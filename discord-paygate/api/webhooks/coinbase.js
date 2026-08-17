import { capabilities } from '../../src/config.js';
import { readRawBody, sendText, guard } from '../../src/lib/http.js';
import { verifyCoinbaseSignature, withinTolerance } from '../../src/lib/coinbase.js';
import { claimEvent, releaseEvent } from '../../src/db.js';
import { processCoinbaseEvent } from '../../src/services/coinbase-events.js';

// Raw body: the x-cc-webhook-signature covers the exact bytes sent.
export const config = { api: { bodyParser: false } };

// Dormant unless Coinbase credentials are configured — Stripe-only deploys
// answer 501 and never verify or process anything.
export default guard(async function handler(req, res) {
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  if (!capabilities().crypto) {
    sendText(res, 501, 'crypto payments are not enabled');
    return;
  }
  let raw;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    sendText(res, 400, err.message === 'RAW_BODY_UNAVAILABLE' ? 'raw body unavailable' : 'unreadable body');
    return;
  }
  if (!verifyCoinbaseSignature(raw, req.headers['x-cc-webhook-signature'])) {
    sendText(res, 400, 'invalid signature');
    return;
  }
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendText(res, 400, 'invalid payload');
    return;
  }
  const event = body?.event;
  if (!event?.id || !event?.type) {
    sendText(res, 400, 'invalid payload');
    return;
  }
  if (!withinTolerance(event.created_at)) {
    sendText(res, 400, 'stale event');
    return;
  }

  if (!(await claimEvent('coinbase', event.id))) {
    sendText(res, 200, 'duplicate');
    return;
  }
  try {
    await processCoinbaseEvent(event);
    sendText(res, 200, 'ok');
  } catch (err) {
    await releaseEvent('coinbase', event.id);
    console.error(`[webhooks] coinbase ${event.id} failed (claim released for retry): ${err.stack ?? err.message}`);
    sendText(res, 500, 'processing failed');
  }
});
