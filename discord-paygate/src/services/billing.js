// The owner's Ripley plan: platform billing, charged on RIPLEY's own Stripe
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

export const TIERS = [
  { id: 'free', name: 'Free', priceUsd: 0, maxMembers: 10 },
  { id: 'starter', name: 'Starter', priceUsd: 5.99, maxMembers: 50 },
  { id: 'growth', name: 'Growth', priceUsd: 19.99, maxMembers: 500 },
  { id: 'scale', name: 'Scale', priceUsd: 49.99, maxMembers: null }, // unlimited
];

export const tierById = (id) => TIERS.find((t) => t.id === id) ?? null;

const now = () => Math.floor(Date.now() / 1000);

// A paid tier stays effective while its Stripe subscription is alive:
// active, or past_due within the same grace window buyer plans get.
function tierStillPaid(row) {
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

// Distinct live members across every store this owner runs — the number
// their plan is priced on.
export async function memberUsage(ownerDiscordId) {
  const stores = await storesOwnedBy(ownerDiscordId);
  if (!stores.length) return 0;
  return db.countLiveMembers(stores.map((s) => s.id ?? null));
}

// Checkout gate: does creating a NEW membership in this store exceed the
// owner's plan? Existing members always pass (renewals and re-purchases are
// never hostage to the owner's plan).
export async function memberLimitBlocks(store, buyerDiscordId) {
  const owner = store?.ownerDiscordId;
  if (!owner) return false;
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

const lookupKey = (tier) => `ripley_platform_${tier.id}`;

async function findPriceByLookup(tier) {
  const list = await stripeFetch(`/v1/prices?active=true&limit=10&lookup_keys[0]=${encodeURIComponent(lookupKey(tier))}`);
  return (list.data ?? [])[0] ?? null;
}

export async function ensureTierPrice(tier) {
  const cacheName = `platform_price_${tier.id}`;
  const cached = await db.getAppSecret(cacheName);
  if (cached) {
    const price = await stripeFetch(`/v1/prices/${cached}`).catch(() => null);
    if (price && price.active) return price;
  }
  let price = await findPriceByLookup(tier);
  if (!price) {
    const product = await stripeFetch('/v1/products', {
      method: 'POST',
      form: {
        name: `Ripley ${tier.name}`,
        description: `Ripley platform plan — ${tier.maxMembers === null ? 'unlimited' : `up to ${tier.maxMembers}`} paying members`,
        metadata: { managed_by: 'ripley-paygate', tier: tier.id },
      },
    });
    price = await stripeFetch('/v1/prices', {
      method: 'POST',
      form: {
        product: product.id,
        currency: 'usd',
        unit_amount: Math.round(tier.priceUsd * 100),
        recurring: { interval: 'month' },
        lookup_key: lookupKey(tier),
        transfer_lookup_key: 'true',
        metadata: { managed_by: 'ripley-paygate', tier: tier.id },
      },
    });
  }
  await db.setAppSecret(cacheName, price.id);
  return price;
}

// Stripe Checkout for a tier upgrade. metadata.kind routes the webhook away
// from the buyer-grant path and into platform billing.
export async function createBillingCheckout(ownerDiscordId, tier) {
  const price = await ensureTierPrice(tier);
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
// Ripley plan) rather than a buyer membership.
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
