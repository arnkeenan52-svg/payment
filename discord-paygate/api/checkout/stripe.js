import { capabilities } from '../../src/config.js';
import { storeBySlug, planOf } from '../../src/services/stores.js';
import { sendJson, sendText, readJsonBody, guard } from '../../src/lib/http.js';
import { sessionUserId } from '../../src/lib/session.js';
import { createCheckoutSession, stripeFetch } from '../../src/lib/stripe.js';
import { memberLimitBlocks } from '../../src/services/billing.js';
import { getGuildMember } from '../../src/lib/discord.js';
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
  if (plan.active === false) {
    sendJson(res, 409, { error: 'This product is not for sale right now.' });
    return;
  }
  // Limited-time products refuse new purchases past their end date — the
  // storefront hides them, but the link may be cached or shared.
  if (plan.expiresAt && plan.expiresAt <= Math.floor(Date.now() / 1000)) {
    sendJson(res, 409, { error: 'This product is no longer available.' });
    return;
  }
  // Gated products: the buyer must already hold the required role in the
  // store's server. Verified against Discord at purchase time — a chip on
  // the page is advice, this is the enforcement.
  if (plan.requiredRoleId) {
    const member = await getGuildMember(uid, store.guildId).catch(() => null);
    if (!member || !(member.roles ?? []).includes(plan.requiredRoleId)) {
      sendJson(res, 403, {
        error: `This product is for ${plan.requiredRoleName ?? 'members with a specific role'} members only — unlock that first, then come back.`,
      });
      return;
    }
  }
  // Purchase limit: caps total distinct buyers, never a returning one.
  if (plan.purchaseLimit !== null && plan.purchaseLimit !== undefined) {
    const own = (await db.subscriptionsForMember(uid)).some((s) => {
      const sid = s.store_id === null || s.store_id === undefined ? null : Number(s.store_id);
      return sid === (store.id ?? null) && s.plan_id === plan.id;
    });
    if (!own && (await db.countBuyersOfPlan(store.id ?? null, plan.id)) >= plan.purchaseLimit) {
      sendJson(res, 409, { error: 'This product is sold out.' });
      return;
    }
  }
  // Discount code → a one-shot Stripe coupon on the store's own account.
  // Validated here; the completed-checkout webhook counts the use.
  let couponId = null;
  let discountCode = null;
  const codeRaw = typeof body?.discountCode === 'string' ? body.discountCode.trim().toUpperCase() : '';
  if (codeRaw) {
    const now = Math.floor(Date.now() / 1000);
    const d = store.id !== null && store.id !== undefined ? await db.getDiscount(store.id, codeRaw) : null;
    const valid =
      d &&
      // A product-scoped code covers the product's price options too.
      (d.planKey === null || d.planKey === plan.id || d.planKey === plan.variantOf) &&
      (d.expiresAt === null || d.expiresAt > now) &&
      (d.maxUses === null || d.uses < d.maxUses);
    if (!valid) {
      sendJson(res, 400, { error: 'That discount code is not valid for this product.' });
      return;
    }
    try {
      const coupon = await stripeFetch('/v1/coupons', {
        method: 'POST',
        key: store.stripeKey,
        form: {
          duration: 'once',
          name: codeRaw,
          ...(d.kind === 'percent'
            ? { percent_off: Math.min(100, Math.max(1, d.amount)) }
            : { amount_off: Math.round(Math.min(d.amount, plan.priceUsd) * 100), currency: 'usd' }),
        },
      });
      couponId = coupon.id;
      discountCode = codeRaw;
    } catch (err) {
      console.error(`[checkout] coupon for ${codeRaw} on ${store.slug} failed: ${err.message}`);
      sendJson(res, 502, { error: 'Could not apply that discount — try again shortly.' });
      return;
    }
  }
  // The owner's Dues plan caps how many members their stores can hold.
  // Existing members are never blocked — only brand-new signups wait until
  // the owner upgrades.
  if (await memberLimitBlocks(store, uid)) {
    sendJson(res, 409, {
      error: 'This store is at its member limit right now. The owner has been shown an upgrade prompt — please try again soon.',
    });
    return;
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
      amountUsd: typeof session.amount_total === 'number' ? session.amount_total / 100 : (plan.priceUsd ?? 0),
      discountCode,
    });
  } catch (err) {
    console.error(`[checkout] could not log attempt ${session.id}: ${err.message}`);
  }
  sendJson(res, 200, { url: session.url });
});
