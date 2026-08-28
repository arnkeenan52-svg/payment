import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader: KEY=VALUE lines, # comments, real env always wins.
// On Vercel this is a no-op (no .env file is deployed; env comes from the
// dashboard) — it exists for local dev and the e2e suite.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[2].startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

loadDotEnv(process.env.ENV_PATH || path.join(ROOT, '.env'));

function loadPlans() {
  const file = process.env.PLANS_PATH || path.join(ROOT, 'plans.json');
  const plans = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const plan of plans) {
    if (!plan.id || !Array.isArray(plan.roleIds) || plan.roleIds.length === 0) {
      throw new Error(`plans.json: plan ${JSON.stringify(plan.id)} needs an id and at least one roleId`);
    }
    if (!plan.lifetime && !(plan.durationDays > 0)) {
      throw new Error(`plans.json: non-lifetime plan "${plan.id}" needs durationDays (fallback term when the provider gives no period end)`);
    }
  }
  return plans;
}

const env = (key, fallback = '') => process.env[key] ?? fallback;
const num = (key, fallback) => Number(process.env[key] ?? fallback);

const publicBaseUrl = env('PUBLIC_BASE_URL', `http://localhost:${num('PORT', 4000)}`).replace(/\/$/, '');
const isProd = publicBaseUrl.startsWith('https://');

// SESSION_SECRET signs session cookies AND derives the at-rest key for every
// tenant's Stripe secret (secretbox). A missing/weak/default value makes every
// session forgeable and every stored key decryptable, so a production
// deployment must fail closed rather than silently run on 'change-me'.
function resolveSessionSecret() {
  const s = env('SESSION_SECRET', '');
  if (isProd && (s.length < 32 || s.startsWith('change-me'))) {
    throw new Error(
      'SESSION_SECRET must be set to a strong value (>= 32 chars, not the default) in production — ' +
        'it signs sessions and derives the at-rest key for tenant Stripe keys.',
    );
  }
  return s || 'change-me';
}
// Cookies are scoped to the registrable domain (www stripped) so a deployment
// reachable on both apex and www keeps its login cookies across the OAuth
// host hop. localhost/IPs get host-only cookies.
const cookieDomain = (() => {
  try {
    const host = new URL(publicBaseUrl).hostname;
    if (host === 'localhost' || /^[\d.]+$/.test(host) || !host.includes('.')) return null;
    return host.replace(/^www\./, '');
  } catch {
    return null;
  }
})();

export const config = {
  root: ROOT,
  // Dues is the host checkout platform; the product being sold is the
  // Discord server itself (DISCORD_GUILD_NAME, e.g. Tradeleaks).
  platform: env('PLATFORM_NAME', 'Dues'),
  brand: env('BRAND') || 'Tradeleaks',
  // The Dues community server. Permanent invite, no expiry, no use cap.
  // Env-overridable so a re-issued invite is a dashboard change, not a deploy.
  communityInvite: env('COMMUNITY_INVITE') || 'https://discord.gg/G6yjsX5qbB',
  // Discord user id of the store owner: unlocks owner-only platform views.
  ownerDiscordId: env('OWNER_DISCORD_ID'),
  port: num('PORT', 4000),
  publicBaseUrl,
  cookieDomain,
  secureCookies: isProd,
  sessionSecret: resolveSessionSecret(),
  cronSecret: env('CRON_SECRET'),
  // Postgres when a connection string is set (Vercel/production); SQLite file
  // otherwise (local dev, e2e). DATABASE_URL wins, but Vercel's marketplace
  // Postgres integrations inject POSTGRES_URL — fall back to it so connecting
  // a database in the Vercel dashboard works with no manual renaming step.
  databaseUrl: env('DATABASE_URL') || env('POSTGRES_URL'),
  dbPath: env('DB_PATH', path.join(ROOT, 'data', 'paygate.sqlite')),
  discord: {
    clientId: env('DISCORD_CLIENT_ID'),
    clientSecret: env('DISCORD_CLIENT_SECRET'),
    botToken: env('DISCORD_BOT_TOKEN'),
    guildId: env('DISCORD_GUILD_ID'),
    // Optional display override; when empty the live guild name from Discord
    // is used, and an unknown name is NEVER rendered as placeholder content.
    guildName: env('DISCORD_GUILD_NAME'),
    apiBase: env('DISCORD_API_BASE', 'https://discord.com/api/v10').replace(/\/$/, ''),
  },
  stripe: {
    secretKey: env('STRIPE_SECRET_KEY'),
    webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
    apiBase: env('STRIPE_API_BASE', 'https://api.stripe.com').replace(/\/$/, ''),
  },
  coinbase: {
    apiKey: env('COINBASE_API_KEY'),
    webhookSecret: env('COINBASE_WEBHOOK_SECRET'),
    apiBase: env('COINBASE_API_BASE', 'https://api.commerce.coinbase.com').replace(/\/$/, ''),
  },
  // NOWPayments. Both secrets come from the environment with NO literal
  // fallback: a default here would be a credential in the repository, and an
  // empty string simply leaves the rail dormant, which is the safe failure.
  //
  // The account this is built against has Custody ENABLED, which means a
  // payment with no payout_address settles into the NOWPayments balance and
  // stays there. That is the one configuration Dues must never produce, so
  // createInvoice refuses to build a request without a payout address rather
  // than quietly leaving funds somewhere the seller cannot reach.
  nowpayments: {
    apiKey: env('NOWPAYMENTS_API_KEY'),
    ipnSecret: env('NOWPAYMENTS_IPN_SECRET'),
    apiBase: env('NOWPAYMENTS_API_BASE', 'https://api.nowpayments.io/v1').replace(/\/$/, ''),
  },
  webhookToleranceSeconds: num('WEBHOOK_TOLERANCE_SECONDS', 300),
  gracePeriodHours: num('GRACE_PERIOD_HOURS', 72),
  plans: loadPlans(),
};

// Payment capabilities: a provider is live only when its credentials are set.
// The storefront hides the crypto CTA and the coinbase endpoints answer 501
// when crypto is off — the code stays dormant rather than deleted.
export function capabilities() {
  return {
    stripe: Boolean(config.stripe.secretKey && config.stripe.webhookSecret),
    crypto: Boolean(config.coinbase.apiKey && config.coinbase.webhookSecret),
    // The two rails are independent: a deploy may run NOWPayments without
    // Coinbase, and the storefront asks for this one by name.
    nowpayments: Boolean(config.nowpayments.apiKey && config.nowpayments.ipnSecret),
  };
}

export function planById(id) {
  return config.plans.find((p) => p.id === id) ?? null;
}

// Every role id that appears in plans.json — the only roles reconcile may remove.
export function managedRoleIds() {
  return new Set(config.plans.flatMap((p) => p.roleIds));
}

const set = (v) => (v ? '✓ set' : '✗ MISSING');

export function printBanner(actualPort) {
  const c = config;
  const caps = capabilities();
  const planLine = (p) =>
    `│   • ${p.id.padEnd(10)} ${p.name.padEnd(10)} $${String(p.priceUsd).padEnd(6)} ${p.interval.padEnd(8)} → roles [${p.roleIds.join(', ')}]`;
  const lines = [
    '',
    `┌─ ${c.brand.toUpperCase()} PAYGATE ${'─'.repeat(46)}`,
    `│ listening      http://localhost:${actualPort}   (public: ${c.publicBaseUrl})`,
    `│ storage        ${c.databaseUrl ? `postgres (${c.databaseUrl.replace(/\/\/[^@]*@/, '//***@')})` : `sqlite ${c.dbPath}`}`,
    `│ discord        guild ${c.discord.guildId || '✗ MISSING'} | client ${set(c.discord.clientId)} | secret ${set(c.discord.clientSecret)} | bot ${set(c.discord.botToken)}`,
    `│ discord api    ${c.discord.apiBase}`,
    `│ stripe         ${caps.stripe ? 'ENABLED' : 'disabled'} | key ${set(c.stripe.secretKey)} | webhook secret ${set(c.stripe.webhookSecret)} | api ${c.stripe.apiBase}`,
    `│ crypto         ${caps.crypto ? 'ENABLED (coinbase)' : 'disabled (coinbase code dormant, CTA hidden)'}`,
    // Two independent rails. NOWPayments needs BOTH values: the key alone
    // cannot verify a delivery, and an unverified delivery is an anonymous
    // request claiming somebody paid.
    `│ nowpayments    ${caps.nowpayments ? 'ENABLED (payouts forward to each seller wallet)' : `disabled (key ${set(Boolean(c.nowpayments.apiKey))}, IPN secret ${set(Boolean(c.nowpayments.ipnSecret))})`}`,
    `│ webhooks       POST /webhooks/stripe${caps.crypto ? '   POST /webhooks/coinbase' : ''}${caps.nowpayments ? '   POST /webhooks/nowpayments' : ''}   (replay tolerance ${c.webhookToleranceSeconds}s)`,
    `│ cron           GET /api/cron/reconcile | CRON_SECRET ${set(c.cronSecret)} | grace ${c.gracePeriodHours}h on failed renewals`,
    `│ plans (plans.json)`,
    ...c.plans.map(planLine),
    `└${'─'.repeat(64)}`,
    '',
  ];
  console.log(lines.join('\n'));
}
