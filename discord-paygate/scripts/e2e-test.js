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
import { spawn, spawnSync } from 'node:child_process';
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
const COMMUNITY_INVITE = 'https://discord.gg/e2e-community'; // one setting; these are its request-time readers (site hop + receipt footer)
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
  failMemberGetsFor: new Set(), // uids whose GET member answers 500 — Discord down, not "they left"
  extraRoles: [],               // appended to the role list (e.g. a same-named decoy)
  kickedFrom: null,             // a guild id the bot was removed from: every guild route answers as Discord does then
  kickedMemberGets: 0,          // GET member calls that hit the kicked guild
  phantomJoinsFor: new Set(),   // uids whose guilds.join answers 204 "already a member" while GET member keeps 404ing
  phantomJoins: 0,
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
  delayCheckoutSessionsMs: 0,   // how long POST /v1/checkout/sessions takes to answer — the window a
                                // checkout's reservation has to survive, and what makes the two-buyers
                                // -at-once scenario a real race rather than a coincidence
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
const nowpayments = { created: [], payments: new Map(), n: 0, minAmount: [], delayCreateMs: 0 };
// How long a created payment can be paid for. The provider freezes the rate on
// the fixed-rate, fee-paid-by-user flow this rail always asks for "for 10
// minutes. If there are no incoming payments during this period, the payment
// status changes to 'expired'." A mock that never expired anything is why a
// ten-minute invoice could be held for seven days with nothing to catch it.
const NP_VALID_FOR_MS = 10 * 60_000;
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

// The live role list per guild, as the doctor and the grant path see it. G2's
// can be swapped by a scenario (a seller deleting and re-creating a role); the
// default guild's bot position and decoy roles are mock-configurable.
function guildRoleList(guildId) {
  if (guildId === G2) {
    return discord.g2RolesOverride ?? [
      { id: G2, name: '@everyone', position: 0, permissions: '0', color: 0 },
      { id: R2_BOT, name: 'Dues', position: 40, permissions: String(1 << 28), color: 0, managed: true },
      { id: R2_VIP, name: 'VIP', position: 7, permissions: '0', color: 5793266 },
    ];
  }
  if (guildId === GUILD) {
    return [
      ...discord.extraRoles,
      { id: GUILD, name: '@everyone', position: 0, permissions: '0', color: 0 },
      { id: R_BOT, name: 'Tradeleaks Bot', position: discord.botRolePosition, permissions: String(1 << 28), color: 0, managed: true }, // MANAGE_ROLES
      { id: R_ADMIN, name: 'Admin', position: 60, permissions: '8', color: 15548997 },
      { id: R_NEW, name: 'New Tier', position: 15, permissions: '0', color: 16711680 },
      { id: R_LIFETIME, name: 'Lifetime', position: 12, permissions: '0', color: 0 },
      { id: R_PRO, name: 'Pro Desk', position: 11, permissions: '0', color: 0 },
      { id: R_INSIDER, name: 'Insider', position: 10, permissions: '0', color: 0 },
      { id: R_MANAGED, name: 'Some Bot Integration', position: 3, permissions: '0', color: 0, managed: true },
    ];
  }
  return null;
}

async function discordHandler(req, res) {
  const url = new URL(req.url, 'http://mock');
  const p = url.pathname;
  let m;

  // The bot was kicked from this guild (or the server was deleted): Discord
  // answers 404 Unknown Guild (10004) on its guild routes and 403 Missing
  // Access (50001) to guilds.join — the same shape whether or not the BUYER
  // is in the server, which is exactly what the app must not misread.
  if ((m = p.match(/^\/guilds\/([^/]+)/)) && discord.kickedFrom && m[1] === discord.kickedFrom) {
    const memberRoute = /^\/guilds\/[^/]+\/members\/[^/]+$/.test(p);
    if (memberRoute && req.method === 'PUT') {
      json(res, 403, { message: 'Missing Access', code: 50001 });
      return;
    }
    if (memberRoute && req.method === 'GET') discord.kickedMemberGets++;
    json(res, 404, { message: 'Unknown Guild', code: 10004 });
    return;
  }

  if ((m = p.match(/^\/guilds\/([^/]+)\/members\/([^/]+)\/roles\/([^/]+)$/)) && (req.method === 'PUT' || req.method === 'DELETE')) {
    const [, , uid, roleId] = m;
    if (discord.rateLimit429Remaining > 0) {
      discord.rateLimit429Remaining--;
      discord.roleCalls.push({ method: req.method, uid, roleId, rateLimited: true });
      json(res, 429, { message: 'You are being rate limited.', retry_after: 0.05, global: false });
      return;
    }
    if (discord.failRoleAddsWith && req.method === 'PUT') {
      // A role the bot cannot grant: dragged above it (403 Missing Permissions).
      discord.roleCalls.push({ method: req.method, uid, roleId, failed: discord.failRoleAddsWith });
      json(res, discord.failRoleAddsWith, { message: 'Missing Permissions', code: 50013 });
      return;
    }
    if (discord.failRoleRemovalsWith && req.method === 'DELETE') {
      // A lost removal: Discord down, or the paid role dragged above the bot.
      discord.roleCalls.push({ method: req.method, uid, roleId, failed: discord.failRoleRemovalsWith });
      json(res, discord.failRoleRemovalsWith, { message: 'mock: role removal exploded' });
      return;
    }
    discord.roleCalls.push({ method: req.method, uid, roleId });
    if (!discord.members.has(uid)) {
      json(res, 404, { message: 'Unknown Member' });
      return;
    }
    // A role that no longer exists in the guild cannot be granted: Discord
    // answers 404 Unknown Role (code 10011), and no retry will ever succeed.
    const known = guildRoleList(m[1]);
    if (req.method === 'PUT' && known && !known.some((r) => r.id === roleId)) {
      json(res, 404, { message: 'Unknown Role', code: 10011 });
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
    // 204 "already a member" from a guild whose member fetch still says 404:
    // a consistency window the app must survive without spinning.
    if (discord.phantomJoinsFor.has(uid)) {
      discord.phantomJoins++;
      res.writeHead(204).end();
      return;
    }
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
    // Discord failing to answer. Deliberately NOT a 404: the whole point is
    // that "we could not ask" and "they are not a member" are different.
    if (discord.failMemberGetsFor.has(uid)) {
      json(res, 500, { message: 'mock: discord is having a moment' });
      return;
    }
    if (!discord.members.has(uid)) {
      json(res, 404, { message: 'Unknown Member', code: 10007 });
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
    // Guilds the mock has no list for are served the default guild's.
    json(res, 200, guildRoleList(m[1]) ?? guildRoleList(GUILD));
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
    stripe.coupons ??= [];
    // Stripe honours a caller-chosen id and refuses a repeat of it.
    if (form.id && stripe.coupons.some((c) => c.id === form.id)) {
      json(res, 400, { error: { code: 'resource_already_exists', message: 'Coupon already exists.' } });
      return;
    }
    const n = stripe.coupons.length + 1;
    const coupon = { id: form.id || `coupon_${n}`, ...form };
    stripe.coupons.push(coupon);
    json(res, 200, coupon);
    return;
  }
  if (url.pathname === '/v1/checkout/sessions' && req.method === 'GET') {
    // Seeded per test: sessions Stripe holds as complete that Dues never heard about.
    json(res, 200, { object: 'list', data: stripe.completedSessions ?? [], has_more: false });
    return;
  }
  if (url.pathname === '/v1/checkout/sessions' && req.method === 'POST') {
    if (stripe.failCheckoutSessionsWith) {
      json(res, 400, { error: { message: stripe.failCheckoutSessionsWith } });
      return;
    }
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
    if (stripe.delayCheckoutSessionsMs) await sleep(stripe.delayCheckoutSessionsMs);
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
  nowpayments.requests = (nowpayments.requests ?? 0) + 1;
  // Every call carries the merchant key; a request without it is the bug
  // where the key never reached the fetch at all.
  if (req.headers['x-api-key'] !== NOW_KEY) {
    json(res, 401, { message: 'invalid api key' });
    return;
  }
  if (url.pathname === '/merchant/coins' && req.method === 'GET') {
    // The key is `currencies`. That is the one NOWPayments documents for this
    // endpoint and the only one in their sample response; `selectedCurrencies`
    // appears nowhere in their material, so a mock that answers with it alone
    // proves the rail against a shape the provider does not send.
    //
    // Deliberately UPPERCASE: tickers are compared lowercase everywhere, and
    // the provider is not consistent about which it sends. XMR is enabled for
    // DEPOSITS only — see validate-address below — which is the case the
    // payout gate must not confuse with "available for payouts".
    json(res, 200, { currencies: nowpayments.noCoins ? [] : ['BTC', 'SOL', 'USDTSOL', 'ETH', 'XMR'] });
    return;
  }
  if (url.pathname === '/payout/validate-address' && req.method === 'POST') {
    // The provider's own answer to "can this coin be paid out to this
    // address". Its success body is a bare OK, not JSON — documented, and
    // exactly the kind of thing a shared JSON fetch helper trips over.
    const body = JSON.parse(await readBody(req));
    (nowpayments.validated ??= []).push(body);
    const shape = {
      btc: /^(1|3)[1-9A-HJ-NP-Za-km-z]{25,34}$|^bc1[02-9ac-hj-np-z]{8,87}$/,
      ltc: /^[LM][1-9A-HJ-NP-Za-km-z]{25,34}$|^ltc1[02-9ac-hj-np-z]{8,87}$/,
      sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
      usdtsol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
      eth: /^0x[0-9a-fA-F]{40}$/,
    }[String(body.currency).toLowerCase()];
    if (!shape || !shape.test(String(body.address))) {
      json(res, 400, { status: false, statusCode: 400, code: 'BAD_CREATE_WITHDRAWAL_REQUEST', message: `Invalid payout_address: ${body.currency} ${body.address}` });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('OK');
    return;
  }
  if (url.pathname === '/min-amount' && req.method === 'GET') {
    nowpayments.minAmount.push({
      from: url.searchParams.get('currency_from'),
      to: url.searchParams.get('currency_to'),
      // The flow the floor is asked about. NOWPayments: these "allow you to
      // see current minimum amounts for corresponsing flows (it may differ
      // from the standard flow!)" — so a quote taken without them is a
      // different number from the one the payment we create is judged by.
      fixedRate: url.searchParams.get('is_fixed_rate'),
      feePaidByUser: url.searchParams.get('is_fee_paid_by_user'),
      fiat: url.searchParams.get('fiat_equivalent'),
    });
    // fiat_equivalent is returned only when it was asked for — the provider
    // documents it as "(Optional) Get the fiat equivalent", not as a field
    // every answer carries.
    json(res, 200, {
      min_amount: 0.004,
      currency_from: url.searchParams.get('currency_from'),
      ...(url.searchParams.get('fiat_equivalent') ? { fiat_equivalent: 12.5 } : {}),
    });
    return;
  }
  if (url.pathname === '/payment' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (Number(body.price_amount) < 1) {
      json(res, 400, { message: 'Amount is too small: minimal amount is 1' });
      return;
    }
    if (nowpayments.delayCreateMs) await sleep(nowpayments.delayCreateMs);
    nowpayments.created.push(body);
    const id = `npid_${++nowpayments.n}`;
    // Shaped like the provider's own payment object, not like the subset this
    // app happens to read. Two of these fields are the reason the IPN
    // signature has to re-serialise recursively: `fee` is a NESTED object
    // whose keys do not arrive sorted, and `payment_extra_ids` is an ARRAY of
    // child deposits. A mock that only ever produced flat scalars let a
    // top-level-only sort pass every scenario.
    const payment = {
      payment_id: id,
      payment_status: 'waiting',
      pay_address: `ADDR_${id}`,
      pay_amount: 0.5,
      pay_currency: body.pay_currency,
      price_amount: body.price_amount,
      price_currency: body.price_currency,
      order_id: body.order_id,
      order_description: body.order_description,
      actually_paid: 0,
      // Present and zero on a payment the provider's own example shows as
      // paid in full: the field says nothing until a deposit has been valued
      // in fiat, which is exactly how settledFiat reads it.
      actually_paid_at_fiat: 0,
      payin_extra_id: null,
      purchase_id: `${5300000000 + nowpayments.n}`,
      parent_payment_id: null,
      invoice_id: null,
      outcome_amount: 0.4985,
      outcome_currency: body.payout_currency,
      payment_extra_ids: null,
      fee: { currency: body.pay_currency, depositFee: 0.09853637216235617, withdrawalFee: 0, serviceFee: 0 },
      // TWO expiries, because the provider documents two and they are not the
      // same instant. This one is the ESTIMATE's — "expiration date of this
      // estimate" — and it is deliberately the later of the pair, so a rail
      // that reads it as the payment's life is caught by every assertion about
      // the window rather than passing by coincidence.
      expiration_estimate_date: new Date(Date.now() + 20 * 60_000).toISOString(),
      // ...and this one is the PAYMENT's: "this parameter indicated when
      // payment go expired". Every payment this app creates is fixed-rate with
      // the fee paid by the buyer, and NOWPayments' note on both flags is the
      // same — "the rate of exchange will be frozen for 10 minutes. If there
      // are no incoming payments during this period, the payment status
      // changes to 'expired'".
      valid_until: new Date(Date.now() + (nowpayments.validForMs ?? NP_VALID_FOR_MS)).toISOString(),
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
    // The provider expires a payment nothing was sent to before valid_until,
    // and it does so SILENTLY: "no callbacks are sent after a payment expires".
    // So it only ever becomes visible on a lookup — which is exactly why our
    // own polling is the only thing that can find a deposit afterwards.
    if (payment.payment_status === 'waiting' && Number(payment.actually_paid ?? 0) <= 0
        && payment.valid_until && Date.parse(payment.valid_until) <= Date.now()) {
      payment.payment_status = 'expired';
    }
    json(res, 200, payment);
    return;
  }
  json(res, 404, { message: 'no route' });
}

// A deposit that lands on an invoice the provider has already expired. Their
// help centre is explicit that both halves of this happen: "no callbacks are
// sent after a payment expires. Deposits can still be received, but they will
// not trigger any further IPN callbacks" — and a payment "lives for 7 days -
// after that, our system will stop tracking it".
//
// So this moves the payment on and delivers NOTHING: no IPN is sent anywhere,
// because the provider would send none. The only way anyone learns about this
// money is the next time we ask about the payment ourselves.
function npDepositAfterExpiry(ref) {
  const payment = nowpayments.payments.get(ref);
  payment.actually_paid = payment.pay_amount;
  payment.actually_paid_at_fiat = payment.price_amount;
  payment.payment_status = 'finished';
  return payment;
}

// A deposit NOWPayments MINTED ITSELF, which is the only way a second
// transfer to a used address — or a deposit in a coin the invoice was not
// created for, with extra-deposits auto processing on — reaches a merchant.
//
// Not a variation on the parent payment: "Repeated deposits to the same
// addresses will automatically create a new payment with another id". The new
// payment has its own id, names the original in `parent_payment_id`, and
// carries `"order_id": null` — their own example webhook body for one does.
// The parent does NOT move: an underpaid invoice stays partially_paid however
// much arrives after it, and a wrong-coin deposit never touches its
// actually_paid.
//
// The mock used to be unable to express any of that (every payment it made
// carried our order_id), which is exactly why a handler that resolved
// everything through order_id passed the whole suite.
function npRepeatDeposit(parentId, { status = 'finished', payCurrency = null, actuallyPaid = 0.5, atFiat = 0 } = {}) {
  const parent = nowpayments.payments.get(parentId);
  assert.ok(parent, `no parent payment ${parentId} to deposit against`);
  const id = `npid_${++nowpayments.n}`;
  const child = {
    payment_id: id,
    // The link back to the invoice, and the only one.
    parent_payment_id: parent.payment_id,
    invoice_id: null,
    payment_status: status,
    // The same deposit address: that is what makes it a repeat.
    pay_address: parent.pay_address,
    payin_extra_id: null,
    // A deposit the provider minted has no invoice of its own behind it, so
    // it carries no price to reason about — the field the app reaches for
    // first everywhere else.
    price_amount: null,
    price_currency: null,
    pay_amount: null,
    actually_paid: actuallyPaid,
    actually_paid_at_fiat: atFiat,
    pay_currency: payCurrency ?? parent.pay_currency,
    order_id: null,
    order_description: null,
    // Shared with the parent: "Special identifier for handling
    // partially_paid payments".
    purchase_id: parent.purchase_id,
    outcome_amount: actuallyPaid,
    outcome_currency: parent.outcome_currency,
    payment_extra_ids: null,
    fee: { currency: payCurrency ?? parent.pay_currency, depositFee: 0.0985, withdrawalFee: 0, serviceFee: 0 },
  };
  nowpayments.payments.set(id, child);
  // "array of child payments for this payment" — the provider lists them on
  // the parent, so the mock does too.
  parent.payment_extra_ids = [...(parent.payment_extra_ids ?? []), id];
  return child;
}

// What the provider POSTs for one of those: the payment body itself, order_id
// and all — which here means order_id null.
const npDepositIpn = (child) => ({
  payment_id: child.payment_id,
  parent_payment_id: child.parent_payment_id,
  invoice_id: null,
  payment_status: child.payment_status,
  pay_address: child.pay_address,
  payin_extra_id: null,
  price_amount: null,
  price_currency: null,
  pay_amount: null,
  actually_paid: child.actually_paid,
  actually_paid_at_fiat: child.actually_paid_at_fiat,
  pay_currency: child.pay_currency,
  order_id: null,
  order_description: null,
  purchase_id: child.purchase_id,
  outcome_amount: child.outcome_amount,
  outcome_currency: child.outcome_currency,
  fee: child.fee,
});

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

// A session cookie is checked against the account row of the deployment that
// reads it, so a scenario that spawns an app on its OWN database (SQLite
// mode) signs in there instead of carrying the phase-1 cookie across.
async function signInOn(base, code) {
  const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  const stateCookie = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state=')).split(';')[0];
  const cb = await fetch(`${base}/auth/callback?code=${code}&state=${state}`, { redirect: 'manual', headers: { cookie: stateCookie } });
  return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
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
  ROLE_CACHE_SECONDS: '0', // every resolution refetches, so a scenario can swap a guild's role list and be seen at once
  RESEND_API_KEY: RESEND_KEY,
  RESEND_API_BASE: mocks.resend.url,
  COMMUNITY_INVITE: COMMUNITY_INVITE,
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
  // `durationDays` rides beside them for the same reason: the crypto rail has
  // no renewal to point at, so the pay screen has to name the term itself.
  assert.deepEqual(Object.keys(plans[0]).sort(), ['currency', 'description', 'descriptionHighlight', 'durationDays', 'expiresAt', 'id', 'imageUrl', 'interval', 'lifetime', 'linkSlug', 'mediaKind', 'name', 'priceUsd', 'requiredRoleName', 'roleNames', 'variantOf']);
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
      /\.ui-tint,\.ui-tint-b\{[^}]*position:fixed/,
      `${path} tint strips must be fixed to the viewport edges`,
    );
    assert.match(html, /\.ui-tint\{top:0;background-color:var\(--ui-tint\)\}/, `${path} top strip must carry the sky colour`);
    // BOTH edges. Safari tints the strip behind its bottom toolbar the same
    // way it tints the status bar, and the marketing pages had no sample point
    // down there at all — .footer paints a gradient, so its background-color
    // reads transparent and the sample fell through to the page ground. That
    // is a dark navy band under a blue footer, and it was reported three times.
    assert.match(html, /<i class="ui-tint-b" aria-hidden="true"><\/i>/, `${path} must carry the bottom tint strip`);
    assert.match(html, /\.ui-tint-b\{bottom:0;background-color:var\(--ui-tint-b,var\(--ui-tint\)\)\}/, `${path} bottom strip must carry the footer colour`);
    // and the state that swaps it, plus the footer's own solid colour — the
    // ground, the strip and the theme-color meta all read one token, so no
    // future edit can leave three answers to one question.
    assert.match(html, /html\[data-footer-near\]\{--ui-tint-b:var\(--foot-edge\)\}/, `${path} must hand the bottom strip to the footer at the foot of the page`);
    assert.match(html, /html\[data-footer-near\]\{background:var\(--foot-edge\)\}/, `${path} ground must become the footer's edge at the foot of the page`);
    assert.match(html, /--foot-edge:#264580/, `${path} must define the night footer edge`);
    assert.match(html, /--foot-edge:#2a56a4/, `${path} must define the day footer edge`);
    assert.match(html, /\.footer\{[^}]*background-color:var\(--foot-edge\)/, `${path} footer must carry a solid colour for an engine to sample`);
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

test('night: the small copy on the open sky rides navy glass on both marketing pages', async () => {
  // The night face puts eyebrows, notes and the hero sub straight over the
  // procedural cloud canvas. A text-shadow and lighter greys got the medians
  // past 4.5:1, but a bright cloud body behind the copy still measured 3.0–4.0
  // at the 5th percentile (worst: the payment note and the /pricing eyebrow),
  // and the clouds drift, so any placement is only luck. Dimming the whole sky
  // enough to fix it would need ~55% black. Instead the copy sits on the same
  // navy glass the plan cards already use — eyebrow chips at .74 (the blue is
  // darker than the greys), plates and the payment panel at .62, a .5 vignette
  // behind the hero copy — every rule scoped to the night face, so the day
  // face is untouched. Measured after: every element 6.9:1+ at the 5th
  // percentile at 390 and 1440. This holds the rules in place.
  const glass = /html:not\(\[data-theme="light"\]\) \.sec-eyebrow\{display:inline-block;[^}]*background:rgba\(13,20,32,\.74\)/;
  const vignette = /radial-gradient\(ellipse 50% 50% at 50% 50%,rgba\(13,20,32,\.5\) 0,rgba\(13,20,32,\.5\) 55%,rgba\(13,20,32,0\) 100%\)/;
  const home = await (await fetch(`${appUrl}/`)).text();
  assert.match(home, glass, '/ eyebrows must sit on a night chip');
  assert.match(home, /html:not\(\[data-theme="light"\]\) \.mid-note,html:not\(\[data-theme="light"\]\) \.save-demo\{[^}]*background:rgba\(13,20,32,\.62\)/, '/ notes must sit on a night plate');
  assert.match(home, /html:not\(\[data-theme="light"\]\) \.pay\{[^}]*background:rgba\(13,20,32,\.62\)/, '/ payment band must be a night panel');
  assert.match(home, /html:not\(\[data-theme="light"\]\) \.hero-core::before\{[^}]*\}/, '/ hero copy must have its night vignette');
  assert.match(home, vignette, '/ vignette must keep its soft plateau');
  const pricing = await (await fetch(`${appUrl}/pricing`)).text();
  assert.match(pricing, glass, '/pricing eyebrow must sit on a night chip');
  assert.match(pricing, /html:not\(\[data-theme="light"\]\) \.fees-note,html:not\(\[data-theme="light"\]\) \.faq-cta \.microcopy\{[^}]*background:rgba\(13,20,32,\.62\)/, '/pricing notes must sit on a night plate');
  assert.match(pricing, /html:not\(\[data-theme="light"\]\) \.page-hero::before\{[^}]*\}/, '/pricing hero copy must have its night vignette');
  assert.match(pricing, vignette, '/pricing vignette must keep its soft plateau');
  // and none of it leaks into the day face: every selector the block adds is
  // scoped to html:not([data-theme="light"]).
  for (const [path, html] of [['/', home], ['/pricing', pricing]]) {
    const start = html.indexOf('/* Night, the rest of it:');
    const block = html.slice(start, html.indexOf(path === '/' ? '.sky-card b{' : '.fee-chip{', start));
    assert.ok(block.length > 200 && block.length < 6000, `${path} night block must sit where it was written`);
    for (const line of block.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')) {
      const t = line.trim();
      if (!t || /^[a-z-]+:|^\}$/.test(t)) continue;
      if (t.startsWith('@media')) assert.match(t, /^@media \([^)]*\)\{html:not\(\[data-theme="light"\]\)/, `${path}: ${t.slice(0, 60)} must be night-scoped`);
      else assert.match(t, /^html:not\(\[data-theme="light"\]\)/, `${path}: ${t.slice(0, 60)} must be night-scoped`);
    }
  }
});

test('the favicon is square, big enough for search surfaces, and at a url that does not move', async () => {
  // Google Search fetches /favicon.ico by default. Its stated rules are that
  // the file be square and at least 8x8, with "we recommend using a favicon
  // that's larger than 48x48px so that it looks good on various surfaces".
  //   https://developers.google.com/search/docs/appearance/favicon-in-search
  //
  // Note what that does NOT say. An earlier version of this comment quoted a
  // superseded revision — "a multiple of 48 pixels in size" — and treated a
  // 16x16 icon as disqualified. It is not: 16x16 clears the hard floor and is
  // not why a site shows the globe placeholder. What was actually wrong here
  // was smaller and real. The file held ONE 16x16 image, under the recommended
  // size, while three places disagreed about what was in it: the markup said
  // sizes="32x32", scripts/gen-icons.mjs said 16/32/48/64, and the file said
  // neither. Nothing in the tree could catch that, because nothing read the
  // file. This does.
  //
  // The genuinely hard guideline on that page is the one about URLs, and it is
  // checked at the bottom of this test.
  const ico = await fs.promises.readFile(new URL('../public/favicon.ico', import.meta.url));
  assert.equal(ico.readUInt16LE(0), 0, 'favicon.ico must start with a valid ICONDIR');
  assert.equal(ico.readUInt16LE(2), 1, 'favicon.ico must be an icon, not a cursor');
  const count = ico.readUInt16LE(4);
  assert.ok(count > 0, 'favicon.ico must contain at least one image');
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    const w = ico.readUInt8(e) || 256;
    const h = ico.readUInt8(e + 1) || 256;
    const len = ico.readUInt32LE(e + 8);
    const off = ico.readUInt32LE(e + 12);
    assert.equal(w, h, `favicon.ico entry ${i} is ${w}x${h}, not square`);
    assert.ok(w >= 48, `favicon.ico entry ${i} is ${w}px — under the 48px Google recommends for search surfaces`);
    // The directory is only a claim; the PNG header is the fact. They disagreed
    // once already.
    const payload = ico.subarray(off, off + len);
    const isPng = payload.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (isPng) {
      assert.equal(payload.readUInt32BE(16), w, `favicon.ico entry ${i} claims ${w}px but the PNG is ${payload.readUInt32BE(16)}px`);
      assert.equal(payload.readUInt32BE(20), h, `favicon.ico entry ${i} height disagrees with its PNG`);
    }
    sizes.push(`${w}x${h}`);
  }

  // and the markup has to say what the file IS.
  const home = await (await fetch(`${appUrl}/`)).text();
  const declared = home.match(/<link rel="icon" href="\/favicon\.ico" sizes="([^"]+)"/);
  assert.ok(declared, 'the homepage must declare /favicon.ico with a sizes attribute');
  assert.deepEqual(
    declared[1].split(/\s+/).sort(),
    sizes.sort(),
    'the sizes attribute must list exactly what favicon.ico contains',
  );

  // No ?v= on any icon url, anywhere. This is the one hard rule of the three
  // this test touches: "The favicon URL must be stable (don't change the URL
  // frequently)." A version query that moves on every ship hands Google a URL
  // it has never seen instead of the one it already holds, and these files are
  // served must-revalidate anyway, so the query bought no freshness either.
  const pages = ['/', '/pricing', '/help', '/terms', '/guides/', '/vs/whop', '/use-cases/trading'];
  for (const path of pages) {
    const html = await (await fetch(`${appUrl}${path}`)).text();
    const versioned = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]*\?v=[^"]*)"/g)];
    assert.deepEqual(
      versioned.map((m) => m[1]),
      [],
      `${path} must not put a version query on an icon url`,
    );
    // The superseded "multiple of 48" rule was corrected in the generator's
    // favicon script and here, but the head comment the SEO generator stamps
    // into 45 public pages kept quoting it as what Google requires. A
    // policy claim the repo knows is false must not ship in served HTML.
    assert.doesNotMatch(html, /multiples? of 48|what Google requires/, `${path} must not quote the superseded favicon rule`);
  }
});

test('the look is free: every background and an imported URL, on every plan', async () => {
  const theme = await import('../src/lib/theme.js');
  // There is no paid part of a look any more, so there is no usesPaidLook /
  // freeLook pair to keep honest. What has to stay true is that the picker,
  // the server and the price page all describe the same deal.
  const total = Object.keys(theme.BG_PRESETS).length;
  assert.equal(theme.FREE_BG_PRESETS.length, total, 'every preset in the catalogue is free');
  assert.equal(theme.usesPaidLook, undefined, 'the paid-look gate is gone, not left answering "allowed"');
  assert.equal(theme.freeLook, undefined, 'and so is the stripper that went with it');
  const billing = await import('../src/services/billing.js');
  assert.equal(typeof billing.storeTheme, 'function', "the render path asks for the store's look, not for its plan");
  assert.equal(billing.themeIfPaid, undefined, 'the old name would be a lie');

  // The picker must not lock anything, and the two catalogues must agree.
  // THE ONE SETUP STEP THAT HAPPENS IN DISCORD, NOT HERE. Discord only lets a
  // bot hand out roles below its own, and the invite link cannot set that — it
  // is a drag in Server Settings. Said at the invite, it is a step; left to the
  // role picker, it reads as half the seller's roles being broken.
  {
    const src = fs.readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
    const step1 = src.slice(src.indexOf('Invite the Dues bot'), src.indexOf('id="recheck"'));
    assert.match(step1, /Server Settings/, 'the invite step names where the seller has to go');
    assert.match(step1, /drag the <strong>Dues<\/strong> role\s*<strong>above<\/strong>/,
      'and says which way to drag it');
    assert.match(step1, /Manage Roles/, 'and names the permission the invite asks for');
  }

  const dash = fs.readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  const catalogue = dash.match(/const BG_CATALOG = \[[\s\S]*?\n\];/)[0];
  const ids = [...catalogue.matchAll(/\{ id: '([a-z0-9-]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(ids, [...theme.FREE_BG_PRESETS].sort(), 'the picker and the server must offer the same catalogue');
  assert.doesNotMatch(catalogue, /free:\s*true/, 'no entry needs a free flag any more — they all are');
  assert.doesNotMatch(dash, /bgp-lock">Pro/, 'no wallpaper tile may wear a Pro lock');
  assert.doesNotMatch(dash, /bgp-url-row\${/, 'the import field is not conditionally locked');
  assert.doesNotMatch(dash, /canCustomise/, 'the dashboard does not ask whether a look is allowed');

  // And every price card advertises the same look, because every plan gets it.
  const pricing = fs.readFileSync(new URL('../public/pricing.html', import.meta.url), 'utf8');
  const cards = pricing.split(/<div class="plan(?: plan-pop)?">/).slice(1);
  assert.ok(cards.length >= 3, 'the pricing page still has its plan cards');
  const looks = cards.map((c) => c.match(/class="plan-look">([^<]*)</)?.[1] ?? '');
  assert.ok(looks.every((t) => new RegExp(`\\b${total}\\b`).test(t) && /URL/i.test(t)),
    `every plan, Free included, advertises all ${total} backgrounds plus the import — got ${JSON.stringify(looks)}`);
});

test('How it works shows the mechanism: the steps are numbered and wear the real marks', () => {
  // The band used to be three centred paragraphs under three grey discs. It
  // TOLD the mechanism and showed none of it: a wallet glyph does not say
  // "your own Stripe account", a basket does not say "a role is the product",
  // and in a section headed "Three steps" the order — the one thing that makes
  // it a sequence rather than a list — was nowhere on screen. Each of the four
  // things that fixes it is pinned here, because every one is invisible to the
  // HTTP scenarios and each has a cheap way of quietly regressing.
  const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = index.slice(index.indexOf('<style>'), index.indexOf('</style>'));
  const band = index.slice(index.indexOf('<div class="trio">'), index.indexOf('<div class="pay">'));
  assert.ok(band.length > 400, 'the step band and the payment strip are both still there');

  // 1 · the order is on screen, and it is in order.
  assert.deepEqual([...band.matchAll(/<span class="trio-n"[^>]*>(\d+)<\/span>/g)].map((m) => m[1]),
    ['01', '02', '03'], 'the three steps are numbered, in sequence');

  // 2 · each step wears the real mark of the thing it names — the Stripe
  //     wordmark, the blurple role chip a storefront actually renders, the
  //     Discord glyph the role lands in — and they are white chips, the same
  //     component the payment strip below is built from, which is what makes
  //     that strip read as the end of step three rather than a fourth thing.
  assert.match(band, /class="trio-badge trio-stripe"[^>]*>\s*<svg viewBox="54 36 360 150"/,
    'step one wears the Stripe wordmark');
  assert.match(band, /<span class="trio-badge trio-role"[^>]*>@VIP<\/span>/,
    'step two wears a role chip');
  assert.match(band, /class="trio-badge trio-discord"[^>]*>\s*<svg viewBox="0 0 127.14 96.36"/,
    'step three wears the Discord mark');
  assert.match(css, /^\.trio-badge\{[^}]*background:#fff/m, 'the step marks are the strip\'s white chip');

  // 3 · the copy is the seller's, unchanged: this was a layout fix, and a
  //     redesign that quietly rewrites a claim is not one.
  assert.deepEqual([...band.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]),
    ['Set up payouts', 'Create a product', 'Get paid'], 'the three step headings');

  // 4 · a step is a card on BOTH faces, and so is the strip that closes the
  //     band. Small copy straight on the sky photograph is the contrast bug
  //     this page has fixed everywhere else; and the strip used to be framed
  //     on the night face only, so on day it read as a row of logos that had
  //     drifted loose below the section.
  assert.match(css, /^\.trio-item\{[^}]*background:var\(--glass\)/m, 'a step is a glass card');
  assert.match(css, /^html:not\(\[data-theme="light"\]\) \.trio-item\{[^}]*background:rgba\(13,20,32,\.62\)/m,
    'the night face gives the step card the same navy glass as the plan cards');
  for (const face of ['html:not\\(\\[data-theme="light"\\]\\)', 'html\\[data-theme="light"\\]']) {
    assert.match(css, new RegExp(`^${face} \\.pay\\{[^}]*border-radius:22px`, 'm'),
      'both faces frame the payment strip');
  }
});

test('landing polish holds: one gutter, centred community CTA, Cash App logotype, comments that match the code', () => {
  // Each of these was a real regression on the landing page and every one is
  // invisible to the HTTP-level scenarios, so they are pinned at the source.
  const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const pricing = fs.readFileSync(new URL('../public/pricing.html', import.meta.url), 'utf8');
  const css = index.slice(index.indexOf('<style>'), index.indexOf('</style>'));

  // ONE gutter, on BOTH pages, at EVERY width. .wrap declares it; the sections
  // kept overriding it with a padding SHORTHAND, which silently resets
  // padding-inline, so their cards sat outside the sticky logo above and the
  // FAQ below. The first fix only cleaned the desktop rules on index, which
  // left the same 4px step in the <=600px block, the payment strip 24px proud
  // of everything on tablets, and /pricing untouched. So walk every .wrap
  // section on both pages and every rule that targets one — media copies
  // included — and let nothing name a horizontal padding.
  const gutters = {};
  for (const [name, html] of [['index', index], ['pricing', pricing]]) {
    const sheet = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    const desktop = sheet.match(/^\.wrap\{[^}]*padding-inline:(\d+px)/m)?.[1];
    const phone = sheet.match(/@media \(max-width:600px\)\{[\s\S]*?\n\s*\.wrap\{padding-inline:(\d+px)\}/)?.[1];
    assert.ok(desktop && phone, `${name}: .wrap declares the gutter as padding-inline at both widths`);
    gutters[name] = `${desktop}/${phone}`;
    // every section that opts into .wrap, read off the markup so a new one
    // cannot be added without being covered here.
    const secs = [...html.matchAll(/class="(?:([a-z-]+) wrap|wrap ([a-z-]+))"/g)].map((m) => m[1] || m[2]);
    assert.ok(secs.length >= 4, `${name}: found the .wrap sections (${secs.length})`);
    for (const sec of new Set(secs)) {
      // rules whose selector IS the section — a compound like
      // `html:not([data-theme="light"]) .pay` is a deliberate card treatment
      // with its own geometry, not the page gutter, so it is left alone.
      const rules = [...sheet.matchAll(new RegExp(`(?:^|[{,])\\s*\\.${sec}\\{([^}]*)\\}`, 'gm'))];
      assert.ok(rules.length, `${name}: .${sec} still has a rule`);
      for (const r of rules) {
        assert.doesNotMatch(r[1], /(^|;)\s*padding(-inline|-left|-right)?\s*:/,
          `${name}: .${sec} must not reset .wrap's ${gutters[name]} gutter — use padding-block`);
      }
    }
  }
  assert.equal(gutters.index, gutters.pricing, 'the landing and /pricing share one gutter at both widths');
  // the payment strip is no longer a section of its own: it closes "How it
  // works", so it inherits that section's .wrap gutter rather than declaring
  // one. What has to hold is that it never grows its own horizontal padding.
  assert.match(index, /<section class="how wrap" id="how">[\s\S]*?<div class="pay">[\s\S]*?<\/section>/,
    'the payment strip lives inside How it works and takes that section\'s gutter');
  assert.doesNotMatch(index, /<section class="pay/, 'the payment strip is not a section of its own');
  // and it is off the walk above now, so its own rules are checked here — the
  // night face's `html:not(...) .pay` panel is exempt for the same reason the
  // walk exempts compounds: that one is a card treatment, not the page gutter.
  const payRules = [...css.matchAll(/(?:^|[{,])\s*\.pay\{([^}]*)\}/gm)];
  assert.ok(payRules.length, '.pay still has a rule');
  for (const r of payRules) {
    assert.doesNotMatch(r[1], /(^|;)\s*padding(-inline|-left|-right)?\s*:/,
      '.pay must not grow a horizontal gutter of its own inside How it works');
  }

  // The community card centres everything; its one CTA is inside a flex row
  // with no justify-content, so it pinned to flex-start under centred copy.
  assert.match(css, /^\.comm-cta-row\{[^}]*justify-content:center/m, 'the community CTA row centres its button');
  // The right-aligned note beside "What sellers say." orphaned its last word.
  assert.match(css, /^\.mid-note\{[^}]*text-wrap:balance/m, '.mid-note balances its two lines');

  // Cash App is the only white-on-brand-green logotype in the strip. Its size
  // was set on a lone class, which .pay-chip b (0,1,1) outranks, so the rule
  // never applied and the least legible chip was also the smallest.
  const base = parseFloat(css.match(/^\.pay-chip b\{[^}]*font-size:([\d.]+)px/m)[1]);
  const cash = css.match(/^\.pm-cashchip b\{([^}]*)\}/m);
  assert.ok(cash, 'the Cash App logotype is styled through .pm-cashchip b, which can win');
  assert.ok(parseFloat(cash[1].match(/font-size:([\d.]+)px/)[1]) >= base, 'Cash App is at least as large as the other chips');
  assert.match(cash[1], /white-space:nowrap/, 'the two-word logotype never breaks across lines');
  assert.doesNotMatch(css, /^\.pm-cash-ink\{/m, 'no dead lone-class rule for the Cash App text');

  // Comment / code agreement in the two copies of the theme-color and footer
  // scripts. The comment above tintWant() must name the token the code reads
  // (--foot-edge, the painted edge; --foot-end is the nominal stop that leaves
  // a seam), and the stale "svh, NOT lvh" paragraph — which told the next
  // person to undo the guard two lines below it — must stay deleted.
  for (const [name, html] of [['index', index], ['pricing', pricing]]) {
    const at = html.indexOf('var tintWant');
    assert.ok(at > 0, `${name}: tintWant present`);
    const above = html.slice(at - 900, at);
    const body = html.slice(at, at + 400);
    assert.match(body, /'--foot-edge'/, `${name}: tintWant reads --foot-edge`);
    assert.match(above, /--foot-edge is the colour/, `${name}: the comment names the token the code reads`);
    assert.doesNotMatch(above, /--foot-end is the colour/, `${name}: the comment must not name the nominal stop as the answer`);
    assert.doesNotMatch(html, /svh, NOT lvh/, `${name}: the stale svh-vs-lvh comment is gone`);
    assert.match(html, /h > largeVh\(\) - 8/, `${name}: the fit guard measures against lvh`);
  }
  // The two copies of the viewport-probe block must not drift apart.
  const probe = (s) => s.slice(s.indexOf('// the LARGE viewport height'), s.indexOf('var largeVh = function'));
  assert.ok(probe(index).length > 200, 'index carries the viewport probe block');
  assert.equal(probe(index), probe(pricing), 'index and pricing share one viewport-probe block, comments included');
});

test('the landing runs on one type scale, one vertical rhythm and one grid', () => {
  // The page had been tuned section by section and never against itself: eight
  // section-heading sizes (84/52/52/44/42/38/34/27), seven small-copy sizes,
  // four eyebrow trackings, seven different section boundaries between 52 and
  // 104px, and four centred column widths (1344/940/900/820). One class even
  // rendered in two typefaces — .sec-display fell through to the generic
  // h1,h2,h3 rule inside .mid-head (Space Grotesk 700) while .faq-head h2 was
  // named in the Jakarta list, so "What sellers say." and "Questions,
  // answered." were set differently on the same page.
  //
  // This reads the sheet the way the cascade does — last declaration wins —
  // and holds every one of those to a token, so the next tweak to one section
  // cannot quietly desynchronise it from the other seven.
  const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = index.slice(index.indexOf('<style>'), index.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');

  // flatten the sheet to (selector, body) pairs; at-rule preludes are stepped
  // over, so a rule inside a media query counts exactly where it is written.
  const rules = [];
  for (let i = 0; i < css.length;) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    // a stray '}' can lead the slice when the previous rule was nested (an
    // at-rule body), so it is trimmed off along with the whitespace.
    const sel = css.slice(i, open).replace(/^[\s}]+/, '').trim();
    if (/^@(media|supports|keyframes)/.test(sel)) { i = open + 1; continue; }
    const close = css.indexOf('}', open);
    if (close < 0) break;
    rules.push({ sel, body: css.slice(open + 1, close) });
    i = close + 1;
  }
  const last = (selector, prop) => {
    let value = null;
    for (const r of rules) {
      if (!r.sel.split(',').some((s) => s.trim() === selector)) continue;
      const hits = [...r.body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g'))];
      if (hits.length) value = hits[hits.length - 1][1].trim();
    }
    return value;
  };

  // every token is declared once, in one place
  for (const t of ['--t-display', '--t-title', '--t-sub', '--t-lead', '--t-body', '--t-note', '--t-micro',
    '--sec-y', '--sec-y-tight', '--sec-head-gap', '--measure', '--measure-wide']) {
    const declared = [...css.matchAll(new RegExp(`(?:^|[;{\\s])${t}\\s*:`, 'g'))].length;
    assert.equal(declared, 1, `${t} is declared exactly once`);
  }

  // ONE section heading, whatever the section is called
  for (const h of ['.save-head h2', '.why-title', '.how-title', 'h2.sec-display']) {
    assert.equal(last(h, 'font-size'), 'var(--t-title)', `${h} takes the one section-heading step`);
  }
  assert.equal(last('.hero h1', 'font-size'), 'var(--t-display)', 'the hero takes the display step');
  // and the closer is no larger than the hero it answers
  assert.match(last('.footer-title', 'font-size') || '', /74px\)$/, 'the closer tops out at the display step');
  for (const s of ['.save-card h2', '.comm-txt h2']) {
    assert.equal(last(s, 'font-size'), 'var(--t-sub)', `${s} takes the in-card heading step`);
  }

  // ONE uppercase label: one size, one weight, one tracking
  for (const s of ['.pay-cap', '.sec-eyebrow', '.save-rows-cap', '.save-cap']) {
    assert.match(last(s, 'font') || '', /600 var\(--t-micro\)/, `${s} takes the one micro-label step`);
    assert.equal(last(s, 'letter-spacing'), '.1em', `${s} takes the one micro-label tracking`);
  }

  // ONE body step and ONE note step
  for (const s of ['.save-head p', '.save-sub', '.trio-item p', '.comm-txt>p', '.mid-note', '.acc-a p', '.faq-card p']) {
    assert.equal(last(s, 'font-size'), 'var(--t-body)', `${s} takes the one body step`);
  }
  for (const s of ['.hero .microcopy', '.fee-note', '.pay-note', '.save-hero small']) {
    assert.equal(last(s, 'font-size'), 'var(--t-note)', `${s} takes the one note step`);
  }

  // TWO section boundaries, and no third. Every section's block padding is
  // written in the rhythm tokens, so the gap between any two of them is either
  // 2x--sec-y (a new movement) or 2x--sec-y-tight (inside the fee argument).
  for (const s of ['.save', '.why', '.pay', '.how', '.voices', '.comm', '.faq']) {
    const pad = last(s, 'padding-block');
    assert.ok(pad, `${s} sets its own block rhythm`);
    assert.doesNotMatch(pad, /\d+px/, `${s} spends the rhythm tokens, not a hand-picked px value (${pad})`);
    assert.match(pad, /var\(--sec-y(-tight)?\)/, `${s} spends the rhythm tokens`);
  }

  // ONE reading column, ONE multi-column measure — four widths became two
  for (const s of ['.acc', '.faq-card']) {
    assert.equal(last(s, 'max-width'), 'var(--measure)', `${s} sits in the reading column`);
  }
  for (const s of ['.save-card', '.comm-card']) {
    assert.match(last(s, 'width') || '', /min\(var\(--measure\),100%\)/, `${s} sits in the reading column`);
  }
  for (const s of ['.trio', '.voices-stage']) {
    assert.equal(last(s, 'max-width'), 'var(--measure-wide)', `${s} sits in the multi-column measure`);
  }
});

test('the first screen earns its height: a capped well, a grounded claim field, a role band with a floor', () => {
  // Measured on this machine at 1440x900 before the change: 256px of hero
  // content adrift in a 752px well, so two thirds of the first screen was
  // empty sky with a bouncing chevron as the only evidence the page continued.
  // The claim field — the ONLY input above the fold and the only thing on that
  // screen a visitor can act on — rode --glass, which is 6% white on the night
  // face and 55% on the day face, so over a bright cloud it had no edge at all
  // and read as chrome rather than an invitation. And the role marquee was two
  // rows of solid pills on bare sky: on the day face the brightest object on
  // the page, louder than the headline above it, with nothing marking where
  // the first screen ended and the argument began.
  //
  // Every number below is a composition decision, so it is pinned here rather
  // than left to the next person's eye.
  const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = index.slice(index.indexOf('<style>'), index.indexOf('</style>'));

  // 1 · THE WELL. Above the phone breakpoint the hero is capped, which lets the
  // top of the role band sit inside the fold — a floor under the hero, and a
  // better reason to scroll than a marker in an empty half ever was.
  //
  // There is no chevron rule to pin beside this one. The scroll hint was
  // deleted with the empty sky it pointed into, element and all, and the
  // homepage scenario asserts the string is gone from the page — so a rule
  // switching it off would be a rule about nothing, and the two pins would
  // contradict each other. The cap is the whole change here.
  const wide = css.match(/@media \(min-width:601px\)\{([\s\S]*?)\n\}/);
  assert.ok(wide, 'the desktop-and-up hero block is where it was written');
  assert.match(wide[1], /\.hero\{min-height:clamp\(620px,86svh,820px\)/,
    'the first screen is capped, so a tall window shows more page rather than more sky');
  // the phone keeps the full-screen hero the footer reveal is built on
  assert.match(css, /\.hero\{min-height:100vh;min-height:100lvh\}/,
    'the phone hero still owns the whole screen — the blind depends on it');

  // 2 · THE CLAIM FIELD. A ground of its own on BOTH faces, an address set in
  // ink rather than in the placeholder grey, and a submit that inverts the
  // field it sits in — at a thumb's size on a phone, where it is the only
  // action on the screen and was 34px tall.
  assert.match(css, /html:not\(\[data-theme="light"\]\) \.capture\{background:rgba\(13,20,32,\.68\)/,
    'the night field has a ground of its own, not 6% white over the clouds');
  assert.match(css, /html\[data-theme="light"\] \.capture\{background:rgba\(255,255,255,\.74\)/,
    'the day field has a ground of its own');
  assert.match(css, /\.capture-prefix\{font-size:17px;font-weight:600;color:var\(--ink\)/,
    'dues.gg\/ is set in ink, so the field reads as an address being handed over');
  assert.match(css, /html:not\(\[data-theme="light"\]\) \.btn-capture\{background:#f4f7fd/,
    'the night submit inverts the field rather than sitting two steps off it');
  assert.match(css, /\.btn-capture\{\n  display:inline-flex[^}]*min-height:44px/,
    'the submit is 44px');
  assert.match(css, /@media \(max-width:600px\)\{[\s\S]*?\.btn-capture\{min-height:44px/,
    'and stays 44px under a thumb');

  // 3 · THE CLOSING EVIDENCE. What the rail is, is a different claim from what
  // it costs; middot-chained onto the end of the free-tier note it read as the
  // tail of the fine print.
  assert.match(css, /\.mc-compat\{display:block/, 'Compatible with … is its own line');
  assert.doesNotMatch(index, /<span class="mc-compat"> &#183;/,
    'and is no longer chained onto the free-tier note by a middot');

  // The fourth thing this scenario used to pin was the role band under the
  // hero — its ground, its hairlines, its quieted chips. The band is gone: the
  // owner asked that the page not open by listing what other people sell, so
  // the calculator now follows the hero directly. Nothing replaced it, which is
  // why there is nothing here to assert; the homepage scenario checks that no
  // rule for it survived.
});

test('one nav: every page in the site shows the same header links, in the same order', () => {
  // The site grew three different desktop navs. The landing and /pricing had
  // Pricing / Discover / Invite Dues; the SEO and legal pages had
  // Discover / Pricing / Compare / Tools; /discover alone had a "Features" link
  // pointing at a fragment of another page. Moving between pages swapped the
  // item set and the order, and two of the four hubs were unreachable from the
  // highest-authority page on the site. The SEO set won: it names the four
  // hubs that exist as real routes, and it is the set the ~40 generated pages
  // carry, so adopting it costs the landing only a nav-level invite link that
  // the community section already repeats. This walks every page AND the
  // generator that writes most of them, so a new page cannot invent a fourth.
  const root = fileURLToPath(new URL('..', import.meta.url));
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name))
      : e.name.endsWith('.html') ? [path.join(dir, e.name)] : []);
  const NAV = /<div class="nav-links">([\s\S]*?)<\/div>|<nav class="top-center"[^>]*>([\s\S]*?)<\/nav>|<nav class="mobile-menu"[^>]*>([\s\S]*?)<\/nav>/g;
  const linksOf = (block) => [...block.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => `${m[2].replace(/<[^>]*>/g, '').trim()} -> ${m[1]}`).join(' | ');
  const CANON = 'Discover -> /discover | Pricing -> /pricing | Compare -> /vs | Tools -> /tools';
  const files = [...walk(path.join(root, 'public')), path.join(root, 'scripts/gen-seo-pages.mjs')];
  let navs = 0;
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(NAV)) {
      const links = linksOf(m[1] ?? m[2] ?? m[3]);
      if (!links) continue;                       // an empty shell, e.g. a JS-filled menu
      navs++;
      assert.equal(links, CANON, `${path.relative(root, f)} carries its own nav`);
    }
  }
  assert.ok(navs >= 40, `every page's nav was inspected (${navs})`);
});

test('dashboard: MRR is a monthly rate, a flat product reads flat, and the black face holds on every route', async () => {
  // The dashboard renders on the client, which this suite does not run. These
  // are the pure functions it reads its money and growth figures with, lifted
  // out of the file by shape and executed as written.
  const dash = fs.readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  const lift = (name, re, ...args) => {
    const src = dash.match(re)?.[0];
    assert.ok(src, `dashboard.js must still define ${name}`);
    return new Function(...args, `${src}\n return ${name};`);
  };

  // A $600 yearly plan is $50 of monthly recurring revenue, not $600; a
  // quarterly one is a third; a weekly one is a bit over four weeks' worth. No
  // term and a monthly term stay as they are.
  const monthlyRate = lift('monthlyRate', /const TERM_MONTHS = [\s\S]*?\nfunction monthlyRate\(p\) \{[\s\S]*?\n\}/)();
  assert.equal(monthlyRate({ amountUsd: 600, durationDays: 365 }), 50);
  assert.equal(monthlyRate({ amountUsd: 600, durationDays: 366 }), 50);
  assert.equal(monthlyRate({ amountUsd: 90, durationDays: 90 }), 30);
  assert.equal(monthlyRate({ amountUsd: 120, durationDays: 180 }), 20);
  assert.equal(monthlyRate({ amountUsd: 25, durationDays: 31 }), 25);
  assert.equal(monthlyRate({ amountUsd: 25, durationDays: 30 }), 25);
  assert.equal(monthlyRate({ amountUsd: 25, durationDays: null }), 25);
  assert.equal(monthlyRate({ amountUsd: 25 }), 25);
  assert.equal(Math.round(monthlyRate({ amountUsd: 10, durationDays: 7 }) * 100) / 100, 43.45, 'a weekly $10 is ~4.35 weeks a month');
  assert.match(dash, /mrrRows = data\.payments\.filter\([^\n]*\.map\(\(p\) => \(\{ \.\.\.p, amountUsd: monthlyRate\(p\) \}\)\)/,
    'the MRR card must sum monthly rates, not period prices');
  // …and only over rows that BILL AGAIN. api/admin/payments.js marks them
  // `renews`; a crypto pass is a fixed term nothing renews, so counting it
  // gives a crypto-heavy store an MRR that expires on its own. The card and
  // its sparkline are two separate filters and both were missing the test.
  assert.match(dash, /mrrRows = data\.payments\.filter\(\(p\) => p\.entitled && !p\.lifetime && p\.renews\)/,
    'the MRR card counts only rows that renew');
  assert.match(dash, /mrr: sparkSvg\(bucketSeries\(data\.payments\.filter\(\(p\) => !p\.lifetime && p\.renews\)/,
    'and so does the sparkline under it');

  // Top Products and the Revenue card sit side by side and must agree that
  // no change is not growth: 0% is flat in both, never a green ▲0%.
  const deltaChip = lift('deltaChip', /function deltaChip\(delta\) \{[\s\S]*?\n\}/)();
  const pct = (cur, prev) => (prev <= 0 ? null : ((cur - prev) / prev) * 100);
  const prev = new Map([['VIP', 200], ['Up', 100], ['Down', 100], ['Nudge', 100]]);
  const topDelta = lift('topDelta', /const topDelta = \(name, v\) => \{[\s\S]*?\n  \};|const topDelta = \(name, v\) => [^\n]*;/, 'byPlanPrev', 'pct', 'deltaChip')(prev, pct, deltaChip);
  assert.equal(topDelta('VIP', 200), '<span class="delta flat">0%</span>');
  assert.equal(deltaChip(0), '<span class="delta flat">0%</span>');
  assert.match(topDelta('Up', 150), /class="delta up".*▲.*50%/);
  assert.match(topDelta('Down', 50), /class="delta down".*▼.*50%/);
  assert.equal(topDelta('New', 50), '', 'nothing to compare against says nothing');
  // …and they must agree ROUNDING too, not just the flat rule. A second copy
  // of the formatter kept whole percents here while the card beside it kept a
  // decimal below 10%, so $1,000 -> $1,004 read ▲0.4% on the Revenue card and
  // a flat 0% on the very same product: two chips, one number, opposite
  // stories about whether it grew.
  for (const v of [100.4, 99.6, 100.6, 104, 150, 250, 100]) {
    assert.equal(topDelta('Nudge', v), deltaChip(pct(v, 100)), `Top Products and the Revenue card must print ${v} vs 100 identically`);
  }
  assert.match(topDelta('Nudge', 100.4), /class="delta up".*0\.4%/, 'a +0.4% product is growth, not flat');

  // The black face: stamped before first paint from the key dashboard.js
  // remembers the SAVED face under, and re-applied by route() for the views
  // that have no store — so an unsaved Customize preview cannot follow the
  // seller out to "All servers", and the picker wears the same ground
  // whether it was loaded cold or reached by navigating back.
  const html = fs.readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
  const key = dash.match(/const DARK_FACE_KEY = '([a-z-]+)'/)?.[1];
  assert.ok(key, 'dashboard.js names the face key');
  // The face is a per-STORE preference. Under one browser-wide key it was
  // whichever store was opened last, so a seller running one black and one
  // navy store got the wrong first paint on every cold load of the other —
  // the flash the key exists to stop, moved rather than removed. The head
  // script is lifted out and RUN, against a fake localStorage: a rewrite is
  // fine, reading the wrong store's face is not.
  const headSrc = html.match(/<script>(try \{[^<]*dues-dash-face[^<]*)<\/script>/)?.[1];
  assert.ok(headSrc, 'dashboard.html still stamps the face before first paint');
  // THREE faces now, not two: the head script owns light as well, because the
  // face is one setting and light is one of its values. It has to CLEAR as
  // well as set — theme.js runs above it and stamps data-theme='light' from a
  // session carried in off the marketing pages, and the store's own saved
  // face must win over that or the picker says navy on a white screen.
  const firstPaint = (saved, hash, sessionLight = false) => {
    const root = { dataset: sessionLight ? { theme: 'light' } : {} };
    new Function('localStorage', 'location', 'document', headSrc)(
      { getItem: (k) => (k in saved ? saved[k] : null) },
      { hash },
      { documentElement: root },
    );
    return root.dataset.theme === 'light' ? 'light' : (root.dataset.dark ?? 'navy');
  };
  // Three stores, three faces, and the bare key left on whichever was opened last.
  const twoStores = { [key]: 'black', [`${key}:ink`]: 'black', [`${key}:sky`]: 'navy', [`${key}:day`]: 'light' };
  assert.equal(firstPaint(twoStores, '#/store/sky'), 'navy', 'the navy store paints navy even when the black one was opened last');
  assert.equal(firstPaint(twoStores, '#/store/ink'), 'black', 'and the black store still paints black');
  assert.equal(firstPaint(twoStores, '#/store/day'), 'light', 'and the light store paints light, before the API answers');
  // A store never opened here, and the store-less views, fall back to the
  // last saved face — the behaviour the single key always had.
  assert.equal(firstPaint(twoStores, '#/store/brand-new'), 'black', 'an unseen store falls back to the last saved face');
  assert.equal(firstPaint(twoStores, '#/'), 'black', 'so does the picker');
  assert.equal(firstPaint({ [`${key}:sky`]: 'navy' }, '#/'), 'navy', 'and nothing saved is navy, never a crash');
  // The clearing half. Without it a light session from the marketing site
  // leaves the dashboard white while its picker and its saved face say navy.
  assert.equal(firstPaint(twoStores, '#/store/sky', true), 'navy', "a light session does not beat the store's saved navy");
  assert.equal(firstPaint(twoStores, '#/store/ink', true), 'black', 'nor its saved black');
  assert.equal(firstPaint({}, '#/store/sky', true), 'navy', 'and nothing saved means navy, the dashboard default');
  assert.equal(firstPaint(twoStores, '#/store/day', true), 'light', 'a saved light face still paints light');
  // dashboard.js must WRITE the per-store key, or the head script reads a key
  // that is never set and the fallback quietly becomes the only path.
  assert.match(dash, /rememberFace\(face, store\.slug, prefsDarkHalf\(dashPrefs\)\)/, 'viewStore remembers the face under the store it belongs to');
  assert.match(dash, /localStorage\.setItem\(darkFaceKey\(slug\), face\)/, 'rememberFace writes the per-store key');
  const routeSrc = dash.match(/async function route\(\) \{[\s\S]*?\n\}/)[0];
  const at = (needle) => { const i = routeSrc.indexOf(needle); assert.ok(i >= 0, `route() must contain ${needle}`); return i; };
  assert.ok(at('applyFace(savedFace())') < at('viewSetup(') && at('applyFace(savedFace())') < at('viewAdmin()') && at('applyFace(savedFace())') < at('viewPicker()'),
    'the saved face is applied before every store-less view');
  assert.ok(!/const pickedFace[\s\S]*?rememberFace/.test(dash.match(/function wireCustomize[\s\S]*?\n\}/)?.[0] ?? ''),
    'a preview is never remembered as the saved face');
  // ONE setting, three values, one control. The picker offers all three faces
  // — the old shape was a two-way "dark style" row that, on the light face,
  // looked live and changed nothing anyone could see.
  const dcRow = dash.match(/<div class="dc-row"><span class="dc-lab">Theme<\/span>[\s\S]*?<\/div>/)?.[0] ?? '';
  for (const f of ['light', 'navy', 'black']) assert.ok(dcRow.includes(`'${f}'`), `the dashboard theme picker offers ${f}`);
  assert.ok(!/dc-lab">Dark style/.test(dash), 'and there is no second, invisible "dark style" control left over');
  // The header button belongs to the dashboard, not to theme.js. If both bind
  // it, one click toggles data-theme twice and lands back where it started.
  assert.ok(!/data-theme-toggle/.test(html), 'dashboard.html does not hand its button to theme.js');
  assert.match(html, /<button class="theme-btn" data-face-toggle/, 'the dashboard owns the header face button');
  assert.match(dash, /document\.querySelectorAll\('\[data-face-toggle\]'\)\.forEach/, 'dashboard.js binds it');
  // …and it SAVES. A shortcut that forgets on reload is the original
  // complaint in a different place.
  const pickSrc = dash.match(/async function pickFace\(face\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(pickSrc, /rememberFace\(face, slug, half\)/, 'the header button mirrors the face for the next first paint');
  assert.match(pickSrc, /api\('\/api\/admin\/store', \{ store: slug, dashboardPrefs: prefs \}\)/, 'and persists it on the store');
  // And the night rule the black face inherits names tokens, not navy: the
  // revenue tooltip was the one that did.
  for (const sel of ['.chart-tip']) {
    const rule = html.match(new RegExp(`html:not\\(\\[data-theme='light'\\]\\) ${sel.replace('.', '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
    assert.ok(rule && !/#131b2d|#101827|19, 27, 45|16, 24, 39/.test(rule), `${sel} night rule must not hard-code navy: ${rule}`);
  }
  // The other direction, and the one that shipped: a rule written for the
  // black product and inherited by the light face. The store-theme tiles'
  // SELECTED ring was #fff — a white ring on a white card, so the light
  // dashboard showed no selection at all — and the live preview's window mock
  // was #0c0c0c, a black hole punched into a white panel. Both were only ever
  // right because dashboard.html re-stated them for the night faces. No rule
  // in either family may name a literal colour again.
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const themeRules = [...css.matchAll(/(^|\})\s*(\.(?:th-tile|th-frame|th-viewport|th-preview)[^{}]*)\{([^}]*)\}/gm)];
  assert.ok(themeRules.length >= 8, `expected the theme-picker rules to still be there, found ${themeRules.length}`);
  for (const [, , sel, body] of themeRules) {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(body), `a theme-picker rule must name tokens, not a literal face: ${sel.trim()} {${body}}`);
  }

  // Saving the storefront or dashboard appearance re-renders to a screen that
  // looks exactly like the one before the click; each says it landed.
  assert.match(dash, /theme: read\(\) \}\);\n\s+state\.data = null;\n\s+await viewStore\(slug\);\n\s+flashSaved\('#th-note'\)/, 'Save appearance confirms into #th-note');
  assert.match(dash, /dashboardPrefs: prefsBody \}\);\n\s+state\.data = null;\n\s+await viewStore\(slug\);\n\s+flashSaved\('#dc-ok'\)/, 'Customize save confirms into #dc-ok');
  assert.match(dash, /id="dc-ok" role="status"/, 'and the slot exists in the Customize foot');
  // The 320px billing card: the interval toggle wraps rather than slicing the
  // "2 months free" note at the card edge.
  const dcss = fs.readFileSync(new URL('../public/dash.css', import.meta.url), 'utf8');
  assert.match(dcss, /#billing-body \.bill-toggle \{[^}]*flex-wrap: wrap/, 'the billing interval toggle wraps on narrow phones');
});

test('every dashboard table row survives a 320px phone as a labelled card', async () => {
  // The owner opened the live dashboard on a phone and found the Products
  // price painted on top of "+ Option", "Link", the toggle and "Edit", with
  // the product name gone entirely; Transactions ran the product name under
  // the amount; the platform Stores table stacked owner, status, plan, id and
  // date into one line. The cause was a desktop table shrunk rather than
  // rebuilt: five nowrap columns cannot share 320px, so they overlapped.
  //
  // Below 760px a <tr> is now a card and each <td> a labelled line, and the
  // label is the cell's data-th. That makes data-th load-bearing markup, not
  // decoration: a cell without one renders a value with nothing saying what it
  // is. Both halves of the contract are pinned here — the cells carry the
  // attribute, and the stylesheet is still the thing that prints it.
  const dash = fs.readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  const dcss = fs.readFileSync(new URL('../public/dash.css', import.meta.url), 'utf8');

  const rows = dash.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  assert.ok(rows.length >= 7, `expected the dashboard's row templates, found ${rows.length}`);
  let labelled = 0;
  for (const row of rows) {
    const cells = row.match(/<td\b[^>]*>/g) ?? [];
    for (const [i, cell] of cells.entries()) {
      // The first cell is the card's title and needs no label; the actions
      // cell is a row of buttons that name themselves; a colspan cell is an
      // empty state ("No stores yet.") and is a whole sentence already.
      if (i === 0 || /row-actions/.test(cell) || /colspan=/.test(cell)) continue;
      assert.match(cell, /data-th="[^"]+"/,
        `every cell after the first needs a phone label — this one has none: ${cell.replace(/\s+/g, ' ')}`);
      labelled += 1;
    }
  }
  assert.ok(labelled >= 25, `expected the whole dashboard's cells to be labelled, counted ${labelled}`);

  // The label must be the column's own header, or the phone tells the seller
  // one thing and the desktop another. Every <th> with words in it — first
  // column excepted, since that cell is the card's title — has to appear as a
  // data-th somewhere.
  for (const table of dash.match(/<table class="data-table[^"]*">[\s\S]*?<\/thead>/g) ?? []) {
    const heads = (table.match(/<th[^>]*>([^<]*)<\/th>/g) ?? [])
      .map((h) => h.replace(/<[^>]*>/g, '').trim());
    for (const label of heads.slice(1)) {
      if (!label) continue;
      assert.ok(dash.includes(`data-th="${label}"`),
        `column "${label}" has no cell carrying data-th="${label}"`);
    }
  }

  // The stylesheet half. Without these the attributes are inert and the table
  // is a desktop table again, at 320px, colliding.
  const phone = dcss.match(/@media \(max-width: 760px\) \{[\s\S]*?\n\}/g) ?? [];
  const stack = phone.find((b) => /content: attr\(data-th\)/.test(b));
  assert.ok(stack, 'dash.css must print data-th as the cell label below 760px');
  assert.match(stack, /white-space: normal/, 'and release the nowrap that made the cells overlap');
  assert.match(stack, /body\.app \.data-table thead \{ display: none; \}/, 'and retire the header row the labels replace');
  assert.match(stack, /td\.row-actions \{[\s\S]*?flex-wrap: wrap/, 'and give the row actions a wrapped row of their own');

  // The platform tables were the worst of it and they were reusing .t-pay,
  // whose phone column priority hides columns 5 and 6 — which on those two
  // tables are Members/Revenue and First/Last seen, not Date. Their own
  // classes are what keeps that rule off them.
  assert.match(dash, /<table class="data-table t-stores">/, 'the platform Stores table has its own class');
  assert.match(dash, /<table class="data-table t-users">/, 'the platform Users table has its own class');

  // Safe area: the shell pays back every inset it opted into by asking for a
  // cover viewport, or the wordmark sits under the clock.
  const dhtml = fs.readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
  assert.match(dhtml, /name="viewport"[^>]*viewport-fit=cover/, 'the dashboard opts into the full screen');
  for (const edge of ['top', 'left', 'right', 'bottom']) {
    assert.ok(dcss.includes(`env(safe-area-inset-${edge}, 0px)`),
      `the ${edge} inset must be paid back, with a 0px fallback`);
  }
});

test('the pricing page prints TIERS — every price, yearly price and cap, by name', async () => {
  // Every number on /pricing is hand-written HTML. The server charges what
  // TIERS says (ensureTierPrice provisions a Stripe price from it), so the day
  // TIERS moves and the page does not, Stripe bills one number while the page
  // advertises another — the mirror image of the drift billing.js already
  // documents once catching. Pinned card by card, by tier NAME, so a copy edit
  // elsewhere on the card cannot pass for a price check.
  const { TIERS } = await import('../src/services/billing.js');
  const pricing = fs.readFileSync(new URL('../public/pricing.html', import.meta.url), 'utf8');
  const cards = pricing.split(/<div class="plan(?: plan-pop)?">/).slice(1);
  const usd = (n) => (n === 0 ? '$0' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  for (const tier of TIERS) {
    const card = cards.find((c) => new RegExp(`<div class="plan-name"><b>${tier.name}</b>`).test(c));
    assert.ok(card, `the pricing page must have a ${tier.name} card`);
    const fig = card.match(/<span class="serif" data-monthly="([^"]*)" data-yearly="([^"]*)">([^<]*)</);
    assert.ok(fig, `${tier.name} must carry both prices as data attributes`);
    assert.equal(fig[1], usd(tier.priceUsd), `${tier.name} monthly price must be TIERS.priceUsd`);
    assert.equal(fig[2], usd(tier.yearlyUsd), `${tier.name} yearly price must be TIERS.yearlyUsd`);
    assert.equal(fig[3], fig[1], `${tier.name} must open on the monthly price the toggle starts on`);
    // "2 months free" is only true while yearly is exactly ten monthlies.
    assert.equal(Math.round(tier.yearlyUsd * 100), Math.round(tier.priceUsd * 100) * 10,
      `${tier.name} yearly must be ten months or the "2 months free" toggle lies`);
    const cap = card.match(/<div class="plan-cap"><b(?: class="cap-word")?>([^<]*)<\/b>/)?.[1];
    assert.equal(cap, tier.maxMembers === null ? 'No limit' : String(tier.maxMembers),
      `${tier.name} member cap must be TIERS.maxMembers`);
  }
  assert.equal(cards.length, TIERS.length, 'one card per tier, no card for a tier that does not exist');

  // The paid cards describe a background IMPORT. The only control the product
  // has for it is a URL field (dashboard #th-bgurl) — there is no file picker
  // for a store background — so a card must not promise "uploads". If a picker
  // is ever wired to bgUrl, this assertion is the one to drop.
  const dash = fs.readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  assert.match(dash.match(/<input[^>]*id="th-bgurl"[^>]*>/)?.[0] ?? '', /type="url"/, 'the background import is a URL field');
  for (const c of cards) {
    if (/<b>Free<\/b>/.test(c)) continue;
    const look = c.match(/class="plan-look">([^<]*)</)?.[1] ?? '';
    assert.doesNotMatch(look, /upload/i, `a paid card must not advertise uploads the product does not take: "${look}"`);
  }
});

test('the pricing FAQ is published as FAQPage structured data, word for word', async () => {
  // The seven <details> are the most substantive Q&A on the site; the
  // FAQPage block is what lets a search engine show them. It is a second
  // copy of the same text, so the test reads BOTH from the file and requires
  // them equal — an edit to one without the other fails here.
  const pricing = fs.readFileSync(new URL('../public/pricing.html', import.meta.url), 'utf8');
  const decode = (t) => t.replace(/&rsquo;/g, '’').replace(/&mdash;/g, '—').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const list = pricing.match(/<div class="faq-list">([\s\S]*?)<\/div>\s*<div class="faq-cta">/)?.[1] ?? '';
  const shown = [...list.matchAll(/<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>/g)]
    .map((m) => ({ q: decode(m[1]), a: decode(m[2]) }));
  assert.ok(shown.length >= 5, 'the pricing page keeps a real FAQ');
  const blocks = [...pricing.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const faq = blocks.find((b) => b['@type'] === 'FAQPage');
  assert.ok(faq, 'the pricing page must ship a FAQPage block');
  assert.deepEqual(
    faq.mainEntity.map((e) => ({ q: e.name, a: e.acceptedAnswer.text })),
    shown,
    'FAQPage must mirror the visible FAQ, question for question',
  );
  for (const e of faq.mainEntity) {
    assert.equal(e['@type'], 'Question');
    assert.equal(e.acceptedAnswer['@type'], 'Answer');
    assert.doesNotMatch(e.name + e.acceptedAnswer.text, /[<&]/, 'structured data carries text, not markup or entities');
  }

  // The FAQ title shares one clamp with the fees title (.fees-title,.faq-title).
  // A leftover homepage `.faq h2` rule out-ranked it and made the two sibling
  // titles differ by 8-20px at every width; the page must not grow one back.
  assert.doesNotMatch(pricing, /\.faq h2\{/, 'no homepage .faq h2 rule overriding .faq-title on the pricing page');
  // The other half of that copy was a second `.faq` padding rule pasted in
  // below the 860px one, which then out-ranked it. /pricing declares its FAQ
  // padding exactly twice — the base rule and the narrow-width override, in
  // that order — so this checks the count and the order rather than the
  // property, which is padding-block on both since the gutter now comes from
  // .wrap alone.
  const faqPads = [...pricing.matchAll(/^\s*\.faq\{[^}]*padding[^}]*\}/gm)].map((m) => m.index);
  assert.equal(faqPads.length, 2, '/pricing declares .faq padding twice: the base rule and the 860px one');
  assert.ok(faqPads[1] > pricing.indexOf('@media (max-width:860px)'),
    'the narrow-width .faq padding is the last one to win');
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
  // An index file is its directory's bare URL — vs/index.html is /vs, which
  // is what the canonical, the sitemap and vercel.json's rewrite all say.
  // This map used to produce /vs/, and that is what held the homepage to the
  // slash form while every other reference used the bare one.
  const pages = walk(PUBLIC)
    .map((f) => {
      const rel = `/${relative(PUBLIC, f)}`;
      return rel.endsWith('/index.html') ? rel.slice(0, -'/index.html'.length) || '/' : rel.slice(0, -'.html'.length);
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

test('every in-page anchor link on the site points at an id that exists — checked against the filesystem', async () => {
  // A /#how link whose section was renamed scrolls nowhere and nobody sees
  // it fail. This walk was cited by an earlier commit as "a check that every
  // /#anchor on the site resolves to a real id" while living only in a
  // scratch script that never landed; now it lives here.
  const { readdirSync, statSync, existsSync, readFileSync } = await import('node:fs');
  const { join, relative, dirname, resolve } = await import('node:path');
  const PUBLIC = new URL('../public/', import.meta.url).pathname;
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (name.endsWith('.html')) out.push(full);
    }
    return out;
  };
  const idsIn = new Map();
  const idsOf = (file) => {
    if (!idsIn.has(file)) {
      idsIn.set(file, existsSync(file)
        ? new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
        : null);
    }
    return idsIn.get(file);
  };
  let seen = 0;
  const dead = [];
  for (const file of walk(PUBLIC)) {
    for (const [, target, id] of readFileSync(file, 'utf8').matchAll(/href="([^"#]*)#([^"]+)"/g)) {
      if (/^https?:/.test(target)) continue;
      seen++;
      let page;
      if (target === '') page = file;
      else if (target.startsWith('/')) {
        // cleanUrls: /pricing → pricing.html, /vs → vs/index.html, / → index.html.
        const rel = target.slice(1);
        page = rel === '' ? join(PUBLIC, 'index.html')
          : [join(PUBLIC, `${rel}.html`), join(PUBLIC, rel, 'index.html'), join(PUBLIC, rel)].find((c) => existsSync(c)) ?? join(PUBLIC, `${rel}.html`);
      } else page = resolve(dirname(file), target.endsWith('.html') ? target : `${target}.html`);
      const ids = idsOf(page);
      if (!ids) dead.push(`${relative(PUBLIC, file)} → ${target}#${id} (no such page)`);
      else if (!ids.has(id)) dead.push(`${relative(PUBLIC, file)} → ${target}#${id} (no such id)`);
    }
  }
  // Two survive: the /#how link in /pricing's body copy and the one in
  // /discover's. /discover's nav used to carry a third and fourth (desktop
  // and mobile "Features") until the site settled on one shared nav; the
  // floor is only here so an empty walk cannot pass as a green check.
  assert.ok(seen >= 2, `expected the site's anchor links to be walked, found ${seen}`);
  assert.deepEqual(dead, [], `anchor links with nothing to scroll to: ${dead.join(', ')}`);
});

test('package.json scripts run files the repository ships (nothing behind a gitignore rule)', async () => {
  // `npm run test:dash` once pointed at scripts/_verify-dash.mjs, which the
  // `scripts/_*` rule keeps out of every commit: four commits cited it as
  // their verification and a fresh clone could not run it. Every script
  // entry must name a file that exists AND that git would not ignore.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const targets = Object.entries(pkg.scripts)
    .map(([name, cmd]) => [name, cmd.match(/^node (scripts\/[^\s]+)/)?.[1]])
    .filter(([, file]) => file);
  assert.ok(targets.length >= 8, 'the script table should still be node scripts/…');
  const missing = targets.filter(([, file]) => !fs.existsSync(path.join(ROOT, file))).map(([n, f]) => `${n} → ${f}`);
  assert.deepEqual(missing, [], `scripts pointing at files that do not exist: ${missing.join(', ')}`);
  const git = spawnSync('git', ['check-ignore', ...targets.map(([, f]) => f)], { cwd: ROOT, encoding: 'utf8' });
  if (git.error) return; // no git on this box — existence is all that can be checked
  assert.equal(git.stdout.trim(), '', `scripts pointing at gitignored files: ${git.stdout.trim().split('\n').join(', ')}`);
});

test('every environment variable the code reads is named in .env.example, with the defaults it documents', async () => {
  // README makes .env.example the deploy checklist ("set the environment
  // variables listed in .env.example"), so a variable the code reads but the
  // file never names is one nobody sets: RESEND_API_KEY was one, and its
  // absence silently switches receipts off. The walk is over src/ and api/,
  // the code that ships; scripts/ are local tooling with their own flags.
  const { readdirSync, statSync } = await import('node:fs');
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (name.endsWith('.js')) out.push(full);
    }
    return out;
  };
  const read = new Set();
  for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'api'))]) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|\b(?:env|num)\('([A-Z][A-Z0-9_]*)'/g)) read.add(m[1] ?? m[2]);
  }
  // Not deploy settings: the two test/dev hooks that point the app at another
  // .env or plan catalog, the flag Vercel injects itself, and the local
  // arming switch for the bot-profile refresh that only runs in serverless.
  const INTERNAL = new Set(['ENV_PATH', 'PLANS_PATH', 'VERCEL', 'BRAND_REFRESH']);
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const named = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  const undocumented = [...read].filter((k) => !INTERNAL.has(k) && !named.has(k)).sort();
  assert.deepEqual(undocumented, [], `read by src/ or api/ but absent from .env.example: ${undocumented.join(', ')}`);
  assert.ok(read.size >= 30, `expected the full variable set to be walked, found ${read.size}`);

  // The one default the file spells out must be the code's default: it said
  // "Ripley" for a year after the platform became Dues, an invitation to
  // paste the old brand back in.
  const platformDefault = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8').match(/env\('PLATFORM_NAME', '([^']+)'\)/)[1];
  assert.match(example, new RegExp(`^#\\s*PLATFORM_NAME=${platformDefault}$`, 'm'), `.env.example must document PLATFORM_NAME's real default (${platformDefault})`);
});

test('vercel.json: the old domain 301s to dues.gg with the path kept; the webhook aliases survive', async () => {
  // The redirect only bites once ripleybot.com is attached to the project in
  // Vercel — a human step — but the rule has to be right before that day.
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const rule = vercel.redirects.find((r) => (r.has ?? []).some((h) => h.type === 'host' && /ripleybot/.test(h.value)));
  assert.ok(rule, 'a host-conditioned redirect for ripleybot.com must exist');
  const host = new RegExp(`^${rule.has.find((h) => h.type === 'host').value}$`);
  for (const h of ['ripleybot.com', 'www.ripleybot.com']) assert.ok(host.test(h), `${h} must match the host condition`);
  assert.equal(host.test('dues.gg'), false, 'the new domain must never match itself into a loop');
  assert.equal(rule.permanent, true, 'a domain move is permanent (301/308), not a 307 the browser re-asks about');
  assert.equal(rule.source, '/:path*', 'every path on the old host, the root included');
  assert.equal(rule.destination, 'https://dues.gg/:path*', 'the path rides along, so old deep links keep working');
  // The rewrites the storefront and providers depend on are untouched.
  const rewritten = new Map(vercel.rewrites.map((r) => [r.source, r.destination]));
  for (const [source, destination] of [
    ['/webhooks/stripe', '/api/webhooks/stripe'],
    ['/webhooks/coinbase', '/api/webhooks/coinbase'],
    ['/webhooks/nowpayments', '/api/webhooks/nowpayments'],
    ['/webhooks/stripe/:storeid', '/api/webhooks/stripe?store=:storeid'],
    ['/s/:slug', '/api/store-page?store=:slug'],
  ]) assert.equal(rewritten.get(source), destination, `${source} rewrite must be kept`);
  // Every function that makes a provider call the platform default cannot
  // outlive declares its own limit. A crypto checkout POST is up to three
  // serial NOWPayments round trips of 15s each (coin list, create payment,
  // and the minimum lookup on a minimum error); killed halfway it leaves an
  // order row holding a seat and a discount use with no payment id, and an
  // invoice the provider minted that no buyer is ever shown.
  for (const fn of [
    'api/webhooks/stripe.js',
    'api/webhooks/coinbase.js',
    'api/webhooks/nowpayments.js',
    'api/cron/reconcile.js',
    'api/checkout/crypto.js',
    'api/admin/store.js',
  ]) assert.ok((vercel.functions?.[fn]?.maxDuration ?? 0) >= 60, `${fn} must declare a maxDuration above the provider timeouts it can stack`);
});

test('the community invite is one setting: the site hop and the receipt read the same value, either name works', async () => {
  // COMMUNITY_INVITE fed the receipt email while DISCORD_COMMUNITY_INVITE fed
  // /api/community — re-issuing the invite under one name left the other
  // surface on the dead link. Both now come from config.communityInvite.
  const hop = await fetch(`${appUrl}/api/community`, { redirect: 'manual' });
  assert.equal(hop.status, 302);
  assert.equal(hop.headers.get('location'), COMMUNITY_INVITE, 'the site hop redirects to the configured invite');
  // The older name is still honoured, so a deployment that set it keeps its invite.
  const probe = (env) => spawnSync(process.execPath, ['-e', "import('./src/config.js').then((m) => console.log(m.config.communityInvite))"], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, ENV_PATH: '/nonexistent/.env', PLANS_PATH, COMMUNITY_INVITE: '', DISCORD_COMMUNITY_INVITE: '', ...env },
  }).stdout.trim();
  assert.equal(probe({ DISCORD_COMMUNITY_INVITE: 'https://discord.gg/old-name' }), 'https://discord.gg/old-name');
  assert.equal(probe({ COMMUNITY_INVITE: 'https://discord.gg/new-name', DISCORD_COMMUNITY_INVITE: 'https://discord.gg/old-name' }), 'https://discord.gg/new-name', 'the documented name wins when both are set');
});

// Walks public/ once, for the three checks below that ask questions of the
// shipped site rather than of a running handler.
function publicFiles(filter = () => true) {
  const PUBLIC = path.join(ROOT, 'public');
  const walk = (dir, out = []) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full, out);
      else if (filter(full)) out.push(full);
    }
    return out;
  };
  return walk(PUBLIC).map((f) => path.relative(PUBLIC, f)).sort();
}

// config.communityInvite with no .env and no override — the value the
// committed pages must have been generated from.
function defaultCommunityInvite() {
  return spawnSync(process.execPath, ['-e', "import('./src/config.js').then((m) => console.log(m.config.communityInvite))"], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ENV_PATH: '/nonexistent/.env', PLANS_PATH, COMMUNITY_INVITE: '', DISCORD_COMMUNITY_INVITE: '' },
  }).stdout.trim();
}

test('public/ is the marketing site, not a tool shed: no operator scripts are served from it', async () => {
  // public/setup-community.mjs was a byte copy of scripts/setup-community.mjs,
  // put there so an operator could `curl -O https://dues.gg/setup-community.mjs`
  // (commit 72d9fd0, "one-line download"). It is not a credential, but it is an
  // operator tool — it documents where the bot token is looked up and how the
  // community server is laid out — and it had already drifted a commit behind
  // the real one, so the published copy built a slightly different server.
  // public/ is served verbatim by Vercel: only browser assets belong in it.
  const BROWSER_ASSET = /\.(html|js|css|json|txt|xml|webmanifest|svg|png|jpe?g|gif|webp|avif|ico|mp4|webm|woff2?)$/i;
  const strays = publicFiles().filter((rel) => !BROWSER_ASSET.test(rel));
  assert.deepEqual(strays, [], `served at dues.gg/… and not a browser asset: ${strays.join(', ')}`);
  // Extension-blind backstop: an executable script announces itself with a
  // shebang, and no browser asset ever starts with one.
  const shebanged = publicFiles().filter((rel) => fs.readFileSync(path.join(ROOT, 'public', rel)).subarray(0, 2).toString() === '#!');
  assert.deepEqual(shebanged, [], `executable scripts under public/: ${shebanged.join(', ')}`);
  // The URL itself is gone, and nothing on the site links it back into being.
  // One retry: this is an idempotent GET, and under a loaded machine undici
  // has answered a healthy server with "fetch failed" once. A flaky ship gate
  // is worse than a slow one.
  const notServed = async () => {
    for (let i = 0; ; i += 1) {
      try { return (await fetch(`${appUrl}/setup-community.mjs`)).status; }
      catch (err) { if (i) throw err; await new Promise((r) => setTimeout(r, 250)); }
    }
  };
  assert.equal(await notServed(), 404, '/setup-community.mjs must not be served');
  const linking = publicFiles((f) => f.endsWith('.html')).filter((rel) => fs.readFileSync(path.join(ROOT, 'public', rel), 'utf8').includes('setup-community'));
  assert.deepEqual(linking, [], `pages still pointing at the withdrawn operator script: ${linking.join(', ')}`);
  // It still ships where it is actually run from — a clone, not the website.
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'setup-community.mjs')), 'the operator script itself must stay in scripts/');
});

test('the generated pages take the community invite from config, so one regenerate moves every one of them', async () => {
  // The invite used to be a literal in the generator's footer template, which
  // meant COMMUNITY_INVITE moved exactly two surfaces (the hop and the receipt
  // email) while 45 shipped pages kept linking whatever was last pasted in —
  // and config.js's own comment claimed otherwise. The generator now reads
  // config.communityInvite, so the fix is: set the value, regenerate, commit.
  const gen = fs.readFileSync(path.join(ROOT, 'scripts', 'gen-seo-pages.mjs'), 'utf8');
  assert.ok(gen.includes('config.communityInvite'), 'the generator must take the invite from config');
  assert.deepEqual(gen.match(/discord\.gg\/[^"'`\s)]+/g), null, 'the generator must not carry a literal invite of its own');

  const invite = defaultCommunityInvite();
  assert.match(invite, /^https:\/\/discord\.gg\/[A-Za-z0-9-]+$/, `config.communityInvite should be a discord invite, got ${invite}`);
  const generated = publicFiles((f) => f.endsWith('.html')).filter((rel) =>
    rel === 'help.html' || /^(vs|tools|use-cases|guides|alternatives)\//.test(rel));
  assert.ok(generated.length >= 40, `expected the generated page network, found ${generated.length}`);
  const stale = generated.filter((rel) => !fs.readFileSync(path.join(ROOT, 'public', rel), 'utf8').includes(`href="${invite}"`));
  assert.deepEqual(stale, [], `these shipped pages were generated from a different invite than config's — rerun \`node scripts/gen-seo-pages.mjs\` with the value you deploy and commit the result: ${stale.join(', ')}`);

  // The hand-written pages do not print the invite at all: they link the hop,
  // which reads config per request, so re-issuing moves them with no deploy.
  for (const rel of ['receipt.html', 'store.html']) {
    const html = fs.readFileSync(path.join(ROOT, 'public', rel), 'utf8');
    assert.ok(!/discord\.gg\//.test(html), `${rel} must link the /api/community hop, not a pasted invite`);
    assert.ok(html.includes('href="/api/community"'), `${rel} must link the /api/community hop`);
  }
});

test('the fee calculators compute real figures from the ids the served markup actually carries', async () => {
  // The rebrand left the calculators' element ids on the old name (t-ripley,
  // t-row-ripley, t-bar-ripley) under a row labelled Dues; renaming them was
  // shipped with no test at all. Half a rename — markup moved, script not, or
  // the reverse — is silent in the generator and silent in the browser except
  // that every bar reads $0. So: fetch the page, build a DOM containing ONLY
  // the ids the markup declares, run the page's own inline script against it,
  // and check the arithmetic. A missing id is a TypeError, not a quiet zero.
  const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
  const planCost = (m) => (m <= 10 ? 0 : m <= 50 ? 14.99 : m <= 500 ? 44.99 : 134.99);
  // The publicly-listed competitor pricing each page states in its own copy.
  const CALCULATORS = {
    'whop-fee-calculator': { whop: (rev) => rev * 0.03 },
    'launchpass-fee-calculator': { launchpass: (rev) => 29 + rev * 0.035 },
    'patreon-fee-calculator': { patreon: (rev) => rev * 0.08 },
    'doorfee-fee-calculator': { doorfee: (rev) => rev * 0.1 },
    'discord-fee-calculator': {
      whop: (rev) => rev * 0.03,
      launchpass: (rev) => 29 + rev * 0.035,
      patreon: (rev) => rev * 0.08,
      'upgrade-chat': () => 49,
    },
  };

  for (const [slug, competitors] of Object.entries(CALCULATORS)) {
    const res = await fetch(`${appUrl}/tools/${slug}`);
    assert.equal(res.status, 200, `/tools/${slug} must be served`);
    const html = await res.text();
    assert.ok(!/ripley/i.test(html), `/tools/${slug} still ships the old brand in its markup`);

    // The Dues bar must be the one wearing the dues ids — the exact thing the
    // rename fixed, and the thing a future rename could split apart again.
    const row = html.slice(html.indexOf('id="t-row-dues"'), html.indexOf('</div>', html.indexOf('id="t-bar-dues"')));
    assert.ok(row.includes('>Dues<') && row.includes('id="t-dues"'), `/tools/${slug}: the Dues row does not carry the Dues ids`);

    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script && script.includes('getElementById'), `/tools/${slug} has no inline calculator script`);

    // A DOM that knows only what the page declares. getElementById on anything
    // else returns null, exactly as a browser would, and the script throws.
    const nodes = new Map();
    let onInput = null;
    const value = { 't-subs': '100', 't-price': '50' };
    const document = {
      getElementById(id) {
        if (!ids.has(id)) return null;
        if (!nodes.has(id)) {
          nodes.set(id, {
            get value() { return value[id]; },
            textContent: '',
            style: {},
            addEventListener: (_type, fn) => { onInput = fn; },
          });
        }
        return nodes.get(id);
      },
    };
    new Function('document', script)(document); // runs, and calls upd() itself
    assert.ok(onInput, `/tools/${slug}: the calculator never wired up its sliders`);

    const read = (id) => String(nodes.get(id).textContent);
    for (const [members, price] of [[5, 5], [100, 50], [1000, 200]]) {
      value['t-subs'] = String(members);
      value['t-price'] = String(price);
      onInput();
      const rev = members * price;
      const dues = planCost(members);
      const costs = Object.entries(competitors).map(([id, f]) => [id, f(rev)]);
      const worst = Math.max(...costs.map(([, c]) => c));
      const where = `/tools/${slug} at ${members} members × $${price}`;
      assert.equal(read('t-subs-out'), String(members), `${where}: member readout`);
      assert.equal(read('t-price-out'), `$${price}`, `${where}: price readout`);
      assert.equal(read('t-rev'), `${money(rev)}/mo`, `${where}: sales volume`);
      assert.equal(read('t-dues'), `${money(dues)}/mo`, `${where}: the Dues plan cost`);
      for (const [id, cost] of costs) assert.equal(read(`t-${id}`), `${money(cost)}/mo`, `${where}: ${id} cost`);
      assert.equal(read('t-save'), `${money(Math.max(worst - dues, 0) * 12)}/yr`, `${where}: annual saving`);
      // Every bar is drawn, which means every bar id resolved to an element.
      for (const id of ['dues', ...costs.map(([k]) => k)]) {
        const width = nodes.get(`t-bar-${id}`).style.width;
        assert.match(String(width), /^\d+(\.\d+)?%$/, `${where}: the ${id} bar was never sized`);
        assert.ok(parseFloat(width) >= 2, `${where}: the ${id} bar collapsed to nothing`);
      }
    }
  }
});

test("the landing's cost band computes from TIERS, and every figure on it is derived", async () => {
  // The band is the argument the whole landing page is built on and it prints
  // seven live figures. Two things can rot underneath it silently. One: the
  // Dues ladder is a copy of src/services/billing.js TIERS written out by hand
  // in an inline script, so the day a price or a member cap moves in TIERS,
  // the page keeps quoting the old one at a visitor while Stripe bills the new
  // one. Two: an id can be renamed on one side of the markup/script pair and
  // every figure it feeds silently stops updating. So the page's own script is
  // lifted out and run against a DOM that knows ONLY the ids the markup
  // declares, with the slider bounds read off the markup too, and the
  // arithmetic is checked against TIERS and against the published competitor
  // rates the copy states in its own rows.
  const { TIERS } = await import('../src/services/billing.js');
  const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  // The row the section exists for has to state the basis it is arguing about,
  // in the same grammar the four it is compared with use.
  const duesRow = index.slice(index.indexOf('class="save-row save-dues"'), index.indexOf('id="svBarDues"'));
  assert.match(duesRow, /id="svDuesPlan"/, 'the Dues row names the plan the member count lands on');
  assert.match(duesRow, /0% of sales/, 'the Dues row states its cut, beside "3% of sales" and "8% of sales"');

  const script = [...index.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).find((s) => s.includes("getElementById('svSubs')"));
  assert.ok(script, 'the landing still carries an inline calculator script');

  // The two range inputs ARE the bounds this test computes against: read them
  // off the markup rather than repeating them, so widening a slider cannot
  // quietly leave the expectations behind.
  const attrs = {};
  for (const m of index.matchAll(/<input[^>]*>/g)) {
    const id = m[0].match(/\sid="([^"]+)"/)?.[1];
    if (!id) continue;
    const at = (n) => m[0].match(new RegExp(`\\s${n}="([^"]+)"`))?.[1];
    attrs[id] = { min: at('min'), max: at('max'), step: at('step'), value: at('value') };
  }
  const ids = new Set([...index.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const nodes = new Map();
  const on = {};
  const document = {
    activeElement: null,
    getElementById(id) {
      if (!ids.has(id)) return null;
      if (!nodes.has(id)) {
        nodes.set(id, {
          ...(attrs[id] ?? {}),
          textContent: '',
          style: { width: '', setProperty() {} },
          addEventListener(type, fn) { (on[id] ??= {}); (on[id][type] ??= []).push(fn); },
        });
      }
      return nodes.get(id);
    },
  };
  new Function('document', script)(document); // runs, and paints once itself
  assert.ok(on.svSubs?.input?.length && on.svPrice?.input?.length, 'the sliders were never wired up');

  const read = (id) => String(nodes.get(id).textContent);
  const drive = (members, price) => {
    nodes.get('svSubs').value = String(members);
    nodes.get('svPrice').value = String(price);
    on.svSubs.input[0]();
  };
  const money = (n) => `$${n > 0 && n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US')}`;

  // 1. The ladder IS TIERS: at every cap, and one step past it.
  const step = Number(attrs.svSubs.step);
  const top = Number(attrs.svSubs.max);
  TIERS.forEach((tier, i) => {
    const at = tier.maxMembers ?? top;
    drive(at, 20);
    assert.equal(read('svDuesPlan'), `${tier.name} plan`, `${at} members is the ${tier.name} tier`);
    assert.equal(read('svDues'), tier.priceUsd ? `$${tier.priceUsd.toFixed(2)}` : '$0',
      `${tier.name} must be quoted at TIERS.priceUsd`);
    const next = TIERS[i + 1];
    if (!next) return;
    drive(tier.maxMembers + step, 20);
    assert.equal(read('svDuesPlan'), `${next.name} plan`,
      `one member past the ${tier.name} cap of ${tier.maxMembers} is the ${next.name} tier`);
  });
  // …and the free tier draws no bar at all, because it costs nothing.
  drive(TIERS[0].maxMembers, 20);
  assert.equal(nodes.get('svBarDues').style.width, '0%', 'a $0 plan draws no bar');

  // 2. The comparison, the sales volume it is a percentage of, and the saving.
  // The rates are the publicly listed pricing each row states in its own copy.
  const RATES = {
    svWhop: ['Whop', (rev) => rev * 0.03],
    svLp: ['LaunchPass', (rev) => 29 + rev * 0.035],
    svPatreon: ['Patreon', (rev) => rev * 0.08],
    svDoorfee: ['DoorFee', (rev) => rev * 0.1],
  };
  const planCost = (m) => (TIERS.find((t) => t.maxMembers !== null && m <= t.maxMembers) ?? TIERS.at(-1)).priceUsd;
  for (const [members, price] of [[10, 1], [50, 1], [100, 20], [510, 1], [1000, 100]]) {
    drive(members, price);
    const rev = members * price;
    const where = `${members} members x $${price}`;
    assert.equal(read('svRev'), money(rev), `${where}: the sales volume every percentage is a percentage of`);
    const costs = Object.entries(RATES).map(([id, [, f]]) => [id, f(rev)]);
    for (const [id, cost] of costs) assert.equal(read(id), money(cost), `${where}: ${id}`);
    const [worstId, worst] = costs.reduce((a, b) => (b[1] > a[1] ? b : a));
    const gap = worst - planCost(members);
    assert.equal(read('svAnnual'), money(Math.max(0, gap * 12)), `${where}: the annual saving`);
    // and the line under it never names a platform as the priciest thing on
    // screen when the flat plan has grown past all four.
    if (gap > 0) assert.equal(read('svVs'), `kept versus ${RATES[worstId][0]}, the priciest at your numbers`, `${where}: names who it beat`);
    else assert.doesNotMatch(read('svVs'), /priciest/, `${where}: a $0 saving must not claim to have beaten anyone`);
  }

  // 3. A typed number is clamped to its slider, so no box can quote a figure
  // the ladder above was never evaluated at.
  const box = nodes.get('svSubsNum');
  box.value = '100000';
  on.svSubsNum.input[0]();
  assert.equal(nodes.get('svSubs').value, top, 'a typed member count lands inside the slider');
  assert.equal(read('svDuesPlan'), `${TIERS.at(-1).name} plan`, 'and the ladder follows it there');
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

  // The OAuth token is sealed at rest like the Stripe keys (same secretbox):
  // a database-only leak must not yield a guilds.join-scoped token. The
  // guilds.join PUT further down proves it opens back to `tok_code_u1`.
  const stored = await userRow(U1);
  assert.match(stored.access_token, /^v1\./, 'access_token must be sealed at rest');
  assert.match(stored.refresh_token, /^v1\./, 'refresh_token must be sealed at rest');
  assert.ok(!stored.access_token.includes('tok_code_u1') && !stored.refresh_token.includes('ref_code_u1'), 'no cleartext token in the row');

  const me = await (await fetch(`${appUrl}/api/me`, { headers: { cookie: u1Cookie } })).json();
  assert.deepEqual({ loggedIn: me.loggedIn, username: me.username }, { loggedIn: true, username: 'trader_one' });

  // Lazy migration: a row written before sealing holds cleartext and must
  // keep working (the mock only honours `Bearer tok_<code>`, so a 200 here
  // means the raw value reached Discord unchanged) until the next sign-in
  // rewrites it sealed.
  await tq('UPDATE users SET access_token = ? WHERE discord_id = ?', ['tok_code_u1', U1]);
  assert.equal((await fetch(`${appUrl}/api/my/guilds`, { headers: { cookie: u1Cookie } })).status, 200, 'a legacy cleartext token still reads');
  const again = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
  const againState = new URL(again.headers.get('location')).searchParams.get('state');
  await fetch(`${appUrl}/auth/callback?code=code_u1&state=${againState}`, {
    redirect: 'manual',
    headers: { cookie: again.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') },
  });
  assert.match((await userRow(U1)).access_token, /^v1\./, 'the next sign-in re-seals the row');
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

test('a failed Discord token exchange explains itself and spends the state cookie (no 500 loop)', async () => {
  // A reused or expired code: Discord answers 400 invalid_grant, which the
  // mock does for any code it has never issued. The buyer came from a plan.
  const login = await fetch(`${appUrl}/auth/login?plan=insider`, { redirect: 'manual' });
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  const cookies = login.headers.getSetCookie().map((c) => c.split(';')[0]);
  const failed = await fetch(`${appUrl}/auth/callback?code=code_never_issued&state=${state}`, {
    redirect: 'manual',
    headers: { cookie: cookies.join('; ') },
  });
  assert.equal(failed.status, 502, 'an upstream sign-in failure is not an opaque 500');
  assert.match(await failed.text(), /Discord did not complete the sign-in/i);
  const set = failed.headers.getSetCookie();
  assert.ok(set.some((c) => /^tl_oauth_state=;.*Max-Age=0/.test(c)), 'the spent state cookie must be cleared');
  assert.ok(!set.some((c) => c.startsWith('tl_checkout_plan=')), 'the plan cookie stays so the retry lands on the plan');
  assert.ok(!set.some((c) => c.startsWith('tl_session=')), 'no session is minted for a failed exchange');

  // A refresh of the same URL — the browser now has no state cookie — takes
  // the existing recovery branch and mints a fresh login instead of failing
  // the same way again.
  const refresh = await fetch(`${appUrl}/auth/callback?code=code_never_issued&state=${state}`, {
    redirect: 'manual',
    headers: { cookie: cookies.filter((c) => !c.startsWith('tl_oauth_state=')).join('; ') },
  });
  assert.equal(refresh.status, 302);
  assert.equal(refresh.headers.get('location'), '/auth/login?retry=1');

  // Two failures in a row: the retry leg's state ends in `.r`, so a refresh
  // of ITS failure page reaches the terminal branch. That branch used to
  // tell a buyer their browser had dropped the login cookie — but the
  // browser kept every cookie it was given; the server spent the state
  // itself when Discord failed. A short-lived marker says which happened.
  const retry = await fetch(`${appUrl}/auth/login?retry=1&plan=insider`, { redirect: 'manual' });
  const retryState = new URL(retry.headers.get('location')).searchParams.get('state');
  const retryCookies = retry.headers.getSetCookie().map((c) => c.split(';')[0]);
  const failedTwice = await fetch(`${appUrl}/auth/callback?code=code_never_issued&state=${retryState}`, {
    redirect: 'manual',
    headers: { cookie: retryCookies.join('; ') },
  });
  assert.equal(failedTwice.status, 502);
  const marker = failedTwice.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_fail='));
  assert.ok(marker && !/Max-Age=0/.test(marker), 'a Discord failure leaves a short-lived marker behind');
  const keptJar = retryCookies.filter((c) => !c.startsWith('tl_oauth_state=')).concat(marker.split(';')[0]);
  const secondRefresh = await fetch(`${appUrl}/auth/callback?code=code_never_issued&state=${retryState}`, {
    redirect: 'manual',
    headers: { cookie: keptJar.join('; ') },
  });
  const secondText = await secondRefresh.text();
  assert.equal(secondRefresh.status, 502, 'an upstream failure is still an upstream failure on the retry leg');
  assert.match(secondText, /Discord did not complete the sign-in/i);
  assert.doesNotMatch(secondText, /did not keep the login cookie/i, 'the browser kept every cookie — do not send this buyer browser-hunting');
  assert.ok(
    secondRefresh.headers.getSetCookie().some((c) => /^tl_oauth_fail=;.*Max-Age=0/.test(c)),
    'the marker is spent once it has been read',
  );
});

test('the Discord token exchange is bounded, like every other Discord call', async () => {
  // The catch above only fires on a rejection. A token endpoint that accepts
  // the connection and never answers does not reject: the callback would sit
  // until the platform killed the function, and that gateway timeout carries
  // no Set-Cookie — so the state cookie survived and every refresh hung the
  // same way. The bound is what turns a hang into the 502 pinned above.
  // (Asserted at the call, not by waiting the ten seconds out.)
  const { exchangeOAuthCode } = await import('../src/lib/discord.js');
  const realFetch = globalThis.fetch;
  let init = null;
  globalThis.fetch = async (url, options) => {
    init = options;
    return new Response(JSON.stringify({ access_token: 'tok', refresh_token: 'ref' }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await exchangeOAuthCode('code_u1');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(init?.signal instanceof AbortSignal, 'the OAuth token exchange must carry a timeout signal');
  assert.equal(init.signal.aborted, false, 'and it must still be live when the request goes out');
});

test('sign-out is a POST; a GET confirms instead of clearing the session', async () => {
  // SameSite=Lax rides on cross-site top-level GETs, so a GET that cleared
  // the cookie would let any third-party link sign a seller out mid-task.
  const get = await fetch(`${appUrl}/auth/logout`, { redirect: 'manual', headers: { cookie: u1Cookie } });
  assert.equal(get.status, 200);
  assert.match(get.headers.get('content-type'), /text\/html/);
  assert.deepEqual(get.headers.getSetCookie(), [], 'a GET must not touch the session');
  assert.match(await get.text(), /<form method="post" action="\/auth\/logout"/, 'the confirm page posts the real sign-out');

  // A cross-site POST cannot carry the Lax cookie: nothing to clear, nothing cleared.
  const foreign = await fetch(`${appUrl}/auth/logout`, { method: 'POST', redirect: 'manual' });
  assert.equal(foreign.status, 302);
  assert.deepEqual(foreign.headers.getSetCookie(), [], 'no session cookie, no clears');

  // The page's own button: a same-site POST carrying the session clears both
  // the domain-scoped cookie and any older host-only one.
  const post = await fetch(`${appUrl}/auth/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: u1Cookie } });
  assert.equal(post.status, 302);
  assert.equal(post.headers.get('location'), '/');
  const clears = post.headers.getSetCookie().filter((c) => /^tl_session=;.*Max-Age=0/.test(c));
  assert.equal(clears.length, 2, 'domain-scoped and host-only clears');
  assert.ok(clears.some((c) => /Domain=tradeleaks\.e2e/.test(c)) && clears.some((c) => !/Domain=/.test(c)));

  assert.equal((await fetch(`${appUrl}/auth/logout`, { method: 'PUT', redirect: 'manual' })).status, 405);

  // And every Sign out button in the product submits that POST — none of
  // them navigates to the GET.
  for (const f of ['app.js', 'account.js', 'dashboard.js', 'home.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
    assert.ok(!src.includes("location.href = '/auth/logout'"), `${f} must not sign out via GET`);
    assert.match(src, /f\.method = 'post';\s*f\.action = '\/auth\/logout';/, `${f} must sign out via a POST form`);
  }
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
    data: { object: { id: 'cs_1', mode: 'subscription', payment_status: 'paid', subscription: 'sub_1', client_reference_id: U1, metadata: { plan_id: 'insider', discord_id: U1 } } },
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
    data: { object: { id: 'cs_3', mode: 'subscription', payment_status: 'paid', subscription: 'sub_3', client_reference_id: U3, metadata: { plan_id: 'pro', discord_id: U3 } } },
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
    data: { object: { id: 'cs_life', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_life_1', client_reference_id: U1, metadata: { plan_id: 'lifetime', discord_id: U1 } } },
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
    data: { object: { id: 'cs_ref', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_ref_1', client_reference_id: U_REF, metadata: { plan_id: 'lifetime', discord_id: U_REF } } },
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
    data: { object: { id: 'cs_ref_sub', mode: 'subscription', payment_status: 'paid', subscription: 'sub_ref_1', client_reference_id: U_REF, metadata: { plan_id: 'insider', discord_id: U_REF } } },
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
    data: { object: { id: 'cs_dis', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_dis_1', client_reference_id: U_REF, metadata: { plan_id: 'lifetime', discord_id: U_REF } } },
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
            mode: 'payment', payment_status: 'paid',
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
      headers: { 'content-type': 'application/json', cookie: await signInOn(app2.url, 'code_u1') },
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
    headers: { 'content-type': 'application/json', cookie: await signInOn(app3.url, 'code_u1') },
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
        object: { id: 'cs_auto_1', mode: 'payment', payment_status: 'paid', client_reference_id: U5, metadata: { plan_id: 'lifetime', discord_id: U5 } },
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
    data: { object: { id: 'cs_platform_u6', mode: 'payment', payment_status: 'paid', client_reference_id: U6, metadata: { plan_id: 'lifetime', discord_id: U6 } } },
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
      data: { object: { id: target.sessionId, mode: 'subscription', payment_status: 'paid', subscription: 'sub_u11', client_reference_id: U11, metadata: { plan_id: 'pro', discord_id: U11 } } },
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
    data: { object: { id: target.sessionId, mode: 'subscription', payment_status: 'paid', subscription: 'sub_u11', client_reference_id: U11, metadata: { plan_id: 'pro', discord_id: U11 } } },
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
      data: { object: { id: 'cs_u10', mode: 'subscription', payment_status: 'paid', subscription: subId, client_reference_id: U10, metadata: { plan_id: 'pro', discord_id: U10 } } },
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
  // Every row says what term it renews on, off its plan: the dashboard's MRR
  // divides a yearly price by twelve with it, and cannot without it.
  assert.equal(u6row.durationDays, null, 'a lifetime row has no term');
  const monthlyRow = data.payments.find((p) => !p.lifetime && p.planId === 'insider');
  assert.equal(monthlyRow?.durationDays, 31, 'a monthly row carries its plan\'s 31-day term');
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
        mode: 'payment', payment_status: 'paid',
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
    data: { object: { id: 'cs_forge_plat', mode: 'subscription', payment_status: 'paid', subscription: 'sub_forge_plat', client_reference_id: '507700000000000007', metadata: { kind: 'platform_plan', tier: 'scale', owner_discord_id: '507700000000000007' } } },
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
  // The footer's community link is the configured invite, the same value the
  // site's /api/community hop redirects to — one env var, both surfaces.
  assert.ok(receipt.html.includes(COMMUNITY_INVITE), 'the receipt links the configured community invite');

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

  // Every listed store is reachable from the row, in BOTH senses: the name
  // opens that seller's dashboard, and the line under it opens the storefront
  // their buyers actually see. The second one is the only route from here into
  // a seller's public page — the platform view prints slugs, and a slug you
  // have to retype into the address bar is not a link. A draft store has no
  // public page, so it says so rather than offering one.
  {
    const src = fs.readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
    const row = src.slice(src.indexOf('const storeRow = (st) =>'), src.indexOf('const userRow = (u) ='));
    assert.match(row, /href="#\/store\/\$\{esc\(st\.slug\)\}"/, 'the name still opens the seller dashboard');
    assert.match(row, /st\.status === 'live'/, 'only a live store is offered as a link');
    assert.match(row, /\$\{location\.origin\}\/\$\{st\.slug\}/, 'and it points at the public storefront, not the dashboard');
    assert.match(row, /target="_blank" rel="noopener noreferrer"/, 'opened in a new tab, without handing the opener over');
    assert.match(row, /Not live yet/, 'a draft store says why there is nothing to open');
    // It rides in the FIRST cell, not in a column of its own: the desktop
    // table already fills its panel, and an eighth column made the whole
    // thing scroll sideways — every row paying for this one.
    const header = src.slice(src.indexOf('<th>Store</th>'), src.indexOf('</tr></thead><tbody>${d.stores'));
    assert.equal(header.split('<th').length - 1, 7, 'the platform Stores table stays seven columns wide');
    assert.ok(row.indexOf('admin-live-link') < row.indexOf('data-th="Owner"'),
      "the live link sits inside the store's own cell");
    // The phone card hides the owner's 19-digit Discord id, and that rule is
    // written as a column position — so it has to name the column Owner is
    // actually in, or it silently starts hiding some other cell.
    const ownerCol = header.split('<th').findIndex((h) => h.includes('>Owner<'));
    assert.equal(ownerCol, 2, 'Owner is the second column of the platform Stores table');
    const css = fs.readFileSync(new URL('../public/dash.css', import.meta.url), 'utf8');
    assert.match(css, new RegExp(`t-stores td:nth-child\\(${ownerCol}\\) \\.dim`),
      'the id-hiding rule names the column Owner actually sits in');
  }

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
  // The platform's own demo store is indexable, linked from the homepage and
  // /help, and has a hand-written head — it is not tenant content, so it is
  // the one store URL the sitemap lists.
  assert.match(sm.body, /https:\/\/dues\.gg\/demo<\/loc>/, 'the hosted demo is in the sitemap');
  // Every title in the sitemap fits Google's ~60-character display width and
  // is unique. Seven ran to 77 characters and the clipped tail was the part
  // that told the pages apart — the fee calculator lost "vs Dues", the
  // comparison index lost "monetization" — and the platforms listicle fell
  // out of its "Best X Alternatives" template as "Best Discord monetization
  // platform Alternatives for Discord". Titles are generated, so the check
  // reads the served pages rather than the generator.
  const decode = (t) => t.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  const seenTitles = new Map();
  for (const loc of [...sm.body.matchAll(/<loc>https:\/\/dues\.gg([^<]*)<\/loc>/g)].map((m) => m[1] || '/')) {
    const { status, body } = await get(loc);
    assert.equal(status, 200, `${loc} is in the sitemap and must serve`);
    const title = decode((body.match(/<title>([^<]*)<\/title>/) || [])[1] || '');
    assert.ok(title, `${loc} has a <title>`);
    assert.ok(title.length <= 60, `${loc} title is ${title.length} chars, over the ~60 Google shows: "${title}"`);
    assert.ok(!seenTitles.has(title), `${loc} shares its title with ${seenTitles.get(title)}`);
    seenTitles.set(title, loc);
  }
  assert.equal(seenTitles.get('Best Discord Monetization Platforms (2026)'), '/alternatives/best-discord-monetization-platforms', 'the platforms listicle carries its hand-written title');
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
  // One URL per index page. The sitemap, the canonicals and the breadcrumbs
  // all say /vs; the footer used to say /vs/ from 46 pages, so every index
  // was linked under two URLs, and /use-cases under neither.
  for (const [p, body] of [['/', home.body], ['/pricing', (await get('/pricing')).body], ['/vs/subscord', sub.body], ['/help', (await get('/help')).body]]) {
    const slashed = [...body.matchAll(/href="(\/(?:vs|tools|guides|use-cases|alternatives)\/)"/g)].map((m) => m[1]);
    assert.deepEqual(slashed, [], `${p} links an index page with a trailing slash`);
  }
  for (const idx of ['/vs', '/tools', '/guides', '/use-cases', '/alternatives']) {
    assert.ok(sub.body.includes(`href="${idx}"`), `the generated footer links ${idx}`);
    assert.ok(home.body.includes(`href="${idx}"`), `the homepage links ${idx}`);
  }

  // /terms and /privacy carry the site header and the grid footer like every
  // other page. They used to have a logo-only header — a visitor landing from
  // a search result had no link into the site — and a flex footer, where the
  // preferred-sources pill theme.js appends (grid-column:1/-1) had no row of
  // its own and landed hard-right beside the legal links.
  for (const legal of ['/terms', '/privacy']) {
    const { status, body } = await get(legal);
    assert.equal(status, 200);
    const navLinks = [...body.matchAll(/<a class="nav-link" href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(navLinks, ['/discover', '/pricing', '/vs', '/tools'], `${legal} carries the site nav`);
    assert.match(body, /<footer class="site-footer cols seo-footer">/, `${legal} uses the grid footer`);
    assert.match(body, /<p class="footer-disclaimer">/, `${legal} footer has the row the preferred-sources pill is inserted before`);
    assert.match(body, /<a href="\/terms">Terms<\/a><a href="\/privacy">Privacy<\/a>/, `${legal} footer links both legal pages`);
  }


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

  // THE SELLER IS NOT ONE OF THEIR OWN MEMBERS. Sellers buy their own role to
  // check the checkout works; that test used to spend a seat on the plan they
  // are billed for — and on a full Free store it also refused them, so the one
  // person who most needs to test the shop was the one who could not. Sitting
  // at exactly 10/10: the owner's own purchase is allowed, and it does not move
  // the number.
  const U7_SELF = '507700000000000007';
  if (!discord.members.has(U7_SELF)) discord.members.set(U7_SELF, new Set());
  const ownTest = await fetch(`${appUrl}/api/checkout/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u7Cookie },
    body: JSON.stringify({ planId, store: 'vip-signals' }),
  });
  assert.equal(ownTest.status, 200, `a seller at their limit can still test their own checkout: ${await ownTest.text()}`);
  const selfGrant = await fetch(`${appUrl}/api/admin/member`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u7Cookie },
    body: JSON.stringify({ store: 'vip-signals', action: 'grant', discordId: U7_SELF, planId }),
  });
  assert.equal(selfGrant.status, 200, await selfGrant.text());
  assert.equal((await billingState(u7Cookie)).usage.members, 10, 'the owner is never counted against their own plan');
  // ...and the public badge tells the same story as the bill.
  const badgeStore = await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json();
  assert.ok(
    badgeStore.store.memberCount === null || badgeStore.store.memberCount === 10,
    `the storefront badge excludes the owner too, saw ${badgeStore.store.memberCount}`,
  );
  const selfRevoke = await fetch(`${appUrl}/api/admin/member`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: u7Cookie },
    body: JSON.stringify({ store: 'vip-signals', action: 'revoke', discordId: U7_SELF }),
  });
  assert.equal(selfRevoke.status, 200, await selfRevoke.text());

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
        mode: 'subscription', payment_status: 'paid',
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

test('store themes: a light colour way inverts the white wordmark', async () => {
  const { themeCss } = await import('../src/lib/theme.js');
  const invert = '.platform-mark, .powered-mark { filter: invert(1); }';
  assert.ok(themeCss({ bg: '#faf9f7' }).includes(invert), 'Ivory ground: the white mark would vanish, so it inverts');
  assert.ok(themeCss({ bg: '#ffffff' }).includes(invert));
  assert.ok(!themeCss({ bg: '#0a0a0a' }).includes(invert), 'a dark ground keeps the white mark');
  // Over a wallpaper the mark sits on the CHROME, and the chrome is 68% of
  // --bg — not the photograph. So --bg still decides, and a light-tone preset
  // (which sets data-theme='light' for the column, and with it styles.css's
  // invert rule) must not blacken the mark on a dark store: sakura and mint
  // were painting a black wordmark onto a near-black footer bar.
  assert.ok(themeCss({ bg: '#faf9f7', bgPreset: 'midnight' }).includes('body.has-bg .platform-mark, body.has-bg .powered-mark { filter: invert(1); }'),
    'a light colour way inverts the mark over a wallpaper too');
  assert.ok(themeCss({ bg: '#0a0a0a', bgPreset: 'sakura' }).includes('body.has-bg .platform-mark, body.has-bg .powered-mark { filter: none; }'),
    'a dark colour way keeps the white mark even under a light-tone preset');
  assert.ok(themeCss({ bg: '#faf9f7', bgUrl: 'https://example.com/bg.gif' }).includes('body.has-bg .platform-mark, body.has-bg .powered-mark { filter: invert(1); }'));
  assert.ok(!themeCss({ bg: '#0a0a0a', bgPreset: 'sakura' }).includes(invert), 'and never the bare rule, which would lose to data-theme=light');
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

  // A FREE STORE GETS THE WHOLE LOOK. Every colour, corner, typeface and
  // material, every background in the picker, and an image imported from the
  // seller's own host. A plan buys member capacity, not a shop window.
  const U7ID = '507700000000000007';
  await tq('DELETE FROM platform_billing WHERE owner_discord_id = ?', [U7ID]);
  assert.equal((await setTheme({ bg: '#071209', accent: '#22c55e', radius: 20 })).status, 200,
    'a free store may set its own colours');
  assert.equal((await setTheme({ bg: '#071209', bgPreset: 'denim' })).status, 200,
    'a free store may use a plain gradient ground');
  assert.equal((await setTheme({ bg: '#071209', bgPreset: 'starfield' })).status, 200,
    'and an animated one');
  assert.equal((await setTheme({ bg: '#071209', bgPreset: 'clouds-day' })).status, 200,
    'and a photographic one');
  assert.equal((await setTheme({ bgUrl: 'https://example.com/bg.gif' })).status, 200,
    'and an image imported from its own host');
  // And the storefront shows what the seller saved, on the free plan.
  assert.equal((await setTheme({ bg: '#071209', accent: '#22c55e', bgPreset: 'starfield' })).status, 200);
  const freePub = await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json();
  assert.equal(freePub.store.theme?.bg, '#071209', 'a free store keeps the colours it chose');
  assert.equal(freePub.store.theme?.bgPreset, 'starfield', 'and the wallpaper it chose');
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
  assert.equal((await setTheme({ bgPreset: 'aurora', material: 'liquid', bgUrl: 'https://cdn.example.com/loop.mp4' })).status, 200);
  const bgPage = await (await fetch(`${appUrl}/vip-signals`)).text();
  // An import outranks a preset while it is allowed: bgLayer paints the url and
  // labels the layer 'custom'. The preset underneath is what it falls back to.
  assert.match(bgPage, /<div class="store-bg" data-bg="custom"/, 'the imported background is rendered');
  assert.match(bgPage, /<body class="has-bg" data-bg="custom" data-material="liquid">/, 'body carries bg + material');

  // THE PLAN LAPSES — and the look does not change. Cancelling costs an owner
  // member capacity, never their shop window, on either render path.
  await tq('DELETE FROM platform_billing WHERE owner_discord_id = ?', [U7ID]);
  const lapsedTheme = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).store.theme;
  assert.match(String(lapsedTheme.bgUrl), /loop\.mp4/, 'a lapsed store keeps the image it imported');
  assert.equal(lapsedTheme.bgPreset, 'aurora', 'and the background it picked');
  assert.equal(lapsedTheme.material, 'liquid', 'and the rest of the look it set');
  const lapsed = await (await fetch(`${appUrl}/vip-signals`)).text();
  assert.match(lapsed, /id="store-theme"/, 'the colour way is still server-rendered');
  assert.match(lapsed, /<div class="store-bg" data-bg="custom"/, 'and the imported image is still painted');
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

// An imported background points at a host nobody at Dues has vetted. The
// paid gate that used to stand in front of it was never a safety control —
// it priced the feature, it did not check the URL — so removing it did not
// widen what a hostile URL can do. What DOES bound it, and what this pins:
//
//   • the value only ever becomes a media element's src, escaped. It cannot
//     run script and never reaches CSS url().
//   • no referrer. Reproduced against a real browser: without the attribute
//     the third-party host is told the visit came from the store's origin;
//     with it, the host learns nothing but the IP it would learn anyway.
//     Same rule for the two other seller-pasted URLs on the page — the shop
//     banner and a product photo.
//   • the extension check is a typo catcher, NOT a promise about the bytes:
//     a host may answer .gif with a 302 to anything (reproduced). That is
//     acceptable — an <img> renders pictures or nothing — so the remedy for
//     a store that abuses it is operational, and it is pinned below.
test('an imported background is a stranger’s host: no referrer, and an operator can pull it', async () => {
  const ownerCookie = await signInOn(appUrl, 'code_u7');   // owns vip-signals
  const setTheme = (theme) =>
    fetch(`${appUrl}/api/admin/store`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ store: 'vip-signals', theme }),
    });

  assert.equal((await setTheme({ bg: '#071209', bgUrl: 'https://cdn.example.com/party.gif' })).status, 200);
  const gif = await (await fetch(`${appUrl}/vip-signals`)).text();
  assert.match(gif, /<img src="https:\/\/cdn\.example\.com\/party\.gif"[^>]*referrerpolicy="no-referrer"/,
    'an imported image must not report the visit to the host it came from');
  // NOT crossorigin: that would make it a CORS request and a host without
  // access-control-allow-origin would render nothing at all.
  assert.doesNotMatch(gif.match(/<div class="store-bg"[\s\S]*?<\/div>/)?.[0] ?? '', /crossorigin/,
    'no crossorigin — it would break honest imports and buys nothing');

  assert.equal((await setTheme({ bg: '#071209', bgUrl: 'https://cdn.example.com/loop.mp4' })).status, 200);
  assert.match(await (await fetch(`${appUrl}/vip-signals`)).text(),
    /<video src="https:\/\/cdn\.example\.com\/loop\.mp4"[^>]*referrerpolicy="no-referrer"/,
    'and neither must an imported video');

  // The other two seller-pasted URLs that land on the same page.
  const storeHtml = fs.readFileSync(path.join(ROOT, 'public', 'store.html'), 'utf8');
  for (const id of ['shop-banner', 'shop-banner-video', 'product-shot']) {
    assert.match(storeHtml.match(new RegExp(`<(?:img|video)[^>]*id="${id}"[^>]*>`))?.[0] ?? '',
      /referrerpolicy="no-referrer"/, `#${id} carries a seller-pasted URL and must not leak the visit`);
  }
  const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  for (const m of appJs.match(/<(?:img|video) class="prod-shot[^>]*>/g) ?? []) {
    assert.match(m, /referrerpolicy="no-referrer"/, `a product card's media must not leak the visit: ${m.slice(0, 60)}`);
  }
  // /discover puts dozens of seller-chosen hosts on one page — same rule.
  const discJs = fs.readFileSync(path.join(ROOT, 'public', 'discover.js'), 'utf8');
  const discTags = discJs.match(/<(?:img|video) class="disc-banner-media[^>]*>/g) ?? [];
  assert.equal(discTags.length, 2, 'both directory banner tags are still built here');
  for (const m of discTags) assert.match(m, /referrerpolicy="no-referrer"/, `a directory banner must not leak the visit: ${m.slice(0, 60)}`);

  // THE REMEDY. A store that puts something ugly on a dues.gg URL is pulled
  // down by the platform owner, not by asking its seller nicely: OWNER_
  // DISCORD_ID may write any store's row. Without this, "take it down" means
  // hand-editing the database.
  const strangerCookie = await signInOn(appUrl, 'code_u3');
  const asStranger = await fetch(`${appUrl}/api/admin/store`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: strangerCookie },
    body: JSON.stringify({ store: 'vip-signals', theme: null }),
  });
  assert.equal(asStranger.status, 403, 'a signed-in stranger cannot touch a store that is not theirs');

  const platformCookie = await signInOn(appUrl, 'code_u1'); // OWNER_DISCORD_ID
  const pulled = await fetch(`${appUrl}/api/admin/store`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: platformCookie },
    body: JSON.stringify({ store: 'vip-signals', theme: null, bannerUrl: '', discoverable: false }),
  });
  assert.equal(pulled.status, 200, 'the platform owner can pull a hostile import off a store they do not own');
  const pulledPage = await (await fetch(`${appUrl}/vip-signals`)).text();
  assert.ok(!pulledPage.includes('store-bg'), 'and the imported background is gone from the served page');
  assert.equal((await (await fetch(`${appUrl}/api/discover?fresh=1`)).json()).stores.some((s) => s.slug === 'vip-signals'),
    false, 'and the store is out of the public directory');
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
  const discoverHtml = await page.text();
  assert.match(discoverHtml, /Find your next community/);
  // It is the first link in every footer and the one page in the sitemap that
  // shipped with no image card: Discord and Slack unfurled it as bare text and
  // X, with no twitter:card at all, as a plain link. The same block every
  // other page carries.
  assert.match(discoverHtml, /property="og:url" content="https:\/\/dues\.gg\/discover"/, '/discover names its own og:url');
  assert.match(discoverHtml, /property="og:image" content="https:\/\/dues\.gg\/og-card\.jpg/, '/discover unfurls with the site card');
  assert.match(discoverHtml, /name="twitter:card" content="summary_large_image"/, '/discover gets the large X card like every other page');
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
  let u7Cookie = await loginAs('code_u7'); // re-issued below when the Stripe key is rotated
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
    data: { object: { id: 'cs_plat_3', mode: 'subscription', payment_status: 'paid', subscription: 'sub_plat_3', client_reference_id: '507700000000000007', metadata: { kind: 'platform_plan', tier: 'starter', owner_discord_id: '507700000000000007' } } },
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
  const meSeller = await (await fetch(`${appUrl}/api/me`, { headers: { cookie: u7Cookie } })).json();
  const meBuyer = await (await fetch(`${appUrl}/api/me`, { headers: { cookie: u9Cookie } })).json();
  assert.equal(meSeller.seller, true, 'store owner is flagged seller');
  assert.equal(meBuyer.seller, false, 'buyer is not');
  // And WHICH stores they run, so a storefront can point its owner back at the
  // dashboard for the store they are standing in. A seller reaches their own
  // shop from that dashboard — usually in a fresh tab, where the browser's
  // back button is dead — and a generic "/dashboard" link put them back at the
  // server picker instead of where they came from.
  assert.ok(meSeller.owns.includes('vip-signals'), 'a seller is told which stores are theirs');
  assert.deepEqual(meBuyer.owns, [], 'a buyer is told about no store, not even one they bought from');

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
  assert.match(sess['discounts[0][coupon]'], /^dues_/, 'a Stripe coupon rides the session');
  assert.equal(sess['metadata[discount_code]'], 'LAUNCH20');
  assert.equal(stripe.coupons.at(-1).percent_off, '20');
  // A second attempt with the same code and terms REUSES the coupon: a failed
  // or abandoned checkout leaves nothing new on the seller's Stripe account.
  const couponCount = stripe.coupons.length;
  const again = await checkout(u9Cookie, { planId: vip.planKey, discountCode: 'launch20' });
  assert.equal(again.status, 200, await again.text());
  assert.equal(stripe.coupons.length, couponCount, 'the same code on the same terms mints no second coupon');
  assert.equal(stripe.checkoutSessions.at(-1)['discounts[0][coupon]'], sess['discounts[0][coupon]']);
  // A fixed code that drags the total under Stripe's per-currency floor is
  // refused by CHECKOUT itself, not only by the preview: the Pay button sends
  // whatever is typed in the box, so a buyer who never clicked Apply must hit
  // the same 409 here — before any coupon is minted on the seller's account.
  const nearly = Math.round((vipNow.priceUsd - 0.25) * 100) / 100;
  assert.equal((await disc({ action: 'create', code: 'NEARLY', kind: 'fixed', amount: nearly, planKey: vip.planKey })).status, 200);
  const nearlyPrev = await fetch(`${appUrl}/api/discount?store=vip-signals&code=NEARLY&plan=${vip.planKey}`);
  assert.equal(nearlyPrev.status, 409, 'preview refuses a total under the card floor');
  const couponsBeforeFloor = stripe.coupons.length;
  const underFloor = await checkout(u9Cookie, { planId: vip.planKey, discountCode: 'NEARLY' });
  assert.equal(underFloor.status, 409, 'checkout refuses the same total, not just the preview');
  assert.match((await underFloor.json()).error, /under the USD minimum of \$0\.50/);
  assert.equal(stripe.coupons.length, couponsBeforeFloor, 'no coupon is minted for a total no card can clear');
  assert.equal((await disc({ action: 'delete', code: 'NEARLY' })).status, 200);
  // Completed payment counts the use.
  await deliverStripe({
    id: 'evt_disc_1',
    type: 'checkout.session.completed',
    // Stripe reports what was actually charged: $59.99 less LAUNCH20 (20%).
    data: { object: { id: 'cs_disc_1', mode: 'payment', payment_status: 'paid', amount_total: 4799, client_reference_id: '509900000000000009', customer_details: { email: 'buyer9@e2e.test' }, metadata: { plan_id: vip.planKey, discord_id: '509900000000000009', store_id: String(storeId), discount_code: 'LAUNCH20' } } },
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
  const rotated = await storeCall({ stripeKey: OWNER2_KEY });
  assert.equal(rotated.status, 200);
  // Re-entering the key is what a seller does when they suspect a compromise:
  // every session of the account dies with it, and the browser doing the
  // rotating is re-issued in the same reply so it is not thrown out.
  const preRotation = u7Cookie;
  u7Cookie = rotated.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  assert.notEqual(u7Cookie, preRotation, 'the rotating browser gets a fresh cookie');
  assert.equal((await (await fetch(`${appUrl}/api/me`, { headers: { cookie: preRotation } })).json()).loggedIn, false, 'the pre-rotation cookie is dead everywhere');
  assert.equal((await fetch(`${appUrl}/api/admin/payments?store=vip-signals`, { headers: { cookie: preRotation } })).status, 401, 'a revoked cookie fails closed on admin reads');
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
  // The dashboard's face, as the two keys the picker writes: `light` for the
  // white face, `darkStyle` for which dark the header button goes back to.
  // Both have to survive the round trip or the seller's choice is a preview
  // that dies on reload — and "light + black" has to be storable together,
  // because that is a white dashboard whose moon returns to black.
  assert.equal((await storeCall({ dashboardPrefs: { light: true, darkStyle: 'black' } })).status, 200);
  const faceRead = async () => (await (await fetch(`${appUrl}/api/admin/payments?store=vip-signals`, { headers: { cookie: u7Cookie } })).json())
    .stores.find((s) => s.slug === 'vip-signals').dashboardPrefs;
  assert.deepEqual(await faceRead(), { darkStyle: 'black', light: true }, 'the light face and its dark half both persist');
  assert.equal((await storeCall({ dashboardPrefs: { darkStyle: 'black' } })).status, 200);
  assert.deepEqual(await faceRead(), { darkStyle: 'black' }, 'going back to the dark face drops the light key');
  // Only the non-default value of each is stored, and only the real boolean:
  // a truthy string is not a face.
  assert.equal((await storeCall({ dashboardPrefs: { light: 'yes', darkStyle: 'navy' } })).status, 200);
  assert.equal(await faceRead(), null, 'navy and not-light are the defaults, so nothing is written at all');
  assert.equal((await storeCall({ dashboardPrefs: { accent: '#5865F2', cards: { mrr: false }, defaultRange: '90' } })).status, 200);
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
  // NOT while anyone holds it. U9 was granted plan2 above and still has it;
  // rolePlanFor builds the role map from the plan rows that exist, so deleting
  // this one would strip U9's role on the next reconcile — the opposite of what
  // the confirm dialog promises. This assertion used to expect 200 here, which
  // is to say the suite was asserting the bug.
  const held = await onboard({ step: 'product-delete', storeId, planKey: plan2.planKey });
  assert.equal(held.status, 409, 'a product with a live holder cannot be deleted');
  assert.match((await held.json()).error, /still holds?.*Deactivate/, 'the refusal names the alternative');
  // ...so the seller ends that membership the way the dashboard does, and the
  // delete goes through.
  assert.equal((await call(u7Cookie, '/api/admin/member', { store: 'vip-signals', action: 'revoke', discordId: U9, planId: plan2.planKey })).status, 200);
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

  // …and deleting the product deletes them — once nobody is mid-checkout on
  // it: the buyer above still has a card form open, so the delete waits.
  assert.equal((await onboard({ step: 'product-delete', storeId, planKey: parent.planKey })).status, 409, 'a product someone is paying for cannot be deleted under them');
  await tq("UPDATE checkout_attempts SET status = 'expired' WHERE status = 'started' AND plan_id IN (?, ?)", [parent.planKey, opt.planKey]);
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
  // With products live the switch is a relabel, not a conversion, so it is
  // refused until the seller confirms the new stickers by name.
  const relabel = await call('/api/admin/store', { store: slug, currency: 'dkk' });
  assert.equal(relabel.status, 409, 'a relabel of live prices needs an explicit confirmation');
  assert.equal((await relabel.json()).needsConfirm, true);
  assert.equal((await call('/api/admin/store', { store: slug, currency: 'dkk', currencyConfirm: 'dkk' })).status, 200);
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
  // The gated buyer's card forms above are still open; let them lapse first.
  await tq("UPDATE checkout_attempts SET status = 'expired' WHERE status = 'started' AND plan_id IN (?, ?)", [plan.planKey, opt.planKey]);
  assert.equal((await onboard({ step: 'product-delete', storeId, planKey: plan.planKey })).status, 200);
});

test('storefront chrome: hidden wins, touch targets reach 44, phone text floors at 12px', async () => {
  // A stylesheet is behaviour too. Each of these pinned a buyer-visible bug
  // that a desktop skim signed off on, and the suite cannot run a browser —
  // so it holds the RULES that fixed them, from the served stylesheet, with
  // the same selectors the pages use.
  const css = await (await fetch(`${appUrl}/styles.css`)).text();
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, ''); // comments talk about selectors too
  const rules = (sel) => {
    // every declaration block whose selector list carries `sel` verbatim
    const out = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(plain))) if (m[1].split(',').map((s) => s.trim()).includes(sel)) out.push(m[2]);
    return out;
  };
  const page = (file) => fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');

  // [hidden] is a UA rule with no specificity; .shop-btn's display:inline-flex
  // beat it and /demo shipped an inert Follow button with .hidden === true.
  // One !important rule, and nothing in the sheet may push back against it.
  assert.match(css, /\n\[hidden\] \{ display: none !important; \}/, 'the generic [hidden] rule must be in the served stylesheet');
  for (const [, sel, body] of plain.matchAll(/([^{}]*\[hidden\][^{}]*)\{([^{}]*)\}/g)) {
    if (/:not\([^)]*\[hidden\]/.test(sel)) continue; // `.x:not([hidden])` is the attribute doing its job
    const d = body.match(/display:\s*([^;!]+)/);
    if (d) assert.equal(d[1].trim(), 'none', `${sel.trim()} must not re-show a hidden element`);
  }
  const demo = await (await fetch(`${appUrl}/api/plans?store=demo`)).json();
  assert.equal(demo.store.followable, false, 'the demo store is not followable, so its Follow button is hidden — and must actually vanish');

  // Touch targets: the phone pass had stopped at 40px, and several controls
  // were never sized for a finger at all. Hit boxes, not drawn boxes.
  const phone = css.slice(css.indexOf('@media (max-width: 560px) {\n  .shop-avatar'));
  assert.match(phone, /\.shop-icon-btn \{ width: 44px; height: 44px;/, 'share button is 44px on phones');
  assert.match(phone, /\.shop-btn \{ flex: 1; height: 44px; \}/, 'Join / Follow are 44px on phones');
  assert.match(rules('.menu-btn')[0], /min-width: 44px; min-height: 44px/, 'the /discover hamburger is 44px');
  // A 4px padding sizes the hit box from the ICON, and the seller-link icons
  // are not square: Discord's 16x12 mark measured 24x20 on a mouse, YouTube's
  // 18x13 measured 26x21 and TikTok's 15x17 measured 23x25 — three of six
  // under 24px in one axis. The floor has to be on the BOX, both axes.
  assert.match(rules('.shop-mlink')[0], /min-width: 24px; min-height: 24px; padding: 4px; margin: -4px;/, 'store links carry a 24px pointer hit box in BOTH axes');
  assert.match(rules('.shop-mlink')[0], /align-items: center; justify-content: center;/, 'and the icon stays centred in whatever box that makes');
  const touch = css.slice(css.indexOf('@media (pointer: coarse) {'));
  assert.ok(touch.length > 30, 'the touch pass exists');
  assert.match(touch, /\.shop-mlink \{ width: 44px; height: 44px; align-items: center; justify-content: center; margin: -13\.5px; \}/, 'store links reach 44px under a finger');
  assert.match(touch, /\.shop-mgroup \{ gap: 27px; \}/, 'store links sit a 44px pitch apart, so the hit boxes do not overlap');
  assert.match(touch, /\.disc-chip \{ padding-top: 14px; padding-bottom: 14px; \}/, 'discover chips grow to 44px');
  assert.match(touch, /\.powered-community::after \{ content: ""; position: absolute; inset: -12px 0; \}/, 'the community link reaches 44px');
  assert.match(touch, /\.footer-col a \{ display: inline-flex; align-items: center; min-height: 38px; \}/, 'footer rows grow to a 44px pitch');
  for (const file of ['index.html', 'pricing.html']) {
    const html = page(file);
    assert.match(html, /\.nav-login\{[^}]*padding:10px 0;margin:-10px 0\}/, `${file}: Log in has a 44px hit box`);
    assert.match(html, /\.hero-foot a\{[^}]*min-height:44px;margin:-6px 0\}/, `${file}: the hero footer links have a 44px hit box in a 32px row`);
    assert.match(html, /\.footer \.soc-tile::after\{content:"";position:absolute;inset:-6px\}/, `${file}: social tiles reach 44px`);
    // The landing footer has a fit budget (the phone reveal disarms when it
    // outgrows the viewport), so these rows cannot grow: the hit box reaches
    // UP into the gap above the row, which is the whole pitch on a phone.
    assert.match(html, /\.footer \.fcol a::after\{content:"";position:absolute;inset:-5px 0 0\}/, `${file}: footer links grow only upward, never the footer`);
  }

  // Phone text floor: nothing a buyer reads sits under 12px.
  const px = (body) => [...body.matchAll(/font(?:-size)?:\s*(?:\d+\s+)?([\d.]+)px/g)].map((m) => Number(m[1]));
  // The list below is every styles.css rule that a BUYER or a VISITOR reads
  // at a size, measured by rendering each page at 390 and at 1440 and asking
  // the browser for the computed font-size of every visible text node. What
  // that sweep does NOT include, deliberately: the miniature type inside the
  // aria-hidden product mock-ups on the marketing pages (.vz-*, .dc-app,
  // .browser-url, .appcard, the chart tick labels) — those are a DRAWING of an
  // interface, not text to read, and scaling their type breaks the drawing.
  for (const sel of ['.shop-rolechip', '.alt-ours', '.footer-head', '.calc-note', '.calc-bar-sub', '.footer-disclaimer',
    '.chip', '.order-card .label', '.kicker', '.shop-rv-you', '.shop-share-tip', '.coin span', '.cpay-coin']) {
    const sizes = rules(sel).flatMap(px);
    assert.ok(sizes.length, `${sel} declares a size`);
    assert.ok(sizes.every((n) => n >= 12), `${sel} must not go under 12px (got ${sizes})`);
  }
  // .marq-cap is pricing.html's alone now — the landing's role marquee was
  // removed, and a floor check that demands a selector the page no longer has
  // is a check about the wrong thing.
  const FLOORS = {
    'index.html': [/\.tog-save\{\s*font-size:([\d.]+)px/, /\.kicker\{\s*display:block;font:600 ([\d.]+)px/, /\.footer \.fcol b\{[^}]*font-size:([\d.]+)px/],
    'pricing.html': [/\.tog-save\{\s*font-size:([\d.]+)px/, /\.marq-cap\{\s*text-align:center;font-size:([\d.]+)px/, /\.kicker\{\s*display:block;font:600 ([\d.]+)px/, /\.footer \.fcol b\{[^}]*font-size:([\d.]+)px/],
  };
  for (const file of ['index.html', 'pricing.html']) {
    const html = page(file);
    for (const re of FLOORS[file]) {
      const m = html.match(re);
      assert.ok(m, `${file}: ${re} must still match`);
      assert.ok(Number(m[1]) >= 12, `${file}: ${re} is ${m[1]}px, under the 12px floor`);
    }
    // the footer heading grew from 10.5px inside a fit-budgeted footer: the
    // leading is what keeps its line box (and the phone budget) unchanged
    assert.match(html, /\.footer \.fcol b\{[^}]*line-height:1\.1;/, `${file}: footer headings keep their 13px line box`);
  }
  const home = page('index.html');
  // The rest of what a visitor reads under 12px on the landing page, found by
  // the same render sweep. .pay-chip b is the load-bearing one: it outranks
  // every .pm-* class rule below it (the .pm-cashchip comment says so), so
  // this single number is the size of EVERY wordmark chip on a phone — VISA,
  // AMEX and both "Pay" marks all measured 11.5px at 390.
  for (const [re, what] of [
    [/\.save-rows-cap\{\s*margin:26px 0 14px;font:600 ([\d.]+)px/, 'the calculator column caption'],
    [/  \.pay-chip b\{font-size:([\d.]+)px\}/, 'the payment wordmark chips on a phone'],
    [/  \.save-hero small\{margin-top:2px;font-size:([\d.]+)px\}/, 'the savings sub-line on a desktop'],
    [/  \.sv-name em\{font-size:([\d.]+)px;margin-left:6px\}/, 'the plan tag in the comparison rows'],
    [/  \.fee-note\{font-size:([\d.]+)px;line-height:17px\}/, 'the fee footnote on a desktop'],
  ]) {
    const m = home.match(re);
    assert.ok(m, `index.html: ${what} must still match ${re}`);
    assert.ok(Number(m[1]) >= 12, `index.html: ${what} is ${m[1]}px, under the 12px floor`);
  }
  assert.match(home, /\.pay-cap\{font:600 12px/, 'the payment caption is 12px');
  assert.match(home, /\.save-cap\{display:block;font:600 12px/, 'the savings caption is 12px');
  assert.doesNotMatch(home, /\.save-cap\{font-size:10\.5px\}/, 'no phone override drags it back under');

  // The legal footnote ran ~185 characters a line on a desktop: capped like
  // every other body block.
  assert.match(rules('.footer-disclaimer')[0], /max-width: 78ch/, 'the footer disclaimer is capped to a readable measure');

  // Store chrome over a wallpaper: header and footer wear the column's
  // translucent ground and the ink, so their text no longer depends on the
  // seller's photo.
  //
  // The STRENGTH of that ground is the whole fix, so it is a number here, not
  // a string. At 46% a near-white wallpaper still won: measured on the served
  // storefront with a painted-pixel probe, the dark colour way gave Sign out
  // 3.43:1 on sakura, 3.56 on mint, 4.39 on lavender, and the "powered by"
  // line 3.89 on sakura/mint and 4.14 on lavender — four presets, mint and
  // lavender both FREE tier. At 68% the worst of all forty presets, on both
  // colour ways, signed in and out, top of page and foot, is 6.75:1.
  const ground = css.match(/body\.has-bg \.top, body\.has-bg > footer \{\n  background: color-mix\(in srgb, var\(--bg\) (\d+)%, transparent\);/);
  assert.ok(ground, 'header + footer get the column ground over a wallpaper');
  assert.ok(Number(ground[1]) >= 68, `the chrome ground is ${ground[1]}%, under the 68% a bright wallpaper needs`);
  assert.doesNotMatch(css, /body\.has-bg \.top \{ background: transparent/, 'the header must not be transparent over a wallpaper');
  assert.match(css, /\nbody\.has-bg > footer, body\.has-bg \.powered-community,\nbody\.has-bg \.top \.nav-link, body\.has-bg \.top \.account, body\.has-bg \.top \.btn-ghost \{ color: var\(--ink\); \}/, 'chrome text over a wallpaper is the ink, not --dim');

  // Day-sky SEO pages: blurple TEXT is the darker token. #5865f2 measured
  // 4.3:1 on the paper and ~3.1:1 under the sky; #424cbd is 6.6:1 on the
  // paper and 5.0:1 on the bluest band a prose link sits on. Pinned in the
  // generator AND in the committed artifacts, so a regenerate that was never
  // run cannot ship the old colour.
  const gen = fs.readFileSync(path.join(ROOT, 'scripts', 'gen-seo-pages.mjs'), 'utf8');
  //
  // The list has to cover the rules styles.css applies as well as the ones the
  // generator writes: .legal a, .faq-item a, .seo-ticks a and .seo-step-num
  // all paint var(--accent), which on a day page IS #5865f2. Measured on the
  // served pages before this line existed: /help's "dashboard" link, /terms'
  // "account page" and "contact@dues.gg", /vs/*'s "fee calculator" and the
  // 1-2-3 numerals on all six /use-cases/* pages were still the button
  // blurple at 4.3:1.
  const textLinks = ['--blurple-text: #424cbd;', '.guide-body a { color: var(--blurple-text); }', '.alt-card .seo-card-cta a { color: var(--blurple-text); }',
    '.seo-card-cta, .cmp-table th:nth-child(2), .calc-label output { color: var(--blurple-text); }',
    '.legal a, .faq-item a, .seo-ticks a, .seo-step-num { color: var(--blurple-text); }'];
  for (const line of textLinks) assert.ok(gen.includes(line), `generator paints "${line}"`);
  assert.doesNotMatch(gen, /\.guide-body a \{ color: #5865f2/, 'prose links never go back to the button blurple');
  for (const seo of ['help.html', 'vs/whop.html', 'use-cases/trading.html', 'tools/whop-fee-calculator.html', 'alternatives/whop-alternatives.html', 'guides/discord-paywall.html']) {
    const html = page(seo);
    for (const line of textLinks) assert.ok(html.includes(line), `${seo} is regenerated with "${line}"`);
  }
  // terms.html, privacy.html and discover.html are HAND-WRITTEN — the
  // generator does not own them, which is exactly how /terms kept serving
  // #5865f2 prose links through a whole generator-only fix. They carry the
  // same block, and in every one of the five day pages a declaration that
  // paints #5865f2 as COLOUR must also paint a background, i.e. the blurple
  // is a fill with white on it, never ink on paper.
  for (const hand of ['terms.html', 'privacy.html', 'discover.html']) {
    const html = page(hand);
    for (const line of textLinks) assert.ok(html.includes(line), `${hand} carries "${line}"`);
  }
  for (const day of ['help.html', 'terms.html', 'privacy.html', 'discover.html', 'vs/whop.html', 'use-cases/trading.html']) {
    const style = page(day).match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, sel, body] of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(^|[;\s])color:\s*#5865f2/i.test(body)) continue;
      assert.match(body, /background:/, `${day}: ${sel.trim().slice(0, 60)} paints the button blurple as text`);
    }
  }
});

test('the homepage fold is copy and one field, and the calculator follows it', async () => {
  // The first screen carried two photographs of the running product for a
  // while. They are gone at the owner's call, so what is pinned here is the
  // shape that replaced them — and, more importantly, that NOTHING of the
  // frames is left behind: a stylesheet full of rules for elements that no
  // longer exist is how the last three redesigns each left a layer of debris.
  const home = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const hero = home.slice(home.indexOf('<header class="hero">'), home.indexOf('<main>'));

  assert.match(hero, /id="captureInput"/, 'the fold still carries the one field a visitor can act on');
  assert.doesNotMatch(hero, /<img /, 'and no image in the fold');
  for (const gone of ['hero-demo', 'demo-store', 'demo-pay', 'demo-chip', 'browser-bar', 'win-dots', 'browser-url']) {
    assert.ok(!home.includes(gone), `no ${gone} left behind, markup or rule`);
  }
  for (const file of ['home-store.webp', 'home-checkout.webp']) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'public', file)), `${file} is deleted, not merely unreferenced`);
  }

  // THE PAYMENT STRIP CARRIES BOTH RAILS, DIVIDED. Card money settles to the
  // seller's own Stripe account and crypto settles to a wallet they nominate:
  // two destinations, so the marks may not read as one undivided row.
  assert.match(home, /<hr class="pay-split" \/>/, 'a drawn rule divides the two rails');
  const cardsAt = home.indexOf('>Cards and wallets<');
  const splitAt = home.indexOf('class="pay-split"');
  const cryptoAt = home.indexOf('>Crypto<');
  assert.ok(cardsAt > 0 && splitAt > cardsAt && cryptoAt > splitAt,
    'cards, then the rule, then crypto — in that order');
  for (const coin of ['BTC', 'ETH', 'USDT', 'USDC', 'SOL', 'LTC', 'DOGE']) {
    assert.match(home, new RegExp(`class="pay-chip pm-${coin.toLowerCase()}"[^>]*>.*?${coin}`),
      `the crypto row carries ${coin}`);
  }
  // The chip's ground is #fff on BOTH faces, so a night-face override would be
  // lightening a colour against white. The first version did exactly that.
  assert.doesNotMatch(home, /data-theme="light"\]\) \.pm-(btc|eth|usdt|usdc|sol|ltc|doge)/,
    'no night-face variant for a mark that always sits on white');

  // THE ROLE MARQUEE IS GONE, and nothing of it is left in the stylesheet.
  for (const gone of ['rolemarq', 'marq-track', 'marq-cap', 'keyframes marq']) {
    assert.ok(!home.includes(gone), `no ${gone} left behind`);
  }

  // THE ORDER BELOW THE HERO. The calculator is the first thing the page asks
  // the visitor about — what they charge, and what a rival's cut of it costs
  // them — so it comes before the explanation of how any of it works. The
  // payment marks close it, which is the last thing a buyer meets.
  const order = ['class="save wrap" id="save"', 'class="how wrap" id="how"', 'class="pay"'];
  let cursor = 0;
  for (const mark of order) {
    const at = home.indexOf(mark, cursor);
    assert.ok(at > 0, `${mark} is on the page, after what precedes it`);
    cursor = at;
  }

  // The bouncing chevron went with the empty sky it pointed down.
  assert.doesNotMatch(home, /hero-scrollhint/, 'no scroll hint left behind');
  assert.doesNotMatch(home, /duesHint/, 'and no keyframes left for it');
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
  // ...and canonicalise to themselves, the way a real store's product page
  // does. The demo branch hardcoded /demo, which told Google to index the
  // store instead of the product page it was on.
  assert.match(demoProd, /<link rel="canonical" href="[^"]*\/demo\/vip-access"/, 'a demo product page is its own canonical');
  assert.match(demoProd, /property="og:url" content="[^"]*\/demo\/vip-access"/, 'a demo product page shares as itself');
  assert.match(page, /<link rel="canonical" href="[^"]*\/demo"/, 'the demo store itself still canonicalises to /demo');
  // /store/<slug> is the same overall URL, everywhere.
  const red = await fetch(`${appUrl}/store/demo`, { redirect: 'manual' });
  assert.equal(red.status, 308);
  assert.equal(red.headers.get('location'), '/demo', '/store/<slug> redirects to the overall URL');
  // The plans payload is fixed, flagged, and never touches the database.
  const plans = await (await fetch(`${appUrl}/api/plans?store=demo`)).json();
  assert.equal(plans.brand, 'Dues Membership');
  // The avatar box is 96 CSS px on the one page sellers judge their own store
  // by; the 48px favicon painted there was a 2x upscale (4x on retina).
  assert.equal(plans.server.iconUrl, '/favicon-96x96.png', 'the demo avatar is the asset that fits its box');
  const avatar = await fs.promises.readFile(new URL('../public/favicon-96x96.png', import.meta.url));
  assert.deepEqual([avatar.readUInt32BE(16), avatar.readUInt32BE(20)], [96, 96], 'and that asset really is 96x96');
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
  const gate = (d) => ({ canWrite: d.canWrite, writeBlock: d.writeBlock });
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
  // The same verdict is reported up front on GET, so the storefront offers the
  // composer only to someone whose post will land — and can say why to the rest.
  assert.deepEqual(gate(await list(null)), { canWrite: false, writeBlock: 'signin' });
  assert.deepEqual(gate(await list(u14Cookie)), { canWrite: false, writeBlock: 'notbuyer' }, 'a non-customer is told the composer is not for them');
  assert.deepEqual(gate(await list(u7Cookie)), { canWrite: false, writeBlock: 'owner' }, 'the seller is offered no composer for their own store');

  // A brand-new purchase is still inside the cooling window.
  await tq('INSERT INTO subscriptions (store_id, discord_id, plan_id, provider, provider_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [storeId, U8, 'vip-access', 'stripe', 'sub_review_e2e', 'active', Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)]);
  assert.equal((await post(u8Cookie, { store: 'vip-signals', rating: 5 })).status, 403, 'reviews open after a cooling period');
  assert.deepEqual(gate(await list(u8Cookie)), { canWrite: false, writeBlock: 'cooling' }, 'inside the window the composer is withheld, with the reason');

  // Age that purchase past the window and the same buyer may speak.
  const old = Math.floor(Date.now() / 1000) - 10 * 24 * 60 * 60;
  await tq('UPDATE subscriptions SET created_at = ? WHERE provider_ref = ?', [old, 'sub_review_e2e']);
  assert.deepEqual(gate(await list(u8Cookie)), { canWrite: true, writeBlock: null }, 'past the window the buyer is offered the composer');
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
  assert.equal((await list(u14Cookie)).writeBlock, 'notbuyer', 'the switch changes what is shown, never who may write');

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

  // Public text is text. String() published "[object Object]" under the
  // store's name behind a 200, and an absent body published "undefined"
  // over whatever the seller had written.
  const replyId = (await list(u7Cookie)).reviews[0].id;
  for (const value of [{ a: 1 }, true, [1, 2], 7]) {
    assert.equal((await post(u7Cookie, { store: 'vip-signals', action: 'reply', id: replyId, body: value })).status, 400, `reply body ${JSON.stringify(value)}`);
    assert.equal((await post(u8Cookie, { store: 'vip-signals', rating: 4, body: value })).status, 400, `review body ${JSON.stringify(value)}`);
  }
  assert.equal((await post(u7Cookie, { store: 'vip-signals', action: 'reply', id: replyId })).status, 400, 'an absent reply body is not a clear');
  assert.match((await list(null)).reviews[0].reply.body, /two channels/, 'none of those touched the reply');
  assert.equal((await post(u7Cookie, { store: 'vip-signals', action: 'reply', id: replyId, body: '' })).status, 200, "'' is still the way to take a reply down");
  assert.equal((await list(null)).reviews[0].reply, null);

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

test('storefront client: the failure states the suite cannot drive in a browser are pinned in the source', async () => {
  // These are client-side renders (no DOM here), so each is held by the line
  // of source that fixes it. Each was a live bug measured in Chromium.
  const read = (p) => fs.readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');
  const app = read('app.js');
  // The "All products" button counts PRODUCTS, like main()'s routing does: a
  // one-product store whose product has price options must not grow a button
  // leading to a one-card shop it was designed never to show.
  assert.match(app, /const multi = state\.plans\.filter\(\(p\) => !p\.variantOf\)\.length > 1;/, 'the back-to-shop button counts products, not price options');
  // ...but it is never the reason the slot is EMPTY. A one-product store is
  // routed straight into its order card, so with no link up to the store page
  // that card is the whole storefront and a fresh tab (the dashboard's "View
  // store", a QR code, a link posted in Discord) has nothing on it that goes
  // anywhere. scripts/verify-store-escape.mjs drives this in a browser; the
  // line is held here so `npm test` alone still catches its removal.
  assert.match(app, /back\.hidden = !\(STORE_SLUG && state\.view === 'checkout'\);/, 'every store checkout offers the way up to its store page');
  // The crypto pay screen has no pay button by design (a second invoice would
  // split the payment across two addresses) and hides the method tiles, so its
  // cancel control is the only thing on it that goes anywhere.
  assert.match(app, /if \(state\.cryptoOrder\) \{\s*\n\s*box\.hidden = true;/, 'the method tiles stand down while a crypto order is open');
  assert.match(app, /const cancel = \$\('#cryptopay-cancel'\);/, 'the crypto pay screen wires its own exit');
  const dash = read('dashboard.js');
  // The Appearance preview is a live storefront in an iframe with no address
  // bar and no back button. Clicking through it walked the frame into the
  // checkout and then out to Stripe, and its header offered "Sign out" —
  // which signed the owner out of the dashboard around it.
  assert.match(dash, /f\.contentDocument\?\.addEventListener\(\s*\n?\s*'click',/, 'the store preview swallows clicks instead of navigating the frame');
  // "Lifetime (lifetime)": the parent option's synthesised label is its cadence.
  assert.match(app, /sameWord \? '' : `<small>\$\{cadence\}<\/small>`/, 'the cadence suffix is dropped when the label already is the cadence');
  // A Discord CDN miss falls back to the letter placeholder instead of a hole,
  // and a url that already failed is not re-shown by the next render.
  assert.match(app, /icon\.dataset\.failed !== state\.server\.iconUrl/, 'the shop avatar remembers a failed url');
  assert.match(app, /logo\.dataset\.failed !== state\.server\.iconUrl/, 'the checkout server icon remembers a failed url');
  // Every page a buyer can be standing on mid-purchase wears the same header
  // mark, and on every one of them it is a LINK. The receipt's was a bare
  // <img>: the one page reached straight from Stripe, where a dead logo is the
  // difference between "click the thing that always goes home" and nothing.
  for (const f of ['store.html', 'receipt.html', 'account.html', 'dashboard.html']) {
    assert.match(read(f), /<a href="\/"><img class="platform-mark"/, `${f}'s header mark must link home`);
  }
  const store = read('store.html');
  const img = (marker) => store.match(new RegExp(`<img[^>]*${marker}[^>]*>`))?.[0] ?? '';
  assert.match(img('id="shop-icon"'), /onerror="[^"]*shop-icon-ph[^"]*"/, '#shop-icon swaps to the placeholder on error');
  assert.match(img('class="logo op-server-icon"'), /onerror="[^"]*this\.hidden = true[^"]*"/, '.op-server-icon hides itself on error');
  // The composer is gated on the server's verdict, never offered to a 403.
  assert.match(app, /if \(!mine && !reviewState\.canWrite\)/, 'the review composer is gated on canWrite');
  // With scripts off the app pages say so instead of rendering an empty shell.
  for (const f of ['store.html', 'dashboard.html', 'account.html', 'receipt.html']) {
    const m = read(f).match(/<noscript>([\s\S]*?)<\/noscript>/);
    assert.ok(m, `${f} must carry a <noscript> line`);
    assert.match(m[1].replace(/<[^>]+>/g, ''), /JavaScript enabled/, `${f}'s no-script line must say what is needed`);
  }
  // A receipt with no order behind it says so, rather than sitting on
  // "Payment received / Finishing up your order…" forever.
  const receipt = read('receipt.js');
  // ...and ONLY a receipt with no order behind it. 404 is the single answer
  // /api/plans gives for an unknown store; a 5xx out of guard() or a 429 is a
  // blip, and telling a buyer who just paid that their link points at nothing
  // is a false claim the old stuck-pending page never made.
  assert.match(receipt, /if \(plansRes\.status === 404\) return showNotFound\(\)/, 'only a 404 renders the not-found receipt');
  assert.doesNotMatch(receipt, /if \(!plansRes\.ok\) return showNotFound\(\)/, 'a transient /api/plans failure must not claim the order does not exist');
  assert.match(receipt, /plansRes\.ok \? await plansRes\.json\(\)/, 'a failed catalogue degrades to empty so the buyer\'s own subscription row still names the order');
  assert.match(receipt, /if \(!plan\) return showNotFound\(\)/, 'a missing ?plan renders the not-found receipt');
  assert.match(read('receipt.html'), /<section class="panel" id="r-details">/, 'the details panel is addressable so the not-found state can hide its dashes');

  // ── the demo checkout ─────────────────────────────────────────────────────
  // /demo plays the page a buyer really lands on. Two things hold it in place
  // and neither can be checked from the network: it must stay INCAPABLE of
  // taking a card, and it must not pass itself off as Stripe's own page.
  const demo = app.slice(app.indexOf('function demoCheckout(plan) {'), app.indexOf('async function pay(btn, plan)'));
  assert.ok(demo.length > 2000, 'demoCheckout must still be there to check');
  for (const banned of ['<form', '<input', '<textarea', '<select', 'contenteditable', 'fetch(']) {
    assert.ok(!demo.includes(banned), `the demo checkout must contain no ${banned} — it cannot be able to take a card`);
  }
  // It says what it is ABOVE anything form-shaped, and keeps saying it.
  assert.match(demo, /<p class="dcx-strip"><b>Demo<\/b>/, 'the demo strip spans the top of the panel');
  assert.match(demo, /<span class="dcx-badge">Demo<\/span>/, 'and the badge is still on the pay column');
  assert.match(app, /if \(state\.capabilities\.demo\) \{\n    const demoNote/, 'the demo store says nothing is for sale BEFORE the button is pressed, not only after');
  // Mode decides the page the way the hosted one does: a recurring price is
  // headed "Subscribe to <product>" and pays with Subscribe, a one-off is
  // headed "Pay <merchant>" and pays with Pay.
  assert.match(demo, /const sub = Boolean\(plan\.interval\);/, 'the demo splits on subscription vs one-off');
  assert.match(demo, /sub \? `Subscribe to \$\{esc\(plan\.name\)\}` : `Pay \$\{esc\(merchant\)\}`/, 'the summary heading follows the mode');
  assert.match(demo, /\$\{sub \? 'Subscribe' : 'Pay'\}<\/button>/, 'so does the button label');
  assert.match(demo, /Total due\$\{sub \? ' today' : ''\}/, 'and the total line');
  assert.match(demo, /By confirming your subscription/, 'a subscription carries the mandate sentence the buyer really agrees to');
  // The fields a buyer meets, in the order they meet them — every one a div.
  assert.deepEqual(
    [...demo.matchAll(/data-f="([a-z]+)"/g)].map((m) => m[1]),
    ['email', 'card', 'exp', 'cvc', 'name', 'country', 'zip'],
    'email, card group, cardholder name, country + postal — the hosted page\'s own order',
  );
  // The trust mark that page really carries, as plain text in our own type…
  assert.match(demo, /Powered by Stripe/, 'the factual trust mark stays');
  // …and nothing that wears Stripe's identity instead of stating a fact.
  assert.doesNotMatch(demo, /stripe\.com|stripe[-_.]?(logo|mark|wordmark|svg|png)/i, 'the demo must not reproduce Stripe\'s own mark');
  const css = read('styles.css');
  assert.match(css, /\.dcx-strip \{[^}]*position: sticky/, 'the demo strip stays put while the panel scrolls');
  assert.match(css, /@media \(min-width: 761px\) \{ \.dcx-sumbar \{ display: none; \} \}/, 'the summary sits beside the form on a laptop and folds into a disclosure on a phone');
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
  // A Bitcoin P2SH address ("3…") shares its version byte with Litecoin's
  // retired P2SH prefix, so it decodes cleanly on both chains. Both live in
  // the same wallet app and both start with 3 — it must NOT pass as LTC, and
  // it must never be reported as checksum-verified for LTC.
  assert.equal(validateAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'btc').ok, true);
  assert.deepEqual(
    (({ ok, verified }) => ({ ok, verified }))(validateAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'ltc')),
    { ok: false, verified: false },
    'a BTC P2SH address is not a Litecoin payout wallet',
  );
  assert.equal(validateAddress('MJRSgZ3UUFcTBTBAaN38XAXvZLwRe8WVw7', 'ltc').ok, true, 'the current LTC P2SH prefix (M…) still works');
  assert.equal(validateAddress('LM2WMpR1Rp6j3Sa59cMXMs1SPzj9eXpGc1', 'ltc').ok, true);
  // Cardano: the bech32 checksum alone would pass a six-character string.
  // A real Shelley address has a header byte and 28-byte hashes behind it.
  assert.equal(validateAddress('addr1mykd6t', 'ada').ok, false, 'a valid checksum over no payload is not an address');
  assert.equal(validateAddress('addr1pzrux20ll', 'ada').ok, false);
  assert.equal(validateAddress('addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x', 'ada').ok, true, 'CIP-19 base address');
  assert.equal(validateAddress('addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8', 'ada').ok, true, 'CIP-19 enterprise address');
  assert.equal(validateAddress('addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae', 'ada').ok, false, 'testnet is not somewhere a payout can go');
  assert.equal(validateAddress('stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw', 'ada').ok, false, 'a stake address cannot receive a payment');
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

  // A coin NOWPayments cannot pay out to this address. The provider is the
  // authority on that pair — the deposit list (/merchant/coins) is a
  // different set and must not be what decides it.
  const offCoin = await npStore({ cryptoWallet: 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L', cryptoChain: 'doge' }, npCookie);
  assert.equal(offCoin.status, 400, 'payouts can only go out in a coin the account can actually send');
  assert.match((await offCoin.json()).error, /cannot send DOGE payouts/);

  // XMR is enabled for deposits in the mock but payouts cannot settle in
  // it: gating on the deposit list would save this and every sale would
  // then fail at the provider, on the buyer's screen.
  const depositOnly = await npStore(
    { cryptoWallet: '888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRWKTHmfRUmsdzh1Yg3hCzE5aFbhQirD2u9vnXR', cryptoChain: 'xmr' },
    npCookie,
  );
  assert.equal(depositOnly.status, 400, 'a deposit-only coin is not a payout coin');
  assert.match((await depositOnly.json()).error, /cannot send XMR payouts/);

  // The converse: Litecoin is NOT in the deposit list, but the provider pays
  // out in it fine — so the save goes through (after the usual confirm).
  const LTC_WALLET = 'MJRSgZ3UUFcTBTBAaN38XAXvZLwRe8WVw7';
  const ltcUnconfirmed = await npStore({ cryptoWallet: LTC_WALLET, cryptoChain: 'ltc' }, npCookie);
  assert.equal(ltcUnconfirmed.status, 409, 'a payout coin outside the deposit list is not refused — only confirmed');
  const ltcSaved = await npStore({ cryptoWallet: LTC_WALLET, cryptoChain: 'ltc', cryptoWalletConfirm: LTC_WALLET }, npCookie);
  assert.equal(ltcSaved.status, 200, await ltcSaved.clone().text());
  assert.equal((await ltcSaved.json()).store.cryptoChain, 'ltc');
  const validated = nowpayments.validated.at(-1);
  assert.deepEqual({ address: validated.address, currency: validated.currency }, { address: LTC_WALLET, currency: 'ltc' }, 'the exact pair the seller is saving is what the provider was asked about');

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

  // Every coin toggled off in the dashboard (or a response of a shape the
  // parser does not know) is "nothing to pay with", not a ready picker —
  // and it must not be remembered: the very next request asks again.
  nowpayments.noCoins = true;
  const none = await (await fetch(`${appUrl}/api/checkout/crypto?coins=1&store=vip-signals`)).json();
  assert.deepEqual(none, { ready: false, coins: [] }, 'an empty coin list is not a ready rail');
  nowpayments.noCoins = false;
  const coins = await (await fetch(`${appUrl}/api/checkout/crypto?coins=1&store=vip-signals`)).json();
  assert.equal(coins.ready, true, 'the empty answer was not cached');
  // Read out of the key NOWPayments actually documents for /v1/merchant/coins
  // — their sample answers `{"currencies": [...]}`, and `selectedCurrencies`
  // appears nowhere in their docs. The parser tolerates both; this is the one
  // that has to work.
  assert.deepEqual(coins.coins, ['sol', 'usdtsol', 'btc', 'eth', 'xmr'], 'tickers arrive lowercased and cheapest chains first');

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
  // The three fields NOWPayments marks required on POST /v1/payment, and the
  // pair of flow flags every payment here rides on. `is_fee_paid_by_user`
  // cannot stand alone — the provider forces fixed rate under it — so sending
  // it without `is_fixed_rate` would leave the fixed-rate quote the pay screen
  // counts down to as an accident rather than a request.
  assert.deepEqual(
    { p: typeof sent.price_amount, c: sent.price_currency, pc: sent.pay_currency, fr: sent.is_fixed_rate, fee: sent.is_fee_paid_by_user },
    { p: 'number', c: 'usd', pc: 'sol', fr: true, fee: true },
  );
  // pay_amount is left out ON PURPOSE: it is optional, and omitting it is what
  // makes the provider convert price_amount at ITS rate. Filling it in would
  // quote the buyer a coin figure of our own that the invoice is then judged
  // against.
  assert.equal('pay_amount' in sent, false, 'the coin figure is the provider\'s to compute, not ours to assert');

  // The order row exists BEFORE any money can move — it is the only mapping
  // back from an IPN to which buyer bought what.
  const { rows } = await tq('SELECT * FROM checkout_attempts WHERE session_id = ?', [order.orderId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].discord_id, NP_BUYER);
  assert.equal(rows[0].provider_ref, 'npid_1');
  npOrder = order;
});

test('crypto: a payout address with no chain refuses to create a payment rather than paying out in the buyer\'s coin', async () => {
  // The only writer sets wallet and chain together, but the columns are
  // independent: a migration or a support edit can leave the chain empty.
  // That must never become "pay the seller in whatever the buyer sent" —
  // BTC to a Solana address is the one outcome worse than custody.
  await tq('UPDATE stores SET crypto_chain = NULL WHERE slug = ?', ['vip-signals']);
  const before = nowpayments.created.length;
  try {
    const plans = await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json();
    // And the storefront must not advertise the rail on half a row. One
    // predicate — wallet AND chain — decides the tile, the coin list and the
    // payment, so a buyer is never walked through picking a coin only to be
    // refused at the end of it.
    assert.equal(plans.capabilities.nowpayments, false, 'half a payout row is not a working crypto rail');
    assert.deepEqual(
      await (await fetch(`${appUrl}/api/checkout/crypto?coins=1&store=vip-signals`)).json(),
      { ready: false, coins: [] },
      'the coin picker is told there is nothing to pay with, not handed a grid',
    );
    const res = await fetch(`${appUrl}/api/checkout/crypto`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: npBuyerCookie },
      body: JSON.stringify({ store: 'vip-signals', planId: plans.plans[0].id, payCurrency: 'btc' }),
    });
    assert.equal(res.status, 409, await res.clone().text());
    assert.equal(nowpayments.created.length, before, 'the provider must not have been asked');
    const { createPayment } = await import('../src/lib/nowpayments.js');
    await assert.rejects(
      createPayment({ plan: plans.plans[0], store: { cryptoWallet: SOL_WALLET, cryptoChain: '' }, amount: 10, payCurrency: 'btc', orderId: 'np_x' }),
      /no payout chain/,
      'the library refuses on its own, whatever the caller checked',
    );
  } finally {
    await tq('UPDATE stores SET crypto_chain = ? WHERE slug = ?', ['sol', 'vip-signals']);
  }
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

test('managed store: a role deleted and re-created under its name still lands — no 500 loop', async () => {
  // The seller picked @VIP for a product. Later they delete that role in
  // Discord and make a new one with the same name. The stored id is dead:
  // Discord answers 404 Unknown Role to any grant of it. Every sale of that
  // product used to 500-loop — no role, no receipt, no sale ping, and Stripe
  // retrying the same event for days — because a managed store's ids were
  // never checked against the live guild and the stored NAME was never read.
  const loginAs = async (code) => {
    const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
    const st = new URL(login.headers.get('location')).searchParams.get('state');
    const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
    const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${st}`, { redirect: 'manual', headers: { cookie: sc.split(';')[0] } });
    return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  };
  const u7Cookie = await loginAs('code_u7');
  const onboard = (body) =>
    fetch(`${appUrl}/api/onboard`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: u7Cookie }, body: JSON.stringify(body) });
  const owned = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u7Cookie } })).json();
  const storeId = owned.stores.find((s) => s.slug === 'vip-signals').id;
  const made = await onboard({ step: 'product', storeId, name: 'Stale Role Club', priceUsd: 25, lifetime: true });
  const madeBody = await made.text();
  assert.equal(made.status, 200, madeBody);
  const plan = JSON.parse(madeBody).plan;
  assert.equal((await onboard({ step: 'role', storeId, planKey: plan.planKey, roleId: R2_VIP })).status, 200);

  // The seller deletes @VIP and re-creates it: a new snowflake, the same name.
  const R2_VIP_AGAIN = '2200000000000000102';
  discord.g2RolesOverride = [
    { id: G2, name: '@everyone', position: 0, permissions: '0', color: 0 },
    { id: R2_BOT, name: 'Dues', position: 40, permissions: String(1 << 28), color: 0, managed: true },
    { id: R2_VIP_AGAIN, name: 'VIP', position: 7, permissions: '0', color: 5793266 },
  ];
  try {
    const UID = '516600000000000016';
    discord.members.set(UID, new Set());
    const callsBefore = discord.roleCalls.length;
    const emailsBefore = resend.emails.length;
    const pingsBefore = discord.channelPosts.length;
    const evt = {
      id: 'evt_stale_role_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_stale_role_1', mode: 'payment', payment_status: 'paid', amount_total: 2500, client_reference_id: UID, customer_details: { email: 'stale@e2e.test' }, metadata: { plan_id: plan.planKey, discord_id: UID, store_id: String(storeId) } } },
    };
    const delivered = await deliverStripe(evt, { path: `/webhooks/stripe/${storeId}`, header: signStripe(JSON.stringify(evt), nowSec(), AUTO_ENDPOINT_SECRET) });
    assert.equal(delivered.status, 200, delivered.body);
    assert.ok(memberRoles(UID).has(R2_VIP_AGAIN), 'the live role with the same name is delivered');
    assert.ok(!discord.roleCalls.slice(callsBefore).some((c) => c.uid === UID && c.roleId === R2_VIP), 'the dead id is never attempted');
    assert.ok(resend.emails.length > emailsBefore, 'the receipt still goes out');
    assert.ok(discord.channelPosts.length > pingsBefore, 'the sale ping still goes out');
    // A sweep has nothing to add and nothing to strip.
    const sweepFrom = discord.roleCalls.length;
    assert.equal((await hitCron()).status, 200);
    assert.ok(memberRoles(UID).has(R2_VIP_AGAIN), 'the sweep keeps the role');
    assert.equal(discord.roleCalls.slice(sweepFrom).filter((c) => c.uid === UID).length, 0, 'the sweep has nothing to do');
  } finally {
    discord.g2RolesOverride = null;
  }
  // Park the product so later catalogs are unchanged.
  assert.equal((await onboard({ step: 'product-update', storeId, planKey: plan.planKey, active: false })).status, 200);
});

test('a sealed Stripe key that no longer opens: no Stripe call on any path, and the owner is told', async () => {
  // The tenant key is sealed with a key derived from SESSION_SECRET. Rotate
  // that secret and the blob still exists but will not open — a state that
  // must never fall back to the platform's key, on the session OR the coupon
  // call, and that the owner's checklist must name instead of hiding.
  const app2 = await spawnApp({ ...phase1Env, SESSION_SECRET: 'rotated-e2e-session-secret-9876543210-zyxw' });
  try {
    const loginAs = async (code) => {
      const login = await fetch(`${app2.url}/auth/login`, { redirect: 'manual' });
      const st = new URL(login.headers.get('location')).searchParams.get('state');
      const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
      const cb = await fetch(`${app2.url}/auth/callback?code=${code}&state=${st}`, { redirect: 'manual', headers: { cookie: sc.split(';')[0] } });
      return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
    };
    const plansRes = await (await fetch(`${app2.url}/api/plans?store=vip-signals`)).json();
    assert.equal(plansRes.capabilities.stripe, false, 'buyers see the card rail as not ready, not a dead button');
    const plan = plansRes.plans.find((p) => !p.variantOf && !p.requiredRoleName);
    assert.ok(plan, 'vip-signals still lists an open product');
    const buyer = await loginAs('code_gate');
    const sessionsBefore = stripe.checkoutSessions.length;
    const couponsBefore = stripe.coupons.length;
    const plain = await fetch(`${app2.url}/api/checkout/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: buyer }, body: JSON.stringify({ store: 'vip-signals', planId: plan.id }) });
    assert.equal(plain.status, 502);
    assert.match((await plain.json()).error, /payment could not be started/i);
    const withCode = await fetch(`${app2.url}/api/checkout/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: buyer }, body: JSON.stringify({ store: 'vip-signals', planId: plan.id, discountCode: 'launch20' }) });
    assert.equal(withCode.status, 502);
    assert.match((await withCode.json()).error, /payment could not be started/i, 'a code does not turn the refusal into "the discount is broken"');
    assert.equal(stripe.checkoutSessions.length, sessionsBefore, 'no session on any Stripe account');
    assert.equal(stripe.coupons.length, couponsBefore, 'no coupon on any Stripe account');
    // The owner's own view says so, in the checklist's words.
    const owner = await loginAs('code_u7');
    const mine = (await (await fetch(`${app2.url}/api/admin/payments`, { headers: { cookie: owner } })).json()).stores.find((s) => s.slug === 'vip-signals');
    assert.equal(mine.hasStripeKey, false, 'a key that cannot be read is not a connected one');
    assert.equal(mine.stripeKeyBroken, true);
  } finally {
    app2.child.kill();
  }
});

test('a revoke whose Discord call fails is retried by the sweep and by the button', async () => {
  // Revoke writes 'canceled' and then calls Discord. When that call failed —
  // a 5xx, or the paid role dragged above the bot — the member kept the
  // role, nothing ever revisited a canceled row, and the button answered 404
  // from then on because the row was already canceled. The sweep now
  // revisits revoked rows for a week, and the button reconciles even when
  // there is nothing live left to cancel.
  const loginAs = async (code) => {
    const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
    const st = new URL(login.headers.get('location')).searchParams.get('state');
    const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
    const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${st}`, { redirect: 'manual', headers: { cookie: sc.split(';')[0] } });
    return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  };
  const u7Cookie = await loginAs('code_u7');
  const call = (body) =>
    fetch(`${appUrl}/api/admin/member`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: u7Cookie }, body: JSON.stringify({ store: 'vip-signals', ...body }) });
  const plans = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans;
  const plan = plans.find((p) => !p.variantOf && !p.requiredRoleName);
  const UID = '517700000000000017';
  discord.members.set(UID, new Set());
  const granted = await call({ action: 'grant', discordId: UID, planId: plan.id });
  assert.equal(granted.status, 200, await granted.text());
  assert.ok(memberRoles(UID).has(R2_VIP), 'the grant delivered the role');
  discord.failRoleRemovalsWith = 503;
  try {
    const first = await call({ action: 'revoke', discordId: UID });
    assert.equal(first.status, 500, 'the lost Discord call surfaces as a failure');
    assert.ok(memberRoles(UID).has(R2_VIP), 'the role was NOT taken back — that is the lost call');
  } finally {
    discord.failRoleRemovalsWith = null;
  }
  // The sweep revisits the revoked row and takes the role back.
  assert.equal((await hitCron()).status, 200);
  assert.ok(!memberRoles(UID).has(R2_VIP), 'the next sweep takes the role back');
  // And the button can be clicked again although nothing is live any more.
  discord.members.get(UID).add(R2_VIP);
  const again = await call({ action: 'revoke', discordId: UID });
  assert.equal(again.status, 200, await again.text());
  assert.ok(!memberRoles(UID).has(R2_VIP), 'a retry of the button reconciles');
  // A member who never had a row here is still a 404.
  assert.equal((await call({ action: 'revoke', discordId: '518800000000000018' })).status, 404);
});

test('gifts are one row and zero revenue; a use counts only when a grant lands; a refused role does not 500 a paid sale', async () => {
  const loginAs = async (code) => {
    const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
    const st = new URL(login.headers.get('location')).searchParams.get('state');
    const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
    const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${st}`, { redirect: 'manual', headers: { cookie: sc.split(';')[0] } });
    return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  };
  const u7Cookie = await loginAs('code_u7');
  const post = (path, body) =>
    fetch(`${appUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: u7Cookie }, body: JSON.stringify({ store: 'vip-signals', ...body }) });
  const plans = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans;
  const plan = plans.find((p) => !p.variantOf && !p.requiredRoleName);
  const owned = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u7Cookie } })).json();
  const storeId = owned.stores.find((s) => s.slug === 'vip-signals').id;
  const uses = async () => (await (await post('/api/admin/discounts', { action: 'list' })).json()).discounts.find((d) => d.code === 'LAUNCH20').uses;
  const signed = (evt) => deliverStripe(evt, { path: `/webhooks/stripe/${storeId}`, header: signStripe(JSON.stringify(evt), nowSec(), AUTO_ENDPOINT_SECRET) });
  const completed = (id, uid, planId, extra = {}) => ({
    id: `evt_${id}`, type: 'checkout.session.completed',
    data: { object: { id: `cs_${id}`, mode: 'payment', payment_status: 'paid', amount_total: 1000, client_reference_id: uid, customer_details: { email: `${id}@e2e.test` }, metadata: { plan_id: planId, discord_id: uid, store_id: String(storeId), ...extra } } },
  });

  // 1. A double-clicked manual grant is ONE membership, priced at nothing —
  //    on the seller's dashboard and on the platform page alike.
  const GIFT = '519900000000000019';
  discord.members.set(GIFT, new Set());
  const u1Cookie = await loginAs('code_u1');
  const platform = async () => (await (await fetch(`${appUrl}/api/admin/platform`, { headers: { cookie: u1Cookie } })).json());
  const platBefore = await platform();
  const twice = await Promise.all([0, 1].map(() => post('/api/admin/member', { action: 'grant', discordId: GIFT, planId: plan.id })));
  assert.deepEqual(twice.map((r) => r.status), [200, 200]);
  const rows = (await (await fetch(`${appUrl}/api/admin/payments?store=vip-signals`, { headers: { cookie: u7Cookie } })).json()).payments.filter((p) => p.discordId === GIFT);
  assert.equal(rows.length, 1, 'a double click is one membership');
  assert.equal(rows[0].amountUsd, 0, 'a gift is not revenue');
  const platAfter = await platform();
  const storeRev = (d) => d.stores.find((s) => s.slug === 'vip-signals').revenueUsd;
  assert.equal(storeRev(platAfter), storeRev(platBefore), 'the platform page prices a gift at nothing too');
  assert.equal(platAfter.totals.allTimeUsd, platBefore.totals.allTimeUsd, 'and its all-time volume does not move');

  // 2. A discounted sale of a product the store no longer has grants nothing
  //    and burns no use.
  const before = await uses();
  const GHOST = '520000000000000020';
  discord.members.set(GHOST, new Set());
  assert.equal((await signed(completed('ghost_1', GHOST, 'ghost-product', { discount_code: 'LAUNCH20' }))).status, 200);
  assert.equal(await uses(), before, 'no grant, no use burned');

  // 3. A role Discord refuses (dragged above the bot: 403) must not turn a
  //    PAID sale into a 500 loop that withholds the receipt, the sale ping
  //    and the use count for as long as Stripe retries. The row lands, the
  //    buyer is told, and the next sweep delivers the role.
  const STUCK = '521100000000000021';
  discord.members.set(STUCK, new Set());
  const emailsBefore = resend.emails.length;
  const pingsBefore = discord.channelPosts.length;
  discord.failRoleAddsWith = 403;
  let stuck;
  try {
    stuck = await signed(completed('stuck_1', STUCK, plan.id, { discount_code: 'LAUNCH20' }));
  } finally {
    discord.failRoleAddsWith = null;
  }
  assert.equal(stuck.status, 200, stuck.body);
  assert.ok(!memberRoles(STUCK).has(R2_VIP), 'the role could not be delivered yet');
  assert.ok(resend.emails.length > emailsBefore, 'the receipt still goes out');
  assert.ok(discord.channelPosts.length > pingsBefore, 'the sale ping still goes out');
  assert.equal(await uses(), before + 1, 'the use is counted once the grant landed');
  assert.equal((await hitCron()).status, 200);
  assert.ok(memberRoles(STUCK).has(R2_VIP), 'the next sweep delivers the role once Discord allows it');
});

test('whole numbers bound for bigint columns are safe integers, and an oversized store id on the public webhook route is a 404', async () => {
  // On Postgres 1e21 and twenty digits are not "a big number", they are a
  // 500: pg serialises them past bigint's range. The suite runs on SQLite,
  // which accepts anything, so these pin the VALIDATION, not the engine.
  const loginAs = async (code) => {
    const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
    const st = new URL(login.headers.get('location')).searchParams.get('state');
    const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
    const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${st}`, { redirect: 'manual', headers: { cookie: sc.split(';')[0] } });
    return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  };
  const u7Cookie = await loginAs('code_u7');
  const post = (path, body) =>
    fetch(`${appUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: u7Cookie }, body: JSON.stringify({ store: 'vip-signals', ...body }) });
  const owned = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u7Cookie } })).json();
  const storeId = owned.stores.find((s) => s.slug === 'vip-signals').id;
  const plan = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans.find((p) => !p.variantOf);
  for (const bad of [1e21, '1e21', '99999999999999999999']) {
    assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: plan.id, purchaseLimit: bad })).status, 400, `purchase limit ${bad}`);
    assert.equal((await post('/api/admin/discounts', { action: 'create', code: 'HUGE', kind: 'percent', amount: 10, maxUses: bad })).status, 400, `max uses ${bad}`);
  }
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: plan.id, purchaseLimit: 5 })).status, 200);
  // Pinned the validation; put the product back. Left at 5, the limit was
  // reached by the buyers above and refused the crypto invoice opened
  // earlier when it settled — the guard runs again at settlement.
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: plan.id, purchaseLimit: null })).status, 200);
  assert.equal((await post('/api/onboard', { step: 'product', storeId, name: 'Bad term', priceUsd: 10, lifetime: false, durationDays: 'abc' })).status, 400, 'a term that is not a number is refused, never stored as NaN');
  for (const bad of ['99999999999999999999', '9223372036854775808', '1000000000000000000000000']) {
    const r = await deliverStripe({ id: 'evt_bigid', type: 'ping', data: { object: {} } }, { path: `/webhooks/stripe/${bad}` });
    assert.equal(r.status, 404, `store ${bad} on the public route`);
  }
});

test('the input boundary: bad cookies, null bodies, NUL bytes, wrong types and over-length links are refused, never 500s or silent rewrites', async () => {
  const loginAs = async (code) => {
    const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
    const st = new URL(login.headers.get('location')).searchParams.get('state');
    const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
    const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${st}`, { redirect: 'manual', headers: { cookie: sc.split(';')[0] } });
    return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  };
  const u7Cookie = await loginAs('code_u7');
  const u1Cookie = await loginAs('code_u1'); // the platform owner
  const post = (path, body, cookie = u7Cookie) =>
    fetch(`${appUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: typeof body === 'string' ? body : JSON.stringify({ store: 'vip-signals', ...body }) });
  const storeRow = async () => (await (await post('/api/admin/store', {})).json()).store;
  const owned = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u7Cookie } })).json();
  const storeId = owned.stores.find((s) => s.slug === 'vip-signals').id;
  const plan = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans.find((p) => !p.variantOf);

  // One undecodable cookie ANYWHERE in the jar used to be a URIError and a
  // 500 on every session-reading route. It is "no such cookie", nothing more.
  const me = await fetch(`${appUrl}/api/me`, { headers: { cookie: `junk=%E0%A4%A; ${u7Cookie}` } });
  assert.equal(me.status, 200, 'a stray malformed cookie does not take the session down with it');
  assert.equal((await me.json()).discordId, '507700000000000007', 'the valid session beside it still signs in');
  const bad = await fetch(`${appUrl}/api/me`, { headers: { cookie: 'tl_session=%' } });
  assert.deepEqual(await bad.json(), { loggedIn: false }, 'an undecodable session is simply not a session');

  // The literal JSON `null` parses fine, so the .catch() around readJsonBody
  // never fired and the next `body.store` was a TypeError.
  for (const path of ['/api/admin/store', '/api/admin/discounts']) {
    assert.equal((await post(path, 'null')).status, 404, `${path} with a null body is "unknown store", not a 500`);
  }
  assert.equal((await post('/api/admin/settings', 'null', u1Cookie)).status, 200, 'a null settings body changes nothing');

  // U+0000: Postgres refuses the byte with a 500, SQLite silently truncates
  // the string at it. It is stripped once, at the body boundary, for everyone.
  assert.equal((await post('/api/admin/store', { name: 'Ev\u0000il' })).status, 200);
  assert.equal((await storeRow()).name, 'Evil', 'a NUL byte in a store name is dropped, and the rest of the name survives');
  const nulPlan = await (await post('/api/onboard', { step: 'product-update', storeId, planKey: plan.id, description: 'a\u0000b' })).json();
  assert.equal(nulPlan.plan.description, 'ab', 'the same at every text field, product descriptions included');

  // A discount kind that is not exactly one of the two must not become a
  // percentage: "$50 off" booked as "50% off" is a materially different sale.
  assert.equal((await post('/api/admin/discounts', { action: 'create', code: 'KIND1', kind: 'FIXED', amount: 50 })).status, 400, "'FIXED' is not 'fixed'");
  assert.equal((await post('/api/admin/discounts', { action: 'create', code: 'KIND1', kind: 'coupon', amount: 50 })).status, 400);
  assert.equal((await post('/api/admin/discounts', { action: 'create', code: 'KIND1', amount: 10 })).status, 200, 'omitting the kind still means percent');
  assert.equal((await post('/api/admin/discounts', { action: 'delete', code: 'KIND1' })).status, 200);

  // Links pass the https regex at full length and were then cut at 500 —
  // still a valid URL, to somewhere the seller never chose.
  const long = 'https://a.test/?utm=' + 'x'.repeat(900);
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: plan.id, successUrl: long })).status, 400, 'an over-length success URL is refused');
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: plan.id, imageUrl: long })).status, 400, 'an over-length photo link is refused');
  assert.equal((await post('/api/onboard', { step: 'product', storeId, name: 'Long pic', priceUsd: 10, lifetime: true, imageUrl: long })).status, 400);
  assert.equal((await post('/api/admin/store', { bannerUrl: long })).status, 400, 'an over-length banner URL is refused');
  const okUrl = 'https://a.test/ok?' + 'y'.repeat(470);
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: plan.id, successUrl: okUrl })).status, 200, 'a link that fits is stored whole');
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: plan.id, successUrl: '' })).status, 200);

  // The wrong type for links or prefs used to read as "no keys" and wiped the
  // stored value behind a 200. null clears; anything else that is not an
  // object is refused with the stored value untouched.
  assert.equal((await post('/api/admin/store', { dashboardPrefs: { accent: '#aabbcc', defaultRange: '90' }, links: { x: 'https://x.com/vip' } })).status, 200);
  assert.equal((await post('/api/admin/store', { dashboardPrefs: '#aabbcc' })).status, 400, 'a bare string is not a prefs object');
  assert.equal((await post('/api/admin/store', { links: 'abc' })).status, 400, 'links must be an object');
  assert.equal((await post('/api/admin/store', { links: [] })).status, 400, 'a list is not a links object either');
  const kept = await storeRow();
  assert.deepEqual(kept.dashboardPrefs, { accent: '#aabbcc', defaultRange: '90' }, 'the refused save left the prefs alone');
  assert.deepEqual(kept.links, { x: 'https://x.com/vip' }, 'the refused save left the links alone');
  assert.equal((await post('/api/admin/store', { dashboardPrefs: null, links: null })).status, 200, 'null is the one way to clear');
  const cleared = await storeRow();
  assert.equal(cleared.dashboardPrefs, null);
  assert.equal(cleared.links, null);

  // Text fields are text. String() persisted "[object Object]" as the store
  // name with a 200, and the plan key "object-object" for a product.
  for (const value of [{ a: 1 }, true, [1, 2], 7]) {
    assert.equal((await post('/api/admin/store', { name: value })).status, 400, `store name ${JSON.stringify(value)}`);
    assert.equal((await post('/api/admin/store', { description: value })).status, 400, `store description ${JSON.stringify(value)}`);
    assert.equal((await post('/api/onboard', { step: 'product', storeId, name: value, priceUsd: 10, lifetime: true })).status, 400, `product name ${JSON.stringify(value)}`);
    assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: plan.id, name: value })).status, 400, `product rename ${JSON.stringify(value)}`);
    // The option label is the third product-writing step, and the one that
    // turns its input into a plan key no later edit can change: String()
    // made the permanent key "vip-object-object" behind a 200.
    assert.equal((await post('/api/onboard', { step: 'variant', storeId, planKey: plan.id, label: value, priceUsd: 12, lifetime: true })).status, 400, `option label ${JSON.stringify(value)}`);
  }
  assert.ok(
    !(await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans.some((p) => /object-object|^true$|1,2|^7$/.test(p.planKey)),
    'none of those minted an option',
  );
  assert.equal((await storeRow()).name, 'Evil', 'none of those wrote anything');
  assert.equal((await post('/api/admin/store', { name: 'VIP Signals' })).status, 200);

  // The receipt sender is the From header of every receipt: an address, or a
  // name in front of one. Resend rejects anything else and the only symptom
  // used to be receipts quietly stopping.
  // The specials belong in quotes: `Dues, Inc <a@b.co>` is not a mailbox at
  // all (the comma ends the address) and Resend rejects it — receipts then
  // stop with no symptom. The check used to admit exactly those and refuse
  // the quoted spelling that works.
  for (const from of ['not an email at all', '<script>alert(1)</script>', 'Dues <a@b>', 'Dues <a@b.c', 'x\r\nbcc: y@z.io', 'Dues, Inc <a@b.co>', 'a:b;c <a@b.co>', 'x@y.z <a@b.co>']) {
    assert.equal((await post('/api/admin/settings', { receiptFrom: from }, u1Cookie)).status, 400, `receiptFrom ${JSON.stringify(from)}`);
  }
  assert.equal((await post('/api/admin/settings', { receiptFrom: '"Dues, Inc" <receipts@tradeleaks.e2e>' }, u1Cookie)).status, 200, 'a quoted display name is the RFC spelling, not a refusal');
  const settings = await (await fetch(`${appUrl}/api/admin/settings`, { headers: { cookie: u1Cookie } })).json();
  assert.equal(settings.receiptFrom, '"Dues, Inc" <receipts@tradeleaks.e2e>', 'the refused senders changed nothing');
  assert.equal((await post('/api/admin/settings', { receiptFrom: 'Dues <receipts@tradeleaks.e2e>' }, u1Cookie)).status, 200, 'a real Name <address> sender is accepted');
});

test('a buyer on the card form holds a seat and a discount use; an option upgrade ends the earlier option', async () => {
  const loginAs = async (code) => {
    const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
    const st = new URL(login.headers.get('location')).searchParams.get('state');
    const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
    const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${st}`, { redirect: 'manual', headers: { cookie: sc.split(';')[0] } });
    return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  };
  const u7Cookie = await loginAs('code_u7');
  const post = (path, body, cookie = u7Cookie) =>
    fetch(`${appUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ store: 'vip-signals', ...body }) });
  const owned = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u7Cookie } })).json();
  const storeId = owned.stores.find((s) => s.slug === 'vip-signals').id;
  const seat = JSON.parse(await (await post('/api/onboard', { step: 'product', storeId, name: 'One Seat', priceUsd: 30, lifetime: true })).text()).plan;
  assert.equal((await post('/api/onboard', { step: 'role', storeId, planKey: seat.planKey, roleId: R2_VIP })).status, 200);
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: seat.planKey, purchaseLimit: 1 })).status, 200);
  const A = '522200000000000022';
  const B = '523300000000000023';
  discord.oauthUsers.code_seat_a = { id: A, username: 'seat_a' };
  discord.oauthUsers.code_seat_b = { id: B, username: 'seat_b' };
  discord.members.set(A, new Set());
  discord.members.set(B, new Set());
  const aCookie = await loginAs('code_seat_a');
  const bCookie = await loginAs('code_seat_b');
  // A opens the card form. Nobody has paid, so the subscriptions table is
  // empty — and B must still be refused, or the seller sells one seat twice.
  assert.equal((await post('/api/checkout/stripe', { planId: seat.planKey }, aCookie)).status, 200);
  const b = await post('/api/checkout/stripe', { planId: seat.planKey }, bCookie);
  const bBody = await b.text();
  assert.equal(b.status, 409, bBody);
  assert.match(bBody, /sold out/);
  assert.equal((await post('/api/checkout/stripe', { planId: seat.planKey }, aCookie)).status, 200, "A's own open session never refuses A's retry");
  // The same reservation for a usage limit: one use, A has it on an open form.
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: seat.planKey, purchaseLimit: null })).status, 200);
  assert.equal((await post('/api/admin/discounts', { action: 'create', code: 'ONESEAT', kind: 'percent', amount: 10, maxUses: 1 })).status, 200);
  assert.equal((await post('/api/checkout/stripe', { planId: seat.planKey, discountCode: 'ONESEAT' }, aCookie)).status, 200);
  const bCode = await post('/api/checkout/stripe', { planId: seat.planKey, discountCode: 'ONESEAT' }, bCookie);
  assert.equal(bCode.status, 400, await bCode.text());
  assert.equal((await post('/api/checkout/stripe', { planId: seat.planKey, discountCode: 'ONESEAT' }, aCookie)).status, 200, 'A may reopen with the code they hold');

  // An upgrade inside one product: Monthly, then Yearly. The Monthly
  // subscription is ended at its period end on Stripe, the way the buyer's
  // own cancel button does it — never two live subscriptions for one product.
  const club = JSON.parse(await (await post('/api/onboard', { step: 'product', storeId, name: 'Upgrade Club', priceUsd: 200, lifetime: true })).text()).plan;
  assert.equal((await post('/api/onboard', { step: 'role', storeId, planKey: club.planKey, roleId: R2_VIP })).status, 200);
  const monthly = JSON.parse(await (await post('/api/onboard', { step: 'variant', storeId, planKey: club.planKey, label: 'Monthly', priceUsd: 15, lifetime: false })).text()).plan;
  const yearly = JSON.parse(await (await post('/api/onboard', { step: 'variant', storeId, planKey: club.planKey, label: 'Yearly', priceUsd: 120, lifetime: false })).text()).plan;
  const U = '524400000000000024';
  discord.oauthUsers.code_up = { id: U, username: 'upgrader' };
  discord.members.set(U, new Set());
  const uCookie = await loginAs('code_up');
  const signed = (evt) => deliverStripe(evt, { path: `/webhooks/stripe/${storeId}`, header: signStripe(JSON.stringify(evt), nowSec(), AUTO_ENDPOINT_SECRET) });
  const subEvt = (id, subId, planId) => ({ id: `evt_${id}`, type: 'checkout.session.completed', data: { object: { id: `cs_${id}`, mode: 'subscription', payment_status: 'paid', subscription: subId, amount_total: 1500, client_reference_id: U, customer_details: { email: 'up@e2e.test' }, metadata: { plan_id: planId, discord_id: U, store_id: String(storeId) } } } });
  assert.equal((await signed(subEvt('up_m', 'sub_up_month', monthly.planKey))).status, 200);
  const updatesBefore = stripe.subUpdates.length;
  assert.equal((await signed(subEvt('up_y', 'sub_up_year', yearly.planKey))).status, 200);
  const ended = stripe.subUpdates.slice(updatesBefore).find((u) => u.id === 'sub_up_month');
  assert.ok(ended && ended.form.cancel_at_period_end === 'true', 'the Monthly subscription is ended at its period end on Stripe');
  assert.ok(!stripe.subUpdates.slice(updatesBefore).some((u) => u.id === 'sub_up_year'), 'the new Yearly subscription is left alone');
  const mine = (await (await fetch(`${appUrl}/api/me`, { headers: { cookie: uCookie } })).json()).subscriptions;
  assert.ok(mine.find((s) => s.planId === monthly.planKey).cancelsAt, 'the account page shows Monthly winding down');
  assert.ok(!mine.find((s) => s.planId === yearly.planKey).cancelsAt, 'and Yearly live');
  assert.ok(memberRoles(U).has(R2_VIP), 'the role stays throughout');
  // Cleanup: park both products.
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: seat.planKey, active: false })).status, 200);
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: club.planKey, active: false })).status, 200);
});

test('money: unpaid sessions grant nothing until they settle, a sibling store never eats an event, platform billing moves only from the platform endpoint', async () => {
  const loginAs = async (code) => {
    const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
    const st = new URL(login.headers.get('location')).searchParams.get('state');
    const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
    const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${st}`, { redirect: 'manual', headers: { cookie: sc.split(';')[0] } });
    return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  };
  const u7Cookie = await loginAs('code_u7');
  const post = (path, body, cookie = u7Cookie) =>
    fetch(`${appUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ store: 'vip-signals', ...body }) });
  const owned = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u7Cookie } })).json();
  const storeId = owned.stores.find((s) => s.slug === 'vip-signals').id;
  const plan = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans.find((p) => !p.variantOf && !p.requiredRoleName);
  const signed = (evt, sid = storeId) => deliverStripe(evt, { path: `/webhooks/stripe/${sid}`, header: signStripe(JSON.stringify(evt), nowSec(), AUTO_ENDPOINT_SECRET) });
  const session = (id, uid, planId, extra = {}) => ({
    id: `evt_${id}`, type: 'checkout.session.completed',
    data: { object: { id: `cs_${id}`, mode: 'payment', payment_status: 'paid', payment_intent: `pi_${id}`, amount_total: 1000, client_reference_id: uid, customer_details: { email: `${id}@e2e.test` }, metadata: { plan_id: planId, discord_id: uid, store_id: String(storeId) }, ...extra } },
  });

  // 1. A delayed-notification payment: the session is complete but UNPAID.
  //    Nothing is granted, mailed or pinged until Stripe says the money moved.
  const SLOW = '525500000000000025';
  discord.members.set(SLOW, new Set());
  const emails0 = resend.emails.length;
  const unpaid = session('slow_1', SLOW, plan.id, { payment_status: 'unpaid' });
  assert.equal((await signed(unpaid)).status, 200);
  assert.ok(!memberRoles(SLOW).has(R2_VIP), 'no role until the money moves');
  assert.equal(resend.emails.length, emails0, 'no paid receipt for an unpaid session');
  const settled = { ...unpaid, id: 'evt_slow_1_ok', type: 'checkout.session.async_payment_succeeded', data: { object: { ...unpaid.data.object, payment_status: 'paid' } } };
  assert.equal((await signed(settled)).status, 200);
  assert.ok(memberRoles(SLOW).has(R2_VIP), 'async_payment_succeeded is the grant');
  assert.equal(resend.emails.length, emails0 + 1, 'and the receipt goes out then');
  const NEVER = '526600000000000026';
  discord.members.set(NEVER, new Set());
  const never = session('never_1', NEVER, plan.id, { payment_status: 'unpaid' });
  assert.equal((await signed(never)).status, 200);
  assert.equal((await signed({ ...never, id: 'evt_never_1_fail', type: 'checkout.session.async_payment_failed' })).status, 200);
  assert.ok(!memberRoles(NEVER).has(R2_VIP), 'a payment that never clears delivers nothing');

  // 2. Two stores on ONE Stripe account each have an endpoint, and Stripe
  //    sends every event to both. The sibling drops what is not its own; the
  //    owner is never told "duplicate".
  const u13Cookie = await loginAs('code_u13');
  const sibling = (await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u13Cookie } })).json()).stores.find((s) => s.slug === 'tradeleaks-pro');
  assert.ok(sibling, 'the second store on the shared key exists');
  const TWIN = '527700000000000027';
  discord.members.set(TWIN, new Set());
  const twinSale = session('twin_1', TWIN, plan.id);
  assert.equal((await signed(twinSale, sibling.id)).status, 200);
  assert.ok(!memberRoles(TWIN).has(R2_VIP), 'the sibling endpoint grants nothing: not its sale');
  const owner = await signed(twinSale, storeId);
  assert.deepEqual([owner.status, owner.body], [200, 'ok'], 'the owning endpoint is not told duplicate');
  assert.ok(memberRoles(TWIN).has(R2_VIP), 'the owning store delivers');
  const RENEW = '528800000000000028';
  discord.members.set(RENEW, new Set());
  const base = session('twin_sub', RENEW, plan.id).data.object;
  const subSale = { id: 'evt_twin_sub', type: 'checkout.session.completed', data: { object: { ...base, mode: 'subscription', subscription: 'sub_twin_1' } } };
  assert.equal((await signed(subSale)).status, 200);
  const rowBefore = await subRow('stripe', 'sub_twin_1');
  const renewal = { id: 'evt_twin_renew', type: 'invoice.paid', data: { object: { id: 'in_twin_1', parent: { subscription_details: { subscription: 'sub_twin_1' } } } } };
  assert.equal((await signed(renewal, sibling.id)).status, 200);
  assert.equal(Number((await subRow('stripe', 'sub_twin_1')).store_id), Number(rowBefore.store_id), 'a renewal on the sibling endpoint does not migrate the row');

  // 3. Platform-billing state moves only from the platform's own endpoint.
  const billingBefore = await (await fetch(`${appUrl}/api/billing`, { headers: { cookie: u7Cookie } })).json();
  const forge = { id: 'evt_forge_plat_up', type: 'customer.subscription.updated', data: { object: { id: 'sub_plat_2', object: 'subscription', status: 'active', items: { data: [{ current_period_end: nowSec() + 10 * 365 * 86400 }] } } } };
  assert.equal((await signed(forge)).status, 200);
  const billingAfter = await (await fetch(`${appUrl}/api/billing`, { headers: { cookie: u7Cookie } })).json();
  assert.deepEqual(
    { tier: billingAfter.current.tier, periodEnd: billingAfter.current.periodEnd },
    { tier: billingBefore.current.tier, periodEnd: billingBefore.current.periodEnd },
    'a seller cannot move their own Dues tier by signing to their store endpoint',
  );

  // 4. One grace window per unpaid period: Stripe's retries do not restart
  //    it, and the buyer is told once.
  const failed = { id: 'evt_twin_fail_1', type: 'invoice.payment_failed', data: { object: { id: 'in_twin_2', parent: { subscription_details: { subscription: 'sub_twin_1' } } } } };
  const dms0 = discord.dms.filter((d) => d.uid === RENEW).length;
  assert.equal((await signed(failed)).status, 200);
  const g1 = (await subRow('stripe', 'sub_twin_1')).grace_until;
  assert.ok(g1 > nowSec() + 71 * 3600, 'a full window from the unpaid period end');
  await sleep(1100);
  assert.equal((await signed({ ...failed, id: 'evt_twin_fail_2' })).status, 200);
  assert.equal((await subRow('stripe', 'sub_twin_1')).grace_until, g1, 'a retry does not restart the window');
  assert.equal(discord.dms.filter((d) => d.uid === RENEW).length, dms0 + 1, 'and the buyer is told once');

  // 5. Money taken for a product the store no longer has alerts the seller.
  const pings0 = discord.channelPosts.length;
  const GHOST2 = '529900000000000029';
  discord.members.set(GHOST2, new Set());
  assert.equal((await signed(session('ghost_2', GHOST2, 'no-such-product'))).status, 200);
  assert.equal(discord.channelPosts.length, pings0 + 1, 'the seller is pinged');
  assert.match(discord.channelPosts.at(-1).body.embeds[0].title, /no longer exists/);

  // 6. A product someone is paying for right now cannot be deleted under them.
  const doomed = JSON.parse(await (await post('/api/onboard', { step: 'product', storeId, name: 'Doomed', priceUsd: 12, lifetime: true })).text()).plan;
  const PAYER = '530000000000000030';
  discord.oauthUsers.code_payer = { id: PAYER, username: 'payer' };
  discord.members.set(PAYER, new Set());
  const payerCookie = await loginAs('code_payer');
  assert.equal((await post('/api/checkout/stripe', { planId: doomed.planKey }, payerCookie)).status, 200);
  const del = await post('/api/onboard', { step: 'product-delete', storeId, planKey: doomed.planKey });
  const delBody = await del.text();
  assert.equal(del.status, 409, delBody);
  assert.match(delBody, /paying for this product right now/);
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: doomed.planKey, active: false })).status, 200);
});

test('a sale whose webhook never arrived is recovered by the cron, and a late delivery then does nothing twice', async () => {
  const loginAs = async (code) => {
    const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
    const st = new URL(login.headers.get('location')).searchParams.get('state');
    const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
    const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${st}`, { redirect: 'manual', headers: { cookie: sc.split(';')[0] } });
    return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  };
  const u7Cookie = await loginAs('code_u7');
  const post = (path, body, cookie = u7Cookie) =>
    fetch(`${appUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ store: 'vip-signals', ...body }) });
  const owned = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: u7Cookie } })).json();
  const storeId = owned.stores.find((s) => s.slug === 'vip-signals').id;
  const plan = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans.find((p) => !p.variantOf && !p.requiredRoleName);
  const LOST = '531100000000000031';
  discord.members.set(LOST, new Set());
  // The attempt row Dues writes when it opens a checkout — two hours old,
  // never completed. (Written directly: this store is past its owner's free
  // member cap by now, so a fresh checkout would be refused for that reason.)
  const sessionId = 'cs_lost_1';
  await tq(
    "INSERT INTO checkout_attempts (store_id, plan_id, discord_id, session_id, amount_usd, currency, discount_code, status, created_at) VALUES (?, ?, ?, ?, ?, 'usd', NULL, 'started', ?)",
    [storeId, plan.id, LOST, sessionId, 25, nowSec() - 7200],
  );
  // Stripe holds the session complete and paid two hours ago; Dues never heard.
  stripe.completedSessions = [{
    id: sessionId, object: 'checkout.session', status: 'complete', payment_status: 'paid', mode: 'payment', payment_intent: 'pi_lost_1',
    created: nowSec() - 7200, amount_total: 2500, client_reference_id: LOST, customer_details: { email: 'lost@e2e.test' },
    metadata: { plan_id: plan.id, discord_id: LOST, store_id: String(storeId) },
  }];
  const emails0 = resend.emails.length;
  const pings0 = discord.channelPosts.length;
  try {
    const cron = await hitCron();
    assert.equal(cron.status, 200, cron.body);
    const body = JSON.parse(cron.body);
    assert.equal(body.backfill?.recovered, 1, `the cron recovers the sale: ${cron.body}`);
    assert.ok(memberRoles(LOST).has(R2_VIP), 'the role is delivered');
    assert.equal(resend.emails.length, emails0 + 1, 'the receipt goes out');
    assert.equal(discord.channelPosts.length, pings0 + 1, 'the seller is pinged');
    assert.equal(JSON.parse((await hitCron()).body).backfill.recovered, 0, 'a second sweep finds nothing to do');
    // The real delivery finally lands: acknowledged, and nothing happens twice.
    const late = { id: 'evt_lost_late', type: 'checkout.session.completed', data: { object: stripe.completedSessions[0] } };
    const r = await deliverStripe(late, { path: `/webhooks/stripe/${storeId}`, header: signStripe(JSON.stringify(late), nowSec(), AUTO_ENDPOINT_SECRET) });
    assert.deepEqual([r.status, r.body], [200, 'ok']);
    assert.equal(resend.emails.length, emails0 + 1, 'no second receipt');
    assert.equal(discord.channelPosts.length, pings0 + 1, 'no second ping');
  } finally {
    stripe.completedSessions = [];
  }
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
  // A top-up to a used deposit address is a REPEATED DEPOSIT: NOWPayments
  // "will automatically create a new payment with another id", so the payment
  // this screen polls stays partially_paid whatever the buyer sends next.
  // Telling them to send the difference to finish it promises a completion
  // this rail cannot show them.
  assert.doesNotMatch(view.message, /same address to complete/i, 'the provider does not complete this payment from a second deposit');
  assert.match(view.message, /separate payment/, 'say what a second deposit actually does');

  // Somebody else's order is not readable, however guessable the id is.
  const other = await fetch(`${appUrl}/api/checkout/crypto?store=vip-signals&order=${npOrder.orderId}`, {
    headers: { cookie: npCookie },
  });
  assert.equal(other.status, 404);
});

test('crypto: a deposit is judged on the fiat the provider reported, never on the coin maths', async () => {
  const payment = nowpayments.payments.get('npid_1');
  // The two figures disagree: actually_paid counts units of the coin the
  // invoice asked for, actually_paid_at_fiat is what the provider says the
  // deposit was worth. (A deposit in a coin the invoice was NOT created for
  // does not land on this payment at all — it becomes its own child payment,
  // which is the scenario further down.)
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

test('crypto: a short payment the provider priced no fiat on quotes no figure at all', async () => {
  // `actually_paid_at_fiat` is documented on the IPN body and on nothing else:
  // NOWPayments' own sample response for GET /v1/payment/:id — the call the
  // pay screen polls through — does not carry the field, and their IPN example
  // ships it as 0. So the field being absent is the ORDINARY case on this
  // path, not an edge one, and it is the only field that says what a deposit
  // was worth independently of the coin the invoice asked for.
  //
  // Without it there is no shortfall anyone can name. The buyer gets the
  // figureless wording; nothing derives a dollar amount from the coin ratio,
  // because that ratio assumes the deposit was in pay_currency, which is the
  // one thing an underpayment on a wrong-asset account may not have been.
  const payment = nowpayments.payments.get('npid_1');
  payment.payment_status = 'partially_paid';
  payment.actually_paid = 0.35;
  delete payment.actually_paid_at_fiat;

  const view = await (await fetch(`${appUrl}/api/checkout/crypto?store=vip-signals&order=${npOrder.orderId}`, {
    headers: { cookie: npBuyerCookie },
  })).json();
  assert.equal(view.state, 'short');
  assert.doesNotMatch(view.message, /\d/, 'no fiat figure, no number quoted — an invented one reads as fact');
  assert.doesNotMatch(view.message, /SOL/, 'and no coin figure either');
  assert.match(view.message, /separate payment/, 'the honest instruction still stands');
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

test('a kicked bot is named as the cause (not a buyer who has not joined), the sweep stops hammering that guild, and a phantom "already a member" join cannot spin', async () => {
  // Discord answers 404 to GET member for two very different reasons:
  // Unknown Member (the buyer is not in the server) and Unknown Guild (the
  // BOT is not in the server). Both used to become null, so a kicked bot
  // read as "buyer not in guild → try guilds.join → 403 Missing Access" once
  // per member per sweep — the log blamed every buyer's join, and the guild
  // took two doomed calls per member every hour.
  const loginAs = async (code) => {
    const login = await fetch(`${appUrl}/auth/login`, { redirect: 'manual' });
    const st = new URL(login.headers.get('location')).searchParams.get('state');
    const sc = login.headers.getSetCookie().find((c) => c.startsWith('tl_oauth_state='));
    const cb = await fetch(`${appUrl}/auth/callback?code=${code}&state=${st}`, { redirect: 'manual', headers: { cookie: sc.split(';')[0] } });
    return cb.headers.getSetCookie().find((c) => c.startsWith('tl_session=')).split(';')[0];
  };
  const u7Cookie = await loginAs('code_u7');
  const member = (body) =>
    fetch(`${appUrl}/api/admin/member`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: u7Cookie }, body: JSON.stringify({ store: 'vip-signals', ...body }) });
  const plans = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans;
  const plan = plans.find((p) => !p.variantOf && !p.requiredRoleName);
  const logSince = (mark) => appLog.slice(mark).join('');

  // Two live members of the store, both in the server, both holding the role.
  const KA = '531100000000000031';
  const KB = '532200000000000032';
  for (const uid of [KA, KB]) {
    discord.members.set(uid, new Set());
    const granted = await member({ action: 'grant', discordId: uid, planId: plan.id });
    assert.equal(granted.status, 200, await granted.text());
    assert.ok(memberRoles(uid).has(R2_VIP), 'the grant delivered the role');
  }

  discord.kickedFrom = G2;
  discord.kickedMemberGets = 0;
  try {
    // A resync of a member who IS in the server: the failure names the bot,
    // never a join the buyer supposedly still owes.
    const mark = appLog.length;
    const resync = await member({ action: 'resync', discordId: KA });
    assert.equal(resync.status, 500, 'the outage is a failure, not a silent no-op');
    await waitFor('the resync failure to name the bot', () => /the bot is not in guild 900000000000000002/.test(logSince(mark)));
    assert.doesNotMatch(logSince(mark), /join .* to guild failed/, 'no guilds.join is attempted for a guild the bot is gone from');
    assert.equal(discord.joins.filter((j) => j.uid === KA).length, 0, 'no join was sent');

    // The hourly sweep: one line naming the guild, one member fetch against
    // it (the store's other members are skipped this run), the guild carried
    // in the cron response, and every OTHER store still reconciled.
    const sweepMark = appLog.length;
    discord.kickedMemberGets = 0;
    const cron = await hitCron();
    assert.equal(cron.status, 200, cron.body);
    const sweep = JSON.parse(cron.body);
    assert.deepEqual(sweep.guildsWithoutBot, [G2], 'the cron response carries the guild the bot is missing from');
    assert.ok(sweep.membersReconciled > 0, 'members of the other stores were still reconciled');
    assert.equal(discord.kickedMemberGets, 1, 'exactly one member fetch hit the kicked guild — the rest of that store was skipped');
    await waitFor('the sweep to name the guild', () => /\[sweep\] the bot is not in guild/.test(logSince(sweepMark)));
    const sweepLog = logSince(sweepMark);
    assert.equal((sweepLog.match(/\[sweep\] the bot is not in guild 900000000000000002/g) ?? []).length, 1, 'the outage is logged once per sweep, not once per member');
    assert.doesNotMatch(sweepLog, /join .* to guild failed with 403/, 'no member of that store is blamed for a join failure');
    assert.doesNotMatch(sweepLog, /not in guild 900000000000000002 and no OAuth token/, 'nobody there is diagnosed as a buyer who has not joined');
  } finally {
    discord.kickedFrom = null;
  }
  // The bot is re-invited: the next sweep reconciles the store again, as before.
  const back = JSON.parse((await hitCron()).body);
  assert.equal(back.guildsWithoutBot, undefined);
  assert.ok(memberRoles(KA).has(R2_VIP) && memberRoles(KB).has(R2_VIP), 'nothing was torn off during the outage');

  // The recursion bound. A buyer with a stored guilds.join token is missing
  // from the server; Discord answers the join with 204 "already a member" yet
  // keeps answering 404 to the member fetch. reconcileNow used to call itself
  // until the two agreed — thousands of requests inside one sweep. Now: one
  // join, one more look, one warning, and the next reconcile tries again.
  const KC = '533300000000000033';
  discord.oauthUsers.code_kc = { id: KC, username: 'phantom_member' };
  discord.members.set(KC, new Set());
  await loginAs('code_kc'); // stores the OAuth token the join path needs
  const granted = await member({ action: 'grant', discordId: KC, planId: plan.id });
  assert.equal(granted.status, 200, await granted.text());
  discord.members.delete(KC);
  discord.phantomJoinsFor.add(KC);
  discord.phantomJoins = 0;
  try {
    const mark = appLog.length;
    const t0 = Date.now();
    const cron = await hitCron();
    assert.equal(cron.status, 200, cron.body);
    assert.ok(Date.now() - t0 < 5000, 'the sweep returned promptly');
    assert.equal(discord.phantomJoins, 1, 'exactly one join attempt, then the reconcile stopped');
    await waitFor('the disagreement to be logged and left for the next reconcile', () =>
      /Discord reports 533300000000000033 already in guild 900000000000000002 but the member fetch still answers 404/.test(logSince(mark)));
  } finally {
    discord.phantomJoinsFor.delete(KC);
  }
  // Once Discord agrees with itself, the next reconcile lands the role.
  assert.equal((await member({ action: 'resync', discordId: KC })).status, 200);
  assert.deepEqual(discord.joins.filter((j) => j.uid === KC).map((j) => j.roles), [[R2_VIP]], 'the real join carried the role');
  assert.ok(memberRoles(KC).has(R2_VIP));
});

// The IPN is a claim on the WORK, not on the delivery. NOWPayments sends one
// IPN per status transition and the handler re-reads the payment every time,
// so on a fast chain several deliveries all read `finished`: keyed on the
// body's status, every one of them ran the completion side effects. And a
// delivery whose re-read has not caught up yet is answered 5xx so the
// provider brings it back — a 200 there consumed the only `finished` this
// payment would ever send.
const npStoreId = async () =>
  (await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: npCookie } })).json()).stores.find((s) => s.slug === 'vip-signals').id;
const npPlan = async () => (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans[0];
async function npOpenOrder({ storeId, plan, uid, orderId, ref, status, age, discountCode = null, amount = plan.priceUsd }) {
  discord.members.set(uid, new Set());
  await tq(
    "INSERT INTO checkout_attempts (store_id, plan_id, discord_id, session_id, amount_usd, currency, discount_code, provider_ref, status, created_at) VALUES (?, ?, ?, ?, ?, 'usd', ?, ?, 'started', ?)",
    [storeId, plan.id, uid, orderId, amount, discountCode, ref, nowSec() - age],
  );
  const payment = {
    payment_id: ref, payment_status: status, order_id: orderId, price_amount: amount, price_currency: 'usd',
    pay_currency: 'sol', pay_amount: 0.5, actually_paid: status === 'finished' ? 0.5 : 0,
  };
  nowpayments.payments.set(ref, payment);
  return payment;
}
const attemptStatus = async (orderId) => (await tq('SELECT status FROM checkout_attempts WHERE session_id = ?', [orderId])).rows[0].status;

test('crypto: a lagging re-read is retried rather than consumed, and the completion side effects run once per sale', async () => {
  const storeId = await npStoreId();
  const plan = await npPlan();
  await tq("INSERT INTO discounts (store_id, code, kind, amount, plan_key, max_uses, uses, expires_at, created_at) VALUES (?, 'CRYPTO10', 'percent', 10, NULL, 5, 0, NULL, ?)", [storeId, nowSec()]);
  const uses = async () => Number((await tq('SELECT uses FROM discounts WHERE store_id = ? AND code = ?', [storeId, 'CRYPTO10'])).rows[0].uses);
  const LAG = '515000000000000016';
  const orderId = `np_${'a'.repeat(32)}`;
  const payment = await npOpenOrder({ storeId, plan, uid: LAG, orderId, ref: 'npid_lag', status: 'confirming', age: 60, discountCode: 'CRYPTO10', amount: Math.round(plan.priceUsd * 90) / 100 });
  const pings0 = discord.channelPosts.length;

  // The signed `finished` lands while GET /payment still answers confirming.
  const lagging = await deliverNow({ payment_id: 'npid_lag', payment_status: 'finished', order_id: orderId });
  assert.equal(lagging.status, 503, 'a finished delivery the re-read cannot confirm is not a terminal outcome — the provider must bring it back');
  assert.equal(await subRow('nowpayments', 'npid_lag'), null);
  assert.deepEqual(await claimRows('nowpayments:npid_lag:%'), [], 'no claim is held on work that did not happen');
  assert.equal(await attemptStatus(orderId), 'started');

  // The provider catches up. Whichever delivery re-reads `finished` first
  // does the work — here a late in-flight one, which is exactly the case
  // a per-delivery claim let through twice...
  payment.payment_status = 'finished';
  payment.actually_paid = 0.5;
  const late = await deliverNow({ payment_id: 'npid_lag', payment_status: 'confirming', order_id: orderId });
  assert.deepEqual([late.status, late.body], [200, 'ok']);
  assert.ok(memberRoles(LAG).has(R2_VIP), 'the role lands');
  assert.equal(await attemptStatus(orderId), 'completed');
  assert.equal(await uses(), 1);
  assert.equal(discord.channelPosts.length, pings0 + 1);
  assert.match(discord.channelPosts.at(-1).body.embeds[0].description, /paid in SOL/);
  // ...and every later delivery, whatever status it carries, finds it done.
  for (const status of ['finished', 'sending', 'finished']) {
    const r = await deliverNow({ payment_id: 'npid_lag', payment_status: status, order_id: orderId });
    assert.deepEqual([r.status, r.body], [200, 'duplicate'], `a ${status} delivery after the grant`);
  }
  assert.equal(await uses(), 1, 'a five-use code burns one use on one sale');
  assert.equal(discord.channelPosts.length, pings0 + 1, 'one sale, one ping');
  assert.equal((await claimRows('nowpayments:npid_lag:%')).length, 1, 'one claim: the work');
});

test('crypto: a claim left by an invocation that died is retaken, and the cron recovers a finished payment whose IPN never came', async () => {
  const storeId = await npStoreId();
  const plan = await npPlan();
  const DIED = '515000000000000017';
  const LOST = '515000000000000018';
  const GONE = '515000000000000019';
  const O_DIED = `np_${'b'.repeat(32)}`;
  const O_LOST = `np_${'c'.repeat(32)}`;
  const O_GONE = `np_${'d'.repeat(32)}`;
  await npOpenOrder({ storeId, plan, uid: DIED, orderId: O_DIED, ref: 'npid_died', status: 'finished', age: 60 });
  await npOpenOrder({ storeId, plan, uid: LOST, orderId: O_LOST, ref: 'npid_lost', status: 'finished', age: 7200 });
  // Expired AND past the seven days the provider keeps watching the deposit
  // address for. Only now is there nothing left that could land on it, so only
  // now is closing it honest — an invoice that expired an hour ago is the next
  // scenario's business, and it stays open.
  await npOpenOrder({ storeId, plan, uid: GONE, orderId: O_GONE, ref: 'npid_gone', status: 'expired', age: 8 * 86400 });

  // 1. Another invocation took the claim on this very work 30 seconds ago
  // and may still be running: neither duplicate it nor consume the delivery.
  await tq("INSERT INTO webhook_events (event_id, provider, received_at) VALUES ('nowpayments:npid_died:finished', 'nowpayments', ?)", [nowSec() - 30]);
  const held = await deliverNow({ payment_id: 'npid_died', payment_status: 'finished', order_id: O_DIED });
  assert.equal(held.status, 503, 'work someone else holds is "come back", never "done"');
  assert.equal(await subRow('nowpayments', 'npid_died'), null);
  // Fifteen minutes on with the order still open, the holder can only be an
  // invocation the platform killed before its catch ran (the limit is 60s).
  await tq("UPDATE webhook_events SET received_at = ? WHERE event_id = 'nowpayments:npid_died:finished'", [nowSec() - 900]);
  const retaken = await deliverNow({ payment_id: 'npid_died', payment_status: 'finished', order_id: O_DIED });
  assert.deepEqual([retaken.status, retaken.body], [200, 'ok'], 'a stale claim on undone work is retaken, not honoured');
  assert.ok(memberRoles(DIED).has(R2_VIP));
  assert.equal(await attemptStatus(O_DIED), 'completed');

  // 2. No IPN ever arrived for a payment that finished two hours ago — the
  // provider's retries are spent, the coins are in the seller's wallet.
  const pings0 = discord.channelPosts.length;
  const cron = await hitCron();
  assert.equal(cron.status, 200, cron.body);
  const body = JSON.parse(cron.body);
  assert.equal(body.cryptoBackfill?.recovered, 1, `the cron recovers the sale: ${cron.body}`);
  assert.equal(body.cryptoBackfill?.closed, 1, `and closes the invoice whose tracking window is spent: ${cron.body}`);
  assert.ok(memberRoles(LOST).has(R2_VIP), 'the role is delivered');
  assert.equal(await attemptStatus(O_LOST), 'completed');
  assert.equal(discord.channelPosts.length, pings0 + 1, 'the seller is pinged');
  assert.equal(await attemptStatus(O_GONE), 'expired', 'an invoice nothing can land on any more is closed here too');
  // A second sweep has nothing open left and asks the provider nothing.
  const reqs = nowpayments.requests;
  assert.deepEqual(JSON.parse((await hitCron()).body).cryptoBackfill, { checked: 0, recovered: 0, closed: 0 });
  assert.equal(nowpayments.requests, reqs);
  // The real delivery finally lands: acknowledged, and nothing happens twice.
  const lateIpn = await deliverNow({ payment_id: 'npid_lost', payment_status: 'finished', order_id: O_LOST });
  assert.deepEqual([lateIpn.status, lateIpn.body], [200, 'duplicate']);
  assert.equal(discord.channelPosts.length, pings0 + 1, 'no second ping');
});

test('crypto: an invoice the provider expired keeps looking for money, and a deposit that lands after it still delivers the role', async () => {
  // The case that loses a buyer's money. NOWPayments expires a fixed-rate
  // payment when nothing has arrived before valid_until — ten minutes on the
  // flow this rail always asks for — and from that moment it says nothing at
  // all: "no callbacks are sent after a payment expires. Deposits can still be
  // received, but they will not trigger any further IPN callbacks", while it
  // goes on crediting that address for seven days. So a buyer who sends a
  // minute late produces NO IPN, ever. This sweep is the only thing that can
  // find that money, and closing the order the hour it lapsed — which is what
  // this rail used to do — is what made it disappear with nothing delivered.
  const storeId = await npStoreId();
  const post = (path, body, cookie = npCookie) =>
    fetch(`${appUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ store: 'vip-signals', ...body }) });
  const made = JSON.parse(await (await post('/api/onboard', { step: 'product', storeId, name: 'Late Deposit', priceUsd: 25, lifetime: true })).text()).plan;
  assert.equal((await post('/api/onboard', { step: 'role', storeId, planKey: made.planKey, roleId: R2_VIP })).status, 200);
  const LATE = '536600000000000038';
  discord.members.set(LATE, new Set());
  const lateCookie = await signInAs('code_np_late', LATE, 'np_late');
  const start = () => post('/api/checkout/crypto', { planId: made.planKey, payCurrency: 'sol' }, lateCookie);

  // A real checkout against a provider whose window is about to close. Same
  // field, same code path as the ten-minute one — only the number is small
  // enough for a test to outlive.
  nowpayments.validForMs = 1200;
  let order;
  try {
    const started = await start();
    assert.equal(started.status, 200, await started.clone().text());
    order = await started.json();
  } finally {
    delete nowpayments.validForMs;
  }
  const row = (await tq('SELECT * FROM checkout_attempts WHERE session_id = ?', [order.orderId])).rows[0];
  const ref = row.provider_ref;
  assert.ok(asNum(row.expires_at) - nowSec() < 60,
    "the hold is the provider's own deadline, so it lapses with the invoice instead of a week later");
  assert.equal(Math.floor(Date.parse(order.expiresAt) / 1000), asNum(row.expires_at),
    'and the countdown the buyer watches is that same instant');
  await sleep(1500);

  // The buyer's own screen once the window closes. The provider has expired it
  // silently; the one thing this must not say to someone whose transfer is
  // already on its way is that the payment failed.
  const poll = await (await fetch(`${appUrl}/api/checkout/crypto?store=vip-signals&order=${order.orderId}`, { headers: { cookie: lateCookie } })).json();
  assert.equal(poll.status, 'expired', 'the provider expires the invoice on its own, and only a lookup reveals it');
  assert.match(poll.message, /already sent/i, 'a buyer whose deposit is in flight is told to sit tight, not to pay twice');

  // It also tells them to start again — so doing exactly that has to work.
  // An expired invoice holds no seat, no discount use, and counts for nothing
  // against the three live invoices a buyer may hold. Held for a week, this
  // third restart was the moment a buyer got locked out of a product they had
  // never bought.
  const restarts = [];
  for (let i = 0; i < 3; i += 1) {
    const again = await start();
    assert.equal(again.status, 200, `restart ${i + 1} after an expired invoice: ${await again.clone().text()}`);
    restarts.push((await again.json()).orderId);
  }

  // The money lands on the invoice the provider already gave up on. Nothing is
  // delivered to us: no IPN is sent here, because NOWPayments would send none.
  const pings0 = discord.channelPosts.length;
  await tq('UPDATE checkout_attempts SET created_at = ? WHERE session_id = ?', [nowSec() - 7200, order.orderId]);
  let body = JSON.parse((await hitCron()).body);
  assert.equal(body.cryptoBackfill?.closed, 0, `an expired invoice inside the tracking window is not closed: ${JSON.stringify(body.cryptoBackfill)}`);
  assert.equal(await attemptStatus(order.orderId), 'started', 'it stays open, because it is the only thing still looking for that deposit');

  npDepositAfterExpiry(ref);
  body = JSON.parse((await hitCron()).body);
  assert.equal(body.cryptoBackfill?.recovered, 1, `the deposit nobody was told about is found: ${JSON.stringify(body.cryptoBackfill)}`);
  assert.ok(memberRoles(LATE).has(R2_VIP), 'and the buyer gets the role they paid for');
  assert.equal(await attemptStatus(order.orderId), 'completed');
  assert.ok((await subRow('nowpayments', ref)) !== null, 'the membership row is written like any other sale');
  assert.equal(discord.channelPosts.length, pings0 + 1, 'the seller is pinged once, by the sweep that delivered it');

  // The pay screen tells the same story as the API. Both sentences are lifted
  // out of the browser source and evaluated, so a copy edit is fine and a
  // wrong window is not.
  const appSrc = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const clockSrc = appSrc.match(/const cryptoClockText = \(left\) => \{[\s\S]*?\n\};/)?.[0];
  assert.ok(clockSrc, 'app.js must still decide the countdown wording in one place');
  const clockText = new Function(`${clockSrc}\n return cryptoClockText;`)();
  assert.match(clockText(600), /^expires in 10:00$/i, 'the countdown names what is running out, in the minutes the window really has');
  assert.doesNotMatch(clockText(600), /rate|quote/i, 'what expires is the payment, not a rate quote that outlives it');
  const note = appSrc.match(/const CRYPTO_EXPIRED_NOTE =\n?\s*'([^']*)';/)?.[1];
  assert.ok(note, 'app.js must still say what a closed window means in one place');
  assert.doesNotMatch(note, /rate has expired/i, 'the payment is what closed — the buyer cannot pay this invoice any more');
  assert.match(note, /already sent/i, 'and a buyer who already sent it is told not to send it again');

  // Cleanup: the three live restarts are nobody's business after this.
  for (const id of restarts) await tq('UPDATE checkout_attempts SET expires_at = ? WHERE session_id = ?', [nowSec() - 1, id]);
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: made.planKey, active: false })).status, 200);
});

test('cron: idempotency claims older than any provider retry window are purged, younger ones stay', async () => {
  await tq("INSERT INTO webhook_events (event_id, provider, received_at) VALUES ('stripe:evt_ancient', 'stripe', ?)", [nowSec() - 10 * 86400]);
  assert.equal((await claimRows('nowpayments:npid_lag:%')).length, 1);
  const body = JSON.parse((await hitCron()).body);
  assert.ok(body.claimsPurged >= 1, JSON.stringify(body));
  assert.deepEqual(await claimRows('stripe:evt_ancient'), [], 'a claim no retry can ever match again is gone');
  assert.equal((await claimRows('nowpayments:npid_lag:%')).length, 1, 'a claim inside the window stays');
});

test("crypto: an open invoice holds its seat and its discount use for the invoice's life, a buyer's live invoices are capped, and a settled order polls as paid without its payment id", async () => {
  const post = (path, body, cookie = npCookie) =>
    fetch(`${appUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ store: 'vip-signals', ...body }) });
  const start = (cookie, body) => post('/api/checkout/crypto', { payCurrency: 'sol', ...body }, cookie);
  const owned = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: npCookie } })).json();
  const storeId = owned.stores.find((s) => s.slug === 'vip-signals').id;
  const seat = JSON.parse(await (await post('/api/onboard', { step: 'product', storeId, name: 'Crypto Seat', priceUsd: 40, lifetime: true })).text()).plan;
  assert.equal((await post('/api/onboard', { step: 'role', storeId, planKey: seat.planKey, roleId: R2_VIP })).status, 200);
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: seat.planKey, purchaseLimit: 1 })).status, 200);
  assert.equal((await post('/api/admin/discounts', { action: 'create', code: 'NPONE', kind: 'percent', amount: 10, maxUses: 1 })).status, 200);
  const A = '525500000000000025';
  const B = '526600000000000026';
  const C = '527700000000000027';
  for (const u of [A, B, C]) discord.members.set(u, new Set());
  const aCookie = await signInAs('code_np_a', A, 'np_a');
  const bCookie = await signInAs('code_np_b', B, 'np_b');
  const cCookie = await signInAs('code_np_c', C, 'np_c');

  // A takes the one seat and the one-use code on an invoice nobody has paid.
  const a1 = await start(aCookie, { planId: seat.planKey, discountCode: 'NPONE' });
  assert.equal(a1.status, 200, await a1.clone().text());
  const aOrder = await a1.json();
  const rowOf = async (id) => (await tq('SELECT * FROM checkout_attempts WHERE session_id = ?', [id])).rows[0];
  // One instant, three uses. The seat hold, the discount hold and the buyer's
  // countdown are all the payment's own `valid_until` — ten minutes on the
  // fixed-rate flow this rail always asks for. Not the ESTIMATE's expiry (the
  // mock puts that 20 minutes out), not the card-form TTL (35), and not the
  // seven days this used to hold for: four distinct numbers, so nothing but
  // valid_until satisfies both of these.
  const heldUntil = asNum((await rowOf(aOrder.orderId)).expires_at);
  assert.ok(Math.abs(heldUntil - (nowSec() + 10 * 60)) < 120,
    'the seat and the discount use are held for exactly as long as the provider will accept the payment');
  assert.equal(Math.floor(Date.parse(aOrder.expiresAt) / 1000), heldUntil,
    "the buyer's countdown runs to the same instant the seat is held to — one fact, one number");
  // B is refused the seat, and the code — a subscriptions row lands only when
  // the IPN does, and a crypto invoice can sit unpaid for hours before that.
  const bSeat = await start(bCookie, { planId: seat.planKey });
  assert.equal(bSeat.status, 409);
  assert.match(await bSeat.text(), /sold out/);
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: seat.planKey, purchaseLimit: null })).status, 200);
  const bCode = await start(bCookie, { planId: seat.planKey, discountCode: 'NPONE' });
  assert.equal(bCode.status, 400, await bCode.text());
  // ...and the Apply button says the same thing the Pay button will. The
  // preview used to answer on `uses < max_uses` alone, so it reported "NPONE
  // applied, you save $4" for a use A's open invoice was holding — a promise
  // the next click broke, for as long as that invoice lives.
  const previewOf = (cookie) => fetch(`${appUrl}/api/discount?store=vip-signals&code=NPONE&plan=${seat.planKey}`, { headers: { cookie } });
  assert.equal((await previewOf(bCookie)).status, 404, "the preview refuses a use another buyer's open checkout holds");
  assert.equal((await previewOf(aCookie)).status, 200, "the holder's own reservation is never held against them");
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: seat.planKey, purchaseLimit: 1 })).status, 200);
  // Older than any card form could live, but the provider still takes money
  // for it: the seat is still A's.
  await tq('UPDATE checkout_attempts SET created_at = ? WHERE session_id = ?', [nowSec() - 2 * 3600, aOrder.orderId]);
  assert.equal((await start(bCookie, { planId: seat.planKey })).status, 409, 'an invoice the provider still accepts holds its seat past the card-form TTL');
  // Once the provider has given up on it, both are free.
  await tq('UPDATE checkout_attempts SET expires_at = ? WHERE session_id = ?', [nowSec() - 1, aOrder.orderId]);
  const bFree = await start(bCookie, { planId: seat.planKey, discountCode: 'NPONE' });
  assert.equal(bFree.status, 200, await bFree.clone().text());
  const bOrder = await bFree.json();

  // The pay screen polls the order row before the provider. With no payment
  // id attached it waits — and once the IPN has marked the order completed it
  // says paid, whether or not the id ever got attached.
  const poll = async (order, cookie) => (await fetch(`${appUrl}/api/checkout/crypto?store=vip-signals&order=${order}`, { headers: { cookie } })).json();
  const bRef = (await rowOf(bOrder.orderId)).provider_ref;
  await tq('UPDATE checkout_attempts SET provider_ref = NULL WHERE session_id = ?', [bOrder.orderId]);
  assert.equal((await poll(bOrder.orderId, bCookie)).state, 'pending');
  const bPayment = nowpayments.payments.get(bRef);
  bPayment.payment_status = 'finished';
  bPayment.actually_paid = bPayment.pay_amount;
  bPayment.actually_paid_at_fiat = bPayment.price_amount;
  assert.equal((await deliverNow({ payment_id: bRef, payment_status: 'finished', order_id: bOrder.orderId })).status, 200);
  await waitFor("B's crypto grant to land", async () => (await subRow('nowpayments', bRef)) !== null);
  assert.equal((await rowOf(bOrder.orderId)).status, 'completed');
  const paid = await poll(bOrder.orderId, bCookie);
  assert.deepEqual([paid.status, paid.state], ['finished', 'paid'], 'a settled order never polls as waiting');
  assert.equal((await poll(bOrder.orderId, aCookie)).state, undefined, "still nobody else's to read");

  // The network minimum is asked for the pair the payment used: the buyer's
  // coin into the seller's payout coin, never the coin into itself.
  const tiny = JSON.parse(await (await post('/api/onboard', { step: 'product', storeId, name: 'Tiny', priceUsd: 0.75, lifetime: true })).text()).plan;
  assert.equal((await post('/api/onboard', { step: 'role', storeId, planKey: tiny.planKey, roleId: R2_VIP })).status, 200);
  const under = await start(aCookie, { planId: tiny.planKey, payCurrency: 'btc' });
  assert.equal(under.status, 409);
  assert.match((await under.json()).error, /network minimum of about 0\.004 BTC/);
  // Both halves of the pair AND the flow. Every payment this rail creates is
  // fixed-rate with the fee paid by the user, and NOWPayments documents a
  // different floor for that flow than for the standard one — a minimum
  // fetched without the flags is a number from a flow the buyer is not on.
  assert.deepEqual(
    nowpayments.minAmount.at(-1),
    { from: 'btc', to: 'sol', fixedRate: 'true', feePaidByUser: 'true', fiat: 'usd' },
    'the minimum quoted is the one that refused the order, on the flow that refused it',
  );
  assert.deepEqual(
    nowpayments.created.at(-1) === undefined
      ? null
      : { fixed: nowpayments.created.at(-1).is_fixed_rate, fee: nowpayments.created.at(-1).is_fee_paid_by_user },
    { fixed: true, fee: true },
    'the flow the minimum was asked for is the flow createPayment actually sends',
  );
  {
    const { rows } = await tq('SELECT * FROM checkout_attempts WHERE discord_id = ? AND plan_id = ?', [A, tiny.planKey]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider_ref, null);
    // NOT NULL first: a released row must carry a real, passed expiry —
    // `null <= nowSec()` is true in JavaScript, so the bare comparison also
    // passed for a row that was never released and went on holding its seat.
    assert.ok(rows[0].expires_at !== null && rows[0].expires_at !== undefined && asNum(rows[0].expires_at) <= nowSec(),
      'an attempt the provider refused holds nothing');
  }

  // A buyer gets a few live addresses, not a loop's worth: each one holds a
  // seat and a discount use until the provider gives up on it.
  const loop = JSON.parse(await (await post('/api/onboard', { step: 'product', storeId, name: 'Crypto Loop', priceUsd: 20, lifetime: true })).text()).plan;
  assert.equal((await post('/api/onboard', { step: 'role', storeId, planKey: loop.planKey, roleId: R2_VIP })).status, 200);
  const minted = nowpayments.created.length;
  const cOrders = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await start(cCookie, { planId: loop.planKey });
    assert.equal(r.status, 200, await r.clone().text());
    cOrders.push((await r.json()).orderId);
  }
  const fourth = await start(cCookie, { planId: loop.planKey });
  assert.equal(fourth.status, 429, await fourth.text());
  assert.equal(nowpayments.created.length, minted + 3, 'the provider was never asked for the fourth');
  assert.equal((await start(bCookie, { planId: loop.planKey })).status, 200, "one buyer's cap is not another's");
  await tq('UPDATE checkout_attempts SET expires_at = ? WHERE session_id = ?', [nowSec() - 1, cOrders[0]]);
  assert.equal((await start(cCookie, { planId: loop.planKey })).status, 200, 'an expired invoice no longer counts');

  // And the cap holds when the clicks are in flight TOGETHER. Counted before
  // the row was written, six parallel starts each read "none open yet" and
  // each got an address — six live invoices, six held seats, from one buyer.
  const D = '529000000000000030';
  discord.members.set(D, new Set());
  const dCookie = await signInAs('code_np_d', D, 'np_d');
  const burstFrom = nowpayments.created.length;
  // The provider takes its time, which is what made the old check-then-create
  // window wide enough to drive a lorry through.
  nowpayments.delayCreateMs = 150;
  try {
    const burst = await Promise.all([...Array(6)].map(() => start(dCookie, { planId: loop.planKey })));
    assert.deepEqual(burst.map((r) => r.status).sort(), [200, 200, 200, 429, 429, 429], 'three invoices and three refusals, not six invoices');
    assert.equal(nowpayments.created.length, burstFrom + 3, 'the provider was asked exactly three times');
  } finally {
    nowpayments.delayCreateMs = 0;
  }
  // Cleanup: park the products.
  for (const key of [seat.planKey, tiny.planKey, loop.planKey]) {
    assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: key, active: false })).status, 200);
  }
});

test('a one-seat product is sold once when two buyers click Pay in the same instant, on either rail', async () => {
  // The purchase limit used to be checked and then written on either side of
  // a call to the payment provider: both buyers passed the check, both waited
  // on Stripe or NOWPayments, and both were handed a checkout for the last
  // seat. The card rail has no settlement-time re-check to catch it either —
  // whoever paid, paid — so a one-seat product delivered twice. The seat is
  // taken by the INSERT that records the attempt, so only one of them gets it.
  const post = (path, body, cookie = npCookie) =>
    fetch(`${appUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ store: 'vip-signals', ...body }) });
  const owned = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: npCookie } })).json();
  const storeId = owned.stores.find((s) => s.slug === 'vip-signals').id;
  const seat = JSON.parse(await (await post('/api/onboard', { step: 'product', storeId, name: 'Single Seat', priceUsd: 50, lifetime: true })).text()).plan;
  assert.equal((await post('/api/onboard', { step: 'role', storeId, planKey: seat.planKey, roleId: R2_VIP })).status, 200);
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: seat.planKey, purchaseLimit: 1 })).status, 200);
  const buyers = ['529100000000000031', '529200000000000032', '529300000000000033', '529400000000000034'];
  for (const u of buyers) discord.members.set(u, new Set());
  const [w, x, y, z] = await Promise.all(buyers.map((u, i) => signInAs(`code_seat_${i}`, u, `seat_${i}`)));
  const card = (cookie) => post('/api/checkout/stripe', { planId: seat.planKey }, cookie);
  const crypto_ = (cookie) => post('/api/checkout/crypto', { planId: seat.planKey, payCurrency: 'sol' }, cookie);
  const started = async () => (await tq("SELECT discord_id FROM checkout_attempts WHERE plan_id = ? AND status = 'started'", [seat.planKey])).rows;

  // The window is the provider's answer, so the mocks take their time here:
  // without it the two requests do not really overlap and the scenario proves
  // nothing about the ordering it exists to pin.
  stripe.delayCheckoutSessionsMs = 200;
  nowpayments.delayCreateMs = 200;
  try {
    const mixed = await Promise.all([card(w), crypto_(x)]);
    assert.deepEqual(mixed.map((r) => r.status).sort(), [200, 409], 'one card and one crypto checkout for one seat: exactly one of them');
    assert.equal((await started()).length, 1, 'and exactly one buyer is holding it');
    await tq('DELETE FROM checkout_attempts WHERE plan_id = ?', [seat.planKey]);

    const twoCards = await Promise.all([card(y), card(z)]);
    assert.deepEqual(twoCards.map((r) => r.status).sort(), [200, 409], 'two card buyers in the same instant: exactly one of them');
    assert.equal((await started()).length, 1, 'one seat, one reservation');
    // The reservation is a real attempt row under Stripe's own session id, not
    // a placeholder left behind: the completion webhook matches on that id.
    assert.match((await tq('SELECT session_id FROM checkout_attempts WHERE plan_id = ? ORDER BY id DESC', [seat.planKey])).rows[0].session_id, /^cs_/);
  } finally {
    stripe.delayCheckoutSessionsMs = 0;
    nowpayments.delayCreateMs = 0;
  }
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: seat.planKey, active: false })).status, 200);
});

test('an option of a switched-off product is not for sale on either rail', async () => {
  const post = (path, body, cookie = npCookie) =>
    fetch(`${appUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ store: 'vip-signals', ...body }) });
  const owned = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: npCookie } })).json();
  const storeId = owned.stores.find((s) => s.slug === 'vip-signals').id;
  const parent = JSON.parse(await (await post('/api/onboard', { step: 'product', storeId, name: 'Cohort', priceUsd: 300, lifetime: true })).text()).plan;
  assert.equal((await post('/api/onboard', { step: 'role', storeId, planKey: parent.planKey, roleId: R2_VIP })).status, 200);
  const option = JSON.parse(await (await post('/api/onboard', { step: 'variant', storeId, planKey: parent.planKey, label: 'Monthly', priceUsd: 30, lifetime: false })).text()).plan;
  const buyer = await signInAs('code_np_opt', '528800000000000028', 'np_opt');
  discord.members.set('528800000000000028', new Set());
  assert.equal((await post('/api/checkout/crypto', { planId: option.planKey, payCurrency: 'sol' }, buyer)).status, 200, 'the option sells while its product is on');
  // The seller switches the PRODUCT off. The storefront hides the option;
  // its own planId, from a cached link, must be just as dead at the API.
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: parent.planKey, active: false })).status, 200);
  const viaCrypto = await post('/api/checkout/crypto', { planId: option.planKey, payCurrency: 'sol' }, buyer);
  const viaCryptoBody = await viaCrypto.text();
  assert.equal(viaCrypto.status, 409, viaCryptoBody);
  assert.match(viaCryptoBody, /not for sale/);
  const viaCard = await post('/api/checkout/stripe', { planId: option.planKey }, buyer);
  const viaCardBody = await viaCard.text();
  assert.equal(viaCard.status, 409, viaCardBody);
  assert.match(viaCardBody, /not for sale/);
});

test('the discount preview budgets misses, so it cannot be walked as an oracle', async () => {
  const plan = (await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json()).plans.find((p) => !p.variantOf);
  const cookie = await signInAs('code_np_guess', '529900000000000029', 'np_guess');
  const ask = (code, headers = {}, store = 'vip-signals') => fetch(`${appUrl}/api/discount?store=${store}&code=${code}&plan=${store === 'vip-signals' ? plan.id : 'vip-access'}`, { headers });
  assert.equal((await ask('LAUNCH20', { cookie })).status, 200, 'a real code previews');
  for (let i = 0; i < 8; i += 1) {
    assert.equal((await ask(`GUESS${i}`, { cookie })).status, 404);
  }
  assert.equal((await ask('GUESS9', { cookie })).status, 429, 'the ninth miss in the window is refused');
  assert.equal((await ask('LAUNCH20', { cookie })).status, 429, 'and so is a hit — the throttle must not be the oracle');
  assert.equal((await ask('LAUNCH20')).status, 200, "another asker's budget is their own");

  // Checkout answers the same question — hit or miss, synchronously, to any
  // Discord login — so budgeting only the preview moved the oracle one
  // endpoint over instead of closing it. One budget, shared.
  const guesser = await signInAs('code_np_guess2', '529900000000000030', 'np_guess2');
  discord.members.set('529900000000000030', new Set());
  const buy = (discountCode) => fetch(`${appUrl}/api/checkout/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: guesser },
    body: JSON.stringify({ store: 'vip-signals', planId: plan.id, discountCode }),
  });
  for (let i = 0; i < 8; i += 1) {
    assert.equal((await buy(`CGUESS${i}`)).status, 400, `checkout miss ${i}`);
  }
  assert.equal((await buy('LAUNCH20')).status, 429, 'past the budget checkout refuses alike — a hit must not be the tell');
  assert.equal((await ask('LAUNCH20', { cookie: guesser })).status, 429, 'one budget for both endpoints, not one each');

  // The store-wide cap is shared by every visitor of that store, so refusing
  // on it let ~38 guessers switch the Apply button off for a store's real
  // buyers, renewably. It may refuse guessing; it may not refuse a real code.
  for (let i = 0; i < 300; i += 1) {
    await ask(`FLOOD${i}`, { 'x-forwarded-for': `10.${Math.floor(i / 250)}.${i % 250}.7` });
  }
  assert.equal((await ask('LAUNCH20', { 'x-forwarded-for': '10.9.9.9' })).status, 200, 'a real code still previews once a store is over its cap');
  assert.equal((await ask('NOPE', { 'x-forwarded-for': '10.9.9.9' })).status, 429, 'guessing past the store cap is refused');

  // The budget is in the database, not in the process. This ships as
  // serverless functions: a module-level Map is a fresh eight answers on
  // every instance and every cold start, which is no budget at all.
  assert.ok(Number((await tq('SELECT COUNT(*) AS n FROM discount_misses WHERE asker = ?', [`u:${'529900000000000029'}`])).rows[0].n) >= 8,
    "the asker's misses are counted in shared storage");
  // A store that is not being walked serves everybody normally, cap or no cap:
  // the count is per store, so one store's flood is not another's outage.
  assert.equal((await ask('NOPE', { 'x-forwarded-for': '198.51.100.4' }, 'demo')).status, 404,
    "a quiet store still answers a stranger's miss");
});


test('dashboard money: a crypto pass is not recurring revenue, and a deleted product does not turn a yearly member into a monthly one', async () => {
  // Two facts the Overview MRR card reads straight off this endpoint, and
  // gets wrong in opposite directions when either is missing.
  const ownerCookie = await signInAs('code_u7_mrr', '507700000000000007', 'vip_owner');
  const rowsFor = async (extra = '') =>
    (await (await fetch(`${appUrl}/api/admin/payments?store=vip-signals${extra}`, { headers: { cookie: ownerCookie } })).json());

  // 1. RENEWS. MRR is revenue that bills again. Stripe runs every term plan
  //    in subscription mode, so a card row does; a crypto purchase is a fixed
  //    term that simply ends — /account tells the buyer "a one-time payment,
  //    nothing renews" — and a manual grant was never charged at all. Counted
  //    as MRR, a store selling mostly crypto passes shows a figure that falls
  //    to zero on its own at term end.
  const seen = await rowsFor();
  assert.ok(seen.payments.length, 'the store has sales to judge');
  // The platform view, for the rails this one store has not sold on.
  const adminCookie = await signInAs('code_u1', U1, 'trader_one');
  const every = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: adminCookie } })).json();
  for (const p of [...seen.payments, ...every.payments]) {
    assert.equal(typeof p.renews, 'boolean', `every row says whether it bills again (${p.planId}/${p.provider})`);
    assert.equal(p.renews, p.provider === 'stripe' && !p.lifetime, `${p.provider}${p.lifetime ? ' lifetime' : ''} row: renews`);
  }
  const fixedTerm = every.payments.find((p) => p.provider !== 'stripe' && p.provider !== 'manual' && !p.lifetime);
  assert.ok(fixedTerm, 'a fixed-term crypto pass is on the books to judge');
  assert.equal(fixedTerm.renews, false, 'a crypto pass is bought once and ends — never recurring revenue');
  assert.ok(every.payments.some((p) => p.renews), 'while card subscriptions still count');

  // 2. THE TERM SURVIVES THE PRODUCT. deleteStorePlan is a hard DELETE, and
  //    product-delete refuses while anyone LIVE holds the product — but a
  //    member whose card failed and whose grace has run out is not live, so
  //    the delete goes through, and Stripe's own retry brings them back
  //    afterwards (customer.subscription.updated reactivates the row without
  //    consulting the catalog). The plan row is gone; the member is still
  //    billed $600 a YEAR. Reading the term off the catalog left no term at
  //    all there, and no term reads as monthly: $600 of MRR where there is $50.
  const storeId = seen.stores.find((s) => s.slug === 'vip-signals').id;
  const post = (path, body) =>
    fetch(`${appUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: ownerCookie }, body: JSON.stringify({ store: 'vip-signals', ...body }) });
  const made = await (await post('/api/onboard', { step: 'product', storeId, name: 'Desk Yearly', description: 'A year at the desk.', priceUsd: 600, lifetime: false, durationDays: 365 })).json();
  const yearlyKey = made.plan?.planKey;
  assert.ok(yearlyKey, `the yearly product must be created: ${JSON.stringify(made)}`);

  const YEARLY_BUYER = '523300000000000023';
  const SUB = 'sub_desk_yearly';
  discord.members.set(YEARLY_BUYER, new Set());
  stripe.periodEnds[SUB] = nowSec() + 365 * 86400;
  const signed = (evt) => deliverStripe(evt, { path: `/webhooks/stripe/${storeId}`, header: signStripe(JSON.stringify(evt), nowSec(), AUTO_ENDPOINT_SECRET) });
  assert.equal(
    (await signed({
      id: 'evt_desk_yearly',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_desk_yearly', mode: 'subscription', subscription: SUB, payment_status: 'paid', amount_total: 60000, client_reference_id: YEARLY_BUYER, metadata: { plan_id: yearlyKey, discord_id: YEARLY_BUYER, store_id: String(storeId) } } },
    })).status,
    200,
  );
  const mine = async () => (await rowsFor()).payments.find((p) => p.discordId === YEARLY_BUYER);
  const sold = await mine();
  assert.ok(sold, 'the yearly sale landed');
  assert.equal(sold.durationDays, 365, 'the sale goes on the books as a yearly');
  assert.equal(sold.renews, true, 'a card subscription bills again');

  // Their card fails and the grace window runs out. Only the clock is faked.
  await tq("UPDATE subscriptions SET status = 'past_due', grace_until = ? WHERE provider = 'stripe' AND provider_ref = ?", [nowSec() - 60, SUB]);
  // Nobody is live on the product now, so the seller may retire it.
  const gone = await post('/api/onboard', { step: 'product-delete', storeId, planKey: yearlyKey });
  assert.equal(gone.status, 200, await gone.text());
  // Stripe recovers the payment: active again, on a plan row that is gone.
  assert.equal(
    (await signed({
      id: 'evt_desk_yearly_up',
      type: 'customer.subscription.updated',
      data: { object: { id: SUB, status: 'active', items: { data: [{ current_period_end: nowSec() + 365 * 86400 }] } } },
    })).status,
    200,
  );

  const after = await mine();
  assert.equal(after.entitled, true, 'the member is entitled again');
  assert.equal(after.planName, yearlyKey, 'and the catalog really has nothing left to name them by');
  assert.equal(after.durationDays, 365, 'the term the sale was made on outlives the product row');
  assert.equal(after.amountUsd, sold.amountUsd, 'and so does what they paid');
});

test('crypto: buyer-facing copy never promises a renewal or a cancellation the rail cannot do', async () => {
  // A crypto grant is a fixed term (periodEnd null → plan.durationDays) that
  // no one can cancel (/api/subscription refuses non-stripe refs) and that
  // never renews. The storefront and /account are plain browser scripts, so
  // the two copy expressions are lifted out of the source and evaluated
  // rather than matched as strings: a copy edit is fine, a promise is not.
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const assureExpr = app.match(/assure\.textContent = ([\s\S]*?);\n\s*area\.append\(assure\)/)?.[1];
  assert.ok(assureExpr, 'the note under the pay button must still be a single expression');
  const assure = new Function('plan', 'crypto', 'termDays', `return (${assureExpr});`);
  // The plan object is the one /api/plans actually serves, not a hand-built
  // stand-in: the note can only name the term if the payload carries it, and
  // a projection that drops durationDays leaves every buyer reading "a fixed
  // term" however carefully the sentence is written.
  const served = (await (await fetch(`${appUrl}/api/plans?store=tradeleaks`)).json()).plans;
  const monthly = served.find((p) => !p.lifetime);
  assert.ok(monthly, 'the storefront must still sell a term product');
  assert.ok(Number(monthly.durationDays) > 0, '/api/plans has to carry the term length — the pay screen has nowhere else to read it');
  assert.match(assure(monthly, false, Number(monthly.durationDays)), /cancel anytime/i, 'a card membership really can be cancelled from /account');
  const cryptoNote = assure(monthly, true, Number(monthly.durationDays));
  assert.doesNotMatch(cryptoNote, /cancel/i, 'nothing on a crypto term can be cancelled — do not say it');
  assert.match(cryptoNote, /nothing renews|does not renew|no renewal/i, 'the crypto note must say the term does not renew');
  assert.match(cryptoNote, new RegExp(`\\b${monthly.durationDays} days\\b`), 'the fixed term is the one fact the buyer needs');
  const lifetimePlan = served.find((p) => p.lifetime);
  if (lifetimePlan) assert.equal(lifetimePlan.durationDays, null, 'a lifetime product has no term to advertise');
  assert.doesNotMatch(assure({ lifetime: true, durationDays: null }, true, NaN), /cancel|renews/i);

  const account = fs.readFileSync(new URL('../public/account.js', import.meta.url), 'utf8');
  const expiryExpr = account.match(/const expiry = ([\s\S]*?);\n\s*const roles/)?.[1];
  assert.ok(expiryExpr, '/account must still describe the term in one expression');
  const expiry = new Function('sub', 'fmtDate', `return (${expiryExpr});`);
  const fmt = (t) => `<${t}>`;
  const base = { lifetime: false, cancelsAt: null, entitled: true, currentPeriodEnd: 1_800_000_000, graceUntil: null };
  assert.match(expiry({ ...base, provider: 'stripe' }, fmt), /^Renews <1800000000>/);
  for (const provider of ['nowpayments', 'coinbase']) {
    const text = expiry({ ...base, provider }, fmt);
    assert.doesNotMatch(text, /renews <|will renew|auto-renew(?!s\b)/i, `${provider}: nothing will charge again, so it must not say Renews`);
    assert.match(text, /ends <1800000000>/i, `${provider}: the buyer is told the date the role goes away`);
  }
  // A membership the owner granted by hand was never bought. It ends like a
  // crypto term, but calling it a payment and telling the member to buy again
  // invoices them for a gift — so "one-time payment"/"buy again" is reserved
  // for the rails that really took money, and anything else stays neutral.
  for (const provider of ['manual', undefined]) {
    const text = expiry({ ...base, provider }, fmt);
    assert.match(text, /ends <1800000000>/i, `${String(provider)}: the member is still told when access ends`);
    assert.doesNotMatch(text, /payment|buy again|renews </i, `${String(provider)}: a comped membership was not paid for`);
  }
});

test('crypto: the two coin pickers survive answers the deposit list does not describe', async () => {
  // Both pickers are browser code this suite does not run, so the two pure
  // decisions behind them are lifted out of the files and executed as written.

  // Seller side. /merchant/coins is the DEPOSIT list; payouts are gated by
  // payout/validate-address instead, and the suite above proves a store can
  // legitimately be saved on LTC while LTC is absent from that list. A
  // <select> cannot hold a value it has no option for, so a picker built from
  // the deposit list alone would open on "Choose a coin…", show generic copy
  // for an address that is in fact valid, and refuse to save until the seller
  // moved their payouts to another network.
  const dashSrc = fs.readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  const payoutCoinsSrc = dashSrc.match(/function payoutCoins\(coins, current\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(payoutCoinsSrc, 'dashboard.js must still decide the payout options in one place');
  const payoutCoins = new Function(`${payoutCoinsSrc}\n return payoutCoins;`)();
  const deposit = ['sol', 'usdtsol', 'btc', 'eth', 'xmr'];
  assert.ok(payoutCoins(deposit, 'ltc').includes('ltc'), 'the chain on file is always offered — otherwise the card cannot round-trip it');
  assert.equal(payoutCoins(deposit, 'ltc')[0], 'ltc', 'and it is the one already selected, so Save works untouched');
  assert.deepEqual(payoutCoins(deposit, 'sol'), deposit, 'a chain already in the list is not duplicated');
  assert.deepEqual(payoutCoins(deposit, ''), deposit, 'a store with no chain yet just gets the starting set');

  // Buyer side. `ready:false` and an empty list are the same fact — nothing
  // here can be paid with — and remembering either parks an empty grid under
  // a live Crypto tile for the life of the page, even after the seller
  // finishes their setup a minute later. null is "ask again".
  const appSrc = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const fromAnswerSrc = appSrc.match(/const coinsFromAnswer = \(data\) => \{[\s\S]*?\n\};/)?.[0];
  assert.ok(fromAnswerSrc, 'app.js must still decide what to keep from a ?coins=1 answer in one place');
  const coinsFromAnswer = new Function(`${fromAnswerSrc}\n return coinsFromAnswer;`)();
  assert.equal(coinsFromAnswer({ ready: false, coins: [] }), null, 'a not-ready rail is never cached as "no coins"');
  assert.equal(coinsFromAnswer({ ready: true, coins: [] }), null, 'nor is a ready answer with nothing in it');
  assert.equal(coinsFromAnswer({}), null);
  assert.deepEqual(coinsFromAnswer({ ready: true, coins: ['sol', 'btc'] }), ['sol', 'btc'], 'a real list is kept as it arrived');
});

test('crypto: an IPN the runtime already parsed is still verified, not answered with a blanket 400', async () => {
  // The NOWPayments signature is over a sorted re-serialisation of the JSON,
  // not the wire bytes — so unlike Stripe's, a body the platform pre-parsed
  // onto req.body is still verifiable. A runtime change that starts doing
  // that must not turn into 400 on every delivery (and every sale lost).
  const { Readable } = await import('node:stream');
  const { config: appConfig } = await import('../src/config.js');
  const { default: npWebhook } = await import('../api/webhooks/nowpayments.js');
  const makeRes = () => {
    const res = { statusCode: 0, body: '', headersSent: false };
    res.writeHead = (code) => ((res.statusCode = code), (res.headersSent = true), res);
    res.end = (chunk) => ((res.body += chunk ?? ''), res);
    return res;
  };
  const makeReq = (sig) => {
    const req = new Readable({ read() {} });
    req.method = 'POST';
    req.url = '/api/webhooks/nowpayments';
    req.headers = { 'x-nowpayments-sig': sig };
    return req;
  };
  // The handler runs in THIS process, whose config never saw the rail's
  // credentials; lend it the suite's, then hand them back.
  const saved = { apiKey: appConfig.nowpayments.apiKey, ipnSecret: appConfig.nowpayments.ipnSecret, released: process.env.NOWPAYMENTS_RELEASED };
  appConfig.nowpayments.apiKey = NOW_KEY;
  appConfig.nowpayments.ipnSecret = NOW_IPN_SECRET;
  process.env.NOWPAYMENTS_RELEASED = '1';
  try {
    // No payment_id, so a delivery whose signature verifies stops at the
    // payload check — which is only reachable if the pre-parsed object was
    // the thing signed and verified.
    const payload = { payment_status: 'finished', order_id: 'np_preparsed' };
    const reqA = makeReq(signNow(payload));
    Object.defineProperty(reqA, 'body', { value: payload, configurable: true });
    const resA = makeRes();
    await npWebhook(reqA, resA);
    assert.deepEqual({ status: resA.statusCode, body: resA.body }, { status: 400, body: 'invalid payload' });

    const reqB = makeReq(signNow(payload, 'the-wrong-secret'));
    Object.defineProperty(reqB, 'body', { value: payload, configurable: true });
    const resB = makeRes();
    await npWebhook(reqB, resB);
    assert.deepEqual({ status: resB.statusCode, body: resB.body }, { status: 400, body: 'invalid signature' }, 'a pre-parsed body is verified, never trusted');

    // Vercel's LAZY getter: the stream is read and the getter never touched.
    const reqC = makeReq(signNow(payload));
    let getterTouched = false;
    Object.defineProperty(reqC, 'body', { get() { getterTouched = true; return {}; }, configurable: true });
    reqC.push(JSON.stringify(payload));
    reqC.push(null);
    const resC = makeRes();
    await npWebhook(reqC, resC);
    assert.deepEqual({ status: resC.statusCode, body: resC.body }, { status: 400, body: 'invalid payload' });
    assert.equal(getterTouched, false, 'probing req.body would consume the stream');
  } finally {
    appConfig.nowpayments.apiKey = saved.apiKey;
    appConfig.nowpayments.ipnSecret = saved.ipnSecret;
    if (saved.released === undefined) delete process.env.NOWPAYMENTS_RELEASED;
    else process.env.NOWPAYMENTS_RELEASED = saved.released;
  }
});

// A crypto checkout for the vip-signals buyer: the order row and the mock
// payment it points at, so a scenario can walk the payment through statuses.
async function npCheckout(planId, cookie = npBuyerCookie) {
  const res = await fetch(`${appUrl}/api/checkout/crypto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ store: 'vip-signals', planId, payCurrency: 'sol' }),
  });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const order = JSON.parse(body);
  const { rows } = await tq('SELECT provider_ref FROM checkout_attempts WHERE session_id = ?', [order.orderId]);
  return { order, payment: nowpayments.payments.get(rows[0].provider_ref) };
}
const npView = async (orderId, cookie = npBuyerCookie) =>
  (await fetch(`${appUrl}/api/checkout/crypto?store=vip-signals&order=${orderId}`, { headers: { cookie } })).json();
const npAttemptStatus = async (orderId) =>
  (await tq('SELECT status FROM checkout_attempts WHERE session_id = ?', [orderId])).rows[0].status;

test('crypto: no coin figure without evidence, and a status nobody knows is "checking", never "confirming"', async () => {
  const { describeStatus, paidInRequestedCoin, settledFiat } = await import('../src/lib/nowpayments.js');
  // Wrong-asset auto-processing is ON, so a deposit with no fiat valuation
  // attached could be any coin. actually_paid_at_fiat is the only evidence of
  // what turned up, and ONE rule follows from its absence: no coin figure and
  // no money figure either. The shortfall used to be quoted in dollars from
  // (actually_paid / pay_amount) × price — the same wrong-asset assumption
  // the coin figure is withheld for, dressed up as a precise number.
  const bare = { payment_status: 'partially_paid', pay_currency: 'sol', pay_amount: 0.5, actually_paid: 0.35, price_amount: 49.99, price_currency: 'usd' };
  assert.equal(paidInRequestedCoin(bare), false, 'no actually_paid_at_fiat is no evidence, not proof of the requested coin');
  assert.equal(settledFiat(bare), null, 'and no evidence of what it was worth either');
  assert.doesNotMatch(describeStatus(bare, { currency: 'usd' }).message, /SOL/);
  assert.doesNotMatch(describeStatus(bare, { currency: 'usd' }).message, /[$\d]/, 'no figure at all, in any unit, when nothing here knows one');
  assert.match(describeStatus(bare, { currency: 'usd' }).message, /same address/, 'they can still top it up');
  assert.match(describeStatus({ ...bare, actually_paid_at_fiat: 34.99 }, { currency: 'usd' }).message, /\$15\.00/, 'a reported fiat value is quoted');
  assert.equal(paidInRequestedCoin({ ...bare, actually_paid_at_fiat: 34.99 }), true, 'a fiat value that agrees with the coin maths is the evidence');

  for (const status of ['something_new', '', undefined]) {
    const d = describeStatus({ payment_status: status });
    assert.equal(d.state, 'pending', `status ${JSON.stringify(status)} keeps the screen polling`);
    assert.match(d.message, /Checking on this payment/);
    assert.doesNotMatch(d.message, /Confirming/, 'nothing here knows a confirmation is under way');
  }

  // The same status through the webhook: nothing granted, and a log line an
  // operator can find — the buyer's screen says "checking", so this is the
  // only trace.
  const plans = await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json();
  const { order, payment } = await npCheckout(plans.plans[0].id);
  payment.payment_status = 'something_new';
  assert.equal((await deliverNow({ payment_id: payment.payment_id, payment_status: 'something_new', order_id: order.orderId })).status, 200);
  assert.equal(await subRow('nowpayments', payment.payment_id), null);
  await waitFor('the unrecognised status to be logged', () =>
    appLog.join('').includes(`nowpayments ${payment.payment_id} (order ${order.orderId}) has unrecognised status "something_new"`));
  const view = await npView(order.orderId);
  assert.equal(view.state, 'pending');
  assert.match(view.message, /Checking on this payment/);
});

test('crypto: a provider-shaped IPN — nested fee object, array of child ids, non-ASCII description — verifies', async () => {
  // Checked against the IPN body in NOWPayments' own API documentation
  // (documenter.getpostman.com/view/7907941/2s93JusNJt, "Webhooks Examples")
  // and against their Node SDK's sortObjectDeep. A real delivery is NOT flat:
  //
  //   • `fee` is a nested object, and its keys do not arrive sorted —
  //     depositFee, withdrawalFee, serviceFee is the documented order, so a
  //     sort that only touches the top level signs a different string;
  //   • `payment_extra_ids` is an array of child deposits — an implementation
  //     that rebuilt it as an object would render {"0":…};
  //   • `order_description` is ours, em dash and all — escaping it as \u2014
  //     is a fourth way to diverge.
  //
  // Every other crypto scenario delivers a flat ASCII body, which all three
  // bugs survive. The order is deliberately not one of ours: this pins the
  // signature, and nothing else.
  nowpayments.payments.set('npid_shaped', {
    payment_id: 'npid_shaped',
    payment_status: 'finished',
    order_id: 'np_00000000000000000000000000000001',
    price_amount: 49.99,
    price_currency: 'usd',
    pay_currency: 'sol',
  });
  const ipn = {
    payment_id: 'npid_shaped',
    parent_payment_id: null,
    invoice_id: null,
    payment_status: 'finished',
    pay_address: 'ADDR_npid_shaped',
    payin_extra_id: null,
    price_amount: 49.99,
    price_currency: 'usd',
    pay_amount: 0.5,
    actually_paid: 0.5,
    actually_paid_at_fiat: 0,
    pay_currency: 'sol',
    order_id: 'np_00000000000000000000000000000001',
    order_description: 'VIP Signals — Dues',
    purchase_id: '5312822613',
    outcome_amount: 0.4985,
    outcome_currency: 'sol',
    payment_extra_ids: [5513339153],
    fee: { currency: 'sol', depositFee: 0.09853637216235617, withdrawalFee: 0, serviceFee: 0 },
  };
  assert.equal((await deliverNow(ipn)).status, 200, 'the shape the provider actually sends has to verify');
  assert.equal((await deliverNow(ipn, { signature: signNow({ ...ipn, actually_paid: 0.6 }) })).status, 400, 'and a signature over anything else must not');
});

test('crypto: a second deposit on a delivered order is money the seller is TOLD about, not silence', async () => {
  // The shape the documentation sweep found a hole under. The buyer paid,
  // the role landed, and then they sent more to the same address — a mistake,
  // a double-click on a wallet, a top-up they thought was needed. NOWPayments
  // takes it, mints a payment of its own for it, forwards the coins to the
  // seller, and posts an IPN with no order_id. Resolved only through our own
  // order id, that IPN was "payment without order_id, ignoring" and a 200:
  // the seller's wallet grew and nobody was told anything.
  // The order the earlier scenario paid for and had delivered.
  const payment = nowpayments.payments.get('npid_1');
  assert.equal(payment.payment_status, 'finished');
  assert.equal(await npAttemptStatus(npOrder.orderId), 'completed');
  const order = npOrder;

  const pings0 = discord.channelPosts.length;
  const child = npRepeatDeposit(payment.payment_id, { atFiat: Number(payment.price_amount) });
  assert.equal(child.order_id, null, 'the provider does not put our order id on a payment it minted itself');
  assert.deepEqual(
    nowpayments.payments.get(payment.payment_id).payment_extra_ids,
    [child.payment_id],
    'and it lists the child on the parent, which is the documented "array of child payments"',
  );
  const ipn = npDepositIpn(child);
  const res = await deliverNow(ipn);
  assert.deepEqual([res.status, res.body], [200, 'ok'], 'answered: this cannot become a sale on a retry');
  assert.equal(await subRow('nowpayments', child.payment_id), null, 'a repeat deposit is not a second sale');
  assert.equal(await npAttemptStatus(order.orderId), 'completed', 'and it does not reopen or re-close the order');
  assert.equal(discord.channelPosts.length, pings0 + 1, 'money the seller was sent and did not sell is not silence');
  const embed = discord.channelPosts.at(-1).body.embeds[0];
  assert.match(embed.title, /not a new sale/i);
  assert.doesNotMatch(embed.title, /New Subscriber/, 'it is money, but it is not a subscriber');
  assert.ok(embed.description.includes(child.payment_id), 'the id the seller needs to find it in the dashboard');
  assert.match(embed.description, /SOL/, 'and which coin was sent');

  // Once. NOWPayments has no replay protection, and one deposit produces
  // several transitions — each of which re-reads `finished` here.
  assert.equal((await deliverNow(ipn)).status, 200);
  assert.equal(discord.channelPosts.length, pings0 + 1, 'exactly one alert per deposit');
});

test('crypto: a wrong-coin deposit is a CHILD payment — the order stays open and the seller hears about it', async () => {
  // The account has extra-deposits auto processing on (the release checklist
  // requires it), so a buyer who sends a coin the invoice was not created for
  // does not get it bounced. What they also do not get is credit against the
  // invoice: the provider makes a new payment with a new id, names the
  // invoice in parent_payment_id, and leaves the original exactly where it
  // was. The file header used to claim the opposite — converted "and credited
  // anyway" against the same payment — which is why nothing ever looked for
  // the child.
  const plans = await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json();
  const { order, payment } = await npCheckout(plans.plans[0].id);
  const pings0 = discord.channelPosts.length;
  const child = npRepeatDeposit(payment.payment_id, { payCurrency: 'btc', actuallyPaid: 0.0004, atFiat: Number(payment.price_amount) });
  const res = await deliverNow(npDepositIpn(child));
  assert.deepEqual([res.status, res.body], [200, 'ok']);

  assert.equal(nowpayments.payments.get(payment.payment_id).payment_status, 'waiting', 'the invoice itself does not move');
  assert.equal(await subRow('nowpayments', child.payment_id), null, 'a deposit the provider minted is not a sale to grant on');
  assert.equal(await subRow('nowpayments', payment.payment_id), null, 'nor is it a reason to grant on the invoice');
  assert.equal(await npAttemptStatus(order.orderId), 'started', 'the order stays open — finishing it is the seller\'s call, in their dashboard');
  assert.equal(discord.channelPosts.length, pings0 + 1, 'the seller learns coins arrived for an order that is not delivered');
  const embed = discord.channelPosts.at(-1).body.embeds[0];
  assert.match(embed.title, /did not complete the order/i);
  assert.match(embed.description, /BTC/, 'which coin turned up, since it is not the one the invoice asked for');
  assert.ok(embed.description.includes(child.payment_id));
  assert.match(embed.description, /Members|dashboard/, 'and what they can do about it');

  // The buyer is not told "confirmed": nothing was delivered.
  const view = await npView(order.orderId);
  assert.equal(view.state, 'pending', JSON.stringify(view));

  // Housekeeping, not behaviour: this order is deliberately left OPEN by the
  // code under test (the seller may still finish the payment), and a live
  // invoice holds one of this buyer's three invoice slots in this store. Let
  // it lapse so the scenarios after this one keep their own budget.
  await tq('UPDATE checkout_attempts SET expires_at = ? WHERE session_id = ?', [nowSec() - 60, order.orderId]);
});

test('crypto: a payment that resolves to no order of ours is an alarm, not a log line', async () => {
  // Two ways a deposit ends up unattributable: no order_id and no parent at
  // all, and a parent the provider itself does not know. Neither can be
  // turned into a sale from here — only the NOWPayments dashboard holds the
  // deposit address that says which invoice it was sent to — but money on the
  // platform's own merchant account arriving for nothing is not something to
  // leave in a serverless log nobody reads.
  const row = (await tq('SELECT id, notify_channel_id FROM stores WHERE guild_id = ?', [GUILD])).rows[0];
  assert.ok(row, 'the platform guild has a store whose channel this alarm belongs in');
  await tq('UPDATE stores SET notify_channel_id = ? WHERE id = ?', ['800000000000000002', row.id]);
  try {
    nowpayments.payments.set('npid_orphan', {
      payment_id: 'npid_orphan', parent_payment_id: null, payment_status: 'finished',
      order_id: null, price_currency: 'usd', pay_currency: 'sol',
      actually_paid: 0.5, actually_paid_at_fiat: 49.99, purchase_id: '5312822699',
    });
    const pings0 = discord.channelPosts.length;
    const orphan = { payment_id: 'npid_orphan', parent_payment_id: null, order_id: null, payment_status: 'finished', actually_paid: 0.5, pay_currency: 'sol' };
    assert.equal((await deliverNow(orphan)).status, 200, 'nothing here gets better by making the provider retry');
    assert.equal(discord.channelPosts.length, pings0 + 1, 'it is visible where a seller actually looks');
    const embed = discord.channelPosts.at(-1).body.embeds[0];
    assert.match(embed.title, /matches no order/i);
    assert.ok(embed.description.includes('npid_orphan'), 'the id to look up');
    assert.match(embed.description, /deposit address/, 'and where the answer lives');
    assert.equal((await deliverNow(orphan)).status, 200);
    assert.equal(discord.channelPosts.length, pings0 + 1, 'once, however many deliveries arrive');

    // A parent id we can ask about and the provider 404s: unattributable, and
    // it must not become an endless retry either.
    nowpayments.payments.set('npid_orphan2', {
      payment_id: 'npid_orphan2', parent_payment_id: 'npid_never_existed', payment_status: 'finished',
      order_id: null, price_currency: 'usd', pay_currency: 'sol', actually_paid: 0.25, actually_paid_at_fiat: 0,
    });
    assert.equal((await deliverNow({ payment_id: 'npid_orphan2', parent_payment_id: 'npid_never_existed', order_id: null, payment_status: 'finished' })).status, 200);
    assert.equal(discord.channelPosts.length, pings0 + 2);
    assert.ok(discord.channelPosts.at(-1).body.embeds[0].description.includes('npid_orphan2'));
  } finally {
    await tq('UPDATE stores SET notify_channel_id = ? WHERE id = ?', [row.notify_channel_id ?? null, row.id]);
  }
});

test('crypto: `cancelled` is a status the provider really sends, and it ends the payment', async () => {
  // Not in the API reference's list of nine. The provider's status article
  // has it — a merchant can mark a partially_paid payment cancelled so the
  // buyer gets in touch — and their Node SDK maps both spellings. Treated as
  // an unknown status it was the one dead payment whose screen kept saying
  // "Checking on this payment…", and whose seat the backfill never released.
  const { describeStatus, DEAD } = await import('../src/lib/nowpayments.js');
  assert.equal(describeStatus({ payment_status: 'cancelled' }).state, 'dead');
  assert.ok(DEAD.has('canceled'), 'the provider spells it both ways');

  const plans = await (await fetch(`${appUrl}/api/plans?store=vip-signals`)).json();
  const { order, payment } = await npCheckout(plans.plans[0].id);
  payment.payment_status = 'cancelled';
  assert.equal((await deliverNow({ payment_id: payment.payment_id, payment_status: 'cancelled', order_id: order.orderId })).status, 200);
  await waitFor('the cancelled payment to be logged as ended', () =>
    appLog.join('').includes(`nowpayments ${payment.payment_id} (order ${order.orderId}) ended as cancelled`));
  assert.ok(
    !appLog.join('').includes(`nowpayments ${payment.payment_id} (order ${order.orderId}) has unrecognised status`),
    'a documented status is not an unknown one',
  );
  assert.equal(await subRow('nowpayments', payment.payment_id), null, 'a cancelled payment is not a sale');
  const view = await npView(order.orderId);
  assert.equal(view.state, 'dead');
  assert.match(view.message, /did not complete/);
});

test('crypto: money that lands for a product that cannot be delivered is never a completed sale', async () => {
  const post = (path, body, cookie = npCookie) =>
    fetch(`${appUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ store: 'vip-signals', ...body }) });
  const owned = await (await fetch(`${appUrl}/api/admin/payments`, { headers: { cookie: npCookie } })).json();
  const storeId = owned.stores.find((s) => s.slug === 'vip-signals').id;
  const product = async (name) => {
    const plan = JSON.parse(await (await post('/api/onboard', { step: 'product', storeId, name, priceUsd: 20, lifetime: true })).text()).plan;
    assert.equal((await post('/api/onboard', { step: 'role', storeId, planKey: plan.planKey, roleId: R2_VIP })).status, 200);
    return plan;
  };
  const finish = async ({ order, payment }) => {
    payment.payment_status = 'finished';
    payment.actually_paid = payment.pay_amount;
    payment.actually_paid_at_fiat = payment.price_amount;
    assert.equal((await deliverNow({ payment_id: payment.payment_id, payment_status: 'finished', order_id: order.orderId })).status, 200);
  };
  const undelivered = async ({ order, payment }, why, pings0, cookie = npBuyerCookie) => {
    assert.equal(await subRow('nowpayments', payment.payment_id), null, 'nothing may be granted');
    assert.equal(await npAttemptStatus(order.orderId), 'undelivered', '"completed" means the buyer got what they paid for; this order is closed, not open');
    assert.equal(discord.channelPosts.length, pings0 + 1, 'exactly one post: the alert, never a sale ping');
    const embed = discord.channelPosts.at(-1).body.embeds[0];
    assert.match(embed.title, /nothing was delivered/i);
    assert.doesNotMatch(embed.title, /New Subscriber/);
    assert.match(embed.description, why);
    assert.match(embed.description, /SOL/, 'the seller is told which coin to refund');
    // The buyer is not told "confirmed" and bounced to a receipt that will
    // never fill: the money is in, the product is not.
    const view = await npView(order.orderId, cookie);
    assert.equal(view.state, 'pending', JSON.stringify(view));
    assert.match(view.message, /checking on delivery/i);
  };

  // 1. Switched off while the invoice was open. The checkout-time answer is
  //    stale, and the guard is asked again at settlement.
  const dark = await product('Switched Off');
  const a = await npCheckout(dark.planKey);
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: dark.planKey, active: false })).status, 200);
  let pings0 = discord.channelPosts.length;
  await finish(a);
  await undelivered(a, /not for sale/, pings0);

  // 2. Deleted after the provider closed the invoice — the delete waits for
  //    OPEN checkouts (an invoice holds the product for its whole life), but
  //    coins sent to a closed invoice can still be credited, and then pay.
  const ghost = await product('Ghost');
  const g = await npCheckout(ghost.planKey);
  await tq('UPDATE checkout_attempts SET created_at = created_at - 7200, expires_at = created_at - 3600 WHERE session_id = ?', [g.order.orderId]);
  assert.equal((await post('/api/onboard', { step: 'product-delete', storeId, planKey: ghost.planKey })).status, 200);
  pings0 = discord.channelPosts.length;
  await finish(g);
  await undelivered(g, /no longer in this store/, pings0);

  // 3. One seat, two invoices. An open invoice reserves its seat at checkout,
  //    so the second invoice can only exist if the cap arrived after it: the
  //    seller limits the product to one seat while both are open. The first
  //    to pay is granted…
  const seat = await product('Last Seat');
  const first = await npCheckout(seat.planKey);
  const LATE = '532300000000000034'; // its own id: 5322…32 is the kicked-bot scenario's KB, whose live sub would re-grant the role on login
  discord.members.set(LATE, new Set());
  const lateCookie = await signInAs('code_late_seat', LATE, 'late_seat');
  const second = await npCheckout(seat.planKey, lateCookie);
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: seat.planKey, purchaseLimit: 1 })).status, 200);
  pings0 = discord.channelPosts.length;
  await finish(first);
  await waitFor('the first seat to land', async () => (await subRow('nowpayments', first.payment.payment_id)) !== null);
  assert.equal(await npAttemptStatus(first.order.orderId), 'completed');
  assert.equal(discord.channelPosts.length, pings0 + 1);
  assert.match(discord.channelPosts.at(-1).body.embeds[0].title, /New Subscriber/);
  assert.equal((await npView(first.order.orderId)).state, 'paid', 'delivered, so the screen may say so');
  // …and the second, paying after the seat is gone, is not.
  pings0 = discord.channelPosts.length;
  await finish(second);
  await undelivered(second, /sold out/, pings0, lateCookie);
  assert.ok(!memberRoles(LATE).has(R2_VIP), 'the role is the product, and it was not for sale');
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: seat.planKey, purchaseLimit: null })).status, 200);

  // 4. And the answer is given ONCE. Left open, this order was re-settled by
  //    every IPN replay past the claim window and by every hourly cron for
  //    the whole seven-day backfill window: the same red embed to the seller
  //    each time (~168 of them), counted as a `recovered` sale each time, and
  //    — the expensive part — granted the moment the block happened to clear,
  //    which is after the seller has read "refund them from your wallet" and
  //    done it. Closing the order is what stops all three.
  pings0 = discord.channelPosts.length;
  await tq("UPDATE webhook_events SET received_at = received_at - 900 WHERE event_id = ?", [`nowpayments:${a.payment.payment_id}:finished`]);
  const replay = await deliverNow({ payment_id: a.payment.payment_id, payment_status: 'finished', order_id: a.order.orderId });
  assert.deepEqual([replay.status, replay.body], [200, 'ok'], 'the money is settled and the order closed — nothing for the provider to retry');
  assert.equal(discord.channelPosts.length, pings0, 'no second alert for the same undelivered payment');
  await tq('UPDATE checkout_attempts SET created_at = created_at - 7200 WHERE session_id = ?', [a.order.orderId]);
  for (const pass of [1, 2]) {
    await tq('UPDATE webhook_events SET received_at = received_at - 3600 WHERE event_id = ?', [`nowpayments:${a.payment.payment_id}:finished`]);
    const cron = JSON.parse((await hitCron()).body);
    assert.equal(cron.cryptoBackfill?.recovered, 0, `pass ${pass}: an undelivered order is not a recovered sale`);
    assert.equal(discord.channelPosts.length, pings0, `pass ${pass}: the cron re-alerts nobody`);
  }
  // The seller fixes the cause. The money still does not deliver itself —
  // they were told to refund it, and undoing that is their call, from
  // Members, not something an hourly job decides for them.
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: dark.planKey, active: true })).status, 200);
  await tq('UPDATE webhook_events SET received_at = received_at - 3600 WHERE event_id = ?', [`nowpayments:${a.payment.payment_id}:finished`]);
  assert.equal(JSON.parse((await hitCron()).body).cryptoBackfill?.recovered, 0, 'a re-enabled product does not resurrect a refunded sale');
  // Nor does a replayed IPN, which is the other way in: NOWPayments' delivery
  // carries no timestamp, so a captured one can arrive at any point.
  await tq('UPDATE webhook_events SET received_at = received_at - 3600 WHERE event_id = ?', [`nowpayments:${a.payment.payment_id}:finished`]);
  const late = await deliverNow({ payment_id: a.payment.payment_id, payment_status: 'finished', order_id: a.order.orderId });
  assert.deepEqual([late.status, late.body], [200, 'ok']);
  assert.equal(await subRow('nowpayments', a.payment.payment_id), null);
  assert.equal(await npAttemptStatus(a.order.orderId), 'undelivered');
  assert.equal(discord.channelPosts.length, pings0);
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: dark.planKey, active: false })).status, 200);
});

test('crypto: Discord failing to answer at settlement is a retry, never "they left — refund them"', async () => {
  // The one guard that asks Discord anything: a role-gated product. At
  // checkout, folding an error into "not a member" is right — nothing has
  // been paid. At settlement the coins are already in the seller's wallet,
  // and the alert says the sale is not allowed and to refund it, word for
  // word what a real departure produces. A seller cannot tell those apart,
  // and acting on the wrong one costs them the refund AND the sale, because
  // the next cron delivers the role anyway.
  const post = (path, body, cookie = npCookie) =>
    fetch(`${appUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ store: 'vip-signals', ...body }) });
  const storeId = await npStoreId();
  const plan = JSON.parse(await (await post('/api/onboard', { step: 'product', storeId, name: 'Gate Retry', priceUsd: 25, lifetime: true })).text()).plan;
  assert.equal((await post('/api/onboard', { step: 'role', storeId, planKey: plan.planKey, roleId: R2_VIP })).status, 200);
  assert.equal((await post('/api/onboard', { step: 'product-update', storeId, planKey: plan.planKey, requiredRoleId: R2_VIP })).status, 200);
  const GB = '534400000000000035';
  discord.members.set(GB, new Set());
  // The gate role goes on AFTER the login: signing in reconciles, and a
  // managed role nobody has bought yet is taken back off.
  const gbCookie = await signInAs('code_gate_retry', GB, 'gate_retry');
  discord.members.get(GB).add(R2_VIP);
  const { order, payment } = await npCheckout(plan.planKey, gbCookie);
  payment.payment_status = 'finished';
  payment.actually_paid = payment.pay_amount;
  payment.actually_paid_at_fiat = payment.price_amount;

  const pings0 = discord.channelPosts.length;
  discord.failMemberGetsFor.add(GB);
  const down = await deliverNow({ payment_id: payment.payment_id, payment_status: 'finished', order_id: order.orderId });
  assert.equal(down.status, 500, 'a delivery nothing could decide must come back, not be acknowledged');
  assert.equal(discord.channelPosts.length, pings0, 'no alert: nobody knows yet whether this sale is allowed');
  assert.equal(await npAttemptStatus(order.orderId), 'started', 'and the order stays open for the retry');
  assert.deepEqual(await claimRows(`nowpayments:${payment.payment_id}:%`), [], 'the claim is released, so the retry is not answered "in progress"');

  // Discord comes back; the provider's retry delivers the sale once.
  discord.failMemberGetsFor.delete(GB);
  const back = await deliverNow({ payment_id: payment.payment_id, payment_status: 'finished', order_id: order.orderId });
  assert.deepEqual([back.status, back.body], [200, 'ok']);
  assert.equal(await npAttemptStatus(order.orderId), 'completed');
  assert.ok((await subRow('nowpayments', payment.payment_id)) !== null, 'the valid sale lands');
  assert.equal(discord.channelPosts.length, pings0 + 1);
  assert.match(discord.channelPosts.at(-1).body.embeds[0].title, /New Subscriber/);
});

test('crypto backfill: orders the provider never advances take their turn instead of holding the queue', async () => {
  // The batch is capped at 20 and used to be the OLDEST open orders, every
  // run. An underpayment stays `partially_paid` until it ages out, so twenty
  // of them — common on-chain — pinned the batch for a week and the lost
  // sale this backstop exists for was never looked at. Least-recently-asked
  // ordering is what keeps the queue moving.
  const storeId = await npStoreId();
  const made = JSON.parse(await (await fetch(`${appUrl}/api/onboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: npCookie },
    body: JSON.stringify({ store: 'vip-signals', step: 'product', storeId, name: 'Queue Order', priceUsd: 30, lifetime: true }),
  })).text()).plan;
  const plan = { id: made.planKey, priceUsd: 30 };
  const SHORTY = '535500000000000036';
  const LOST2 = '535500000000000037';
  for (let i = 0; i < 20; i += 1) {
    await npOpenOrder({ storeId, plan, uid: SHORTY, orderId: `np_${'e'.repeat(30)}${String(i).padStart(2, '0')}`, ref: `npid_short_${i}`, status: 'partially_paid', age: 10800 + i });
  }
  const O_LOST2 = `np_${'f'.repeat(32)}`;
  await npOpenOrder({ storeId, plan, uid: LOST2, orderId: O_LOST2, ref: 'npid_lost2', status: 'finished', age: 7200 });
  // Two runs: the first clears the twenty older short rows, the second must
  // reach the newer finished one. Before, every run re-asked the same twenty.
  let recovered = 0;
  for (const _ of [1, 2]) recovered += JSON.parse((await hitCron()).body).cryptoBackfill?.recovered ?? 0;
  assert.equal(recovered, 1, 'the lost sale is recovered within a run or two, not after the shorts age out');
  assert.equal(await attemptStatus(O_LOST2), 'completed');
  assert.ok((await subRow('nowpayments', 'npid_lost2')) !== null, 'the sale that was starved is delivered');
  // The short rows are left open on purpose — the buyer can still top them
  // up — but they no longer come first for ever.
  assert.equal(await attemptStatus(`np_${'e'.repeat(30)}00`), 'started');
  for (let i = 0; i < 20; i += 1) await tq("UPDATE checkout_attempts SET status = 'expired' WHERE session_id = ?", [`np_${'e'.repeat(30)}${String(i).padStart(2, '0')}`]);
});

// ── welcome cards: the doctor's arithmetic ───────────────────────────────────
// Welcome cards are posted by scripts/presence.js, a gateway worker this suite
// cannot reach: it needs a socket and a real bot token. What it CAN hold is the
// part that decides whether the owner gets told the truth — the permission
// arithmetic `npm run doctor:welcome` reports, which is pure, and the manifest
// promise the worker image depends on.

test('doctor:welcome computes channel permissions the way Discord does', async () => {
  const { computePermissions, missingPermissions, membersIntentEnabled, verdictLines, NEEDED } = await import(
    '../scripts/welcome-doctor.mjs'
  );
  const GUILD = '4242';
  const BOT = '9001';
  const BOTS_ROLE = '7001';
  const ALL_FOUR = Object.values(NEEDED).reduce((a, b) => a | b, 0n);
  const VIEW = NEEDED['View Channel'];
  const ATTACH = NEEDED['Attach Files'];
  const base = {
    guildId: GUILD,
    botId: BOT,
    ownerId: '1',
    roles: [
      { id: GUILD, permissions: String(ALL_FOUR) }, // @everyone's role id IS the guild id
      { id: BOTS_ROLE, permissions: '0' },
    ],
    memberRoleIds: [BOTS_ROLE],
  };

  assert.deepEqual(missingPermissions(computePermissions(base)), [], 'inherits @everyone with no overwrites');

  // The classic: someone locks #welcome down to read-only for @everyone. The
  // bot loses Send Messages with it, and the card is refused with a 403 that
  // says nothing about which bit is missing.
  assert.deepEqual(
    missingPermissions(
      computePermissions({ ...base, overwrites: [{ id: GUILD, type: 0, allow: '0', deny: String(NEEDED['Send Messages']) }] }),
    ),
    ['Send Messages'],
  );

  // A role allow must beat the @everyone deny — that is how a locked channel is
  // opened to one bot, and reporting it as still-denied would send the owner
  // hunting for a problem that is not there.
  assert.deepEqual(
    missingPermissions(
      computePermissions({
        ...base,
        overwrites: [
          { id: GUILD, type: 0, allow: '0', deny: String(ALL_FOUR) },
          { id: BOTS_ROLE, type: 0, allow: String(ALL_FOUR), deny: '0' },
        ],
      }),
    ),
    [],
  );

  // Role overwrites are unioned first and the union of allows is applied AFTER
  // the union of denies, so one role allowing Attach Files beats another role
  // denying it. Subtracting per role in sequence would report the opposite and
  // send the owner editing a channel that is already correct.
  const twoRoles = {
    ...base,
    memberRoleIds: [BOTS_ROLE, '7002'],
    roles: [...base.roles, { id: '7002', permissions: '0' }],
  };
  assert.deepEqual(
    missingPermissions(
      computePermissions({
        ...twoRoles,
        overwrites: [
          { id: BOTS_ROLE, type: 0, allow: String(ALL_FOUR), deny: '0' },
          { id: '7002', type: 0, allow: '0', deny: String(ATTACH) },
        ],
      }),
    ),
    [],
  );
  // With nothing allowing it back, the same deny does take the bit away.
  assert.deepEqual(
    missingPermissions(
      computePermissions({ ...twoRoles, overwrites: [{ id: '7002', type: 0, allow: '0', deny: String(ATTACH) }] }),
    ),
    ['Attach Files'],
  );

  // A member-level overwrite on the bot itself is applied last and wins.
  assert.deepEqual(
    missingPermissions(
      computePermissions({
        ...base,
        overwrites: [
          { id: GUILD, type: 0, allow: '0', deny: String(ALL_FOUR) },
          { id: BOT, type: 1, allow: String(ALL_FOUR), deny: '0' },
        ],
      }),
    ),
    [],
  );
  assert.deepEqual(
    missingPermissions(
      computePermissions({
        ...base,
        overwrites: [{ id: BOT, type: 1, allow: '0', deny: String(VIEW) }],
      }),
    ),
    ['View Channel'],
  );

  // Administrator ignores every overwrite, including a deny aimed at the bot.
  assert.deepEqual(
    missingPermissions(
      computePermissions({
        ...base,
        roles: [{ id: GUILD, permissions: '0' }, { id: BOTS_ROLE, permissions: String(1n << 3n) }],
        overwrites: [{ id: BOT, type: 1, allow: '0', deny: String(ALL_FOUR) }],
      }),
    ),
    [],
  );

  // The intent bit: either GATEWAY_GUILD_MEMBERS (verified app) or its LIMITED
  // twin (under 100 servers) means the portal toggle is on. Neither means the
  // gateway closes the worker with 4014 and no card is ever posted.
  assert.equal(membersIntentEnabled(0), false);
  assert.equal(membersIntentEnabled(1 << 14), true);
  assert.equal(membersIntentEnabled(1 << 15), true);
  assert.equal(membersIntentEnabled((1 << 13) | (1 << 18)), false, 'presence and message-content bits are not this one');

  // Every failing verdict carries its fix, indented under the line, or the
  // report is a list of complaints with no instructions.
  const lines = verdictLines({ n: 3, status: 'FAIL', title: 'Server Members intent is enabled', detail: 'OFF', fix: 'fix  flip it\nin the portal' });
  assert.match(lines[0], /^ 3\. FAIL {2}Server Members intent is enabled — OFF$/);
  assert.deepEqual(lines.slice(1), ['         fix  flip it', '         in the portal']);
});

test('the worker image gets the card renderer: sharp is a runtime dependency', async () => {
  // Dockerfile.presence installs with --omit=dev, so a devDependency is simply
  // absent in the deployed worker. renderWelcomeCard imports sharp, and with it
  // missing every join throws "Cannot find package 'sharp'" — cards stop, and
  // nothing else does, which is exactly how this went unnoticed once.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(manifest.dependencies?.sharp, 'sharp must be in dependencies, not devDependencies');
  assert.ok(!manifest.devDependencies?.sharp, 'and only there, so --omit=dev cannot drop it');
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile.presence'), 'utf8');
  assert.match(dockerfile, /--omit=dev/, 'the assumption above still holds for the worker image');
});

// ═══ runner ═══════════════════════════════════════════════════════════════════

// ── session revocation ────────────────────────────────────────────────────────
// A stateless 7-day cookie has no off switch by itself: a stolen laptop stays
// signed in until it expires and "Sign out" only clears one browser. Every
// cookie now carries the account's session generation; "Log out everywhere"
// bumps it and anything issued before is refused. Cookies minted before
// generations existed carry none: a deploy must not sign everyone out, so
// they count as generation 0 (what every account starts at) — valid until the
// account revokes, and dead the moment it does. A permanent exemption would
// spare exactly the stolen-before-deploy device the button exists for.
test('session revocation: log out everywhere kills every cookie, a fresh login works, pre-generation cookies die with it', async () => {
  const UID = '516000000000000016';
  const meWith = async (cookie) => (await (await fetch(`${appUrl}/api/me`, { headers: { cookie } })).json()).loggedIn;
  const logoutAll = (headers, body = '{}') => fetch(`${appUrl}/api/auth/logout-all`, { method: 'POST', headers, body });
  // The same shape as src/lib/session.js, so the suite can mint a cookie of
  // any vintage: no generation at all, or a deliberately stale one.
  const mint = (payload) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', 'e2e-session-secret-0123456789-abcdef').update(body).digest('base64url');
    return `tl_session=${body}.${mac}`;
  };
  const exp = nowSec() + 3600;

  const laptop = await signInAs('code_u16', UID, 'revoker');
  const phone = await signInAs('code_u16', UID, 'revoker');
  assert.equal(await meWith(laptop), true);
  assert.equal(await meWith(phone), true);
  const issued = JSON.parse(Buffer.from(laptop.split('=')[1].split('.')[0], 'base64url').toString('utf8'));
  assert.equal(typeof issued.gen, 'number', 'a login cookie carries the session generation');
  // Deploy safety: a cookie minted before generations existed still works for
  // an account that has never revoked, so shipping this signs nobody out.
  assert.equal(await meWith(mint({ uid: UID, exp })), true, 'a pre-generation cookie is still good until the account revokes');

  // CSRF shape: a same-origin JSON POST from a signed-in browser, nothing else.
  assert.equal((await fetch(`${appUrl}/api/auth/logout-all`, { headers: { cookie: laptop } })).status, 405, 'GET never revokes');
  assert.equal((await logoutAll({ cookie: laptop, 'content-type': 'application/x-www-form-urlencoded' }, 'x=1')).status, 415, 'a cross-site form post is refused');
  assert.equal((await logoutAll({ 'content-type': 'application/json' })).status, 401, 'no session, nothing to revoke');
  assert.equal(await meWith(laptop), true, 'refused calls revoke nothing');

  const out = await logoutAll({ cookie: phone, 'content-type': 'application/json' });
  assert.equal(out.status, 200);
  assert.ok(out.headers.getSetCookie().some((c) => /^tl_session=;/.test(c) && /Max-Age=0/.test(c)), 'the revoking browser is signed out in the reply');
  assert.equal(await meWith(laptop), false, 'the other device is signed out');
  assert.equal(await meWith(phone), false, 'the revoking device is signed out');
  assert.equal((await fetch(`${appUrl}/api/my/guilds`, { headers: { cookie: laptop } })).status, 401, 'a revoked cookie fails closed');
  assert.equal((await logoutAll({ cookie: laptop, 'content-type': 'application/json' })).status, 401, 'a revoked cookie cannot revoke again');

  const again = await signInAs('code_u16', UID, 'revoker');
  assert.equal(await meWith(again), true, 'a fresh login is issued under the new generation');
  assert.equal(await meWith(laptop), false, 'the fresh login does not resurrect the old cookie');
  const reissued = JSON.parse(Buffer.from(again.split('=')[1].split('.')[0], 'base64url').toString('utf8'));
  assert.ok(reissued.gen > issued.gen, 'the generation moved forward');

  // Legacy cookie: same user, valid signature, no generation field. It read as
  // generation 0 above; the revoke moved the account past 0, so it is gone —
  // and it cannot revoke on its own behalf either.
  assert.equal(await meWith(mint({ uid: UID, exp })), false, 'a pre-generation cookie is refused once the account has logged out everywhere');
  assert.equal((await logoutAll({ cookie: mint({ uid: UID, exp }), 'content-type': 'application/json' })).status, 401, 'and it cannot act');
  assert.equal(await meWith(mint({ uid: UID, exp, gen: issued.gen })), false, 'a stale generation is refused even with a valid signature');
  assert.equal(await meWith(mint({ uid: UID, exp, gen: reissued.gen })), true, 'the current generation is accepted');
  assert.equal(await meWith(mint({ uid: UID, exp, gen: String(reissued.gen) })), false, 'a generation that is not a number fails closed');
  assert.equal(await meWith(mint({ uid: '516000000000000099', exp, gen: 0 })), false, 'a generation cookie for an account that never signed in fails closed');
});

// The generation is cached per process for a minute to keep reads off the DB,
// and in production every api/*.js is its OWN process — so a revoke run by the
// logout-all function is invisible to every other endpoint until its entry
// ages out. Reads may live with that lag. Writes may not: api/admin/store.js
// (and api/onboard.js) rotate the store's Stripe key and hand the CALLER a
// replacement cookie carrying the new generation, so a cached check there let
// the holder of a revoked cookie mint themselves seven fresh days, lock the
// seller out of their own account, and point the store's payouts at their key.
test('session revocation: a revoke on another instance stops writes here at once, not in a minute', async () => {
  const UID = '516000000000000017';
  const meWith = async (cookie) => (await (await fetch(`${appUrl}/api/me`, { headers: { cookie } })).json()).loggedIn;
  const cookie = await signInAs('code_u17', UID, 'rotator');
  assert.equal(await meWith(cookie), true, 'this read warms the instance cache with the current generation');

  // A "log out everywhere" served by another instance: the row moves, this
  // process's cache does not. Written straight to the DB, which is exactly
  // what the other process's bump looks like from here.
  await tq('UPDATE users SET session_gen = session_gen + 1 WHERE discord_id = ?', [UID]);
  assert.equal(await meWith(cookie), true, 'a read may still trust the cached generation for up to a minute');

  const rotate = await fetch(`${appUrl}/api/admin/store`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ store: 'no-such-store', stripeKey: 'sk_test_attacker_key' }),
  });
  // 404 would mean the revoked cookie got past the door and was only stopped
  // by the store lookup.
  assert.equal(rotate.status, 401, 'a mutating admin call re-reads the generation and refuses the revoked cookie');
  assert.deepEqual(rotate.headers.getSetCookie().filter((c) => c.startsWith('tl_session=')), [], 'and mints no replacement cookie');
  assert.equal((await fetch(`${appUrl}/api/auth/logout-all`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' })).status, 401, 'nor can it revoke again from a stale cache');
});

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
    COINBASE_RELEASED: '1', // the suite exercises the legacy rail; production does not carry this
    NOWPAYMENTS_API_KEY: NOW_KEY,
    NOWPAYMENTS_IPN_SECRET: NOW_IPN_SECRET,
    NOWPAYMENTS_API_BASE: nowMock.url,
    // The rail is release-gated in src/config.js; the suite exercises it, so
    // the suite releases it. Production does not carry this variable.
    NOWPAYMENTS_RELEASED: '1',
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

  // Phase 3: PRODUCTION's shape — NOWPayments credentials present, the release
  // flag absent. The gate, not the credentials, must keep the rail off, and the
  // provider must never be called. This is the one configuration the
  // production safety property rests on, and the only one in which the gated
  // expression and its credential-only twin would differ.
  if (!failed) {
    const heldDb = path.join(path.dirname(dbPath), 'held.sqlite');
    const before = nowpayments.requests ?? 0;
    const held = await spawnApp({
      ...baseEnv(mocks),
      ...(PG_URL ? {} : { DB_PATH: heldDb }),
      ...(PG_URL ? { DATABASE_URL: PG_URL } : {}),
      NOWPAYMENTS_API_KEY: NOW_KEY,
      NOWPAYMENTS_IPN_SECRET: NOW_IPN_SECRET,
      NOWPAYMENTS_API_BASE: nowMock.url,
    });
    try {
      const { capabilities } = await (await fetch(`${held.url}/api/plans`)).json();
      assert.equal(capabilities.nowpayments, false, 'credentials alone must not switch the rail on');
      assert.equal((await fetch(`${held.url}/api/checkout/crypto?coins=1&store=tradeleaks`)).status, 501, 'the crypto checkout stays dormant behind the gate');
      assert.equal((await deliverNow({ payment_id: 'npid_held', payment_status: 'finished' }, { base: held.url })).status, 501, 'a correctly signed IPN is refused while the gate is closed');
      assert.equal(nowpayments.requests ?? 0, before, 'the provider was never called');
      console.log('  ✓ release gate: NOWPayments credentials present, flag absent — rail off, provider never called');
    } catch (err) {
      failed++;
      console.error(`  ✗ release gate\n    ${String(err.stack ?? err).split('\n').join('\n    ')}`);
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
