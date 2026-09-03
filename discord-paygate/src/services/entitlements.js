import { config } from '../config.js';
import * as db from '../db.js';
import { effectiveRolePlan, effectiveManagedRoleIds, guildRolesCached, resolveAgainstGuild } from './plan-config.js';
import { defaultStore, storeById, plansOf, planOf } from './stores.js';
import { getGuildMember, addRole, removeRole, joinGuildWithRoles, dmUser, postChannelMessage } from '../lib/discord.js';
import { stripeFetch, subscriptionPeriodEnd } from '../lib/stripe.js';

const now = () => Math.floor(Date.now() / 1000);
const storeKey = (store) => String(store?.id ?? 'default');
const sameStore = (sub, store) => {
  const sid = sub.store_id === null || sub.store_id === undefined ? null : Number(sub.store_id);
  return sid === (store?.id ?? null);
};

// Role mapping for a store. The default store resolves through plan-config
// (picker override > existing ids > name match); a dashboard-created store
// carries exact role ids picked during onboarding — checked against the live
// guild the same way, with the stored role NAME as the fallback, so a role
// the seller deleted and re-created does not turn every sale into a 500 loop
// with no role, no receipt and no self-heal. A roles fetch that fails leaves
// the stored ids in place and marks the mapping degraded (no removals).
async function rolePlanFor(store) {
  if (!store || store.isDefault) return effectiveRolePlan();
  const roles = store.guildId ? await guildRolesCached(store.guildId) : null;
  const map = new Map();
  const ids = [];
  for (const plan of await plansOf(store)) {
    const resolved = roles ? await resolveAgainstGuild(plan, roles, store.guildId) : null;
    const roleIds = resolved?.ids ?? plan.roleIds;
    map.set(plan.id, { roleIds, roleNames: plan.roleNames, source: resolved?.byName ? 'name' : 'store' });
    ids.push(...roleIds);
  }
  db.recordManagedRoles(ids).catch(() => {}); // removal ledger; never blocks a grant
  return { map, degraded: !roles };
}

// Role ids this store's reconciler may REMOVE: its current mapping plus the
// global ledger of everything ever grantable. Role ids are globally unique
// snowflakes, so ledger entries from other guilds can never match a role a
// member actually holds in this one.
// The roles this store SELLS, right now — the plan mapping only, without the
// cross-store managed-role ledger managedFor folds in. The comp audit asks
// this: a role another server sells is not this seller's to answer for, and
// including the ledger would have every store recording comps for every other
// store's role ids.
export async function soldRoleIdsFor(store) {
  const { map } = await rolePlanFor(store);
  const ids = new Set();
  for (const { roleIds } of map.values()) for (const id of roleIds) ids.add(String(id));
  return ids;
}

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

// Every role the member is entitled to ANYWHERE in `target`'s Discord guild —
// this store plus any other managed store (and the built-in store) bound to
// the same guild. Removals are decided against this wider set so that when two
// stores share one guild, reconciling store A never strips a role the member
// legitimately holds through store B. Additions stay per-store (see caller).
async function desiredRoleIdsInGuild(discordId, target, targetRoleMap, at = now()) {
  const all = new Set(await desiredFrom(targetRoleMap, target, discordId, at));
  if (!target.guildId) return all;
  const siblings = [];
  const def = defaultStore();
  if (def && def.guildId === target.guildId && storeKey(def) !== storeKey(target)) siblings.push(def);
  for (const row of await db.storesByGuild(target.guildId)) {
    if (storeKey(row) === storeKey(target)) continue;
    const s = await storeById(row.id);
    if (s) siblings.push(s);
  }
  for (const s of siblings) {
    const { map } = await rolePlanFor(s);
    for (const roleId of await desiredFrom(map, s, discordId, at)) all.add(roleId);
  }
  return all;
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

// `afterJoin` marks the one re-entry allowed after a guilds.join answered
// 204 ("already a member"): the second pass diffs like any other and never
// tries to join again.
async function reconcileNow(discordId, store, afterJoin = false) {
  // One mapping snapshot for BOTH the desired and managed sets — resolving
  // twice could disagree mid-reconcile (a transient roles-fetch failure on
  // one of them) and strip a role the member is entitled to.
  const { map: roleMap, degraded } = await rolePlanFor(store);
  const desired = await desiredFrom(roleMap, store, discordId);
  const managed = await managedFor(store, roleMap);

  // Throws with code 'bot_not_in_guild' when the BOT is gone from the server
  // — that is not "the buyer isn't in yet", and no join can fix it.
  const member = await getGuildMember(discordId, store.guildId);

  if (member === null) {
    // Buyer isn't in the server yet. If they logged in we hold a guilds.join
    // token — pull them in with their roles already applied instead of failing.
    if (desired.size === 0) return { joined: false, added: [], removed: [] };
    if (afterJoin) {
      // Discord just said "already a member" and now says "not a member".
      // A consistency window, or a member fetch failing for some reason other
      // than absence — either way, looping until the two agree once spun for
      // the whole function budget. One look is all it gets; the next
      // reconcile (every webhook, login and sweep) tries again.
      console.warn(`[entitlements] Discord reports ${discordId} already in guild ${store.guildId} but the member fetch still answers 404; will retry on next reconcile`);
      return { joined: false, added: [], removed: [] };
    }
    const user = await db.getUser(discordId);
    if (!user?.access_token) {
      console.warn(`[entitlements] ${discordId} not in guild ${store.guildId} and no OAuth token stored; will retry on next reconcile`);
      return { joined: false, added: [], removed: [] };
    }
    const joined = await joinGuildWithRoles(discordId, user.access_token, [...desired], store.guildId);
    if (joined) return { joined: true, added: [...desired], removed: [] };
    // 204: they were already a member after all (raced a join) — fall through
    // to a normal diff; exactly one re-entry, see `afterJoin`.
    return reconcileNow(discordId, store, true);
  }

  const current = new Set(member.roles ?? []);
  const toAdd = [...desired].filter((r) => !current.has(r));
  // A degraded mapping (guild role list unfetchable) fell back to configured
  // ids: additions can retry later, but a removal computed against it could
  // strip a role the member holds legitimately under the full mapping.
  // Removals are decided against the guild-wide desired set so a role the
  // member holds via another store in this same guild is never torn off.
  const desiredInGuild = degraded ? desired : await desiredRoleIdsInGuild(discordId, store, roleMap);
  const toRemove = degraded ? [] : [...current].filter((r) => managed.has(r) && !desiredInGuild.has(r));

  // Revocations first, and every role call isolated: one role the bot cannot
  // touch (dragged above it, deleted, a 5xx) must never cancel the rest of the
  // pass. A failed add costs nobody money; a skipped removal is free access.
  // toAdd and toRemove are disjoint (toRemove excludes desiredInGuild, a
  // superset of desired), so the order can never cost an entitled member a
  // role. One throw at the end keeps the caller's logging and the next
  // sweep's retry.
  const added = [];
  const removed = [];
  const failures = [];
  for (const roleId of toRemove) {
    try { await removeRole(discordId, roleId, store.guildId); removed.push(roleId); }
    catch (err) { failures.push(err.message); }
  }
  for (const roleId of toAdd) {
    try { await addRole(discordId, roleId, store.guildId); added.push(roleId); }
    catch (err) { failures.push(err.message); }
  }
  if (failures.length) throw new Error(failures.join('; '));

  return { joined: false, added, removed };
}

// ── entitlement mutations (each ends in a reconcile) ──────────────────────────

// periodEnd null/undefined on a non-lifetime plan means the provider gave us
// nothing usable — fall back to the plan's own duration. A NULL expiry in the
// database must mean lifetime and nothing else.
export async function grant({ discordId, planId, provider, providerRef, periodEnd = null, store = null, paidUsd = null, currency = null }) {
  const target = store ?? defaultStore();
  const plan = await planOf(target, planId);
  if (!plan) {
    console.warn(`[entitlements] grant for unknown plan "${planId}" (store ${target?.slug ?? '?'}) ignored`);
    return null;
  }
  // A NULL expiry means lifetime and nothing else. For a term plan, use the
  // provider's period end, else the plan's own duration — but never compute
  // NaN from a missing/zero durationDays (which would poison isEntitled and
  // could grant access forever). Fall back to 30 days and log loudly instead.
  let expiry;
  if (plan.lifetime) {
    expiry = null;
  } else if (periodEnd) {
    expiry = periodEnd;
  } else if (Number(plan.durationDays) > 0) {
    expiry = now() + Number(plan.durationDays) * 86400;
  } else {
    console.error(`[entitlements] plan "${planId}" (store ${target?.slug ?? '?'}) is non-lifetime with no usable durationDays; defaulting to 30 days`);
    expiry = now() + 30 * 86400;
  }
  const sub = await db.upsertSubscription({
    discordId,
    planId,
    provider,
    providerRef,
    status: 'active',
    currentPeriodEnd: expiry,
    graceUntil: null,
    storeId: target?.id ?? null,
    paidUsd,
    // The currency the sale actually happened in. Without it every row lands
    // as 'usd' and a yen store's history reads as dollars — the amount would
    // be right and its label wrong, which is the worst of the two.
    currency: currency ?? plan.currency ?? target?.currency ?? 'usd',
    // The term this sale was made on, kept on the row: the seller can delete
    // the product tomorrow (a hard DELETE) while this member keeps renewing,
    // and the dashboard reads a missing term as monthly — a $600 yearly
    // member would jump from $50 of MRR to $600 the moment the plan is gone.
    durationDays: plan.lifetime || !(Number(plan.durationDays) > 0) ? null : Number(plan.durationDays),
  });
  // Buying another option of the SAME product — Monthly to Yearly, Monthly
  // to Lifetime — is an upgrade, not a second membership: the previous
  // recurring subscription is ended at its period end, the way the buyer's
  // own cancel button does it. Different products stack; that is deliberate.
  await supersedeFamily({ discordId, plan, target, keepId: sub.id }).catch((err) => {
    console.error(`[entitlements] superseding ${discordId}'s earlier option of ${plan.variantOf ?? plan.id} failed (their cancel button still works): ${err.message}`);
  });
  try {
    await reconcile(discordId, target);
  } catch (err) {
    // The row has landed and the money is taken. A role Discord will not
    // deliver right now — a 5xx, a role dragged above the bot, a deleted
    // role — must not turn the webhook into a 500 loop that also withholds
    // the receipt, the sale ping and the discount count for as long as
    // Stripe keeps retrying. Every sweep reconciles live rows, so delivery
    // is retried within the hour until the cause is fixed; the dashboard
    // checklist names the cause.
    console.error(`[entitlements] grant ${planId} for ${discordId} (store ${target?.slug ?? 'default'}) landed but role delivery failed — the sweep retries: ${err.message}`);
  }
  return sub;
}

async function supersedeFamily({ discordId, plan, target, keepId }) {
  const family = plan.variantOf ?? plan.id;
  for (const other of await db.subscriptionsForMember(discordId)) {
    if (other.id === keepId || other.provider !== 'stripe' || !sameStore(other, target)) continue;
    if (!db.isEntitled(other) || other.cancels_at) continue;
    if (other.current_period_end === null || other.current_period_end === undefined) continue; // lifetime
    const op = await planOf(target, other.plan_id);
    if (!op || (op.variantOf ?? op.id) !== family) continue;
    const s = await stripeFetch(`/v1/subscriptions/${encodeURIComponent(other.provider_ref)}`, {
      method: 'POST',
      form: { cancel_at_period_end: 'true' },
      key: target?.stripeKey ?? config.stripe.secretKey,
    });
    await db.markSubscriptionCancelling(other.id, Number(subscriptionPeriodEnd(s) ?? other.current_period_end));
  }
}

// Failed payment on a renewing plan: keep access through a grace window and
// tell the buyer, instead of yanking roles the moment a card bounces.
export async function markPastDue(provider, providerRef) {
  const sub = await db.getSubscriptionByRef(provider, providerRef);
  if (!sub) return null;
  // A revoked row must stay revoked. 'canceled' is what a refund, a chargeback
  // and the seller's own Revoke button all write, and Stripe keeps retrying the
  // renewal invoice on the dead card afterwards — without this guard every
  // retry would open a fresh grace window and hand the role back. Coming back
  // needs an explicit re-grant (a real payment). 'expired' is deliberately not
  // here: the sweep can expire a row moments before the renewal's failure
  // lands, and that buyer should still get grace.
  if (sub.status === 'canceled') return sub;
  // One window per unpaid period, anchored to the period that was not paid
  // for rather than to the clock. Stripe retries a failing card for weeks and
  // sends invoice.payment_failed each time; re-anchoring on every retry
  // turned 72 hours into three weeks, and DMed a fresh deadline each time.
  if (sub.status === 'past_due' && sub.grace_until) return sub;
  const store = await storeById(sub.store_id);
  const periodEnd = Number(sub.current_period_end);
  const graceUntil = Math.max(Number.isFinite(periodEnd) ? periodEnd : 0, now()) + config.gracePeriodHours * 3600;
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

// ── the drift audit ──────────────────────────────────────────────────────────
//
// A ROLE DUES DELIVERS IS A ROLE DUES OWNS. While a role id sits in the
// managed ledger, holding it without a live entitlement is a state Dues
// corrects — for the people Dues has a record of.
//
// The trick this closes: a seller revokes a paying member here, which drops
// their live-member count and keeps them under their Dues plan limit, and
// then hands the same paid role straight back inside Discord. The buyer keeps
// access, the seller pays for a smaller plan than they are using. Every
// route into it — the Revoke button, a refund, a chargeback, a lapse — ends
// the same way: a dead row plus a managed role, so the audit does not care
// which one it was.
//
// It used to work because nothing ever looked again. membersWithLiveSubscriptions
// revisits a dead row for seven days (that window heals a REMOVAL CALL THAT
// FAILED, and a week is the right size for that), and after it nothing in this
// repo asked about that person again. A role re-added by hand on day eight was
// permanent. There is no deadline on someone re-adding a role, so there can be
// no deadline on the revisit either.
//
// WHAT IT DOES NOT DO: someone who never bought anything, handed the role by
// the seller — a moderator, a friend, a giveaway winner — is left alone.
// Twice over. Dues cannot see them (listing a guild's members needs the
// GUILD_MEMBERS privileged intent, which this app does not enable — see
// scripts/presence.js, which identifies with intents: 0 unless welcome cards
// are switched on and documents the portal toggle that gates it), and even
// with the intent, stripping a role from someone Dues never sold to would be
// Dues deleting the seller's own decision inside the seller's own server.
// Dues owns what Dues delivered, to whom Dues delivered it.
//
// So gifting has to be the CONVENIENT path, not just an available one: the
// dashboard's Add member writes a real row — counted by countLiveMembers,
// priced at zero revenue, revocable — and the alert below names it, because a
// seller who is corrected without being told where to go is a seller who
// leaves.
//
// BOUNDED like the crypto backfill (services/backfill.js): a batch per run and
// a wall-clock budget, least recently audited first. This runs inside the
// hourly cron's own time limit (60s, vercel.json) alongside the unbounded live
// sweep, the webhook heal and both sale backfills, so it gets a small, fixed
// slice of it — one member fetch each, ~40 of them, and it stops at 8 seconds
// however few it got through. Nothing is lost by stopping: the batch is
// ordered oldest-audit-first, so whoever was skipped is at the head of the
// next hour's queue.
const AUDIT_BATCH = 40;
const AUDIT_BUDGET_MS = 8_000;

// The seller-facing alarm, in the channel the sale ping lands in. Silently
// stripping a role a seller may have added on purpose is how a platform loses
// a seller; this says what moved, to whom, and what to do instead.
async function alertRoleTakenBack(store, discordId, roleIds) {
  if (!store?.notifyChannelId) return;
  const user = await db.getUser(discordId).catch(() => null);
  const who = user?.username ? `@${user.username}` : `<@${discordId}>`;
  const roles = roleIds.map((id) => `<@&${id}>`).join(' ');
  await postChannelMessage(store.notifyChannelId, {
    embeds: [{
      title: '⚠️ A paid role was added outside Dues',
      description:
        `**${who}** was holding ${roles} in this server with no membership in **${store.name ?? config.brand}**, ` +
        `so Dues took ${roleIds.length === 1 ? 'it' : 'them'} back — a role Dues delivers is a role Dues manages.\n\n` +
        'If you meant to give them access, use **Members → Add member**. That is a real membership: it shows on your ' +
        'dashboard, you can revoke it, and it counts towards your Dues plan. Adding the role by hand in Discord does ' +
        'none of that, and will be undone again.',
      color: 0xed4245,
      thumbnail: { url: 'https://dues.gg/icon-192.png' },
      footer: { text: store.name ?? config.brand },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function auditDrift({ at, seen, guildsWithoutBot, batch, budgetMs }) {
  const started = Date.now();
  const candidates = await db.formerMembersToAudit({ limit: batch, at });
  const asked = [];
  let checked = 0;
  let corrected = 0;
  for (const pair of candidates) {
    if (Date.now() - started > budgetMs) break;
    // Audited, whatever the answer was — the same rule the crypto backfill
    // marks its batch by. A member whose removal Discord keeps refusing (the
    // paid role dragged above the bot) would otherwise sit at the head of
    // this queue for ever and starve every other former member out of it.
    asked.push(pair);
    const key = `${pair.storeId ?? 'default'}:${pair.discordId}`;
    if (seen.has(key)) continue; // the sweep above already reconciled them this run
    checked++;
    try {
      const store = await storeById(pair.storeId);
      if (!store) continue;
      if (guildsWithoutBot.has(String(store.guildId))) continue;
      const { removed } = await reconcile(pair.discordId, store);
      if (!removed.length) continue;
      corrected++;
      console.warn(`[sweep] ${pair.discordId} held ${removed.join(', ')} in store ${pair.storeId ?? 'default'} with no membership — taken back, seller alerted`);
      await alertRoleTakenBack(store, pair.discordId, removed);
    } catch (err) {
      if (err.code === 'bot_not_in_guild') {
        guildsWithoutBot.add(err.guildId);
        continue;
      }
      console.error(`[sweep] audit of ${pair.discordId} (store ${pair.storeId ?? 'default'}) failed: ${err.message}`);
    }
  }
  await db.markMembersAudited(asked, at).catch((err) => {
    // Without this the same batch is re-audited next run for ever and the
    // backlog behind it never moves. It is worth saying out loud.
    console.error(`[sweep] recording the audited batch failed: ${err.message}`);
  });
  return { checked, corrected, ...(candidates.length >= batch ? { auditBacklog: true } : {}) };
}

// Cron-driven safety net (there is no long-lived process on Vercel, so this
// runs from /api/cron/reconcile): expire lapsed subscriptions, then reconcile
// every (store, member) pair affected or still live so drift heals on its
// own. Lifetime rows have NULL expiry and are structurally immune. Then the
// drift audit above takes its bounded turn through the former members.
export async function sweepExpirations(at = now(), { auditBatch = AUDIT_BATCH, auditBudgetMs = AUDIT_BUDGET_MS } = {}) {
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
  // A guild the bot has been kicked from fails every member the same way.
  // Name it once, skip the store's remaining members this run (two Discord
  // calls each, all doomed), and carry the guild in the result so the cron
  // response shows the outage — nobody reads the log of an hourly job.
  const guildsWithoutBot = new Set();
  for (const { storeId, discordId } of pairs.values()) {
    try {
      const store = await storeById(storeId);
      if (!store) continue;
      if (guildsWithoutBot.has(String(store.guildId))) continue;
      await reconcile(discordId, store);
      reconciled++;
    } catch (err) {
      if (err.code === 'bot_not_in_guild') {
        guildsWithoutBot.add(err.guildId);
        console.error(`[sweep] the bot is not in guild ${err.guildId} (store ${storeId ?? 'default'}): no member there can gain or lose a role until it is re-invited; skipping that store's other members this run`);
        continue;
      }
      console.error(`[sweep] reconcile ${discordId} (store ${storeId ?? 'default'}) failed: ${err.message}`);
    }
  }
  // An add-on to the sweep, and never allowed to break it: the expiries above
  // are what keeps paid access honest, and they have already landed.
  const drift = await auditDrift({ at, seen: pairs, guildsWithoutBot, batch: auditBatch, budgetMs: auditBudgetMs })
    .catch((err) => {
      console.error(`[sweep] drift audit failed: ${err.message}`);
      return { checked: 0, corrected: 0, failed: err.message };
    });
  return {
    lapsed: lapsed.length,
    membersReconciled: reconciled,
    drift,
    ...(guildsWithoutBot.size ? { guildsWithoutBot: [...guildsWithoutBot] } : {}),
  };
}
