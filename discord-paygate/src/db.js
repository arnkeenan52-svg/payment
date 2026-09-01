// Thin storage adapter. Postgres (pg + DATABASE_URL) in production/Vercel,
// node:sqlite locally and in the e2e suite. Everything above this module is
// dialect-blind: same async function surface, same schema, same semantics.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Schema is identical across dialects; only the id autoincrement spelling and
// the integer width differ. current_period_end IS NULL means LIFETIME and
// nothing else; every non-lifetime grant carries a concrete expiry.
const ddl = (dialect) => {
  const id = dialect === 'pg' ? 'id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY' : 'id INTEGER PRIMARY KEY AUTOINCREMENT';
  const int = dialect === 'pg' ? 'BIGINT' : 'INTEGER';
  return `
  CREATE TABLE IF NOT EXISTS users (
    discord_id    TEXT PRIMARY KEY,
    username      TEXT,
    access_token  TEXT,
    refresh_token TEXT,
    created_at    ${int} NOT NULL,
    updated_at    ${int} NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    ${id},
    store_id      ${int},               -- NULL = the built-in default store
    discord_id    TEXT NOT NULL,
    plan_id       TEXT NOT NULL,
    provider      TEXT NOT NULL,
    provider_ref  TEXT NOT NULL,
    status        TEXT NOT NULL,
    currency      TEXT NOT NULL DEFAULT 'usd',
    current_period_end ${int},
    grace_until   ${int},
    cancels_at    ${int},               -- set when the buyer cancels; access runs to here
    created_at    ${int} NOT NULL,
    updated_at    ${int} NOT NULL,
    UNIQUE (provider, provider_ref)
  );
  CREATE INDEX IF NOT EXISTS idx_subscriptions_member ON subscriptions (discord_id);

  -- Owner-picked role mapping per plan (set from the dashboard). Overrides the
  -- roleIds/roleNames shipped in plans.json — the deployed filesystem is
  -- read-only, so runtime plan-config edits live here.
  CREATE TABLE IF NOT EXISTS plan_overrides (
    plan_id    TEXT PRIMARY KEY,
    role_ids   TEXT NOT NULL,               -- JSON array of role snowflakes
    role_names TEXT NOT NULL,               -- JSON array of display names
    updated_at ${int} NOT NULL
  );

  -- Multi-tenant stores: any Discord server owner can run a storefront.
  -- stripe_secret_enc is AES-GCM-sealed (src/lib/secretbox.js); NULL means
  -- "use the platform env configuration" (the built-in default store).
  CREATE TABLE IF NOT EXISTS stores (
    ${id},
    slug             TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,
    description      TEXT,
    banner_url       TEXT,
    owner_discord_id TEXT NOT NULL,
    guild_id         TEXT NOT NULL UNIQUE,
    stripe_secret_enc     TEXT,
    stripe_webhook_secret TEXT,
    notify_channel_id TEXT,
    theme            TEXT,               -- JSON of validated storefront design tokens
    discoverable     ${int} NOT NULL DEFAULT 0,  -- owner opted in to /discover
    currency         TEXT NOT NULL DEFAULT 'usd',  -- what this store prices in
    crypto_wallet    TEXT,               -- seller's own payout address (never Dues')
    crypto_chain     TEXT,               -- which network that address is on
    category         TEXT,               -- one of the fixed discover categories
    status           TEXT NOT NULL DEFAULT 'draft',
    created_at       ${int} NOT NULL,
    updated_at       ${int} NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_stores_owner ON stores (owner_discord_id);

  -- Products of a store (the default store's products live in plans.json).
  -- Every checkout the buyer actually reached Stripe with, completed or not.
  -- Subscriptions only exist once money moved, so without this an owner cannot
  -- tell "nobody is interested" from "everybody bails at the card form".
  CREATE TABLE IF NOT EXISTS checkout_attempts (
    ${id},
    store_id      ${int},               -- NULL = the built-in default store
    plan_id       TEXT NOT NULL,
    discord_id    TEXT NOT NULL,
    session_id    TEXT NOT NULL,        -- Stripe cs_… ; the completion webhook matches on it
    amount_usd    REAL NOT NULL DEFAULT 0,   -- denominated in the currency column, not always USD
    currency      TEXT NOT NULL DEFAULT 'usd',
    discount_code TEXT,
    provider_ref  TEXT,                 -- crypto: the NOWPayments payment id
    status        TEXT NOT NULL,        -- 'started' | 'completed'
    created_at    ${int} NOT NULL,
    completed_at  ${int},
    UNIQUE (session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_checkout_attempts_store ON checkout_attempts (store_id, created_at);

  CREATE TABLE IF NOT EXISTS store_plans (
    ${id},
    store_id        ${int} NOT NULL,
    plan_key        TEXT NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT,
    image_url       TEXT,
    price_usd       REAL NOT NULL,           -- denominated in the currency column, not always USD
    currency        TEXT NOT NULL DEFAULT 'usd',
    lifetime        ${int} NOT NULL DEFAULT 1,
    duration_days   ${int},
    stripe_price_id TEXT,
    role_ids        TEXT NOT NULL DEFAULT '[]',
    role_names      TEXT NOT NULL DEFAULT '[]',
    active          ${int} NOT NULL DEFAULT 1,
    purchase_limit  ${int},
    success_url     TEXT,
    image_data      TEXT,
    created_at      ${int} NOT NULL,
    UNIQUE (store_id, plan_key)
  );

  -- Uploaded store-level media (currently one row: kind 'banner'), held as a
  -- data URL. A separate table rather than a column on stores because every
  -- store read is SELECT * and allStores() feeds the public /discover
  -- directory — a multi-megabyte TEXT column would ride along on all of them.
  CREATE TABLE IF NOT EXISTS store_media (
    store_id   ${int} NOT NULL,
    kind       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    data       TEXT NOT NULL,
    updated_at ${int} NOT NULL,
    PRIMARY KEY (store_id, kind)
  );

  -- One row per (store, follower). store_id is NOT NULL on purpose: elsewhere
  -- in this schema NULL means "the built-in store", but NULL is DISTINCT from
  -- NULL inside a UNIQUE constraint in both SQLite and Postgres, which would
  -- silently break the idempotency this constraint IS. The built-in and demo
  -- stores are simply not followable. Only the COUNT of these rows is ever
  -- public — who follows a store never leaves this table.
  CREATE TABLE IF NOT EXISTS store_follows (
    ${id},
    store_id            ${int} NOT NULL,
    follower_discord_id TEXT NOT NULL,
    created_at          ${int} NOT NULL,
    UNIQUE (store_id, follower_discord_id)
  );
  CREATE INDEX IF NOT EXISTS idx_store_follows_follower ON store_follows (follower_discord_id);

  -- One review per (store, buyer), and only from an account the payments
  -- ledger proves paid this store. store_id is NOT NULL for exactly the
  -- reason store_follows is: NULL is DISTINCT from NULL inside a UNIQUE
  -- constraint on both dialects, which would silently break the
  -- one-review-per-buyer rule this constraint IS.
  --
  -- Nothing in here is ever seeded, sampled or generated. A store's rating is
  -- COUNT and mean over exactly these rows. status moves for one reason and a
  -- SELLER CANNOT REACH IT: the platform owner removing abuse. A seller who
  -- can subtract a row they dislike has authored the average, and an average
  -- a seller authored is not a rating.
  CREATE TABLE IF NOT EXISTS store_reviews (
    ${id},
    store_id          ${int} NOT NULL,
    author_discord_id TEXT NOT NULL,
    rating            ${int} NOT NULL CHECK (rating BETWEEN 1 AND 5),
    body              TEXT,                             -- NULL = stars only
    status            TEXT NOT NULL DEFAULT 'published', -- published | removed
    purchase_at       ${int} NOT NULL,   -- frozen: revoking access later must
                                         -- not unmake the purchase that earned
                                         -- the right to say something
    reply_body        TEXT,              -- the seller's public answer
    reply_at          ${int},
    created_at        ${int} NOT NULL,
    updated_at        ${int} NOT NULL,   -- > created_at means "edited"
    UNIQUE (store_id, author_discord_id)
  );
  CREATE INDEX IF NOT EXISTS idx_store_reviews_store ON store_reviews (store_id, status, id);
  CREATE INDEX IF NOT EXISTS idx_store_reviews_author ON store_reviews (author_discord_id);

  -- Discount codes, scoped per store and optionally per product. uses counts
  -- completed checkouts (incremented by the webhook, not at session time).
  CREATE TABLE IF NOT EXISTS discounts (
    ${id},
    store_id   ${int} NOT NULL,
    code       TEXT NOT NULL,
    kind       TEXT NOT NULL,             -- 'percent' | 'fixed'
    amount     REAL NOT NULL,             -- percent (1-100) or USD
    plan_key   TEXT,                      -- NULL = every product in the store
    max_uses   ${int},
    uses       ${int} NOT NULL DEFAULT 0,
    expires_at ${int},
    created_at ${int} NOT NULL,
    UNIQUE (store_id, code)
  );

  -- Small runtime key/value store. Holds the signing secret of the Stripe
  -- webhook endpoint the doctor registers automatically (the deployed
  -- filesystem and env are read-only at runtime), plus short-lived locks.
  CREATE TABLE IF NOT EXISTS app_secrets (
    name       TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at ${int} NOT NULL
  );

  -- Every role id the paygate has ever resolved as grantable (from plans.json,
  -- the picker override, or a name match). The reconciler removes only roles
  -- it manages, so this ledger keeps roles granted under an OLD mapping
  -- removable after renames, re-picks and redeploys change the mapping.
  CREATE TABLE IF NOT EXISTS managed_role_history (
    role_id     TEXT PRIMARY KEY,
    recorded_at ${int} NOT NULL
  );

  -- The Dues plan a store owner is on (platform billing). One row per
  -- owner: their paid tier covers every store they run. status active or
  -- past_due keeps the paid limits; anything else falls back to Free.
  CREATE TABLE IF NOT EXISTS platform_billing (
    owner_discord_id   TEXT PRIMARY KEY,
    tier               TEXT NOT NULL,
    provider_ref       TEXT,              -- Stripe subscription id
    status             TEXT NOT NULL,
    current_period_end ${int},
    updated_at         ${int} NOT NULL
  );

  -- Idempotency: the PRIMARY KEY *is* the claim. INSERT ... ON CONFLICT DO
  -- NOTHING and check the affected row count — first delivery wins at the
  -- constraint, not at a racy SELECT-then-INSERT. Claims are deleted again
  -- if the handler throws so the provider's retry gets a real second attempt.
  CREATE TABLE IF NOT EXISTS webhook_events (
    event_id    TEXT PRIMARY KEY,
    provider    TEXT NOT NULL,
    received_at ${int} NOT NULL
  );
`;
};

async function createDriver() {
  if (config.databaseUrl) {
    const { default: pg } = await import('pg');
    // Serverless functions are single-request; keep the pool tiny and let the
    // platform's connection pooler (Neon/Supabase pgbouncer URL) do the rest.
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 3 });
    return {
      dialect: 'pg',
      async query(sql, params = []) {
        let i = 0;
        const text = sql.replace(/\?/g, () => `$${++i}`);
        const r = await pool.query(text, params);
        return { rows: r.rows, changes: r.rowCount ?? 0 };
      },
      async exec(sql) {
        await pool.query(sql);
      },
    };
  }

  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
  const sqlite = new DatabaseSync(config.dbPath);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA busy_timeout = 5000');
  return {
    dialect: 'sqlite',
    async query(sql, params = []) {
      const stmt = sqlite.prepare(sql);
      if (/^\s*select/i.test(sql)) return { rows: stmt.all(...params), changes: 0 };
      const info = stmt.run(...params);
      return { rows: [], changes: Number(info.changes) };
    },
    async exec(sql) {
      sqlite.exec(sql);
    },
  };
}

// Guarded lazy init: serverless has no boot step, so the first query of a
// cold start creates the driver and runs CREATE TABLE IF NOT EXISTS exactly
// once per instance (scripts/migrate.js does the same thing explicitly).
let driverPromise = null;

function db() {
  if (!driverPromise) {
    driverPromise = (async () => {
      const driver = await createDriver();
      await driver.exec(ddl(driver.dialect));
      // Databases created before multi-tenancy lack subscriptions.store_id —
      // add it in place (both dialects error harmlessly when it exists).
      const intType = driver.dialect === 'pg' ? 'BIGINT' : 'INTEGER';
      await driver.exec(`ALTER TABLE subscriptions ADD COLUMN store_id ${intType}`).catch(() => {});
      // Columns added after multi-tenancy shipped — same in-place pattern.
      await driver.exec('ALTER TABLE stores ADD COLUMN description TEXT').catch(() => {});
      await driver.exec('ALTER TABLE stores ADD COLUMN banner_url TEXT').catch(() => {});
      await driver.exec('ALTER TABLE stores ADD COLUMN notify_channel_id TEXT').catch(() => {});
      await driver.exec(`ALTER TABLE store_plans ADD COLUMN active ${intType} NOT NULL DEFAULT 1`).catch(() => {});
      await driver.exec(`ALTER TABLE store_plans ADD COLUMN purchase_limit ${intType}`).catch(() => {});
      await driver.exec('ALTER TABLE store_plans ADD COLUMN success_url TEXT').catch(() => {});
      // Uploaded product photos live in the database as data URLs (kept out
      // of list queries; served by /api/img with cache headers).
      await driver.exec('ALTER TABLE store_plans ADD COLUMN image_data TEXT').catch(() => {});
      // Buyer-initiated cancellation: the row stays active until this moment,
      // so /account can say "ends on …" instead of "renews on …".
      await driver.exec(`ALTER TABLE subscriptions ADD COLUMN cancels_at ${intType}`).catch(() => {});
      // What the buyer actually paid (post-discount) — display surfaces
      // prefer this over the plan's list price when present.
      await driver.exec('ALTER TABLE subscriptions ADD COLUMN paid_usd REAL').catch(() => {});
      // Store-page customization: long about text, social links (JSON of
      // known keys), and the opt-in live member-count badge.
      await driver.exec('ALTER TABLE stores ADD COLUMN about TEXT').catch(() => {});
      await driver.exec('ALTER TABLE stores ADD COLUMN links TEXT').catch(() => {});
      // Per-product custom link segment: dues.gg/<store>/<link>.
      await driver.exec('ALTER TABLE store_plans ADD COLUMN link_slug TEXT').catch(() => {});
      // Pricing options: a plan row whose variant_of names another plan_key in
      // the same store is one PRICE OPTION of that product (e.g. Monthly $50
      // under a Lifetime $500 product) — its own Stripe price and payments,
      // the parent's identity (name, photo, roles, page).
      await driver.exec('ALTER TABLE store_plans ADD COLUMN variant_of TEXT').catch(() => {});
      // Limited-time products: after expires_at (unix seconds) the product
      // stops being sold — hidden from the store, refused at checkout.
      // Buyers who already bought keep everything.
      await driver.exec(`ALTER TABLE store_plans ADD COLUMN expires_at ${intType}`).catch(() => {});
      // Gated products: only buyers already holding this Discord role in the
      // store's server may purchase (e.g. an upsell for @PREMIUM members).
      await driver.exec('ALTER TABLE store_plans ADD COLUMN required_role_id TEXT').catch(() => {});
      await driver.exec('ALTER TABLE store_plans ADD COLUMN required_role_name TEXT').catch(() => {});
      await driver.exec('ALTER TABLE stores ADD COLUMN dashboard_prefs TEXT').catch(() => {});
      await driver.exec(`ALTER TABLE stores ADD COLUMN show_members ${intType}`).catch(() => {});
      await driver.exec('ALTER TABLE stores ADD COLUMN theme TEXT').catch(() => {});
      await driver.exec(`ALTER TABLE stores ADD COLUMN discoverable ${intType} NOT NULL DEFAULT 0`).catch(() => {});
      await driver.exec('ALTER TABLE stores ADD COLUMN category TEXT').catch(() => {});
      // Reviews are per store and ALL-OR-NOTHING: on shows the average, the
      // count and every published review; off shows none of the three. The
      // seller flips this switch; the seller never touches which reviews it
      // contains. Default 0 — publishing strangers' opinions on someone's
      // business without asking them first is not a default we get to pick,
      // the same reasoning as `discoverable` above.
      await driver.exec(`ALTER TABLE stores ADD COLUMN reviews_on ${intType} NOT NULL DEFAULT 0`).catch(() => {});
      // Seller-authored identity: who is behind the store, and the people who
      // run it (JSON array, same storage idiom as `links`). Both are CLAIMS by
      // the seller about their own business, exactly like `about` — the
      // platform stores and renders them, and vouches for neither.
      await driver.exec('ALTER TABLE stores ADD COLUMN creator_name TEXT').catch(() => {});
      await driver.exec('ALTER TABLE stores ADD COLUMN team TEXT').catch(() => {});
      await driver.exec('ALTER TABLE stores ADD COLUMN team_heading TEXT').catch(() => {});
      // The currency the store prices in — one per store, because it has to be
      // a settlement currency of the seller's own Stripe account for Stripe to
      // convert anything for the buyer. Defaulting to 'usd' is what makes this
      // migration free: every existing row keeps meaning exactly what it meant.
      await driver.exec("ALTER TABLE stores ADD COLUMN currency TEXT NOT NULL DEFAULT 'usd'").catch(() => {});
      // Money columns carry the currency they were denominated in AT THE TIME,
      // not the store's current one. Without this a seller who switches from
      // USD to DKK turns their own history into a lie, and every SUM() over
      // these tables silently adds dollars to kroner.
      await driver.exec("ALTER TABLE checkout_attempts ADD COLUMN currency TEXT NOT NULL DEFAULT 'usd'").catch(() => {});
      await driver.exec("ALTER TABLE subscriptions ADD COLUMN currency TEXT NOT NULL DEFAULT 'usd'").catch(() => {});
      await driver.exec("ALTER TABLE store_plans ADD COLUMN currency TEXT NOT NULL DEFAULT 'usd'").catch(() => {});
      // Crypto payouts forward straight to the seller's own wallet: Dues has
      // no custodial balance and no code path that needs one. The network is
      // stored alongside the address because the same string can be a valid
      // address on more than one chain, and paying out on the wrong one is
      // unrecoverable.
      await driver.exec('ALTER TABLE stores ADD COLUMN crypto_wallet TEXT').catch(() => {});
      await driver.exec('ALTER TABLE stores ADD COLUMN crypto_chain TEXT').catch(() => {});
      // The provider's own id for an attempt. Stripe puts its cs_… id straight
      // in session_id; a crypto attempt is keyed by an order id we mint
      // ourselves, so the payment id it maps to needs somewhere to live —
      // it is what the buyer's pay screen re-reads status from.
      await driver.exec('ALTER TABLE checkout_attempts ADD COLUMN provider_ref TEXT').catch(() => {});
      return driver;
    })().catch((err) => {
      driverPromise = null; // a failed init must not poison every later request
      throw err;
    });
  }
  return driverPromise;
}

export async function ensureSchema() {
  return (await db()).dialect;
}

const q = async (sql, params) => (await db()).query(sql, params);
const now = () => Math.floor(Date.now() / 1000);

// ── users ─────────────────────────────────────────────────────────────────────

export async function upsertUser({ discordId, username, accessToken = null, refreshToken = null }) {
  await q(
    `INSERT INTO users (discord_id, username, access_token, refresh_token, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (discord_id) DO UPDATE SET
       username = excluded.username,
       access_token = COALESCE(excluded.access_token, users.access_token),
       refresh_token = COALESCE(excluded.refresh_token, users.refresh_token),
       updated_at = excluded.updated_at`,
    [discordId, username ?? null, accessToken, refreshToken, now(), now()],
  );
}

export async function getUser(discordId) {
  const { rows } = await q('SELECT * FROM users WHERE discord_id = ?', [discordId]);
  return rows[0] ?? null;
}

// Every Discord account that has ever signed in, WITHOUT the OAuth token
// columns — this feeds the platform-owner admin view, and tokens must never
// leave the DB layer on that path. updated_at moves on every login, so it
// doubles as "last seen".
export async function allUsersSafe({ limit = 1000 } = {}) {
  const { rows } = await q(
    'SELECT discord_id, username, created_at, updated_at FROM users ORDER BY updated_at DESC LIMIT ?',
    [limit],
  );
  return rows;
}

// Every owner's Dues plan row — the platform admin view sums MRR from this.
export async function allPlatformBilling() {
  const { rows } = await q('SELECT * FROM platform_billing', []);
  return rows;
}

// ── plan role overrides ───────────────────────────────────────────────────────

export async function getPlanOverride(planId) {
  const { rows } = await q('SELECT * FROM plan_overrides WHERE plan_id = ?', [planId]);
  const r = rows[0];
  return r ? { roleIds: JSON.parse(r.role_ids), roleNames: JSON.parse(r.role_names) } : null;
}

export async function getAllPlanOverrides() {
  const { rows } = await q('SELECT * FROM plan_overrides', []);
  return new Map(rows.map((r) => [r.plan_id, { roleIds: JSON.parse(r.role_ids), roleNames: JSON.parse(r.role_names) }]));
}

export async function setPlanOverride(planId, roleIds, roleNames) {
  await q(
    `INSERT INTO plan_overrides (plan_id, role_ids, role_names, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (plan_id) DO UPDATE SET
       role_ids = excluded.role_ids,
       role_names = excluded.role_names,
       updated_at = excluded.updated_at`,
    [planId, JSON.stringify(roleIds), JSON.stringify(roleNames), now()],
  );
}

export async function getAppSecret(name) {
  const { rows } = await q('SELECT value FROM app_secrets WHERE name = ?', [name]);
  return rows[0] ? String(rows[0].value) : null;
}

export async function setAppSecret(name, value) {
  await q(
    `INSERT INTO app_secrets (name, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [name, value, now()],
  );
}

// Cross-instance lock via the app_secrets PRIMARY KEY: first inserter wins;
// a stale lock (older than ttlSeconds) can be taken over.
export async function acquireLock(name, ttlSeconds) {
  const t = now();
  const ins = await q(
    'INSERT INTO app_secrets (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING',
    [name, String(t), t],
  );
  if (ins.changes > 0) return true;
  const upd = await q('UPDATE app_secrets SET value = ?, updated_at = ? WHERE name = ? AND updated_at < ?', [
    String(t),
    t,
    name,
    t - ttlSeconds,
  ]);
  return upd.changes > 0;
}

export async function releaseLock(name) {
  await q('DELETE FROM app_secrets WHERE name = ?', [name]);
}

// Ledger of every role id the paygate has ever been able to grant — see the
// managed_role_history DDL comment. Insert-only, idempotent.
export async function recordManagedRoles(roleIds) {
  if (roleIds.length === 0) return;
  const values = roleIds.map(() => '(?, ?)').join(', ');
  await q(
    `INSERT INTO managed_role_history (role_id, recorded_at) VALUES ${values} ON CONFLICT (role_id) DO NOTHING`,
    roleIds.flatMap((id) => [id, now()]),
  );
}

export async function recordedManagedRoleIds() {
  const { rows } = await q('SELECT role_id FROM managed_role_history', []);
  return rows.map((r) => String(r.role_id));
}

// ── webhook idempotency claims ────────────────────────────────────────────────

export async function claimEvent(provider, eventId) {
  const { changes } = await q(
    'INSERT INTO webhook_events (event_id, provider, received_at) VALUES (?, ?, ?) ON CONFLICT (event_id) DO NOTHING',
    [`${provider}:${eventId}`, provider, now()],
  );
  return changes === 1;
}

export async function releaseEvent(provider, eventId) {
  await q('DELETE FROM webhook_events WHERE event_id = ?', [`${provider}:${eventId}`]);
}

// ── subscriptions ─────────────────────────────────────────────────────────────

export async function getSubscriptionByRef(provider, providerRef) {
  const { rows } = await q('SELECT * FROM subscriptions WHERE provider = ? AND provider_ref = ?', [provider, providerRef]);
  return rows[0] ?? null;
}

export async function upsertSubscription({ discordId, planId, provider, providerRef, status, currentPeriodEnd, graceUntil = null, storeId = null, paidUsd = null, currency = 'usd' }) {
  await q(
    `INSERT INTO subscriptions (store_id, discord_id, plan_id, provider, provider_ref, status, current_period_end, grace_until, paid_usd, currency, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider, provider_ref) DO UPDATE SET
       store_id = excluded.store_id,
       discord_id = excluded.discord_id,
       plan_id = excluded.plan_id,
       status = excluded.status,
       current_period_end = excluded.current_period_end,
       grace_until = excluded.grace_until,
       paid_usd = COALESCE(excluded.paid_usd, subscriptions.paid_usd),
       currency = excluded.currency,
       updated_at = excluded.updated_at`,
    [storeId, discordId, planId, provider, providerRef, status, currentPeriodEnd, graceUntil, paidUsd, currency, now(), now()],
  );
  return getSubscriptionByRef(provider, providerRef);
}

export async function setSubscriptionStatus(id, { status, currentPeriodEnd, graceUntil }) {
  const { rows } = await q('SELECT * FROM subscriptions WHERE id = ?', [id]);
  const cur = rows[0];
  if (!cur) return null;
  await q(
    'UPDATE subscriptions SET status = ?, current_period_end = ?, grace_until = ?, updated_at = ? WHERE id = ?',
    [
      status ?? cur.status,
      currentPeriodEnd === undefined ? cur.current_period_end : currentPeriodEnd,
      graceUntil === undefined ? cur.grace_until : graceUntil,
      now(),
      id,
    ],
  );
  return (await q('SELECT * FROM subscriptions WHERE id = ?', [id])).rows[0];
}

// Buyer cancelled: keep the row entitled (they paid for this period) and just
// record when it runs out. The role lifts on Stripe's deletion webhook.
export async function markSubscriptionCancelling(id, cancelsAt) {
  await q('UPDATE subscriptions SET cancels_at = ?, updated_at = ? WHERE id = ?', [cancelsAt, now(), id]);
}

// A checkout was started. Recorded before the buyer ever sees Stripe's page,
// so an abandoned one still shows up. Re-clicking Pay makes a new session and
// therefore a new row — that repetition is itself the signal.
export async function recordCheckoutAttempt({ storeId = null, planId, discordId, sessionId, amountUsd = 0, discountCode = null, currency = 'usd' }) {
  const t = now();
  await q(
    `INSERT INTO checkout_attempts (store_id, plan_id, discord_id, session_id, amount_usd, currency, discount_code, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?)
     ON CONFLICT (session_id) DO NOTHING`,
    [storeId, planId, discordId, sessionId, amountUsd, currency, discountCode, t],
  );
}

export async function setCheckoutAttemptRef(sessionId, providerRef) {
  await q('UPDATE checkout_attempts SET provider_ref = ? WHERE session_id = ?', [providerRef, sessionId]);
}

// The order behind a crypto payment. NOWPayments' IPN carries only our own
// order_id, so this row is the whole mapping from "money arrived" back to
// which buyer bought which product in which store — there is nothing else to
// recover it from.
export async function getCheckoutAttempt(sessionId) {
  const { rows } = await q('SELECT * FROM checkout_attempts WHERE session_id = ?', [sessionId]);
  return rows[0] ?? null;
}

// The completion webhook is the only thing that flips a row. It is replayed by
// Stripe on retries, so completed_at is written once and never moved.
export async function markCheckoutCompleted(sessionId, at = now()) {
  await q("UPDATE checkout_attempts SET status = 'completed', completed_at = ? WHERE session_id = ? AND status <> 'completed'", [at, sessionId]);
}

export async function checkoutAttempts(storeIds = null, { limit = 300 } = {}) {
  if (storeIds === null) {
    return (await q('SELECT * FROM checkout_attempts ORDER BY created_at DESC LIMIT ?', [limit])).rows;
  }
  if (!storeIds.length) return [];
  const hasNull = storeIds.includes(null);
  const ids = storeIds.filter((v) => v !== null);
  const clauses = [];
  const args = [];
  if (ids.length) {
    clauses.push(`store_id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  if (hasNull) clauses.push('store_id IS NULL');
  if (!clauses.length) return [];
  args.push(limit);
  return (await q(`SELECT * FROM checkout_attempts WHERE ${clauses.join(' OR ')} ORDER BY created_at DESC LIMIT ?`, args)).rows;
}

export async function subscriptionsForMember(discordId) {
  return (await q('SELECT * FROM subscriptions WHERE discord_id = ?', [discordId])).rows;
}

// A subscription still entitles its member while active and unexpired
// (NULL expiry = lifetime), or past_due inside the grace window.
// (pg returns BIGINT as string — normalise before comparing.)
const asNum = (v) => (v === null || v === undefined ? null : Number(v));

export function isEntitled(sub, at = now()) {
  const end = asNum(sub.current_period_end);
  const grace = asNum(sub.grace_until);
  if (sub.status === 'active') return end === null || end > at;
  if (sub.status === 'past_due') return grace !== null && grace > at;
  return false;
}

// ── stores (multi-tenant) ─────────────────────────────────────────────────────

const storeRow = (r) => (r ? { ...r, id: Number(r.id) } : null);

export async function createStore({ slug, name, ownerDiscordId, guildId, stripeSecretEnc, status = 'draft' }) {
  await q(
    `INSERT INTO stores (slug, name, owner_discord_id, guild_id, stripe_secret_enc, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [slug, name, ownerDiscordId, guildId, stripeSecretEnc, status, now(), now()],
  );
  return getStoreBySlug(slug);
}

export async function getStoreBySlug(slug) {
  const { rows } = await q('SELECT * FROM stores WHERE slug = ?', [slug]);
  return storeRow(rows[0]);
}

export async function getStoreById(id) {
  const { rows } = await q('SELECT * FROM stores WHERE id = ?', [id]);
  return storeRow(rows[0]);
}

export async function getStoreByGuild(guildId) {
  const { rows } = await q('SELECT * FROM stores WHERE guild_id = ?', [guildId]);
  return storeRow(rows[0]);
}

// Every managed store bound to a guild. Used by the reconciler so a role a
// member legitimately holds via ANOTHER store in the same Discord guild is
// never stripped while reconciling this one.
export async function storesByGuild(guildId) {
  const { rows } = await q('SELECT * FROM stores WHERE guild_id = ?', [guildId]);
  return rows.map(storeRow);
}

export async function storesByOwner(ownerDiscordId) {
  const { rows } = await q('SELECT * FROM stores WHERE owner_discord_id = ? ORDER BY id', [ownerDiscordId]);
  return rows.map(storeRow);
}

export async function allStores() {
  const { rows } = await q('SELECT * FROM stores ORDER BY id', []);
  return rows.map(storeRow);
}

export async function updateStore(id, fields) {
  const cols = {
    name: 'name',
    description: 'description',
    bannerUrl: 'banner_url',
    slug: 'slug',
    status: 'status',
    stripeSecretEnc: 'stripe_secret_enc',
    stripeWebhookSecret: 'stripe_webhook_secret',
    notifyChannelId: 'notify_channel_id',
    theme: 'theme',
    discoverable: 'discoverable',
    category: 'category',
    about: 'about',
    links: 'links',
    showMembers: 'show_members',
    dashboardPrefs: 'dashboard_prefs',
    reviewsOn: 'reviews_on',
    creatorName: 'creator_name',
    team: 'team',
    teamHeading: 'team_heading',
    currency: 'currency',
    cryptoWallet: 'crypto_wallet',
    cryptoChain: 'crypto_chain',
  };
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(cols)) {
    if (fields[k] !== undefined) {
      sets.push(`${col} = ?`);
      params.push(fields[k]);
    }
  }
  if (!sets.length) return getStoreById(id);
  params.push(now(), id);
  await q(`UPDATE stores SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, params);
  return getStoreById(id);
}

// Payment history is the line a delete must not cross: a store with any
// subscription row ever recorded stays (members' access and the money trail
// both hang off it).
export async function countStoreSubscriptions(storeId) {
  const { rows } = await q('SELECT COUNT(*) AS n FROM subscriptions WHERE store_id = ?', [storeId]);
  return Number(rows[0]?.n ?? 0);
}

// Live holders of any of these plans in one store — what product-delete has
// to ask before it removes a row the role map is built from.
export async function countLiveSubscriptionsForPlans(storeId, planIds) {
  if (!planIds.length) return 0;
  const marks = planIds.map(() => '?').join(', ');
  const { rows } = await q(
    `SELECT COUNT(*) AS n FROM subscriptions WHERE store_id = ? AND status IN ('active', 'past_due') AND plan_id IN (${marks})`,
    [storeId, ...planIds],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function deleteStore(storeId) {
  await q('DELETE FROM discounts WHERE store_id = ?', [storeId]);
  await q('DELETE FROM store_plans WHERE store_id = ?', [storeId]);
  await q('DELETE FROM store_media WHERE store_id = ?', [storeId]);
  await q('DELETE FROM store_follows WHERE store_id = ?', [storeId]);
  await q('DELETE FROM store_reviews WHERE store_id = ?', [storeId]);
  await q('DELETE FROM stores WHERE id = ?', [storeId]);
}

// ── store media (uploaded banners) ────────────────────────────────────────────

export async function setStoreMedia(storeId, kind, mime, data) {
  await q(
    `INSERT INTO store_media (store_id, kind, mime, data, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (store_id, kind) DO UPDATE SET
       mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
    [storeId, kind, mime, data, now()],
  );
}

// Everything ABOUT the upload without the upload: what it is and when it
// changed. Every render path uses this — the blob itself is loaded only by
// the endpoint that streams it.
export async function getStoreMediaMeta(storeId, kind) {
  const { rows } = await q('SELECT mime, updated_at FROM store_media WHERE store_id = ? AND kind = ?', [storeId, kind]);
  return rows[0] ? { mime: String(rows[0].mime), updatedAt: Number(rows[0].updated_at) } : null;
}

export async function getStoreMedia(storeId, kind) {
  const { rows } = await q('SELECT data FROM store_media WHERE store_id = ? AND kind = ?', [storeId, kind]);
  return rows[0]?.data ?? null;
}

export async function deleteStoreMedia(storeId, kind) {
  await q('DELETE FROM store_media WHERE store_id = ? AND kind = ?', [storeId, kind]);
}

// ── store follows ─────────────────────────────────────────────────────────────
// Counts only ever leave this module. Nothing here returns a roster of who
// follows a store, because no client is ever allowed one.

// Idempotent by the UNIQUE constraint, not by a racy SELECT-then-INSERT.
// Returns whether this call is what created the row.
export async function followStore(storeId, discordId) {
  const { changes } = await q(
    `INSERT INTO store_follows (store_id, follower_discord_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT (store_id, follower_discord_id) DO NOTHING`,
    [storeId, discordId, now()],
  );
  return changes === 1;
}

export async function unfollowStore(storeId, discordId) {
  const { changes } = await q('DELETE FROM store_follows WHERE store_id = ? AND follower_discord_id = ?', [storeId, discordId]);
  return changes > 0;
}

// The public follower number, and the only shape of it that exists: COUNT(*),
// computed here, never seeded or adjusted. (pg returns COUNT as a string.)
export async function countStoreFollowers(storeId) {
  const { rows } = await q('SELECT COUNT(*) AS n FROM store_follows WHERE store_id = ?', [storeId]);
  return Number(rows[0]?.n ?? 0);
}

export async function isFollowingStore(storeId, discordId) {
  const { rows } = await q('SELECT 1 AS hit FROM store_follows WHERE store_id = ? AND follower_discord_id = ?', [storeId, discordId]);
  return rows.length > 0;
}

// The caller's OWN follow list, as store slugs — this is what /api/me returns,
// and it is scoped to the signed-in follower by construction.
export async function storesFollowedBy(discordId) {
  const { rows } = await q(
    `SELECT s.slug FROM store_follows f JOIN stores s ON s.id = f.store_id
     WHERE f.follower_discord_id = ? ORDER BY f.id`,
    [discordId],
  );
  return rows.map((r) => String(r.slug));
}

// The follow ledger doubles as the rate limiter's window: no separate counter
// to drift, and a repeat follow (which inserts nothing) costs nothing.
export async function countRecentFollowsBy(discordId, since) {
  const { rows } = await q('SELECT COUNT(*) AS n FROM store_follows WHERE follower_discord_id = ? AND created_at >= ?', [discordId, since]);
  return Number(rows[0]?.n ?? 0);
}

// ── store reviews ─────────────────────────────────────────────────────────────
// The right to review is bought, not granted: this returns the timestamp of the
// caller's FIRST payment to this store, or null. It deliberately ignores
// `status` — a membership that lapsed, was cancelled, or was revoked by the
// seller still happened, and a seller who could silence a critic by removing
// them would be editing their own rating by the back door.
export async function firstPurchaseAt(storeId, discordId) {
  const { rows } = await q(
    'SELECT MIN(created_at) AS at FROM subscriptions WHERE store_id = ? AND discord_id = ?',
    [storeId, discordId],
  );
  const at = rows[0]?.at;
  return at === null || at === undefined ? null : Number(at);
}

const reviewRow = (r) =>
  r
    ? {
        id: Number(r.id),
        storeId: Number(r.store_id),
        authorDiscordId: String(r.author_discord_id),
        rating: Number(r.rating),
        body: r.body ?? null,
        status: String(r.status),
        purchaseAt: Number(r.purchase_at),
        replyBody: r.reply_body ?? null,
        replyAt: r.reply_at === null || r.reply_at === undefined ? null : Number(r.reply_at),
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
      }
    : null;

// COUNT(*) and the mean over published rows. Nothing else. A store with no
// reviews reports { count: 0, average: null } — never an average of 0, which
// would render as a one-star store that nobody has actually rated.
export async function reviewSummary(storeId) {
  if (storeId === null || storeId === undefined) return { count: 0, average: null };
  const { rows } = await q(
    "SELECT COUNT(*) AS n, AVG(rating) AS avg FROM store_reviews WHERE store_id = ? AND status = 'published'",
    [storeId],
  );
  const count = Number(rows[0]?.n ?? 0);
  return { count, average: count > 0 ? Number(rows[0].avg) : null };
}

export async function listReviews(storeId, { limit = 20, before = null } = {}) {
  const params = [storeId];
  let where = "store_id = ? AND status = 'published'";
  if (before) {
    where += ' AND id < ?';
    params.push(before);
  }
  params.push(limit);
  const { rows } = await q(`SELECT * FROM store_reviews WHERE ${where} ORDER BY id DESC LIMIT ?`, params);
  return rows.map(reviewRow);
}

export async function getReviewByAuthor(storeId, discordId) {
  const { rows } = await q('SELECT * FROM store_reviews WHERE store_id = ? AND author_discord_id = ?', [storeId, discordId]);
  return reviewRow(rows[0]);
}

export async function getReviewById(id) {
  const { rows } = await q('SELECT * FROM store_reviews WHERE id = ?', [id]);
  return reviewRow(rows[0]);
}

// Write-or-replace the caller's own review. created_at is preserved on an edit
// so "reviewed in March, edited in May" stays true; updated_at moving past it
// is what the storefront reads to label a review as edited.
export async function upsertReview({ storeId, discordId, rating, body, purchaseAt }) {
  const ts = now();
  await q(
    `INSERT INTO store_reviews (store_id, author_discord_id, rating, body, status, purchase_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'published', ?, ?, ?)
     ON CONFLICT (store_id, author_discord_id)
     DO UPDATE SET rating = EXCLUDED.rating, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at`,
    [storeId, discordId, rating, body, purchaseAt, ts, ts],
  );
  return getReviewByAuthor(storeId, discordId);
}

// A reviewer withdrawing their OWN words. This is the only DELETE on this
// table reachable from the product, and only the author can reach it.
export async function deleteOwnReview(storeId, discordId) {
  const { changes } = await q('DELETE FROM store_reviews WHERE store_id = ? AND author_discord_id = ?', [storeId, discordId]);
  return Number(changes ?? 0) > 0;
}

// The seller's public answer. Note what this cannot do: it cannot touch
// rating, body or status. Reply is the whole of a seller's power here.
export async function setReviewReply(id, storeId, body) {
  const { changes } = await q(
    'UPDATE store_reviews SET reply_body = ?, reply_at = ? WHERE id = ? AND store_id = ?',
    [body, body === null ? null : now(), id, storeId],
  );
  return Number(changes ?? 0) > 0;
}

// The rate limiter's window, same trick as countRecentFollowsBy.
export async function countRecentReviewsBy(discordId, since) {
  const { rows } = await q('SELECT COUNT(*) AS n FROM store_reviews WHERE author_discord_id = ? AND updated_at >= ?', [discordId, since]);
  return Number(rows[0]?.n ?? 0);
}

const planRow = (r) =>
  r
    ? {
        id: Number(r.id),
        storeId: Number(r.store_id),
        planKey: r.plan_key,
        name: r.name,
        description: r.description,
        imageUrl: r.image_url,
        priceUsd: Number(r.price_usd),
        currency: r.currency ?? 'usd',
        lifetime: Number(r.lifetime) === 1,
        durationDays: r.duration_days === null ? null : Number(r.duration_days),
        stripePriceId: r.stripe_price_id,
        roleIds: JSON.parse(r.role_ids ?? '[]'),
        roleNames: JSON.parse(r.role_names ?? '[]'),
        active: r.active === null || r.active === undefined ? true : Number(r.active) === 1,
        purchaseLimit: r.purchase_limit === null || r.purchase_limit === undefined ? null : Number(r.purchase_limit),
        successUrl: r.success_url ?? null,
        linkSlug: r.link_slug ?? null,
        variantOf: r.variant_of ?? null,
        expiresAt: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
        requiredRoleId: r.required_role_id ?? null,
        requiredRoleName: r.required_role_name ?? null,
        hasImageData: Boolean(r.image_data), // the data URL itself never rides list payloads
        // What the upload IS — storefronts need a <video> vs <img> decision
        // without ever loading the data URL into a list payload.
        mediaKind: r.image_data ? (String(r.image_data).startsWith('data:video/') ? 'video' : 'image') : null,
        createdAt: r.created_at === null || r.created_at === undefined ? null : Number(r.created_at),
      }
    : null;

// The uploaded photo for one plan — fetched only by the image endpoint.
export async function getPlanImage(storeId, planKey) {
  const { rows } = await q('SELECT image_data FROM store_plans WHERE store_id = ? AND plan_key = ?', [storeId, planKey]);
  return rows[0]?.image_data ?? null;
}

// Field-level product edits. stripe_price_id is set here only when checkout
// lazily provisions a price; a price EDIT clears it so the next checkout
// provisions a fresh price — existing Stripe subscriptions keep the price
// they were sold at and are never touched.
export async function updateStorePlan(storeId, planKey, fields) {
  const cols = {
    name: 'name',
    description: 'description',
    imageUrl: 'image_url',
    priceUsd: 'price_usd',
    currency: 'currency',
    lifetime: 'lifetime',
    durationDays: 'duration_days',
    stripePriceId: 'stripe_price_id',
    active: 'active',
    purchaseLimit: 'purchase_limit',
    successUrl: 'success_url',
    imageData: 'image_data',
    linkSlug: 'link_slug',
    variantOf: 'variant_of',
    expiresAt: 'expires_at',
    requiredRoleId: 'required_role_id',
    requiredRoleName: 'required_role_name',
  };
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(cols)) {
    if (fields[k] !== undefined) {
      sets.push(`${col} = ?`);
      params.push(typeof fields[k] === 'boolean' ? (fields[k] ? 1 : 0) : fields[k]);
    }
  }
  if (sets.length) {
    params.push(storeId, planKey);
    await q(`UPDATE store_plans SET ${sets.join(', ')} WHERE store_id = ? AND plan_key = ?`, params);
  }
  return getStorePlan(storeId, planKey);
}

// Distinct buyers who ever completed a purchase of this product — the number
// a purchase_limit caps. Canceled/expired rows still count (they bought).
export async function countBuyersOfPlan(storeId, planKey) {
  const { rows } = await q(
    `SELECT COUNT(DISTINCT discord_id) AS n FROM subscriptions
     WHERE plan_id = ? AND ${storeId === null ? 'store_id IS NULL' : 'store_id = ?'}`,
    storeId === null ? [planKey] : [planKey, storeId],
  );
  return Number(rows[0]?.n ?? 0);
}

// ── discounts ─────────────────────────────────────────────────────────────────

const discountRow = (r) =>
  r
    ? {
        id: Number(r.id),
        storeId: Number(r.store_id),
        code: r.code,
        kind: r.kind,
        amount: Number(r.amount),
        planKey: r.plan_key ?? null,
        maxUses: r.max_uses === null || r.max_uses === undefined ? null : Number(r.max_uses),
        uses: Number(r.uses ?? 0),
        expiresAt: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
      }
    : null;

export async function createDiscount({ storeId, code, kind, amount, planKey = null, maxUses = null, expiresAt = null }) {
  await q(
    `INSERT INTO discounts (store_id, code, kind, amount, plan_key, max_uses, uses, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [storeId, code, kind, amount, planKey, maxUses, expiresAt, now()],
  );
  return getDiscount(storeId, code);
}

export async function getDiscount(storeId, code) {
  const { rows } = await q('SELECT * FROM discounts WHERE store_id = ? AND code = ?', [storeId, code]);
  return discountRow(rows[0]);
}

export async function discountsFor(storeId) {
  const { rows } = await q('SELECT * FROM discounts WHERE store_id = ? ORDER BY id', [storeId]);
  return rows.map(discountRow);
}

export async function deleteDiscount(storeId, code) {
  await q('DELETE FROM discounts WHERE store_id = ? AND code = ?', [storeId, code]);
}

export async function incrementDiscountUse(storeId, code) {
  await q('UPDATE discounts SET uses = uses + 1 WHERE store_id = ? AND code = ?', [storeId, code]);
}

export async function createStorePlan({ storeId, planKey, name, description, imageUrl, priceUsd, lifetime, durationDays, stripePriceId, variantOf, currency = 'usd' }) {
  await q(
    `INSERT INTO store_plans (store_id, plan_key, name, description, image_url, price_usd, currency, lifetime, duration_days, stripe_price_id, variant_of, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (store_id, plan_key) DO UPDATE SET
       name = excluded.name, description = excluded.description, image_url = excluded.image_url,
       price_usd = excluded.price_usd, currency = excluded.currency, lifetime = excluded.lifetime, duration_days = excluded.duration_days,
       stripe_price_id = excluded.stripe_price_id, variant_of = excluded.variant_of`,
    [storeId, planKey, name, description ?? null, imageUrl ?? null, priceUsd, currency, lifetime ? 1 : 0, durationDays ?? null, stripePriceId ?? null, variantOf ?? null, now()],
  );
  return getStorePlan(storeId, planKey);
}

export async function getStorePlan(storeId, planKey) {
  const { rows } = await q('SELECT * FROM store_plans WHERE store_id = ? AND plan_key = ?', [storeId, planKey]);
  return planRow(rows[0]);
}

export async function storePlansFor(storeId) {
  const { rows } = await q('SELECT * FROM store_plans WHERE store_id = ? ORDER BY id', [storeId]);
  return rows.map(planRow);
}

export async function deleteStorePlan(storeId, planKey) {
  await q('DELETE FROM store_plans WHERE store_id = ? AND plan_key = ?', [storeId, planKey]);
}

export async function setStorePlanRoles(storeId, planKey, roleIds, roleNames) {
  await q('UPDATE store_plans SET role_ids = ?, role_names = ? WHERE store_id = ? AND plan_key = ?', [
    JSON.stringify(roleIds),
    JSON.stringify(roleNames),
    storeId,
    planKey,
  ]);
  return getStorePlan(storeId, planKey);
}

// Every subscription with its buyer's username — the owner dashboard's
// payments timeline (one row per purchase, newest first).
// storeIds filter: null entries mean the built-in default store. Pass null
// for everything (platform admin).
export async function allSubscriptionsWithUsers(storeIds = null) {
  let where = '';
  const params = [];
  if (storeIds !== null) {
    const parts = [];
    const concrete = storeIds.filter((x) => x !== null);
    if (storeIds.includes(null)) parts.push('s.store_id IS NULL');
    if (concrete.length) {
      parts.push(`s.store_id IN (${concrete.map(() => '?').join(', ')})`);
      params.push(...concrete);
    }
    where = parts.length ? `WHERE ${parts.join(' OR ')}` : 'WHERE 1 = 0';
  }
  const { rows } = await q(
    `SELECT s.*, u.username FROM subscriptions s
     LEFT JOIN users u ON u.discord_id = s.discord_id
     ${where}
     ORDER BY s.created_at DESC, s.id DESC`,
    params,
  );
  return rows;
}

// (store_id, discord_id) pairs — reconciliation is per store, per member.
export async function membersWithLiveSubscriptions(at = now()) {
  // Live rows, PLUS anyone whose row expired within the last week. The sweep
  // flips a lapsed row to 'expired' and only then reconciles the member; if
  // that reconcile fails — Discord down for a minute — the role was never
  // taken back, and nothing ever looked at an 'expired' row again. One lost
  // call was free access forever. A week of revisits makes it an hour's delay.
  const { rows } = await q(
    `SELECT DISTINCT store_id, discord_id FROM subscriptions
     WHERE status IN ('active', 'past_due')
        OR (status = 'expired' AND updated_at >= ?)`,
    [at - 7 * 86400],
  );
  return rows.map((r) => ({ storeId: r.store_id === null ? null : Number(r.store_id), discordId: r.discord_id }));
}

// How many distinct members currently hold a live membership across these
// stores — the number the owner's Dues plan is priced on. storeIds may mix
// concrete ids and null (the built-in default store).
export async function countLiveMembers(storeIds) {
  const parts = [];
  const params = [];
  const concrete = storeIds.filter((x) => x !== null && x !== undefined);
  if (storeIds.includes(null)) parts.push('store_id IS NULL');
  if (concrete.length) {
    parts.push(`store_id IN (${concrete.map(() => '?').join(', ')})`);
    params.push(...concrete);
  }
  if (!parts.length) return 0;
  // The predicate here MUST be isEntitled() expressed in SQL. It used to be
  // `status IN ('active','past_due')` with no expiry test, so a cancelled-at-
  // period-end row that had already lapsed, or a past_due row whose grace had
  // run out, still counted against the owner's plan. Those members hold no
  // role and have no access — but they filled the seller's allowance and
  // paused their checkouts. Measured on one seeded store: 175 counted here
  // against 102 the Members screen calls active, a gap of 73 dead rows.
  const at = now();
  const live = "((status = 'active' AND (current_period_end IS NULL OR current_period_end > ?))"
    + " OR (status = 'past_due' AND grace_until IS NOT NULL AND grace_until > ?))";
  const { rows } = await q(
    `SELECT COUNT(DISTINCT discord_id) AS n FROM subscriptions
     WHERE ${live} AND (${parts.join(' OR ')})`,
    [at, at, ...params],
  );
  return Number(rows[0]?.n ?? 0);
}

// ── platform billing (the owner's Dues plan) ───────────────────────────────

export async function getPlatformBilling(ownerDiscordId) {
  const { rows } = await q('SELECT * FROM platform_billing WHERE owner_discord_id = ?', [ownerDiscordId]);
  return rows[0] ?? null;
}

export async function getPlatformBillingByRef(providerRef) {
  const { rows } = await q('SELECT * FROM platform_billing WHERE provider_ref = ?', [providerRef]);
  return rows[0] ?? null;
}

export async function upsertPlatformBilling({ ownerDiscordId, tier, providerRef = null, status, currentPeriodEnd = null }) {
  await q(
    `INSERT INTO platform_billing (owner_discord_id, tier, provider_ref, status, current_period_end, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner_discord_id) DO UPDATE SET
       tier = excluded.tier,
       provider_ref = excluded.provider_ref,
       status = excluded.status,
       current_period_end = excluded.current_period_end,
       updated_at = excluded.updated_at`,
    [ownerDiscordId, tier, providerRef, status, currentPeriodEnd, now()],
  );
  return getPlatformBilling(ownerDiscordId);
}

// Rows whose entitlement has lapsed but still carry a live status; the cron
// sweep flips them to 'expired' and returns them for reconciliation.
// Lifetime rows (NULL expiry) never match the predicate.
export async function lapseOverdueSubscriptions(at = now()) {
  const { rows: lapsed } = await q(
    `SELECT * FROM subscriptions
     WHERE (status = 'active' AND current_period_end IS NOT NULL AND current_period_end <= ?)
        OR (status = 'past_due' AND (grace_until IS NULL OR grace_until <= ?))`,
    [at, at],
  );
  for (const sub of lapsed) {
    await q("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ?", [at, sub.id]);
  }
  return lapsed;
}
