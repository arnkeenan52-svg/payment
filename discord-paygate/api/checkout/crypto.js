import crypto from 'node:crypto';
import { capabilities } from '../../src/config.js';
import { storeBySlug, planOf } from '../../src/services/stores.js';
import { sendJson, sendText, readJsonBody, guard } from '../../src/lib/http.js';
import { sessionUserId } from '../../src/lib/session.js';
import { purchaseBlocked, resolveDiscount } from '../../src/services/purchase-guard.js';
import { publicPaymentView } from '../../src/services/nowpayments-events.js';
import { createPayment, getPayment, merchantCoins, minimumFor } from '../../src/lib/nowpayments.js';
import { normalize as normalizeCurrency, formatAmount, minCharge } from '../../src/lib/currency.js';
import { qrForPayment } from '../../src/lib/qr.js';
import { CHECKOUT_TTL_SECONDS } from '../../src/lib/stripe.js';
import * as db from '../../src/db.js';

// The crypto rail (NOWPayments).
//
// Three jobs, one endpoint:
//   GET  ?store=…&coins=1   which coins this store can be paid in
//   GET  ?store=…&order=…   the buyer polling their own payment
//   POST                    create the payment and hand back an address
//
// Nothing here reads a balance. The money never lands in a Dues account to
// have a balance in: every payment carries the seller's own payout address
// (src/lib/nowpayments.js explains why that is a precondition, not a setting).

const ORDER_RE = /^np_[0-9a-f]{32}$/;

// Live invoices one buyer may hold in one store. One is all a purchase
// needs; a couple more cover a changed mind about the coin. Past that it is
// a loop, and every invoice it mints holds a seat and a discount use until
// the provider gives up on it.
const MAX_OPEN_INVOICES = 3;

// When the provider stops taking money for a payment, in unix seconds. The
// row holds its seat and its discount use until then, so a missing or
// unreadable date falls back to the card-form TTL rather than to forever.
function invoiceExpiry(payment) {
  const at = Math.floor(Date.parse(payment?.expiration_estimate_date ?? '') / 1000);
  const now = Math.floor(Date.now() / 1000);
  return Number.isFinite(at) && at > now ? at : now + CHECKOUT_TTL_SECONDS;
}

async function loadStore(slug) {
  const store = await storeBySlug(typeof slug === 'string' ? slug : '');
  return store && store.status === 'live' ? store : null;
}

export default guard(async function handler(req, res) {
  if (!capabilities().nowpayments) {
    sendJson(res, 501, { error: 'crypto payments are not enabled' });
    return;
  }

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const store = await loadStore(url.searchParams.get('store') ?? '');
    if (!store) {
      sendJson(res, 404, { error: 'unknown store' });
      return;
    }

    // ── the buyer's pay screen, polling ──────────────────────────────────
    const order = url.searchParams.get('order');
    if (order) {
      if (!ORDER_RE.test(order)) {
        sendJson(res, 400, { error: 'bad request' });
        return;
      }
      const uid = sessionUserId(req);
      const attempt = await db.getCheckoutAttempt(order);
      // Someone else's order is not "not found by accident" — an order id is
      // guessable enough to be worth refusing on identity, not on existence.
      if (!attempt || !uid || attempt.discord_id !== uid) {
        sendJson(res, 404, { error: 'unknown order' });
        return;
      }
      // The row is flipped to completed by the webhook, after the grant. It
      // is the stronger source: a poll must never keep saying "waiting" for
      // a sale that has already landed — not when the payment id never got
      // attached below, and not when the provider is unreachable right now.
      if (attempt.status === 'completed') {
        sendJson(res, 200, publicPaymentView({ payment_status: 'finished' }, { currency: attempt.currency }));
        return;
      }
      if (!attempt.provider_ref) {
        sendJson(res, 200, { status: 'waiting', state: 'pending', message: 'Waiting for your payment…' });
        return;
      }
      try {
        // Read the payment from the API rather than trusting anything the
        // browser sent, and answer with a buyer-shaped view: no address, no
        // ids, nothing about the seller's wallet.
        const payment = await getPayment(attempt.provider_ref);
        sendJson(res, 200, publicPaymentView(payment, { currency: attempt.currency, delivered: attempt.status === 'completed' }));
      } catch (err) {
        console.error(`[checkout] nowpayments status for ${order} failed: ${err.message}`);
        sendJson(res, 502, { error: 'Could not check that payment just now — try again in a moment.' });
      }
      return;
    }

    // ── the coin picker ──────────────────────────────────────────────────
    if (url.searchParams.get('coins')) {
      // A store with no payout wallet cannot take crypto at all, and saying
      // so here is what keeps the storefront from offering a button that can
      // only fail.
      if (!String(store.cryptoWallet ?? '').trim()) {
        sendJson(res, 200, { ready: false, coins: [] });
        return;
      }
      try {
        sendJson(res, 200, { ready: true, coins: await merchantCoins() });
      } catch (err) {
        console.error(`[checkout] nowpayments coin list failed: ${err.message}`);
        sendJson(res, 502, { error: 'Could not load the coin list just now.' });
      }
      return;
    }
    sendJson(res, 400, { error: 'bad request' });
    return;
  }

  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }

  const uid = sessionUserId(req);
  if (!uid) {
    sendJson(res, 401, { error: 'log in with Discord first' });
    return;
  }
  const body = await readJsonBody(req).catch(() => null);
  const store = await loadStore(body?.store);
  if (!store) {
    sendJson(res, 404, { error: 'unknown store' });
    return;
  }
  const plan = body?.planId ? await planOf(store, body.planId) : null;
  if (!plan) {
    sendJson(res, 400, { error: 'unknown plan' });
    return;
  }
  // Same rules as the card rail, from the same guard.
  const blocked = await purchaseBlocked({ store, plan, uid });
  if (blocked) {
    sendJson(res, blocked.status, { error: blocked.error });
    return;
  }
  // No wallet, no sale. Refusing here is the whole custody guarantee: a
  // payment created without a payout address settles into the platform's
  // NOWPayments balance, and this account still has custody switched on.
  if (!String(store.cryptoWallet ?? '').trim()) {
    console.error(`[checkout] ${store.slug} has crypto enabled but no payout wallet — refusing to create a payment`);
    sendJson(res, 409, { error: 'This store has not finished setting up crypto payments yet. Pay by card, or check back shortly.' });
    return;
  }
  const payCurrency = String(body?.payCurrency ?? '').toLowerCase().trim();
  if (!/^[a-z0-9]{2,20}$/.test(payCurrency)) {
    sendJson(res, 400, { error: 'Pick a coin to pay with.' });
    return;
  }
  // A coin the merchant account has not enabled would be refused by
  // NOWPayments with a message no buyer should have to read.
  try {
    if (!(await merchantCoins()).includes(payCurrency)) {
      sendJson(res, 400, { error: 'That coin is not available for this store.' });
      return;
    }
  } catch (err) {
    console.error(`[checkout] nowpayments coin check failed: ${err.message}`);
    sendJson(res, 502, { error: 'Crypto checkout is unavailable right now — try again shortly.' });
    return;
  }

  const currency = normalizeCurrency(plan.currency ?? store.currency);
  let amount = plan.priceUsd;
  let discountCode = null;
  if (typeof body?.discountCode === 'string' && body.discountCode.trim()) {
    const applied = await resolveDiscount({ store, plan, code: body.discountCode, uid });
    if (applied.error) {
      sendJson(res, 400, { error: applied.error });
      return;
    }
    amount = applied.priceAfter;
    discountCode = applied.code;
  }
  // A free order has nothing to send, and a crypto invoice for zero is not a
  // thing any chain can express.
  if (!(amount > 0)) {
    sendJson(res, 409, { error: 'This order costs nothing to pay — no crypto payment is needed.' });
    return;
  }
  if (amount < minCharge(currency)) {
    sendJson(res, 409, {
      error: `That total is under the ${currency.toUpperCase()} minimum of ${formatAmount(minCharge(currency), currency)}.`,
    });
    return;
  }

  // A buyer with addresses already waiting on them does not need another.
  // Checked here, after everything that can refuse for a better reason, and
  // before the provider is asked for anything.
  const open = await db.countOpenCryptoAttemptsBy(store.id ?? null, uid, Math.floor(Date.now() / 1000) - CHECKOUT_TTL_SECONDS);
  if (open >= MAX_OPEN_INVOICES) {
    sendJson(res, 429, { error: 'You already have crypto payments waiting — pay one of those, or let them expire before starting another.' });
    return;
  }

  // The order row goes in BEFORE the payment exists. It is the only mapping
  // from a NOWPayments IPN back to which buyer bought what, so it must never
  // be possible for money to move while the row is still missing. A row with
  // no payment behind it is just an abandoned checkout, which is a thing the
  // table already models.
  const orderId = `np_${crypto.randomUUID().replace(/-/g, '')}`;
  try {
    await db.recordCheckoutAttempt({
      storeId: store.id ?? null,
      planId: plan.id,
      discordId: uid,
      sessionId: orderId,
      amountUsd: amount,
      currency,
      discountCode,
    });
  } catch (err) {
    console.error(`[checkout] could not log crypto attempt ${orderId}: ${err.message}`);
    sendJson(res, 500, { error: 'Payment could not be started — try again in a moment.' });
    return;
  }

  let payment;
  try {
    payment = await createPayment({ plan, store, amount, payCurrency, orderId });
  } catch (err) {
    console.error(`[checkout] nowpayments payment for ${uid}/${plan.id} (store ${store.slug}) failed: ${err.message}`);
    // No payment, nothing to pay: the row must not hold a seat or a discount
    // use for a purchase that cannot happen.
    await db.releaseCheckoutAttempt(orderId).catch(() => {});
    // The one provider error worth translating: the order is below what that
    // coin's network can economically settle. Everything else is a setup
    // problem the buyer can do nothing about.
    if (/minim|too small/i.test(err.message)) {
      // The minimum is per pair, and the pair is the buyer's coin into the
      // SELLER's payout coin — the same one createPayment just asked for.
      const min = await minimumFor(payCurrency, String(store.cryptoChain || payCurrency).toLowerCase()).catch(() => null);
      const amt = min?.min_amount ?? min?.fiat_equivalent ?? null;
      sendJson(res, 409, {
        error: amt
          ? `${payCurrency.toUpperCase()} has a network minimum of about ${amt} ${payCurrency.toUpperCase()} — pick another coin or a larger product.`
          : `This order is below ${payCurrency.toUpperCase()}'s network minimum — pick another coin.`,
      });
      return;
    }
    sendJson(res, 502, { error: 'Payment could not be started — try again shortly.' });
    return;
  }

  await db.setCheckoutAttemptRef(orderId, String(payment.payment_id), invoiceExpiry(payment)).catch((err) => {
    // Not fatal: the IPN still resolves the order by order_id. Only the
    // buyer's live status poll degrades, and it degrades to "waiting" until
    // the webhook marks the row completed (the poll reads that first).
    console.error(`[checkout] could not attach payment id to ${orderId}: ${err.message}`);
  });

  sendJson(res, 200, {
    orderId,
    payAddress: payment.pay_address,
    payAmount: payment.pay_amount,
    payCurrency: String(payment.pay_currency ?? payCurrency).toUpperCase(),
    // What the buyer is buying, in the money the price is written in — the
    // coin figure moves with the market and is not the thing they agreed to.
    amount,
    currency,
    // NOWPayments returns this on fixed-rate payments; the pay screen counts
    // down to it so a buyer knows the quoted coin amount has an expiry.
    expiresAt: payment.expiration_estimate_date ?? null,
    // Present only on chains that need it (XRP, XLM, TON…). A buyer who
    // misses a required memo loses the payment, so it is never optional
    // where it exists.
    payExtraId: payment.payin_extra_id ?? null,
    // Rendered server-side so there is one implementation of it and the
    // browser cannot get it wrong. Null on memo chains by design — see
    // src/lib/qr.js for why scanning is the unsafe option there.
    qrSvg: qrForPayment({ address: payment.pay_address, extraId: payment.payin_extra_id ?? null, size: 208 }),
  });
});
