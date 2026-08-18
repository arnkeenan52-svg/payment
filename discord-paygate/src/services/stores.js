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

const DEFAULT_SLUG = 'store';

export function defaultStore() {
  if (!config.discord.guildId) return null;
  return {
    id: null,
    slug: DEFAULT_SLUG,
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
    status: row.status,
    isDefault: false,
  };
}

export async function storeBySlug(slug) {
  if (!slug || slug === DEFAULT_SLUG) return defaultStore();
  return hydrate(await db.getStoreBySlug(slug));
}

export async function storeById(id) {
  if (id === null || id === undefined || id === '') return defaultStore();
  return hydrate(await db.getStoreById(Number(id)));
}

export async function storeByGuild(guildId) {
  if (config.discord.guildId && String(guildId) === String(config.discord.guildId)) return defaultStore();
  return hydrate(await db.getStoreByGuild(String(guildId)));
}

export async function storesOwnedBy(discordId) {
  const rows = (await db.storesByOwner(discordId)).map(hydrate);
  const def = defaultStore();
  if (def && config.ownerDiscordId && discordId === config.ownerDiscordId) rows.unshift(def);
  return rows;
}

export async function everyStore() {
  const rows = (await db.allStores()).map(hydrate);
  const def = defaultStore();
  return def ? [def, ...rows] : rows;
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
]);

export function isReservedSlug(slug) {
  return RESERVED_SLUGS.has(String(slug ?? '').toLowerCase());
}
