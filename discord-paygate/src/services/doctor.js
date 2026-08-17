// Setup doctor: verifies the deployment LIVE — real Stripe and Discord API
// calls, not string presence — because a wrong value here fails silently at
// the worst possible moment (a buyer pays and no role is granted).
// Shared by `npm run doctor` (scripts/doctor.js) and GET /api/setup-check.
// Never returns secret values: only masked prefixes.

import { config, capabilities } from '../config.js';

const MANAGE_ROLES = 1n << 28n;
const ADMINISTRATOR = 1n << 3n;

const mask = (v) => (v ? `${String(v).slice(0, 8)}…(${String(v).length} chars)` : '(empty)');
const isSnowflake = (v) => /^\d{17,20}$/.test(String(v ?? ''));

export async function runDoctor() {
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
  const keyShaped = /^sk_(test|live)_/.test(stripeKey);
  add('env:stripe-key', 'STRIPE_SECRET_KEY starts with sk_test_/sk_live_', keyShaped ? 'pass' : 'fail', mask(stripeKey),
    keyShaped ? null : 'Copy the Secret key from Stripe dashboard → Developers → API keys (it starts with sk_).');
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
  const stripeMode = stripeKey.startsWith('sk_live_') ? 'live' : 'test';
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
        add(id, name, 'fail', `price ${plan.stripePriceId} does not exist in this ${stripeMode}-mode account`,
          `Create it: Stripe dashboard → Product catalog → Add product → $${plan.priceUsd} USD → ${plan.lifetime ? 'One-off' : 'Recurring'} → copy the price_… id into plans.json (stripePriceId). Test and live mode have separate catalogs.`);
        continue;
      }
      if (!res.ok) {
        add(id, name, 'fail', `Stripe answered ${res.status} for price ${plan.stripePriceId}`);
        continue;
      }
      const price = await res.json();
      const expected = Math.round(plan.priceUsd * 100);
      if (price.active !== true) {
        add(id, name, 'fail', `price ${plan.stripePriceId} is archived (active=false)`,
          'Unarchive it or create a new price: Stripe dashboard → Product catalog → the product → Pricing.');
      } else if (plan.lifetime && price.type !== 'one_time') {
        add(id, name, 'fail', `price ${plan.stripePriceId} is RECURRING (${price.recurring?.interval ?? '?'}) but the plan is lifetime — buyers would be billed every ${price.recurring?.interval ?? 'period'} forever`,
          `Create a ONE-OFF price: Stripe dashboard → Product catalog → Add product → $${plan.priceUsd} USD → choose "One-off" (not "Recurring") → put the new price_… id in plans.json.`);
      } else if (!plan.lifetime && price.type !== 'recurring') {
        add(id, name, 'fail', `price ${plan.stripePriceId} is one-time but plan "${plan.id}" is a recurring ${plan.interval} plan`,
          `Create a Recurring (${plan.interval}) price in Stripe → Product catalog and put its id in plans.json.`);
      } else if (price.unit_amount !== expected) {
        add(id, name, 'fail', `price is ${(price.unit_amount / 100).toFixed(2)} ${String(price.currency ?? '').toUpperCase()} but plans.json says $${plan.priceUsd}`,
          `Fix whichever is wrong: the price in Stripe → Product catalog, or priceUsd in plans.json.`);
      } else {
        add(id, name, 'pass', `${plan.stripePriceId}: $${(price.unit_amount / 100).toFixed(2)} ${price.type === 'one_time' ? 'one-time' : `every ${price.recurring?.interval}`}, active`);
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

    for (const plan of config.plans) {
      for (const roleId of plan.roleIds) {
        const role = byId.get(roleId);
        if (!role) {
          add(`discord:role:${roleId}`, `Role ${roleId} (plan "${plan.id}") exists in the guild`, 'fail',
            'no role with that id in this guild',
            'The id in plans.json is wrong or the role was deleted. Server Settings → Roles → right-click the role → Copy Role ID (Developer Mode on), and paste it into plans.json.');
          continue;
        }
        add(`discord:role:${roleId}`, `Role "${role.name}" (plan "${plan.id}") exists in the guild`, 'pass', `position ${role.position}`);

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
    }
  } else if (member && !roles) {
    add('discord:manage-roles', 'Bot holds the Manage Roles permission', 'fail', 'could not list guild roles',
      'The bot may lack basic guild access — re-invite it with the URL from the README.');
  } else {
    add('discord:manage-roles', 'Bot holds the Manage Roles permission', 'skip', 'skipped — bot not confirmed in guild');
    add('discord:hierarchy', 'Bot role hierarchy', 'skip', 'skipped — bot not confirmed in guild');
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
