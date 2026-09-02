// The owner's Dues plan: platform billing, charged on RIPLEY's own Stripe
// account (config.stripe.secretKey) — completely separate from the money a
// store makes, which lands on the store owner's account.
//
// Free covers a store's first 10 paying members. Past that, the owner picks
// a monthly tier sized by member count. Enforcement is deliberately gentle:
// an over-limit store stops accepting NEW members at checkout; nobody who
// already paid ever loses a role because their store owner outgrew Free.

import { config } from '../config.js';
import * as db from '../db.js';
import { stripeFetch, subscriptionPeriodEnd, getSubscription } from '../lib/stripe.js';
import { storesOwnedBy } from './stores.js';

// yearlyUsd = 10 months — two months free on yearly, like the reference.
export const TIERS = [
  { id: 'free', name: 'Free', priceUsd: 0, yearlyUsd: 0, maxMembers: 10 },
  { id: 'starter', name: 'Pro', priceUsd: 14.99, yearlyUsd: 149.9, maxMembers: 50 },
  { id: 'growth', name: 'Max', priceUsd: 44.99, yearlyUsd: 449.9, maxMembers: 500 },
  { id: 'scale', name: 'Unlimited', priceUsd: 134.99, yearlyUsd: 1349.9, maxMembers: null }, // unlimited
];

export const tierById = (id) => TIERS.find((t) => t.id === id) ?? null;

const now = () => Math.floor(Date.now() / 1000);

// A paid tier stays effective while its Stripe subscription is alive:
// active, or past_due within the same grace window buyer plans get.
export function tierStillPaid(row) {
  if (!row) return false;
  const end = row.current_period_end === null || row.current_period_end === undefined ? null : Number(row.current_period_end);
  if (row.status === 'active') return end === null || end + 86400 > now(); // 1 day of clock slack on renewals
  if (row.status === 'past_due') return end !== null && end + config.gracePeriodHours * 3600 > now();
  return false;
}

// The owner's effective plan right now. The platform owner runs the platform —
// exempt, unlimited, no plan to buy.
export async function billingFor(ownerDiscordId) {
  if (!ownerDiscordId) return { tier: tierById('free'), row: null, exempt: false };
  if (config.ownerDiscordId && ownerDiscordId === config.ownerDiscordId) {
    return { tier: { id: 'platform', name: 'Platform owner', priceUsd: 0, maxMembers: null }, row: null, exempt: true };
  }
  const row = await db.getPlatformBilling(ownerDiscordId);
  const tier = tierStillPaid(row) ? (tierById(row.tier) ?? tierById('free')) : tierById('free');
  return { tier, row, exempt: false };
}

// A STOREFRONT'S LOOK IS FREE, ON EVERY PLAN.
//
// It was a paid feature until a seller pointed out the obvious: the shop
// window is what sells the seller's roles, so charging for it taxed the thing
// the platform lives on. Every colour, corner, typeface, material, every
// background in the catalogue and an image imported by URL are all free now.
// What a plan buys is member capacity.
//
// This function stays because both render paths go through it (api/store-page.js
// server-side and api/plans.js for the client) and because it still answers a
// real question — what look should this store be shown in — even though the
// answer no longer depends on a plan.
export async function storeTheme(store) {
  return store?.theme ?? null;
}

// Whether this owner's plan is a paid one. The look no longer asks; nothing
// else does either today, and the dashboard's Appearance panel is open to
// everyone. Kept because the billing state itself is worth naming, and a
// future paid feature should ask this rather than reinvent it.
export async function onPaidPlan(ownerDiscordId) {
  const { tier, exempt } = await billingFor(ownerDiscordId);
  return Boolean(exempt || (tier && tier.id !== 'free'));
}

// Distinct live members across every store this owner runs — the number
// their plan is priced on. The owner is never one of them: sellers buy their
// own role to check the checkout works, and that test must not spend a seat
// on the plan they are being billed for.
export async function memberUsage(ownerDiscordId) {
  const stores = await storesOwnedBy(ownerDiscordId);
  if (!stores.length) return 0;
  return db.countLiveMembers(stores.map((s) => s.id ?? null), { except: [ownerDiscordId] });
}

// Checkout gate: does creating a NEW membership in this store exceed the
// owner's plan? Existing members always pass (renewals and re-purchases are
// never hostage to the owner's plan).
export async function memberLimitBlocks(store, buyerDiscordId) {
  const owner = store?.ownerDiscordId;
  if (!owner) return false;
  // The seller buying from their own shop is a test of the shop. It does not
  // count towards their plan (memberUsage excludes them), so it must not be
  // refused by it either — otherwise a seller sitting on their limit cannot
  // check their own checkout still works.
  if (buyerDiscordId && String(buyerDiscordId) === String(owner)) return false;
  const { tier, exempt } = await billingFor(owner);
  if (exempt || tier.maxMembers === null) return false;
  if (buyerDiscordId) {
    const own = (await db.subscriptionsForMember(buyerDiscordId)).filter((s) => {
      const sid = s.store_id === null || s.store_id === undefined ? null : Number(s.store_id);
      return sid === (store.id ?? null) && (s.status === 'active' || s.status === 'past_due');
    });
    if (own.length) return false;
  }
  return (await memberUsage(owner)) >= tier.maxMembers;
}

// ── self-provisioned recurring prices on the platform account ────────────────
// Same philosophy as the webhook doctor: nothing to hand-copy. Each paid tier
// gets a product + monthly price created once via lookup_key and reused
// forever; the cached id is re-verified before use so a deleted price heals.

const lookupKey = (tier, interval) => `ripley_platform_${tier.id}${interval === 'year' ? '_year' : ''}`;

async function findPriceByLookup(tier, interval) {
  const list = await stripeFetch(`/v1/prices?active=true&limit=10&lookup_keys[0]=${encodeURIComponent(lookupKey(tier, interval))}`);
  return (list.data ?? [])[0] ?? null;
}

export async function ensureTierPrice(tier, interval = 'month') {
  const cacheName = interval === 'year' ? `platform_price_${tier.id}_year` : `platform_price_${tier.id}`;
  const wantCents = Math.round((interval === 'year' ? tier.yearlyUsd : tier.priceUsd) * 100);
  // A cached or looked-up price is only reusable if it still charges what the
  // site advertises. Without this check, editing TIERS repriced every page on
  // the site while Stripe quietly went on billing the old amount.
  const usable = (p) => p && p.active && p.currency === 'usd' && p.unit_amount === wantCents;

  const cached = await db.getAppSecret(cacheName);
  if (cached) {
    const price = await stripeFetch(`/v1/prices/${cached}`).catch(() => null);
    if (usable(price)) return price;
  }
  const found = await findPriceByLookup(tier, interval);
  if (usable(found)) {
    await db.setAppSecret(cacheName, found.id);
    return found;
  }

  // Either the tier has no price yet, or its advertised price moved. Reuse the
  // existing product so Stripe does not accumulate one per price change, and
  // let transfer_lookup_key carry the lookup key onto the new price. Live
  // subscriptions keep billing their original price until their owner switches
  // plans — Stripe grandfathers them by design, and so do we.
  const priorProduct = typeof found?.product === 'string' ? found.product : found?.product?.id;
  const productId =
    priorProduct ??
    (
      await stripeFetch('/v1/products', {
        method: 'POST',
        form: {
          name: `Dues ${tier.name}`,
          description: `Dues platform plan — ${tier.maxMembers === null ? 'unlimited' : `up to ${tier.maxMembers}`} paying members`,
          metadata: { managed_by: 'ripley-paygate', tier: tier.id },
        },
      })
    ).id;

  const price = await stripeFetch('/v1/prices', {
    method: 'POST',
    form: {
      product: productId,
      currency: 'usd',
      unit_amount: wantCents,
      recurring: { interval },
      lookup_key: lookupKey(tier, interval),
      transfer_lookup_key: 'true',
      metadata: { managed_by: 'ripley-paygate', tier: tier.id },
    },
  });
  await db.setAppSecret(cacheName, price.id);
  return price;
}

// Stripe Checkout for a tier upgrade. metadata.kind routes the webhook away
// from the buyer-grant path and into platform billing.
export async function createBillingCheckout(ownerDiscordId, tier, interval = 'month') {
  const price = await ensureTierPrice(tier, interval);
  return stripeFetch('/v1/checkout/sessions', {
    method: 'POST',
    form: {
      mode: 'subscription',
      client_reference_id: ownerDiscordId,
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: { kind: 'platform_plan', tier: tier.id, owner_discord_id: ownerDiscordId },
      subscription_data: {
        metadata: { kind: 'platform_plan', tier: tier.id, owner_discord_id: ownerDiscordId },
      },
      success_url: `${config.publicBaseUrl}/dashboard?upgraded=${encodeURIComponent(tier.id)}`,
      cancel_url: `${config.publicBaseUrl}/dashboard`,
    },
  });
}

// Cancel the paid plan now: Stripe subscription deleted, row downgraded.
// (The deletion webhook will land too — idempotent by then.)
export async function cancelBilling(ownerDiscordId) {
  const row = await db.getPlatformBilling(ownerDiscordId);
  if (!row || !tierStillPaid(row)) return { canceled: false };
  if (row.provider_ref) {
    await stripeFetch(`/v1/subscriptions/${row.provider_ref}`, { method: 'DELETE' }).catch((err) => {
      // Already gone on Stripe's side is success, anything else surfaces.
      if (!/404/.test(err.message)) throw err;
    });
  }
  await db.upsertPlatformBilling({
    ownerDiscordId,
    tier: row.tier,
    providerRef: row.provider_ref,
    status: 'canceled',
    currentPeriodEnd: row.current_period_end ?? null,
  });
  return { canceled: true };
}

// ── webhook lifecycle (called from stripe-events) ────────────────────────────

export async function activatePlatformPlan({ ownerDiscordId, tierId, subscriptionId }) {
  const tier = tierById(tierId);
  if (!tier || !ownerDiscordId) return;
  // Tier switch: one live plan per owner. The previous Stripe subscription is
  // ended so nobody pays for two tiers at once.
  const prev = await db.getPlatformBilling(ownerDiscordId);
  if (prev?.provider_ref && prev.provider_ref !== subscriptionId && (prev.status === 'active' || prev.status === 'past_due')) {
    await stripeFetch(`/v1/subscriptions/${prev.provider_ref}`, { method: 'DELETE' }).catch(() => {});
  }
  const sub = subscriptionId ? await getSubscription(subscriptionId).catch(() => null) : null;
  await db.upsertPlatformBilling({
    ownerDiscordId,
    tier: tier.id,
    providerRef: subscriptionId ?? null,
    status: 'active',
    currentPeriodEnd: sub ? subscriptionPeriodEnd(sub) : null,
  });
}

// Whether this Stripe subscription id belongs to platform billing (an owner's
// Dues plan) rather than a buyer membership.
export async function isPlatformSubscription(subscriptionId) {
  return Boolean(await db.getPlatformBillingByRef(subscriptionId));
}

// Returns true when the Stripe subscription in an event is a platform-plan
// subscription — the caller then skips the buyer-entitlement path entirely.
export async function applyPlatformSubscriptionEvent(subscriptionId, { status, periodEnd }) {
  const row = await db.getPlatformBillingByRef(subscriptionId);
  if (!row) return false;
  await db.upsertPlatformBilling({
    ownerDiscordId: row.owner_discord_id,
    tier: row.tier,
    providerRef: subscriptionId,
    status: status ?? row.status,
    currentPeriodEnd: periodEnd === undefined ? (row.current_period_end ?? null) : periodEnd,
  });
  return true;
}
