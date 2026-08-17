#!/usr/bin/env node
// End-to-end suite: boots the real app (node src/server.js, same entry as
// `npm start`) against mock Stripe, Coinbase Commerce and Discord HTTP
// servers, then drives signed webhooks at it and asserts on the role calls
// the Discord mock actually received.
//
// Scenarios: purchase (incl. guilds.join), renewal, decline + grace + DM,
// recovery, cancellation, crypto confirmation (pending ignored, resolved
// honoured), duplicate delivery, forged/stale signatures, claim release on
// handler crash, 429 retry_after honouring, expiry sweep, lifetime surviving
// the sweep, and unmanaged roles staying untouched throughout.

import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

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

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock state ────────────────────────────────────────────────────────────────

const discord = {
  members: new Map(),           // uid -> Set(roleIds)
  joins: [],                    // { uid, roles, accessToken }
  roleCalls: [],                // { method, uid, roleId }
  dms: [],                      // { uid, content }
  rateLimit429Remaining: 0,     // next N role PUT/DELETEs answer 429 first
  oauthUsers: {
    code_u1: { id: U1, username: 'trader_one' },
    code_u3: { id: U3, username: 'trader_three' },
  },
};

const stripe = {
  checkoutSessions: [],         // parsed form bodies
  periodEnds: {},               // subscription id -> current_period_end (on ITEMS only)
  failSubFetchOnce: new Set(),  // subscription ids whose next GET answers 500
  subFetches: {},               // subscription id -> fetch count
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

  // role add/remove: PUT|DELETE /guilds/:g/members/:u/roles/:r
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

  // guilds.join: PUT /guilds/:g/members/:u
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

  // member fetch: GET /guilds/:g/members/:u
  if ((m = p.match(/^\/guilds\/([^/]+)\/members\/([^/]+)$/)) && req.method === 'GET') {
    const [, , uid] = m;
    if (!discord.members.has(uid)) {
      json(res, 404, { message: 'Unknown Member' });
      return;
    }
    json(res, 200, { user: { id: uid }, roles: [...discord.members.get(uid)] });
    return;
  }

  // DMs
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

  // OAuth
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
    const code = (req.headers.authorization ?? '').replace('Bearer tok_', '');
    const user = discord.oauthUsers[code];
    if (!user) {
      json(res, 401, { message: 'Unauthorized' });
      return;
    }
    json(res, 200, user);
    return;
  }
}

async function stripeHandler(req, res) {
  const url = new URL(req.url, 'http://mock');
  let m;
  if (url.pathname === '/v1/checkout/sessions' && req.method === 'POST') {
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

// ── signing + delivery helpers ────────────────────────────────────────────────

let appUrl;

function signStripe(payload, t = nowSec()) {
  const v1 = crypto.createHmac('sha256', STRIPE_SECRET).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

const signCoinbase = (payload) => crypto.createHmac('sha256', COINBASE_SECRET).update(payload).digest('hex');

async function deliverStripe(event, { header } = {}) {
  const payload = JSON.stringify(event);
  const res = await fetch(`${appUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': header ?? signStripe(payload) },
    body: payload,
  });
  return { status: res.status, body: await res.text() };
}

async function deliverCoinbase(event, { signature } = {}) {
  const payload = JSON.stringify({ id: crypto.randomUUID(), event });
  const res = await fetch(`${appUrl}/webhooks/coinbase`, {
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

// ── boot the real app ─────────────────────────────────────────────────────────

let child;
let appDb;
const appLog = [];
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-e2e-')), 'e2e.sqlite');

async function bootApp(env) {
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => appLog.push(d.toString()));
  child.stderr.on('data', (d) => appLog.push(d.toString()));
  const port = await waitFor('app to start listening', () => {
    const m = appLog.join('').match(/listening on http:\/\/localhost:(\d+)/);
    return m ? Number(m[1]) : null;
  });
  appUrl = `http://127.0.0.1:${port}`;
  appDb = new DatabaseSync(dbPath);
  appDb.exec('PRAGMA busy_timeout = 5000');
}

const subRow = (provider, ref) =>
  appDb.prepare('SELECT * FROM subscriptions WHERE provider = ? AND provider_ref = ?').get(provider, ref) ?? null;

// ── tiny sequential harness ───────────────────────────────────────────────────

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ═══ scenarios ════════════════════════════════════════════════════════════════

test('npm start entry prints the config banner', async () => {
  await waitFor('banner in stdout', () => appLog.join('').includes('TRADELEAKS PAYGATE'));
  assert.match(appLog.join(''), /webhooks\s+POST \/webhooks\/stripe\s+POST \/webhooks\/coinbase/);
});

test('storefront serves the Tradeleaks page and plans API', async () => {
  const page = await (await fetch(`${appUrl}/`)).text();
  assert.match(page, /Tradeleaks/i);
  const { plans } = await (await fetch(`${appUrl}/api/plans`)).json();
  assert.equal(plans.length, PLANS.length);
  assert.deepEqual(Object.keys(plans[0]).sort(), ['description', 'id', 'interval', 'lifetime', 'name', 'priceUsd']);
});

let u1Cookie;

test('OAuth login requests guilds.join and stores the access token', async () => {
  const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const authorize = new URL(login.headers.get('location'));
  assert.equal(authorize.searchParams.get('scope'), 'identify guilds.join');
  const state = authorize.searchParams.get('state');
  const stateCookie = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));

  const cb = await fetch(`${appUrl}/auth/callback?code=code_u1&state=${state}`, {
    redirect: 'manual',
    headers: { cookie: stateCookie.split(';')[0] },
  });
  assert.equal(cb.status, 302);
  u1Cookie = cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];

  const user = appDb.prepare('SELECT * FROM users WHERE discord_id = ?').get(U1);
  assert.equal(user.access_token, 'tok_code_u1');

  const me = await (await fetch(`${appUrl}/api/me`, { headers: { cookie: u1Cookie } })).json();
  assert.deepEqual({ loggedIn: me.loggedIn, username: me.username }, { loggedIn: true, username: 'trader_one' });
});

test('checkout endpoint creates a Stripe session with the buyer wired in', async () => {
  const res = await fetch(`${appUrl}/api/checkout/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u1Cookie },
    body: JSON.stringify({ planId: 'insider' }),
  });
  const { url } = await res.json();
  assert.match(url, /^https:\/\/stripe\.mock\/pay\//);
  const form = stripe.checkoutSessions.at(-1);
  assert.equal(form.mode, 'subscription');
  assert.equal(form.client_reference_id, U1);
  assert.equal(form['metadata[plan_id]'], 'insider');
  assert.equal(form['line_items[0][price]'], 'price_insider_month');
});

const SUB1_END = nowSec() + 31 * 86400;

test('purchase: webhook grants the role and joins the buyer into the guild', async () => {
  stripe.periodEnds.sub_1 = SUB1_END;
  assert.equal(discord.members.has(U1), false, 'U1 must start outside the guild');
  const { status, body } = await deliverStripe({
    id: 'evt_checkout_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', mode: 'subscription', subscription: 'sub_1', client_reference_id: U1, metadata: { plan_id: 'insider', discord_id: U1 } } },
  });
  assert.deepEqual({ status, body }, { status: 200, body: 'ok' });

  await waitFor('U1 joined with insider role', () => memberRoles(U1).has(R_INSIDER));
  const join = discord.joins.find((j) => j.uid === U1);
  assert.deepEqual(join.roles, [R_INSIDER]);
  assert.equal(join.accessToken, 'tok_code_u1');

  const row = subRow('stripe', 'sub_1');
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
  await deliverStripe({
    id: 'evt_invoice_1',
    type: 'invoice.paid',
    data: { object: { id: 'in_1', parent: { subscription_details: { subscription: 'sub_1' } } } },
  });
  await waitFor('expiry extended', () => subRow('stripe', 'sub_1').current_period_end === SUB1_RENEWED_END);
  assert.equal(subRow('stripe', 'sub_1').status, 'active');
  assert.ok(memberRoles(U1).has(R_INSIDER));
});

test('duplicate delivery: same event id is claimed once and not reprocessed', async () => {
  const fetchesBefore = stripe.subFetches.sub_1;
  const { status, body } = await deliverStripe({
    id: 'evt_invoice_1',
    type: 'invoice.paid',
    data: { object: { id: 'in_1', parent: { subscription_details: { subscription: 'sub_1' } } } },
  });
  assert.deepEqual({ status, body }, { status: 200, body: 'duplicate' });
  await sleep(300);
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

  const claims = appDb.prepare("SELECT event_id FROM webhook_events WHERE event_id LIKE '%forged%'").all();
  assert.deepEqual(claims, []);
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

test('handler crash releases the idempotency claim so the retry really retries', async () => {
  stripe.failSubFetchOnce.add('sub_3');
  const evt = {
    id: 'evt_checkout_3',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_3', mode: 'subscription', subscription: 'sub_3', client_reference_id: U3, metadata: { plan_id: 'pro', discord_id: U3 } } },
  };
  const first = await deliverStripe(evt);
  assert.equal(first.body, 'ok', 'ack still 200 — the failure happens after the ack');
  await waitFor('claim released after crash', () =>
    !appDb.prepare('SELECT 1 FROM webhook_events WHERE event_id = ?').get('stripe:evt_checkout_3'));
  assert.equal(subRow('stripe', 'sub_3'), null);

  const retry = await deliverStripe(evt); // the provider's retry of the SAME event id
  assert.equal(retry.body, 'ok', 'retry must be processed, not swallowed as duplicate');
  await waitFor('sub_3 granted on retry', () => subRow('stripe', 'sub_3')?.status === 'active');
});

test('buyer not in guild with no token yet gets roles at login via guilds.join', async () => {
  // U3 paid but never logged in: no access token, so reconcile could only wait.
  assert.equal(discord.members.has(U3), false);
  const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const authorize = new URL(login.headers.get('location'));
  const stateCookie = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  await fetch(`${appUrl}/auth/callback?code=code_u3&state=${authorize.searchParams.get('state')}`, {
    redirect: 'manual',
    headers: { cookie: stateCookie.split(';')[0] },
  });
  await waitFor('U3 joined with pro role at login', () => memberRoles(U3).has(R_PRO));
  assert.deepEqual(discord.joins.find((j) => j.uid === U3).roles, [R_PRO]);
});

test('declined renewal: DM + grace window, role kept while sweep runs', async () => {
  await deliverStripe({
    id: 'evt_invoice_fail_1',
    type: 'invoice.payment_failed',
    data: { object: { id: 'in_2', parent: { subscription_details: { subscription: 'sub_1' } } } },
  });
  const dm = await waitFor('failure DM to U1', () => discord.dms.find((d) => d.uid === U1));
  assert.match(dm.content, /payment .*didn't go through/i);
  assert.match(dm.content, /keep access until/i);
  const row = subRow('stripe', 'sub_1');
  assert.equal(row.status, 'past_due');
  assert.ok(row.grace_until > nowSec() + 71 * 3600, 'grace window ≈ GRACE_PERIOD_HOURS');
  await sleep(1300); // let at least one sweep tick pass
  assert.ok(memberRoles(U1).has(R_INSIDER), 'role must survive the sweep during grace');
});

test('grace expiry: sweep revokes the managed role, unmanaged role untouched', async () => {
  appDb.prepare("UPDATE subscriptions SET grace_until = ? WHERE provider_ref = 'sub_1'").run(nowSec() - 10);
  await waitFor('sweep pulls insider role', () => !memberRoles(U1).has(R_INSIDER));
  assert.equal(subRow('stripe', 'sub_1').status, 'expired');
  assert.ok(memberRoles(U1).has('ROLE_MOD_UNMANAGED'), 'sweep must never touch mod/colour/unmanaged roles');
});

test('late payment recovery: invoice.paid re-grants after expiry', async () => {
  stripe.periodEnds.sub_1 = nowSec() + 31 * 86400;
  await deliverStripe({
    id: 'evt_invoice_2',
    type: 'invoice.paid',
    data: { object: { id: 'in_3', parent: { subscription_details: { subscription: 'sub_1' } } } },
  });
  await waitFor('insider role restored', () => memberRoles(U1).has(R_INSIDER));
  assert.equal(subRow('stripe', 'sub_1').status, 'active');
});

test('cancellation: customer.subscription.deleted removes the role', async () => {
  await deliverStripe({
    id: 'evt_sub_deleted_1',
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_1', object: 'subscription', status: 'canceled' } },
  });
  await waitFor('insider role removed on cancel', () => !memberRoles(U1).has(R_INSIDER));
  assert.equal(subRow('stripe', 'sub_1').status, 'canceled');
  assert.ok(memberRoles(U1).has('ROLE_MOD_UNMANAGED'));
});

test('crypto: charge:pending never grants', async () => {
  discord.members.set(U2, new Set(['ROLE_COLOUR_UNMANAGED'])); // already in guild
  await deliverCoinbase(coinbaseEvent('charge:pending', { id: 'cb_pend_1', code: 'CBP1', discordId: U2, planId: 'insider' }));
  await sleep(400);
  assert.equal(memberRoles(U2).has(R_INSIDER), false, 'pending is a mempool sighting, not money');
  assert.equal(subRow('coinbase', 'CBP1'), null);
});

test('crypto: charge:confirmed grants a fixed term, honouring 429 retry_after', async () => {
  discord.rateLimit429Remaining = 1;
  await deliverCoinbase(coinbaseEvent('charge:confirmed', { id: 'cb_conf_1', code: 'CBC1', discordId: U2, planId: 'insider' }));
  await waitFor('U2 has insider role', () => memberRoles(U2).has(R_INSIDER));

  const calls = discord.roleCalls.filter((c) => c.uid === U2 && c.roleId === R_INSIDER && c.method === 'PUT');
  assert.equal(calls.length, 2, 'first call rate-limited, second after retry_after honoured');
  assert.equal(calls[0].rateLimited, true);

  const row = subRow('coinbase', 'CBC1');
  assert.equal(row.status, 'active');
  const expectedEnd = nowSec() + 31 * 86400;
  assert.ok(
    row.current_period_end !== null && Math.abs(row.current_period_end - expectedEnd) < 3600,
    'crypto cannot auto-renew: grant must be a fixed term of the plan duration, never NULL',
  );
});

test('crypto: charge:resolved also grants', async () => {
  await deliverCoinbase(coinbaseEvent('charge:resolved', { id: 'cb_res_1', code: 'CBR1', discordId: U2, planId: 'pro' }));
  await waitFor('U2 has pro role', () => memberRoles(U2).has(R_PRO));
  assert.equal(subRow('coinbase', 'CBR1').status, 'active');
});

test('expiry sweep: ended crypto term loses its role, other roles untouched', async () => {
  appDb.prepare("UPDATE subscriptions SET current_period_end = ? WHERE provider_ref = 'CBC1'").run(nowSec() - 10);
  await waitFor('sweep pulls U2 insider role', () => !memberRoles(U2).has(R_INSIDER));
  assert.equal(subRow('coinbase', 'CBC1').status, 'expired');
  assert.ok(memberRoles(U2).has(R_PRO), 'the still-active pro sub must keep its role');
  assert.ok(memberRoles(U2).has('ROLE_COLOUR_UNMANAGED'), 'unmanaged colour role must survive');
});

test('lifetime: NULL expiry survives the sweep', async () => {
  await deliverStripe({
    id: 'evt_checkout_life',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_life', mode: 'payment', payment_intent: 'pi_life_1', client_reference_id: U1, metadata: { plan_id: 'lifetime', discord_id: U1 } } },
  });
  await waitFor('U1 has lifetime role', () => memberRoles(U1).has(R_LIFETIME));
  const row = subRow('stripe', 'pi_life_1');
  assert.equal(row.current_period_end, null, 'NULL expiry means lifetime and nothing else');
  await sleep(1500); // several sweep ticks
  assert.ok(memberRoles(U1).has(R_LIFETIME), 'lifetime must survive the expiry sweep');
  assert.equal(subRow('stripe', 'pi_life_1').status, 'active');
});

test('coinbase checkout endpoint creates a charge with metadata', async () => {
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

// ═══ runner ═══════════════════════════════════════════════════════════════════

async function main() {
  const mocks = await Promise.all([
    startMock('discord', discordHandler),
    startMock('stripe', stripeHandler),
    startMock('coinbase', coinbaseHandler),
  ]);
  const [discordMock, stripeMock, coinbaseMock] = mocks;

  await bootApp({
    ENV_PATH: '/nonexistent/.env', // a developer's real .env must never leak in
    PLANS_PATH,
    PORT: '0',
    DB_PATH: dbPath,
    PUBLIC_BASE_URL: 'http://tradeleaks.e2e', // mocks never validate redirect URIs
    SESSION_SECRET: 'e2e-session-secret',
    DISCORD_CLIENT_ID: 'client_e2e',
    DISCORD_CLIENT_SECRET: 'client_secret_e2e',
    DISCORD_BOT_TOKEN: 'bot_token_e2e',
    DISCORD_GUILD_ID: GUILD,
    DISCORD_API_BASE: discordMock.url,
    STRIPE_SECRET_KEY: 'sk_test_e2e',
    STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
    STRIPE_API_BASE: stripeMock.url,
    COINBASE_API_KEY: 'cb_key_e2e',
    COINBASE_WEBHOOK_SECRET: COINBASE_SECRET,
    COINBASE_API_BASE: coinbaseMock.url,
    WEBHOOK_TOLERANCE_SECONDS: '300',
    GRACE_PERIOD_HOURS: '72',
    SWEEP_INTERVAL_SECONDS: '1',
  });

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

  child.kill('SIGTERM');
  await new Promise((r) => {
    child.on('exit', r);
    setTimeout(() => {
      child.kill('SIGKILL');
      r();
    }, 3000).unref();
  });
  for (const { server } of mocks) server.close();

  if (failed) {
    console.error(`\n${failed} scenario failed. App output tail:\n${appLog.join('').split('\n').slice(-30).join('\n')}`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} scenarios green.`);
}

main().catch((err) => {
  console.error(err);
  if (child) child.kill('SIGKILL');
  process.exit(1);
});
