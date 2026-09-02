import { capabilities } from '../../src/config.js';
import { readRawBody, sendText, guard } from '../../src/lib/http.js';
import { verifyIpnSignature, getPayment, GRANTS_ACCESS } from '../../src/lib/nowpayments.js';
import { processNowPayment } from '../../src/services/nowpayments-events.js';

// Raw body: the IPN signature is computed over a RE-SERIALISATION of the
// payload (keys sorted), not over the bytes. The bytes are still read first
// (readRawBody is descriptor-aware, so Vercel's lazy body getter is never
// triggered); the config export below is only an extra opt-out on runtimes
// that honour it — this is not Next.js, and on @vercel/node it is inert.
// Unlike Stripe's, this signature survives a runtime that already parsed the
// body: a pre-parsed object re-serialises to the same sorted JSON, so that
// case is accepted instead of rejecting every delivery.
export const config = { api: { bodyParser: false } };

// Dormant unless NOWPayments credentials are configured. Both are required:
// the key alone cannot verify a delivery, and an unverified delivery is just
// an anonymous request claiming someone paid.
export default guard(async function handler(req, res) {
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  if (!capabilities().nowpayments) {
    sendText(res, 501, 'crypto payments are not enabled');
    return;
  }
  let raw;
  let parsed = null;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    // A plain pre-parsed object is the one shape the raw read refuses; it is
    // safe to touch here (a value, not a getter) and usable for this
    // signature. Anything else is a real failure.
    if (err.message === 'RAW_BODY_UNAVAILABLE' && req.body && typeof req.body === 'object') {
      parsed = req.body;
    } else {
      sendText(res, 400, err.message === 'RAW_BODY_UNAVAILABLE' ? 'raw body unavailable' : 'unreadable body');
      return;
    }
  }
  let body;
  try {
    body = parsed ?? JSON.parse(raw.toString('utf8'));
  } catch {
    sendText(res, 400, 'invalid payload');
    return;
  }
  if (!verifyIpnSignature(body, req.headers['x-nowpayments-sig'])) {
    sendText(res, 400, 'invalid signature');
    return;
  }
  const paymentId = body?.payment_id;
  const status = String(body?.payment_status ?? '').toLowerCase();
  if (!paymentId || !status) {
    sendText(res, 400, 'invalid payload');
    return;
  }

  // No claim is taken on the DELIVERY. NOWPayments sends one IPN per status
  // transition with no event id, and this handler deliberately ignores the
  // status it carries — the payment is re-read from the API and the answer is
  // its state NOW, which is what makes a captured IPN replayed next week
  // harmless (the IPN has no timestamp and no nonce to bound a replay with).
  // But that same re-read means several deliveries can all read `finished`,
  // so a per-delivery claim keyed on the body's status let each of them run
  // the completion side effects again. The claim is on the WORK instead,
  // inside processNowPayment: payment id + outcome, taken once the outcome is
  // known and released when the work fails, so nothing runs twice and no
  // delivery is consumed for work that did not happen.
  let outcome;
  try {
    const payment = await getPayment(paymentId);
    outcome = await processNowPayment(payment);
  } catch (err) {
    console.error(`[webhooks] nowpayments ${paymentId}:${status} failed (provider will retry): ${err.stack ?? err.message}`);
    sendText(res, 500, 'processing failed');
    return;
  }
  if (outcome === 'already') {
    sendText(res, 200, 'duplicate');
    return;
  }
  // A non-2xx is the only thing that brings a delivery back, and this may be
  // the only `finished` this payment ever sends. So a delivery that claims a
  // granting status is not acknowledged until the re-read agrees — GET
  // /payment is a separate read path that can lag the emitter — or the
  // payment has ended for good. Same for work another invocation holds: it
  // may have died, and a retry in a few minutes finds out either way.
  const settled = outcome === 'granted' || outcome === 'ignored' || outcome === 'dead';
  if (outcome === 'in-progress' || (GRANTS_ACCESS.has(status) && !settled)) {
    console.warn(`[webhooks] nowpayments ${paymentId}: delivery says ${status}, re-read says ${outcome} — asking the provider to retry`);
    sendText(res, 503, 'not settled yet');
    return;
  }
  sendText(res, 200, 'ok');
});
