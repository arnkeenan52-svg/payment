import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    discord_id   TEXT PRIMARY KEY,
    username     TEXT,
    access_token TEXT,
    refresh_token TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );

  -- current_period_end IS NULL means LIFETIME and nothing else; every
  -- non-lifetime grant must carry a concrete expiry (see entitlements.grant).
  CREATE TABLE IF NOT EXISTS subscriptions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id   TEXT NOT NULL,
    plan_id      TEXT NOT NULL,
    provider     TEXT NOT NULL,             -- 'stripe' | 'coinbase'
    provider_ref TEXT NOT NULL,             -- stripe subscription/payment id, coinbase charge code
    status       TEXT NOT NULL,             -- 'active' | 'past_due' | 'canceled' | 'expired'
    current_period_end INTEGER,             -- unix seconds; NULL = lifetime
    grace_until  INTEGER,                   -- unix seconds; set while past_due
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    UNIQUE (provider, provider_ref)
  );
  CREATE INDEX IF NOT EXISTS idx_subscriptions_member ON subscriptions (discord_id);

  -- Idempotency: the PRIMARY KEY *is* the claim. First INSERT wins; a
  -- duplicate delivery loses the race at the constraint, not at a racy
  -- SELECT-then-INSERT. Rows are deleted again if the handler throws so the
  -- provider's retry gets a real second attempt.
  CREATE TABLE IF NOT EXISTS webhook_events (
    event_id    TEXT PRIMARY KEY,           -- '<provider>:<provider event id>'
    provider    TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );
`);

const now = () => Math.floor(Date.now() / 1000);

// ── users ─────────────────────────────────────────────────────────────────────

const upsertUserStmt = db.prepare(`
  INSERT INTO users (discord_id, username, access_token, refresh_token, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (discord_id) DO UPDATE SET
    username = excluded.username,
    access_token = COALESCE(excluded.access_token, users.access_token),
    refresh_token = COALESCE(excluded.refresh_token, users.refresh_token),
    updated_at = excluded.updated_at
`);

export function upsertUser({ discordId, username, accessToken = null, refreshToken = null }) {
  upsertUserStmt.run(discordId, username ?? null, accessToken, refreshToken, now(), now());
}

export function getUser(discordId) {
  return db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId) ?? null;
}

// ── webhook idempotency claims ────────────────────────────────────────────────

export function claimEvent(provider, eventId) {
  try {
    db.prepare('INSERT INTO webhook_events (event_id, provider, received_at) VALUES (?, ?, ?)')
      .run(`${provider}:${eventId}`, provider, now());
    return true;
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed')) return false;
    throw err;
  }
}

export function releaseEvent(provider, eventId) {
  db.prepare('DELETE FROM webhook_events WHERE event_id = ?').run(`${provider}:${eventId}`);
}

// ── subscriptions ─────────────────────────────────────────────────────────────

export function getSubscriptionByRef(provider, providerRef) {
  return db.prepare('SELECT * FROM subscriptions WHERE provider = ? AND provider_ref = ?')
    .get(provider, providerRef) ?? null;
}

export function upsertSubscription({ discordId, planId, provider, providerRef, status, currentPeriodEnd, graceUntil = null }) {
  db.prepare(`
    INSERT INTO subscriptions (discord_id, plan_id, provider, provider_ref, status, current_period_end, grace_until, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider, provider_ref) DO UPDATE SET
      discord_id = excluded.discord_id,
      plan_id = excluded.plan_id,
      status = excluded.status,
      current_period_end = excluded.current_period_end,
      grace_until = excluded.grace_until,
      updated_at = excluded.updated_at
  `).run(discordId, planId, provider, providerRef, status, currentPeriodEnd, graceUntil, now(), now());
  return getSubscriptionByRef(provider, providerRef);
}

export function setSubscriptionStatus(id, { status, currentPeriodEnd, graceUntil }) {
  const cur = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
  if (!cur) return null;
  db.prepare('UPDATE subscriptions SET status = ?, current_period_end = ?, grace_until = ?, updated_at = ? WHERE id = ?')
    .run(
      status ?? cur.status,
      currentPeriodEnd === undefined ? cur.current_period_end : currentPeriodEnd,
      graceUntil === undefined ? cur.grace_until : graceUntil,
      now(),
      id,
    );
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
}

export function subscriptionsForMember(discordId) {
  return db.prepare('SELECT * FROM subscriptions WHERE discord_id = ?').all(discordId);
}

// A subscription still entitles its member to roles while it is active and
// unexpired (NULL expiry = lifetime), or past_due inside the grace window.
export function isEntitled(sub, at = now()) {
  if (sub.status === 'active') return sub.current_period_end === null || sub.current_period_end > at;
  if (sub.status === 'past_due') return sub.grace_until !== null && sub.grace_until > at;
  return false;
}

export function membersWithLiveSubscriptions() {
  return db.prepare("SELECT DISTINCT discord_id FROM subscriptions WHERE status IN ('active', 'past_due')")
    .all().map((r) => r.discord_id);
}

// Rows whose entitlement has lapsed but still carry a live status; the sweep
// flips them to 'expired' and returns them for reconciliation.
export function lapseOverdueSubscriptions(at = now()) {
  const lapsed = db.prepare(`
    SELECT * FROM subscriptions
    WHERE (status = 'active' AND current_period_end IS NOT NULL AND current_period_end <= ?)
       OR (status = 'past_due' AND (grace_until IS NULL OR grace_until <= ?))
  `).all(at, at);
  const mark = db.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ?");
  for (const sub of lapsed) mark.run(at, sub.id);
  return lapsed;
}
