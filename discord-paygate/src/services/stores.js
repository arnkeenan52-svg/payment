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
import { uploadKind } from '../lib/upload.js';
import { normalize as normalizeCurrency } from '../lib/currency.js';

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
    about: null,
    links: null,
    showMembers: false,
    dashboardPrefs: null,
    // The built-in store has no row, so it has no review ledger to aggregate
    // and no seller to author an identity. Every one of these must be present
    // and falsy: a missing key here reads as `undefined` everywhere downstream.
    reviewsOn: false,
    creatorName: null,
    team: null,
    teamHeading: null,
    currency: 'usd',
    // The built-in store has no row, so it has no seller wallet. Present and
    // null on purpose: `undefined` here reads as "not set" everywhere
    // downstream by accident rather than by decision.
    cryptoWallet: null,
    cryptoChain: null,
    isDefault: true,
  };
}

function hydrate(row) {
  if (!row) return null;
  // Decrypted once. null here means the row HAS a sealed key and it will not
  // open — a rotated SECRET_KEY — which is a different state from "no key",
  // and one the checkout must refuse rather than paper over.
  const ownKey = row.stripe_secret_enc ? openSecret(row.stripe_secret_enc) : null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    bannerUrl: row.banner_url ?? null,
    ownerDiscordId: row.owner_discord_id,
    guildId: row.guild_id,
    stripeKey: row.stripe_secret_enc ? ownKey : config.stripe.secretKey,
    stripeKeyBroken: Boolean(row.stripe_secret_enc) && ownKey === null,
    // Whether this store has a key OF ITS OWN. stripeKey above falls back to
    // the platform's, so it can never answer "has the seller connected
    // Stripe?" — and the setup checklist needs exactly that question. A
    // boolean, never the key.
    hasOwnStripeKey: Boolean(row.stripe_secret_enc),
    webhookSecret: row.stripe_webhook_secret ?? null,
    notifyChannelId: row.notify_channel_id ?? null,
    theme: row.theme ? JSON.parse(row.theme) : null,
    about: row.about ?? null,
    links: row.links ? JSON.parse(row.links) : null,
    showMembers: Boolean(Number(row.show_members ?? 0)),
    dashboardPrefs: row.dashboard_prefs ? JSON.parse(row.dashboard_prefs) : null,
    discoverable: Boolean(Number(row.discoverable ?? 0)),
    category: row.category ?? null,
    reviewsOn: Boolean(Number(row.reviews_on ?? 0)),
    creatorName: row.creator_name ?? null,
    // The currency this store prices in. Normalised on the way out so a row
    // written before the column existed, or hand-edited to something Stripe
    // does not accept, degrades to USD rather than reaching the charge path.
    currency: normalizeCurrency(row.currency),
    // The seller's OWN crypto payout address and the network it is on. Null
    // is the honest answer for a store that has not set one, and the crypto
    // checkout refuses to start rather than let a payment settle anywhere
    // but here.
    cryptoWallet: row.crypto_wallet ?? null,
    cryptoChain: row.crypto_chain ?? null,
    // Seller-authored, same storage idiom as links. A row written before this
    // column existed parses as null, not as a crash.
    team: row.team ? JSON.parse(row.team) : null,
    teamHeading: row.team_heading ?? null,
    status: row.status,
    createdAt: row.created_at ? Number(row.created_at) : null,
    isDefault: false,
  };
}

export async function storeBySlug(slug) {
  // No slug = internal callers (legacy webhooks, reconcile) meaning the
  // built-in store. By URL it is reachable ONLY at its own unique slug.
  if (!slug) return defaultStore();
  const def = defaultStore();
  if (def && slug === defaultSlug()) {
    // The built-in guild's OWN managed store may hold the brand slug (rows
    // from before the reserved-slug guard, or an owner claiming it via the
    // guild-aware guard). It is the editable twin every by-guild lookup
    // already prefers — shadowing it here split the catalog: products made
    // in the dashboard (and their copied links) never appeared on the
    // storefront, which kept selling the env catalog instead. The twin wins
    // once it actually sells something; a bare row leaves the env-configured
    // checkout untouched.
    // SECURITY: a row with this slug but ANOTHER guild is an impostor and
    // never resolves (belt-and-braces with the write guard — this also
    // neutralizes foreign rows that predate it). Buyers of the brand link
    // reach the platform's real store, whichever of the two that is.
    const managed = hydrate(await db.getStoreBySlug(slug));
    if (managed) {
      // A managed row on ANOTHER guild is NOT an impostor: it is a real
      // tenant that already holds this slug, created before this deployment
      // configured a guild (isReservedSlug only blocks NEW foreign claims,
      // and only once DISCORD_GUILD_ID is set). Shadowing it hands its
      // buyers the platform's own catalog and silently kills a live store —
      // which is exactly what happened the day a guild id was first set on
      // a deployment whose BRAND still defaulted to a tenant's name. The
      // row wins outright; squatting stays blocked at write time.
      if (String(managed.guildId) !== String(def.guildId)) return managed;
      // The built-in guild's OWN twin still wins only once it actually
      // sells something, so a bare draft leaves the env checkout untouched.
      if ((await sellablePlansOf(managed)).length > 0) return managed;
    }
    return def;
  }
  return hydrate(await db.getStoreBySlug(slug));
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
    !(await managedStoreByGuild(def.guildId)) &&
    // ...and never beside a real store that already holds its slug: two
    // entries sharing one slug make the picker ambiguous, and the read-only
    // twin wins the lookup — the owner then sees "this is the built-in
    // store" where their own products and discounts used to be.
    !(await db.getStoreBySlug(def.slug))
  ) {
    rows.unshift(def);
  }
  return rows;
}

export async function everyStore() {
  const rows = (await db.allStores()).map(hydrate);
  const def = defaultStore();
  // Same rule as storesOwnedBy: the virtual twin steps aside for a real row
  // on its guild OR one already holding its slug.
  if (!def || rows.some((r) => String(r.guildId) === String(def.guildId) || r.slug === def.slug)) return rows;
  return [def, ...rows];
}

// Uploaded product photos are stored as ABSOLUTE /api/img URLs minted under
// whatever domain — and whatever store link — the platform had at upload time.
// Serving them re-based on the current base keeps every photo alive across
// domain moves (ripleybot.com → dues.gg), and re-based on the current slug
// keeps it alive across a store RENAME: /api/img resolves by slug, so a stored
// URL naming the old link 404s every photo the moment the owner changes it.
// Foreign image links pass through untouched.
export function rebaseImageUrl(u, currentSlug = null) {
  if (typeof u !== 'string') return u ?? null;
  const at = u.indexOf('/api/img?');
  if (at <= 0) return u;
  const rest = u.slice(at);
  if (!currentSlug) return `${config.publicBaseUrl}${rest}`;
  const q = rest.indexOf('?');
  const params = new URLSearchParams(rest.slice(q + 1));
  params.set('store', currentSlug); // set, not append — keeps the parameter's place
  return `${config.publicBaseUrl}${rest.slice(0, q)}?${params.toString()}`;
}

// The store's banner. An upload always beats a pasted link, and its URL is
// minted here from the CURRENT slug rather than stored — the same rename trap
// rebaseImageUrl exists for, with no stored value to go stale. updated_at is
// the cache-buster, so replacing the banner is visible immediately behind the
// endpoint's one-hour cache-control.
export async function bannerFor(store) {
  if (!store) return { url: null, kind: null };
  if (store.id !== null && store.id !== undefined) {
    const media = await db.getStoreMediaMeta(store.id, 'banner');
    if (media) {
      return {
        url: `${config.publicBaseUrl}/api/img?store=${encodeURIComponent(store.slug)}&kind=banner&v=${media.updatedAt}`,
        kind: uploadKind(media.mime),
      };
    }
  }
  const linked = typeof store.bannerUrl === 'string' && store.bannerUrl.trim() ? store.bannerUrl.trim() : null;
  if (!linked) return { url: null, kind: null };
  return { url: linked, kind: /\.(mp4|webm)([?#]|$)/i.test(linked) ? 'video' : 'image' };
}

// The store's product catalog in the same shape plans.json uses, so the
// storefront, checkout and entitlements treat both kinds identically.
export async function plansOf(store) {
  if (!store) return [];
  if (store.isDefault) return config.plans;
  const plans = (await db.storePlansFor(store.id)).map((p) => ({
    id: p.planKey,
    // The plan id is only unique WITHIN a store. Anything that keys a cache
    // on a plan has to key it on this too.
    storeId: store.id,
    name: p.name,
    description: p.description ?? '',
    descriptionHighlight: null,
    imageUrl: rebaseImageUrl(p.imageUrl, store.slug),
    mediaKind: p.mediaKind ?? null,
    roleNames: p.roleNames,
    priceUsd: p.priceUsd,
    // The currency the price is in. Read off the plan row, not the store, so a
    // store that changes currency cannot retroactively re-denominate the
    // products it already sold under the old one.
    currency: normalizeCurrency(p.currency ?? store.currency),
    interval: p.lifetime ? 'lifetime' : 'month',
    lifetime: p.lifetime,
    durationDays: p.durationDays,
    stripePriceId: p.stripePriceId,
    roleIds: p.roleIds,
    active: p.active,
    purchaseLimit: p.purchaseLimit,
    successUrl: p.successUrl,
    linkSlug: p.linkSlug ?? null,
    variantOf: p.variantOf ?? null,
    expiresAt: p.expiresAt ?? null,
    requiredRoleId: p.requiredRoleId ?? null,
    requiredRoleName: p.requiredRoleName ?? null,
    createdAt: p.createdAt,
  }));
  // A variant is one PRICE OPTION of its parent product: price, billing and
  // option label are its own; everything that identifies the product — name
  // on the page, photo, description, the roles a buyer receives — is read
  // from the parent so the group can never drift apart.
  const byKey = new Map(plans.map((p) => [p.id, p]));
  for (const v of plans) {
    if (!v.variantOf) continue;
    const parent = byKey.get(v.variantOf);
    if (!parent) continue;
    v.description = parent.description;
    v.descriptionHighlight = parent.descriptionHighlight;
    v.imageUrl = parent.imageUrl;
    v.mediaKind = parent.mediaKind ?? null;
    v.roleIds = parent.roleIds;
    v.roleNames = parent.roleNames;
    v.successUrl = v.successUrl ?? parent.successUrl;
    // Availability and purchase gating are PRODUCT decisions — every price
    // option ends when the product ends and is locked when the product is.
    v.expiresAt = parent.expiresAt;
    v.requiredRoleId = parent.requiredRoleId;
    v.requiredRoleName = parent.requiredRoleName;
  }
  return plans;
}

// What buyers see: only products the owner has switched on. Entitlements and
// role reconciliation keep using plansOf — a deactivated product must never
// strip roles from people who already bought it. A price option sells only
// while its own toggle AND its parent product's toggle are on (an orphaned
// option — parent gone — never sells).
export async function sellablePlansOf(store) {
  const plans = await plansOf(store);
  const now = Math.floor(Date.now() / 1000);
  const fresh = (p) => p.active !== false && (!p.expiresAt || p.expiresAt > now);
  const freshByKey = new Map(plans.map((p) => [p.id, fresh(p)]));
  return plans.filter((p) => fresh(p) && (!p.variantOf || freshByKey.get(p.variantOf) === true));
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

// Store links live at the domain root (dues.gg/<slug>), so every path
// the platform itself uses is off-limits as a store name.
const RESERVED_SLUGS = new Set([
  'store', 'account', 'dashboard', 'receipt', 'terms', 'privacy', 'diagnostics',
  'api', 'auth', 'webhooks', 's', 'admin', 'checkout', 'login', 'logout',
  'pricing', 'docs', 'help', 'support', 'status', 'assets', 'static',
  'vs', 'tools', 'use-cases', 'compare', 'blog', 'sitemap', 'robots',
  'guides', 'alternatives', 'llms', 'discover', 'demo',
]);

// The fixed category list for /discover. An enum, not free text — the
// directory filters on these, and free text would fragment it instantly.
export const STORE_CATEGORIES = [
  ['trading', 'Trading'],
  ['sports', 'Sports picks'],
  ['crypto', 'Crypto'],
  ['gaming', 'Gaming'],
  ['fitness', 'Fitness'],
  ['reselling', 'Reselling'],
  ['education', 'Education'],
  ['content', 'Content'],
  ['community', 'Community'],
  ['other', 'Other'],
];
export const isStoreCategory = (v) => STORE_CATEGORIES.some(([k]) => k === v);

export function isReservedSlug(slug, guildId = null) {
  const s = String(slug ?? '').toLowerCase();
  // The built-in store's own slug is reserved against every FOREIGN store: no
  // one else may claim the platform's brand link and hijack its storefront or
  // checkout. The built-in guild's own managed store is the one exception —
  // holding the brand slug is how its owner brings the brand link's catalog
  // into the dashboard (storeBySlug then resolves the managed row first).
  if (
    config.discord.guildId &&
    s === defaultSlug() &&
    String(guildId ?? '') !== String(config.discord.guildId)
  ) {
    return true;
  }
  return RESERVED_SLUGS.has(s);
}
