// Store resolution for the multi-tenant platform.
//
// The BUILT-IN store is virtual (id null): it is configured by env +
// plans.json exactly as the original single-store deployment was, so an
// existing deployment keeps working untouched. Database stores (created
// through the dashboard wizard) carry their own guild, Stripe key
// (encrypted at rest) and product catalog.

import { config } from '../config.js';
import * as db from '../db.js';
import { openSecret } from '../lib/secretbox.js';

// The built-in store is NOT special to buyers: it lives at its own slug
// derived from its brand name (e.g. /tradeleaks), exactly like every other
// store. 'store' maps to NO store — it is a reserved platform word that no
// store may claim or squat, the built-in one included.
export function defaultSlug() {
  return slugify(config.brand);
}

export function defaultStore() {
  if (!config.discord.guildId) return null;
  return {
    id: null,
    slug: defaultSlug(),
    name: config.brand,
    ownerDiscordId: config.ownerDiscordId || null,
    guildId: config.discord.guildId,
    stripeKey: config.stripe.secretKey,
    webhookSecret: null, // env + doctor-stored secrets apply (webhook handler)
    status: 'live',
    isDefault: true,
  };
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    bannerUrl: row.banner_url ?? null,
    ownerDiscordId: row.owner_discord_id,
    guildId: row.guild_id,
    stripeKey: row.stripe_secret_enc ? openSecret(row.stripe_secret_enc) : config.stripe.secretKey,
    webhookSecret: row.stripe_webhook_secret ?? null,
    notifyChannelId: row.notify_channel_id ?? null,
    status: row.status,
    isDefault: false,
  };
}

export async function storeBySlug(slug) {
  // No slug = internal callers (legacy webhooks, reconcile) meaning the
  // built-in store. By URL it is reachable ONLY at its own unique slug.
  if (!slug) return defaultStore();
  const managed = hydrate(await db.getStoreBySlug(slug));
  if (managed) {
    // A managed store owns its slug — with one guard: while it is still a
    // DRAFT and its slug is the built-in store's, buyers keep the WORKING
    // env-configured store. A half-set-up store must never turn the live
    // checkout link into an empty page; it takes the link over when it goes
    // live (role attached), not before.
    const def = defaultStore();
    if (managed.status !== 'live' && def && slug === defaultSlug()) return def;
    return managed;
  }
  return slug === defaultSlug() ? defaultStore() : null;
}

// Owner-side resolution: the managed row wins outright, draft or live. The
// buyer-facing guard in storeBySlug (a draft cannot claim the built-in
// store's link) must not hide a draft from its own dashboard — its owner
// still needs to edit, finish or delete it.
export async function adminStoreBySlug(slug) {
  if (!slug) return defaultStore();
  const managed = hydrate(await db.getStoreBySlug(slug));
  if (managed) return managed;
  return slug === defaultSlug() ? defaultStore() : null;
}

export async function storeById(id) {
  if (id === null || id === undefined || id === '') return defaultStore();
  return hydrate(await db.getStoreById(Number(id)));
}

// A managed (database) store only — never the virtual built-in one. This is
// what onboarding and the server picker must consult: the built-in store is
// env configuration, and its guild stays onboardable until a real managed
// store exists for it.
export async function managedStoreByGuild(guildId) {
  return hydrate(await db.getStoreByGuild(String(guildId)));
}

export async function storeByGuild(guildId) {
  // Managed store first: once the owner onboards the built-in server
  // properly, every by-guild lookup sees the managed store (products,
  // discounts, custom link — all dashboard-editable). The virtual env store
  // remains the fallback so legacy /store checkouts keep working unchanged.
  const managed = await managedStoreByGuild(guildId);
  if (managed) return managed;
  if (config.discord.guildId && String(guildId) === String(config.discord.guildId)) return defaultStore();
  return null;
}

export async function storesOwnedBy(discordId) {
  const rows = (await db.storesByOwner(discordId)).map(hydrate);
  const def = defaultStore();
  // One server, one store: the virtual env-configured store steps aside in
  // every dashboard list once a managed (editable) store exists for its
  // guild — otherwise the owner sees a read-only twin next to the real one.
  if (
    def &&
    config.ownerDiscordId &&
    discordId === config.ownerDiscordId &&
    !(await managedStoreByGuild(def.guildId))
  ) {
    rows.unshift(def);
  }
  return rows;
}

export async function everyStore() {
  const rows = (await db.allStores()).map(hydrate);
  const def = defaultStore();
  if (!def || rows.some((r) => String(r.guildId) === String(def.guildId))) return rows;
  return [def, ...rows];
}

// The store's product catalog in the same shape plans.json uses, so the
// storefront, checkout and entitlements treat both kinds identically.
export async function plansOf(store) {
  if (!store) return [];
  if (store.isDefault) return config.plans;
  return (await db.storePlansFor(store.id)).map((p) => ({
    id: p.planKey,
    name: p.name,
    description: p.description ?? '',
    descriptionHighlight: null,
    imageUrl: p.imageUrl ?? null,
    roleNames: p.roleNames,
    priceUsd: p.priceUsd,
    interval: p.lifetime ? 'lifetime' : 'month',
    lifetime: p.lifetime,
    durationDays: p.durationDays,
    stripePriceId: p.stripePriceId,
    roleIds: p.roleIds,
    active: p.active,
    purchaseLimit: p.purchaseLimit,
    successUrl: p.successUrl,
    createdAt: p.createdAt,
  }));
}

// What buyers see: only products the owner has switched on. Entitlements and
// role reconciliation keep using plansOf — a deactivated product must never
// strip roles from people who already bought it.
export async function sellablePlansOf(store) {
  return (await plansOf(store)).filter((p) => p.active !== false);
}

export async function planOf(store, planId) {
  return (await plansOf(store)).find((p) => p.id === planId) ?? null;
}

export function slugify(name) {
  const base = String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'server';
}

// Store links live at the domain root (ripleybot.com/<slug>), so every path
// the platform itself uses is off-limits as a store name.
const RESERVED_SLUGS = new Set([
  'store', 'account', 'dashboard', 'receipt', 'terms', 'privacy', 'diagnostics',
  'api', 'auth', 'webhooks', 's', 'admin', 'checkout', 'login', 'logout',
  'pricing', 'docs', 'help', 'support', 'status', 'assets', 'static',
  'vs', 'tools', 'use-cases', 'compare', 'blog', 'sitemap', 'robots',
]);

export function isReservedSlug(slug) {
  return RESERVED_SLUGS.has(String(slug ?? '').toLowerCase());
}
