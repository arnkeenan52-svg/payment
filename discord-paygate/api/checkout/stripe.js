import { capabilities } from '../../src/config.js';
import { storeBySlug, planOf } from '../../src/services/stores.js';
import { sendJson, sendText, readJsonBody, guard } from '../../src/lib/http.js';
import { sessionUserId } from '../../src/lib/session.js';
import { createCheckoutSession, stripeFetch } from '../../src/lib/stripe.js';
import { fromMinor, toMinor, normalize as normalizeCurrency } from '../../src/lib/currency.js';
import { purchaseBlocked, resolveDiscount } from '../../src/services/purchase-guard.js';
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
  const uid = sessionUserId(req);
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
  // Discount code → a one-shot Stripe coupon on the store's own account.
  // Validated here; the completed-checkout webhook counts the use.
  let couponId = null;
  let discountCode = null;
  const wanted = typeof body?.discountCode === 'string' ? body.discountCode : '';
  if (wanted.trim()) {
    const applied = await resolveDiscount({ store, plan, code: wanted });
    if (applied.error) {
      sendJson(res, 400, { error: applied.error });
      return;
    }
    const d = applied.row;
    try {
      const coupon = await stripeFetch('/v1/coupons', {
        method: 'POST',
        key: store.stripeKey,
        form: {
          duration: 'once',
          name: applied.code,
          ...(d.kind === 'percent'
            ? { percent_off: Math.min(100, Math.max(1, d.amount)) }
            // A fixed discount is money, so it carries the plan's currency and
            // the plan's minor-unit factor. Hardcoded 'usd' × 100 minted a
            // ¥500-off coupon as a $500-off one — refused by Stripe at best,
            // and at worst a discount a hundred times the intended size.
            : {
                amount_off: toMinor(Math.min(d.amount, plan.priceUsd), plan.currency),
                currency: normalizeCurrency(plan.currency),
              }),
        },
      });
      couponId = coupon.id;
      discountCode = applied.code;
    } catch (err) {
      console.error(`[checkout] coupon for ${applied.code} on ${store.slug} failed: ${err.message}`);
      sendJson(res, 502, { error: 'Could not apply that discount — try again shortly.' });
      return;
    }
  }
  // Optional buyer note — rides into Stripe metadata so the owner sees it on
  // the payment in the Stripe dashboard.
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
  let session;
  try {
    session = await createCheckoutSession({ plan, discordId: uid, note, store, couponId, discountCode });
  } catch (err) {
    // Buyers get a plain sentence, never raw Stripe internals; the owner sees
    // the exact cause (wrong-mode key, missing price, …) via the setup doctor.
    console.error(`[checkout] stripe session for ${uid}/${plan.id} (store ${store.slug}) failed: ${err.message}`);
    sendJson(res, 502, {
      error: "Payment could not be started — the store's payment setup is incomplete. Please try again shortly.",
    });
    return;
  }
  // Log the attempt before answering. A buyer who never finishes leaves no
  // subscription behind, so this row is the only trace that they got as far as
  // Stripe's card form — and it is what turns "no sales" into a diagnosis.
  // Never let a bookkeeping failure cost someone a checkout they can pay for.
  try {
    await db.recordCheckoutAttempt({
      storeId: store.id ?? null,
      planId: plan.id,
      discordId: uid,
      sessionId: session.id,
      // amount_total comes back in MINOR units, and the divisor is not always
      // 100 — a ¥1500 sale reports 1500, which /100 would log as ¥15.
      // session.currency is the currency Stripe actually charged in.
      amountUsd: typeof session.amount_total === 'number'
        ? fromMinor(session.amount_total, session.currency ?? plan.currency)
        : (plan.priceUsd ?? 0),
      currency: normalizeCurrency(session.currency ?? plan.currency),
      discountCode,
    });
  } catch (err) {
    console.error(`[checkout] could not log attempt ${session.id}: ${err.message}`);
  }
  sendJson(res, 200, { url: session.url });
});
