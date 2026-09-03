import { config } from '../src/config.js';
import { sendJson, sendText, readJsonBody, guard } from '../src/lib/http.js';
import { sessionUserId, createSessionCookie, revokeAllSessions } from '../src/lib/session.js';
import { ownerAuthorized } from '../src/lib/authz.js';
import * as db from '../src/db.js';
import { sealSecret } from '../src/lib/secretbox.js';
import { getUser } from '../src/db.js';
import { getUserGuilds, getGuild, getGuildRoles, getBotUser, getGuildMember, getGuildChannels } from '../src/lib/discord.js';
import { CHECKOUT_TTL_SECONDS, stripeFetch, createWebhookEndpoint, canonicalWebhookUrl, invalidatePriceCache, isStripeKey, stripeKeyMode } from '../src/lib/stripe.js';
import { managedStoreByGuild, storeBySlug, slugify, isReservedSlug, plansOf, rebaseImageUrl } from '../src/services/stores.js';
import { parseUploadDataUrl, UPLOAD_BODY_LIMIT } from '../src/lib/upload.js';
import { validatePlanBg } from '../src/lib/theme.js';
import { validateAmount, roundAmount, toMinor, formatAmount, minCharge, maxCharge, normalize as normalizeCurrency } from '../src/lib/currency.js';

const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

// Uploaded product media arrives as data URLs, on the platform-wide upload
// whitelist (src/lib/upload.js) that store banners share.
const isImageDataUrl = (v) => parseUploadDataUrl(v) !== null;

async function callerManagesGuild(uid, guildId) {
  const user = await getUser(uid);
  if (!user?.access_token) return false;
  let guilds;
  try {
    guilds = await getUserGuilds(user.access_token);
  } catch {
    return false;
  }
  const g = guilds.find((x) => String(x.id) === String(guildId));
  if (!g) return false;
  if (g.owner) return true;
  try {
    const perms = BigInt(g.permissions ?? 0);
    return (perms & ADMINISTRATOR) !== 0n || (perms & MANAGE_GUILD) !== 0n;
  } catch {
    return false;
  }
}

async function ownedStore(uid, storeId, req) {
  // An integer or nothing. Number(undefined) is NaN, and the two storage
  // engines disagree about NaN as a bound parameter: SQLite binds it as NULL
  // and finds no row (a clean 403); Postgres rejects it and the handler 500s.
  // The suite runs on SQLite, which is why it never saw production do this.
  const id = Number(storeId);
  // Safe integers only: pg serialises 1e21 as "1e+21" and 2^63 past bigint's
  // range, and both surface as a 500 instead of this 403. isInteger let them by.
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = await db.getStoreById(id);
  if (!row) return null;
  // The platform operator can act on any store — same bypass the sibling
  // admin endpoints grant, so the Platform admin view is fully functional.
  if (row.owner_discord_id !== uid && !(req && await ownerAuthorized(req))) return null;
  return row;
}

// The whole onboarding wizard behind one endpoint: POST { step, ... }.
// Every step re-validates LIVE (guild admin, bot presence, Stripe key) —
// the client is a convenience, never the authority.
export default guard(async function handler(req, res) {
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  const uid = await sessionUserId(req);
  if (!uid) {
    sendJson(res, 401, { error: 'sign in with Discord first' });
    return;
  }
  const body = await readJsonBody(req, { maxBytes: UPLOAD_BODY_LIMIT }).catch(() => ({}));

  switch (body?.step) {
    // ── 0. is the bot in this guild yet? ────────────────────────────────────
    // Uses ONLY the bot token — deliberately no getUserGuilds call, because
    // Discord rate-limits /users/@me/guilds hard and the wizard polls this.
    case 'botcheck': {
      const guildId = String(body.guildId ?? '');
      if (!/^\d{17,20}$/.test(guildId)) return sendJson(res, 400, { error: 'Pick a server first.' });
      return sendJson(res, 200, { botIn: Boolean(await getGuild(guildId)) });
    }

    // ── 1. create the store: guild + Stripe secret key ──────────────────────
    case 'store': {
      const guildId = String(body.guildId ?? '');
      const stripeKey = String(body.stripeKey ?? '').trim();
      if (!isText(body.name)) return sendJson(res, 400, { error: 'The store name must be text.' });
      const name = String(body.name ?? '').trim().slice(0, 60);
      if (!/^\d{17,20}$/.test(guildId)) return sendJson(res, 400, { error: 'Pick a server first.' });
      if (!name) return sendJson(res, 400, { error: 'Give your store a name.' });
      if (!isStripeKey(stripeKey)) {
        return sendJson(res, 400, { error: 'That does not look like a Stripe API key. Restricted keys (rk_live_…) and secret keys (sk_live_…) both work.' });
      }
      if (!(await callerManagesGuild(uid, guildId))) {
        return sendJson(res, 403, { error: 'You need Manage Server or Administrator in that Discord server.' });
      }
      // A store whose webhook registration failed on a previous attempt must
      // not dead-end the wizard: the same owner's unfinished draft is
      // resumed — fresh key stored, webhook retried — instead of refused.
      const existingStore = await managedStoreByGuild(guildId);
      if (existingStore && !(existingStore.ownerDiscordId === uid && existingStore.status !== 'live' && !existingStore.webhookSecret)) {
        return sendJson(res, 409, { error: 'That server already has a store.' });
      }
      if (!(await getGuild(guildId))) {
        return sendJson(res, 409, { error: 'bot_missing', detail: 'The Dues bot is not in that server yet — invite it, then retry.' });
      }
      // The key must actually work before anything is stored.
      let account;
      try {
        account = await stripeFetch('/v1/account', { key: stripeKey });
      } catch {
        return sendJson(res, 400, { error: 'Stripe rejected that key. Create one under Stripe → Developers → API keys — a restricted key needs the permissions listed above.' });
      }
      if (existingStore) {
        // stripeAccountId is which BUSINESS this store is — it groups stores
        // that settle to one Stripe account into one plan, whoever owns the
        // Discord accounts (src/services/billing.js). The /v1/account call
        // above already fetched it to validate the key.
        await db.updateStore(existingStore.id, {
          stripeSecretEnc: sealSecret(stripeKey),
          stripeAccountId: account?.id ? String(account.id) : null,
        });
        // A key re-entered on an existing store revokes every other session
        // (see api/admin/store.js); the caller's own cookie is re-issued.
        res.setHeader('set-cookie', createSessionCookie(uid, await revokeAllSessions(uid)));
        try {
          const base = await canonicalWebhookUrl();
          const url = base.replace(/\/webhooks\/stripe$/, `/webhooks/stripe/${existingStore.id}`);
          const endpoint = await createWebhookEndpoint(url, stripeKey);
          await db.updateStore(existingStore.id, { stripeWebhookSecret: endpoint.secret });
        } catch (err) {
          console.error(`[onboard] webhook registration for store ${existingStore.id} failed: ${err.message}`);
          return sendJson(res, 502, { error: 'Stripe accepted the key but webhook setup failed — try again in a minute.' });
        }
        return sendJson(res, 200, {
          ok: true,
          store: { id: existingStore.id, slug: existingStore.slug, name: existingStore.name, guildId, mode: stripeKeyMode(stripeKey), stripeAccount: account.id ?? null },
        });
      }

      let slug = slugify(name);
      if (isReservedSlug(slug, guildId) || (await db.getStoreBySlug(slug))) {
        slug = `${slug}-${guildId.slice(-4)}`;
        if (await db.getStoreBySlug(slug)) return sendJson(res, 409, { error: 'Try a different store name.' });
      }
      const row = await db.createStore({
        slug,
        name,
        ownerDiscordId: uid,
        guildId,
        stripeSecretEnc: sealSecret(stripeKey),
        status: 'draft',
      });
      // Which business this new store is — see the update path above.
      await db.updateStore(row.id, { stripeAccountId: account?.id ? String(account.id) : null }).catch(() => {});

      // Register this store's own webhook endpoint on THEIR Stripe account;
      // its signing secret verifies every delivery for this store.
      try {
        const base = await canonicalWebhookUrl();
        const url = base.replace(/\/webhooks\/stripe$/, `/webhooks/stripe/${row.id}`);
        const endpoint = await createWebhookEndpoint(url, stripeKey);
        await db.updateStore(row.id, { stripeWebhookSecret: endpoint.secret });
      } catch (err) {
        console.error(`[onboard] webhook registration for store ${row.id} failed: ${err.message}`);
        return sendJson(res, 502, {
          error: 'Stripe accepted the key but webhook setup failed — try again in a minute.',
        });
      }
      return sendJson(res, 200, {
        ok: true,
        store: { id: row.id, slug, name, guildId, mode: stripeKeyMode(stripeKey), stripeAccount: account.id ?? null },
      });
    }

    // ── 2. create the product on their Stripe account ───────────────────────
    case 'product': {
      const row = await ownedStore(uid, body.storeId, req);
      if (!row) return sendJson(res, 403, { error: 'not your store' });
      if (!isText(body.name) || !isText(body.description)) return sendJson(res, 400, { error: 'The product name and description must be text.' });
      const name = String(body.name ?? '').trim().slice(0, 80);
      const description = String(body.description ?? '').trim().slice(0, 300);
      // Priced in the store's own currency, and checked against Stripe's real
      // limits for it. A 500 JPY product and a 20,000,000 IDR one are both
      // ordinary, and the old flat $1–$10,000 rule refused each of them.
      const currency = normalizeCurrency(row.currency);
      const priceUsd = roundAmount(Number(body.priceUsd), currency);
      const lifetime = body.lifetime !== false;
      const durationDays = lifetime ? null : termDays(body.durationDays);
      if (!lifetime && durationDays === null) return sendJson(res, 400, { error: 'Term length must be a whole number of days.' });
      if (!name) return sendJson(res, 400, { error: 'Name your product.' });
      if (!validateAmount(priceUsd, currency).ok) {
        return sendJson(res, 400, {
          error: `Price must be between ${formatAmount(minCharge(currency), currency)} and ${formatAmount(maxCharge(currency), currency)}.`,
        });
      }
      // Photo: an uploaded data URL (dashboard photo picker) wins over a
      // pasted link. It is stored on the row and served from /api/img.
      // The key must be unique in the store: a second product whose name
      // slugifies to an existing key must never overwrite the first.
      let planKey = slugify(name) || 'premium';
      {
        const taken = new Set((await db.storePlansFor(row.id)).map((p) => p.planKey));
        if (taken.has(planKey)) {
          let n = 2;
          while (taken.has(`${planKey}-${n}`)) n += 1;
          planKey = `${planKey}-${n}`;
        }
      }
      if (body.imageData !== undefined && body.imageData !== null && !isImageDataUrl(body.imageData)) {
        return sendJson(res, 400, { error: 'That photo could not be read — use a JPG, PNG, WebP or GIF under 1.5MB.' });
      }
      const uploaded = isImageDataUrl(body.imageData) ? body.imageData : null;
      const pasted = String(body.imageUrl ?? '').trim();
      if (pasted.length > MAX_URL) return sendJson(res, 400, { error: `The photo link tops out at ${MAX_URL} characters.` });
      const linked = /^https:\/\/\S+$/.test(pasted) ? pasted : null;
      const imageUrl = uploaded
        ? `${config.publicBaseUrl}/api/img?store=${encodeURIComponent(row.slug)}&plan=${encodeURIComponent(planKey)}`
        : linked;
      const { openSecret } = await import('../src/lib/secretbox.js');
      const key = openSecret(row.stripe_secret_enc);
      if (!key) return sendJson(res, 409, { error: 'Stripe key unreadable — re-enter it in step 1.' });
      let product;
      try {
        product = await stripeFetch('/v1/products', {
          method: 'POST',
          key,
          form: {
            name,
            ...(description ? { description } : {}),
            ...(imageUrl?.startsWith('https://') ? { images: [imageUrl] } : {}),
            default_price_data: {
              currency,
              unit_amount: toMinor(priceUsd, currency),
              ...(lifetime ? {} : { recurring: { interval: 'month' } }),
            },
          },
        });
      } catch (err) {
        console.error(`[onboard] product creation for store ${row.id} failed: ${err.message}`);
        return sendJson(res, 502, { error: 'Stripe would not create the product — check the key and try again.' });
      }
      let plan = await db.createStorePlan({
        storeId: row.id,
        planKey,
        name,
        description,
        imageUrl,
        priceUsd,
        currency,
        lifetime,
        durationDays,
        stripePriceId: typeof product.default_price === 'string' ? product.default_price : product.default_price?.id ?? null,
      });
      if (uploaded) plan = await db.updateStorePlan(row.id, planKey, { imageData: uploaded });
      return sendJson(res, 200, { ok: true, plan });
    }

    // ── price options: extra billing choices INSIDE one product ─────────────
    // "Lifetime $500 or Monthly $50" as ONE product with two options: each
    // option is its own plan row (own Stripe price, own payments and members)
    // marked variant_of the parent, inheriting the parent's name, photo,
    // description, roles and link. Its `name` is the option label.
    case 'variant': {
      const row = await ownedStore(uid, body.storeId, req);
      if (!row) return sendJson(res, 403, { error: 'not your store' });
      const parentKey = String(body.planKey ?? '');
      const parent = await db.getStorePlan(row.id, parentKey);
      if (!parent) return sendJson(res, 404, { error: 'unknown product' });
      if (parent.variantOf) {
        return sendJson(res, 400, { error: 'Options cannot have options of their own — add it to the product instead.' });
      }
      const siblings = await db.storePlansFor(row.id);
      if (siblings.filter((p) => p.variantOf === parentKey).length >= 5) {
        return sendJson(res, 400, { error: 'A product can carry at most 6 pricing options.' });
      }
      const lifetime = body.lifetime !== false;
      const durationDays = lifetime ? null : termDays(body.durationDays);
      if (!lifetime && durationDays === null) return sendJson(res, 400, { error: 'Term length must be a whole number of days.' });
      const currency = normalizeCurrency(row.currency);
      const priceUsd = roundAmount(Number(body.priceUsd), currency);
      if (!validateAmount(priceUsd, currency).ok) {
        return sendJson(res, 400, {
          error: `Price must be between ${formatAmount(minCharge(currency), currency)} and ${formatAmount(maxCharge(currency), currency)}.`,
        });
      }
      // The option's label becomes its plan key, which no later edit can
      // change: String() on an object made the permanent key
      // "vip-object-object" behind a 200.
      if (!isText(body.label)) return sendJson(res, 400, { error: 'The option label must be text.' });
      const label = String(body.label ?? '').trim().slice(0, 40) || (lifetime ? 'Lifetime' : 'Monthly');
      let planKey = `${parentKey}-${slugify(label)}`.slice(0, 60);
      {
        const taken = new Set(siblings.map((p) => p.planKey));
        if (taken.has(planKey)) {
          let n = 2;
          while (taken.has(`${planKey}-${n}`)) n += 1;
          planKey = `${planKey}-${n}`;
        }
      }
      const { openSecret } = await import('../src/lib/secretbox.js');
      const key = openSecret(row.stripe_secret_enc);
      if (!key) return sendJson(res, 409, { error: 'Stripe key unreadable — re-enter it in Settings.' });
      let product;
      try {
        product = await stripeFetch('/v1/products', {
          method: 'POST',
          key,
          form: {
            name: `${parent.name} — ${label}`,
            ...(parent.description ? { description: parent.description } : {}),
            default_price_data: {
              currency,
              unit_amount: toMinor(priceUsd, currency),
              ...(lifetime ? {} : { recurring: { interval: 'month' } }),
            },
          },
        });
      } catch (err) {
        console.error(`[onboard] option creation for store ${row.id}/${parentKey} failed: ${err.message}`);
        return sendJson(res, 502, { error: 'Stripe would not create the option — check the key and try again.' });
      }
      const plan = await db.createStorePlan({
        storeId: row.id,
        planKey,
        name: label,
        description: null,
        imageUrl: null,
        priceUsd,
        currency,
        lifetime,
        durationDays,
        stripePriceId: typeof product.default_price === 'string' ? product.default_price : product.default_price?.id ?? null,
        variantOf: parentKey,
      });
      return sendJson(res, 200, { ok: true, plan });
    }

    // ── 3. the role buyers receive ──────────────────────────────────────────
    case 'roles': {
      const row = await ownedStore(uid, body.storeId, req);
      if (!row) return sendJson(res, 403, { error: 'not your store' });
      const roles = await getGuildRoles(row.guild_id);
      const bot = await getBotUser();
      const botMember = await getGuildMember(bot.id, row.guild_id);
      const byId = new Map(roles.map((r) => [r.id, r]));
      let botTop = { name: '@everyone', position: 0 };
      for (const rid of botMember?.roles ?? []) {
        const r = byId.get(rid);
        if (r && r.position > botTop.position) botTop = { name: r.name, position: r.position };
      }
      return sendJson(res, 200, {
        botTop,
        roles: roles
          .slice()
          .sort((a, b) => b.position - a.position)
          .map((r) => ({
            id: r.id,
            name: r.name,
            position: r.position,
            color: r.color ? `#${Number(r.color).toString(16).padStart(6, '0')}` : null,
            usable: r.id !== row.guild_id && !r.managed && r.position < botTop.position,
            reason:
              r.id === row.guild_id
                ? '@everyone cannot be granted'
                : r.managed
                  ? 'managed by an integration'
                  : r.position >= botTop.position
                    ? `at or above the bot's top role — drag Dues's role higher in Server Settings → Roles`
                    : null,
          })),
      });
    }

    // Text channels of the store's server, for the sale-notification picker.
    case 'channels': {
      const row = await ownedStore(uid, body.storeId, req);
      if (!row) return sendJson(res, 403, { error: 'not your store' });
      const channels = await getGuildChannels(row.guild_id);
      if (!channels) {
        return sendJson(res, 409, { error: 'Could not list channels — is the Dues bot still in your server?' });
      }
      return sendJson(res, 200, { channels });
    }

    // ── 4. pick the role, go live ───────────────────────────────────────────
    case 'role': {
      const row = await ownedStore(uid, body.storeId, req);
      if (!row) return sendJson(res, 403, { error: 'not your store' });
      const planKey = String(body.planKey ?? '');
      const roleId = String(body.roleId ?? '');
      const plan = await db.getStorePlan(row.id, planKey);
      if (!plan) return sendJson(res, 400, { error: 'unknown product' });
      const roles = await getGuildRoles(row.guild_id);
      const role = roles.find((r) => r.id === roleId);
      if (!role || role.managed || role.id === row.guild_id) {
        return sendJson(res, 400, { error: 'That role cannot be granted by the bot.' });
      }
      const bot = await getBotUser();
      const botMember = await getGuildMember(bot.id, row.guild_id);
      const byId = new Map(roles.map((r) => [r.id, r]));
      let botTop = 0;
      for (const rid of botMember?.roles ?? []) botTop = Math.max(botTop, byId.get(rid)?.position ?? 0);
      if (role.position >= botTop) {
        return sendJson(res, 400, {
          error: `"${role.name}" sits at or above the bot's top role — drag Dues's role above it in Server Settings → Roles, then retry.`,
        });
      }
      // Roles belong to the PRODUCT, not to one of its price options — a role
      // aimed at an option lands on the parent, and every option inherits it.
      await db.setStorePlanRoles(row.id, plan.variantOf ?? planKey, [role.id], [`@${role.name}`]);
      await db.updateStore(row.id, { status: 'live' });
      const store = await storeBySlug(row.slug);
      return sendJson(res, 200, { ok: true, store: { slug: store.slug, status: store.status }, plans: await plansOf(store) });
    }

    // ── manage products after onboarding (the dashboard Products tab) ───────
    // The owner's full catalog — inactive products included (buyers never see
    // those; this is the management view).
    case 'products': {
      const row = await ownedStore(uid, body.storeId, req);
      if (!row) return sendJson(res, 403, { error: 'not your store' });
      const plans = await db.storePlansFor(row.id);
      const byKey = new Map(plans.map((p) => [p.planKey, p]));
      const out = [];
      for (const p of plans) {
        // A price option shares its product's page — its copy-link is the
        // parent's link (opening it preselects the option client-side).
        const linkOwner = (p.variantOf && byKey.get(p.variantOf)) || p;
        out.push({
          ...p,
          imageUrl: rebaseImageUrl(p.imageUrl, row.slug),
          buyers: await db.countBuyersOfPlan(row.id, p.planKey),
          checkoutUrl: `${config.publicBaseUrl}/${row.slug}/${encodeURIComponent(linkOwner.linkSlug ?? linkOwner.planKey)}`,
        });
      }
      return sendJson(res, 200, { products: out, storeSlug: row.slug });
    }

    // Field edits. A price or billing change clears the pinned Stripe price —
    // the next checkout lazily provisions a fresh one on their account, and
    // existing Stripe subscriptions keep the price they were sold at.
    case 'product-update': {
      const row = await ownedStore(uid, body.storeId, req);
      if (!row) return sendJson(res, 403, { error: 'not your store' });
      const planKey = String(body.planKey ?? '');
      const existing = await db.getStorePlan(row.id, planKey);
      if (!existing) return sendJson(res, 404, { error: 'unknown product' });
      const fields = {};
      if (!isText(body.name) || !isText(body.description)) return sendJson(res, 400, { error: 'The product name and description must be text.' });
      if (body.name !== undefined) {
        const name = String(body.name ?? '').trim().slice(0, 80);
        if (!name) return sendJson(res, 400, { error: 'Name your product.' });
        fields.name = name;
      }
      if (body.description !== undefined) fields.description = String(body.description ?? '').trim().slice(0, 300);
      if (body.imageData !== undefined) {
        if (body.imageData === null || body.imageData === '') {
          fields.imageData = null;
          // A cleared upload also clears the served URL it produced.
          if ((existing.imageUrl ?? '').includes('/api/img?')) fields.imageUrl = null;
        } else if (isImageDataUrl(body.imageData)) {
          fields.imageData = body.imageData;
          fields.imageUrl = `${config.publicBaseUrl}/api/img?store=${encodeURIComponent(row.slug)}&plan=${encodeURIComponent(planKey)}`;
        } else {
          return sendJson(res, 400, { error: 'That photo could not be read — use a JPG, PNG, WebP or GIF under 1.5MB.' });
        }
      }
      // A pasted link applies unless a fresh upload just claimed the slot.
      // The form echoes the stored URL back on every save — a value equal to
      // the product's current URL is "unchanged", never a replacement link.
      // (Treating the product's own /api/img URL as a pasted link silently
      // deleted the uploaded photo on any ordinary edit.)
      if (body.imageUrl !== undefined && typeof fields.imageData !== 'string' && String(body.imageUrl ?? '').trim() !== (existing.imageUrl ?? '')) {
        const u = String(body.imageUrl ?? '').trim();
        // Over-length links are refused, never cut: a URL truncated at 500
        // characters is still a valid https link — to something else.
        if (u.length > MAX_URL) return sendJson(res, 400, { error: `The photo link tops out at ${MAX_URL} characters.` });
        const linked = /^https:\/\/\S+$/.test(u) ? u : null;
        if (linked || fields.imageUrl === undefined) fields.imageUrl = linked;
        if (linked && existing.hasImageData) fields.imageData = null; // link replaces upload
      }
      if (body.successUrl !== undefined) {
        const u = String(body.successUrl ?? '').trim();
        if (u && !/^https:\/\/\S+$/.test(u)) return sendJson(res, 400, { error: 'The success URL must start with https://' });
        // A success URL carries the buyer's redirect; cut at 500 it would
        // still pass the regex and send them somewhere the seller never chose.
        if (u.length > MAX_URL) return sendJson(res, 400, { error: `The success URL tops out at ${MAX_URL} characters.` });
        fields.successUrl = u || null;
      }
      if (body.purchaseLimit !== undefined) {
        const n = body.purchaseLimit === null || body.purchaseLimit === '' ? null : Math.round(Number(body.purchaseLimit));
        // isSafeInteger, not isFinite: 1e21 is finite, passes a type=number
        // input, and Postgres refuses it for a bigint column with a 500.
        if (n !== null && (!Number.isSafeInteger(n) || n < 1)) return sendJson(res, 400, { error: 'Purchase limit must be a whole number of at least 1.' });
        fields.purchaseLimit = n;
      }
      if (body.active !== undefined) fields.active = Boolean(body.active);
      // The product's own link segment: dues.gg/<store>/<this>. Blank
      // falls back to the plan key; taken segments are refused.
      if (body.linkSlug !== undefined) {
        if (existing.variantOf) {
          return sendJson(res, 400, { error: "Options share their product's link — set the link on the product itself." });
        }
        const raw = String(body.linkSlug ?? '').trim().toLowerCase();
        if (!raw) {
          fields.linkSlug = null;
        } else {
          if (!/^[a-z0-9-]{2,40}$/.test(raw)) {
            return sendJson(res, 400, { error: 'Product links use 2–40 lowercase letters, numbers and dashes.' });
          }
          const siblings = await db.storePlansFor(row.id);
          const clash = siblings.some((p) => p.planKey !== planKey && ((p.linkSlug ?? p.planKey) === raw || p.planKey === raw));
          if (clash) return sendJson(res, 409, { error: 'Another product in this store already uses that link.' });
          fields.linkSlug = raw;
        }
      }
      // Limited-time availability: the product stops being sold after this
      // moment (hidden from the store, refused at checkout) — buyers who
      // already bought keep everything. A date-only value means "through
      // that day" (end-of-day UTC), the same rule discount expiry uses.
      if (body.expiresAt !== undefined) {
        if (existing.variantOf) {
          return sendJson(res, 400, { error: "Options end when their product ends — set the expiry on the product itself." });
        }
        if (body.expiresAt === null || body.expiresAt === '') {
          fields.expiresAt = null;
        } else {
          const raw = String(body.expiresAt);
          const ts = Math.floor(new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59Z` : raw).getTime() / 1000);
          if (!Number.isFinite(ts)) return sendJson(res, 400, { error: 'That expiry date could not be read.' });
          if (ts <= Math.floor(Date.now() / 1000)) return sendJson(res, 400, { error: 'The expiry must be in the future.' });
          fields.expiresAt = ts;
        }
      }
      // Purchase gate: only buyers already holding this role in the server
      // may buy (e.g. an upsell reserved for @PREMIUM members). Any role
      // works as a gate — the bot only READS it, it never has to grant it.
      if (body.requiredRoleId !== undefined) {
        if (existing.variantOf) {
          return sendJson(res, 400, { error: "Options are gated by their product — set who can buy on the product itself." });
        }
        if (body.requiredRoleId === null || body.requiredRoleId === '') {
          fields.requiredRoleId = null;
          fields.requiredRoleName = null;
        } else {
          const roleId = String(body.requiredRoleId);
          const roles = await getGuildRoles(row.guild_id);
          const role = (roles ?? []).find((r) => r.id === roleId);
          if (!role || role.id === row.guild_id) {
            return sendJson(res, 400, { error: 'That role was not found in your server — pick one from the list.' });
          }
          fields.requiredRoleId = role.id;
          fields.requiredRoleName = `@${role.name}`;
        }
      }
      // This product's OWN background — a preset id or an imported URL, and
      // nothing else about a look. Validated by the same code the store's
      // background goes through (validatePlanBg delegates to validateTheme),
      // so there is one catalogue and one URL gate for both. null clears it
      // and the product goes back to wearing the store's.
      if (body.bg !== undefined) {
        if (existing.variantOf) {
          return sendJson(res, 400, { error: 'Options share their product\u2019s page \u2014 set the background on the product itself.' });
        }
        let bg;
        try {
          bg = validatePlanBg(body.bg);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
        fields.bg = bg ? JSON.stringify(bg) : null;
      }
      if (body.priceUsd !== undefined) {
        const currency = normalizeCurrency(existing.currency);
        const priceUsd = roundAmount(Number(body.priceUsd), currency);
        if (!validateAmount(priceUsd, currency).ok) {
          return sendJson(res, 400, {
            error: `Price must be between ${formatAmount(minCharge(currency), currency)} and ${formatAmount(maxCharge(currency), currency)}.`,
          });
        }
        if (priceUsd !== existing.priceUsd) {
          fields.priceUsd = priceUsd;
          fields.stripePriceId = null; // re-provisioned lazily; old subscribers unaffected
        }
      }
      if (body.lifetime !== undefined) {
        const lifetime = Boolean(body.lifetime);
        if (lifetime !== existing.lifetime) {
          fields.lifetime = lifetime ? 1 : 0;
          fields.durationDays = lifetime ? null : termDays(body.durationDays);
          if (!lifetime && fields.durationDays === null) return sendJson(res, 400, { error: 'Term length must be a whole number of days.' });
          fields.stripePriceId = null;
        }
      }
      const plan = await db.updateStorePlan(row.id, planKey, fields);
      // A cleared/changed price must take effect now, not after the cache TTL.
      if (fields.stripePriceId !== undefined) invalidatePriceCache();
      return sendJson(res, 200, { ok: true, plan });
    }

    case 'product-delete': {
      const row = await ownedStore(uid, body.storeId, req);
      if (!row) return sendJson(res, 403, { error: 'not your store' });
      const planKey = String(body.planKey ?? '');
      const plan = await db.getStorePlan(row.id, planKey);
      if (!plan) return sendJson(res, 404, { error: 'unknown product' });
      // Deleting a product takes its price options with it — an option
      // without its product is unreachable and must not linger half-alive.
      const variants = plan.variantOf ? [] : (await db.storePlansFor(row.id)).filter((p) => p.variantOf === planKey);
      // "Buyers keep what they already bought" is what the confirm dialog
      // promises, and it has to be true. rolePlanFor builds the role map from
      // the plan rows that EXIST, so deleting a row that live subscriptions
      // still point at means the next reconcile finds no roles for those
      // members and takes theirs away — and for a recurring product, Stripe
      // keeps billing them for it. Refuse while anyone holds it. Deactivating
      // is the right verb there: it stops the sale and keeps their access.
      const keys = [plan.planKey, ...variants.map((v) => v.planKey)];
      const holders = await db.countLiveSubscriptionsForPlans(row.id, keys);
      // A buyer on Stripe's card form has no row yet; deleting under them
      // takes their money and delivers nothing. Wait out their session.
      const paying = holders > 0 ? 0 : await db.countOpenCheckoutsForPlans(row.id, keys, Math.floor(Date.now() / 1000) - CHECKOUT_TTL_SECONDS);
      if (paying > 0) {
        return sendJson(res, 409, {
          error: `${paying === 1 ? 'Someone is' : `${paying} people are`} paying for this product right now. Deactivate it to stop the sale, and delete it once their checkout has finished (about half an hour).`,
        });
      }
      if (holders > 0) {
        return sendJson(res, 409, {
          error: `${holders} member${holders === 1 ? ' still holds' : 's still hold'} this product. Deactivate it instead — that stops the sale and keeps their access.`,
        });
      }
      for (const target of [plan, ...variants]) {
        // Best-effort archive on their Stripe so the product stops being
        // sellable there too — the local delete is what gates checkout.
        if (target.stripePriceId) {
          try {
            const { openSecret } = await import('../src/lib/secretbox.js');
            const key = openSecret(row.stripe_secret_enc);
            const price = await stripeFetch(`/v1/prices/${target.stripePriceId}`, { key });
            if (price?.product) await stripeFetch(`/v1/products/${price.product}`, { method: 'POST', key, form: { active: 'false' } });
          } catch (err) {
            console.warn(`[onboard] archiving Stripe product for ${row.slug}/${target.planKey} failed: ${err.message}`);
          }
        }
        await db.deleteStorePlan(row.id, target.planKey);
      }
      return sendJson(res, 200, { ok: true, deleted: planKey });
    }

    default:
      return sendJson(res, 400, { error: 'unknown step' });
  }
});

// Text or nothing. String() on an object or a boolean persisted
// "[object Object]" (and the plan key "object-object") behind a 200.
const isText = (v) => v === undefined || v === null || typeof v === 'string';
// Longest link the plan columns hold. Refused past this, never truncated.
const MAX_URL = 500;

// Term length in days for a non-lifetime product: whole, 1..366. Null when
// the value is not a number at all — Math.max/Math.min pass NaN straight
// through, and Postgres refuses NaN for a bigint column with a 500.
function termDays(v) {
  if (v === undefined || v === null || v === '') return 31;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(1, Math.min(366, n)) : null;
}
