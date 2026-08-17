import { config, planById } from '../config.js';
import * as db from '../db.js';
import { effectiveRoleMap, effectiveManagedRoleIds } from './plan-config.js';
import { getGuildMember, addRole, removeRole, joinGuildWithRoles, dmUser } from '../lib/discord.js';

const now = () => Math.floor(Date.now() / 1000);

// Roles this member should hold right now: the union of roleIds across every
// subscription that still entitles them (active+unexpired, or in grace).
// Role mapping honours the owner's diagnostics picker (DB override) over the
// shipped plans.json values.
export async function desiredRoleIds(discordId, at = now()) {
  const roleMap = await effectiveRoleMap();
  const desired = new Set();
  for (const sub of await db.subscriptionsForMember(discordId)) {
    if (!db.isEntitled(sub, at)) continue;
    for (const roleId of roleMap.get(sub.plan_id)?.roleIds ?? []) desired.add(roleId);
  }
  return desired;
}

// Two webhooks for the same member can land at once; running their
// reconciles back-to-back keeps add/remove pairs from interleaving.
// (Per-instance only — cross-instance safety comes from reconcile being
// idempotent: every run converges on the same desired state.)
const inflight = new Map();

// The one place roles change, and it is idempotent: compute desired state,
// diff against Discord, add what's missing, remove only roles that appear in
// plans.json. Mod, colour and every other unmanaged role is never touched.
// Called from every webhook, from login, and from the cron sweep.
export async function reconcile(discordId) {
  const previous = inflight.get(discordId) ?? Promise.resolve();
  const run = previous.then(() => reconcileNow(discordId)).finally(() => {
    if (inflight.get(discordId) === run) inflight.delete(discordId);
  });
  inflight.set(discordId, run);
  return run;
}

async function reconcileNow(discordId) {
  const desired = await desiredRoleIds(discordId);
  const managed = await effectiveManagedRoleIds();

  const member = await getGuildMember(discordId);

  if (member === null) {
    // Buyer isn't in the server yet. If they logged in we hold a guilds.join
    // token — pull them in with their roles already applied instead of failing.
    if (desired.size === 0) return { joined: false, added: [], removed: [] };
    const user = await db.getUser(discordId);
    if (!user?.access_token) {
      console.warn(`[entitlements] ${discordId} not in guild and no OAuth token stored; will retry on next reconcile`);
      return { joined: false, added: [], removed: [] };
    }
    const joined = await joinGuildWithRoles(discordId, user.access_token, [...desired]);
    if (joined) return { joined: true, added: [...desired], removed: [] };
    // 204: they were already a member after all (raced a join) — fall through
    // to a normal diff on the next call; recurse once for freshness.
    return reconcileNow(discordId);
  }

  const current = new Set(member.roles ?? []);
  const toAdd = [...desired].filter((r) => !current.has(r));
  const toRemove = [...current].filter((r) => managed.has(r) && !desired.has(r));

  for (const roleId of toAdd) await addRole(discordId, roleId);
  for (const roleId of toRemove) await removeRole(discordId, roleId);

  return { joined: false, added: toAdd, removed: toRemove };
}

// ── entitlement mutations (each ends in a reconcile) ──────────────────────────

// periodEnd null/undefined on a non-lifetime plan means the provider gave us
// nothing usable — fall back to the plan's own duration. A NULL expiry in the
// database must mean lifetime and nothing else.
export async function grant({ discordId, planId, provider, providerRef, periodEnd = null }) {
  const plan = planById(planId);
  if (!plan) {
    console.warn(`[entitlements] grant for unknown plan "${planId}" ignored`);
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
  });
  await reconcile(discordId);
  return sub;
}

// Failed payment on a renewing plan: keep access through a grace window and
// tell the buyer, instead of yanking roles the moment a card bounces.
export async function markPastDue(provider, providerRef) {
  const sub = await db.getSubscriptionByRef(provider, providerRef);
  if (!sub) return null;
  const graceUntil = now() + config.gracePeriodHours * 3600;
  await db.setSubscriptionStatus(sub.id, { status: 'past_due', graceUntil });
  const plan = planById(sub.plan_id);
  await dmUser(
    sub.discord_id,
    `⚠️ Your ${config.brand} payment for **${plan?.name ?? sub.plan_id}** didn't go through. ` +
      `You keep access until <t:${graceUntil}:f> — sort it out at ${config.publicBaseUrl} to stay in.`,
  );
  await reconcile(sub.discord_id);
  return db.getSubscriptionByRef(provider, providerRef);
}

export async function cancel(provider, providerRef) {
  const sub = await db.getSubscriptionByRef(provider, providerRef);
  if (!sub) return null;
  await db.setSubscriptionStatus(sub.id, { status: 'canceled', graceUntil: null });
  await reconcile(sub.discord_id);
  return db.getSubscriptionByRef(provider, providerRef);
}

// Cron-driven safety net (there is no long-lived process on Vercel, so this
// runs from /api/cron/reconcile): expire lapsed subscriptions, then reconcile
// both the members affected and every member still holding a live
// subscription so drift heals on its own. Lifetime rows have NULL expiry and
// are structurally immune.
export async function sweepExpirations(at = now()) {
  const lapsed = await db.lapseOverdueSubscriptions(at);
  const members = [...new Set([...lapsed.map((s) => s.discord_id), ...(await db.membersWithLiveSubscriptions())])];
  for (const discordId of members) {
    try {
      await reconcile(discordId);
    } catch (err) {
      console.error(`[sweep] reconcile ${discordId} failed: ${err.message}`);
    }
  }
  return { lapsed: lapsed.length, membersReconciled: members.length };
}
