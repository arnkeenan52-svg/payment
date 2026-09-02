// Effective plan configuration: plans.json is the shipped default, but the
// role mapping can be overridden at runtime from the owner dashboard
// (stored in the database — the deployed filesystem is read-only). Pricing
// and billing fields (stripePriceId, priceUsd, lifetime, durationDays) are
// deliberately NOT runtime-editable; only the Discord role mapping is.
//
// Resolution order per plan:
//   1. the owner's dashboard pick (DB override)
//   2. plans.json roleIds that exist in the guild
//   3. ONLY when none of the configured ids exist: roleNames matched against
//      the live guild role list — "@Premium" finds the role literally named
//      "premium" (case-insensitive, "@" ignored) — so a fresh install works
//      from the role's NAME without anyone copying snowflakes. Names are a
//      fallback tier, never a union: a live configured id plus a same-named
//      other role must not double-grant.
//
// Every id a resolution produces is recorded in the managed_role_history
// ledger, so the reconciler can still REMOVE a role granted under an old
// mapping after renames, re-picks and redeploys.

import { config, planById, managedRoleIds } from '../config.js';
import { getAllPlanOverrides, recordManagedRoles, recordedManagedRoleIds } from '../db.js';
import { getGuildRoles, getBotUser, getGuildMember } from '../lib/discord.js';

// Short-lived guild-role cache: name resolution sits on the webhook grant
// path and role lists change rarely. Failures are NOT cached — the next call
// retries — and resolve to null so callers fall back to the configured ids.
const ttlMs = () => Number(process.env.ROLE_CACHE_SECONDS ?? 60) * 1000;
// Per guild: every managed store lives in its own server, and the cron sweep
// resolves once per (store, member) pair, so one shared slot would thrash.
const rolesCache = new Map(); // guildId -> { at, promise }
export function guildRolesCached(guildId = config.discord.guildId) {
  const at = Date.now();
  const hit = rolesCache.get(guildId);
  if (hit && at - hit.at <= ttlMs()) return hit.promise;
  const entry = { at, promise: null };
  entry.promise = getGuildRoles(guildId).catch(() => {
    entry.at = 0; // a failure is not cached: the next call retries
    return null;
  });
  rolesCache.set(guildId, entry);
  return entry.promise;
}

// The doctor calls this before running so "Re-run checks" never grades a
// mapping resolved from a role list up to a minute old.
export function invalidateGuildRolesCache() {
  rolesCache.clear();
  botMemberCache.clear();
}

// The bot's top role position — consulted only to break ties between
// same-named roles, so the pick prefers a role the bot can actually grant.
let botIdPromise = null;
const botMemberCache = new Map(); // guildId -> { at, promise }
async function botTopPosition(roles, guildId = config.discord.guildId) {
  try {
    botIdPromise ??= getBotUser().then((u) => u.id).catch(() => {
      botIdPromise = null;
      return null;
    });
    const botId = await botIdPromise;
    if (!botId) return null;
    const at = Date.now();
    let hit = botMemberCache.get(guildId);
    if (!hit || at - hit.at > ttlMs()) {
      hit = { at, promise: null };
      hit.promise = getGuildMember(botId, guildId).catch(() => {
        hit.at = 0;
        return null;
      });
      botMemberCache.set(guildId, hit);
    }
    const member = await hit.promise;
    if (!member) return null;
    const byId = new Map(roles.map((r) => [r.id, r]));
    let top = 0;
    for (const rid of member.roles ?? []) top = Math.max(top, byId.get(rid)?.position ?? 0);
    return top;
  } catch {
    return null;
  }
}

const normName = (name) => String(name ?? '').replace(/^@/, '').trim().toLowerCase();

// Tier 2/3 resolution for one plan against the live role list. Returns null
// when nothing resolves — callers fall back to the shipped ids so the doctor
// can point at them loudly.
// Exported: managed stores resolve the same way against THEIR guild, so a
// role the seller deleted and re-created under the same name still lands
// instead of every sale 500-looping on the dead id.
export async function resolveAgainstGuild(plan, roles, guildId = config.discord.guildId) {
  const byId = new Map(roles.map((r) => [r.id, r]));
  const ids = (plan.roleIds ?? []).filter((id) => byId.has(id));
  if (ids.length > 0) return { ids, byName: false };

  const out = [];
  for (const wanted of plan.roleNames ?? []) {
    const key = normName(wanted);
    if (!key) continue;
    const matches = roles
      .filter((r) => r.id !== guildId && !r.managed && normName(r.name) === key)
      .sort((a, b) => b.position - a.position);
    if (matches.length === 0) continue;
    let pick = matches[0];
    if (matches.length > 1) {
      const top = await botTopPosition(roles, guildId);
      if (top !== null) pick = matches.find((m) => m.position < top) ?? matches[0];
    }
    if (!out.includes(pick.id)) out.push(pick.id);
  }
  return out.length ? { ids: out, byName: true } : null;
}

// Persist resolved ids into the removal ledger; memoized per process so the
// hot path pays one INSERT per new id, and a bookkeeping failure never
// blocks a grant.
const recordedThisProcess = new Set();
async function recordResolved(ids) {
  const fresh = ids.filter((id) => !recordedThisProcess.has(id));
  if (fresh.length === 0) return;
  try {
    await recordManagedRoles(fresh);
    for (const id of fresh) recordedThisProcess.add(id);
  } catch (err) {
    console.warn(`[plan-config] recording managed roles failed (will retry): ${err.message}`);
  }
}

// Full resolution result: `map` is planId -> { roleIds, roleNames, source }
// (source: 'override' | 'name' | 'default'); `degraded` is true when the
// guild role list could not be fetched and any plan fell back to configured
// ids — reconcilers must not REMOVE roles based on a degraded mapping.
export async function effectiveRolePlan() {
  const overrides = await getAllPlanOverrides();
  const needsGuild = config.plans.some((p) => !overrides.get(p.id));
  const roles = needsGuild ? await guildRolesCached() : null;
  const map = new Map();
  const resolvedIds = [];
  let degraded = false;
  for (const plan of config.plans) {
    const o = overrides.get(plan.id);
    if (o) {
      map.set(plan.id, { roleIds: o.roleIds, roleNames: o.roleNames ?? plan.roleNames ?? [], source: 'override' });
      resolvedIds.push(...o.roleIds);
      continue;
    }
    if (!roles) {
      degraded = true;
      map.set(plan.id, { roleIds: plan.roleIds, roleNames: plan.roleNames ?? [], source: 'default' });
      continue;
    }
    const resolved = await resolveAgainstGuild(plan, roles);
    if (resolved) resolvedIds.push(...resolved.ids);
    map.set(plan.id, {
      roleIds: resolved?.ids ?? plan.roleIds,
      roleNames: plan.roleNames ?? [],
      source: resolved?.byName ? 'name' : 'default',
    });
  }
  await recordResolved(resolvedIds);
  return { map, degraded };
}

export async function effectiveRoleMap() {
  return (await effectiveRolePlan()).map;
}

export async function effectiveRoleIds(planId) {
  return (await effectiveRoleMap()).get(planId)?.roleIds ?? planById(planId)?.roleIds ?? [];
}

// Every role id the reconciler may remove: static plans.json ids, current
// overrides, the current resolution, and the persisted ledger of everything
// ever resolved — so a role mapped in the past really is still cleaned up
// after the mapping changes. Pass a precomputed map to keep one reconcile on
// a single mapping snapshot.
export async function effectiveManagedRoleIds(roleMap = null) {
  const managed = managedRoleIds();
  for (const { roleIds } of (await getAllPlanOverrides()).values()) {
    for (const id of roleIds) managed.add(id);
  }
  for (const id of await recordedManagedRoleIds()) managed.add(id);
  for (const { roleIds } of (roleMap ?? (await effectiveRoleMap())).values()) {
    for (const id of roleIds) managed.add(id);
  }
  return managed;
}
