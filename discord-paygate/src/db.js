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
    discord_id    TEXT NOT NULL,
    plan_id       TEXT NOT NULL,
    provider      TEXT NOT NULL,
    provider_ref  TEXT NOT NULL,
    status        TEXT NOT NULL,
    current_period_end ${int},
    grace_until   ${int},
    created_at    ${int} NOT NULL,
    updated_at    ${int} NOT NULL,
    UNIQUE (provider, provider_ref)
  );
  CREATE INDEX IF NOT EXISTS idx_subscriptions_member ON subscriptions (discord_id);

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

export async function upsertSubscription({ discordId, planId, provider, providerRef, status, currentPeriodEnd, graceUntil = null }) {
  await q(
    `INSERT INTO subscriptions (discord_id, plan_id, provider, provider_ref, status, current_period_end, grace_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider, provider_ref) DO UPDATE SET
       discord_id = excluded.discord_id,
       plan_id = excluded.plan_id,
       status = excluded.status,
       current_period_end = excluded.current_period_end,
       grace_until = excluded.grace_until,
       updated_at = excluded.updated_at`,
    [discordId, planId, provider, providerRef, status, currentPeriodEnd, graceUntil, now(), now()],
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

export async function membersWithLiveSubscriptions() {
  const { rows } = await q("SELECT DISTINCT discord_id FROM subscriptions WHERE status IN ('active', 'past_due')", []);
  return rows.map((r) => r.discord_id);
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
