// Setup doctor: verifies the deployment LIVE — real Stripe and Discord API
// calls, not string presence — because a wrong value here fails silently at
// the worst possible moment (a buyer pays and no role is granted).
// Shared by `npm run doctor` (scripts/doctor.js) and GET /api/setup-check.
// Never returns secret values: only masked prefixes.

import { config, capabilities } from '../config.js';
import { effectiveRoleMap, invalidateGuildRolesCache } from './plan-config.js';
import {
  resolvePlanPrice,
  invalidatePriceCache,
  listWebhookEndpoints,
  createWebhookEndpoint,
  webhookUrlCandidates,
  canonicalWebhookUrl,
  isStripeKey,
  stripeKeyMode,
} from '../lib/stripe.js';
import { getAppSecret, setAppSecret, acquireLock, releaseLock } from '../db.js';
import { resendApiKey, receiptFrom } from '../lib/email.js';

const MANAGE_ROLES = 1n << 28n;
const ADMINISTRATOR = 1n << 3n;

const mask = (v) => (v ? `${String(v).slice(0, 8)}…(${String(v).length} chars)` : '(empty)');
const isSnowflake = (v) => /^\d{17,20}$/.test(String(v ?? ''));

export async function runDoctor() {
  // Grade against FRESH state — "Re-run checks" right after the owner fixes
  // a role or price must not read caches up to a minute old.
  invalidateGuildRolesCache();
  invalidatePriceCache();
  const checks = [];
  const add = (id, name, status, detail, fix = null) =>
    checks.push({ id, name, status, detail, ...(fix ? { fix } : {}) });

  // ── structural env checks ───────────────────────────────────────────────────
  const rawBase = process.env.PUBLIC_BASE_URL ?? '';
  let baseUrl = null;
  try {
    baseUrl = new URL(rawBase);
  } catch {
    /* handled below */
  }
  if (!baseUrl) {
    add('env:public-base-url', 'PUBLIC_BASE_URL is a valid URL', 'fail', `got ${JSON.stringify(rawBase)}`,
      'Set PUBLIC_BASE_URL to your deployed origin, e.g. https://tradeleaks.vercel.app — Vercel dashboard → Project → Settings → Environment Variables.');
  } else if (rawBase.endsWith('/')) {
    add('env:public-base-url', 'PUBLIC_BASE_URL has no trailing slash', 'fail', `got ${rawBase}`,
      'Remove the trailing slash — the OAuth redirect is built as PUBLIC_BASE_URL + "/auth/callback" and Discord matches it byte-for-byte.');
  } else if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost' && baseUrl.hostname !== '127.0.0.1') {
    add('env:public-base-url', 'PUBLIC_BASE_URL uses https', 'fail', `got ${rawBase}`,
      'Use the https:// origin buyers actually reach. Vercel dashboard → Project → Settings → Environment Variables.');
  } else {
    add('env:public-base-url', 'PUBLIC_BASE_URL well-formed', baseUrl.protocol === 'https:' ? 'pass' : 'warn', rawBase);
  }

  for (const [key, value, label] of [
    ['SESSION_SECRET', config.sessionSecret, 'env:session-secret'],
    ['CRON_SECRET', config.cronSecret, 'env:cron-secret'],
  ]) {
    if (!value || value.length < 16 || value.startsWith('change-me')) {
      add(label, `${key} is a real secret`, 'fail', `${mask(value)} — too short or still the placeholder`,
        `Generate one with: openssl rand -hex 32, then set ${key} in Vercel → Project → Settings → Environment Variables.`);
    } else {
      add(label, `${key} is a real secret`, 'pass', mask(value));
    }
  }

  if (!config.ownerDiscordId) {
    add('env:owner-id', 'OWNER_DISCORD_ID set (platform owner)', 'warn', '(empty)',
      'Set OWNER_DISCORD_ID to your own Discord user id (Developer Mode → right-click yourself → Copy User ID) so owner-only views work for you.');
  } else if (!isSnowflake(config.ownerDiscordId)) {
    add('env:owner-id', 'OWNER_DISCORD_ID looks like a Discord snowflake', 'fail', `got ${mask(config.ownerDiscordId)}`,
      'Copy YOUR user id: Discord → Developer Mode on → right-click your name → Copy User ID.');
  } else {
    add('env:owner-id', 'OWNER_DISCORD_ID set (platform owner)', 'pass', config.ownerDiscordId);
  }

  for (const [key, value] of [
    ['DISCORD_CLIENT_ID', config.discord.clientId],
    ['DISCORD_GUILD_ID', config.discord.guildId],
  ]) {
    if (!isSnowflake(value)) {
      add(`env:${key.toLowerCase()}`, `${key} looks like a Discord snowflake`, 'fail', `got ${mask(value)}`,
        key === 'DISCORD_GUILD_ID'
          ? 'Enable Developer Mode in Discord, right-click your server → Copy Server ID.'
          : 'Copy the Application ID from discord.com/developers/applications → your app → General Information.');
    } else {
      add(`env:${key.toLowerCase()}`, `${key} looks like a Discord snowflake`, 'pass', value);
    }
  }
  add('env:discord-client-secret', 'DISCORD_CLIENT_SECRET present', config.discord.clientSecret ? 'pass' : 'fail',
    mask(config.discord.clientSecret),
    config.discord.clientSecret ? null : 'Copy it from discord.com/developers/applications → your app → OAuth2 → Client Secret.');

  const stripeKey = config.stripe.secretKey;
  const keyShaped = isStripeKey(stripeKey);
  add('env:stripe-key', 'STRIPE_SECRET_KEY is a Stripe API key (rk_ or sk_)', keyShaped ? 'pass' : 'fail', mask(stripeKey),
    keyShaped ? null : 'Copy a key from Stripe dashboard → Developers → API keys. Stripe recommends a restricted key (rk_) over a secret key (sk_).');
  add('env:stripe-webhook-secret', 'STRIPE_WEBHOOK_SECRET starts with whsec_',
    stripeKey && config.stripe.webhookSecret.startsWith('whsec_') ? 'pass' : 'fail', mask(config.stripe.webhookSecret),
    config.stripe.webhookSecret.startsWith('whsec_') ? null
      : 'Copy the Signing secret of your /webhooks/stripe endpoint: Stripe dashboard → Developers → Webhooks → your endpoint → Signing secret.');

  for (const plan of config.plans) {
    for (const roleId of plan.roleIds) {
      if (!isSnowflake(roleId)) {
        add('env:role-ids', `plans.json roleIds are snowflakes (${plan.id})`, 'fail', `got ${roleId}`,
          'Enable Developer Mode, Server Settings → Roles → right-click the role → Copy Role ID, and paste it into plans.json.');
      }
    }
  }

  // ── Stripe, live ────────────────────────────────────────────────────────────
  const stripeMode = stripeKeyMode(stripeKey);
  let stripeAuthed = false;
  if (keyShaped) {
    try {
      const res = await fetch(`${config.stripe.apiBase}/v1/account`, {
        headers: { authorization: `Bearer ${stripeKey}` },
      });
      if (res.ok) {
        const acct = await res.json();
        stripeAuthed = true;
        add('stripe:auth', 'Stripe key authenticates', 'pass', `${stripeMode} mode, account ${acct.id ?? '(unknown)'}, key ${mask(stripeKey)}`);
      } else {
        add('stripe:auth', 'Stripe key authenticates', 'fail', `Stripe answered ${res.status} for ${mask(stripeKey)}`,
          'The key is wrong or revoked. Copy a fresh Secret key: Stripe dashboard → Developers → API keys.');
      }
    } catch (err) {
      add('stripe:auth', 'Stripe key authenticates', 'fail', `could not reach Stripe: ${err.message}`,
        'Check STRIPE_API_BASE (leave it unset for the real Stripe) and outbound network access.');
    }
  } else {
    add('stripe:auth', 'Stripe key authenticates', 'skip', 'skipped — key is not sk_-shaped');
  }

  for (const plan of config.plans) {
    const id = `stripe:price:${plan.id}`;
    const name = `Stripe price for "${plan.id}" exists, active, ${plan.lifetime ? 'one-time' : 'recurring'}, amount matches`;
    if (!stripeAuthed) {
      add(id, name, 'skip', 'skipped — Stripe auth failed');
      continue;
    }
    try {
      const res = await fetch(`${config.stripe.apiBase}/v1/prices/${plan.stripePriceId}`, {
        headers: { authorization: `Bearer ${stripeKey}` },
      });
      if (res.status === 404) {
        // The configured id is dead on this account — the store falls back to
        // the newest active price matching the plan's own terms ($, USD,
        // one-time/interval). Surface which price checkout will really use.
        const resolved = await resolvePlanPrice(plan);
        if (resolved?.source === 'amount') {
          add(id, name, 'warn',
            `stripePriceId ${plan.stripePriceId} does not exist in this ${stripeMode}-mode account — checkout resolves by amount to ${resolved.price.id} ($${(resolved.price.unit_amount / 100).toFixed(2)} USD ${plan.lifetime ? 'one-time' : `every ${resolved.price.recurring?.interval}`}${resolved.price.nickname ? `, "${resolved.price.nickname}"` : ''})`,
            `Pin it: put ${resolved.price.id} into plans.json (stripePriceId) so the choice is explicit.`);
        } else {
          add(id, name, 'fail', `price ${plan.stripePriceId} does not exist in this ${stripeMode}-mode account, and no active $${plan.priceUsd} USD ${plan.lifetime ? 'one-off' : plan.interval} price was found to fall back to`,
            `Create it: Stripe dashboard → Product catalog → Add product → $${plan.priceUsd} USD → ${plan.lifetime ? 'One-off' : 'Recurring'} → copy the price_… id into plans.json (stripePriceId). Test and live mode have separate catalogs.`);
        }
        continue;
      }
      if (!res.ok) {
        add(id, name, 'fail', `Stripe answered ${res.status} for price ${plan.stripePriceId}`);
        continue;
      }
      const price = await res.json();
      const expected = Math.round(plan.priceUsd * 100);
      // plans.json prices are USD by definition (priceUsd). The Stripe
      // account's default currency is irrelevant — the price object's own
      // currency is what buyers get charged in, so any mismatch here means
      // the wrong money would be taken. Fail loudly, never silently pass.
      const currency = String(price.currency ?? '').toLowerCase();
      if (currency !== 'usd') {
        add(id, name, 'fail',
          `CURRENCY MISMATCH: plans.json prices are USD but price ${plan.stripePriceId} is ${currency.toUpperCase() || 'unknown'} — buyers would be charged in the wrong currency`,
          `Create the price in USD (Stripe dashboard → Product catalog → the product → Add another price → currency USD, $${plan.priceUsd}, ${plan.lifetime ? 'One-off' : 'Recurring'}) and put its id in plans.json. Do not rely on the account's default currency.`);
      } else if (price.active !== true) {
        add(id, name, 'fail', `price ${plan.stripePriceId} is archived (active=false)`,
          'Unarchive it or create a new price: Stripe dashboard → Product catalog → the product → Pricing.');
      } else if (plan.lifetime && price.type !== 'one_time') {
        add(id, name, 'fail', `price ${plan.stripePriceId} is RECURRING (${price.recurring?.interval ?? '?'}) but the plan is lifetime — buyers would be billed every ${price.recurring?.interval ?? 'period'} forever`,
          `Create a ONE-OFF price: Stripe dashboard → Product catalog → Add product → $${plan.priceUsd} USD → choose "One-off" (not "Recurring") → put the new price_… id in plans.json.`);
      } else if (!plan.lifetime && price.type !== 'recurring') {
        add(id, name, 'fail', `price ${plan.stripePriceId} is one-time but plan "${plan.id}" is a recurring ${plan.interval} plan`,
          `Create a Recurring (${plan.interval}) price in Stripe → Product catalog and put its id in plans.json.`);
      } else if (price.unit_amount !== expected) {
        add(id, name, 'fail', `price is ${(price.unit_amount / 100).toFixed(2)} USD but plans.json says $${plan.priceUsd}`,
          `Fix whichever is wrong: the price in Stripe → Product catalog, or priceUsd in plans.json.`);
      } else {
        add(id, name, 'pass', `${plan.stripePriceId}: $${(price.unit_amount / 100).toFixed(2)} USD ${price.type === 'one_time' ? 'one-time' : `every ${price.recurring?.interval}`}, active`);
      }
    } catch (err) {
      add(id, name, 'fail', `could not reach Stripe: ${err.message}`);
    }
  }

  if (stripeAuthed && stripeMode === 'live' && baseUrl &&
      (baseUrl.hostname.endsWith('.vercel.app') || baseUrl.hostname === 'localhost' || baseUrl.protocol !== 'https:')) {
    add('stripe:live-vs-domain', 'Live Stripe key vs. deployment domain', 'warn',
      `Stripe is in LIVE mode but PUBLIC_BASE_URL is ${rawBase} — that looks like a preview/dev domain`,
      'Point PUBLIC_BASE_URL (and the Discord redirect + Stripe webhook endpoint) at your production domain before taking real money.');
  } else if (stripeAuthed) {
    add('stripe:live-vs-domain', 'Live Stripe key vs. deployment domain', 'pass',
      stripeMode === 'live' ? 'live mode on a production domain' : 'test mode — safe anywhere');
  }

  // Without a webhook endpoint on THIS account pointing at THIS deployment,
  // buyers pay and no role is ever granted. Verify it exists — and when it
  // does not, register it ourselves and keep its signing secret in the
  // database, so deliveries verify with zero manual configuration.
  if (stripeAuthed) {
    const wid = 'stripe:webhook-endpoint';
    const wname = 'Stripe webhook endpoint delivers to this deployment';
    try {
      const endpoints = await listWebhookEndpoints();
      const candidates = new Set(webhookUrlCandidates());
      const found = endpoints.find((e) => e.status === 'enabled' && candidates.has(e.url));
      if (found) {
        const stored = await getAppSecret('stripe_webhook_secret');
        add(wid, wname, 'pass',
          `endpoint ${found.id} → ${found.url}${found.metadata?.managed_by === 'ripley-paygate' && stored ? ' (registered automatically; deliveries verify with its stored signing secret)' : ' — make sure STRIPE_WEBHOOK_SECRET is THIS endpoint\'s signing secret'}`);
      } else if (await acquireLock('lock:stripe-endpoint-register', 600)) {
        try {
          const url = await canonicalWebhookUrl();
          const created = await createWebhookEndpoint(url);
          await setAppSecret('stripe_webhook_secret', created.secret);
          add(wid, wname, 'pass',
            `no endpoint pointed here, so one was registered automatically: ${created.id} → ${url}. Its signing secret is stored; deliveries verify with it (STRIPE_WEBHOOK_SECRET keeps working too).`);
        } finally {
          await releaseLock('lock:stripe-endpoint-register');
        }
      } else {
        add(wid, wname, 'warn', 'another instance is registering the endpoint right now — re-run checks in a moment');
      }
    } catch (err) {
      add(wid, wname, 'fail', `could not verify or register the webhook endpoint: ${err.message}`,
        `Create it manually: Stripe dashboard → Developers → Webhooks → Add endpoint → ${config.publicBaseUrl}/webhooks/stripe (checkout.session.completed and invoice/subscription events) → put its signing secret in STRIPE_WEBHOOK_SECRET.`);
    }
  }

  // ── Discord, live ───────────────────────────────────────────────────────────
  const dHeaders = { authorization: `Bot ${config.discord.botToken}` };
  const dFetch = (p) => fetch(`${config.discord.apiBase}${p}`, { headers: dHeaders });
  let bot = null;
  if (!config.discord.botToken) {
    add('discord:bot-auth', 'Bot token authenticates', 'fail', '(empty)',
      'Copy the token: discord.com/developers/applications → your app → Bot → Reset Token.');
  } else {
    try {
      const res = await dFetch('/users/@me');
      if (res.ok) {
        bot = await res.json();
        add('discord:bot-auth', 'Bot token authenticates', 'pass', `logged in as ${bot.username} (${bot.id})`);
      } else {
        add('discord:bot-auth', 'Bot token authenticates', 'fail', `Discord answered ${res.status} for token ${mask(config.discord.botToken)}`,
          'The token is wrong or was reset. Copy a fresh one: discord.com/developers/applications → your app → Bot.');
      }
    } catch (err) {
      add('discord:bot-auth', 'Bot token authenticates', 'fail', `could not reach Discord: ${err.message}`,
        'Check DISCORD_API_BASE (leave it unset for the real Discord) and outbound network access.');
    }
  }

  let member = null;
  let roles = null;
  if (bot && isSnowflake(config.discord.guildId)) {
    try {
      const mRes = await dFetch(`/guilds/${config.discord.guildId}/members/${bot.id}`);
      if (mRes.status === 404) {
        add('discord:bot-in-guild', 'Bot is a member of the guild', 'fail', `bot ${bot.username} is not in guild ${config.discord.guildId}`,
          `Invite it: https://discord.com/oauth2/authorize?client_id=${config.discord.clientId || '<APP_ID>'}&scope=bot&permissions=268435457 — open that URL, pick the server, authorize.`);
      } else if (!mRes.ok) {
        add('discord:bot-in-guild', 'Bot is a member of the guild', 'fail', `Discord answered ${mRes.status}`);
      } else {
        member = await mRes.json();
        add('discord:bot-in-guild', 'Bot is a member of the guild', 'pass', `in guild ${config.discord.guildId}`);
      }
      const rRes = await dFetch(`/guilds/${config.discord.guildId}/roles`);
      if (rRes.ok) roles = await rRes.json();
    } catch (err) {
      add('discord:bot-in-guild', 'Bot is a member of the guild', 'fail', `could not reach Discord: ${err.message}`);
    }
  } else {
    add('discord:bot-in-guild', 'Bot is a member of the guild', 'skip', 'skipped — bot auth or guild id failed');
  }

  if (member && roles) {
    const byId = new Map(roles.map((r) => [r.id, r]));
    const botRoleIds = new Set([config.discord.guildId, ...(member.roles ?? [])]); // @everyone + assigned
    let perms = 0n;
    let botTop = 0;
    let botTopRole = '@everyone';
    for (const rid of botRoleIds) {
      const role = byId.get(rid);
      if (!role) continue;
      perms |= BigInt(role.permissions ?? 0);
      if (role.position > botTop) {
        botTop = role.position;
        botTopRole = role.name;
      }
    }

    const canManage = (perms & ADMINISTRATOR) !== 0n || (perms & MANAGE_ROLES) !== 0n;
    add('discord:manage-roles', 'Bot holds the Manage Roles permission', canManage ? 'pass' : 'fail',
      canManage ? `via role "${botTopRole}"` : 'none of the bot\'s roles grant Manage Roles',
      canManage ? null : 'Server Settings → Roles → the bot\'s role → Permissions → enable "Manage Roles" (or re-invite with the invite URL from the README).');

    const roleMap = await effectiveRoleMap();
    for (const plan of config.plans) {
      const mapping = roleMap.get(plan.id) ?? { roleIds: plan.roleIds, source: 'default' };
      const src =
        mapping.source === 'override' ? ' [picked in the dashboard]'
        : mapping.source === 'name' ? ' [matched by role name]'
        : '';
      for (const roleId of mapping.roleIds) {
        const role = byId.get(roleId);
        if (!role) {
          add(`discord:role:${roleId}`, `Role ${roleId} (plan "${plan.id}")${src} exists in the guild`, 'fail',
            'no role with that id in this guild',
            'Pick the real role in the dashboard (Products → role picker), or paste its id into plans.json (Developer Mode → Server Settings → Roles → right-click → Copy Role ID).');
          continue;
        }
        add(`discord:role:${roleId}`, `Role "${role.name}" (plan "${plan.id}")${src} exists in the guild`, 'pass', `position ${role.position}`);

        // THE check. Below or equal means every grant 403s after the buyer paid.
        if (botTop <= role.position) {
          add(`discord:hierarchy:${roleId}`, `Bot's highest role sits ABOVE "${role.name}"`, 'fail',
            `bot's top role "${botTopRole}" is at position ${botTop}, "${role.name}" is at ${role.position} — Discord will refuse every grant with 403 AFTER the buyer has paid`,
            `Server Settings → Roles → drag the bot's role "${botTopRole}" ABOVE "${role.name}" in the list, then re-run the doctor.`);
        } else {
          add(`discord:hierarchy:${roleId}`, `Bot's highest role sits above "${role.name}"`, 'pass',
            `"${botTopRole}" (${botTop}) > "${role.name}" (${role.position})`);
        }
      }

      // Configured ids that resolution dropped must never vanish silently: a
      // typo'd id next to a valid one is exactly the misconfiguration this
      // doctor exists to catch. An owner's dashboard pick is the one
      // legitimate supersession — the override IS the pin, so the shipped
      // placeholder ids stop mattering entirely.
      const mappedIds = new Set(mapping.roleIds);
      for (const cfgId of plan.roleIds ?? []) {
        if (mapping.source === 'override') continue;
        if (mappedIds.has(cfgId) || byId.has(cfgId)) continue;
        if (mapping.source === 'name') {
          add(`discord:role:${cfgId}`, `Configured role id ${cfgId} (plan "${plan.id}") is stale`, 'warn',
            'no role with that id in this guild — the plan currently works because the role was matched by NAME instead',
            'Pin it: pick the role in the dashboard (role picker), or paste the real id into plans.json.');
        } else {
          add(`discord:role:${cfgId}`, `Role ${cfgId} (plan "${plan.id}") exists in the guild`, 'fail',
            'no role with that id in this guild — buyers would be granted only the other configured roles',
            'Pick the real role in the dashboard (Products → role picker), or paste its id into plans.json (Developer Mode → Server Settings → Roles → right-click → Copy Role ID).');
        }
      }
    }
  } else if (member && !roles) {
    add('discord:manage-roles', 'Bot holds the Manage Roles permission', 'fail', 'could not list guild roles',
      'The bot may lack basic guild access — re-invite it with the URL from the README.');
  } else {
    add('discord:manage-roles', 'Bot holds the Manage Roles permission', 'skip', 'skipped — bot not confirmed in guild');
    add('discord:hierarchy', 'Bot role hierarchy', 'skip', 'skipped — bot not confirmed in guild');
  }

  // Receipt emails (Resend) — warn-level only: broken receipts must never
  // mark the store itself unsafe, but the owner needs to SEE why buyers get
  // no confirmation mail. The classic trap: the resend.dev test sender
  // "works" while delivering only to the account owner's own inbox.
  try {
    const resendKey = await resendApiKey();
    if (!resendKey) {
      add('email:resend-key', 'Resend API key present (receipt emails)', 'warn', '(empty)',
        'Set RESEND_API_KEY in Vercel → Project → Settings → Environment Variables to turn on membership-confirmation emails.');
    } else {
      add('email:resend-key', 'Resend API key present (receipt emails)', 'pass', mask(resendKey));
      const from = await receiptFrom();
      if (from.includes('resend.dev')) {
        add('email:resend-sender', 'Receipts send from a verified domain', 'warn', from,
          "Resend's onboarding@resend.dev test sender delivers ONLY to your own Resend account inbox — real buyers get nothing. Verify your domain in Resend → Domains (the sender switches automatically), or set RECEIPT_FROM.");
      } else {
        add('email:resend-sender', 'Receipts send from a verified domain', 'pass', from);
      }
    }
  } catch (err) {
    add('email:resend-key', 'Resend reachable (receipt emails)', 'warn', err.message);
  }

  // Coinbase: only flagged when partially configured (one secret without the other).
  const cb = config.coinbase;
  if ((cb.apiKey && !cb.webhookSecret) || (!cb.apiKey && cb.webhookSecret)) {
    add('coinbase:partial', 'Coinbase configured fully or not at all', 'fail',
      `one of COINBASE_API_KEY / COINBASE_WEBHOOK_SECRET is set without the other (${mask(cb.apiKey)} / ${mask(cb.webhookSecret)})`,
      'Set both to enable crypto, or clear both for Stripe-only (the CTA hides automatically).');
  } else {
    add('coinbase:partial', 'Coinbase capability', 'pass', capabilities().crypto ? 'crypto enabled' : 'Stripe-only (coinbase dormant)');
  }

  return {
    ok: !checks.some((c) => c.status === 'fail'),
    generatedAt: new Date().toISOString(),
    checks,
  };
}
