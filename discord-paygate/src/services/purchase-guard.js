import * as db from '../db.js';
import { getGuildMember } from '../lib/discord.js';
import { memberLimitBlocks } from './billing.js';
import { planOf } from './stores.js';
import { roundAmount, normalize as normalizeCurrency } from '../lib/currency.js';
import { CHECKOUT_TTL_SECONDS } from '../lib/stripe.js';

// Everything that can stop a purchase before a payment provider is ever
// contacted, in one place.
//
// It lives here because there is now more than one rail. A sold-out product
// that refuses card payments but happily takes crypto is not a smaller bug
// than one that refuses both — it is a worse one, because it only shows up
// for the buyers who pick the second button. Both checkout endpoints call
// this, so the rules cannot drift apart.
//
// Returns null when the sale may proceed, or { status, error } — the exact
// HTTP status and the sentence the buyer should read.
//
// `atSettlement` is the crypto rail asking again once the money has landed:
// an invoice can sit open far longer than a card form, so the answer given
// at checkout may have gone stale. Open checkouts hold a seat at checkout
// time so a limited product is not oversold; at settlement they must NOT
// count, or ten buyers holding an invoice for a one-seat product would each
// refuse the first of them who actually pays.
export async function purchaseBlocked({ store, plan, uid, atSettlement = false }) {
  if (plan.active === false) {
    return { status: 409, error: 'This product is not for sale right now.' };
  }
  // A price option is its product at another cadence, so it is off sale
  // whenever the product is. The storefront already hides it (sellablePlansOf)
  // — this is for the option's own planId arriving straight at the API from
  // a cached link, which is exactly the case the storefront cannot cover.
  if (plan.variantOf) {
    const parent = await planOf(store, plan.variantOf);
    if (!parent || parent.active === false) {
      return { status: 409, error: 'This product is not for sale right now.' };
    }
  }
  // Limited-time products refuse new purchases past their end date — the
  // storefront hides them, but the link may be cached or shared.
  if (plan.expiresAt && plan.expiresAt <= Math.floor(Date.now() / 1000)) {
    return { status: 409, error: 'This product is no longer available.' };
  }
  // Gated products: the buyer must already hold the required role in the
  // store's server. Verified against Discord at purchase time — a chip on
  // the page is advice, this is the enforcement.
  if (plan.requiredRoleId) {
    const member = await getGuildMember(uid, store.guildId).catch(() => null);
    if (!member || !(member.roles ?? []).includes(plan.requiredRoleId)) {
      return {
        status: 403,
        error: `This product is for ${plan.requiredRoleName ?? 'members with a specific role'} members only — unlock that first, then come back.`,
      };
    }
  }
  // Purchase limit: caps total distinct buyers, never a returning one.
  const limit = await seatLimitFor({ store, plan, uid });
  if (limit !== null) {
    // Buyers still on the card form hold a seat for the life of their session.
    const taken = await db.countBuyersOfPlan(store.id ?? null, plan.id, { exceptUid: uid, reservedSince: atSettlement ? null : Math.floor(Date.now() / 1000) - CHECKOUT_TTL_SECONDS });
    if (taken >= limit) {
      return { status: 409, error: 'This product is sold out.' };
    }
  }
  // The owner's Dues plan caps how many members their stores can hold.
  // Existing members are never blocked — only brand-new signups wait until
  // the owner upgrades.
  if (await memberLimitBlocks(store, uid)) {
    return {
      status: 409,
      error: 'This store is at its member limit right now. The owner has been shown an upgrade prompt — please try again soon.',
    };
  }
  return null;
}

// The purchase limit this buyer's checkout has to hold to, or null when
// nothing caps them: either the product has no limit, or they already bought
// it — a returning buyer never takes a second seat, so the limit is not theirs
// to hit. Exported because the answer is needed twice: once here for the
// sentence the buyer reads, and once at the checkout row's INSERT, which is
// where the limit is actually enforced against a second buyer clicking Pay at
// the same moment.
export async function seatLimitFor({ store, plan, uid }) {
  if (plan.purchaseLimit === null || plan.purchaseLimit === undefined) return null;
  const own = (await db.subscriptionsForMember(uid)).some((s) => {
    const sid = s.store_id === null || s.store_id === undefined ? null : Number(s.store_id);
    return sid === (store.id ?? null) && s.plan_id === plan.id;
  });
  return own ? null : plan.purchaseLimit;
}

// A discount code checked against this store and product. Shared for the same
// reason as the guard above: a code that is expired, used up or scoped to
// another product must be equally dead on every rail.
//
// Returns { code, row, priceAfter } or { error }.
export async function resolveDiscount({ store, plan, code, uid = null }) {
  const codeRaw = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!codeRaw) return { code: null, row: null, priceAfter: plan.priceUsd };
  const now = Math.floor(Date.now() / 1000);
  const d = store.id !== null && store.id !== undefined ? await db.getDiscount(store.id, codeRaw) : null;
  // A use is counted when the grant lands, so between "code applied" and
  // "paid" the counter has not moved: other buyers with this code on an open
  // checkout hold a use for the life of their session, like a seat. (A crypto
  // invoice holds it for as long as the provider would still settle it — see
  // db.OPEN_ATTEMPT and api/checkout/crypto.js.)
  // Asked without a uid too — that is the public preview, and the honest
  // answer for "anyone but you" when nobody is signed in is "everyone".
  const reserved = d && d.maxUses !== null
    ? await db.countReservedDiscountUses(store.id, codeRaw, now - CHECKOUT_TTL_SECONDS, uid)
    : 0;
  const valid =
    d &&
    // A product-scoped code covers the product's price options too.
    (d.planKey === null || d.planKey === plan.id || d.planKey === plan.variantOf) &&
    (d.expiresAt === null || d.expiresAt > now) &&
    (d.maxUses === null || d.uses + reserved < d.maxUses);
  if (!valid) return { error: 'That discount code is not valid for this product.' };
  const cur = normalizeCurrency(plan.currency ?? store.currency);
  const off = d.kind === 'percent'
    ? (plan.priceUsd * Math.min(100, Math.max(1, d.amount))) / 100
    : Math.min(d.amount, plan.priceUsd);
  return { code: codeRaw, row: d, priceAfter: Math.max(0, roundAmount(plan.priceUsd - off, cur)) };
}
