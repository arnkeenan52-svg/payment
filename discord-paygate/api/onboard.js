import { config } from '../src/config.js';
import { sendJson, sendText, readJsonBody, guard } from '../src/lib/http.js';
import { sessionUserId } from '../src/lib/session.js';
import * as db from '../src/db.js';
import { sealSecret } from '../src/lib/secretbox.js';
import { getUser } from '../src/db.js';
import { getUserGuilds, getGuild, getGuildRoles, getBotUser, getGuildMember } from '../src/lib/discord.js';
import { stripeFetch, createWebhookEndpoint, canonicalWebhookUrl } from '../src/lib/stripe.js';
import { storeByGuild, storeBySlug, slugify, plansOf } from '../src/services/stores.js';

const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

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

async function ownedStore(uid, storeId) {
  const row = await db.getStoreById(Number(storeId));
  if (!row || row.owner_discord_id !== uid) return null;
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
  const uid = sessionUserId(req);
  if (!uid) {
    sendJson(res, 401, { error: 'sign in with Discord first' });
    return;
  }
  const body = await readJsonBody(req).catch(() => ({}));

  switch (body?.step) {
    // ── 1. create the store: guild + Stripe secret key ──────────────────────
    case 'store': {
      const guildId = String(body.guildId ?? '');
      const stripeKey = String(body.stripeKey ?? '').trim();
      const name = String(body.name ?? '').trim().slice(0, 60);
      if (!/^\d{17,20}$/.test(guildId)) return sendJson(res, 400, { error: 'Pick a server first.' });
      if (!name) return sendJson(res, 400, { error: 'Give your store a name.' });
      if (!/^(sk|rk)_(live|test)_/.test(stripeKey)) {
        return sendJson(res, 400, { error: 'That does not look like a Stripe secret key (it starts with sk_live_ or sk_test_).' });
      }
      if (!(await callerManagesGuild(uid, guildId))) {
        return sendJson(res, 403, { error: 'You need Manage Server or Administrator in that Discord server.' });
      }
      if (await storeByGuild(guildId)) {
        return sendJson(res, 409, { error: 'That server already has a store.' });
      }
      if (!(await getGuild(guildId))) {
        return sendJson(res, 409, { error: 'bot_missing', detail: 'The Ripley bot is not in that server yet — invite it, then retry.' });
      }
      // The key must actually work before anything is stored.
      let account;
      try {
        account = await stripeFetch('/v1/account', { key: stripeKey });
      } catch {
        return sendJson(res, 400, { error: 'Stripe rejected that key. Copy the Secret key from Stripe → Developers → API keys.' });
      }

      let slug = slugify(name);
      if (slug === 'store' || (await db.getStoreBySlug(slug))) {
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
        store: { id: row.id, slug, name, guildId, mode: stripeKey.startsWith('sk_live_') ? 'live' : 'test', stripeAccount: account.id ?? null },
      });
    }

    // ── 2. create the product on their Stripe account ───────────────────────
    case 'product': {
      const row = await ownedStore(uid, body.storeId);
      if (!row) return sendJson(res, 403, { error: 'not your store' });
      const name = String(body.name ?? '').trim().slice(0, 80);
      const description = String(body.description ?? '').trim().slice(0, 300);
      const imageUrl = /^https:\/\/\S+$/.test(String(body.imageUrl ?? '').trim()) ? String(body.imageUrl).trim().slice(0, 500) : null;
      const priceUsd = Math.round(Number(body.priceUsd) * 100) / 100;
      const lifetime = body.lifetime !== false;
      const durationDays = lifetime ? null : Math.max(1, Math.min(366, Math.round(Number(body.durationDays ?? 31))));
      if (!name) return sendJson(res, 400, { error: 'Name your product.' });
      if (!Number.isFinite(priceUsd) || priceUsd < 1 || priceUsd > 10000) {
        return sendJson(res, 400, { error: 'Price must be between $1 and $10,000.' });
      }
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
            ...(imageUrl ? { images: [imageUrl] } : {}),
            default_price_data: {
              currency: 'usd',
              unit_amount: Math.round(priceUsd * 100),
              ...(lifetime ? {} : { recurring: { interval: 'month' } }),
            },
          },
        });
      } catch (err) {
        console.error(`[onboard] product creation for store ${row.id} failed: ${err.message}`);
        return sendJson(res, 502, { error: 'Stripe would not create the product — check the key and try again.' });
      }
      const plan = await db.createStorePlan({
        storeId: row.id,
        planKey: slugify(name) || 'premium',
        name,
        description,
        imageUrl,
        priceUsd,
        lifetime,
        durationDays,
        stripePriceId: typeof product.default_price === 'string' ? product.default_price : product.default_price?.id ?? null,
      });
      return sendJson(res, 200, { ok: true, plan });
    }

    // ── 3. the role buyers receive ──────────────────────────────────────────
    case 'roles': {
      const row = await ownedStore(uid, body.storeId);
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
                    ? `at or above the bot's top role — drag Ripley's role higher in Server Settings → Roles`
                    : null,
          })),
      });
    }

    // ── 4. pick the role, go live ───────────────────────────────────────────
    case 'role': {
      const row = await ownedStore(uid, body.storeId);
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
          error: `"${role.name}" sits at or above the bot's top role — drag Ripley's role above it in Server Settings → Roles, then retry.`,
        });
      }
      await db.setStorePlanRoles(row.id, planKey, [role.id], [`@${role.name}`]);
      await db.updateStore(row.id, { status: 'live' });
      const store = await storeBySlug(row.slug);
      return sendJson(res, 200, { ok: true, store: { slug: store.slug, status: store.status }, plans: await plansOf(store) });
    }

    default:
      return sendJson(res, 400, { error: 'unknown step' });
  }
});
