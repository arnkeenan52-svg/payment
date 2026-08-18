import { config } from '../config.js';
import * as db from '../db.js';
import { effectiveRolePlan, effectiveManagedRoleIds } from './plan-config.js';
import { defaultStore, storeById, plansOf, planOf } from './stores.js';
import { getGuildMember, addRole, removeRole, joinGuildWithRoles, dmUser } from '../lib/discord.js';

const now = () => Math.floor(Date.now() / 1000);
const storeKey = (store) => String(store?.id ?? 'default');
const sameStore = (sub, store) => {
  const sid = sub.store_id === null || sub.store_id === undefined ? null : Number(sub.store_id);
  return sid === (store?.id ?? null);
};

// Role mapping for a store. The default store resolves through plan-config
// (picker override > existing ids > name match); a dashboard-created store
// carries exact role ids picked during onboarding.
async function rolePlanFor(store) {
  if (!store || store.isDefault) return effectiveRolePlan();
  const map = new Map();
  const ids = [];
  for (const plan of await plansOf(store)) {
    map.set(plan.id, { roleIds: plan.roleIds, roleNames: plan.roleNames, source: 'store' });
    ids.push(...plan.roleIds);
  }
  db.recordManagedRoles(ids).catch(() => {}); // removal ledger; never blocks a grant
  return { map, degraded: false };
}

// Role ids this store's reconciler may REMOVE: its current mapping plus the
// global ledger of everything ever grantable. Role ids are globally unique
// snowflakes, so ledger entries from other guilds can never match a role a
// member actually holds in this one.
async function managedFor(store, roleMap) {
  if (!store || store.isDefault) return effectiveManagedRoleIds(roleMap);
  const managed = new Set();
  for (const { roleIds } of roleMap.values()) for (const id of roleIds) managed.add(id);
  for (const id of await db.recordedManagedRoleIds()) managed.add(id);
  return managed;
}

async function desiredFrom(roleMap, store, discordId, at = now()) {
  const desired = new Set();
  for (const sub of await db.subscriptionsForMember(discordId)) {
    if (!sameStore(sub, store)) continue;
    if (!db.isEntitled(sub, at)) continue;
    for (const roleId of roleMap.get(sub.plan_id)?.roleIds ?? []) desired.add(roleId);
  }
  return desired;
}

export async function desiredRoleIds(discordId, at = now(), store = null) {
  const target = store ?? defaultStore();
  return desiredFrom((await rolePlanFor(target)).map, target, discordId, at);
}

// Two webhooks for the same member can land at once; running their
// reconciles back-to-back keeps add/remove pairs from interleaving.
const inflight = new Map();

// The one place roles change, per (store, member), and it is idempotent:
// compute desired state, diff against Discord, add what's missing, remove
// only managed roles. Called from every webhook, login, resync and cron.
export async function reconcile(discordId, store = null) {
  const target = store ?? defaultStore();
  if (!target) return { joined: false, added: [], removed: [] };
  const key = `${storeKey(target)}:${discordId}`;
  const previous = inflight.get(key) ?? Promise.resolve();
  const run = previous.then(() => reconcileNow(discordId, target)).finally(() => {
    if (inflight.get(key) === run) inflight.delete(key);
  });
  inflight.set(key, run);
  return run;
}

// Reconcile a member in EVERY store they have history with (plus the default
// store) — the login and resync path.
export async function reconcileEverywhere(discordId) {
  const results = [];
  const seen = new Set();
  const targets = [];
  const def = defaultStore();
  if (def) {
    targets.push(def);
    seen.add(storeKey(def));
  }
  for (const sub of await db.subscriptionsForMember(discordId)) {
    const sid = sub.store_id === null || sub.store_id === undefined ? null : Number(sub.store_id);
    if (sid === null || seen.has(String(sid))) continue;
    seen.add(String(sid));
    const store = await storeById(sid);
    if (store) targets.push(store);
  }
  for (const store of targets) {
    results.push(await reconcile(discordId, store));
  }
  return {
    joined: results.some((r) => r.joined),
    added: results.flatMap((r) => r.added),
    removed: results.flatMap((r) => r.removed),
  };
}

async function reconcileNow(discordId, store) {
  // One mapping snapshot for BOTH the desired and managed sets — resolving
  // twice could disagree mid-reconcile (a transient roles-fetch failure on
  // one of them) and strip a role the member is entitled to.
  const { map: roleMap, degraded } = await rolePlanFor(store);
  const desired = await desiredFrom(roleMap, store, discordId);
  const managed = await managedFor(store, roleMap);

  const member = await getGuildMember(discordId, store.guildId);

  if (member === null) {
    // Buyer isn't in the server yet. If they logged in we hold a guilds.join
    // token — pull them in with their roles already applied instead of failing.
    if (desired.size === 0) return { joined: false, added: [], removed: [] };
    const user = await db.getUser(discordId);
    if (!user?.access_token) {
      console.warn(`[entitlements] ${discordId} not in guild ${store.guildId} and no OAuth token stored; will retry on next reconcile`);
      return { joined: false, added: [], removed: [] };
    }
    const joined = await joinGuildWithRoles(discordId, user.access_token, [...desired], store.guildId);
    if (joined) return { joined: true, added: [...desired], removed: [] };
    // 204: they were already a member after all (raced a join) — fall through
    // to a normal diff on the next call; recurse once for freshness.
    return reconcileNow(discordId, store);
  }

  const current = new Set(member.roles ?? []);
  const toAdd = [...desired].filter((r) => !current.has(r));
  // A degraded mapping (guild role list unfetchable) fell back to configured
  // ids: additions can retry later, but a removal computed against it could
  // strip a role the member holds legitimately under the full mapping.
  const toRemove = degraded ? [] : [...current].filter((r) => managed.has(r) && !desired.has(r));

  for (const roleId of toAdd) await addRole(discordId, roleId, store.guildId);
  for (const roleId of toRemove) await removeRole(discordId, roleId, store.guildId);

  return { joined: false, added: toAdd, removed: toRemove };
}

// ── entitlement mutations (each ends in a reconcile) ──────────────────────────

// periodEnd null/undefined on a non-lifetime plan means the provider gave us
// nothing usable — fall back to the plan's own duration. A NULL expiry in the
// database must mean lifetime and nothing else.
export async function grant({ discordId, planId, provider, providerRef, periodEnd = null, store = null }) {
  const target = store ?? defaultStore();
  const plan = await planOf(target, planId);
  if (!plan) {
    console.warn(`[entitlements] grant for unknown plan "${planId}" (store ${target?.slug ?? '?'}) ignored`);
    return null;
  }
  const expiry = plan.lifetime ? null : periodEnd ?? now() + plan.durationDays * 86400;
  const sub = await db.upsertSubscription({
    discordId,
    planId,
    provider,
    providerRef,
    status: 'active',
    currentPeriodEnd: expiry,
    graceUntil: null,
    storeId: target?.id ?? null,
  });
  await reconcile(discordId, target);
  return sub;
}

// Failed payment on a renewing plan: keep access through a grace window and
// tell the buyer, instead of yanking roles the moment a card bounces.
export async function markPastDue(provider, providerRef) {
  const sub = await db.getSubscriptionByRef(provider, providerRef);
  if (!sub) return null;
  const store = await storeById(sub.store_id);
  const graceUntil = now() + config.gracePeriodHours * 3600;
  await db.setSubscriptionStatus(sub.id, { status: 'past_due', graceUntil });
  const plan = await planOf(store, sub.plan_id);
  await dmUser(
    sub.discord_id,
    `⚠️ Your ${store?.name ?? config.brand} payment for **${plan?.name ?? sub.plan_id}** didn't go through. ` +
      `You keep access until <t:${graceUntil}:f> — sort it out at ${config.publicBaseUrl} to stay in.`,
  );
  await reconcile(sub.discord_id, store);
  return db.getSubscriptionByRef(provider, providerRef);
}

export async function cancel(provider, providerRef) {
  const sub = await db.getSubscriptionByRef(provider, providerRef);
  if (!sub) return null;
  const store = await storeById(sub.store_id);
  await db.setSubscriptionStatus(sub.id, { status: 'canceled', graceUntil: null });
  await reconcile(sub.discord_id, store);
  return db.getSubscriptionByRef(provider, providerRef);
}

// Cron-driven safety net (there is no long-lived process on Vercel, so this
// runs from /api/cron/reconcile): expire lapsed subscriptions, then reconcile
// every (store, member) pair affected or still live so drift heals on its
// own. Lifetime rows have NULL expiry and are structurally immune.
export async function sweepExpirations(at = now()) {
  const lapsed = await db.lapseOverdueSubscriptions(at);
  const pairs = new Map();
  for (const s of lapsed) {
    const sid = s.store_id === null || s.store_id === undefined ? null : Number(s.store_id);
    pairs.set(`${sid ?? 'default'}:${s.discord_id}`, { storeId: sid, discordId: s.discord_id });
  }
  for (const m of await db.membersWithLiveSubscriptions()) {
    pairs.set(`${m.storeId ?? 'default'}:${m.discordId}`, m);
  }
  let reconciled = 0;
  for (const { storeId, discordId } of pairs.values()) {
    try {
      const store = await storeById(storeId);
      if (!store) continue;
      await reconcile(discordId, store);
      reconciled++;
    } catch (err) {
      console.error(`[sweep] reconcile ${discordId} (store ${storeId ?? 'default'}) failed: ${err.message}`);
    }
  }
  return { lapsed: lapsed.length, membersReconciled: reconciled };
}
