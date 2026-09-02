import { capabilities } from '../../src/config.js';
import { readRawBody, sendText, guard } from '../../src/lib/http.js';
import { verifyIpnSignature, getPayment } from '../../src/lib/nowpayments.js';
import { claimEvent, releaseEvent } from '../../src/db.js';
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

  // NOWPayments sends one IPN per status TRANSITION and gives none of them an
  // event id, so the claim key is the pair. Keying on payment_id alone would
  // let the first delivery (waiting) swallow every later one — including the
  // finished that actually grants the role.
  const eventId = `${paymentId}:${status}`;
  if (!(await claimEvent('nowpayments', eventId))) {
    sendText(res, 200, 'duplicate');
    return;
  }
  try {
    // The IPN carries no timestamp and no nonce, so there is nothing in it to
    // bound a replay against. Re-reading the payment from the API makes that
    // moot: a captured delivery replayed next week is answered with the
    // payment's state next week, not with the state it described.
    const payment = await getPayment(paymentId);
    await processNowPayment(payment);
    sendText(res, 200, 'ok');
  } catch (err) {
    await releaseEvent('nowpayments', eventId);
    console.error(`[webhooks] nowpayments ${eventId} failed (claim released for retry): ${err.stack ?? err.message}`);
    sendText(res, 500, 'processing failed');
  }
});
