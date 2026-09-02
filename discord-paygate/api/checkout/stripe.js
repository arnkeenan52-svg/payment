import crypto from 'node:crypto';
import { capabilities } from '../../src/config.js';
import { storeBySlug, planOf } from '../../src/services/stores.js';
import { sendJson, sendText, readJsonBody, guard } from '../../src/lib/http.js';
import { sessionUserId } from '../../src/lib/session.js';
import { createCheckoutSession, stripeFetch, CHECKOUT_TTL_SECONDS } from '../../src/lib/stripe.js';
import { fromMinor, toMinor, normalize as normalizeCurrency, minCharge, formatAmount } from '../../src/lib/currency.js';
import { purchaseBlocked, resolveDiscount, seatLimitFor } from '../../src/services/purchase-guard.js';
import * as db from '../../src/db.js';

export default guard(async function handler(req, res) {
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  if (!capabilities().stripe) {
    sendJson(res, 501, { error: 'card payments are not enabled' });
    return;
  }
  const uid = await sessionUserId(req);
  if (!uid) {
    sendJson(res, 401, { error: 'log in with Discord first' });
    return;
  }
  const body = await readJsonBody(req).catch(() => null);
  const store = await storeBySlug(typeof body?.store === 'string' ? body.store : '');
  if (!store || store.status !== 'live') {
    sendJson(res, 404, { error: 'unknown store' });
    return;
  }
  const plan = body?.planId ? await planOf(store, body.planId) : null;
  if (!plan) {
    sendJson(res, 400, { error: 'unknown plan' });
    return;
  }
  // Every rule that can stop this sale — inactive, expired, role-gated,
  // sold out, or the owner's member cap — lives in one shared guard so the
  // card and crypto rails cannot enforce different ones.
  const blocked = await purchaseBlocked({ store, plan, uid });
  if (blocked) {
    sendJson(res, blocked.status, { error: blocked.error });
    return;
  }
  // The same purchase limit, to be held again by the reservation's INSERT.
  const seatLimit = await seatLimitFor({ store, plan, uid });
  // A managed store whose sealed key will not open (a rotated SESSION_SECRET)
  // must not reach Stripe at all — not for a coupon, not for a session. The
  // session builder refuses on its own, but the coupon call ran BEFORE it and
  // told a buyer with a code that the discount was broken, with `null` as the
  // bearer. Same sentence as the session failure: the cause is the same.
  if (store.id !== null && store.id !== undefined && !store.stripeKey) {
    console.error(`[checkout] store ${store.slug}: its Stripe key cannot be read — reconnect Stripe in Settings before selling`);
    sendJson(res, 502, {
      error: "Payment could not be started — the store's payment setup is incomplete. Please try again shortly.",
    });
    return;
  }
  // Discount code → a one-shot Stripe coupon on the store's own account.
  // Validated here; the completed-checkout webhook counts the use.
  let couponId = null;
  let discountCode = null;
  // What this checkout is for, in the plan's own currency — the reservation
  // below records it, and the session's own total replaces it once Stripe has
  // answered with what it actually charged.
  let amountUsd = plan.priceUsd ?? 0;
  const wanted = typeof body?.discountCode === 'string' ? body.discountCode : '';
  if (wanted.trim()) {
    const applied = await resolveDiscount({ store, plan, code: wanted, uid });
    if (applied.error) {
      sendJson(res, 400, { error: applied.error });
      return;
    }
    // A code that drags the total under Stripe's per-currency floor cannot be
    // charged by any card; Stripe would refuse the session with an error the
    // buyer never gets to read. Say it here, before minting anything.
    {
      const cur = normalizeCurrency(plan.currency);
      if (applied.priceAfter > 0 && applied.priceAfter < minCharge(cur)) {
        sendJson(res, 409, {
          error: `That code brings the total under the ${cur.toUpperCase()} minimum of ${formatAmount(minCharge(cur), cur)}, which no card payment can clear.`,
        });
        return;
      }
    }
    const d = applied.row;
    // A fixed discount is money, so it carries the plan's currency and the
    // plan's minor-unit factor. Hardcoded 'usd' × 100 minted a ¥500-off
    // coupon as a $500-off one — refused by Stripe at best, and at worst a
    // discount a hundred times the intended size.
    const terms = d.kind === 'percent'
      ? { percent_off: Math.min(100, Math.max(1, d.amount)) }
      : { amount_off: toMinor(Math.min(d.amount, plan.priceUsd), plan.currency), currency: normalizeCurrency(plan.currency) };
    // One coupon per (store, code, terms), reused across attempts. Stripe lets
    // the caller pick the coupon id, so a failed or abandoned checkout leaves
    // nothing new on the seller's account, and an edited discount gets a fresh
    // coupon because its terms are in the id. Codes are already [A-Z0-9_-].
    const couponKey = `dues_${store.id ?? 'default'}_${applied.code}_${d.kind === 'percent' ? `p${terms.percent_off}` : `a${terms.amount_off}${terms.currency}`}`
      .replace(/[^A-Za-z0-9_-]/g, '_');
    try {
      await stripeFetch('/v1/coupons', {
        method: 'POST',
        key: store.stripeKey,
        form: { id: couponKey, duration: 'once', name: applied.code, ...terms },
      }).catch((err) => {
        // Already minted by an earlier attempt: reuse it.
        if (!/resource_already_exists|already exists/i.test(err.message)) throw err;
      });
      couponId = couponKey;
      discountCode = applied.code;
      amountUsd = applied.priceAfter;
    } catch (err) {
      console.error(`[checkout] coupon for ${applied.code} on ${store.slug} failed: ${err.message}`);
      sendJson(res, 502, { error: 'Could not apply that discount — try again shortly.' });
      return;
    }
  }
  // Optional buyer note — rides into Stripe metadata so the owner sees it on
  // the payment in the Stripe dashboard.
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
  // The seat is taken HERE, before Stripe is asked for anything. The guard
  // above answers for this buyer alone; two buyers who click Pay in the same
  // second both passed it, and with the row written only after the session
  // came back, both were sold the last seat of a one-seat product — a card
  // sale has no settlement-time re-check to catch that, so both were then
  // delivered. The row goes in under a placeholder id (the session does not
  // exist yet) and takes the real one below; the limit is counted by the
  // INSERT itself. A bookkeeping failure still never costs a buyer their
  // checkout — only a limit that really is reached refuses one.
  const reservationId = `res_${crypto.randomUUID().replace(/-/g, '')}`;
  try {
    const reserved = await db.insertCheckoutAttemptWithin({
      storeId: store.id ?? null,
      planId: plan.id,
      discordId: uid,
      sessionId: reservationId,
      amountUsd,
      currency: normalizeCurrency(plan.currency),
      discountCode,
      seatLimit,
      reservedSince: Math.floor(Date.now() / 1000) - CHECKOUT_TTL_SECONDS,
    });
    if (!reserved) {
      sendJson(res, 409, { error: 'This product is sold out.' });
      return;
    }
  } catch (err) {
    console.error(`[checkout] could not reserve ${reservationId} for ${uid}/${plan.id}: ${err.message}`);
  }
  let session;
  try {
    session = await createCheckoutSession({ plan, discordId: uid, note, store, couponId, discountCode });
  } catch (err) {
    // No session, nothing to pay: the reservation must not hold a seat or a
    // discount use for a purchase that cannot happen.
    await db.releaseCheckoutAttempt(reservationId).catch(() => {});
    // Buyers get a plain sentence, never raw Stripe internals; the owner sees
    // the exact cause (wrong-mode key, missing price, …) via the setup doctor.
    console.error(`[checkout] stripe session for ${uid}/${plan.id} (store ${store.slug}) failed: ${err.message}`);
    sendJson(res, 502, {
      error: "Payment could not be started — the store's payment setup is incomplete. Please try again shortly.",
    });
    return;
  }
  // The reservation becomes the attempt row proper: the session id the
  // completion webhook matches on, and what Stripe says it charged. A buyer
  // who never finishes leaves no subscription behind, so this row is the only
  // trace that they got as far as the card form — and it is what turns "no
  // sales" into a diagnosis. Never let a bookkeeping failure cost someone a
  // checkout they can pay for.
  try {
    await db.attachCheckoutSession(reservationId, session.id, {
      // amount_total comes back in MINOR units, and the divisor is not always
      // 100 — a ¥1500 sale reports 1500, which /100 would log as ¥15.
      // session.currency is the currency Stripe actually charged in.
      amountUsd: typeof session.amount_total === 'number'
        ? fromMinor(session.amount_total, session.currency ?? plan.currency)
        : amountUsd,
      currency: normalizeCurrency(session.currency ?? plan.currency),
    });
  } catch (err) {
    console.error(`[checkout] could not log attempt ${session.id}: ${err.message}`);
  }
  sendJson(res, 200, { url: session.url });
});
