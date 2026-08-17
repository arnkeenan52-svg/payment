import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader: KEY=VALUE lines, # comments, real env always wins.
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

export const config = {
  root: ROOT,
  brand: 'Tradeleaks',
  port: num('PORT', 4000),
  publicBaseUrl: env('PUBLIC_BASE_URL', `http://localhost:${num('PORT', 4000)}`).replace(/\/$/, ''),
  sessionSecret: env('SESSION_SECRET', 'change-me'),
  dbPath: env('DB_PATH', path.join(ROOT, 'data', 'paygate.sqlite')),
  discord: {
    clientId: env('DISCORD_CLIENT_ID'),
    clientSecret: env('DISCORD_CLIENT_SECRET'),
    botToken: env('DISCORD_BOT_TOKEN'),
    guildId: env('DISCORD_GUILD_ID'),
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
  webhookToleranceSeconds: num('WEBHOOK_TOLERANCE_SECONDS', 300),
  gracePeriodHours: num('GRACE_PERIOD_HOURS', 72),
  sweepIntervalSeconds: num('SWEEP_INTERVAL_SECONDS', 600),
  plans: loadPlans(),
};

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
  const planLine = (p) =>
    `│   • ${p.id.padEnd(10)} ${p.name.padEnd(10)} $${String(p.priceUsd).padEnd(4)} ${p.interval.padEnd(8)} → roles [${p.roleIds.join(', ')}]`;
  const lines = [
    '',
    `┌─ ${c.brand.toUpperCase()} PAYGATE ${'─'.repeat(46)}`,
    `│ listening      http://localhost:${actualPort}   (public: ${c.publicBaseUrl})`,
    `│ database       ${c.dbPath}`,
    `│ discord        guild ${c.discord.guildId || '✗ MISSING'} | client ${set(c.discord.clientId)} | secret ${set(c.discord.clientSecret)} | bot ${set(c.discord.botToken)}`,
    `│ discord api    ${c.discord.apiBase}`,
    `│ stripe         key ${set(c.stripe.secretKey)} | webhook secret ${set(c.stripe.webhookSecret)} | api ${c.stripe.apiBase}`,
    `│ coinbase       key ${set(c.coinbase.apiKey)} | webhook secret ${set(c.coinbase.webhookSecret)} | api ${c.coinbase.apiBase}`,
    `│ webhooks       POST /webhooks/stripe   POST /webhooks/coinbase   (replay tolerance ${c.webhookToleranceSeconds}s)`,
    `│ entitlements   grace ${c.gracePeriodHours}h on failed renewals | expiry sweep every ${c.sweepIntervalSeconds}s`,
    `│ plans (plans.json)`,
    ...c.plans.map(planLine),
    `└${'─'.repeat(64)}`,
    '',
  ];
  console.log(lines.join('\n'));
}
