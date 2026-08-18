#!/usr/bin/env node
// End-to-end suite for the serverless build: boots the dev shim
// (scripts/dev-server.js), which mounts the SAME handler functions Vercel
// runs from api/**, against mock Stripe, Coinbase Commerce and Discord HTTP
// servers — then drives signed webhooks at it and asserts on the role calls
// the Discord mock actually received.
//
// Serverless semantics under test: webhooks do the work BEFORE responding
// (a frozen function must never leave a grant pending), idempotency is a
// PRIMARY KEY claim via INSERT ... ON CONFLICT DO NOTHING with the claim
// released on failure (500 → provider retry really retries), and the expiry
// sweep is the CRON_SECRET-guarded /api/cron/reconcile endpoint instead of a
// timer. Storage runs on SQLite by default; set E2E_DATABASE_URL to a
// Postgres connection string to run the identical suite against pg.

import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The suite runs against its own multi-plan catalog (role unions, a lifetime
// plan) so editing the production plans.json never shrinks test coverage.
const PLANS_PATH = path.join(ROOT, 'scripts', 'e2e-plans.json');
const PLANS = JSON.parse(fs.readFileSync(PLANS_PATH, 'utf8'));
const roleOf = (planId) => PLANS.find((p) => p.id === planId).roleIds[0];
const R_INSIDER = roleOf('insider');
const R_PRO = roleOf('pro');
const R_LIFETIME = roleOf('lifetime');

const GUILD = '900000000000000001';
const U1 = '501100000000000001'; // card buyer, not in guild at purchase time
const U2 = '502200000000000002'; // crypto buyer, already in guild with unmanaged roles
const U3 = '503300000000000003'; // buyer whose first webhook crashes the handler

const STRIPE_SECRET = 'whsec_e2e_secret';
const COINBASE_SECRET = 'cb_e2e_secret';
const CRON_SECRET = 'cron_e2e_secret_1'; // ≥16 chars so the doctor's own check passes
const BOT_ID = '600000000000000001';
const R_BOT = '1200000000000000999';
const R_ADMIN = '1200000000000000555';   // above the bot — must be flagged unusable
const R_NEW = '1200000000000000200';     // below the bot — pickable
const R_MANAGED = '1200000000000000666'; // integration-managed — unusable

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock state ────────────────────────────────────────────────────────────────

const discord = {
  members: new Map(),           // uid -> Set(roleIds)
  joins: [],                    // { uid, roles, accessToken }
  roleCalls: [],                // { method, uid, roleId }
  dms: [],                      // { uid, content }
  rateLimit429Remaining: 0,     // next N role PUT/DELETEs answer 429 first
  botRolePosition: 50,          // doctor: set below the managed roles (10-12) to break hierarchy
  failRolesFetchOnce: false,    // next GET /guilds/:id/roles answers 500
  extraRoles: [],               // appended to the role list (e.g. a same-named decoy)
  oauthUsers: {
    code_u1: { id: U1, username: 'trader_one' },
    code_u3: { id: U3, username: 'trader_three' },
  },
};
// The bot itself is a guild member holding its own role.
discord.members.set(BOT_ID, new Set([R_BOT]));

const stripe = {
  checkoutSessions: [],         // parsed form bodies
  periodEnds: {},               // subscription id -> current_period_end (on ITEMS only)
  failSubFetchOnce: new Set(),  // subscription ids whose next GET answers 500
  subFetches: {},               // subscription id -> fetch count
  failCheckoutSessionsWith: null, // when set, POST /v1/checkout/sessions answers 400 with this message
};

const coinbase = { charges: [] };

// ── mock servers ──────────────────────────────────────────────────────────────

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function startMock(name, handler) {
  const server = http.createServer(async (req, res) => {
    try {
      await handler(req, res);
      if (!res.writableEnded) json(res, 404, { error: `${name}: no route ${req.method} ${req.url}` });
    } catch (err) {
      console.error(`[mock ${name}] ${err.stack}`);
      if (!res.writableEnded) json(res, 500, { error: err.message });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function discordHandler(req, res) {
  const url = new URL(req.url, 'http://mock');
  const p = url.pathname;
  let m;

  if ((m = p.match(/^\/guilds\/([^/]+)\/members\/([^/]+)\/roles\/([^/]+)$/)) && (req.method === 'PUT' || req.method === 'DELETE')) {
    const [, , uid, roleId] = m;
    if (discord.rateLimit429Remaining > 0) {
      discord.rateLimit429Remaining--;
      discord.roleCalls.push({ method: req.method, uid, roleId, rateLimited: true });
      json(res, 429, { message: 'You are being rate limited.', retry_after: 0.05, global: false });
      return;
    }
    discord.roleCalls.push({ method: req.method, uid, roleId });
    if (!discord.members.has(uid)) {
      json(res, 404, { message: 'Unknown Member' });
      return;
    }
    if (req.method === 'PUT') discord.members.get(uid).add(roleId);
    else discord.members.get(uid).delete(roleId);
    res.writeHead(204).end();
    return;
  }

  if ((m = p.match(/^\/guilds\/([^/]+)\/members\/([^/]+)$/)) && req.method === 'PUT') {
    const [, , uid] = m;
    const body = JSON.parse(await readBody(req));
    if (discord.members.has(uid)) {
      res.writeHead(204).end();
      return;
    }
    assert.ok(body.access_token, 'guilds.join PUT must carry the OAuth access_token');
    discord.members.set(uid, new Set(body.roles ?? []));
    discord.joins.push({ uid, roles: body.roles ?? [], accessToken: body.access_token });
    json(res, 201, { user: { id: uid }, roles: body.roles ?? [] });
    return;
  }

  if ((m = p.match(/^\/guilds\/([^/]+)\/members\/([^/]+)$/)) && req.method === 'GET') {
    const [, , uid] = m;
    if (!discord.members.has(uid)) {
      json(res, 404, { message: 'Unknown Member' });
      return;
    }
    json(res, 200, { user: { id: uid }, roles: [...discord.members.get(uid)] });
    return;
  }

  if (p === '/users/@me/channels' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    json(res, 200, { id: `dm_${body.recipient_id}` });
    return;
  }
  if ((m = p.match(/^\/channels\/dm_([^/]+)\/messages$/)) && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    discord.dms.push({ uid: m[1], content: body.content });
    json(res, 200, { id: `msg_${discord.dms.length}` });
    return;
  }

  if (p === '/oauth2/token' && req.method === 'POST') {
    const params = new URLSearchParams(await readBody(req));
    const code = params.get('code');
    if (!discord.oauthUsers[code]) {
      json(res, 400, { error: 'invalid_grant' });
      return;
    }
    json(res, 200, { access_token: `tok_${code}`, refresh_token: `ref_${code}`, token_type: 'Bearer', expires_in: 604800 });
    return;
  }
  if (p === '/users/@me' && req.method === 'GET') {
    const auth = req.headers.authorization ?? '';
    if (auth.startsWith('Bot ')) {
      // The doctor authenticates the bot token here.
      json(res, 200, { id: BOT_ID, username: 'tradeleaks-bot' });
      return;
    }
    const user = discord.oauthUsers[auth.replace('Bearer tok_', '')];
    if (!user) {
      json(res, 401, { message: 'Unauthorized' });
      return;
    }
    json(res, 200, user);
    return;
  }

  // Guild object with an ANIMATED icon hash (a_ prefix) — the storefront must
  // surface it as the .gif CDN url so the server's animated logo plays.
  if ((m = p.match(/^\/guilds\/([^/]+)$/)) && req.method === 'GET') {
    json(res, 200, { id: m[1], name: 'Tradeleaks', icon: 'a_e2eicon' });
    return;
  }

  // Doctor: full role list with positions and permissions. The bot's role
  // position is mock-configurable so the hierarchy failure can be staged.
  if ((m = p.match(/^\/guilds\/([^/]+)\/roles$/)) && req.method === 'GET') {
    if (discord.failRolesFetchOnce) {
      discord.failRolesFetchOnce = false;
      json(res, 500, { message: 'mock: roles fetch exploded' });
      return;
    }
    json(res, 200, [
      ...discord.extraRoles,
      { id: GUILD, name: '@everyone', position: 0, permissions: '0', color: 0 },
      { id: R_BOT, name: 'Tradeleaks Bot', position: discord.botRolePosition, permissions: String(1 << 28), color: 0, managed: true }, // MANAGE_ROLES
      { id: R_ADMIN, name: 'Admin', position: 60, permissions: '8', color: 15548997 },
      { id: R_NEW, name: 'New Tier', position: 15, permissions: '0', color: 16711680 },
      { id: R_LIFETIME, name: 'Lifetime', position: 12, permissions: '0', color: 0 },
      { id: R_PRO, name: 'Pro Desk', position: 11, permissions: '0', color: 0 },
      { id: R_INSIDER, name: 'Insider', position: 10, permissions: '0', color: 0 },
      { id: R_MANAGED, name: 'Some Bot Integration', position: 3, permissions: '0', color: 0, managed: true },
    ]);
    return;
  }
}

// Doctor: prices matching the fixture catalog (amounts in cents).
const MOCK_PRICES = {
  price_insider_month: { id: 'price_insider_month', active: true, type: 'recurring', unit_amount: 1900, currency: 'usd', recurring: { interval: 'month' } },
  price_pro_month: { id: 'price_pro_month', active: true, type: 'recurring', unit_amount: 4900, currency: 'usd', recurring: { interval: 'month' } },
  price_lifetime_once: { id: 'price_lifetime_once', active: true, type: 'one_time', unit_amount: 29900, currency: 'usd' },
};

async function stripeHandler(req, res) {
  const url = new URL(req.url, 'http://mock');
  let m;
  if (url.pathname === '/v1/account' && req.method === 'GET') {
    if (req.headers.authorization !== 'Bearer sk_test_e2e') {
      json(res, 401, { error: { message: 'Invalid API Key' } });
      return;
    }
    json(res, 200, { id: 'acct_e2e' });
    return;
  }
  if ((m = url.pathname.match(/^\/v1\/prices\/([^/]+)$/)) && req.method === 'GET') {
    const price = MOCK_PRICES[m[1]];
    if (!price) {
      json(res, 404, { error: { message: 'No such price' } });
      return;
    }
    json(res, 200, price);
    return;
  }
  if (url.pathname === '/v1/checkout/sessions' && req.method === 'POST') {
    if (stripe.failCheckoutSessionsWith) {
      json(res, 400, { error: { message: stripe.failCheckoutSessionsWith } });
      return;
    }
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
    stripe.checkoutSessions.push(form);
    json(res, 200, { id: `cs_${stripe.checkoutSessions.length}`, url: `https://stripe.mock/pay/cs_${stripe.checkoutSessions.length}` });
    return;
  }
  if ((m = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/)) && req.method === 'GET') {
    const id = m[1];
    stripe.subFetches[id] = (stripe.subFetches[id] ?? 0) + 1;
    if (stripe.failSubFetchOnce.has(id)) {
      stripe.failSubFetchOnce.delete(id);
      json(res, 500, { error: { message: 'mock: transient explosion' } });
      return;
    }
    // Deliberately NO top-level current_period_end: Stripe moved it onto the
    // subscription items, so the app must read items.data[0] to pass.
    json(res, 200, {
      id,
      object: 'subscription',
      status: 'active',
      items: { data: [{ id: `si_${id}`, current_period_end: stripe.periodEnds[id] ?? nowSec() + 31 * 86400 }] },
    });
    return;
  }
}

async function coinbaseHandler(req, res) {
  if (new URL(req.url, 'http://mock').pathname === '/charges' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    coinbase.charges.push(body);
    const n = coinbase.charges.length;
    json(res, 201, { data: { id: `charge_${n}`, code: `CBCODE${n}`, hosted_url: `https://commerce.mock/charges/CBCODE${n}` } });
    return;
  }
}

// ── test-side database access (time travel + assertions) ─────────────────────
// Mirrors the app's adapter: SQLite by default, Postgres when E2E_DATABASE_URL
// is set — the app child gets the same target via its env.

const PG_URL = process.env.E2E_DATABASE_URL ?? '';
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-e2e-')), 'e2e.sqlite');
let tq; // (sql, params) => Promise<{rows}>

async function initTestDb() {
  if (PG_URL) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    tq = async (sql, params = []) => {
      let i = 0;
      return pool.query(sql.replace(/\?/g, () => `$${++i}`), params);
    };
    // fresh slate for repeat runs
    await tq('DROP TABLE IF EXISTS users');
    await tq('DROP TABLE IF EXISTS subscriptions');
    await tq('DROP TABLE IF EXISTS webhook_events');
    await tq('DROP TABLE IF EXISTS plan_overrides');
    await tq('DROP TABLE IF EXISTS managed_role_history');
  } else {
    const { DatabaseSync } = await import('node:sqlite');
    let sqlite;
    tq = async (sql, params = []) => {
      sqlite ??= (() => {
        const d = new DatabaseSync(dbPath);
        d.exec('PRAGMA busy_timeout = 5000');
        return d;
      })();
      const stmt = sqlite.prepare(sql);
      if (/^\s*select/i.test(sql)) return { rows: stmt.all(...params) };
      stmt.run(...params);
      return { rows: [] };
    };
  }
}

const asNum = (v) => (v === null || v === undefined ? null : Number(v));

async function subRow(provider, ref) {
  const { rows } = await tq('SELECT * FROM subscriptions WHERE provider = ? AND provider_ref = ?', [provider, ref]);
  const r = rows[0];
  return r ? { ...r, current_period_end: asNum(r.current_period_end), grace_until: asNum(r.grace_until) } : null;
}

const userRow = async (uid) => (await tq('SELECT * FROM users WHERE discord_id = ?', [uid])).rows[0] ?? null;
const claimRows = async (like) => (await tq('SELECT event_id FROM webhook_events WHERE event_id LIKE ?', [like])).rows;

// ── signing + delivery helpers ────────────────────────────────────────────────

let appUrl;

function signStripe(payload, t = nowSec()) {
  const v1 = crypto.createHmac('sha256', STRIPE_SECRET).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

const signCoinbase = (payload) => crypto.createHmac('sha256', COINBASE_SECRET).update(payload).digest('hex');

async function deliverStripe(event, { header, path: whPath = '/webhooks/stripe', base = appUrl } = {}) {
  const payload = JSON.stringify(event);
  const res = await fetch(`${base}${whPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': header ?? signStripe(payload) },
    body: payload,
  });
  return { status: res.status, body: await res.text() };
}

async function deliverCoinbase(event, { signature, base = appUrl } = {}) {
  const payload = JSON.stringify({ id: crypto.randomUUID(), event });
  const res = await fetch(`${base}/webhooks/coinbase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cc-webhook-signature': signature ?? signCoinbase(payload) },
    body: payload,
  });
  return { status: res.status, body: await res.text() };
}

const coinbaseEvent = (type, { id, code, discordId, planId, createdAt }) => ({
  id,
  type,
  created_at: createdAt ?? new Date().toISOString(),
  data: { id: `charge_${code}`, code, metadata: { discord_id: discordId, plan_id: planId } },
});

// The cron sweep — what Vercel's scheduler calls, with its Bearer secret.
async function hitCron({ secret = CRON_SECRET, omitHeader = false } = {}) {
  const res = await fetch(`${appUrl}/api/cron/reconcile`, {
    headers: omitHeader ? {} : { authorization: `Bearer ${secret}` },
  });
  return { status: res.status, body: await res.text() };
}

async function waitFor(desc, fn, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(25);
  }
  throw new Error(`timed out waiting for: ${desc}`);
}

const memberRoles = (uid) => discord.members.get(uid) ?? new Set();

// ── boot the real handlers via the dev shim ───────────────────────────────────

const children = [];

async function spawnApp(env) {
  const log = [];
  const child = spawn(process.execPath, ['scripts/dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', (d) => log.push(d.toString()));
  child.stderr.on('data', (d) => log.push(d.toString()));
  const port = await waitFor('app to start listening', () => {
    const m = log.join('').match(/listening on http:\/\/localhost:(\d+)/);
    return m ? Number(m[1]) : null;
  });
  return { child, log, url: `http://127.0.0.1:${port}` };
}

const baseEnv = (mocks) => ({
  ENV_PATH: '/nonexistent/.env', // a developer's real .env must never leak in
  PLANS_PATH,
  PORT: '0',
  // In SQLite mode, blank both connection-string names so a POSTGRES_URL in
  // the developer's shell can't silently flip the suite onto Postgres.
  ...(PG_URL ? { DATABASE_URL: PG_URL } : { DB_PATH: dbPath, DATABASE_URL: '', POSTGRES_URL: '' }),
  PUBLIC_BASE_URL: 'https://tradeleaks.e2e', // https + snowflake-shaped ids so the doctor's structural checks pass
  SESSION_SECRET: 'e2e-session-secret',
  CRON_SECRET,
  DISCORD_CLIENT_ID: '1010101010101010101',
  OWNER_DISCORD_ID: U1, // U1 doubles as the store owner in these tests
  DISCORD_CLIENT_SECRET: 'client_secret_e2e',
  DISCORD_BOT_TOKEN: 'bot_token_e2e',
  DISCORD_GUILD_ID: GUILD,
  DISCORD_API_BASE: mocks.discord.url,
  STRIPE_SECRET_KEY: 'sk_test_e2e',
  STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
  STRIPE_API_BASE: mocks.stripe.url,
  WEBHOOK_TOLERANCE_SECONDS: '300',
  GRACE_PERIOD_HOURS: '72',
});

// ── tiny sequential harness ───────────────────────────────────────────────────

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let appLog; // phase-1 child log
let phase1Env; // full env of the phase-1 app — reused to run the doctor CLI

function runDoctorCli(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/doctor.js'], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

// ═══ scenarios ════════════════════════════════════════════════════════════════

test('npm start entry prints the config banner (storage + cron lines)', async () => {
  await waitFor('banner in stdout', () => appLog.join('').includes('TRADELEAKS PAYGATE'));
  const out = appLog.join('');
  assert.match(out, /webhooks\s+POST \/webhooks\/stripe\s+POST \/webhooks\/coinbase/);
  assert.match(out, /cron\s+GET \/api\/cron\/reconcile/);
  assert.match(out, PG_URL ? /storage\s+postgres/ : /storage\s+sqlite/);
});

test('storefront serves the Tradeleaks page, plans API exposes capabilities', async () => {
  const page = await (await fetch(`${appUrl}/`)).text();
  assert.match(page, /Tradeleaks/i);
  const { plans, capabilities, server } = await (await fetch(`${appUrl}/api/plans`)).json();
  assert.equal(plans.length, PLANS.length);
  assert.deepEqual(capabilities, { stripe: true, crypto: true }); // coinbase configured in this phase
  assert.equal(
    server.iconUrl,
    `https://cdn.discordapp.com/icons/${GUILD}/a_e2eicon.gif?size=128`,
    'an animated guild icon must surface as the .gif CDN url',
  );
  assert.equal(server.name, 'Tradeleaks', 'server name must come from the live guild lookup, never a placeholder');
  const diagPage = await fetch(`${appUrl}/diagnostics`);
  assert.equal(diagPage.status, 200);
  assert.match(await diagPage.text(), /Setup diagnostics/);
  assert.deepEqual(Object.keys(plans[0]).sort(), ['description', 'descriptionHighlight', 'id', 'interval', 'lifetime', 'name', 'priceUsd', 'roleNames']);
});

test('cron endpoint rejects a missing or wrong secret (timingSafeEqual guard)', async () => {
  assert.equal((await hitCron({ omitHeader: true })).status, 401);
  assert.equal((await hitCron({ secret: 'wrong-secret' })).status, 401);
  assert.equal((await hitCron({ secret: `${CRON_SECRET}x` })).status, 401);
  const ok = await hitCron();
  assert.equal(ok.status, 200);
  assert.match(ok.body, /"ok":true/);
});

let u1Cookie;

test('checkout is refused for logged-out buyers (401 — UI gating is not security)', async () => {
  const res = await fetch(`${appUrl}/api/checkout/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId: 'insider' }),
  });
  assert.equal(res.status, 401);
  assert.equal(stripe.checkoutSessions.length, 0, 'no checkout session may be created without a session');
});

test('OAuth login requests guilds.join, stores the token, and carries the plan back', async () => {
  const login = await fetch(`${appUrl}/auth/login?plan=insider`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const authorize = new URL(login.headers.get('location'));
  assert.equal(authorize.searchParams.get('scope'), 'identify guilds.join');
  const state = authorize.searchParams.get('state');
  const rawStateCookie = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  assert.match(rawStateCookie, /Domain=tradeleaks\.e2e/, 'auth cookies must be registrable-domain scoped (apex↔www hop)');
  assert.match(rawStateCookie, /Secure/, 'auth cookies must be Secure on https deployments');
  const cookies = login.headers.getSetCookie().map((c) => c.split(';')[0]);
  assert.ok(cookies.includes('tl_checkout_plan=insider'), 'login must remember which plan the buyer was on');

  const cb = await fetch(`${appUrl}/auth/callback?code=code_u1&state=${state}`, {
    redirect: 'manual',
    headers: { cookie: cookies.join('; ') },
  });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/?plan=insider', 'buyer must land back on the plan, ready to pay');
  u1Cookie = cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];

  assert.equal((await userRow(U1)).access_token, 'tok_code_u1');

  const me = await (await fetch(`${appUrl}/api/me`, { headers: { cookie: u1Cookie } })).json();
  assert.deepEqual({ loggedIn: me.loggedIn, username: me.username }, { loggedIn: true, username: 'trader_one' });
});

test('OAuth state mismatch auto-heals once, then reports plainly (no loop)', async () => {
  // Callback with a lost cookie: retry exactly once…
  const first = await fetch(`${appUrl}/auth/callback?code=x&state=deadbeef`, { redirect: 'manual' });
  assert.equal(first.status, 302);
  assert.equal(first.headers.get('location'), '/auth/login?retry=1');

  // …the retry login mints a state marked .r…
  const retryLogin = await fetch(`${appUrl}/auth/login?retry=1`, { redirect: 'manual' });
  const retryState = new URL(retryLogin.headers.get('location')).searchParams.get('state');
  assert.match(retryState, /\.r$/, 'retry marker must ride inside the OAuth state, not a cookie');

  // …and if the cookie is lost AGAIN, explain instead of looping.
  const second = await fetch(`${appUrl}/auth/callback?code=x&state=${retryState}`, { redirect: 'manual' });
  assert.equal(second.status, 400);
  assert.match(await second.text(), /did not keep the login cookie/i);
});

test('checkout endpoint creates a Stripe session with the buyer wired in', async () => {
  const res = await fetch(`${appUrl}/api/checkout/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u1Cookie },
    body: JSON.stringify({ planId: 'insider', note: 'purchased by @e2e on discord' }),
  });
  const { url } = await res.json();
  assert.match(url, /^https:\/\/stripe\.mock\/pay\//);
  const form = stripe.checkoutSessions.at(-1);
  assert.equal(form.mode, 'subscription');
  assert.equal(form.client_reference_id, U1);
  assert.equal(form['metadata[plan_id]'], 'insider');
  assert.equal(form['metadata[buyer_note]'], 'purchased by @e2e on discord', 'buyer note must reach Stripe metadata');
  assert.equal(form['line_items[0][price]'], 'price_insider_month');
  assert.match(form.success_url, /\/receipt\?plan=insider$/, 'buyers must land on the order receipt');
});

const SUB1_END = nowSec() + 31 * 86400;

test('purchase: webhook completes the grant BEFORE responding (serverless-safe)', async () => {
  stripe.periodEnds.sub_1 = SUB1_END;
  assert.equal(discord.members.has(U1), false, 'U1 must start outside the guild');
  const { status, body } = await deliverStripe({
    id: 'evt_checkout_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', mode: 'subscription', subscription: 'sub_1', client_reference_id: U1, metadata: { plan_id: 'insider', discord_id: U1 } } },
  });
  assert.deepEqual({ status, body }, { status: 200, body: 'ok' });

  // No waiting: the response means the work already happened.
  assert.ok(memberRoles(U1).has(R_INSIDER), 'role must be granted by the time the webhook responds');
  const join = discord.joins.find((j) => j.uid === U1);
  assert.deepEqual(join.roles, [R_INSIDER]);
  assert.equal(join.accessToken, 'tok_code_u1');

  const row = await subRow('stripe', 'sub_1');
  assert.equal(row.status, 'active');
  // The mock returns current_period_end ONLY on items.data[0] — equality here
  // proves the sub.current_period_end ?? items fallback is being read.
  assert.equal(row.current_period_end, SUB1_END);

  // Simulate a mod role granted by hand; nothing below may ever remove it.
  discord.members.get(U1).add('ROLE_MOD_UNMANAGED');
});

const SUB1_RENEWED_END = nowSec() + 62 * 86400;

test('renewal: invoice.paid extends the expiry', async () => {
  stripe.periodEnds.sub_1 = SUB1_RENEWED_END;
  // Newer Stripe API versions nest the subscription id under parent.*
  const { status } = await deliverStripe({
    id: 'evt_invoice_1',
    type: 'invoice.paid',
    data: { object: { id: 'in_1', parent: { subscription_details: { subscription: 'sub_1' } } } },
  });
  assert.equal(status, 200);
  const row = await subRow('stripe', 'sub_1');
  assert.equal(row.current_period_end, SUB1_RENEWED_END);
  assert.equal(row.status, 'active');
  assert.ok(memberRoles(U1).has(R_INSIDER));
});

test('duplicate delivery (via /api path): same event id claimed once, not reprocessed', async () => {
  const fetchesBefore = stripe.subFetches.sub_1;
  // Post the duplicate to the direct /api route — same handler, same claim.
  const { status, body } = await deliverStripe(
    {
      id: 'evt_invoice_1',
      type: 'invoice.paid',
      data: { object: { id: 'in_1', parent: { subscription_details: { subscription: 'sub_1' } } } },
    },
    { path: '/api/webhooks/stripe' },
  );
  assert.deepEqual({ status, body }, { status: 200, body: 'duplicate' });
  assert.equal(stripe.subFetches.sub_1, fetchesBefore, 'duplicate must not hit Stripe again');
});

test('forged and stale signatures are rejected with no side effects', async () => {
  const evt = { id: 'evt_forged', type: 'invoice.paid', data: { object: { subscription: 'sub_1' } } };
  const payload = JSON.stringify(evt);

  const forged = await deliverStripe(evt, { header: `t=${nowSec()},v1=${'0'.repeat(64)}` });
  assert.equal(forged.status, 400);

  const stale = await deliverStripe(evt, { header: signStripe(payload, nowSec() - 600) });
  assert.equal(stale.status, 400, 'a replayed capture outside the 5-minute window must be rejected');

  const wrongKey = await deliverStripe(evt, {
    header: `t=${nowSec()},v1=${crypto.createHmac('sha256', 'wrong-secret').update(`${nowSec()}.${payload}`).digest('hex')}`,
  });
  assert.equal(wrongKey.status, 400);

  const cbForged = await deliverCoinbase(
    coinbaseEvent('charge:confirmed', { id: 'cb_forged', code: 'CBFORGED', discordId: U2, planId: 'insider' }),
    { signature: '0'.repeat(64) },
  );
  assert.equal(cbForged.status, 400);

  assert.deepEqual(await claimRows('%forged%'), []);
});

test('coinbase events outside the replay window are rejected even when correctly signed', async () => {
  const { status, body } = await deliverCoinbase(
    coinbaseEvent('charge:confirmed', {
      id: 'cb_stale', code: 'CBSTALE', discordId: U2, planId: 'insider',
      createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    }),
  );
  assert.deepEqual({ status, body }, { status: 400, body: 'stale event' });
});

test('handler crash: 500 + claim released, so the provider retry really retries', async () => {
  stripe.failSubFetchOnce.add('sub_3');
  const evt = {
    id: 'evt_checkout_3',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_3', mode: 'subscription', subscription: 'sub_3', client_reference_id: U3, metadata: { plan_id: 'pro', discord_id: U3 } } },
  };
  const first = await deliverStripe(evt);
  // Work-first semantics: the failure surfaces as a 500 (Stripe will retry),
  // never as a swallowed 200.
  assert.deepEqual({ status: first.status, body: first.body }, { status: 500, body: 'processing failed' });
  assert.deepEqual(await claimRows('stripe:evt_checkout_3'), [], 'claim must be released after the crash');
  assert.equal(await subRow('stripe', 'sub_3'), null);

  const retry = await deliverStripe(evt); // the provider's retry of the SAME event id
  assert.deepEqual({ status: retry.status, body: retry.body }, { status: 200, body: 'ok' });
  assert.equal((await subRow('stripe', 'sub_3')).status, 'active');
});

test('buyer not in guild with no token yet gets roles at login via guilds.join', async () => {
  assert.equal(discord.members.has(U3), false);
  const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const authorize = new URL(login.headers.get('location'));
  const stateCookie = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  await fetch(`${appUrl}/auth/callback?code=code_u3&state=${authorize.searchParams.get('state')}`, {
    redirect: 'manual',
    headers: { cookie: stateCookie.split(';')[0] },
  });
  assert.ok(memberRoles(U3).has(R_PRO), 'login reconcile must join U3 with the pro role');
  assert.deepEqual(discord.joins.find((j) => j.uid === U3).roles, [R_PRO]);
});

test('declined renewal: DM + grace window, role kept across a cron sweep', async () => {
  const { status } = await deliverStripe({
    id: 'evt_invoice_fail_1',
    type: 'invoice.payment_failed',
    data: { object: { id: 'in_2', parent: { subscription_details: { subscription: 'sub_1' } } } },
  });
  assert.equal(status, 200);
  const dm = discord.dms.find((d) => d.uid === U1);
  assert.ok(dm, 'buyer must be DMed about the failed payment');
  assert.match(dm.content, /payment .*didn't go through/i);
  assert.match(dm.content, /keep access until/i);
  const row = await subRow('stripe', 'sub_1');
  assert.equal(row.status, 'past_due');
  assert.ok(row.grace_until > nowSec() + 71 * 3600, 'grace window ≈ GRACE_PERIOD_HOURS');

  const sweep = await hitCron();
  assert.equal(sweep.status, 200);
  assert.ok(memberRoles(U1).has(R_INSIDER), 'role must survive the sweep during grace');
});

test('grace expiry: cron sweep revokes the managed role, unmanaged role untouched', async () => {
  await tq("UPDATE subscriptions SET grace_until = ? WHERE provider_ref = 'sub_1'", [nowSec() - 10]);
  const sweep = await hitCron();
  assert.equal(sweep.status, 200);
  assert.ok(!memberRoles(U1).has(R_INSIDER), 'sweep must pull the lapsed insider role');
  assert.equal((await subRow('stripe', 'sub_1')).status, 'expired');
  assert.ok(memberRoles(U1).has('ROLE_MOD_UNMANAGED'), 'sweep must never touch mod/colour/unmanaged roles');
});

test('late payment recovery: invoice.paid re-grants after expiry', async () => {
  stripe.periodEnds.sub_1 = nowSec() + 31 * 86400;
  const { status } = await deliverStripe({
    id: 'evt_invoice_2',
    type: 'invoice.paid',
    data: { object: { id: 'in_3', parent: { subscription_details: { subscription: 'sub_1' } } } },
  });
  assert.equal(status, 200);
  assert.ok(memberRoles(U1).has(R_INSIDER), 'insider role restored');
  assert.equal((await subRow('stripe', 'sub_1')).status, 'active');
});

test('cancellation: customer.subscription.deleted removes the role', async () => {
  const { status } = await deliverStripe({
    id: 'evt_sub_deleted_1',
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_1', object: 'subscription', status: 'canceled' } },
  });
  assert.equal(status, 200);
  assert.ok(!memberRoles(U1).has(R_INSIDER));
  assert.equal((await subRow('stripe', 'sub_1')).status, 'canceled');
  assert.ok(memberRoles(U1).has('ROLE_MOD_UNMANAGED'));
});

test('crypto: charge:pending never grants', async () => {
  discord.members.set(U2, new Set(['ROLE_COLOUR_UNMANAGED'])); // already in guild
  const { status, body } = await deliverCoinbase(coinbaseEvent('charge:pending', { id: 'cb_pend_1', code: 'CBP1', discordId: U2, planId: 'insider' }));
  assert.deepEqual({ status, body }, { status: 200, body: 'ok' });
  assert.equal(memberRoles(U2).has(R_INSIDER), false, 'pending is a mempool sighting, not money');
  assert.equal(await subRow('coinbase', 'CBP1'), null);
});

test('crypto: charge:confirmed grants a fixed term, honouring 429 retry_after', async () => {
  discord.rateLimit429Remaining = 1;
  const { status } = await deliverCoinbase(coinbaseEvent('charge:confirmed', { id: 'cb_conf_1', code: 'CBC1', discordId: U2, planId: 'insider' }));
  assert.equal(status, 200);
  assert.ok(memberRoles(U2).has(R_INSIDER));

  const calls = discord.roleCalls.filter((c) => c.uid === U2 && c.roleId === R_INSIDER && c.method === 'PUT');
  assert.equal(calls.length, 2, 'first call rate-limited, second after retry_after honoured');
  assert.equal(calls[0].rateLimited, true);

  const row = await subRow('coinbase', 'CBC1');
  assert.equal(row.status, 'active');
  const expectedEnd = nowSec() + 31 * 86400;
  assert.ok(
    row.current_period_end !== null && Math.abs(row.current_period_end - expectedEnd) < 3600,
    'crypto cannot auto-renew: a term plan grant must be a fixed term, never NULL',
  );
});

test('crypto: charge:resolved also grants', async () => {
  const { status } = await deliverCoinbase(coinbaseEvent('charge:resolved', { id: 'cb_res_1', code: 'CBR1', discordId: U2, planId: 'pro' }));
  assert.equal(status, 200);
  assert.ok(memberRoles(U2).has(R_PRO));
  assert.equal((await subRow('coinbase', 'CBR1')).status, 'active');
});

test('cron sweep: ended crypto term loses its role, other roles untouched', async () => {
  await tq("UPDATE subscriptions SET current_period_end = ? WHERE provider_ref = 'CBC1'", [nowSec() - 10]);
  const sweep = await hitCron();
  assert.equal(sweep.status, 200);
  assert.match(sweep.body, /"lapsed":1/);
  assert.ok(!memberRoles(U2).has(R_INSIDER), 'sweep must pull the ended crypto term');
  assert.equal((await subRow('coinbase', 'CBC1')).status, 'expired');
  assert.ok(memberRoles(U2).has(R_PRO), 'the still-active pro sub must keep its role');
  assert.ok(memberRoles(U2).has('ROLE_COLOUR_UNMANAGED'), 'unmanaged colour role must survive');
});

test('lifetime: NULL expiry survives the cron sweep', async () => {
  const { status } = await deliverStripe({
    id: 'evt_checkout_life',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_life', mode: 'payment', payment_intent: 'pi_life_1', client_reference_id: U1, metadata: { plan_id: 'lifetime', discord_id: U1 } } },
  });
  assert.equal(status, 200);
  assert.ok(memberRoles(U1).has(R_LIFETIME));
  const row = await subRow('stripe', 'pi_life_1');
  assert.equal(row.current_period_end, null, 'NULL expiry means lifetime and nothing else');

  const sweep = await hitCron();
  assert.equal(sweep.status, 200);
  assert.ok(memberRoles(U1).has(R_LIFETIME), 'lifetime must survive the expiry sweep');
  assert.equal((await subRow('stripe', 'pi_life_1')).status, 'active');
});

test('coinbase checkout endpoint creates a charge with metadata (crypto enabled here)', async () => {
  const res = await fetch(`${appUrl}/api/checkout/coinbase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u1Cookie },
    body: JSON.stringify({ planId: 'pro' }),
  });
  const { url } = await res.json();
  assert.match(url, /^https:\/\/commerce\.mock\/charges\//);
  const charge = coinbase.charges.at(-1);
  assert.deepEqual(charge.metadata, { discord_id: U1, plan_id: 'pro' });
  assert.equal(charge.local_price.amount, '49');
});

test('setup doctor: healthy config passes; endpoint gates detail behind CRON_SECRET', async () => {
  const full = await (await fetch(`${appUrl}/api/setup-check`, {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  })).json();
  assert.equal(full.ok, true);
  assert.ok(Array.isArray(full.checks) && full.checks.length >= 10, 'authorized call must return the check list');
  assert.deepEqual(full.checks.filter((c) => c.status === 'fail'), [], 'no check may fail on a healthy setup');
  assert.ok(
    full.checks.some((c) => c.id.startsWith('discord:hierarchy:') && c.status === 'pass'),
    'the hierarchy check must run and pass',
  );
  assert.ok(full.checks.some((c) => c.id === 'stripe:auth' && /test mode/.test(c.detail)), 'reports test vs live mode');
  assert.ok(full.checks.some((c) => c.id === 'discord:bot-auth' && /tradeleaks-bot/.test(c.detail)), 'reports bot username');

  const summary = await (await fetch(`${appUrl}/api/setup-check`)).json();
  assert.deepEqual(summary, { ok: true }, 'unauthenticated callers get the bare ok flag and nothing else');

  // The signed-in OWNER gets the full report (drives /diagnostics) …
  const ownerView = await (await fetch(`${appUrl}/api/setup-check?fresh=1`, { headers: { cookie: u1Cookie } })).json();
  assert.ok(Array.isArray(ownerView.checks) && ownerView.checks.length >= 10, 'the owner session must unlock the check list');
  assert.ok(!JSON.stringify(ownerView).includes('sk_test_e2e'), 'the owner report must never contain raw secrets');

  // … while any other signed-in user stays on the bare flag.
  const login3 = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const st3 = new URL(login3.headers.get('location')).searchParams.get('state');
  const sc3 = login3.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  const cb3 = await fetch(`${appUrl}/auth/callback?code=code_u3&state=${st3}`, {
    redirect: 'manual',
    headers: { cookie: sc3.split(';')[0] },
  });
  const u3Cookie = cb3.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  const nonOwner = await (await fetch(`${appUrl}/api/setup-check`, { headers: { cookie: u3Cookie } })).json();
  assert.deepEqual(nonOwner, { ok: true }, 'a non-owner session must not unlock the report');
});

test('Vercel parsed-body regression: webhook never crashes, never touches the lazy body getter', async () => {
  const { Readable } = await import('node:stream');
  const { default: stripeWebhook } = await import('../api/webhooks/stripe.js');

  const makeRes = () => {
    const res = { statusCode: 0, body: '', headersSent: false };
    res.writeHead = (code) => ((res.statusCode = code), (res.headersSent = true), res);
    res.end = (chunk) => ((res.body += chunk ?? ''), res);
    return res;
  };

  // Case A: the platform pre-parsed the body onto req.body as a plain object
  // (raw bytes gone). Must be a clean 400, not FUNCTION_INVOCATION_FAILED.
  const reqA = new Readable({ read() {} });
  reqA.method = 'POST';
  reqA.url = '/api/webhooks/stripe';
  reqA.headers = { 'stripe-signature': 't=1,v1=deadbeef' };
  Object.defineProperty(reqA, 'body', { value: { id: 'evt_x', type: 'noop' }, configurable: true });
  const resA = makeRes();
  await stripeWebhook(reqA, resA);
  assert.deepEqual({ status: resA.statusCode, body: resA.body }, { status: 400, body: 'raw body unavailable' });

  // Case B: Vercel-style LAZY body getter — merely probing it would consume
  // the stream. The handler must read the stream and never touch the getter.
  const reqB = new Readable({ read() {} });
  reqB.method = 'POST';
  reqB.url = '/api/webhooks/stripe';
  reqB.headers = {}; // no signature → clean 400 after the raw read
  let getterTouched = false;
  Object.defineProperty(reqB, 'body', {
    get() {
      getterTouched = true;
      return {};
    },
    configurable: true,
  });
  reqB.push('{"id":"evt_y","type":"noop"}');
  reqB.push(null);
  const resB = makeRes();
  await stripeWebhook(reqB, resB);
  assert.deepEqual({ status: resB.statusCode, body: resB.body }, { status: 400, body: 'invalid signature' });
  assert.equal(getterTouched, false, 'the lazy req.body getter must never be invoked on the webhook path');
});

test('setup doctor CLI: exit 0 on healthy setup, secrets only ever masked', async () => {
  const { code, out } = await runDoctorCli(phase1Env);
  assert.equal(code, 0, `doctor must exit 0 on a healthy setup:\n${out}`);
  assert.match(out, /tradeleaks-bot/);
  assert.match(out, /test mode/);
  assert.match(out, /safe to take payments/i);
  for (const secret of ['sk_test_e2e', STRIPE_SECRET, 'bot_token_e2e', CRON_SECRET, 'e2e-session-secret', 'client_secret_e2e']) {
    assert.ok(!out.includes(secret), `doctor output must never contain the raw secret ${secret.slice(0, 4)}…`);
  }
});

test('setup doctor: bot role at/below a managed role fails loudly with the drag-above fix', async () => {
  discord.botRolePosition = 5; // below Insider(10)/Pro(11)/Lifetime(12) — the charge-then-403 failure
  try {
    const { code, out } = await runDoctorCli(phase1Env);
    assert.equal(code, 1, `doctor must exit non-zero when the hierarchy is broken:\n${out}`);
    assert.match(out, /position 5/, 'names the bot role position');
    assert.match(out, /403 AFTER the buyer has paid/i, 'states the consequence loudly');
    assert.match(out, /Server Settings → Roles → drag/i, 'gives the exact click path');
    assert.match(out, /DO NOT take payments/i);

    // The storefront-facing summary flips too, so the banner shows.
    const broken = await spawnApp({ ...phase1Env, PORT: '0' });
    try {
      const summary = await (await fetch(`${broken.url}/api/setup-check`)).json();
      assert.deepEqual(summary, { ok: false }, 'public summary must report failing (drives the storefront banner)');
      const detail = await (await fetch(`${broken.url}/api/setup-check`, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      })).json();
      assert.ok(detail.checks.some((c) => c.id.startsWith('discord:hierarchy:') && c.status === 'fail'));
    } finally {
      broken.child.kill('SIGTERM');
    }
  } finally {
    discord.botRolePosition = 50;
  }
});

test('role picker: owner sees guild roles with usability flags; others refused', async () => {
  assert.equal((await fetch(`${appUrl}/api/admin/roles`)).status, 401, 'anonymous gets 401');

  const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const st = new URL(login.headers.get('location')).searchParams.get('state');
  const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  const cb = await fetch(`${appUrl}/auth/callback?code=code_u3&state=${st}`, {
    redirect: 'manual',
    headers: { cookie: sc.split(';')[0] },
  });
  const u3Cookie = cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  assert.equal((await fetch(`${appUrl}/api/admin/roles`, { headers: { cookie: u3Cookie } })).status, 403, 'non-owner gets 403');

  const data = await (await fetch(`${appUrl}/api/admin/roles`, { headers: { cookie: u1Cookie } })).json();
  assert.deepEqual({ name: data.botTop.name, position: data.botTop.position }, { name: 'Tradeleaks Bot', position: 50 });
  const byName = new Map(data.roles.map((r) => [r.name, r]));
  assert.equal(byName.get('Admin').usable, false, 'a role above the bot must be unusable');
  assert.match(byName.get('Admin').reason, /at or above the bot/i);
  assert.equal(byName.get('@everyone').usable, false);
  assert.equal(byName.get('Some Bot Integration').usable, false, 'integration-managed roles are unusable');
  assert.deepEqual(
    { usable: byName.get('New Tier').usable, color: byName.get('New Tier').color },
    { usable: true, color: '#ff0000' },
    'a normal role below the bot is pickable, with its colour',
  );
  assert.equal(data.plans[0].source, 'default');
});

test('picking a role writes the DB override; grants use it immediately', async () => {
  const post = (body, cookie) =>
    fetch(`${appUrl}/api/admin/plan-role`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  assert.equal((await post({ planId: 'insider', roleId: R_NEW })).status, 401, 'anonymous cannot write');
  const above = await post({ planId: 'insider', roleId: R_ADMIN }, u1Cookie);
  assert.equal(above.status, 400, 'a role at/above the bot is rejected server-side');
  assert.match((await above.json()).error, /at or above the bot/i);

  const ok = await post({ planId: 'insider', roleId: R_NEW }, u1Cookie);
  assert.equal(ok.status, 200);

  const { plans } = await (await fetch(`${appUrl}/api/plans`)).json();
  assert.deepEqual(plans.find((p) => p.id === 'insider').roleNames, ['@New Tier'], 'storefront role name follows the pick');

  // A fresh grant must hand out the PICKED role, not the plans.json one.
  const { status } = await deliverCoinbase(coinbaseEvent('charge:confirmed', { id: 'cb_pick_1', code: 'CBPICK', discordId: U3, planId: 'insider' }));
  assert.equal(status, 200);
  assert.ok(memberRoles(U3).has(R_NEW), 'grant must use the picked role');
  assert.ok(!memberRoles(U3).has(R_INSIDER), 'the old plans.json role must not be granted');
  assert.ok(memberRoles(U3).has(R_PRO), 'unrelated entitled roles stay');
});

test('doctor fails loudly on a currency mismatch (never assumes account default)', async () => {
  MOCK_PRICES.price_pro_month.currency = 'dkk';
  try {
    const { code, out } = await runDoctorCli(phase1Env);
    assert.equal(code, 1, `doctor must exit non-zero on a currency mismatch:\n${out}`);
    assert.match(out, /CURRENCY MISMATCH/);
    assert.match(out, /DKK/);
    assert.match(out, /Create the price in USD/i);
  } finally {
    MOCK_PRICES.price_pro_month.currency = 'usd';
  }
});

test('checkout answers clean JSON when Stripe rejects the session (never an opaque error page)', async () => {
  stripe.failCheckoutSessionsWith = 'No such price: price_pro_month';
  try {
    const res = await fetch(`${appUrl}/api/checkout/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: u1Cookie },
      body: JSON.stringify({ planId: 'pro' }),
    });
    assert.equal(res.status, 502, 'a Stripe rejection must surface as 502, not a crash');
    assert.match(res.headers.get('content-type') ?? '', /application\/json/, 'body must be JSON for the storefront to render');
    const body = await res.json();
    assert.match(body.error, /payment could not be started/i);
    assert.doesNotMatch(body.error, /no such price/i, 'raw Stripe internals must not leak to buyers');
  } finally {
    stripe.failCheckoutSessionsWith = null;
  }
});

test('a plan with stale roleIds grants by role NAME, and the doctor goes green', async () => {
  // plans.json ships a dead snowflake but names the role — resolution must
  // find the real role by its name from the live guild list. A same-named
  // decoy ABOVE the bot must lose to the grantable role below the bot.
  const R_DECOY = '1200000000000000201';
  const namedPlans = [
    {
      id: 'named',
      name: 'Named Tier',
      description: 'role resolved by name',
      priceUsd: 299,
      interval: 'lifetime',
      lifetime: true,
      durationDays: null,
      stripePriceId: 'price_lifetime_once',
      roleIds: ['1200000000000000404'], // no such role in the guild
      roleNames: ['@New Tier'], // the real role, by name (with the display "@")
    },
  ];
  const namedPlansPath = path.join(path.dirname(dbPath), 'named-plans.json');
  fs.writeFileSync(namedPlansPath, JSON.stringify(namedPlans, null, 2));
  const env = {
    ...phase1Env,
    PLANS_PATH: namedPlansPath,
    ROLE_CACHE_SECONDS: '0', // every resolution refetches — the failure knobs below stay deterministic
    ...(PG_URL ? {} : { DB_PATH: path.join(path.dirname(dbPath), 'named.sqlite') }),
  };
  const app2 = await spawnApp(env);
  discord.extraRoles = [{ id: R_DECOY, name: 'New Tier', position: 55, permissions: '0', color: 0 }];

  try {
    const U4 = '504400000000000004';
    discord.members.set(U4, new Set());
    const { status } = await deliverStripe(
      {
        id: 'evt_named_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_named_1',
            mode: 'payment',
            client_reference_id: U4,
            metadata: { plan_id: 'named', discord_id: U4 },
          },
        },
      },
      { base: app2.url },
    );
    assert.equal(status, 200);
    assert.ok(memberRoles(U4).has(R_NEW), 'the grant must land on the role matched by name');
    assert.ok(!memberRoles(U4).has(R_DECOY), 'the same-named decoy above the bot must not be picked');
    assert.ok(!memberRoles(U4).has('1200000000000000404'), 'the dead configured id must not be attempted');

    const { plans } = await (await fetch(`${app2.url}/api/plans`)).json();
    assert.deepEqual(plans[0].roleNames, ['@New Tier']);

    // A transient roles-fetch failure mid-sweep must NEVER strip an entitled
    // member's name-resolved role (degraded mappings skip removals).
    discord.failRolesFetchOnce = true;
    const cron = await fetch(`${app2.url}/api/cron/reconcile`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
    assert.equal(cron.status, 200);
    assert.ok(memberRoles(U4).has(R_NEW), 'a transient roles-fetch failure must not strip the entitled role');

    // The next (healthy) sweep converges back to exactly the resolved role.
    const cron2 = await fetch(`${app2.url}/api/cron/reconcile`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
    assert.equal(cron2.status, 200);
    assert.ok(memberRoles(U4).has(R_NEW), 'healthy sweep keeps the entitled role');
    assert.ok(!memberRoles(U4).has('1200000000000000404'), 'healthy sweep cleans up any degraded-mode junk');

    const doctor = await runDoctorCli(env);
    assert.match(doctor.out, /matched by role name/i, `doctor must say the role was matched by name:\n${doctor.out}`);
    assert.match(doctor.out, /matched by NAME instead/, `doctor must warn about the stale configured id:\n${doctor.out}`);
    assert.equal(doctor.code, 0, `doctor must pass once the role resolves by name:\n${doctor.out}`);

    // A typo'd id NEXT TO a valid one must still fail loudly — resolution
    // dropping it silently is exactly what the doctor exists to catch.
    const mixedPlans = [
      { ...namedPlans[0], id: 'mixed', roleIds: [R_NEW, '1200000000000000777'], roleNames: [] },
    ];
    const mixedPlansPath = path.join(path.dirname(dbPath), 'mixed-plans.json');
    fs.writeFileSync(mixedPlansPath, JSON.stringify(mixedPlans, null, 2));
    const mixedDoctor = await runDoctorCli({
      ...env,
      PLANS_PATH: mixedPlansPath,
      ...(PG_URL ? {} : { DB_PATH: path.join(path.dirname(dbPath), 'mixed.sqlite') }),
    });
    assert.equal(mixedDoctor.code, 1, `doctor must fail on a dead id even when another id is valid:\n${mixedDoctor.out}`);
    assert.match(mixedDoctor.out, /no role with that id/);
  } finally {
    discord.extraRoles = [];
    discord.failRolesFetchOnce = false;
  }
});

// ═══ runner ═══════════════════════════════════════════════════════════════════

async function main() {
  await initTestDb();
  const [discordMock, stripeMock, coinbaseMock] = await Promise.all([
    startMock('discord', discordHandler),
    startMock('stripe', stripeHandler),
    startMock('coinbase', coinbaseHandler),
  ]);
  const mocks = { discord: discordMock, stripe: stripeMock, coinbase: coinbaseMock };

  // Phase 1: full configuration (Stripe + Coinbase) — the main scenario ladder.
  phase1Env = {
    ...baseEnv(mocks),
    COINBASE_API_KEY: 'cb_key_e2e',
    COINBASE_WEBHOOK_SECRET: COINBASE_SECRET,
    COINBASE_API_BASE: coinbaseMock.url,
  };
  const app = await spawnApp(phase1Env);
  appUrl = app.url;
  appLog = app.log;

  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}\n    ${String(err.stack ?? err).split('\n').join('\n    ')}`);
      break; // scenarios build on each other; later results would be noise
    }
  }

  // Phase 2: Stripe-only deploy — coinbase env absent, code dormant.
  if (!failed) {
    const soloDb = path.join(path.dirname(dbPath), 'solo.sqlite');
    const solo = await spawnApp({
      ...baseEnv(mocks),
      ...(PG_URL ? {} : { DB_PATH: soloDb }),
      ...(PG_URL ? { DATABASE_URL: PG_URL } : {}),
    });
    try {
      const { capabilities } = await (await fetch(`${solo.url}/api/plans`)).json();
      assert.deepEqual(capabilities, { stripe: true, crypto: false });
      const co = await fetch(`${solo.url}/api/checkout/coinbase`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planId: 'insider' }),
      });
      assert.equal(co.status, 501, 'coinbase checkout must be dormant without credentials');
      const wh = await deliverCoinbase(
        coinbaseEvent('charge:confirmed', { id: 'cb_solo', code: 'CBSOLO', discordId: U2, planId: 'insider' }),
        { base: solo.url },
      );
      assert.equal(wh.status, 501, 'coinbase webhook must be dormant without credentials');
      console.log('  ✓ stripe-only mode: crypto capability off, coinbase endpoints dormant (501)');
    } catch (err) {
      failed++;
      console.error(`  ✗ stripe-only mode\n    ${String(err.stack ?? err).split('\n').join('\n    ')}`);
    }
  }

  for (const child of children) child.kill('SIGTERM');
  await Promise.all(
    children.map(
      (child) =>
        new Promise((r) => {
          child.on('exit', r);
          setTimeout(() => {
            child.kill('SIGKILL');
            r();
          }, 3000).unref();
        }),
    ),
  );
  for (const { server } of [discordMock, stripeMock, coinbaseMock]) server.close();

  if (failed) {
    console.error(`\n${failed} scenario failed. App output tail:\n${(appLog ?? []).join('').split('\n').slice(-30).join('\n')}`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length + 1} scenarios green (storage: ${PG_URL ? 'postgres' : 'sqlite'}).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  for (const child of children) child.kill('SIGKILL');
  process.exit(1);
});
