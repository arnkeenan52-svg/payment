import crypto from 'node:crypto';
import { capabilities } from '../../src/config.js';
import { storeBySlug, planOf } from '../../src/services/stores.js';
import { sendJson, sendText, readJsonBody, guard } from '../../src/lib/http.js';
import { sessionUserId } from '../../src/lib/session.js';
import { purchaseBlocked, resolveDiscount, seatLimitFor, DISCOUNT_WINDOW_SECONDS, MAX_DISCOUNT_MISSES } from '../../src/services/purchase-guard.js';
import { publicPaymentView } from '../../src/services/nowpayments-events.js';
import { createPayment, getPayment, merchantCoins, minimumFor, paymentExpiryAt } from '../../src/lib/nowpayments.js';
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
// a loop, and every invoice it mints holds a seat and a discount use for as
// long as it can be paid.
//
// LIVE is the whole of it: the cap counts the same `expires_at > now` rows the
// seat does, so an invoice the provider has already expired is not one of the
// three. It has to work that way, because the pay screen's own answer to a
// lapsed invoice is "start again" — a buyer who does what we tell them three
// times must not be locked out of a product they never bought.
const MAX_OPEN_INVOICES = 3;

// How long a live invoice holds its seat and its discount use: exactly as long
// as the provider will let anyone pay it, and not one second more.
//
// That instant is the payment's own `valid_until` (paymentExpiryAt reads it,
// and explains why the estimate's expiry is a different field). Every payment
// here is fixed-rate with the fee paid by the buyer, and NOWPayments freezes
// the rate on that flow for TEN MINUTES — "if there are no incoming payments
// during this period, the payment status changes to 'expired'".
//
// This used to hold for seven days, on the reading that the payment itself
// lived that long. Seven days is how long the provider keeps WATCHING the
// deposit address, not how long the invoice can be started against, and the
// difference cost buyers the product: an invoice that lapsed at minute ten
// told them to start again, each restart minted another week-long hold on the
// seat and the discount use, and the third one hit MAX_OPEN_INVOICES below —
// locked out of something they never bought, with a seat nobody could buy.
//
// The other half of that seven days — that money can still land on a lapsed
// invoice — is real, and is answered where it belongs: src/services/backfill.js
// keeps asking the provider about an expired order for its whole tracking
// window, and a deposit that turns up is granted like any other. If the seat
// went to someone else in the meantime, settlement re-runs the purchase guard
// and the seller is told to refund — a certain, week-long lockout for every
// other buyer is the worse trade.
const RATE_FREEZE_SECONDS = 10 * 60;

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
      const uid = await sessionUserId(req);
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
      // A store with no payout wallet — or one with no chain to pay it on —
      // cannot take crypto at all, and saying so here is what keeps the
      // storefront from offering a button that can only fail. Same pair the
      // POST below refuses on, so the picker never fills with coins the
      // payment is going to turn down.
      if (!String(store.cryptoWallet ?? '').trim() || !String(store.cryptoChain ?? '').trim()) {
        sendJson(res, 200, { ready: false, coins: [] });
        return;
      }
      try {
        // No coins is the same answer as no wallet: nothing here can be paid
        // with, so say so instead of offering an empty picker.
        const coins = await merchantCoins();
        sendJson(res, 200, { ready: coins.length > 0, coins });
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

  const uid = await sessionUserId(req);
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
  // The same purchase limit, to be held again by the reservation's INSERT.
  const seatLimit = await seatLimitFor({ store, plan, uid });
  // No wallet, no sale. Refusing here is the whole custody guarantee: a
  // payment created without a payout address settles into the platform's
  // NOWPayments balance, and this account still has custody switched on.
  if (!String(store.cryptoWallet ?? '').trim() || !String(store.cryptoChain ?? '').trim()) {
    console.error(`[checkout] ${store.slug} has crypto enabled but no payout wallet or chain — refusing to create a payment`);
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
    // Checkout separates "no such code" from "here is your discount" just as
    // plainly as the preview does, and to anyone with a Discord login — so it
    // spends the same guessing budget, kept in the database because this ships
    // as serverless functions. Only the per-asker count gates here: a
    // store-wide refusal on the money path would let a stranger switch off
    // every seller's discount codes mid-sale. Past the budget a valid code is
    // refused too, or the refusal itself would be the tell.
    const since = Math.floor(Date.now() / 1000) - DISCOUNT_WINDOW_SECONDS;
    if ((await db.countDiscountMisses(`u:${uid}`, since)) >= MAX_DISCOUNT_MISSES) {
      sendJson(res, 429, { error: 'Too many code attempts — try again in a few minutes.' });
      return;
    }
    const applied = await resolveDiscount({ store, plan, code: body.discountCode, uid });
    if (applied.error) {
      await db.recordDiscountMiss(`u:${uid}`, store.slug, since).catch(() => {});
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

  // The order row goes in BEFORE the payment exists. It is the only mapping
  // from a NOWPayments IPN back to which buyer bought what, so it must never
  // be possible for money to move while the row is still missing. A row with
  // no payment behind it is just an abandoned checkout, which is a thing the
  // table already models.
  //
  // It is also the reservation: the seat and the buyer's invoice cap are
  // counted by the INSERT itself, so a burst of parallel clicks cannot each
  // read "nothing taken yet" and then each be handed an address. The guard
  // above already answered for this buyer — this is the same rule, enforced
  // where it holds, and it runs before the provider is asked for anything.
  const orderId = `np_${crypto.randomUUID().replace(/-/g, '')}`;
  const reservedSince = Math.floor(Date.now() / 1000) - CHECKOUT_TTL_SECONDS;
  let reserved;
  try {
    reserved = await db.insertCheckoutAttemptWithin({
      storeId: store.id ?? null,
      planId: plan.id,
      discordId: uid,
      sessionId: orderId,
      amountUsd: amount,
      currency,
      discountCode,
      seatLimit,
      maxOpenCrypto: MAX_OPEN_INVOICES,
      reservedSince,
    });
  } catch (err) {
    console.error(`[checkout] could not log crypto attempt ${orderId}: ${err.message}`);
    sendJson(res, 500, { error: 'Payment could not be started — try again in a moment.' });
    return;
  }
  if (!reserved) {
    // Which of the two limits refused it — the same counts the INSERT just
    // took, so the buyer reads the reason that actually applies.
    const open = await db.countOpenCryptoAttemptsBy(store.id ?? null, uid, reservedSince).catch(() => MAX_OPEN_INVOICES);
    if (open >= MAX_OPEN_INVOICES) {
      sendJson(res, 429, { error: 'You already have crypto payments waiting — pay one of those, or let them expire before starting another.' });
      return;
    }
    sendJson(res, 409, { error: 'This product is sold out.' });
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
      // SELLER's payout coin — the same one createPayment just asked for, on
      // the same fixed-rate fee-paid-by-user flow, which the provider warns
      // has its own floor. The order's own currency is asked for too, so the
      // fiat fallback below has something to fall back to.
      const min = await minimumFor(
        payCurrency,
        String(store.cryptoChain || payCurrency).toLowerCase(),
        { fiatEquivalent: currency },
      ).catch(() => null);
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

  // One instant, three uses: the seat hold, the discount hold and the
  // countdown the buyer is shown are all this number, because they are all the
  // same fact — when the provider stops accepting this payment. A payment that
  // volunteers neither expiry field falls back to the documented rate freeze
  // for the flow we always ask for, never to a window of our own invention.
  const expiresAt = paymentExpiryAt(payment) ?? Math.floor(Date.now() / 1000) + RATE_FREEZE_SECONDS;
  await db.setCheckoutAttemptRef(orderId, String(payment.payment_id), expiresAt).catch((err) => {
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
    // The same instant the row above holds its seat until — the moment the
    // provider expires this payment. The pay screen counts down to it, so what
    // the buyer is watching run out is the payment, not a rate quote that
    // outlives it or a hold that outlives them both.
    expiresAt: new Date(expiresAt * 1000).toISOString(),
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
