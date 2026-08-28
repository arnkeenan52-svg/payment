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
const G2 = '900000000000000002';           // second tenant guild (VIP Signals)
const G3 = '900000000000000003';           // third guild — draft-store slug-guard scenario
const G4 = '900000000000000004';           // fourth guild — the multi-currency store, owned by nothing else
const R2_VIP = '2200000000000000101';      // grantable role in G2
const R2_BOT = '2200000000000000999';      // the bot's role in G2
const OWNER2_KEY = 'rk_test_owner2';       // second owner's own Stripe key — restricted, the kind Stripe recommends
const RESEND_KEY = 're_e2e_1234567890';
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
  channelPosts: [],             // { channelId, body } — sale pings + test messages
  rateLimit429Remaining: 0,     // next N role PUT/DELETEs answer 429 first
  botRolePosition: 50,          // doctor: set below the managed roles (10-12) to break hierarchy
  botInG2: false,               // the invite step flips this
  userGuilds: {},               // uid -> guilds visible to /users/@me/guilds
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
  charges: {},                  // charge id -> { payment_intent, invoice } for refund/dispute lookups
  invoices: {},                 // invoice id -> { subscription }
  subDeletes: [],               // DELETE /v1/subscriptions/:id calls (platform-plan switches/cancels)
  subUpdates: [],               // POST /v1/subscriptions/:id calls (buyer cancel-at-period-end)
  // Registered webhook endpoints; a matching one exists by default so the
  // doctor's endpoint check passes without registering.
  endpointUpdates: [],          // POST /v1/webhook_endpoints/:id — the in-place event upgrade
  // Deliberately subscribed to the PRE-REFUND event set: this is the shape
  // every seller who onboarded before those events were added still has, and
  // the doctor is expected to upgrade it in place rather than leave it.
  webhookEndpoints: [{ id: 'we_e2e_default', url: 'https://tradeleaks.e2e/webhooks/stripe', status: 'enabled', metadata: {},
    enabled_events: ['checkout.session.completed', 'invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted'] }],
};
const AUTO_ENDPOINT_SECRET = 'whsec_auto_e2e_secret_1';

const coinbase = { charges: [] };
// NOWPayments: the crypto rail. `payments` is mutable so a test can advance a
// payment through its statuses the way the real provider would.
const nowpayments = { created: [], payments: new Map(), n: 0 };
const NOW_KEY = 'np_key_e2e';
const NOW_IPN_SECRET = 'np_ipn_secret_e2e';
const resend = { emails: [] };

async function resendHandler(req, res) {
  const url = new URL(req.url, 'http://mock');
  if (url.pathname === '/emails' && req.method === 'POST') {
    if (req.headers.authorization !== `Bearer ${RESEND_KEY}`) {
      json(res, 401, { message: 'invalid key' });
      return;
    }
    resend.emails.push(JSON.parse(await readBody(req)));
    json(res, 200, { id: `email_${resend.emails.length}` });
    return;
  }
  // The account's verified domains — receiptFrom() self-provisions the
  // sender from here (the resend.dev test sender delivers to nobody real).
  if (url.pathname === '/domains' && req.method === 'GET') {
    json(res, 200, { data: [{ name: 'pending.e2e', status: 'pending' }, { name: 'tradeleaks.e2e', status: 'verified' }] });
    return;
  }
  json(res, 404, { message: 'not found' });
}

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

  if ((m = p.match(/^\/guilds\/([^/]+)\/members\/([^/]+)$/)) && req.method === 'GET' && m[2] === BOT_ID && m[1] === G2) {
    json(res, 200, { user: { id: BOT_ID }, roles: [R2_BOT] });
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

  // Text channels of a guild (the sale-notification picker) — G2 only.
  if ((m = p.match(/^\/guilds\/([^/]+)\/channels$/)) && req.method === 'GET') {
    if (m[1] !== G2) {
      json(res, 200, []);
      return;
    }
    json(res, 200, [
      { id: '800000000000000001', name: 'general', type: 0, position: 0 },
      { id: '800000000000000002', name: 'sales-feed', type: 0, position: 1 },
      { id: '800000000000000003', name: 'voice-lounge', type: 2, position: 2 },
    ]);
    return;
  }
  if ((m = p.match(/^\/channels\/(\d+)\/messages$/)) && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    discord.channelPosts.push({ channelId: m[1], body });
    json(res, 200, { id: `chmsg_${discord.channelPosts.length}` });
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
    if (m[1] === G2) {
      if (!discord.botInG2) {
        json(res, 404, { message: 'Unknown Guild' });
        return;
      }
      json(res, 200, { id: G2, name: 'VIP Signals', icon: null });
      return;
    }
    if (m[1] === GUILD) {
      json(res, 200, { id: m[1], name: 'Tradeleaks', icon: 'a_e2eicon' });
      return;
    }
    if (m[1] === G3) {
      json(res, 200, { id: G3, name: 'Trade Hub', icon: null });
      return;
    }
    if (m[1] === G4) {
      json(res, 200, { id: G4, name: 'Tokyo Desk', icon: null });
      return;
    }
    // Any other guild: the bot is not a member — exactly like real Discord.
    json(res, 404, { message: 'Unknown Guild' });
    return;
  }

  if (p === '/users/@me/guilds' && req.method === 'GET') {
    const auth = req.headers.authorization ?? '';
    const user = discord.oauthUsers[auth.replace('Bearer tok_', '')];
    if (!user) {
      json(res, 401, { message: 'Unauthorized' });
      return;
    }
    json(res, 200, discord.userGuilds[user.id] ?? []);
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
    if (m[1] === G2) {
      json(res, 200, [
        { id: G2, name: '@everyone', position: 0, permissions: '0', color: 0 },
        { id: R2_BOT, name: 'Dues', position: 40, permissions: String(1 << 28), color: 0, managed: true },
        { id: R2_VIP, name: 'VIP', position: 7, permissions: '0', color: 5793266 },
      ]);
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
    if (req.headers.authorization === 'Bearer sk_test_e2e') {
      json(res, 200, { id: 'acct_e2e', default_currency: 'usd' });
      return;
    }
    if (req.headers.authorization === `Bearer ${OWNER2_KEY}`) {
      // A real multi-currency seller: settles in USD by default and holds a
      // DKK and a JPY bank account too. This is what the currency picker is
      // read from — Dues never asks for these details, it reports them.
      json(res, 200, { id: 'acct_owner2', default_currency: 'usd' });
      return;
    }
    json(res, 401, { error: { message: 'Invalid API Key' } });
    return;
  }
  if ((m = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/external_accounts$/)) && req.method === 'GET') {
    const banks = m[1] === 'acct_owner2'
      ? [
          { object: 'bank_account', currency: 'usd', last4: '6789', bank_name: 'STRIPE TEST BANK', country: 'US', status: 'new', default_for_currency: true },
          { object: 'bank_account', currency: 'dkk', last4: '4242', bank_name: 'DANSKE TEST', country: 'DK', status: 'new', default_for_currency: true },
          { object: 'bank_account', currency: 'jpy', last4: '1010', bank_name: 'MIZUHO TEST', country: 'JP', status: 'new', default_for_currency: true },
        ]
      : [{ object: 'bank_account', currency: 'usd', last4: '0000', bank_name: 'STRIPE TEST BANK', country: 'US', status: 'new', default_for_currency: true }];
    json(res, 200, { object: 'list', data: banks, has_more: false });
    return;
  }
  if (url.pathname === '/v1/products' && req.method === 'POST') {
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
    const n = (stripe.products ??= []).length + 1;
    // Only register a default price when the caller inlined one (tenant
    // product creation does; platform-plan products create a price separately).
    let priceId = null;
    if (form['default_price_data[unit_amount]'] !== undefined) {
      priceId = `price_auto_${n}`;
      MOCK_PRICES[priceId] = {
        id: priceId,
        active: true,
        type: form['default_price_data[recurring][interval]'] ? 'recurring' : 'one_time',
        unit_amount: Number(form['default_price_data[unit_amount]']),
        currency: form['default_price_data[currency]'],
        ...(form['default_price_data[recurring][interval]'] ? { recurring: { interval: form['default_price_data[recurring][interval]'] } } : {}),
      };
    }
    const product = { id: `prod_auto_${n}`, name: form.name, images: form['images[0]'] ? [form['images[0]']] : [], default_price: priceId };
    stripe.products.push(product);
    json(res, 200, product);
    return;
  }
  if (url.pathname === '/v1/prices' && req.method === 'POST') {
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
    const id = `price_lk_${Object.keys(MOCK_PRICES).length + 1}`;
    // Stripe allows one active price per lookup key: transfer_lookup_key takes
    // it off whichever price holds it. Repricing a tier depends on that.
    if (form.lookup_key && form.transfer_lookup_key === 'true')
      for (const p of Object.values(MOCK_PRICES)) if (p.lookup_key === form.lookup_key) p.lookup_key = null;
    MOCK_PRICES[id] = {
      id,
      active: true,
      type: form['recurring[interval]'] ? 'recurring' : 'one_time',
      unit_amount: Number(form.unit_amount),
      currency: form.currency,
      product: form.product ?? null,
      lookup_key: form.lookup_key ?? null,
      ...(form['recurring[interval]'] ? { recurring: { interval: form['recurring[interval]'] } } : {}),
    };
    json(res, 200, MOCK_PRICES[id]);
    return;
  }
  if (url.pathname === '/v1/prices' && req.method === 'GET') {
    const type = url.searchParams.get('type');
    const lookup = url.searchParams.get('lookup_keys[0]');
    json(res, 200, {
      data: Object.values(MOCK_PRICES).filter(
        (p) => p.active && (!type || p.type === type) && (!lookup || p.lookup_key === lookup),
      ),
    });
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
  if (url.pathname === '/v1/webhook_endpoints' && req.method === 'GET') {
    json(res, 200, { data: stripe.webhookEndpoints });
    return;
  }
  if (url.pathname === '/v1/webhook_endpoints' && req.method === 'POST') {
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
    const ep = {
      id: `we_auto_${stripe.webhookEndpoints.length + 1}`,
      url: form.url,
      status: 'enabled',
      metadata: { managed_by: form['metadata[managed_by]'] ?? null },
    };
    stripe.webhookEndpoints.push(ep);
    json(res, 200, { ...ep, secret: AUTO_ENDPOINT_SECRET });
    return;
  }
  if ((m = url.pathname.match(/^\/v1\/webhook_endpoints\/([^/]+)$/)) && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    const events = [...form.entries()].filter(([k]) => k.startsWith('enabled_events[')).map(([, v]) => v);
    const ep = stripe.webhookEndpoints.find((e) => e.id === m[1]);
    if (ep) ep.enabled_events = events;
    stripe.endpointUpdates.push({ id: m[1], events });
    json(res, 200, { id: m[1], enabled_events: events });
    return;
  }
  if (url.pathname === '/v1/coupons' && req.method === 'POST') {
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
    const n = (stripe.coupons ??= []).length + 1;
    const coupon = { id: `coupon_${n}`, ...form };
    stripe.coupons.push(coupon);
    json(res, 200, coupon);
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
  // Charges and invoices, for the refund/dispute path: a charge names its
  // invoice, an invoice names its subscription. Seeded per test via
  // stripe.charges / stripe.invoices.
  if ((m = url.pathname.match(/^\/v1\/charges\/([^/]+)$/)) && req.method === 'GET') {
    const c = stripe.charges[m[1]];
    if (!c) return json(res, 404, { error: { message: 'No such charge' } });
    return json(res, 200, { id: m[1], object: 'charge', ...c });
  }
  if ((m = url.pathname.match(/^\/v1\/invoices\/([^/]+)$/)) && req.method === 'GET') {
    const inv = stripe.invoices[m[1]];
    if (!inv) return json(res, 404, { error: { message: 'No such invoice' } });
    return json(res, 200, { id: m[1], object: 'invoice', ...inv });
  }
  if ((m = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/)) && req.method === 'DELETE') {
    stripe.subDeletes.push(m[1]);
    json(res, 200, { id: m[1], object: 'subscription', status: 'canceled' });
    return;
  }
  if ((m = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/)) && req.method === 'POST') {
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
    stripe.subUpdates.push({ id: m[1], form });
    json(res, 200, {
      id: m[1],
      object: 'subscription',
      status: 'active',
      cancel_at_period_end: form.cancel_at_period_end === 'true',
      items: { data: [{ id: `si_${m[1]}`, current_period_end: stripe.periodEnds[m[1]] ?? nowSec() + 31 * 86400 }] },
    });
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

async function nowpaymentsHandler(req, res) {
  const url = new URL(req.url, 'http://mock');
  // Every call carries the merchant key; a request without it is the bug
  // where the key never reached the fetch at all.
  if (req.headers['x-api-key'] !== NOW_KEY) {
    json(res, 401, { message: 'invalid api key' });
    return;
  }
  if (url.pathname === '/merchant/coins' && req.method === 'GET') {
    // Deliberately UPPERCASE: tickers are compared lowercase everywhere, and
    // the provider is not consistent about which it sends.
    json(res, 200, { selectedCurrencies: ['BTC', 'SOL', 'USDTSOL', 'ETH'] });
    return;
  }
  if (url.pathname === '/min-amount' && req.method === 'GET') {
    json(res, 200, { min_amount: 0.004, currency_from: url.searchParams.get('currency_from') });
    return;
  }
  if (url.pathname === '/payment' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (Number(body.price_amount) < 1) {
      json(res, 400, { message: 'Amount is too small: minimal amount is 1' });
      return;
    }
    nowpayments.created.push(body);
    const id = `npid_${++nowpayments.n}`;
    const payment = {
      payment_id: id,
      payment_status: 'waiting',
      pay_address: `ADDR_${id}`,
      pay_amount: 0.5,
      pay_currency: body.pay_currency,
      price_amount: body.price_amount,
      price_currency: body.price_currency,
      order_id: body.order_id,
      actually_paid: 0,
      payin_extra_id: null,
      expiration_estimate_date: new Date(Date.now() + 20 * 60_000).toISOString(),
    };
    nowpayments.payments.set(id, payment);
    json(res, 201, payment);
    return;
  }
  const m = url.pathname.match(/^\/payment\/(.+)$/);
  if (m && req.method === 'GET') {
    const payment = nowpayments.payments.get(m[1]);
    if (!payment) {
      json(res, 404, { message: 'not found' });
      return;
    }
    json(res, 200, payment);
    return;
  }
  json(res, 404, { message: 'no route' });
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
    await tq('DROP TABLE IF EXISTS checkout_attempts');
    await tq('DROP TABLE IF EXISTS webhook_events');
    await tq('DROP TABLE IF EXISTS plan_overrides');
    await tq('DROP TABLE IF EXISTS managed_role_history');
    await tq('DROP TABLE IF EXISTS app_secrets');
    await tq('DROP TABLE IF EXISTS stores');
    await tq('DROP TABLE IF EXISTS store_plans');
    await tq('DROP TABLE IF EXISTS store_media');
    await tq('DROP TABLE IF EXISTS store_follows');
    await tq('DROP TABLE IF EXISTS platform_billing');
    await tq('DROP TABLE IF EXISTS discounts');
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

function signStripe(payload, t = nowSec(), secret = STRIPE_SECRET) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

const signCoinbase = (payload) => crypto.createHmac('sha256', COINBASE_SECRET).update(payload).digest('hex');

// NOWPayments signs a RE-SERIALISATION of the payload with its keys sorted,
// not the bytes on the wire. Implemented independently here on purpose: if the
// test reused the app's own sorter, a bug in it would sign and verify
// identically and the suite would prove nothing.
function npSorted(v) {
  if (Array.isArray(v)) return `[${v.map(npSorted).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${npSorted(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}
const signNow = (obj, secret = NOW_IPN_SECRET) =>
  crypto.createHmac('sha512', secret).update(npSorted(obj)).digest('hex');

async function deliverNow(payload, { signature, base = appUrl } = {}) {
  const res = await fetch(`${base}/webhooks/nowpayments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-nowpayments-sig': signature ?? signNow(payload),
    },
    // The bytes are deliberately NOT key-sorted: a verifier that hashed the
    // raw body instead of re-serialising would pass in a test that sent them
    // sorted, and fail in production where the provider does not.
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.text() };
}

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
  SESSION_SECRET: 'e2e-session-secret-0123456789-abcdef', // >= 32 chars: prod guard rejects weak secrets
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
  RESEND_API_KEY: RESEND_KEY,
  RESEND_API_BASE: mocks.resend.url,
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

test('storefront serves the tenant-generic checkout, plans API exposes capabilities', async () => {
  // "/" is the Dues platform landing. The built-in store is NOT special:
  // it lives at its brand slug like every other store. /store belongs to NO
  // store — it is a reserved word nobody can claim, the built-in one included.
  const home = await (await fetch(`${appUrl}/`)).text();
  assert.match(home, /Sell Discord access/);
  assert.match(home, /href="\/demo\?plan=vip-access"/); // the demo link opens the checkout directly
  assert.doesNotMatch(home, /href="\/store"/, 'no platform link may point at /store');
  for (const p of ['/terms', '/privacy']) {
    const res = await fetch(`${appUrl}${p}`);
    assert.equal(res.status, 200, `${p} must serve`);
  }
  assert.equal((await fetch(`${appUrl}/api/plans?store=store`)).status, 404, '"store" resolves to no store');
  const page = await (await fetch(`${appUrl}/tradeleaks`)).text();
  assert.match(page, /Confirm Order/);
  // The checkout shell is shared by every tenant store: the HEAD is
  // server-rendered per store (link unfurlers never run JS, so previews
  // need the name there), while the BODY stays tenant-generic — store
  // identity arrives via the API.
  assert.match(page, /property="og:title" content="Tradeleaks — Membership"/, 'link preview carries the store name');
  assert.doesNotMatch(page.slice(page.indexOf('<body')), /Tradeleaks/i, 'checkout BODY must be tenant-generic');
  // Search hygiene: real store pages self-canonicalize and shed the raw
  // template's noindex; the template alone keeps it so /store never indexes.
  assert.match(page, /rel="canonical" href="[^"]*\/tradeleaks"/, 'store page carries its canonical URL');
  assert.doesNotMatch(page, /name="robots" content="noindex"/, 'a real store page must be indexable');
  const bySlug = await (await fetch(`${appUrl}/api/plans?store=tradeleaks`)).json();
  assert.equal(bySlug.brand, 'Tradeleaks', 'the built-in store resolves at its brand slug');
  const { plans, capabilities, server } = await (await fetch(`${appUrl}/api/plans`)).json();
  assert.equal(plans.length, PLANS.length);
  assert.deepEqual(capabilities, { stripe: true, crypto: true, nowpayments: false }); // coinbase configured; the built-in store has no payout wallet
  assert.equal(
    server.iconUrl,
    `https://cdn.discordapp.com/icons/${GUILD}/a_e2eicon.gif?size=128`,
    'an animated guild icon must surface as the .gif CDN url',
  );
  assert.equal(server.name, 'Tradeleaks', 'server name must come from the live guild lookup, never a placeholder');
  // The internal diagnostics page is gone — tenants never see platform
  // plumbing. Its old path now falls through to the storefront shell like any
  // other unclaimed slug ('diagnostics' is reserved, so no store can claim it).
  const diagPage = await fetch(`${appUrl}/diagnostics`);
  const diagBody = await diagPage.text();
  assert.doesNotMatch(diagBody, /Setup diagnostics/, 'the diagnostics tool must be gone');
  assert.match(diagBody, /Confirm Order/, 'unclaimed slugs serve the storefront shell');
  // `currency` rides beside priceUsd on every plan: the number alone cannot
  // say whether 1500 is $1,500.00 or ¥1,500, and the storefront formats from it.
  assert.deepEqual(Object.keys(plans[0]).sort(), ['currency', 'description', 'descriptionHighlight', 'expiresAt', 'id', 'imageUrl', 'interval', 'lifetime', 'linkSlug', 'mediaKind', 'name', 'priceUsd', 'requiredRoleName', 'roleNames', 'variantOf']);
  assert.equal(plans[0].currency, 'usd', 'a store that never picked a currency prices in USD, exactly as before');
});

test('the iOS status-bar strip is on every themed page, with both of its colours', async () => {
  // Safari 26 stopped reading <meta name="theme-color">: it paints the status
  // bar from the background-color of a fixed element pinned to the viewport
  // edge. .ui-tint is that element. If the strip or either colour token goes
  // missing, the top of the phone screen silently stops following the
  // day/night toggle — a bug with no symptom anywhere else, hence this guard.
  for (const path of ['/', '/pricing']) {
    const html = await (await fetch(`${appUrl}${path}`)).text();
    assert.match(html, /<i class="ui-tint" aria-hidden="true"><\/i>/, `${path} must carry the tint strip`);
    assert.match(html, /--ui-tint:#131b2d/, `${path} must define the night tint`);
    assert.match(html, /--ui-tint:#70a3e6/, `${path} must define the day tint`);
    assert.match(
      html,
      /\.ui-tint\{[^}]*position:fixed[^}]*background-color:var\(--ui-tint\)/,
      `${path} tint must be a fixed strip that carries the colour`,
    );
  }
  // Buyer storefronts get it too — there --ui-tint falls back to --bg, which
  // the seller's own theme sets, so the strip follows their store colour.
  // They carry a SECOND strip at the bottom edge: that is the bar Safari was
  // painting platform-navy across the foot of a black storefront, on top of
  // the pay button. And viewport-fit=cover, without which
  // env(safe-area-inset-bottom) is zero and the page cannot reserve room for
  // that bar at all.
  const store = await (await fetch(`${appUrl}/tradeleaks`)).text();
  assert.match(store, /<i class="ui-tint" aria-hidden="true"><\/i>/, 'store pages must carry the tint strip');
  assert.match(store, /<i class="ui-tint-b" aria-hidden="true"><\/i>/, 'store pages must carry the bottom tint strip');
  assert.match(
    store,
    /<meta name="viewport" content="[^"]*viewport-fit=cover[^"]*"/,
    'a store page must opt into the safe area or its pay button sits under the browser bar',
  );
});

test('the free look: colours on every plan, wallpapers on a paid one', async () => {
  const theme = await import('../src/lib/theme.js');
  // The split has to mean the same thing in three places or it is not a split:
  // the server that strips a look, the picker that offers one, and the page
  // that sells the difference.
  assert.equal(theme.FREE_BG_PRESETS.length, 10, 'ten plain gradient grounds are free');
  for (const id of theme.FREE_BG_PRESETS) {
    assert.equal(theme.usesPaidLook({ bgPreset: id }), false, `${id} must be free`);
  }
  for (const id of ['starfield', 'aurora', 'clouds-day', 'mountains', 'rain']) {
    assert.equal(theme.usesPaidLook({ bgPreset: id }), true, `${id} is a wallpaper and must need a plan`);
  }
  assert.equal(theme.usesPaidLook({ bgUrl: 'https://example.com/a.gif' }), true, 'an import is a wallpaper');
  assert.equal(theme.usesPaidLook({ bg: '#0a0a0a', accent: '#ededed', radius: 4 }), false, 'colours alone are free');

  // Stripping keeps everything a free store is entitled to and nothing more.
  const stripped = theme.freeLook({ bg: '#123456', panel: '#222222', text: '#ffffff', accent: '#ff0000',
    pay: '#5865f2', radius: 8, font: 'serif', material: 'liquid', bgPreset: 'starfield', bgUrl: 'https://e.com/x.mp4' });
  assert.deepEqual(stripped, { bg: '#123456', panel: '#222222', text: '#ffffff', accent: '#ff0000',
    pay: '#5865f2', radius: 8, font: 'serif', material: 'liquid' }, 'colours survive, wallpapers do not');
  assert.deepEqual(theme.freeLook({ bg: '#000000', bgPreset: 'denim' }), { bg: '#000000', bgPreset: 'denim' },
    'a free gradient ground is left alone');

  // The picker's copy of the list must not drift from the server's.
  const dash = fs.readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  const catalogue = dash.match(/const BG_CATALOG = \[[\s\S]*?\n\];/)[0];
  const flagged = [...catalogue.matchAll(/\{ id: '([a-z0-9-]+)'[^}]*free: true/g)].map((m) => m[1]).sort();
  assert.deepEqual(flagged, [...theme.FREE_BG_PRESETS].sort(),
    'dashboard BG_CATALOG free flags must match FREE_BG_PRESETS');

  // And the price page must advertise the deal Free actually gets. Pinned to
  // the NUMBERS rather than a sentence: the old assertion matched one exact
  // marketing string, so it failed on a copy edit that changed nothing about
  // what a seller receives, while it would have sat green through the free
  // preset list doubling. What must not drift is the count.
  const pricing = fs.readFileSync(new URL('../public/pricing.html', import.meta.url), 'utf8');
  const total = Object.keys(theme.BG_PRESETS).length;
  const freeCount = theme.FREE_BG_PRESETS.length;
  // Split on the card openings rather than trying to match balanced divs — a
  // non-greedy </div></div> stops at the first NESTED pair, which silently
  // truncated every card before its .plan-look line.
  const cards = pricing.split(/<div class="plan(?: plan-pop)?">/).slice(1);
  const freeCard = cards.find((c) => /<b>Free<\/b>/.test(c));
  assert.ok(freeCard, 'the pricing page must still have a Free card');
  const freeLook = freeCard.match(/class="plan-look">([^<]*)</)?.[1] ?? '';
  assert.match(freeLook, new RegExp(`\\b${freeCount}\\b`), `Free must advertise its ${freeCount} backgrounds, not a different number`);
  assert.doesNotMatch(freeLook, new RegExp(`\\b${total}\\b`), 'Free must not be promised the full catalogue');
  const paid = cards.filter((c) => !/<b>Free<\/b>/.test(c)).map((c) => c.match(/class="plan-look">([^<]*)</)?.[1] ?? '');
  assert.ok(paid.length >= 2 && paid.every((t) => new RegExp(`\\b${total}\\b`).test(t)),
    `every paid plan must advertise all ${total} backgrounds`);
});

test('every page on the site is named in the footer — checked against the filesystem', async () => {
  // A page nothing links to is a page nobody finds. The old version of this
  // test listed the twelve comparisons by hand and accepted an INDEX link for
  // the four libraries, which meant twenty-seven real pages could sit behind a
  // parent index and this suite would call that "reachable". It also could not
  // notice a page being added.
  //
  // So it does not carry a list any more. It walks public/ for every .html
  // that a visitor can reach and asserts each one appears in the footer by its
  // own href. Adding a page and forgetting the footer now fails here rather
  // than quietly shipping an orphan.
  const home = await (await fetch(`${appUrl}/`)).text();
  const start = home.indexOf('<div class="footer-directory">');
  assert.ok(start > 0, 'the footer directory must exist on the homepage');
  const footer = home.slice(start, home.indexOf('footer-watermark', start));
  const linked = new Set([...footer.matchAll(/href="(\/[^"#?]*)"/g)].map((m) => m[1]));

  const { readdirSync, statSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const PUBLIC = new URL('../public/', import.meta.url).pathname;
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (name.endsWith('.html')) out.push(full);
    }
    return out;
  };
  // The app screens are not marketing pages and are linked from the product,
  // not the directory: a signed-out visitor has no use for /receipt.
  const APP = new Set(['/', '/dashboard', '/account', '/receipt', '/store']);
  const pages = walk(PUBLIC)
    .map((f) => {
      const rel = `/${relative(PUBLIC, f)}`;
      return rel.endsWith('/index.html') ? rel.slice(0, -'index.html'.length) : rel.slice(0, -'.html'.length);
    })
    .filter((p) => !APP.has(p));

  const missing = pages.filter((p) => !linked.has(p)).sort();
  assert.deepEqual(missing, [], `these pages exist but nothing in the footer links them: ${missing.join(', ')}`);
  assert.ok(pages.length >= 40, `expected the full page network, found ${pages.length}`);

  // And the reverse: a footer link to a page that does not exist is a 404 the
  // seller's visitors find before we do.
  const onDisk = new Set(pages);
  const dead = [...linked].filter((l) => !onDisk.has(l) && !l.startsWith('/api') && !APP.has(l)).sort();
  assert.deepEqual(dead, [], `footer links with no page behind them: ${dead.join(', ')}`);
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
let u6Cookie;

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
  assert.equal(authorize.searchParams.get('scope'), 'identify guilds guilds.join');
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
  assert.equal(cb.headers.get('location'), '/dashboard?plan=insider', 'a store-less sign-in lands on the dashboard, never on any store');
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
  assert.match(form.success_url, /\/receipt\?plan=insider&store=tradeleaks$/, 'buyers must land on the order receipt, store identified by its slug');
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

test('refunds and chargebacks take the role back', async () => {
  const U_REF = '509900000000000099';
  discord.members.set(U_REF, new Set(['ROLE_KEEP_UNMANAGED']));

  // A lifetime purchase. Its provider_ref is the payment_intent, which is
  // exactly what a charge.refunded event carries.
  assert.equal((await deliverStripe({
    id: 'evt_ref_buy',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_ref', mode: 'payment', payment_intent: 'pi_ref_1', client_reference_id: U_REF, metadata: { plan_id: 'lifetime', discord_id: U_REF } } },
  })).status, 200);
  assert.ok(memberRoles(U_REF).has(R_LIFETIME), 'bought and granted');

  // A PARTIAL refund is not a reversal of the sale. $4 back on a $50 purchase
  // leaves a member who is still a member.
  assert.equal((await deliverStripe({
    id: 'evt_ref_partial',
    type: 'charge.refunded',
    data: { object: { id: 'ch_ref_1', object: 'charge', payment_intent: 'pi_ref_1', amount: 5000, amount_refunded: 400, refunded: false } },
  })).status, 200);
  assert.ok(memberRoles(U_REF).has(R_LIFETIME), 'a partial refund must not revoke');
  assert.equal((await subRow('stripe', 'pi_ref_1')).status, 'active');

  // A FULL refund does.
  assert.equal((await deliverStripe({
    id: 'evt_ref_full',
    type: 'charge.refunded',
    data: { object: { id: 'ch_ref_1', object: 'charge', payment_intent: 'pi_ref_1', amount: 5000, amount_refunded: 5000, refunded: true } },
  })).status, 200);
  assert.ok(!memberRoles(U_REF).has(R_LIFETIME), 'a full refund takes the role back');
  assert.equal((await subRow('stripe', 'pi_ref_1')).status, 'canceled');
  assert.ok(memberRoles(U_REF).has('ROLE_KEEP_UNMANAGED'), 'and touches nothing it did not grant');

  // A SUBSCRIPTION payment is stored under the subscription id, not the
  // payment_intent — so the charge has to be walked back through its invoice.
  assert.equal((await deliverStripe({
    id: 'evt_ref_sub_buy',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_ref_sub', mode: 'subscription', subscription: 'sub_ref_1', client_reference_id: U_REF, metadata: { plan_id: 'insider', discord_id: U_REF } } },
  })).status, 200);
  assert.ok(memberRoles(U_REF).has(R_INSIDER), 'subscribed and granted');
  stripe.invoices.in_ref_1 = { subscription: 'sub_ref_1' };
  assert.equal((await deliverStripe({
    id: 'evt_ref_sub',
    type: 'charge.refunded',
    data: { object: { id: 'ch_ref_2', object: 'charge', payment_intent: 'pi_unknown_1', invoice: 'in_ref_1', amount: 1500, amount_refunded: 1500, refunded: true } },
  })).status, 200);
  assert.ok(!memberRoles(U_REF).has(R_INSIDER), 'a refunded subscription payment revokes via its invoice');
  assert.equal((await subRow('stripe', 'sub_ref_1')).status, 'canceled');

  // A CHARGEBACK. The object is a Dispute, which carries no invoice — the
  // charge has to be fetched to find one. The bank already took the money, so
  // waiting for the dispute to resolve would leave a non-payer holding a role.
  assert.equal((await deliverStripe({
    id: 'evt_dispute_buy',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_dis', mode: 'payment', payment_intent: 'pi_dis_1', client_reference_id: U_REF, metadata: { plan_id: 'lifetime', discord_id: U_REF } } },
  })).status, 200);
  assert.ok(memberRoles(U_REF).has(R_LIFETIME));
  stripe.charges.ch_dis_1 = { payment_intent: 'pi_dis_1', invoice: null };
  assert.equal((await deliverStripe({
    id: 'evt_dispute',
    type: 'charge.dispute.created',
    data: { object: { id: 'dp_1', object: 'dispute', charge: 'ch_dis_1', payment_intent: 'pi_dis_1', amount: 5000 } },
  })).status, 200);
  assert.ok(!memberRoles(U_REF).has(R_LIFETIME), 'a chargeback takes the role back');
  assert.equal((await subRow('stripe', 'pi_dis_1')).status, 'canceled');

  // A refund on a charge that has nothing to do with Dues is acknowledged and
  // ignored — a seller's Stripe account carries plenty of those.
  assert.equal((await deliverStripe({
    id: 'evt_ref_stranger',
    type: 'charge.refunded',
    data: { object: { id: 'ch_x', object: 'charge', payment_intent: 'pi_not_ours', amount: 100, amount_refunded: 100, refunded: true } },
  })).status, 200, 'an unrelated refund is a 200, not a retry loop');
});

test('the webhook endpoint Dues registers carries the refund events', async () => {
  // Registration is the half people forget: a handler for charge.refunded is
  // useless if Stripe was never told to send it. WEBHOOK_EVENTS is the single
  // list both the create call and the in-place upgrade below read from.
  const { WEBHOOK_EVENTS } = await import('../src/lib/stripe.js');
  for (const want of ['charge.refunded', 'charge.dispute.created', 'checkout.session.completed']) {
    assert.ok(WEBHOOK_EVENTS.includes(want), `every Dues endpoint must subscribe to ${want}`);
  }
  // And an endpoint registered BEFORE these events existed gets upgraded in
  // place rather than left behind — that is every seller already selling. The
  // mock's endpoint carries the pre-refund set; a doctor run must fix it.
  assert.equal((await fetch(`${appUrl}/api/setup-check?fresh=1`)).status, 200);
  const upgrade = stripe.endpointUpdates.find((u) => u.id === 'we_e2e_default');
  assert.ok(upgrade, 'the doctor upgraded the existing endpoint in place');
  assert.ok(upgrade.events.includes('charge.refunded'), 'subscribing it to refunds');
  assert.ok(upgrade.events.includes('charge.dispute.created'), 'and to chargebacks');
  assert.ok(upgrade.events.includes('checkout.session.completed'), 'without dropping what it already had');
  // Idempotent: a second run has nothing left to add.
  const before = stripe.endpointUpdates.length;
  assert.equal((await fetch(`${appUrl}/api/setup-check?fresh=1`)).status, 200);
  assert.equal(stripe.endpointUpdates.length, before, 'a complete endpoint is not written to again');
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
  assert.deepEqual(summary, { ok: true, receipts: true }, 'unauthenticated callers get the bare flags and nothing else');

  // The signed-in OWNER gets the full report (drives the setup checklist) …
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
  assert.deepEqual(nonOwner, { ok: true, receipts: true }, 'a non-owner session must not unlock the report');
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
      assert.deepEqual(summary, { ok: false, receipts: true }, 'public summary must report failing (drives the storefront banner)');
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

    // An owner's dashboard role pick supersedes the shipped placeholder id
    // entirely — the doctor must go fully green, with no stale-id complaint.
    const pick = await fetch(`${app2.url}/api/admin/plan-role`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: u1Cookie },
      body: JSON.stringify({ planId: 'named', roleId: R_NEW }),
    });
    assert.equal(pick.status, 200, await pick.text());
    const pickedDoctor = await runDoctorCli(env);
    assert.equal(pickedDoctor.code, 0, `doctor must pass after the pick:\n${pickedDoctor.out}`);
    assert.match(pickedDoctor.out, /picked in the dashboard/);
    assert.doesNotMatch(pickedDoctor.out, /buyers would be granted only/, 'a picked role must silence the stale placeholder id');
  } finally {
    discord.extraRoles = [];
    discord.failRolesFetchOnce = false;
  }
});

test('a stale stripePriceId resolves by amount; checkout works and the doctor warns', async () => {
  // The plan points at a dead price id, but the account holds an active
  // one-time USD price of the exact amount — checkout must find and use it.
  const ghostPlans = [
    {
      id: 'ghost',
      name: 'Ghost Tier',
      description: 'price resolved by amount',
      priceUsd: 299,
      interval: 'lifetime',
      lifetime: true,
      durationDays: null,
      stripePriceId: 'price_ghost_zzz', // no such price on the account
      roleIds: [R_NEW],
    },
  ];
  const ghostPlansPath = path.join(path.dirname(dbPath), 'ghost-plans.json');
  fs.writeFileSync(ghostPlansPath, JSON.stringify(ghostPlans, null, 2));
  const env = {
    ...phase1Env,
    PLANS_PATH: ghostPlansPath,
    ...(PG_URL ? {} : { DB_PATH: path.join(path.dirname(dbPath), 'ghost.sqlite') }),
  };
  const app3 = await spawnApp(env);

  const before = stripe.checkoutSessions.length;
  const res = await fetch(`${app3.url}/api/checkout/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u1Cookie }, // same SESSION_SECRET across apps
    body: JSON.stringify({ planId: 'ghost' }),
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(stripe.checkoutSessions.length, before + 1);
  assert.equal(
    stripe.checkoutSessions.at(-1)['line_items[0][price]'],
    'price_lifetime_once',
    'checkout must use the amount-matched price, not the dead configured id',
  );

  const doctor = await runDoctorCli(env);
  assert.match(doctor.out, /resolves by amount to price_lifetime_once/, `doctor must name the fallback price:\n${doctor.out}`);
  assert.equal(doctor.code, 0, `an amount-resolved price is a warning, not a failure:\n${doctor.out}`);
});

test('doctor auto-registers the missing webhook endpoint; deliveries verify with its stored secret', async () => {
  const saved = stripe.webhookEndpoints;
  stripe.webhookEndpoints = [];
  try {
    const doctor = await runDoctorCli(phase1Env);
    assert.equal(doctor.code, 0, `registration must leave the doctor green:\n${doctor.out}`);
    assert.match(doctor.out, /registered automatically/, `doctor must report the registration:\n${doctor.out}`);
    assert.equal(stripe.webhookEndpoints.length, 1, 'exactly one endpoint must be created');
    assert.equal(stripe.webhookEndpoints[0].url, 'https://tradeleaks.e2e/webhooks/stripe');
    assert.equal(stripe.webhookEndpoints[0].metadata.managed_by, 'ripley-paygate');

    // A delivery signed with the NEW endpoint's secret (not the env secret)
    // must verify via the database-stored secret and complete the grant.
    const U5 = '505500000000000005';
    discord.members.set(U5, new Set());
    const evt = {
      id: 'evt_auto_secret_1',
      type: 'checkout.session.completed',
      data: {
        object: { id: 'cs_auto_1', mode: 'payment', client_reference_id: U5, metadata: { plan_id: 'lifetime', discord_id: U5 } },
      },
    };
    const payload = JSON.stringify(evt);
    const viaStored = await deliverStripe(evt, { header: signStripe(payload, nowSec(), AUTO_ENDPOINT_SECRET) });
    assert.equal(viaStored.status, 200, viaStored.body);
    assert.ok(memberRoles(U5).has(R_LIFETIME), 'the stored-secret delivery must grant the role');

    // Deliveries signed with the env secret keep working alongside it.
    const evt2 = { ...evt, id: 'evt_auto_secret_2', data: { object: { ...evt.data.object, id: 'cs_auto_2' } } };
    const viaEnv = await deliverStripe(evt2);
    assert.equal(viaEnv.status, 200, viaEnv.body);
  } finally {
    stripe.webhookEndpoints = saved;
  }
});

test('platform: /api/me exposes account fields (isOwner, purchase dates, roles)', async () => {
  const anon = await (await fetch(`${appUrl}/api/me`)).json();
  assert.deepEqual(anon, { loggedIn: false });

  const me = await (await fetch(`${appUrl}/api/me`, { headers: { cookie: u1Cookie } })).json();
  assert.equal(me.isOwner, true, 'U1 is the store owner in these tests');
  assert.ok(me.subscriptions.length >= 1);
  for (const sub of me.subscriptions) {
    assert.equal(typeof sub.createdAt, 'number', 'every subscription carries its purchase date');
    assert.ok(Array.isArray(sub.roleNames));
    assert.ok(sub.priceUsd === null || typeof sub.priceUsd === 'number');
  }
});

test('platform: account re-sync heals a manually-removed role', async () => {
  assert.equal((await fetch(`${appUrl}/api/resync`, { method: 'POST' })).status, 401, 'anonymous cannot resync');

  // Fresh buyer U6: pay by webhook, log in, then lose the role "by accident".
  const U6 = '506600000000000006';
  discord.members.set(U6, new Set());
  discord.oauthUsers.code_u6 = { id: U6, username: 'trader_six' };
  const paid = await deliverStripe({
    id: 'evt_platform_u6',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_platform_u6', mode: 'payment', client_reference_id: U6, metadata: { plan_id: 'lifetime', discord_id: U6 } } },
  });
  assert.equal(paid.status, 200);
  assert.ok(memberRoles(U6).has(R_LIFETIME));

  const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const st = new URL(login.headers.get('location')).searchParams.get('state');
  const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  const cb = await fetch(`${appUrl}/auth/callback?code=code_u6&state=${st}`, {
    redirect: 'manual',
    headers: { cookie: sc.split(';')[0] },
  });
  u6Cookie = cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];

  discord.members.get(U6).delete(R_LIFETIME); // a mod (or Discord hiccup) removed it
  const resync = await fetch(`${appUrl}/api/resync`, { method: 'POST', headers: { cookie: u6Cookie } });
  const body = await resync.json();
  assert.equal(resync.status, 200, JSON.stringify(body));
  assert.ok(body.added.includes(R_LIFETIME), 'resync must report the healed role');
  assert.ok(memberRoles(U6).has(R_LIFETIME), 'the role must be back after resync');
});

test('checkout attempts are logged whether or not the buyer pays', async () => {
  // A buyer who reaches Stripe and walks away leaves no subscription, so this
  // row is the only evidence the owner ever gets that someone tried.
  const U11 = '511100000000000011';
  discord.members.set(U11, new Set());
  discord.oauthUsers.code_u11 = { id: U11, username: 'window_shopper' };
  const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const st = new URL(login.headers.get('location')).searchParams.get('state');
  const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  const cb = await fetch(`${appUrl}/auth/callback?code=code_u11&state=${st}`, {
    redirect: 'manual',
    headers: { cookie: sc.split(';')[0] },
  });
  const u11Cookie = cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];

  const owned = async () => (await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u1Cookie } })).json());
  const before = await owned();

  // Start two checkouts. Neither is paid yet.
  for (const n of [1, 2]) {
    const r = await fetch(`${appUrl}/api/checkout/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: u11Cookie },
      body: JSON.stringify({ planId: 'pro', store: 'tradeleaks' }),
    });
    assert.equal(r.status, 200, `checkout ${n} starts`);
  }
  const mid = await owned();
  const mine = mid.checkouts.filter((c) => c.discordId === U11);
  assert.equal(mine.length, 2, 'both attempts are recorded, not just the last');
  assert.equal(mine.every((c) => c.status === 'started'), true, 'unpaid attempts read as started');
  assert.equal(mid.checkoutTotals.started - before.checkoutTotals.started, 2);
  assert.equal(mid.checkoutTotals.completed, before.checkoutTotals.completed, 'nothing is counted as paid yet');
  assert.equal(mine[0].username, 'window_shopper', 'the owner sees who it was');
  assert.ok(mine[0].amountUsd > 0, 'and what they were about to pay');

  // Now pay one of them; only that session flips.
  const paidSession = stripe.checkoutSessions.at(-1)?.id ?? mine[0].sessionId;
  const target = mine.find((c) => c.sessionId === paidSession) ?? mine[0];
  assert.equal(
    (await deliverStripe({
      id: 'evt_u11_paid',
      type: 'checkout.session.completed',
      data: { object: { id: target.sessionId, mode: 'subscription', subscription: 'sub_u11', client_reference_id: U11, metadata: { plan_id: 'pro', discord_id: U11 } } },
    })).status,
    200,
  );
  const after = await owned();
  const mineAfter = after.checkouts.filter((c) => c.discordId === U11);
  assert.equal(mineAfter.filter((c) => c.status === 'completed').length, 1, 'exactly the paid session flips');
  assert.equal(mineAfter.filter((c) => c.status === 'started').length, 1, 'the abandoned one stays visible');
  assert.ok(mineAfter.find((c) => c.sessionId === target.sessionId).completedAt > 0, 'and carries when it completed');
  assert.equal(after.checkoutTotals.abandoned, after.checkoutTotals.started - after.checkoutTotals.completed);
  assert.ok(after.checkoutTotals.conversionPct !== null && after.checkoutTotals.conversionPct <= 100);

  // Stripe replays completed events on retry; the row must not move.
  const firstCompletedAt = mineAfter.find((c) => c.sessionId === target.sessionId).completedAt;
  await deliverStripe({
    id: 'evt_u11_paid_again',
    type: 'checkout.session.completed',
    data: { object: { id: target.sessionId, mode: 'subscription', subscription: 'sub_u11', client_reference_id: U11, metadata: { plan_id: 'pro', discord_id: U11 } } },
  });
  const replayed = (await owned()).checkouts.find((c) => c.sessionId === target.sessionId);
  assert.equal(replayed.completedAt, firstCompletedAt, 'a replayed webhook does not move completed_at');

  // Attempts carry other buyers' Discord IDs, so they ride the same gate as
  // the rest of this endpoint: owners only.
  assert.equal((await fetch(`${appUrl}/api/admin/payments`)).status, 401, 'anonymous cannot read checkout attempts');
  assert.equal(
    (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u11Cookie } })).status,
    403,
    'a buyer cannot read checkout attempts',
  );
});

test('buyer self-serve cancel: at period end, own subscriptions only', async () => {
  assert.equal((await fetch(`${appUrl}/api/subscription`, { method: 'POST' })).status, 401, 'anonymous cannot cancel');

  // A fresh buyer on a RECURRING plan, signed in.
  const U10 = '510100000000000010';
  discord.members.set(U10, new Set());
  discord.oauthUsers.code_u10 = { id: U10, username: 'monthly_member' };
  const subId = 'sub_cancel_me';
  stripe.periodEnds[subId] = nowSec() + 20 * 86400;
  assert.equal(
    (await deliverStripe({
      id: 'evt_u10_sub',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_u10', mode: 'subscription', subscription: subId, client_reference_id: U10, metadata: { plan_id: 'pro', discord_id: U10 } } },
    })).status,
    200,
  );
  assert.ok(memberRoles(U10).has(R_PRO), 'the recurring plan granted its role');

  const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const st = new URL(login.headers.get('location')).searchParams.get('state');
  const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  const cb = await fetch(`${appUrl}/auth/callback?code=code_u10&state=${st}`, {
    redirect: 'manual',
    headers: { cookie: sc.split(';')[0] },
  });
  const u10Cookie = cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];

  const cancelCall = (cookie, body) =>
    fetch(`${appUrl}/api/subscription`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ action: 'cancel', ...body }),
    });

  // /api/me hands the page the ref and marks the row cancellable.
  const before = await (await fetch(`${appUrl}/api/me`, { headers: { cookie: u10Cookie } })).json();
  const mine = before.subscriptions.find((x) => x.ref === subId);
  assert.ok(mine?.cancellable, 'a live recurring stripe sub is cancellable');
  assert.equal(mine.cancelsAt, null);

  // Ownership is decided from the session, never from the id in the request:
  // another signed-in buyer cannot cancel this one by knowing its ref.
  assert.equal((await cancelCall(u6Cookie, { subscriptionRef: subId })).status, 404, 'cannot cancel a stranger\'s membership');
  assert.deepEqual(stripe.subUpdates, [], 'a refused cancel never reaches Stripe');

  // U6 holds a LIFETIME row — nothing recurring to cancel.
  const u6Subs = await (await fetch(`${appUrl}/api/me`, { headers: { cookie: u6Cookie } })).json();
  assert.equal(u6Subs.subscriptions.every((x) => !x.cancellable), true, 'a lifetime purchase is not cancellable');
  const lifetimeRef = u6Subs.subscriptions[0].ref;
  assert.equal((await cancelCall(u6Cookie, { subscriptionRef: lifetimeRef })).status, 400, 'one-off purchases are refused with a reason');

  // The real thing.
  const res = await cancelCall(u10Cookie, { subscriptionRef: subId });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.cancelAtPeriodEnd, true);
  assert.equal(out.endsAt, stripe.periodEnds[subId], 'the buyer keeps the period they paid for');
  assert.deepEqual(
    stripe.subUpdates.map((u) => ({ id: u.id, cape: u.form.cancel_at_period_end })),
    [{ id: subId, cape: 'true' }],
    'Stripe is told to cancel at period end, not immediately',
  );
  assert.deepEqual(stripe.subDeletes, [], 'the subscription is never deleted outright');

  // Access survives the cancellation — the role lifts on Stripe's own
  // deletion webhook when the period actually runs out.
  assert.ok(memberRoles(U10).has(R_PRO), 'the role stays until the paid period ends');
  const after = await (await fetch(`${appUrl}/api/me`, { headers: { cookie: u10Cookie } })).json();
  const now = after.subscriptions.find((x) => x.ref === subId);
  assert.equal(now.entitled, true, 'still entitled after cancelling');
  assert.equal(now.cancelsAt, stripe.periodEnds[subId], 'the page can say when access ends');
  assert.equal(now.cancellable, false, 'the button does not come back');

  // Cancelling twice is a no-op, not a second Stripe call.
  const again = await cancelCall(u10Cookie, { subscriptionRef: subId });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).alreadyCancelled, true);
  assert.equal(stripe.subUpdates.length, 1, 'a second cancel does not hit Stripe again');

  // Stripe ends it for real → the role goes.
  assert.equal(
    (await deliverStripe({ id: 'evt_u10_gone', type: 'customer.subscription.deleted', data: { object: { id: subId } } })).status,
    200,
  );
  assert.ok(!memberRoles(U10).has(R_PRO), 'the role lifts when the subscription actually ends');
});

test('platform: payments dashboard endpoint is owner-gated and its totals add up', async () => {
  assert.equal((await fetch(`${appUrl}/api/admin/payments`)).status, 401, 'anonymous gets 401');
  assert.equal(
    (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u6Cookie } })).status,
    403,
    'a signed-in non-owner gets 403',
  );

  const data = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u1Cookie } })).json();
  assert.equal(data.totals.payments, data.payments.length);
  const sum = Math.round(data.payments.reduce((s, p) => s + p.amountUsd, 0) * 100) / 100;
  assert.equal(data.totals.allTimeUsd, sum, 'all-time revenue must equal the sum of the rows');
  const u6row = data.payments.find((p) => p.discordId === '506600000000000006');
  assert.deepEqual(
    { username: u6row.username, planId: u6row.planId, amountUsd: u6row.amountUsd, lifetime: u6row.lifetime },
    { username: 'trader_six', planId: 'lifetime', amountUsd: 299, lifetime: true },
  );
  assert.ok(data.totals.activeMembers >= 2);
  assert.ok(data.totals.lifetimeMembers >= 1);

  // The cron secret also opens it (for machine use), and rows are newest-first.
  const viaCron = await fetch(`${appUrl}/api/admin/payments`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  assert.equal(viaCron.status, 200);
  const times = data.payments.map((p) => p.createdAt);
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'payments must be newest-first');
});

test('multi-tenant: a second owner onboards their server end-to-end and sells through their own Stripe', async () => {
  // U7 owns "VIP Signals" (G2). Sign them in.
  const U7 = '507700000000000007';
  discord.oauthUsers.code_u7 = { id: U7, username: 'vip_owner' };
  discord.userGuilds[U7] = [
    { id: G2, name: 'VIP Signals', icon: null, owner: true, permissions: '0' },
    { id: GUILD, name: 'Tradeleaks', icon: null, owner: false, permissions: '0' }, // no admin — must not be settable
  ];
  const login7 = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const st7 = new URL(login7.headers.get('location')).searchParams.get('state');
  const sc7 = login7.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  const cb7 = await fetch(`${appUrl}/auth/callback?code=code_u7&state=${st7}`, {
    redirect: 'manual',
    headers: { cookie: sc7.split(';')[0] },
  });
  const u7Cookie = cb7.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];

  // Server picker: G2 shows up manageable without the bot; Tradeleaks does not.
  const picker = await (await fetch(`${appUrl}/api/my/guilds`, { headers: { cookie: u7Cookie } })).json();
  assert.equal(picker.guilds.length, 1, 'only servers the user can manage are listed');
  assert.deepEqual(
    { id: picker.guilds[0].id, botIn: picker.guilds[0].botIn, store: picker.guilds[0].store },
    { id: G2, botIn: false, store: null },
  );
  assert.match(picker.botInvite, /client_id=/);

  const onboard = (body) =>
    fetch(`${appUrl}/api/onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: u7Cookie },
      body: JSON.stringify(body),
    });

  // Without the bot in the guild the store step refuses with the invite hint.
  const noBot = await onboard({ step: 'store', guildId: G2, name: 'VIP Signals', stripeKey: OWNER2_KEY });
  assert.equal(noBot.status, 409);
  assert.equal((await noBot.json()).error, 'bot_missing');

  discord.botInG2 = true; // the owner invited the bot

  // A wrong key is rejected before anything is stored.
  const badKey = await onboard({ step: 'store', guildId: G2, name: 'VIP Signals', stripeKey: 'sk_test_wrong' });
  assert.equal(badKey.status, 400);

  const made = await onboard({ step: 'store', guildId: G2, name: 'VIP Signals', stripeKey: OWNER2_KEY });
  const store = (await made.json()).store;
  assert.equal(made.status, 200, JSON.stringify(store));
  assert.equal(store.slug, 'vip-signals');
  assert.equal(store.stripeAccount, 'acct_owner2');
  assert.equal(store.mode, 'test', 'an rk_test_ key is a test store');
  // Liveness must come from the _live_ segment, not from an sk_ prefix: reading
  // it off "sk_live_" filed every restricted live key as a test store.
  const liveKeyed = await onboard({ step: 'store', guildId: G2, name: 'VIP Signals', stripeKey: 'rk_live_owner2' });
  assert.equal(liveKeyed.status, 409, 'the guild already has a store');
  const { stripeKeyMode } = await import('../src/lib/stripe.js');
  assert.equal(stripeKeyMode('rk_live_owner2'), 'live', 'a restricted live key is a live store');
  assert.equal(stripeKeyMode('sk_live_x'), 'live');
  assert.equal(stripeKeyMode('rk_test_x'), 'test');
  const storeEndpoint = stripe.webhookEndpoints.find((e) => e.url.endsWith(`/webhooks/stripe/${store.id}`));
  assert.ok(storeEndpoint, 'a per-store webhook endpoint must be registered on the owner Stripe account');

  // Product creation lands on THEIR Stripe account with image + description.
  const prod = await onboard({
    step: 'product',
    storeId: store.id,
    name: 'VIP Access',
    description: 'Every signal, for life.',
    imageUrl: 'https://cdn.e2e.test/vip.png',
    priceUsd: 49.99,
    lifetime: true,
  });
  const plan = (await prod.json()).plan;
  assert.equal(prod.status, 200, JSON.stringify(plan));
  assert.match(plan.stripePriceId, /^price_auto_/);
  assert.deepEqual(stripe.products.at(-1).images, ['https://cdn.e2e.test/vip.png']);

  // Role picker: VIP usable, the bot's own managed role is not.
  const roles = await (await onboard({ step: 'roles', storeId: store.id })).json();
  assert.equal(roles.botTop.position, 40);
  assert.equal(roles.roles.find((r) => r.id === R2_VIP).usable, true);
  assert.equal(roles.roles.find((r) => r.id === R2_BOT).usable, false);

  const live = await onboard({ step: 'role', storeId: store.id, planKey: plan.planKey, roleId: R2_VIP });
  assert.equal(live.status, 200);
  assert.equal((await live.json()).store.status, 'live');

  // The slug storefront serves at the root (and the legacy /s/ path), and its
  // plans API shows the tenant catalog.
  assert.equal((await fetch(`${appUrl}/vip-signals`)).status, 200);
  assert.match(await (await fetch(`${appUrl}/vip-signals`)).text(), /Confirm Order/, 'root slug serves the storefront');
  assert.equal((await fetch(`${appUrl}/s/vip-signals`)).status, 200);
  const tenantPlans = await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json();
  assert.equal(tenantPlans.server.guildId, G2);
  assert.deepEqual(
    { id: tenantPlans.plans[0].id, imageUrl: tenantPlans.plans[0].imageUrl, roleNames: tenantPlans.plans[0].roleNames },
    { id: plan.planKey, imageUrl: 'https://cdn.e2e.test/vip.png', roleNames: ['@VIP'] },
  );

  // Buyer U8: signs in, checks out on the tenant store.
  const U8 = '508800000000000008';
  discord.oauthUsers.code_u8 = { id: U8, username: 'vip_buyer' };
  const login8 = await fetch(`${appUrl}/auth/login?plan=${plan.planKey}&store=vip-signals`, { redirect: 'manual' });
  const st8 = new URL(login8.headers.get('location')).searchParams.get('state');
  const sc8 = login8.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const cb8 = await fetch(`${appUrl}/auth/callback?code=code_u8&state=${st8}`, {
    redirect: 'manual',
    headers: { cookie: sc8 },
  });
  assert.equal(cb8.headers.get('location'), `/vip-signals?plan=${plan.planKey}`, 'buyer lands back on the tenant store');
  const u8Cookie = cb8.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];

  const co = await fetch(`${appUrl}/api/checkout/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u8Cookie },
    body: JSON.stringify({ planId: plan.planKey, store: 'vip-signals' }),
  });
  assert.equal(co.status, 200, await co.text());
  const sessionForm = stripe.checkoutSessions.at(-1);
  assert.equal(sessionForm['line_items[0][price]'], plan.stripePriceId);
  assert.equal(sessionForm['metadata[store_id]'], String(store.id));
  assert.match(sessionForm.success_url, /store=vip-signals/);

  // Stripe notifies the PER-STORE endpoint, signed with ITS secret; the env
  // secret must NOT be accepted there.
  const evt = {
    id: 'evt_tenant_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_tenant_1',
        mode: 'payment',
        client_reference_id: U8,
        customer_details: { email: 'buyer8@e2e.test' },
        metadata: { plan_id: plan.planKey, discord_id: U8, store_id: String(store.id) },
      },
    },
  };
  const payload = JSON.stringify(evt);
  const wrongSecret = await deliverStripe(evt, { path: `/webhooks/stripe/${store.id}` });
  assert.equal(wrongSecret.status, 400, 'the platform secret must not verify on a tenant endpoint');
  const delivered = await deliverStripe(evt, {
    path: `/webhooks/stripe/${store.id}`,
    header: signStripe(payload, nowSec(), AUTO_ENDPOINT_SECRET),
  });
  assert.equal(delivered.status, 200, delivered.body);
  assert.ok(memberRoles(U8).has(R2_VIP), 'the buyer must receive the tenant role (joined with it)');
  assert.ok(discord.joins.some((j) => j.uid === U8 && j.roles.includes(R2_VIP)), 'buyer was pulled into G2 with the role');

  // ── SECURITY: a per-store webhook endpoint is bound to its own store ───────
  // The owner controls the signing secret for THEIR endpoint. They must not be
  // able to (a) self-activate a platform plan for free, nor (b) redirect a
  // grant to a different store, by stamping metadata on an event they deliver.
  // (a) A platform_plan marker on a tenant endpoint is acked and dropped.
  const tierBefore = (await (await fetch(`${appUrl}/api/billing`, { headers: { cookie: u7Cookie } })).json()).current.tier;
  const forgePlatEvt = {
    id: 'evt_forge_platform_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_forge_plat', mode: 'subscription', subscription: 'sub_forge_plat', client_reference_id: '507700000000000007', metadata: { kind: 'platform_plan', tier: 'scale', owner_discord_id: '507700000000000007' } } },
  };
  const forgePlat = await deliverStripe(forgePlatEvt, {
    path: `/webhooks/stripe/${store.id}`,
    header: signStripe(JSON.stringify(forgePlatEvt), nowSec(), AUTO_ENDPOINT_SECRET),
  });
  assert.equal(forgePlat.status, 200, forgePlat.body);
  const tierAfter = (await (await fetch(`${appUrl}/api/billing`, { headers: { cookie: u7Cookie } })).json()).current.tier;
  assert.equal(tierAfter, tierBefore, 'a platform_plan event on a tenant endpoint must NOT activate a plan');

  // The emailed receipt went out via Resend with the right details, sent
  // from the account's VERIFIED domain — never the resend.dev test sender,
  // which delivers only to the Resend account owner.
  const receipt = resend.emails.at(-1);
  assert.ok(receipt, 'a receipt email must be sent');
  assert.deepEqual(receipt.to, ['buyer8@e2e.test']);
  assert.equal(receipt.from, 'Dues <receipts@tradeleaks.e2e>', 'the sender self-provisions from the verified domain');
  assert.match(receipt.subject, /VIP Signals/);
  assert.match(receipt.html, /VIP Access/);
  assert.match(receipt.html, /\$49\.99/);

  // The tenant owner's dashboard sees exactly their store — nothing else.
  const pay7 = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u7Cookie } })).json();
  assert.equal(pay7.totals.payments, 1);
  assert.deepEqual(
    { store: pay7.payments[0].storeSlug, amount: pay7.payments[0].amountUsd, buyer: pay7.payments[0].username },
    { store: 'vip-signals', amount: 49.99, buyer: 'vip_buyer' },
  );
  // The platform owner still sees everything, including the tenant sale.
  const pay1 = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u1Cookie } })).json();
  assert.ok(pay1.payments.some((p) => p.storeSlug === 'vip-signals'));
  assert.ok(pay1.payments.some((p) => p.storeSlug === 'tradeleaks'), 'the built-in store reports its brand slug');

  // ── member management: revoke / manual grant / resync ─────────────────────
  const member = (cookie, payload) =>
    fetch(`${appUrl}/api/admin/member`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ store: 'vip-signals', ...payload }),
    });

  assert.equal((await member(null, { action: 'revoke', discordId: U8 })).status, 401, 'anonymous cannot manage members');
  assert.equal((await member(u8Cookie, { action: 'revoke', discordId: U8 })).status, 403, 'a buyer cannot manage members');

  const revoked = await member(u7Cookie, { action: 'revoke', discordId: U8 });
  assert.equal(revoked.status, 200, await revoked.text());
  assert.ok(!memberRoles(U8).has(R2_VIP), 'revoking the membership must take the role away');

  // Manual grant: a member who never paid gets access by hand.
  const U9 = '509900000000000009';
  discord.members.set(U9, new Set());
  const granted = await member(u7Cookie, { action: 'grant', discordId: U9, planId: plan.planKey });
  assert.equal(granted.status, 200, await granted.text());
  assert.ok(memberRoles(U9).has(R2_VIP), 'a manual grant must deliver the role');

  // Resync heals a manually-removed role for the tenant store.
  discord.members.get(U9).delete(R2_VIP);
  const resynced = await member(u7Cookie, { action: 'resync', discordId: U9 });
  assert.equal(resynced.status, 200);
  assert.ok(memberRoles(U9).has(R2_VIP), 'resync must restore the role');
});

test('the built-in server can be onboarded as a managed store: products, discounts and custom link become dashboard-editable', async () => {
  // An admin of the BUILT-IN (env-configured) guild. Before this worked, the
  // virtual store claimed the guild and onboarding answered "already has a
  // store" — locking the platform's own server out of in-site products,
  // discounts and custom links forever.
  const U13 = '513300000000000013';
  discord.oauthUsers.code_u13 = { id: U13, username: 'tl_admin' };
  discord.userGuilds[U13] = [{ id: GUILD, name: 'Tradeleaks', icon: null, owner: true, permissions: '8' }];
  const login13 = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const st13 = new URL(login13.headers.get('location')).searchParams.get('state');
  const sc13 = login13.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  const cb13 = await fetch(`${appUrl}/auth/callback?code=code_u13&state=${st13}`, {
    redirect: 'manual',
    headers: { cookie: sc13.split(';')[0] },
  });
  const u13Cookie = cb13.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  const onboard13 = (payload) =>
    fetch(`${appUrl}/api/onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: u13Cookie },
      body: JSON.stringify(payload),
    });

  // The picker offers the built-in guild as onboardable — no store attached.
  const picker = await (await fetch(`${appUrl}/api/my/guilds`, { headers: { cookie: u13Cookie } })).json();
  const tl = picker.guilds.find((g) => g.id === GUILD);
  assert.ok(tl, 'the built-in guild must be listed');
  assert.equal(tl.store, null, 'the virtual store must not block onboarding the built-in guild');

  // Onboard it for real.
  const made = await onboard13({ step: 'store', guildId: GUILD, name: 'Tradeleaks Pro', stripeKey: OWNER2_KEY });
  const madeBody = await made.text();
  assert.equal(made.status, 200, madeBody);
  const { store } = JSON.parse(madeBody);
  assert.equal(store.slug, 'tradeleaks-pro');

  // A second attempt is refused — now a MANAGED store owns the guild.
  assert.equal((await onboard13({ step: 'store', guildId: GUILD, name: 'Again', stripeKey: OWNER2_KEY })).status, 409);

  // Product created in the dashboard, role attached, discount created.
  const prod = await onboard13({ step: 'product', storeId: store.id, name: 'Elite', priceUsd: 25, lifetime: true });
  const prodBody = await prod.text();
  assert.equal(prod.status, 200, prodBody);
  const { plan } = JSON.parse(prodBody);
  assert.equal((await onboard13({ step: 'role', storeId: store.id, planKey: plan.planKey, roleId: '1200000000000000101' })).status, 200);
  const disc = await fetch(`${appUrl}/api/admin/discounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u13Cookie },
    body: JSON.stringify({ store: 'tradeleaks-pro', action: 'create', code: 'TL10', kind: 'percent', amount: 10 }),
  });
  assert.equal(disc.status, 200, await disc.text());

  // The managed store serves on its own link with the dashboard-made catalog…
  const managedPlans = await (await fetch(`${appUrl}/api/plans?store=tradeleaks-pro`)).json();
  assert.equal(managedPlans.plans.length, 1);
  assert.equal(managedPlans.plans[0].id, plan.planKey);
  assert.equal((await fetch(`${appUrl}/tradeleaks-pro`)).status, 200);
  // …while the legacy built-in checkout keeps serving its env catalog untouched.
  const legacy = await (await fetch(`${appUrl}/api/plans`)).json();
  assert.equal(legacy.plans.length, PLANS.length, 'the built-in store must keep working');

  // One server, one store: the virtual twin leaves every dashboard list, and
  // the pre-multi-tenant payments are attributed to the managed store with
  // their original env-catalog pricing intact.
  const merged = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { authorization: `Bearer ${CRON_SECRET}` } })).json();
  assert.ok(!merged.stores.some((s) => s.isDefault), 'the virtual store must leave the list once its guild is managed');
  assert.equal(merged.stores.filter((s) => String(s.guildId) === GUILD).length, 1, 'exactly one store per guild');
  assert.ok(
    merged.payments.some((p) => p.storeSlug === 'tradeleaks-pro' && p.amountUsd > 0),
    'legacy payments ride the managed store, still priced from the env catalog',
  );
});

test("no store can claim the built-in store's link (reserved slug)", async () => {
  // An admin of a THIRD server tries to name their store exactly like the
  // brand so its slug collides with the built-in store's — a hijack of the
  // live checkout link and its Stripe account. Creation must be REJECTED, and
  // buyers at the link must always reach the working built-in catalog.
  const U14 = '514400000000000014';
  discord.oauthUsers.code_u14 = { id: U14, username: 'hub_admin' };
  discord.userGuilds[U14] = [{ id: G3, name: 'Trade Hub', icon: null, owner: true, permissions: '8' }];
  const login14 = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const st14 = new URL(login14.headers.get('location')).searchParams.get('state');
  const sc14 = login14.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  const cb14 = await fetch(`${appUrl}/auth/callback?code=code_u14&state=${st14}`, {
    redirect: 'manual',
    headers: { cookie: sc14.split(';')[0] },
  });
  const u14Cookie = cb14.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];

  // Onboarding with the exact brand name must NOT yield the brand slug — the
  // built-in slug is reserved, so the store gets a de-duplicated slug instead.
  const brandNamed = await fetch(`${appUrl}/api/onboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u14Cookie },
    body: JSON.stringify({ step: 'store', guildId: G3, name: 'Tradeleaks', stripeKey: OWNER2_KEY }),
  });
  const brandBody = await brandNamed.text();
  assert.equal(brandNamed.status, 200, brandBody);
  const store = JSON.parse(brandBody).store;
  assert.notEqual(store.slug, 'tradeleaks', 'a store named after the brand must not get the brand slug');

  // Buyers at the built-in link still get the working env catalog on the
  // platform's own account — never a hijacker's store.
  const atLink = await (await fetch(`${appUrl}/api/plans?store=tradeleaks`)).json();
  assert.equal(atLink.plans.length, PLANS.length, 'the built-in link keeps selling');
  assert.equal(atLink.store.status, 'live');

  // Renaming a store TO the built-in slug is refused outright (reserved).
  const rename = await fetch(`${appUrl}/api/admin/store`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u14Cookie },
    body: JSON.stringify({ store: store.slug, slug: 'tradeleaks' }),
  });
  assert.equal(rename.status, 409, `renaming to the built-in slug must be rejected: ${await rename.text()}`);

  // A rename to a normal, free slug succeeds — fixes a predictable slug for
  // the draft-management checks and the delete test below.
  const rehome = await fetch(`${appUrl}/api/admin/store`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u14Cookie },
    body: JSON.stringify({ store: store.slug, slug: 'trade-hub' }),
  });
  assert.equal(rehome.status, 200, `renaming to a free slug must work: ${await rehome.text()}`);

  // The draft stays fully manageable by its owner…
  const list = await fetch(`${appUrl}/api/onboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u14Cookie },
    body: JSON.stringify({ step: 'products', storeId: store.id }),
  });
  assert.equal(list.status, 200);

  // …and its uploaded photos serve at its own slug.
  const DRAFT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const withPhoto = await fetch(`${appUrl}/api/onboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u14Cookie },
    body: JSON.stringify({ step: 'product', storeId: store.id, name: 'Draft Pass', priceUsd: 9.99, lifetime: true, imageData: `data:image/png;base64,${DRAFT_PNG}` }),
  });
  const withPhotoBody = await withPhoto.text();
  assert.equal(withPhoto.status, 200, withPhotoBody);
  const draftPlan = JSON.parse(withPhotoBody).plan;
  const draftImg = await fetch(`${appUrl}/api/img?store=trade-hub&plan=${encodeURIComponent(draftPlan.planKey)}`);
  assert.equal(draftImg.status, 200, "the draft's uploaded photo must serve at its slug");
  assert.equal(Buffer.from(await draftImg.arrayBuffer()).toString('base64'), DRAFT_PNG, 'draft photo bytes intact');
});

test("the built-in guild's own store can hold the brand slug — dashboard links match the storefront", async () => {
  // The bug this pins down: a managed store for the BUILT-IN guild holding
  // the brand slug (legacy rows predate the reserved-slug guard) was
  // shadowed by the virtual env store on the buyer side. The dashboard
  // showed (and copy-linked) the DB catalog while /brand-slug kept selling
  // plans.json — so a freshly made product's link opened some OTHER
  // product's checkout. The owner's own twin must win; foreign stores must
  // still never claim the slug (previous scenario).
  const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const st = new URL(login.headers.get('location')).searchParams.get('state');
  const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  const cb = await fetch(`${appUrl}/auth/callback?code=code_u13&state=${st}`, {
    redirect: 'manual',
    headers: { cookie: sc.split(';')[0] },
  });
  const u13Cookie = cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  const call = (path, payload) =>
    fetch(`${appUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: u13Cookie },
      body: JSON.stringify(payload),
    });
  const plansAt = async (slug) => (await (await fetch(`${appUrl}/api/plans?store=${slug}`)).json()).plans;

  // The owner's store (created in the takeover scenario) may TAKE the brand
  // slug — same guild, so the guard's foreign-store rejection does not apply.
  const claim = await call('/api/admin/store', { store: 'tradeleaks-pro', slug: 'tradeleaks' });
  assert.equal(claim.status, 200, `the built-in guild's own store must be allowed the brand slug: ${await claim.text()}`);
  const owned = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u13Cookie } })).json();
  const mine = owned.stores.find((s) => s.slug === 'tradeleaks');
  assert.ok(mine, 'the renamed store is in the owner payload');

  // Buyers at the brand link now get the DASHBOARD-MANAGED catalog, not the
  // env one — what the owner sees is what buyers see.
  const before = await plansAt('tradeleaks');
  assert.notEqual(before.length, PLANS.length, 'the env catalog must step aside for the owner-managed one');

  // The user's exact reproduction: make a new product, take its copied link,
  // open it — the link must resolve to THAT product.
  const made = await call('/api/onboard', { step: 'product', storeId: mine.id, name: 'Insider Alpha', priceUsd: 17, lifetime: true });
  const madeBody = await made.text();
  assert.equal(made.status, 200, madeBody);
  const newKey = JSON.parse(madeBody).plan.planKey;
  const listed = await (await call('/api/onboard', { step: 'products', storeId: mine.id })).json();
  const copied = listed.products.find((p) => p.planKey === newKey).checkoutUrl;
  assert.match(copied, /\/tradeleaks\/insider-alpha$/, 'the dashboard copies the brand-slug product link');
  const after = await plansAt('tradeleaks');
  const alpha = after.find((p) => (p.linkSlug ?? p.id) === 'insider-alpha' || p.id === 'insider-alpha');
  assert.ok(alpha, 'the new product is in the storefront payload its link points at');
  assert.equal(alpha.priceUsd, 17, 'at its own price');
  const page = await fetch(`${appUrl}/tradeleaks/insider-alpha`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /\/tradeleaks\/insider-alpha/, 'the product page canonicalizes to the product link');

  // Safety net: with every product switched off, the brand link falls back
  // to the env catalog instead of an empty dead store.
  for (const p of after) assert.equal((await call('/api/onboard', { step: 'product-update', storeId: mine.id, planKey: p.id, active: false })).status, 200);
  assert.equal((await plansAt('tradeleaks')).length, PLANS.length, 'an empty twin leaves the env checkout serving');
  for (const p of after) assert.equal((await call('/api/onboard', { step: 'product-update', storeId: mine.id, planKey: p.id, active: true })).status, 200);

  // Restore the world for the scenarios below: back to its own slug, and the
  // brand link back on the env catalog.
  assert.equal((await call('/api/admin/store', { store: 'tradeleaks', slug: 'tradeleaks-pro' })).status, 200);
  assert.equal((await plansAt('tradeleaks')).length, PLANS.length, 'the brand link serves the env catalog again');
});

test('store delete: payment history refuses; a draft deletes, freeing its link and guild', async () => {
  const loginAs = async (code) => {
    const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
    const st = new URL(login.headers.get('location')).searchParams.get('state');
    const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
    const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${st}`, {
      redirect: 'manual',
      headers: { cookie: sc.split(';')[0] },
    });
    return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  };
  const u14Cookie = await loginAs('code_u14');
  const u7Cookie = await loginAs('code_u7');
  const del = (cookie, slug) =>
    fetch(`${appUrl}/api/admin/store`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ store: slug, action: 'delete' }),
    });

  // Only the store's owner may delete it.
  assert.equal((await del(u7Cookie, 'trade-hub')).status, 403, "another owner must not delete the draft");
  // A store with real payments is not deletable — the history stays.
  const refused = await del(u7Cookie, 'vip-signals');
  assert.equal(refused.status, 409, await refused.text());

  // The empty draft deletes cleanly…
  const ok = await del(u14Cookie, 'trade-hub');
  assert.equal(ok.status, 200, await ok.text());
  // …the built-in store's own link is unaffected throughout…
  const back = await (await fetch(`${appUrl}/api/plans?store=tradeleaks`)).json();
  assert.equal(back.plans.length, PLANS.length, 'the built-in store keeps its link');
  // …and the guild is free to onboard from scratch (the reset path).
  const again = await fetch(`${appUrl}/api/onboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u14Cookie },
    body: JSON.stringify({ step: 'store', guildId: G3, name: 'Trade Hub Prime', stripeKey: OWNER2_KEY }),
  });
  const againBody = await again.text();
  assert.equal(again.status, 200, againBody);
  assert.equal(JSON.parse(againBody).store.slug, 'trade-hub-prime');
  // Leave the world as this scenario found it (minus the hijacking draft).
  assert.equal((await del(u14Cookie, 'trade-hub-prime')).status, 200);
});

test('platform admin endpoint: owner-only bird\'s-eye of users, stores and totals', async () => {
  // Strictly the PLATFORM owner. A store owner sees their own stores on
  // /api/admin/payments, but this endpoint spans every tenant — so a seller
  // is refused exactly like a buyer.
  assert.equal((await fetch(`${appUrl}/api/admin/platform`)).status, 401, 'anonymous gets 401');
  assert.equal(
    (await fetch(`${appUrl}/api/admin/platform`, { headers: { cookie: u6Cookie } })).status,
    403,
    'a buyer gets 403',
  );
  const login7 = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const st7 = new URL(login7.headers.get('location')).searchParams.get('state');
  const sc7 = login7.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  const cb7x = await fetch(`${appUrl}/auth/callback?code=code_u7&state=${st7}`, {
    redirect: 'manual',
    headers: { cookie: sc7.split(';')[0] },
  });
  const sellerCookie = cb7x.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  assert.equal(
    (await fetch(`${appUrl}/api/admin/platform`, { headers: { cookie: sellerCookie } })).status,
    403,
    'a STORE owner still gets 403 — this page is platform-owner only',
  );

  const res = await fetch(`${appUrl}/api/admin/platform`, { headers: { cookie: u1Cookie } });
  assert.equal(res.status, 200);
  const body = await res.text();
  // The users table carries OAuth tokens; none of that may ever leave the DB
  // layer on this path.
  assert.ok(!body.includes('access_token') && !body.includes('refresh_token'), 'no token material in the payload');
  assert.ok(!body.includes('sk_test_') && !body.includes('rk_test_'), 'no Stripe key material in the payload');
  const d = JSON.parse(body);

  // Internal consistency, not magic numbers — the suite creates users and
  // stores above this point and the exact counts shift as tests evolve.
  assert.equal(d.totals.stores, d.stores.length);
  assert.equal(d.totals.storesLive + d.totals.storesDraft, d.totals.stores);
  assert.ok(d.totals.users >= 5, 'every signed-in test account is listed');
  assert.equal(d.totals.users, d.users.length);
  assert.ok(d.totals.checkoutsStarted >= d.totals.checkoutsCompleted);
  assert.ok(d.totals.allTimeUsd > 0, 'all-time volume reflects the payments made above');
  assert.ok(d.totals.activeMembers > 0);

  // Every tenant's store is visible, with its owner attributed.
  const vip = d.stores.find((st) => st.slug === 'vip-signals');
  assert.ok(vip, 'the second owner\'s store is listed');
  assert.equal(vip.ownerDiscordId, '507700000000000007');
  assert.ok(vip.revenueUsd > 0, 'tenant revenue is priced from its own catalog');
  // By this point the built-in guild has been taken over by a managed store
  // ('Tradeleaks Pro'), so assert by guild rather than by slug.
  assert.ok(d.stores.some((st) => String(st.guildId) === '900000000000000001'), 'the built-in guild\'s store is listed too');

  // Users carry role flags the owner can filter on.
  const seller = d.users.find((u) => u.discordId === '507700000000000007');
  assert.ok(seller?.seller, 'a store owner is flagged as a seller');
  const buyer = d.users.find((u) => u.discordId === '506600000000000006');
  assert.ok(buyer && buyer.memberships >= 1 && buyer.spentUsd > 0, 'a buyer shows purchases and spend');
  assert.ok(d.users.every((u) => typeof u.joinedAt === 'number' && typeof u.lastSeenAt === 'number'));
});

test('SEO reach pages serve: /vs, /tools, /use-cases, sitemap and robots', async () => {
  const get = async (p) => {
    const r = await fetch(`${appUrl}${p}`);
    return { status: r.status, body: await r.text() };
  };
  const vs = await get('/vs/whop');
  assert.equal(vs.status, 200);
  assert.match(vs.body, /Dues vs Whop/);
  assert.match(vs.body, /rel="canonical" href="https:\/\/dues\.gg\/vs\/whop"/);
  const vsIdx = await get('/vs');
  assert.equal(vsIdx.status, 200);
  assert.match(vsIdx.body, /Compare Discord Monetization Platforms/);
  const tool = await get('/tools/discord-fee-calculator');
  assert.equal(tool.status, 200);
  assert.match(tool.body, /Discord Monetization Fee Calculator/);
  const uc = await get('/use-cases/trading');
  assert.equal(uc.status, 200);
  assert.match(uc.body, /Trading Discord/);
  const sm = await get('/sitemap.xml');
  assert.equal(sm.status, 200);
  assert.match(sm.body, /\/vs\/whop<\/loc>/);
  const rb = await get('/robots.txt');
  assert.equal(rb.status, 200);
  assert.match(rb.body, /Sitemap: https:\/\/dues\.gg\/sitemap\.xml/);
  assert.match(rb.body, /User-agent: GPTBot/, 'AI crawlers are explicitly welcomed');
  const sub = await get('/vs/subscord');
  assert.equal(sub.status, 200);
  assert.match(sub.body, /Dues vs Subscord/);
  assert.match(sub.body, /plan-dependent/i, 'Subscord claims stay hedged');
  const guide = await get('/guides/how-to-monetize-a-discord-server');
  assert.equal(guide.status, 200);
  assert.match(guide.body, /How to Monetize a Discord Server/);
  assert.match(guide.body, /application\/ld\+json/, 'guides carry structured data');
  const alt = await get('/alternatives/subscord-alternatives');
  assert.equal(alt.status, 200);
  assert.match(alt.body, /Subscord Alternatives/i);
  assert.match(alt.body, /our product/, 'the Dues entry is disclosed as ours');
  const llms = await get('/llms.txt');
  assert.equal(llms.status, 200);
  assert.match(llms.body, /0% of sales/);
  assert.match(sm.body, /\/guides\/how-to-monetize-a-discord-server<\/loc>/);
  assert.match(sm.body, /\/alternatives\/subscord-alternatives<\/loc>/);
  // Reach paths resolve to pages, never to a store.
  assert.equal((await fetch(`${appUrl}/api/plans?store=vs`)).status, 404);
  assert.equal((await fetch(`${appUrl}/api/plans?store=guides`)).status, 404);
  assert.equal((await fetch(`${appUrl}/api/plans?store=alternatives`)).status, 404);

  // The homepage used to carry a byte-identical copy of the generated footer;
  // the redesigned landing owns its own footer markup, so the anti-drift
  // guarantee is now LINK PARITY: every comparison page the generator links
  // must be linked from the homepage too (gen-seo-pages enforces the same at
  // build time). The original bug this guards: /vs/subscord shipped and was
  // linked everywhere except the one page visitors actually land on.
  const home = await get('/');
  const genFooter = sub.body.slice(sub.body.indexOf('<footer class="site-footer'), sub.body.indexOf('</footer>'));
  const vsLinks = [...genFooter.matchAll(/href="(\/vs\/[a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(vsLinks.length >= 5, 'the generated footer lists the comparison pages');
  for (const href of vsLinks) {
    assert.ok(home.body.includes(`href="${href}"`), `the homepage links ${href}`);
  }
  assert.match(home.body, /href="\/vs\/subscord"/, 'the homepage links the Subscord comparison');


  // The homepage's "Invite Dues" button: a stable hop to Discord's
  // authorize screen, bot scope — same as the wizard.
  const inv = await fetch(`${appUrl}/api/invite`, { redirect: 'manual' });
  assert.equal(inv.status, 302);
  const invUrl = new URL(inv.headers.get('location'));
  assert.equal(invUrl.origin, 'https://discord.com');
  assert.equal(invUrl.searchParams.get('scope'), 'bot');
  assert.ok(invUrl.searchParams.get('client_id'), 'client id rides the invite link');
  // Exact permission set, so it can't silently drift again: Manage Roles +
  // Manage Server + Create Instant Invite (guilds.join needs it) +
  // View/Send/Embed for sale notifications. Never Administrator (bit 3).
  const perms = BigInt(invUrl.searchParams.get('permissions'));
  assert.equal(perms, 268435456n + 32n + 1n + 1024n + 2048n + 16384n);
  assert.equal(perms & 8n, 0n, 'the invite never asks for Administrator');
  const homeHtml = await (await fetch(`${appUrl}/`)).text();
  assert.match(homeHtml, /href="\/api\/invite"/, 'the hero links the invite');
  assert.match(homeHtml, /Invite Dues/);
});

test('platform billing: Free gates at 10 members, paid tiers unlock, switch cancels the old sub, cancel re-gates', async () => {
  const U9_BILLING = '509900000000000009'; // the manually-granted member from the previous scenario
  const loginAs = async (code) => {
    const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
    const st = new URL(login.headers.get('location')).searchParams.get('state');
    const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
    const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${st}`, {
      redirect: 'manual',
      headers: { cookie: sc.split(';')[0] },
    });
    return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  };
  const u7Cookie = await loginAs('code_u7');
  const billing = (cookie, body) =>
    body
      ? fetch(`${appUrl}/api/billing`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })
      : fetch(`${appUrl}/api/billing`, { headers: { cookie } });
  const billingState = async (cookie) => (await billing(cookie)).json();

  // The platform owner is exempt; the tenant owner starts on Free with the
  // one member the previous scenario granted (U9) — the default store's many
  // members must NOT count against them.
  assert.equal((await billingState(u1Cookie)).exempt, true, 'the platform owner never pays');
  const b0 = await billingState(u7Cookie);
  assert.deepEqual(
    { tier: b0.current.tier, members: b0.usage.members, limit: b0.usage.limit, exempt: b0.exempt },
    { tier: 'free', members: 1, limit: 10, exempt: false },
  );

  // Fill the Free limit: 9 manual grants take vip-signals to exactly 10 live.
  const planId = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans[0].id;
  for (let i = 0; i < 9; i++) {
    const uid = `5210000000000000${String(10 + i)}`;
    discord.members.set(uid, new Set());
    const granted = await fetch(`${appUrl}/api/admin/member`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: u7Cookie },
      body: JSON.stringify({ store: 'vip-signals', action: 'grant', discordId: uid, planId }),
    });
    assert.equal(granted.status, 200, await granted.text());
  }
  assert.equal((await billingState(u7Cookie)).usage.members, 10);

  // A brand-new buyer is refused at checkout; the platform's own store is not.
  const U10 = '511000000000000010';
  discord.oauthUsers.code_u10 = { id: U10, username: 'late_buyer' };
  const u10Cookie = await loginAs('code_u10');
  const tryCheckout = (store, id = planId) =>
    fetch(`${appUrl}/api/checkout/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: u10Cookie },
      body: JSON.stringify({ planId: id, store }),
    });
  const blocked = await tryCheckout('vip-signals');
  const blockedBody = await blocked.text();
  assert.equal(blocked.status, 409, blockedBody);
  assert.match(JSON.parse(blockedBody).error, /member limit/);
  assert.equal((await tryCheckout('tradeleaks', PLANS[0].id)).status, 200, 'the platform owner store is never gated');
  // An EXISTING member is never hostage to the owner's plan: U9 re-checks out fine.
  discord.oauthUsers.code_u9b = { id: U9_BILLING, username: 'manual_member' };
  const u9Cookie = await loginAs('code_u9b');
  const renewal = await fetch(`${appUrl}/api/checkout/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u9Cookie },
    body: JSON.stringify({ planId, store: 'vip-signals' }),
  });
  assert.equal(renewal.status, 200, 'existing members can always re-purchase');

  // Upgrade to Starter: checkout runs on RIPLEY's account with a
  // self-provisioned recurring price (lookup_key, $5.99/mo).
  const up = await billing(u7Cookie, { action: 'checkout', tier: 'starter' });
  assert.equal(up.status, 200, await up.text());
  const upForm = stripe.checkoutSessions.at(-1);
  const starterPrice = Object.values(MOCK_PRICES).find((p) => p.lookup_key === 'ripley_platform_starter');
  assert.ok(starterPrice, 'the Starter price is created with its lookup key');
  assert.deepEqual(
    { mode: upForm.mode, price: upForm['line_items[0][price]'], kind: upForm['metadata[kind]'], amount: starterPrice.unit_amount },
    { mode: 'subscription', price: starterPrice.id, kind: 'platform_plan', amount: 1499 },
  );

  // Repricing a tier has to reprice Stripe too. The price id is cached in
  // app_secrets and was previously reused forever, so editing TIERS changed
  // every number on the site while checkout quietly charged the old amount.
  // Simulate that by ageing the cached price out from under the app.
  starterPrice.unit_amount = 599;
  const reprice = await billing(u7Cookie, { action: 'checkout', tier: 'starter' });
  assert.equal(reprice.status, 200, await reprice.text());
  const charged = MOCK_PRICES[stripe.checkoutSessions.at(-1)['line_items[0][price]']];
  assert.equal(charged.unit_amount, 1499, 'checkout charges the advertised price, not the stale cached one');
  assert.notEqual(charged.id, starterPrice.id, 'a fresh price is minted rather than the stale one reused');
  assert.equal(charged.lookup_key, 'ripley_platform_starter');
  assert.equal(starterPrice.lookup_key, null, 'the lookup key moved to the new price');
  assert.equal(charged.product, starterPrice.product ?? charged.product, 'the tier keeps one product across reprices');

  // Stripe confirms the plan on the DEFAULT endpoint → the gate opens.
  const platEvt = (n, tier, subId) => ({
    id: `evt_plat_${n}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_plat_${n}`,
        mode: 'subscription',
        subscription: subId,
        client_reference_id: '507700000000000007',
        metadata: { kind: 'platform_plan', tier, owner_discord_id: '507700000000000007' },
      },
    },
  });
  assert.equal((await deliverStripe(platEvt(1, 'starter', 'sub_plat_1'))).status, 200);
  const b1 = await billingState(u7Cookie);
  assert.deepEqual({ tier: b1.current.tier, limit: b1.usage.limit }, { tier: 'starter', limit: 50 });
  assert.equal((await tryCheckout('vip-signals')).status, 200, 'upgrading opens the gate');

  // A platform-plan renewal never creates a buyer membership.
  const inv = await deliverStripe({
    id: 'evt_plat_inv_1',
    type: 'invoice.paid',
    data: { object: { id: 'in_plat_1', parent: { subscription_details: { subscription: 'sub_plat_1' } } } },
  });
  assert.equal(inv.status, 200);
  assert.equal(await subRow('stripe', 'sub_plat_1'), null, 'platform subscriptions must never appear as buyer subscriptions');

  // Switching tiers ends the old Stripe subscription — nobody pays twice.
  assert.equal((await billing(u7Cookie, { action: 'checkout', tier: 'growth' })).status, 200);
  assert.equal((await deliverStripe(platEvt(2, 'growth', 'sub_plat_2'))).status, 200);
  assert.ok(stripe.subDeletes.includes('sub_plat_1'), 'the Starter subscription is canceled on switch');
  const b2 = await billingState(u7Cookie);
  assert.deepEqual({ tier: b2.current.tier, limit: b2.usage.limit }, { tier: 'growth', limit: 500 });

  // Cancel drops back to Free — and with 10 live members the gate closes again.
  assert.equal((await billing(u7Cookie, { action: 'cancel' })).status, 200);
  assert.ok(stripe.subDeletes.includes('sub_plat_2'), 'cancel ends the Stripe subscription');
  assert.equal((await billingState(u7Cookie)).current.tier, 'free');
  assert.equal((await tryCheckout('vip-signals')).status, 409, 'back on Free the full store is gated again');

  // Yearly billing: two months free — the session carries a yearly price
  // provisioned under its own lookup key. (No webhook: state stays Free.)
  assert.equal((await billing(u7Cookie, { action: 'checkout', tier: 'starter', interval: 'year' })).status, 200);
  const yearForm = stripe.checkoutSessions.at(-1);
  const yearPrice = Object.values(MOCK_PRICES).find((p) => p.lookup_key === 'ripley_platform_starter_year');
  assert.ok(yearPrice, 'yearly price created with its lookup key');
  assert.deepEqual(
    { price: yearForm['line_items[0][price]'], amount: yearPrice.unit_amount, interval: yearPrice.recurring.interval },
    { price: yearPrice.id, amount: 14990, interval: 'year' },
  );
});

test('onboarding: the Continue check uses only the bot token (never user-guild listing)', async () => {
  const loginAs = async (code) => {
    const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
    const st = new URL(login.headers.get('location')).searchParams.get('state');
    const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
    const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${st}`, {
      redirect: 'manual',
      headers: { cookie: sc.split(';')[0] },
    });
    return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  };
  const u7Cookie = await loginAs('code_u7');
  const botcheck = (cookie, guildId) =>
    fetch(`${appUrl}/api/onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ step: 'botcheck', guildId }),
    });
  assert.equal((await botcheck(null, G2)).status, 401, 'botcheck needs a session');
  // A guild the bot is NOT in: false. The guild it is in: true. Neither call
  // touches /users/@me/guilds — the mock would 404 an unknown guild fetch.
  assert.deepEqual(await (await botcheck(u7Cookie, '999900000000000099')).json(), { botIn: false });
  assert.deepEqual(await (await botcheck(u7Cookie, G2)).json(), { botIn: true });
});

test('store themes: validated tokens in, server-rendered CSS out', async () => {
  const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const st = new URL(login.headers.get('location')).searchParams.get('state');
  const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  const cb = await fetch(`${appUrl}/auth/callback?code=code_u7&state=${st}`, {
    redirect: 'manual',
    headers: { cookie: sc.split(';')[0] },
  });
  const ownerCookie = cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  const setTheme = (theme) =>
    fetch(`${appUrl}/api/admin/store`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ store: 'vip-signals', theme }),
    });

  // THE COLOUR WAY IS FREE, THE WALLPAPER IS NOT. A free store may save every
  // colour, corner, typeface and material, and the ten plain gradient grounds;
  // it may not save a photograph, an animated ground, or an imported URL.
  const U7ID = '507700000000000007';
  await tq('DELETE FROM platform_billing WHERE owner_discord_id = ?', [U7ID]);
  assert.equal((await setTheme({ bg: '#071209', accent: '#22c55e', radius: 20 })).status, 200,
    'a free store may set its own colours');
  assert.equal((await setTheme({ bg: '#071209', bgPreset: 'denim' })).status, 200,
    'a free store may use a plain gradient ground');
  const freeTry = await setTheme({ bg: '#071209', bgPreset: 'starfield' });
  assert.equal(freeTry.status, 402, 'a free store cannot save an animated wallpaper');
  assert.equal((await freeTry.json()).upgrade, true, 'and the refusal points at the plan');
  assert.equal((await setTheme({ bgUrl: 'https://example.com/bg.gif' })).status, 402,
    'nor import one of its own');
  // What a free store DID save must survive on the storefront — the gate takes
  // the wallpaper off a look, it does not throw the whole look away.
  assert.equal((await setTheme({ bg: '#071209', accent: '#22c55e' })).status, 200);
  const freePub = await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json();
  assert.equal(freePub.store.theme?.bg, '#071209', 'a free store keeps the colours it chose');
  assert.equal(freePub.store.theme?.bgPreset, undefined, 'and carries no wallpaper');
  // Clearing is NOT gated — undoing must never need a subscription.
  assert.equal((await setTheme(null)).status, 200, 'anyone may reset to the default look');

  // Put this owner on a paid plan for the rest of the scenario.
  await tq(
    'INSERT INTO platform_billing (owner_discord_id, tier, provider_ref, status, current_period_end, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [U7ID, 'starter', 'sub_theme_e2e', 'active', Math.floor(Date.now() / 1000) + 30 * 86400, Math.floor(Date.now() / 1000)],
  );

  // Values are validated, not laundered: a typoed color must fail loudly.
  assert.equal((await setTheme({ bg: 'red' })).status, 400, 'a non-hex color is refused');
  assert.equal((await setTheme({ radius: 99 })).status, 400, 'an out-of-range radius is refused');
  assert.equal((await setTheme({ font: 'comic-sans' })).status, 400, 'fonts come from the fixed list');
  assert.equal((await setTheme('body{}')).status, 400, 'raw CSS is not a theme');

  // A good theme saves; unknown keys are dropped rather than stored.
  const good = { bg: '#071209', panel: '#0d2012', text: '#e9f6ec', accent: '#22c55e', pay: '#22c55e', radius: 20, font: 'mono', evil: 'url(https://x)' };
  assert.equal((await setTheme(good)).status, 200);
  const pub = await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json();
  assert.deepEqual(pub.store.theme, { bg: '#071209', panel: '#0d2012', text: '#e9f6ec', accent: '#22c55e', pay: '#22c55e', radius: 20, font: 'mono' });

  // The storefront carries the theme server-rendered — buyers get the owner's
  // look on first paint, and only token-built CSS ever reaches the page.
  const page = await (await fetch(`${appUrl}/vip-signals`)).text();
  assert.match(page, /<style id="store-theme">/, 'the theme style is injected');
  assert.match(page, /--bg: #071209/, 'background token rendered');
  assert.match(page, /\.pay-btn \{ background: #22c55e/, 'pay button color rendered');
  assert.match(page, /border-radius: 20px/, 'radius rendered');
  assert.ok(!page.includes('evil'), 'junk keys never reach the page');

  // Backgrounds + materials: enum/URL-validated tokens, rendered as a layer
  // (attributes and media elements), never as CSS url().
  assert.equal((await setTheme({ bgPreset: 'not-a-real-bg' })).status, 400, 'unknown preset refused');
  assert.equal((await setTheme({ bgUrl: 'javascript:alert(1)' })).status, 400, 'non-https bgUrl refused');
  assert.equal((await setTheme({ bgUrl: 'https://cdn.example.com/loop' })).status, 400, 'extension-less bgUrl refused');
  assert.equal((await setTheme({ material: 'velvet' })).status, 400, 'unknown material refused');
  assert.equal((await setTheme({ bgPreset: 'aurora', material: 'liquid' })).status, 200);
  const bgPage = await (await fetch(`${appUrl}/vip-signals`)).text();
  assert.match(bgPage, /<div class="store-bg" data-bg="aurora"/, 'the background layer is rendered');
  assert.match(bgPage, /<body class="has-bg" data-bg="aurora" data-material="liquid">/, 'body carries bg + material');

  // THE PLAN LAPSES. The tokens stay on the row — a cancelled plan parks a
  // store's look, it never deletes it — but the storefront goes back to the
  // platform's own black on BOTH render paths. A write-time gate alone would
  // let an owner theme a store, cancel, and keep the look for nothing.
  await tq('DELETE FROM platform_billing WHERE owner_discord_id = ?', [U7ID]);
  const lapsedTheme = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).store.theme;
  assert.equal(lapsedTheme.bgPreset, undefined, 'a lapsed store loses the wallpaper it was renting');
  assert.equal(lapsedTheme.bgUrl, undefined, 'and any import with it');
  assert.equal(lapsedTheme.material, 'liquid', 'but keeps the look it set, which was never rented');
  const lapsed = await (await fetch(`${appUrl}/vip-signals`)).text();
  assert.match(lapsed, /id="store-theme"/, 'the colour way is still server-rendered');
  assert.ok(!/class="store-bg"/.test(lapsed), 'the wallpaper layer is not');
  // The row still holds them, so re-subscribing restores the exact look.
  const stillStored = (await tq("SELECT theme FROM stores WHERE slug = 'vip-signals'")).rows[0].theme;
  assert.match(String(stillStored), /aurora/, 'the tokens are parked, not deleted');
  // Re-subscribe: the exact same look is back, with nothing re-entered.
  await tq(
    'INSERT INTO platform_billing (owner_discord_id, tier, provider_ref, status, current_period_end, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [U7ID, 'starter', 'sub_theme_e2e', 'active', Math.floor(Date.now() / 1000) + 30 * 86400, Math.floor(Date.now() / 1000)],
  );
  assert.equal(
    (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).store.theme.bgPreset,
    'aurora',
    'upgrading brings the parked look straight back',
  );
  assert.equal((await setTheme({ bgPreset: 'clouds-day' })).status, 200);
  const cloudPage = await (await fetch(`${appUrl}/vip-signals`)).text();
  assert.match(cloudPage, /<canvas data-dues-sky>/, 'live cloud preset mounts the shader canvas');
  assert.match(cloudPage, /<html lang="en" data-theme="light">/, 'light-tone preset flips the token set');
  const gifUrl = 'https://cdn.example.com/party.gif';
  assert.equal((await setTheme({ bgUrl: gifUrl, material: 'glass' })).status, 200);
  const gifPage = await (await fetch(`${appUrl}/vip-signals`)).text();
  assert.match(gifPage, /<div class="store-bg" data-bg="custom"[^>]*><img src="https:\/\/cdn\.example\.com\/party\.gif"/, 'an imported GIF renders as an img element');
  assert.equal((await setTheme({ bgUrl: 'https://cdn.example.com/loop.mp4' })).status, 200);
  const mp4Page = await (await fetch(`${appUrl}/vip-signals`)).text();
  assert.match(mp4Page, /<video src="https:\/\/cdn\.example\.com\/loop\.mp4" autoplay muted loop playsinline/, 'an imported MP4 renders as a muted looping video');

  // Reset: null clears the row and the page goes back to the platform look.
  assert.equal((await setTheme(null)).status, 200);
  const cleared = await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json();
  assert.equal(cleared.store.theme, null);
  const plain = await (await fetch(`${appUrl}/vip-signals`)).text();
  assert.ok(!plain.includes('store-theme'), 'no theme style once cleared');
  assert.ok(!plain.includes('store-bg'), 'no background layer once cleared');
});

test('discover: opt-in directory of live stores, real numbers only', async () => {
  const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const st = new URL(login.headers.get('location')).searchParams.get('state');
  const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  const cb = await fetch(`${appUrl}/auth/callback?code=code_u7&state=${st}`, {
    redirect: 'manual',
    headers: { cookie: sc.split(';')[0] },
  });
  const ownerCookie = cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  const setStore = (body) =>
    fetch(`${appUrl}/api/admin/store`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ store: 'vip-signals', ...body }),
    });
  const directory = async () => (await (await fetch(`${appUrl}/api/discover?fresh=1`)).json()).stores;

  // Nothing is listed until an owner says so.
  assert.equal((await directory()).some((x) => x.slug === 'vip-signals'), false, 'stores are unlisted by default');

  // Category is an enum, not free text.
  assert.equal((await setStore({ discoverable: true, category: 'get-rich-quick' })).status, 400);
  assert.equal((await setStore({ discoverable: true, category: 'trading' })).status, 200);

  const body = await (await fetch(`${appUrl}/api/discover?fresh=1`)).text();
  assert.ok(!body.includes('sk_') && !body.includes('rk_') && !body.includes('whsec'), 'no key material in the directory');
  const listed = JSON.parse(body).stores.find((x) => x.slug === 'vip-signals');
  assert.ok(listed, 'an opted-in live store is listed');
  assert.equal(listed.category, 'trading');
  assert.ok(listed.products >= 1, 'real product count');
  assert.ok(listed.fromUsd > 0, 'real lowest price');
  assert.equal(typeof listed.members, 'number');
  assert.ok(!('guildId' in listed) && !('ownerDiscordId' in listed), 'only storefront-visible fields leave');

  // The page itself serves, and the platform paths cannot be claimed as slugs.
  const page = await fetch(`${appUrl}/discover`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Find your next community/);
  assert.equal((await fetch(`${appUrl}/api/plans?store=discover`)).status, 404);

  // Opting out delists immediately.
  assert.equal((await setStore({ discoverable: false })).status, 200);
  assert.equal((await directory()).some((x) => x.slug === 'vip-signals'), false, 'opting out delists');
  // restore for later scenarios' screenshots/data
  assert.equal((await setStore({ discoverable: true })).status, 200);
});

test('products managed in-site: edit/toggle/limit/success-url/lazy price/discounts/delete/store settings', async () => {
  const loginAs = async (code) => {
    const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
    const st = new URL(login.headers.get('location')).searchParams.get('state');
    const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
    const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${st}`, {
      redirect: 'manual',
      headers: { cookie: sc.split(';')[0] },
    });
    return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  };
  const u7Cookie = await loginAs('code_u7');
  const u9Cookie = await loginAs('code_u9b'); // existing member (manual grant)
  const u10Cookie = await loginAs('code_u10'); // signed in, never purchased
  const call = (cookie, path, body) =>
    fetch(`${appUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  const onboard = (body) => call(u7Cookie, '/api/onboard', body);
  const checkout = (cookie, body) => call(cookie, '/api/checkout/stripe', { store: 'vip-signals', ...body });

  // Headroom for the member-limit gate: back onto Starter.
  assert.equal((await call(u7Cookie, '/api/billing', { action: 'checkout', tier: 'starter' })).status, 200);
  await deliverStripe({
    id: 'evt_plat_3',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_plat_3', mode: 'subscription', subscription: 'sub_plat_3', client_reference_id: '507700000000000007', metadata: { kind: 'platform_plan', tier: 'starter', owner_discord_id: '507700000000000007' } } },
  });

  // The owner's management list: buyers count + a copyable checkout link.
  const storeRow = await tq("SELECT id FROM stores WHERE slug = 'vip-signals'");
  const storeId = Number(storeRow.rows[0].id);
  const list0 = await (await onboard({ step: 'products', storeId })).json();
  assert.equal(list0.products.length, 1);
  const vip = list0.products[0];
  assert.ok(vip.buyers >= 10, `buyers counted (got ${vip.buyers})`);
  assert.match(vip.checkoutUrl, new RegExp(`\\.e2e/vip-signals/${vip.planKey}$`), 'checkout links use the per-product URL');

  // Deactivate → hidden from buyers and refused at checkout; reactivate heals.
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: vip.planKey, active: false })).status, 200);
  assert.equal((await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans.length, 0, 'inactive products are invisible to buyers');
  const inactive = await checkout(u9Cookie, { planId: vip.planKey });
  assert.equal(inactive.status, 409);
  assert.match((await inactive.json()).error, /not for sale/);
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: vip.planKey, active: true })).status, 200);

  // Price edit clears the pinned Stripe price; the next checkout lazily
  // provisions a fresh one on the OWNER'S account and pins it. Existing
  // Stripe subscriptions are never touched.
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: vip.planKey, priceUsd: 59.99 })).status, 200);
  assert.equal((await tq('SELECT stripe_price_id FROM store_plans WHERE store_id = ? AND plan_key = ?', [storeId, vip.planKey])).rows[0].stripe_price_id, null);
  assert.equal((await checkout(u9Cookie, { planId: vip.planKey })).status, 200, 'checkout provisions the price lazily');
  const pinned = (await tq('SELECT stripe_price_id FROM store_plans WHERE store_id = ? AND plan_key = ?', [storeId, vip.planKey])).rows[0].stripe_price_id;
  assert.match(String(pinned), /^price_auto_/, 'fresh price pinned after lazy provisioning');
  assert.equal(stripe.checkoutSessions.at(-1)['line_items[0][price]'], pinned);

  // Success URL: buyers land on the owner's page after paying.
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: vip.planKey, successUrl: 'https://done.example/thanks' })).status, 200);
  assert.equal((await checkout(u9Cookie, { planId: vip.planKey })).status, 200);
  assert.equal(stripe.checkoutSessions.at(-1).success_url, 'https://done.example/thanks');

  // ── uploaded product photo: stored, listed as a served URL, delivered ─────
  const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  assert.equal(
    (await onboard({ step: 'product-update', storeId, planKey: vip.planKey, imageData: `data:image/png;base64,${PNG1}` })).status,
    200,
  );
  const withPhoto = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans.find((p) => p.id === vip.planKey);
  assert.match(withPhoto.imageUrl, /\/api\/img\?store=vip-signals&plan=/, 'uploads are served from /api/img');
  const served = await fetch(`${appUrl}/api/img?store=vip-signals&plan=${vip.planKey}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await served.arrayBuffer()).toString('base64'), PNG1, 'served bytes match the upload');
  // Link previews: the store page is SERVER-rendered with the product photo,
  // so sharing the link unfurls with the image the owner added (unfurlers
  // never run JS — client-set tags don't count).
  const shared = await (await fetch(`${appUrl}/vip-signals`)).text();
  assert.match(shared, /property="og:image" content="[^"]*\/api\/img\?store=vip-signals/, 'link previews carry the uploaded product photo');
  assert.match(shared, /property="og:title" content="[^"]*VIP Signals[^"]*"/, 'link previews carry the store name');
  assert.equal(
    (await onboard({ step: 'product-update', storeId, planKey: vip.planKey, imageData: 'data:image/png;base64,@@@' })).status,
    400,
    'garbage uploads are refused',
  );
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: vip.planKey, imageData: null })).status, 200, 'photo removable');
  assert.equal((await fetch(`${appUrl}/api/img?store=vip-signals&plan=${vip.planKey}`)).status, 404, 'removed photo no longer served');

  // ── uploaded product VIDEO: a short MP4/GIF loop on a product link ────────
  const MP4 = Buffer.from('AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=', 'base64').toString('base64');
  assert.equal(
    (await onboard({ step: 'product-update', storeId, planKey: vip.planKey, imageData: `data:video/mp4;base64,${MP4}` })).status,
    200,
    'a small MP4 upload saves',
  );
  const withVideo = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans.find((p) => p.id === vip.planKey);
  assert.equal(withVideo.mediaKind, 'video', 'the payload says video so the storefront renders a <video>');
  const servedVid = await fetch(`${appUrl}/api/img?store=vip-signals&plan=${vip.planKey}`);
  assert.equal(servedVid.headers.get('content-type'), 'video/mp4');
  // Safari plays <video> only from range-capable servers.
  const ranged = await fetch(`${appUrl}/api/img?store=vip-signals&plan=${vip.planKey}`, { headers: { range: 'bytes=0-9' } });
  assert.equal(ranged.status, 206, 'byte ranges answered');
  assert.equal((await ranged.arrayBuffer()).byteLength, 10);
  assert.match(ranged.headers.get('content-range'), /^bytes 0-9\/\d+$/);
  // A video never becomes the link-preview image.
  const sharedVid = await (await fetch(`${appUrl}/vip-signals`)).text();
  assert.ok(!/property="og:image" content="[^"]*\/api\/img\?store=vip-signals/.test(sharedVid), 'og:image skips video media');
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: vip.planKey, imageData: null })).status, 200);
  // Regression: the edit form echoes the stored imageUrl back on every save.
  // An ordinary edit (price + the echoed /api/img URL) must never wipe the
  // upload — the server once mistook its own URL for a replacement link.
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: vip.planKey, imageData: `data:image/png;base64,${PNG1}` })).status, 200);
  const echoUrl = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans.find((p) => p.id === vip.planKey).imageUrl;
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: vip.planKey, priceUsd: 59.99, imageUrl: echoUrl })).status, 200);
  assert.equal((await fetch(`${appUrl}/api/img?store=vip-signals&plan=${vip.planKey}`)).status, 200, 'an edit echoing the stored URL keeps the upload');
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: vip.planKey, imageData: null })).status, 200);
  // The platform operator manages tenant products too — same bypass as the
  // admin endpoints, so the Platform admin view is fully functional.
  const opRes = await fetch(`${appUrl}/api/onboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u1Cookie },
    body: JSON.stringify({ step: 'products', storeId }),
  });
  assert.equal(opRes.status, 200, 'platform owner bypass on onboard steps');
  // Sellers get the dashboard nav link; buyers do not.
  assert.equal((await (await fetch(`${appUrl}/api/me`, { headers: { cookie: u7Cookie } })).json()).seller, true, 'store owner is flagged seller');
  assert.equal((await (await fetch(`${appUrl}/api/me`, { headers: { cookie: u9Cookie } })).json()).seller, false, 'buyer is not');

  // Second product, monthly — created in the site, extras applied, role picked.
  const made = await onboard({ step: 'product', storeId, name: 'Signals Monthly', description: 'Every signal, monthly.', priceUsd: 15, lifetime: false, durationDays: 31 });
  const plan2 = (await made.json()).plan;
  // A product whose name slugifies to an existing key must get its own key,
  // never overwrite the first product in place.
  const dup = await onboard({ step: 'product', storeId, name: vip.name, priceUsd: 25, lifetime: true });
  assert.equal(dup.status, 200);
  const dupKey = (await dup.json()).plan.planKey;
  assert.notEqual(dupKey, vip.planKey, 'name collision gets a fresh key');
  assert.match(dupKey, new RegExp(`^${vip.planKey}-\\d+$`));
  assert.equal((await onboard({ step: 'product-delete', storeId, planKey: dupKey })).status, 200);
  assert.equal(made.status, 200);
  assert.equal((await onboard({ step: 'role', storeId, planKey: plan2.planKey, roleId: R2_VIP })).status, 200);
  assert.equal((await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans.length, 2);

  // Purchase limit: sold out for NEW buyers, never for returning ones.
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: vip.planKey, purchaseLimit: vip.buyers })).status, 200);
  const soldOut = await checkout(u10Cookie, { planId: vip.planKey });
  assert.equal(soldOut.status, 409);
  assert.match((await soldOut.json()).error, /sold out/);
  assert.equal((await checkout(u9Cookie, { planId: vip.planKey })).status, 200, 'existing buyers pass the purchase limit');
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: vip.planKey, purchaseLimit: null })).status, 200);

  // ── sale notifications ────────────────────────────────────────────────────
  const chans = await (await onboard({ step: 'channels', storeId })).json();
  assert.ok(chans.channels.some((c) => c.name === 'sales-feed'), 'text channels are listed');
  assert.ok(!chans.channels.some((c) => c.name === 'voice-lounge'), 'voice channels are not');
  const storeCallEarly = (body) => call(u7Cookie, '/api/admin/store', { store: 'vip-signals', ...body });
  assert.equal((await storeCallEarly({ notifyChannelId: 'abc' })).status, 400, 'channel ids are validated');
  assert.equal((await storeCallEarly({ notifyChannelId: '999999999999999999' })).status, 409, 'foreign channels are refused');
  assert.equal((await storeCallEarly({ notifyChannelId: '800000000000000002' })).status, 200);
  const testPost = discord.channelPosts.at(-1);
  assert.equal(testPost.channelId, '800000000000000002');
  assert.match(testPost.body.embeds[0].title, /Sale notifications are on/, 'saving posts a proof message');

  // ── discounts ─────────────────────────────────────────────────────────────
  const disc = (body) => call(u7Cookie, '/api/admin/discounts', { store: 'vip-signals', ...body });
  assert.equal((await disc({ action: 'create', code: 'launch20', kind: 'percent', amount: 20 })).status, 200);
  assert.equal((await disc({ action: 'create', code: 'FIVER', kind: 'fixed', amount: 5, planKey: plan2.planKey, maxUses: 1 })).status, 200);
  assert.equal((await disc({ action: 'create', code: 'launch20', kind: 'percent', amount: 10 })).status, 409, 'duplicate codes refused');
  // A date-only expiry means "valid through that day": pinned to end-of-day
  // UTC, never UTC midnight (which killed codes a day early west of UTC).
  assert.equal((await disc({ action: 'create', code: 'DATED', kind: 'percent', amount: 10, expiresAt: '2099-08-30' })).status, 200);
  const datedRow = (await (await disc({ action: 'list' })).json()).discounts.find((d) => d.code === 'DATED');
  assert.equal(datedRow.expiresAt, Math.floor(Date.parse('2099-08-30T23:59:59Z') / 1000), 'date-only expiry pins to end-of-day UTC');
  assert.equal((await disc({ action: 'delete', code: 'DATED' })).status, 200);
  // The checkout page's Apply button previews codes here before paying.
  const vipNow = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans.find((p) => p.id === vip.planKey);
  const preview = await (await fetch(`${appUrl}/api/discount?store=vip-signals&code=launch20&plan=${vip.planKey}`)).json();
  assert.equal(preview.discountedUsd, Math.round(vipNow.priceUsd * 0.8 * 100) / 100, 'percent preview math');
  assert.equal((await fetch(`${appUrl}/api/discount?store=vip-signals&code=NOPE&plan=${vip.planKey}`)).status, 404);
  assert.equal(
    (await fetch(`${appUrl}/api/discount?store=vip-signals&code=FIVER&plan=${vip.planKey}`)).status,
    404,
    'a scoped code previews only for its own product',
  );
  const fixedPrev = await (await fetch(`${appUrl}/api/discount?store=vip-signals&code=FIVER&plan=${plan2.planKey}`)).json();
  assert.equal(fixedPrev.saveUsd, 5, 'fixed-amount preview math');
  const bad = await checkout(u9Cookie, { planId: vip.planKey, discountCode: 'NOPE' });
  assert.equal(bad.status, 400);
  const withCode = await checkout(u9Cookie, { planId: vip.planKey, discountCode: 'launch20' });
  assert.equal(withCode.status, 200, await withCode.text());
  const sess = stripe.checkoutSessions.at(-1);
  assert.match(sess['discounts[0][coupon]'], /^coupon_/, 'a Stripe coupon rides the session');
  assert.equal(sess['metadata[discount_code]'], 'LAUNCH20');
  assert.equal(stripe.coupons.at(-1).percent_off, '20');
  // Completed payment counts the use.
  await deliverStripe({
    id: 'evt_disc_1',
    type: 'checkout.session.completed',
    // Stripe reports what was actually charged: $59.99 less LAUNCH20 (20%).
    data: { object: { id: 'cs_disc_1', mode: 'payment', amount_total: 4799, client_reference_id: '509900000000000009', customer_details: { email: 'buyer9@e2e.test' }, metadata: { plan_id: vip.planKey, discord_id: '509900000000000009', store_id: String(storeId), discount_code: 'LAUNCH20' } } },
  });
  const discs = (await (await disc({ action: 'list' })).json()).discounts;
  assert.equal(discs.find((d) => d.code === 'LAUNCH20').uses, 1, 'the webhook counts discount uses');
  // The completed order also pinged the configured sales channel — with the
  // amount the buyer PAID, not the plan's list price.
  const salePost = discord.channelPosts.at(-1);
  assert.equal(salePost.channelId, '800000000000000002');
  assert.match(salePost.body.embeds[0].title, /New Subscriber/, 'every order posts to the sales channel');
  assert.match(salePost.body.embeds[0].description, /just subscribed to \*\*VIP Access\*\*/, 'the ping names the product');
  assert.match(salePost.body.embeds[0].description, /Payment received: \*\*\$47\.99\*\*/, 'the ping carries the discounted charge, not the list price');
  // The emailed receipt shows the same real amount.
  const discReceipt = resend.emails.at(-1);
  assert.ok(discReceipt, 'a discounted order still sends a receipt');
  assert.deepEqual(discReceipt.to, ['buyer9@e2e.test']);
  assert.match(discReceipt.html, /\$47\.99/, 'the receipt bills the discounted charge');
  assert.ok(!/\$59\.99/.test(discReceipt.html), 'the list price must not appear as the charge');
  // And the owner dashboard's payments timeline records what was paid.
  const payRows = (await (await fetch(`${appUrl}/api/admin/payments?store=vip-signals`, { headers: { cookie: u7Cookie } })).json()).payments;
  const discRow = payRows.find((p) => p.discordId === '509900000000000009' && p.planId === vip.planKey);
  assert.ok(discRow, 'the discounted purchase appears in the payments timeline');
  assert.equal(discRow.amountUsd, 47.99, 'the timeline shows the paid amount, not the list price');
  // FIVER is scoped to plan2 — wrong product refused, then its single use is spent.
  assert.equal((await checkout(u9Cookie, { planId: vip.planKey, discountCode: 'FIVER' })).status, 400, 'scoped code refuses other products');
  // (owner deletes it instead of spending it — delete works)
  assert.equal((await disc({ action: 'delete', code: 'FIVER' })).status, 200);
  assert.equal((await (await disc({ action: 'list' })).json()).discounts.length, 1);

  // ── product links: each product owns a URL under the store ────────────────
  const upd = (body) => call(u7Cookie, '/api/onboard', { step: 'product-update', storeId, ...body });
  assert.equal((await upd({ planKey: vip.planKey, linkSlug: 'VIP!' })).status, 400, 'link segments are validated');
  assert.equal((await upd({ planKey: vip.planKey, linkSlug: 'vip' })).status, 200);
  assert.equal((await upd({ planKey: plan2.planKey, linkSlug: 'vip' })).status, 409, 'taken segments are refused');
  const withLinks = await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json();
  assert.equal(withLinks.plans.find((p) => p.id === vip.planKey).linkSlug, 'vip', 'the segment rides the public payload');
  const prodPage = await (await fetch(`${appUrl}/vip-signals/vip`)).text();
  assert.match(prodPage, /VIP Access — /, 'the product link serves its own page with product link-preview tags');
  const prods = (await (await call(u7Cookie, '/api/onboard', { step: 'products', storeId })).json()).products;
  assert.match(prods.find((p) => p.planKey === vip.planKey).checkoutUrl, /\/vip-signals\/vip$/, 'the dashboard copies the pretty link');
  assert.equal((await upd({ planKey: vip.planKey, linkSlug: '' })).status, 200, 'blank returns the link to the plan key');

  // ── member extend (monthly manual grant) ──────────────────────────────────
  const U9 = '509900000000000009';
  assert.equal((await call(u7Cookie, '/api/admin/member', { store: 'vip-signals', action: 'grant', discordId: U9, planId: plan2.planKey })).status, 200);
  const before = asNum((await tq("SELECT current_period_end FROM subscriptions WHERE discord_id = ? AND plan_id = ?", [U9, plan2.planKey])).rows[0].current_period_end);
  assert.ok(before > nowSec(), 'monthly manual grant carries an expiry');
  assert.equal((await call(u7Cookie, '/api/admin/member', { store: 'vip-signals', action: 'extend', discordId: U9, days: 30 })).status, 200);
  const after = asNum((await tq("SELECT current_period_end FROM subscriptions WHERE discord_id = ? AND plan_id = ?", [U9, plan2.planKey])).rows[0].current_period_end);
  assert.ok(Math.abs(after - (before + 30 * 86400)) <= 2, `extend adds 30 days (${before} → ${after})`);

  // ── store settings ────────────────────────────────────────────────────────
  const storeCall = (body) => call(u7Cookie, '/api/admin/store', { store: 'vip-signals', ...body });
  assert.equal((await storeCall({ stripeKey: 'sk_test_wrong' })).status, 400, 'key rotation validates with Stripe first');
  assert.equal((await storeCall({ stripeKey: 'pk_live_publishable' })).status, 400, 'a publishable key is refused on shape alone');
  assert.equal((await storeCall({ stripeKey: OWNER2_KEY })).status, 200);
  assert.equal((await storeCall({ name: 'VIP Signals Pro', description: 'The alpha desk.', bannerUrl: 'https://cdn.e2e.test/banner.png' })).status, 200);
  // Store-page extras: about, social links and the member-count badge.
  assert.equal((await storeCall({ links: { x: 'http://insecure.example' } })).status, 400, 'links must be https');
  assert.equal(
    (await storeCall({
      about: 'Daily signals.\n\nRefunds within 7 days.',
      links: { discord: 'https://discord.gg/vipsignals', website: 'https://vipsignals.example' },
      showMembers: true,
    })).status,
    200,
  );
  const pub = await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json();
  assert.equal(pub.brand, 'VIP Signals Pro');
  assert.equal(pub.store.description, 'The alpha desk.');
  assert.match(pub.store.about, /Refunds within 7 days/);
  assert.equal(pub.store.links.discord, 'https://discord.gg/vipsignals');
  assert.equal(typeof pub.store.memberCount, 'number', 'opt-in badge exposes the live count');
  // The dashboard re-renders its settings forms from /api/admin/payments —
  // if that payload drops an editable field, a saved value comes back blank
  // and the owner's next save wipes it (the "goes back to empty" bug).
  const dash = await (await fetch(`${appUrl}/api/admin/payments?store=vip-signals`, { headers: { cookie: u7Cookie } })).json();
  const dstore = dash.stores.find((s) => s.slug === 'vip-signals');
  assert.equal(dstore.description, 'The alpha desk.', 'dashboard payload carries description');
  assert.equal(dstore.bannerUrl, 'https://cdn.e2e.test/banner.png', 'dashboard payload carries banner');
  assert.match(dstore.links?.discord ?? '', /discord\.gg/, 'dashboard payload carries links');
  assert.match(String(dstore.about), /Refunds within 7 days/, 'dashboard payload carries about');
  assert.equal(dstore.showMembers, true, 'dashboard payload carries the member-badge switch');
  // Dashboard preferences: fixed shape, validated, round-trips to the payload.
  assert.equal((await storeCall({ dashboardPrefs: { accent: 'red' } })).status, 400, 'accent must be #rrggbb');
  assert.equal((await storeCall({ dashboardPrefs: { accent: '#5865F2', cards: { mrr: false }, defaultRange: '90' } })).status, 200);
  const dash2 = await (await fetch(`${appUrl}/api/admin/payments?store=vip-signals`, { headers: { cookie: u7Cookie } })).json();
  const dp = dash2.stores.find((s) => s.slug === 'vip-signals').dashboardPrefs;
  assert.equal(dp.accent, '#5865f2', 'accent saved lowercased');
  assert.equal(dp.cards.mrr, false, 'hidden stat cards persist');
  assert.equal(dp.defaultRange, '90', 'default period persists');
  assert.equal((await storeCall({ dashboardPrefs: null })).status, 200, 'prefs reset clears the row');
  assert.equal((await storeCall({ showMembers: false })).status, 200);
  const pubOff = await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json();
  assert.equal(pubOff.store.memberCount, null, 'switched off, the count is private again');
  // Custom link: platform paths can never be claimed as store links.
  // ('vs' is unclaimable too, but the 2-char format check 400s it first.)
  for (const bad of ['dashboard', 'api', 'store', 'diagnostics', 'tools', 'use-cases', 'demo']) {
    assert.equal((await storeCall({ slug: bad })).status, 409, `reserved slug "${bad}" must be refused`);
  }
  // New slug serves, the old one 404s, then restore.
  assert.equal((await storeCall({ slug: 'vip-elite' })).status, 200);
  assert.equal((await fetch(`${appUrl}/api/plans?store=vip-elite`)).status, 200);
  assert.equal((await fetch(`${appUrl}/api/plans?store=vip-signals`)).status, 404);
  assert.equal((await call(u7Cookie, '/api/admin/store', { store: 'vip-elite', slug: 'vip-signals' })).status, 200);

  // ── delete a product ──────────────────────────────────────────────────────
  assert.equal((await onboard({ step: 'product-delete', storeId, planKey: plan2.planKey })).status, 200);
  assert.equal((await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans.length, 1);
  assert.equal((await checkout(u10Cookie, { planId: plan2.planKey })).status, 400, 'deleted products cannot be bought');
});

test('pricing options: one product sold at several prices, same role, same page', async () => {
  const loginAs = async (code) => {
    const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
    const st = new URL(login.headers.get('location')).searchParams.get('state');
    const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
    const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${st}`, {
      redirect: 'manual',
      headers: { cookie: sc.split(';')[0] },
    });
    return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  };
  const u7Cookie = await loginAs('code_u7');
  const call = (cookie, path, body) =>
    fetch(`${appUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  const onboard = (body) => call(u7Cookie, '/api/onboard', body);
  const owned = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u7Cookie } })).json();
  const storeId = owned.stores.find((s) => s.slug === 'vip-signals').id;
  const plansAt = async () => (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans;

  // The product: Mentorship, lifetime $500 — plus a Monthly $50 option.
  const made = await onboard({ step: 'product', storeId, name: 'Mentorship', priceUsd: 500, lifetime: true });
  const parent = JSON.parse(await made.text()).plan;
  assert.equal(made.status, 200);
  assert.equal((await onboard({ step: 'role', storeId, planKey: parent.planKey, roleId: R2_VIP })).status, 200);
  const optRes = await onboard({ step: 'variant', storeId, planKey: parent.planKey, label: 'Monthly', priceUsd: 50, lifetime: false });
  const optBody = await optRes.text();
  assert.equal(optRes.status, 200, optBody);
  const opt = JSON.parse(optBody).plan;
  assert.equal(opt.variantOf, parent.planKey, 'the option points at its product');

  // Storefront payload: the option carries its own price and cadence but the
  // PRODUCT's role — attached to the parent only.
  const plans = await plansAt();
  const optPlan = plans.find((p) => p.id === opt.planKey);
  assert.ok(optPlan, 'the option is sellable');
  assert.equal(optPlan.priceUsd, 50);
  assert.equal(optPlan.interval, 'month');
  assert.deepEqual(optPlan.roleNames, plans.find((p) => p.id === parent.planKey).roleNames, 'options inherit the product role');
  assert.ok(optPlan.roleNames.length > 0, 'the inherited role is real');

  // Options have no options and no links of their own.
  assert.equal((await onboard({ step: 'variant', storeId, planKey: opt.planKey, label: 'Weekly', priceUsd: 15, lifetime: false })).status, 400);
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: opt.planKey, linkSlug: 'mentor-monthly' })).status, 400);

  // A role attach AIMED at the option lands on the product — the group can
  // never drift apart.
  assert.equal((await onboard({ step: 'role', storeId, planKey: opt.planKey, roleId: R2_VIP })).status, 200);
  {
    const now = await plansAt();
    assert.deepEqual(
      now.find((p) => p.id === opt.planKey).roleNames,
      now.find((p) => p.id === parent.planKey).roleNames,
      'the option-aimed attach landed on the product and flowed back down',
    );
  }

  // The dashboard's copy-link for the option is the PRODUCT's link.
  const listed = await (await onboard({ step: 'products', storeId })).json();
  assert.match(listed.products.find((p) => p.planKey === opt.planKey).checkoutUrl, new RegExp(`/vip-signals/${parent.planKey}$`));

  // A code scoped to the product covers its options.
  assert.equal(
    (await call(u7Cookie, '/api/admin/discounts', { store: 'vip-signals', action: 'create', code: 'MENT10', kind: 'percent', amount: 10, planKey: parent.planKey })).status,
    200,
  );
  const disc = await (await fetch(`${appUrl}/api/discount?store=vip-signals&code=MENT10&plan=${opt.planKey}`)).json();
  assert.equal(disc.discountedUsd, 45, 'a product-scoped code prices the option too');

  // A buyer can check the option out — the lazy Stripe price provisions for
  // the option's own amount, through the store's own key.
  const u9Cookie = await loginAs('code_u9b');
  assert.equal((await call(u9Cookie, '/api/checkout/stripe', { store: 'vip-signals', planId: opt.planKey })).status, 200);

  // Switching the PRODUCT off takes its options off sale with it…
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: parent.planKey, active: false })).status, 200);
  const dark = await plansAt();
  assert.ok(!dark.some((p) => p.id === parent.planKey) && !dark.some((p) => p.id === opt.planKey), 'inactive product hides its options');
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: parent.planKey, active: true })).status, 200);

  // …and deleting the product deletes them.
  assert.equal((await onboard({ step: 'product-delete', storeId, planKey: parent.planKey })).status, 200);
  const after = await (await onboard({ step: 'products', storeId })).json();
  assert.ok(!after.products.some((p) => p.planKey === parent.planKey || p.planKey === opt.planKey), 'options never outlive their product');
  await call(u7Cookie, '/api/admin/discounts', { store: 'vip-signals', action: 'delete', code: 'MENT10' });
});

test('multi-currency: a store prices in its own currency, and the minor-unit maths holds', async () => {
  // The whole point of this scenario is the divisor. Stripe wants amounts in a
  // currency's MINOR unit, and that unit is not always 1/100: ¥1500 is sent as
  // 1500, not 150000. A hundredfold overcharge is invisible in every test that
  // only ever uses dollars, which is what this suite used to be.
  const U15 = '514400000000000015';
  discord.oauthUsers.code_u15 = { id: U15, username: 'tokyo_owner' };
  discord.userGuilds[U15] = [{ id: G4, name: 'Tokyo Desk', icon: null, owner: true, permissions: '8' }];
  const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const st = new URL(login.headers.get('location')).searchParams.get('state');
  const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  const cb = await fetch(`${appUrl}/auth/callback?code=code_u15&state=${st}`, {
    redirect: 'manual',
    headers: { cookie: sc.split(';')[0] },
  });
  const cookie = cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  const call = (path, body) =>
    fetch(`${appUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  const dash = async () => (await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie } })).json());

  const madeStore = await call('/api/onboard', { step: 'store', guildId: G4, name: 'Tokyo Desk', stripeKey: OWNER2_KEY });
  assert.equal(madeStore.status, 200, await madeStore.clone().text());
  const store = (await madeStore.json()).store;
  const slug = store.slug;
  const storeId = store.id;

  // A brand-new store prices in USD. Every store that existed before this
  // feature must land exactly here, which is what the column default buys.
  assert.equal((await dash()).stores.find((x) => x.slug === slug).currency, 'usd',
    'a store that never chose a currency is a USD store');

  // The picker offers what the SELLER'S OWN Stripe account can be paid out in,
  // read from the bank accounts already on it. Dues asks for no bank details,
  // stores none, and invents no options.
  const avail = await (await call('/api/admin/store', { store: slug, action: 'payout-currencies' })).json();
  assert.deepEqual([...avail.currencies].sort(), ['dkk', 'jpy', 'usd'], "the picker mirrors the seller's own payout accounts");
  assert.equal(avail.defaultCurrency, 'usd');
  assert.equal(avail.connected, true);

  // A currency with no bank account behind it is refused: saving it would
  // strand the seller's money at Stripe.
  const nope = await call('/api/admin/store', { store: slug, currency: 'gbp' });
  assert.equal(nope.status, 400, 'a currency the account cannot be paid out in is refused');
  assert.match((await nope.json()).error, /GBP/);
  assert.equal((await call('/api/admin/store', { store: slug, currency: 'zzz' })).status, 400, 'a non-currency is refused');

  // Switch to yen and sell at ¥1500.
  assert.equal((await call('/api/admin/store', { store: slug, currency: 'jpy' })).status, 200);
  const made = await call('/api/onboard', { step: 'product', storeId, name: 'Tokyo Pass', priceUsd: 1500, lifetime: true });
  const body = await made.text();
  assert.equal(made.status, 200, body);
  const plan = JSON.parse(body).plan;
  assert.equal(plan.currency, 'jpy', 'the product is stamped with the currency it was priced in');
  assert.equal(plan.priceUsd, 1500);

  // THE assertion. What actually reached Stripe: 1500, not 150000.
  const jpyPrice = MOCK_PRICES[plan.stripePriceId];
  assert.ok(jpyPrice, 'a Stripe price was provisioned');
  assert.equal(jpyPrice.currency, 'jpy', 'the Stripe price is denominated in the store currency');
  assert.equal(jpyPrice.unit_amount, 1500, 'a zero-decimal currency is sent as-is — 1500, never 150000');

  // The storefront must carry the currency beside the number, or the page has
  // no way to tell ¥1,500 from $1,500.00.
  const shown = (await (await fetch(`${appUrl}/api/plans?store=${slug}`)).json()).plans.find((p) => p.id === plan.planKey);
  assert.equal(shown.currency, 'jpy');
  assert.equal(shown.priceUsd, 1500);

  // Stripe's own per-currency floor, enforced where the seller can still fix
  // it rather than at the buyer's card form. ¥50 is the JPY minimum.
  assert.equal((await call('/api/onboard', { step: 'product', storeId, name: 'Too Cheap', priceUsd: 10, lifetime: true })).status, 400,
    'a price under the JPY minimum is refused at the form, not at the card');
  // ...and the old flat $1–$10,000 ceiling is gone: ¥40,000 is about $260.
  assert.equal((await call('/api/onboard', { step: 'product', storeId, name: 'Tokyo Pro', priceUsd: 40000, lifetime: true })).status, 200,
    'a price that only looked absurd in dollars is ordinary in yen');

  // The dashboard is told which currency every figure on it is in.
  assert.equal((await dash()).stores.find((x) => x.slug === slug).currency, 'jpy');

  // Switching again re-mints the Stripe prices rather than reinterpreting the
  // old ones: a Stripe price object carries its currency forever, so leaving a
  // yen price pinned under a krone label would sell at the wrong money.
  const oldPriceId = plan.stripePriceId;
  assert.equal((await call('/api/admin/store', { store: slug, currency: 'dkk' })).status, 200);
  const afterSwitch = (await (await fetch(`${appUrl}/api/plans?store=${slug}`)).json()).plans.find((p) => p.id === plan.planKey);
  assert.equal(afterSwitch.currency, 'dkk', 'products follow the store to its new currency');
  assert.notEqual(afterSwitch.stripePriceId, oldPriceId, 'the yen price is unpinned, not relabelled');

  // And once a store has sold something the currency locks. Dues never touches
  // the Stripe price an existing subscriber is billed on, so a mid-life switch
  // would bill old members in one currency and new ones in another while the
  // dashboard added the two together. vip-signals has real payment history by
  // this point in the suite, so it is the store that proves it.
  const u7 = await (async () => {
    const lg = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
    const s7 = new URL(lg.headers.get('location')).searchParams.get('state');
    const c7 = lg.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
    const done = await fetch(`${appUrl}/auth/callback?code=code_u7&state=${s7}`, {
      redirect: 'manual', headers: { cookie: c7.split(';')[0] },
    });
    return done.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  })();
  const locked = await fetch(`${appUrl}/api/admin/store`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u7 },
    body: JSON.stringify({ store: 'vip-signals', currency: 'dkk' }),
  });
  assert.equal(locked.status, 409, 'a store that has sold something cannot change what it sold in');
  assert.match((await locked.json()).error, /USD/);
});

test('every checkout asks Stripe to show the buyer their own currency', async () => {
  // Adaptive Pricing is what turns "one store currency" into "buyers in 150+
  // countries pay in theirs". It is a per-session override of the seller's
  // dashboard toggle, so it must ride on EVERY session Dues creates — a seller
  // who never opens their Stripe settings still gets it.
  const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const st = new URL(login.headers.get('location')).searchParams.get('state');
  const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  const cb = await fetch(`${appUrl}/auth/callback?code=code_u1&state=${st}`, {
    redirect: 'manual',
    headers: { cookie: sc.split(';')[0] },
  });
  const cookie = cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  const before = stripe.checkoutSessions.length;
  const res = await fetch(`${appUrl}/api/checkout/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ planId: 'insider' }),
  });
  assert.equal(res.status, 200, await res.text());
  const form = stripe.checkoutSessions[stripe.checkoutSessions.length - 1];
  assert.ok(stripe.checkoutSessions.length > before, 'a session was created');
  assert.equal(form['adaptive_pricing[enabled]'], 'true',
    'every Checkout Session opts the buyer into local-currency presentment');
});

test('gated + limited-time products: only role holders buy, expiry ends the sale', async () => {
  const loginAs = async (code) => {
    const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
    const st = new URL(login.headers.get('location')).searchParams.get('state');
    const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
    const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${st}`, {
      redirect: 'manual',
      headers: { cookie: sc.split(';')[0] },
    });
    return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  };
  const u7Cookie = await loginAs('code_u7');
  const call = (cookie, path, body) =>
    fetch(`${appUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  const onboard = (body) => call(u7Cookie, '/api/onboard', body);
  const owned = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u7Cookie } })).json();
  const storeId = owned.stores.find((s) => s.slug === 'vip-signals').id;
  const plansAt = async () => (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans;

  // An upsell for existing @VIP holders only.
  const made = await onboard({ step: 'product', storeId, name: 'Inner Sanctum', priceUsd: 200, lifetime: true });
  const plan = JSON.parse(await made.text()).plan;
  assert.equal(made.status, 200);
  assert.equal((await onboard({ step: 'role', storeId, planKey: plan.planKey, roleId: R2_VIP })).status, 200);
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: plan.planKey, requiredRoleId: R2_VIP })).status, 200);
  assert.equal((await plansAt()).find((p) => p.id === plan.planKey).requiredRoleName, '@VIP', 'the storefront names the gate');

  // A buyer WITHOUT the role is refused; the SAME buyer with it gets through.
  const GATE_UID = '515500000000000015';
  discord.oauthUsers.code_gate = { id: GATE_UID, username: 'gate_buyer' };
  const u10Cookie = await loginAs('code_gate');
  discord.members.set(GATE_UID, new Set(['ROLE_OTHER']));
  const refused = await call(u10Cookie, '/api/checkout/stripe', { store: 'vip-signals', planId: plan.planKey });
  assert.equal(refused.status, 403, await refused.text());
  discord.members.get(GATE_UID).add(R2_VIP);
  assert.equal((await call(u10Cookie, '/api/checkout/stripe', { store: 'vip-signals', planId: plan.planKey })).status, 200);

  // A pricing option inherits the product's gate.
  const opt = JSON.parse(await (await onboard({ step: 'variant', storeId, planKey: plan.planKey, label: 'Monthly', priceUsd: 20, lifetime: false })).text()).plan;
  discord.members.get(GATE_UID).delete(R2_VIP);
  assert.equal((await call(u10Cookie, '/api/checkout/stripe', { store: 'vip-signals', planId: opt.planKey })).status, 403, 'options are gated by their product');

  // Expiry: the past is refused, options may not carry their own date…
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: plan.planKey, expiresAt: '2020-01-01' })).status, 400);
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: opt.planKey, expiresAt: '2099-01-01' })).status, 400);
  // …a future date sells normally, and once it passes, the product AND its
  // options leave the store and refuse checkout — with the gate satisfied,
  // so it is the expiry doing the refusing.
  discord.members.get(GATE_UID).add(R2_VIP);
  const soon = new Date(Date.now() + 2000).toISOString();
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: plan.planKey, expiresAt: soon })).status, 200);
  assert.ok((await plansAt()).some((p) => p.id === plan.planKey), 'still on sale before the deadline');
  await sleep(2600);
  const dark = await plansAt();
  assert.ok(!dark.some((p) => p.id === plan.planKey) && !dark.some((p) => p.id === opt.planKey), 'the deadline hides the product and its options');
  assert.equal((await call(u10Cookie, '/api/checkout/stripe', { store: 'vip-signals', planId: plan.planKey })).status, 409, 'expired products refuse checkout');
  assert.equal((await call(u10Cookie, '/api/checkout/stripe', { store: 'vip-signals', planId: opt.planKey })).status, 409, 'expired products refuse their options too');

  // Clearing the date puts it back on sale; cleanup.
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: plan.planKey, expiresAt: '' })).status, 200);
  assert.ok((await plansAt()).some((p) => p.id === plan.planKey), 'clearing the expiry restores the sale');
  assert.equal((await onboard({ step: 'product-delete', storeId, planKey: plan.planKey })).status, 200);
});

test('the hosted demo store: fixed storefront at /demo, discount preview works, nothing purchasable', async () => {
  // The page serves with its own head and the Emerald theme server-rendered.
  const page = await (await fetch(`${appUrl}/demo`)).text();
  assert.match(page, /Dues Membership — Demo Store/);
  assert.match(page, /store-theme/, 'the demo ships its theme in the head');
  assert.match(page, /id="shop"/, 'the storefront carries the shop view');
  // The store page ships exactly these sections, in this order. The retired
  // Home tab must never come back, and a tab appearing here that app.js does
  // not know how to show would be a pane nobody can reach.
  assert.ok(!/data-tab="home"/.test(page), 'no Home tab in the served storefront');
  assert.ok(!/id="shop-pane-home"/.test(page), 'no Home pane in the served storefront');
  assert.deepEqual(
    [...page.matchAll(/<button[^>]*class="shop-tab[^"]*"[^>]*data-tab="([a-z]+)"/g)].map((m) => m[1]),
    ['products', 'reviews', 'about'],
    'the store page ships exactly the Products, Reviews and About tabs, in that order',
  );
  const demoProd = await (await fetch(`${appUrl}/demo/vip-access`)).text();
  assert.match(demoProd, /VIP Access — Dues Membership/, 'demo product links carry product previews');
  // /store/<slug> is the same overall URL, everywhere.
  const red = await fetch(`${appUrl}/store/demo`, { redirect: 'manual' });
  assert.equal(red.status, 308);
  assert.equal(red.headers.get('location'), '/demo', '/store/<slug> redirects to the overall URL');
  // The plans payload is fixed, flagged, and never touches the database.
  const plans = await (await fetch(`${appUrl}/api/plans?store=demo`)).json();
  assert.equal(plans.brand, 'Dues Membership');
  assert.equal(plans.capabilities.demo, true, 'the client needs the demo flag to disarm pay');
  assert.equal(plans.capabilities.stripe, true, 'the checkout still renders fully');
  assert.deepEqual(plans.plans.map((p) => p.priceUsd), [49.99, 14.99, 79.99]);
  // The demo wears the SIGNATURE BLACK — what a Dues store looks like out of
  // the box. Not a preset backdrop: dressing the demo in one advertised a look
  // that a new store does not actually arrive wearing.
  assert.equal(plans.store.theme.bg, '#0a0a0a', 'the demo store wears the signature black');
  assert.equal(plans.store.theme.panel, '#101010');
  assert.equal(plans.store.theme.bgPreset, '', 'the demo has no custom background');
  assert.equal(plans.store.theme.material, 'glass');
  assert.equal(plans.store.links.website, 'https://dues.gg');
  assert.equal(plans.store.memberCount, 134);
  assert.match(plans.store.about, /invite Dues/i);
  // The demo's one discount code previews like a real one.
  const d = await (await fetch(`${appUrl}/api/discount?store=demo&code=LAUNCH20&plan=vip-access`)).json();
  assert.equal(d.discountedUsd, 39.99, 'LAUNCH20 takes 20% off the demo product');
  assert.equal((await fetch(`${appUrl}/api/discount?store=demo&code=NOPE&plan=vip-access`)).status, 404);
  // Nothing can be bought: checkout refuses the slug like any unknown store.
  const co = await fetch(`${appUrl}/api/checkout/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId: 'vip-access', store: 'demo' }),
  });
  assert.ok(co.status >= 400, `demo checkout must refuse (got ${co.status})`);
});

// The store-page login dance, repeated by the scenarios below exactly as the
// ones above spell it out.
const loginAsUser = async (code) => {
  const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const st = new URL(login.headers.get('location')).searchParams.get('state');
  const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${st}`, {
    redirect: 'manual',
    headers: { cookie: sc.split(';')[0] },
  });
  return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
};

test('store banners: uploaded media serves from /api/img, beats a pasted link, survives a rename', async () => {
  const u7Cookie = await loginAsUser('code_u7');
  const storeCall = (slug, body) =>
    fetch(`${appUrl}/api/admin/store`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: u7Cookie },
      body: JSON.stringify({ store: slug, ...body }),
    });
  const publicStore = async (slug) => (await (await fetch(`${appUrl}/api/plans?store=${slug}`)).json()).store;
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const MP4 = 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=';
  // The earlier settings scenario left a pasted banner link on this store.
  assert.equal((await publicStore('vip-signals')).bannerUrl, 'https://cdn.e2e.test/banner.png');

  // The whitelist IS the content-type /api/img echoes back under nosniff, so
  // anything outside it is refused before a byte is written.
  assert.equal((await storeCall('vip-signals', { bannerData: 'data:image/png;base64,@@@' })).status, 400);
  assert.equal((await storeCall('vip-signals', { bannerData: 'data:text/html;base64,PHNjcmlwdD4=' })).status, 400);
  assert.equal((await fetch(`${appUrl}/api/img?store=vip-signals&kind=banner`)).status, 404, 'a refused upload stored nothing');

  const up = await storeCall('vip-signals', { bannerData: `data:image/png;base64,${PNG}` });
  const upBody = await up.text();
  assert.equal(up.status, 200, upBody);
  const echo = JSON.parse(upBody).store;
  assert.equal(echo.hasBannerUpload, true, 'the echo carries every editable field or the form wipes it');
  assert.equal(echo.bannerKind, 'image');
  assert.equal(echo.bannerUrl, 'https://cdn.e2e.test/banner.png', 'the pasted link is kept, not clobbered by an upload');

  const pub = await publicStore('vip-signals');
  assert.match(pub.bannerUrl, /\/api\/img\?store=vip-signals&kind=banner&v=\d+$/, 'the storefront gets a ready-to-use URL');
  assert.equal(pub.bannerKind, 'image');
  // The directory resolves the banner the same way the storefront does. It
  // used to read the raw column, so an uploaded banner showed as none there.
  const listed = (await (await fetch(`${appUrl}/api/discover?fresh=1`)).json()).stores
    .find((x) => x.slug === 'vip-signals');
  assert.ok(listed, 'the opted-in store is in the directory');
  assert.equal(listed.bannerUrl, pub.bannerUrl, 'the directory serves the upload, not the pasted link');
  assert.equal(listed.bannerKind, 'image');

  const served = await fetch(pub.bannerUrl.replace('https://tradeleaks.e2e', appUrl));
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(await served.arrayBuffer()).toString('base64'), PNG, 'served bytes match the upload');
  // Link previews lead with the banner the owner chose for the page.
  const shared = await (await fetch(`${appUrl}/vip-signals`)).text();
  assert.match(shared, /property="og:image" content="[^"]*kind=banner/, 'the banner fronts the store unfurl');

  // Uploads the whitelist accepts must actually be deliverable: a 1.2MB
  // banner puts the JSON body well over the 1 MiB ceiling every other route
  // keeps, and under the dev shim (which reads the stream itself) that ceiling
  // is what rejected them.
  const BIG = 'A'.repeat(1_600_000);
  assert.ok(BIG.length + 22 <= 2_000_000, 'the test payload stays inside the whitelist cap');
  assert.equal((await storeCall('vip-signals', { bannerData: `data:image/png;base64,${BIG}` })).status, 200, 'an upload over 1 MiB is deliverable');
  const bigServed = await fetch(`${appUrl}/api/img?store=vip-signals&kind=banner`);
  assert.equal(Number(bigServed.headers.get('content-length')), 1_200_000, 'all of it round-trips');
  await bigServed.arrayBuffer();
  assert.equal((await storeCall('vip-signals', { bannerData: `data:image/png;base64,${PNG}` })).status, 200);

  // A rename must not strand any of it: /api/img resolves by slug, so nothing
  // about these URLs is stored — banner and product photo alike are minted
  // from whatever link the store carries right now.
  const storeId = Number((await tq("SELECT id FROM stores WHERE slug = 'vip-signals'")).rows[0].id);
  const target = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans.find((p) => !p.variantOf);
  const productCall = (body) =>
    fetch(`${appUrl}/api/onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: u7Cookie },
      body: JSON.stringify({ step: 'product-update', storeId, planKey: target.id, ...body }),
    });
  assert.equal((await productCall({ imageData: `data:image/png;base64,${PNG}` })).status, 200);
  assert.equal((await storeCall('vip-signals', { slug: 'vip-elite' })).status, 200);
  assert.match((await publicStore('vip-elite')).bannerUrl, /\/api\/img\?store=vip-elite&kind=banner/);
  assert.equal((await fetch(`${appUrl}/api/img?store=vip-elite&kind=banner`)).status, 200, 'the renamed store still serves its banner');
  const movedPhoto = (await (await fetch(`${appUrl}/api/plans?store=vip-elite`)).json()).plans.find((p) => p.id === target.id).imageUrl;
  assert.match(movedPhoto, /\/api\/img\?store=vip-elite&plan=/, 'product photos follow the store to its new link');
  assert.equal((await fetch(movedPhoto.replace('https://tradeleaks.e2e', appUrl))).status, 200, 'and still serve there');
  assert.equal((await storeCall('vip-elite', { slug: 'vip-signals' })).status, 200);
  assert.equal((await productCall({ imageData: null })).status, 200);

  // A short clip is a banner too — same endpoint, so Safari's byte ranges are
  // answered for free, but an unfurler never gets handed an mp4.
  assert.equal((await storeCall('vip-signals', { bannerData: `data:video/mp4;base64,${MP4}` })).status, 200);
  assert.equal((await publicStore('vip-signals')).bannerKind, 'video');
  const ranged = await fetch(`${appUrl}/api/img?store=vip-signals&kind=banner`, { headers: { range: 'bytes=0-9' } });
  assert.equal(ranged.status, 206, 'byte ranges answered');
  assert.equal((await ranged.arrayBuffer()).byteLength, 10);
  assert.equal(ranged.headers.get('content-type'), 'video/mp4');
  const sharedVid = await (await fetch(`${appUrl}/vip-signals`)).text();
  assert.ok(!/property="og:image" content="[^"]*kind=banner/.test(sharedVid), 'og:image skips video banners');

  // Three states: '' clears back to the pasted link, and an unrelated save
  // leaves the banner exactly where it was.
  assert.equal((await storeCall('vip-signals', { bannerData: '' })).status, 200);
  const cleared = await publicStore('vip-signals');
  assert.equal(cleared.bannerUrl, 'https://cdn.e2e.test/banner.png', 'clearing the upload falls back to the pasted link');
  assert.equal(cleared.bannerKind, 'image');
  assert.equal((await fetch(`${appUrl}/api/img?store=vip-signals&kind=banner`)).status, 404, 'a cleared banner is gone');
  assert.equal(
    (await (await fetch(`${appUrl}/api/discover?fresh=1`)).json()).stores.find((x) => x.slug === 'vip-signals').bannerUrl,
    'https://cdn.e2e.test/banner.png',
    'the directory falls back to the pasted link too',
  );
  assert.equal((await storeCall('vip-signals', { bannerData: `data:image/png;base64,${PNG}` })).status, 200);
  assert.equal((await storeCall('vip-signals', { description: 'The alpha desk.' })).status, 200);
  assert.equal((await fetch(`${appUrl}/api/img?store=vip-signals&kind=banner`)).status, 200, 'an unrelated save must not drop the banner');

  // The dashboard re-renders its settings form from /api/admin/payments.
  const dash = await (await fetch(`${appUrl}/api/admin/payments?store=vip-signals`, { headers: { cookie: u7Cookie } })).json();
  const dstore = dash.stores.find((s) => s.slug === 'vip-signals');
  assert.equal(dstore.hasBannerUpload, true, 'dashboard payload knows an upload exists');
  assert.equal(dstore.bannerKind, 'image');
  assert.match(dstore.bannerImageUrl, /kind=banner/, 'dashboard payload carries the resolved banner');
  assert.equal(dstore.bannerUrl, 'https://cdn.e2e.test/banner.png', 'the URL field still gets the pasted link');
  assert.ok(!JSON.stringify(dash).includes('base64'), 'the upload itself never rides a list payload');

  // Stores with no row of their own have nowhere to hang media.
  assert.equal((await fetch(`${appUrl}/api/img?store=tradeleaks&kind=banner`)).status, 404);
  assert.equal((await publicStore('demo')).bannerKind, null);
  assert.equal((await fetch(`${appUrl}/api/img?store=vip-signals`)).status, 400, 'a plan-less, kind-less request is still a bad request');
});

test('store reviews: bought-only, seller cannot subtract, all-or-nothing switch, honest aggregates', async () => {
  const U7 = '507700000000000007'; // the vip-signals owner
  const U8 = '508800000000000008'; // a real buyer of vip-signals
  const U14 = '514400000000000014'; // never bought anything here
  const u7Cookie = await loginAsUser('code_u7');
  const u8Cookie = await loginAsUser('code_u8');
  const u14Cookie = await loginAsUser('code_u14');
  const post = (cookie, body) =>
    fetch(`${appUrl}/api/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const list = async (cookie) =>
    (await (await fetch(`${appUrl}/api/reviews?store=vip-signals`, { headers: cookie ? { cookie } : {} })).json());
  const publicStore = async (slug) => (await (await fetch(`${appUrl}/api/plans?store=${slug}`)).json()).store;
  const storeCall = (body) =>
    fetch(`${appUrl}/api/admin/store`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: u7Cookie },
      body: JSON.stringify({ store: 'vip-signals', ...body }),
    });
  const storeId = Number((await tq("SELECT id FROM stores WHERE slug = 'vip-signals'")).rows[0].id);
  const rowCount = async () => Number((await tq('SELECT COUNT(*) AS n FROM store_reviews WHERE store_id = ?', [storeId])).rows[0].n);

  // Signed out cannot write; an unknown action is refused.
  assert.equal((await post(null, { store: 'vip-signals', rating: 5 })).status, 401);
  assert.equal((await post(u8Cookie, { store: 'vip-signals', action: 'sabotage' })).status, 400);

  // THE GATE. U14 has never paid this store, so no rating they submit exists.
  const stranger = await post(u14Cookie, { store: 'vip-signals', rating: 5, body: 'amazing!!' });
  assert.equal(stranger.status, 403, 'a non-customer cannot review');
  assert.match((await stranger.json()).error, /bought from this store/);
  assert.equal(await rowCount(), 0, 'and nothing was written');

  // A brand-new purchase is still inside the cooling window.
  await tq('INSERT INTO subscriptions (store_id, discord_id, plan_id, provider, provider_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [storeId, U8, 'vip-access', 'stripe', 'sub_review_e2e', 'active', Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)]);
  assert.equal((await post(u8Cookie, { store: 'vip-signals', rating: 5 })).status, 403, 'reviews open after a cooling period');

  // Age that purchase past the window and the same buyer may speak.
  const old = Math.floor(Date.now() / 1000) - 10 * 24 * 60 * 60;
  await tq('UPDATE subscriptions SET created_at = ? WHERE provider_ref = ?', [old, 'sub_review_e2e']);
  assert.equal((await post(u8Cookie, { store: 'vip-signals', rating: 9 })).status, 400, 'a rating outside 1-5 is not a rating');
  const wrote = await post(u8Cookie, { store: 'vip-signals', rating: 2, body: 'Signals were fine, pace was not for me.' });
  assert.equal(wrote.status, 200);
  const w = await wrote.json();
  assert.equal(w.count, 1);
  assert.equal(w.average, 2);
  assert.equal(w.review.mine, true);
  assert.equal(w.review.author, 'vip_buyer', 'the reviewer is a display name the storefront can print');

  // One review per buyer: writing again EDITS, it does not stack. Timestamps
  // are whole seconds, so age the row first — an edit inside the same second
  // is indistinguishable from the original write, which is true and harmless.
  await tq('UPDATE store_reviews SET created_at = created_at - 60, updated_at = updated_at - 60 WHERE store_id = ?', [storeId]);
  const edited = await post(u8Cookie, { store: 'vip-signals', rating: 4, body: 'Revisited — it clicked.' });
  assert.equal((await edited.json()).count, 1, 'a second write is an edit, not a second vote');
  assert.equal(await rowCount(), 1);
  assert.equal((await list(u8Cookie)).reviews[0].edited, true, 'an edited review says so');

  // A seller cannot review their own store.
  assert.equal((await post(u7Cookie, { store: 'vip-signals', rating: 5 })).status, 409);

  // THE ALL-OR-NOTHING SWITCH. Off by default: the storefront is told the
  // section does not exist, and is handed no subset to draw.
  let pub = await publicStore('vip-signals');
  assert.deepEqual(pub.reviews, { count: 0, average: null, on: false }, 'reviews off reports nothing, not a filtered list');
  assert.deepEqual((await list(null)).reviews, [], 'and the public list is empty while off');
  assert.equal((await list(u14Cookie)).reviews.length, 0, 'a signed-in stranger sees none of it either');
  assert.equal((await list(u8Cookie)).reviews.length, 1, 'but the reviewer can still reach their own words');
  // The seller still sees their own reviews while the display is off — hiding
  // them from the storefront must not hide them from the person they are about.
  assert.equal((await list(u7Cookie)).reviews.length, 1, 'the seller can always read what buyers said');

  assert.equal((await storeCall({ reviewsOn: true })).status, 200);
  pub = await publicStore('vip-signals');
  assert.equal(pub.reviews.on, true);
  assert.equal(pub.reviews.count, 1);
  assert.equal(pub.reviews.average, 4);

  // THE CENTRAL RULE: there is no request a seller can make that removes,
  // hides or reorders ONE review. Every shape of the attempt is refused.
  for (const attempt of [
    { action: 'delete', id: 1 },
    { action: 'remove', id: 1 },
    { action: 'hide', id: 1 },
    { action: 'withdraw', id: 1 },
  ]) {
    await post(u7Cookie, { store: 'vip-signals', ...attempt });
  }
  assert.equal(await rowCount(), 1, 'no seller action of any name subtracts a review');
  assert.equal((await publicStore('vip-signals')).reviews.count, 1);
  // Nor through the settings endpoint.
  await storeCall({ reviews: [], reviewIds: [1], deleteReview: 1 });
  assert.equal(await rowCount(), 1, 'the settings endpoint has no review scalpel either');

  // What a seller CAN do: reply, in public, under the review.
  const replied = await post(u7Cookie, { store: 'vip-signals', action: 'reply', id: (await list(u7Cookie)).reviews[0].id, body: 'Fair — we have split the pace into two channels since.' });
  assert.equal(replied.status, 200);
  assert.match((await list(null)).reviews[0].reply.body, /two channels/);
  // A reply from someone who does not own the store is a 403.
  assert.equal((await post(u8Cookie, { store: 'vip-signals', action: 'reply', id: 1, body: 'nope' })).status, 403);

  // The AUTHOR may withdraw their own words — the one delete that exists.
  assert.equal((await post(u8Cookie, { store: 'vip-signals', action: 'withdraw' })).status, 200);
  assert.equal(await rowCount(), 0);
  const empty = await publicStore('vip-signals');
  assert.equal(empty.reviews.count, 0);
  assert.equal(empty.reviews.average, null, 'no reviews is an average of null, never 0');

  // Nothing without a row of its own is reviewable, and no payload anywhere
  // carries the reviewer's Discord id.
  for (const slug of ['demo', 'tradeleaks', 'no-such-store']) {
    assert.equal((await post(u8Cookie, { store: slug, rating: 5 })).status, 404);
  }
  await post(u8Cookie, { store: 'vip-signals', rating: 5, body: 'back again' });
  const feed = await list(null);
  assert.ok(!JSON.stringify(feed).includes(U8), 'a reviewer is a display name, never a Discord id');
  assert.ok(!JSON.stringify(await publicStore('vip-signals')).includes(U8));

  // The seller's dashboard gets the real aggregate even while the switch is off.
  assert.equal((await storeCall({ reviewsOn: false })).status, 200);
  const dash = await (await fetch(`${appUrl}/api/admin/payments?store=vip-signals`, { headers: { cookie: u7Cookie } })).json();
  const dstore = dash.stores.find((s) => s.slug === 'vip-signals');
  assert.equal(dstore.reviews.count, 1, 'the seller sees the true count regardless of the switch');
  assert.equal(dstore.reviews.average, 5);
  assert.equal(dstore.reviewsOn, false, 'and the dashboard payload carries the switch back to the form');
});

test('store creator and team: seller-authored, validated, and round-tripped to both payloads', async () => {
  const u7Cookie = await loginAsUser('code_u7');
  const storeCall = (body) =>
    fetch(`${appUrl}/api/admin/store`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: u7Cookie },
      body: JSON.stringify({ store: 'vip-signals', ...body }),
    });

  assert.equal((await storeCall({ team: [{ name: '' }] })).status, 400, 'a team member needs a name');
  assert.equal((await storeCall({ team: Array.from({ length: 13 }, (_, i) => ({ name: `M${i}` })) })).status, 400, 'the roster is capped');
  assert.equal((await storeCall({ team: [{ name: 'Alex', handle: 'not a handle!' }] })).status, 400, 'handles are handle-shaped');
  assert.equal((await storeCall({ creatorName: 'x'.repeat(41) })).status, 400);

  const saved = await storeCall({
    creatorName: 'Harshill M',
    teamHeading: 'The desk',
    team: [{ name: 'Alex Rivera', handle: '@alex', title: 'Head of research' }, { name: 'Sam Okoye' }],
  });
  assert.equal(saved.status, 200);
  const echo = (await saved.json()).store;
  assert.equal(echo.creatorName, 'Harshill M');
  assert.equal(echo.team[0].handle, 'alex', 'the @ is stripped once, at the edge');
  assert.equal(echo.team[1].handle, null);
  assert.equal(echo.teamHeading, 'The desk');

  // The storefront payload carries them, and the ORDER the seller chose.
  const pub = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).store;
  assert.deepEqual(pub.team.map((m) => m.name), ['Alex Rivera', 'Sam Okoye']);
  assert.equal(pub.creatorName, 'Harshill M');

  // And so does the payload the dashboard re-renders its form from — the
  // field-wipe trap: a field missing here comes back blank and the next save
  // erases it.
  const dash = await (await fetch(`${appUrl}/api/admin/payments?store=vip-signals`, { headers: { cookie: u7Cookie } })).json();
  const d = dash.stores.find((s) => s.slug === 'vip-signals');
  assert.equal(d.creatorName, 'Harshill M');
  assert.equal(d.team.length, 2);
  assert.equal(d.teamHeading, 'The desk');

  // Clearing is explicit and works.
  assert.equal((await storeCall({ team: [], creatorName: '' })).status, 200);
  assert.equal((await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).store.team, null, 'an empty team is absent, not an empty block');
});

test('following a store: signed-in only, idempotent, counts only, owner refused, rate-limited', async () => {
  const U7 = '507700000000000007'; // the vip-signals owner
  const U8 = '508800000000000008'; // a buyer
  const U14 = '514400000000000014'; // owns nothing right now; G3 is free
  const u7Cookie = await loginAsUser('code_u7');
  const u8Cookie = await loginAsUser('code_u8');
  const u14Cookie = await loginAsUser('code_u14');
  const follow = (cookie, body) =>
    fetch(`${appUrl}/api/follow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const me = async (cookie) => (await (await fetch(`${appUrl}/api/me`, { headers: { cookie } })).json());
  const publicStore = async (slug) => (await (await fetch(`${appUrl}/api/plans?store=${slug}`)).json()).store;
  const storeId = Number((await tq("SELECT id FROM stores WHERE slug = 'vip-signals'")).rows[0].id);
  const ledger = async (id) => Number((await tq('SELECT COUNT(*) AS n FROM store_follows WHERE store_id = ?', [id])).rows[0].n);

  // Signed out is a 401 with the words the button shows; GET is not a way in.
  const anon = await follow(null, { store: 'vip-signals', action: 'follow' });
  assert.equal(anon.status, 401);
  assert.deepEqual(await anon.json(), { error: 'sign in first' });
  assert.equal((await fetch(`${appUrl}/api/follow`, { headers: { cookie: u8Cookie } })).status, 405);
  assert.equal((await follow(u8Cookie, { store: 'vip-signals', action: 'sabotage' })).status, 400);

  // Follow, then follow again: one ledger row, one follower, same answer.
  const first = await follow(u8Cookie, { store: 'vip-signals', action: 'follow' });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, store: 'vip-signals', following: true, followers: 1 });
  assert.equal((await (await follow(u8Cookie, { store: 'vip-signals', action: 'follow' })).json()).followers, 1, 'a double tap is not a second follower');
  assert.equal(await ledger(storeId), 1, 'exactly one row after two follows');

  // The public payload carries the COUNT and never who it is made of.
  const pub = await publicStore('vip-signals');
  assert.equal(pub.followers, 1, 'the number is COUNT(*), computed server-side');
  assert.equal(pub.followable, true);
  assert.ok(!JSON.stringify(pub).includes(U8), 'no client is ever handed a roster of who follows a store');
  // The caller's own list is the one caller-scoped piece, and it is slugs.
  assert.deepEqual((await me(u8Cookie)).following, ['vip-signals']);
  assert.deepEqual((await me(u14Cookie)).following, [], 'following is per caller, not global');

  // Unfollow is idempotent the same way — unfollowing nothing is not an error.
  assert.equal((await (await follow(u8Cookie, { store: 'vip-signals', action: 'unfollow' })).json()).followers, 0);
  const twice = await follow(u8Cookie, { store: 'vip-signals', action: 'unfollow' });
  assert.equal(twice.status, 200);
  assert.deepEqual(await twice.json(), { ok: true, store: 'vip-signals', following: false, followers: 0 });
  assert.equal(await ledger(storeId), 0);

  // A seller padding their own store 0 → 1 is the number nobody should trust.
  assert.equal((await follow(u7Cookie, { store: 'vip-signals', action: 'follow' })).status, 409);
  assert.equal((await publicStore('vip-signals')).followers, 0, 'refused, and the count stays honest');

  // Nothing without a database row of its own is followable.
  for (const slug of ['demo', 'tradeleaks', 'no-such-store', 'NOT A SLUG']) {
    assert.equal((await follow(u8Cookie, { store: slug, action: 'follow' })).status, 404, `"${slug}" must not be followable`);
  }
  for (const slug of ['demo', 'tradeleaks']) {
    const s = await publicStore(slug);
    assert.equal(s.followers, null, `${slug} reports null, never 0 — there is no store to count`);
    assert.equal(s.followable, false);
  }

  // The owner's own dashboard gets the exact number, 0 included.
  const dashAt = async (cookie, slug) =>
    (await (await fetch(`${appUrl}/api/admin/payments?store=${slug}`, { headers: { cookie } })).json()).stores.find((s) => s.slug === slug);
  assert.equal((await dashAt(u7Cookie, 'vip-signals')).followers, 0, 'the seller sees 0 rather than a hidden number');
  assert.equal((await follow(u8Cookie, { store: 'vip-signals', action: 'follow' })).status, 200);
  const dstore = await dashAt(u7Cookie, 'vip-signals');
  assert.equal(dstore.followers, 1);
  assert.ok(!JSON.stringify(dstore).includes(U8), 'the dashboard gets a count, never a roster');

  // The ledger is keyed on the store row, so a rename carries the follow with
  // it — including in the follower's own list.
  const rename = (slug, to) =>
    fetch(`${appUrl}/api/admin/store`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: u7Cookie },
      body: JSON.stringify({ store: slug, slug: to }),
    });
  assert.equal((await rename('vip-signals', 'vip-elite')).status, 200);
  assert.equal((await publicStore('vip-elite')).followers, 1, 'follows survive a slug rename');
  assert.deepEqual((await me(u8Cookie)).following, ['vip-elite'], 'the list names the store as it is now');
  assert.equal((await rename('vip-elite', 'vip-signals')).status, 200);

  // Rate limit, counted from the ledger itself: 20 follows a minute per
  // account. Twenty rows backdated to now stand in for the flood.
  const t = nowSec();
  for (let i = 0; i < 20; i += 1) {
    await tq('INSERT INTO store_follows (store_id, follower_discord_id, created_at) VALUES (?, ?, ?)', [990000 + i, U8, t]);
  }
  assert.equal((await follow(u8Cookie, { store: 'vip-signals', action: 'follow' })).status, 429);
  await tq('DELETE FROM store_follows WHERE follower_discord_id = ? AND store_id >= ?', [U8, 990000]);
  assert.equal((await follow(u8Cookie, { store: 'vip-signals', action: 'follow' })).status, 200, 'the window is the ledger, so clearing it clears the block');
  // A row already inside the window costs nothing to re-follow.
  assert.equal(await ledger(storeId), 1);

  // Deleting a store takes its follows with it — no orphan rows, and the link
  // stops being followable the moment the store is gone.
  const made = await fetch(`${appUrl}/api/onboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u14Cookie },
    body: JSON.stringify({ step: 'store', guildId: G3, name: 'Trade Hub Followed', stripeKey: OWNER2_KEY }),
  });
  assert.equal(made.status, 200, await made.clone().text());
  const fresh = (await made.json()).store;
  assert.equal((await (await follow(u8Cookie, { store: fresh.slug, action: 'follow' })).json()).followers, 1);
  assert.equal(await ledger(Number(fresh.id)), 1);
  const del = await fetch(`${appUrl}/api/admin/store`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u14Cookie },
    body: JSON.stringify({ store: fresh.slug, action: 'delete' }),
  });
  assert.equal(del.status, 200, await del.text());
  assert.equal(await ledger(Number(fresh.id)), 0, 'a deleted store leaves no follow rows behind');
  assert.equal((await follow(u8Cookie, { store: fresh.slug, action: 'follow' })).status, 404);
  assert.deepEqual((await me(u8Cookie)).following, ['vip-signals'], 'the deleted store drops out of the follower list');
});

test('crypto address validation refuses a plausible address on the wrong chain', async () => {
  const { validateAddress } = await import('../src/lib/crypto-address.js');
  // A real EIP-55 address, and the same address with one character re-cased.
  assert.equal(validateAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'eth').ok, true);
  assert.equal(validateAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD', 'eth').ok, false);
  // Bitcoin's own genesis address is not a Litecoin address: same encoding,
  // different version byte, and paying out to it would be unrecoverable.
  assert.equal(validateAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'btc').ok, true);
  assert.equal(validateAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'ltc').ok, false);
  assert.equal(validateAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'btc').ok, true);
  assert.equal(validateAddress('TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', 'usdttrc20').ok, true);
  assert.equal(validateAddress('TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSF', 'usdttrc20').ok, false);
  // A chain nobody here can check is stored, but never CLAIMED as checked —
  // that difference is what the settings form turns into a confirm step.
  const unknown = validateAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'somenewchain');
  assert.deepEqual({ ok: unknown.ok, verified: unknown.verified }, { ok: true, verified: false });
});

// The crypto rail, end to end: the seller sets a payout wallet, a buyer pays
// in a coin they picked, and roles land only when the money actually finished.
let npCookie; // the vip-signals owner
let npBuyerCookie;
let npOrder;
const NP_BUYER = '515000000000000015';
const SOL_WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

async function signInAs(code, uid, username) {
  discord.oauthUsers[code] = { id: uid, username };
  const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  const stateCookie = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
  const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${state}`, {
    redirect: 'manual',
    headers: { cookie: stateCookie.split(';')[0] },
  });
  return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
}

const npStore = (body, cookie) =>
  fetch(`${appUrl}/api/admin/store`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ store: 'vip-signals', ...body }),
  });

test('crypto: a store with no payout wallet offers no crypto and refuses to start one', async () => {
  npCookie = await signInAs('code_u7_np', '507700000000000007', 'vip_owner');
  npBuyerCookie = await signInAs('code_u15', NP_BUYER, 'crypto_buyer');

  const caps = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).capabilities;
  assert.equal(caps.nowpayments, false, 'credentials alone must not offer a rail with nowhere to send the money');
  const coins = await (await fetch(`${appUrl}/api/checkout/crypto?coins=1&store=vip-signals`)).json();
  assert.deepEqual(coins, { ready: false, coins: [] });

  const plans = await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json();
  const planId = plans.plans[0].id;
  const start = await fetch(`${appUrl}/api/checkout/crypto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: npBuyerCookie },
    body: JSON.stringify({ store: 'vip-signals', planId, payCurrency: 'sol' }),
  });
  assert.equal(start.status, 409, 'no wallet, no payment — never a payment into the platform balance');
  assert.equal(nowpayments.created.length, 0, 'the provider must not have been called at all');
});

test('crypto: the payout wallet is checksum-checked and has to be typed twice', async () => {
  // Wrong chain for the address: a Solana address in an unrelated field.
  const wrongChain = await npStore({ cryptoWallet: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', cryptoChain: 'sol' }, npCookie);
  assert.equal(wrongChain.status, 400);
  assert.match((await wrongChain.json()).error, /Solana/);

  // A coin the merchant account does not have enabled.
  const offCoin = await npStore({ cryptoWallet: SOL_WALLET, cryptoChain: 'doge' }, npCookie);
  assert.equal(offCoin.status, 400, 'payouts can only go out in a coin the account can actually send');

  // Right address, right chain, no confirmation: refused, and told why.
  const unconfirmed = await npStore({ cryptoWallet: SOL_WALLET, cryptoChain: 'sol' }, npCookie);
  assert.equal(unconfirmed.status, 409);
  assert.equal((await unconfirmed.json()).needsConfirm, true);

  // Confirmation that does not match is exactly the typo this step exists for.
  const mistyped = await npStore(
    { cryptoWallet: SOL_WALLET, cryptoChain: 'sol', cryptoWalletConfirm: `${SOL_WALLET.slice(0, -1)}N` },
    npCookie,
  );
  assert.equal(mistyped.status, 409);

  const saved = await npStore(
    { cryptoWallet: SOL_WALLET, cryptoChain: 'sol', cryptoWalletConfirm: SOL_WALLET },
    npCookie,
  );
  assert.equal(saved.status, 200, await saved.clone().text());
  const echoed = (await saved.json()).store;
  assert.deepEqual(
    { cryptoWallet: echoed.cryptoWallet, cryptoChain: echoed.cryptoChain },
    { cryptoWallet: SOL_WALLET, cryptoChain: 'sol' },
    'the settings form repopulates from this response — a field missing here gets wiped on the next save',
  );

  // Only a store owner may point their own payouts somewhere else.
  const notMine = await npStore({ cryptoWallet: SOL_WALLET, cryptoChain: 'sol', cryptoWalletConfirm: SOL_WALLET }, npBuyerCookie);
  assert.equal(notMine.status, 403, 'a payout address is the one field a stranger must never be able to move');
});

test('crypto: checkout creates a payment carrying the payout address and its own callback url', async () => {
  const caps = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).capabilities;
  assert.equal(caps.nowpayments, true, 'a wallet plus credentials is what turns the rail on');

  const coins = await (await fetch(`${appUrl}/api/checkout/crypto?coins=1&store=vip-signals`)).json();
  assert.equal(coins.ready, true);
  assert.deepEqual(coins.coins, ['sol', 'usdtsol', 'btc', 'eth'], 'tickers arrive lowercased and cheapest chains first');

  const plans = await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json();
  const plan = plans.plans[0];

  // A coin the merchant has not enabled never reaches the provider.
  const offCoin = await fetch(`${appUrl}/api/checkout/crypto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: npBuyerCookie },
    body: JSON.stringify({ store: 'vip-signals', planId: plan.id, payCurrency: 'doge' }),
  });
  assert.equal(offCoin.status, 400);

  // Logged out, there is nobody to give the roles to.
  const anon = await fetch(`${appUrl}/api/checkout/crypto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ store: 'vip-signals', planId: plan.id, payCurrency: 'sol' }),
  });
  assert.equal(anon.status, 401);

  const res = await fetch(`${appUrl}/api/checkout/crypto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: npBuyerCookie },
    body: JSON.stringify({ store: 'vip-signals', planId: plan.id, payCurrency: 'sol' }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const order = await res.json();
  assert.match(order.orderId, /^np_[0-9a-f]{32}$/);
  assert.equal(order.payAddress, 'ADDR_npid_1');
  assert.equal(order.payCurrency, 'SOL');

  const sent = nowpayments.created.at(-1);
  assert.equal(sent.payout_address, SOL_WALLET, 'every payment must name the seller wallet — this is the custody guarantee');
  assert.equal(sent.payout_currency, 'sol');
  assert.equal(sent.ipn_callback_url, 'https://tradeleaks.e2e/api/webhooks/nowpayments', 'there is no IPN field in the dashboard, so it rides on every create');
  assert.equal(sent.price_amount, plan.priceUsd);
  assert.equal(sent.order_id, order.orderId);

  // The order row exists BEFORE any money can move — it is the only mapping
  // back from an IPN to which buyer bought what.
  const { rows } = await tq('SELECT * FROM checkout_attempts WHERE session_id = ?', [order.orderId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].discord_id, NP_BUYER);
  assert.equal(rows[0].provider_ref, 'npid_1');
  npOrder = order;
});

test('crypto: the pay QR decodes back to the exact payment address', async () => {
  // A QR is the one control on this page nobody proofreads. If it encodes
  // anything but the address, a scan sends the money somewhere unrecoverable
  // and the address printed underneath it looks perfectly fine. So the check
  // is a real decode by an independent library, not a "did we render an svg".
  const [{ qrSvg, qrForPayment }, jsQR, { PNG }] = await Promise.all([
    import('../src/lib/qr.js'),
    import('jsqr').then((m) => m.default ?? m),
    import('pngjs'),
  ]);
  const addr = '9Wscg7HtjJtGxqqTRzXJEVX2NFJcaDSoWnztEVSV3hBQ';

  // Rasterise the SVG's own module grid rather than shelling out to a
  // renderer: same bits the browser paints, no image toolchain in the suite.
  const decode = (text) => {
    const svg = qrSvg(text);
    const span = Number(svg.match(/viewBox="0 0 (\d+)/)[1]);
    const S = 4;
    const W = span * S;
    const png = new PNG({ width: W, height: W });
    png.data.fill(255);
    for (const seg of svg.match(/M[\d.]+ [\d.]+h\d+v1h-\d+z/g) ?? []) {
      const [, x, y, run] = seg.match(/M([\d.]+) ([\d.]+)h(\d+)/).map(Number.parseFloat ? (v, i) => (i ? Number(v) : v) : Number);
      for (let dy = 0; dy < S; dy += 1) {
        for (let dx = 0; dx < run * S; dx += 1) {
          const i = ((y * S + dy) * W + (x * S + dx)) << 2;
          png.data[i] = png.data[i + 1] = png.data[i + 2] = 0;
          png.data[i + 3] = 255;
        }
      }
    }
    return jsQR(new Uint8ClampedArray(png.data), W, W)?.data ?? null;
  };

  assert.equal(decode(addr), addr, 'a Solana address must survive the round trip byte for byte');
  assert.equal(decode('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
  assert.equal(decode('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'mixed case must not be mangled — an EIP-55 address is case-significant');

  // Memo chains get no QR at all: a scan hands over the address and silently
  // drops the tag, and without the tag the payment cannot be credited.
  assert.equal(qrForPayment({ address: addr, extraId: '4821990' }), null);
  assert.equal(typeof qrForPayment({ address: addr, extraId: null }), 'string');
});

test('crypto: an unsigned or wrongly signed IPN grants nothing', async () => {
  const payload = { payment_id: 'npid_1', payment_status: 'finished', order_id: npOrder.orderId };
  assert.equal((await deliverNow(payload, { signature: 'deadbeef' })).status, 400);
  assert.equal((await deliverNow(payload, { signature: signNow(payload, 'the-wrong-secret') })).status, 400);
  assert.equal(await subRow('nowpayments', 'npid_1'), null, 'nothing may be granted on an unverified delivery');
});

test('crypto: waiting and partially_paid show progress and grant nothing', async () => {
  const payment = nowpayments.payments.get('npid_1');
  assert.equal((await deliverNow({ payment_id: 'npid_1', payment_status: 'waiting', order_id: npOrder.orderId })).status, 200);
  assert.equal(await subRow('nowpayments', 'npid_1'), null);

  // Short by more than the account's covering tolerance: NOWPayments reports
  // partially_paid, and partially_paid is a buyer who still owes money.
  payment.payment_status = 'partially_paid';
  payment.actually_paid = 0.35;
  payment.actually_paid_at_fiat = Number((payment.price_amount * 0.7).toFixed(2));
  assert.equal((await deliverNow({ payment_id: 'npid_1', payment_status: 'partially_paid', order_id: npOrder.orderId })).status, 200);
  assert.equal(await subRow('nowpayments', 'npid_1'), null, 'a short payment is not a sale');

  // The buyer's own pay screen tells them the shortfall in the money the
  // order is priced in, which is true whichever coin actually turned up.
  const view = await (await fetch(`${appUrl}/api/checkout/crypto?store=vip-signals&order=${npOrder.orderId}`, {
    headers: { cookie: npBuyerCookie },
  })).json();
  assert.equal(view.state, 'short');
  assert.match(view.message, /still outstanding/);
  assert.match(view.message, /SOL/, 'same-coin shortfalls can also be quoted in the coin');

  // Somebody else's order is not readable, however guessable the id is.
  const other = await fetch(`${appUrl}/api/checkout/crypto?store=vip-signals&order=${npOrder.orderId}`, {
    headers: { cookie: npCookie },
  });
  assert.equal(other.status, 404);
});

test('crypto: a wrong-asset deposit is judged on fiat, never on the coin that was asked for', async () => {
  const payment = nowpayments.payments.get('npid_1');
  // Wrong-asset auto-processing is ON for this account: what arrived is not
  // pay_currency, so actually_paid and actually_paid_at_fiat disagree.
  payment.actually_paid = 0.35;
  payment.actually_paid_at_fiat = Number((payment.price_amount * 0.4).toFixed(2));
  const { describeStatus, settledFiat } = await import('../src/lib/nowpayments.js');
  const short = describeStatus(payment, { currency: 'usd' });
  assert.equal(short.state, 'short');
  assert.doesNotMatch(
    short.message,
    /SOL/,
    'telling someone who paid in another coin to send more SOL is worse than saying nothing',
  );
  assert.equal(settledFiat(payment), payment.actually_paid_at_fiat);
});

test('crypto: finished grants a fixed term, and the same IPN twice grants once', async () => {
  const payment = nowpayments.payments.get('npid_1');
  payment.payment_status = 'finished';
  payment.actually_paid = 0.5;
  payment.actually_paid_at_fiat = payment.price_amount;
  const ipn = { payment_id: 'npid_1', payment_status: 'finished', order_id: npOrder.orderId, actually_paid: 0.5 };

  const first = await deliverNow(ipn);
  assert.equal(first.status, 200);
  await waitFor('the crypto grant to land', async () => (await subRow('nowpayments', 'npid_1')) !== null);
  const row = await subRow('nowpayments', 'npid_1');
  assert.equal(row.status, 'active');
  assert.equal(row.discord_id, NP_BUYER);
  assert.ok(memberRoles(NP_BUYER).has(R2_VIP), 'the role is the product — it has to be on the member');
  assert.equal(
    (await tq('SELECT status FROM checkout_attempts WHERE session_id = ?', [npOrder.orderId])).rows[0].status,
    'completed',
  );

  // Replayed byte-for-byte: NOWPayments has no replay protection of its own,
  // so the claim is what stops a captured delivery being replayed forever.
  const again = await deliverNow(ipn);
  assert.equal(again.status, 200);
  assert.equal(again.body, 'duplicate');

  // A term that renews itself is the one thing crypto cannot do.
  const plans = await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json();
  if (!plans.plans[0].lifetime) {
    assert.notEqual(row.current_period_end, null, 'a crypto term must expire — nothing will charge again');
  }
});

test('crypto: an IPN whose order is not ours is answered, and grants nothing', async () => {
  nowpayments.payments.set('npid_stranger', {
    payment_id: 'npid_stranger',
    payment_status: 'finished',
    order_id: 'np_ffffffffffffffffffffffffffffffff',
    price_amount: 49.99,
    price_currency: 'usd',
    pay_currency: 'sol',
  });
  const res = await deliverNow({ payment_id: 'npid_stranger', payment_status: 'finished', order_id: 'np_ffffffffffffffffffffffffffffffff' });
  assert.equal(res.status, 200);
  assert.equal(await subRow('nowpayments', 'npid_stranger'), null);
});

// ═══ runner ═══════════════════════════════════════════════════════════════════

async function main() {
  await initTestDb();
  const [discordMock, stripeMock, coinbaseMock, resendMock, nowMock] = await Promise.all([
    startMock('discord', discordHandler),
    startMock('stripe', stripeHandler),
    startMock('coinbase', coinbaseHandler),
    startMock('resend', resendHandler),
    startMock('nowpayments', nowpaymentsHandler),
  ]);
  const mocks = { discord: discordMock, stripe: stripeMock, coinbase: coinbaseMock, resend: resendMock, nowpayments: nowMock };

  // Phase 1: full configuration (Stripe + Coinbase) — the main scenario ladder.
  phase1Env = {
    ...baseEnv(mocks),
    COINBASE_API_KEY: 'cb_key_e2e',
    COINBASE_WEBHOOK_SECRET: COINBASE_SECRET,
    COINBASE_API_BASE: coinbaseMock.url,
    NOWPAYMENTS_API_KEY: NOW_KEY,
    NOWPAYMENTS_IPN_SECRET: NOW_IPN_SECRET,
    NOWPAYMENTS_API_BASE: nowMock.url,
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
      assert.deepEqual(capabilities, { stripe: true, crypto: false, nowpayments: false });
      const npSolo = await fetch(`${solo.url}/api/checkout/crypto?coins=1&store=tradeleaks`);
      assert.equal(npSolo.status, 501, 'the crypto rail must be dormant without NOWPayments credentials');
      const npWh = await deliverNow({ payment_id: 'npid_solo', payment_status: 'finished' }, { base: solo.url });
      assert.equal(npWh.status, 501, 'the nowpayments webhook must be dormant without credentials');
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
  for (const { server } of [discordMock, stripeMock, coinbaseMock, resendMock, nowMock]) server.close();

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
