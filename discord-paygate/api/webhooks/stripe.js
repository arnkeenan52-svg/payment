import { readRawBody, sendText, guard } from '../../src/lib/http.js';
import { verifyStripeSignature } from '../../src/lib/stripe.js';
import { claimEvent, releaseEvent } from '../../src/db.js';
import { processStripeEvent } from '../../src/services/stripe-events.js';

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
  if (!verifyStripeSignature(raw, req.headers['stripe-signature'])) {
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

  if (!(await claimEvent('stripe', event.id))) {
    sendText(res, 200, 'duplicate');
    return;
  }
  try {
    await processStripeEvent(event);
    sendText(res, 200, 'ok');
  } catch (err) {
    await releaseEvent('stripe', event.id);
    console.error(`[webhooks] stripe ${event.id} failed (claim released for retry): ${err.stack ?? err.message}`);
    sendText(res, 500, 'processing failed');
  }
});
