import { readRawBody, sendText, guard } from '../../src/lib/http.js';
import { verifyStripeSignature } from '../../src/lib/stripe.js';
import { config as appConfig } from '../../src/config.js';
import { claimEvent, releaseEvent, getAppSecret } from '../../src/db.js';
import { processStripeEvent } from '../../src/services/stripe-events.js';
import { storeById } from '../../src/services/stores.js';

// The signature is computed over the exact bytes Stripe sent. readRawBody is
// descriptor-aware so Vercel's lazy body parser is never triggered; the
// config export below additionally opts out on runtimes that honour it.
export const config = { api: { bodyParser: false } };

// Serverless ordering matters: the function is frozen the instant it
// responds, so the grant would silently never happen if we acked first.
// Verify → claim → DO THE WORK → then respond, inside the function timeout.
// A throw releases the PRIMARY KEY claim and answers 500, so Stripe's retry
// of the same event id gets a real second attempt instead of a duplicate ack.
export default guard(async function handler(req, res) {
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  // Per-store endpoints deliver at /webhooks/stripe/<id> (rewritten to
  // ?store=<id>); each store's endpoint verifies with ITS signing secret.
  const url = new URL(req.url, 'http://localhost');
  const storeParam = url.searchParams.get('store');
  let routeStore = null;
  if (storeParam !== null && storeParam !== '') {
    // Digits are not enough: twenty of them pass the regex, overflow a bigint
    // on Postgres, and 500 an UNAUTHENTICATED endpoint. Fifteen digits stay
    // under 2^53 and no store id is anywhere near that.
    routeStore = /^\d{1,15}$/.test(storeParam) ? await storeById(Number(storeParam)) : null;
    if (!routeStore || routeStore.isDefault) {
      sendText(res, 404, 'unknown store endpoint');
      return;
    }
  }
  let raw;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    // Never a function crash: a runtime that already consumed the raw bytes
    // gets a clean 4xx (Stripe retries, and the doctor's endpoint checks
    // will show the platform misbehaving).
    sendText(res, 400, err.message === 'RAW_BODY_UNAVAILABLE' ? 'raw body unavailable' : 'unreadable body');
    return;
  }
  // Deliveries may be signed by the endpoint the owner configured (env
  // STRIPE_WEBHOOK_SECRET) or by the endpoint the setup doctor registered
  // automatically (secret stored in the database). Accept either.
  const secrets = (
    routeStore
      ? [routeStore.webhookSecret]
      : [appConfig.stripe.webhookSecret, await getAppSecret('stripe_webhook_secret').catch(() => null)]
  ).filter(Boolean);
  if (!secrets.some((secret) => verifyStripeSignature(raw, req.headers['stripe-signature'], { secret }))) {
    sendText(res, 400, 'invalid signature');
    return;
  }
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    sendText(res, 400, 'invalid payload');
    return;
  }
  if (!event?.id || !event?.type) {
    sendText(res, 400, 'invalid payload');
    return;
  }

  // Claimed per endpoint: a seller with two stores on one Stripe account has
  // two endpoints, and Stripe sends every event to both — each store decides
  // for itself whether the event is its own (see resolveStore).
  const scope = routeStore ? `s${routeStore.id}` : null;
  if (!(await claimEvent('stripe', event.id, scope))) {
    sendText(res, 200, 'duplicate');
    return;
  }
  try {
    await processStripeEvent(event, routeStore);
    sendText(res, 200, 'ok');
  } catch (err) {
    await releaseEvent('stripe', event.id, scope);
    console.error(`[webhooks] stripe ${event.id} failed (claim released for retry): ${err.stack ?? err.message}`);
    sendText(res, 500, 'processing failed');
  }
});
