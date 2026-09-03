// THE COMP AUDIT — roles handed out by hand, and the plan that meters them.
//
// The hole it closes. A store's plan is priced on members, and until now a
// member meant a row in `subscriptions`: somebody who checked out. So a seller
// could carry people the plan was not paying for by never letting them check
// out at all — add the role in Discord yourself, take the money somewhere
// else, or cancel a payment and hand the role straight back. The drift audit
// in entitlements.js already catches the last of those, because a cancelled
// row is still a row and the pair stays in its queue for ever. The first two
// left no trace anywhere in this database.
//
// How it is seen. Discord's audit log, action type 25 (MEMBER_ROLE_UPDATE),
// which reports every role change with the actor who made it. That needs the
// ordinary View Audit Log permission, in the invite. The obvious alternative —
// list the guild's members and diff them against the entitlement table — needs
// the privileged GUILD_MEMBERS intent, approved per application by Discord and
// gated behind bot verification past 100 servers, which is a product-level
// dependency this does not want. The audit log also says strictly more: not
// just that a role is held, but who gave it and when.
//
// What it is NOT. It is not an accusation and it does not take anything away.
// Comping a moderator, a friend, a giveaway winner, a refunded customer you
// want to keep — all normal, all a seller's own business in a seller's own
// server, and Dues has no standing to overrule any of it. What the audit does
// is make those people COUNT toward the plan, which is the honest rule: a plan
// meters people holding the roles you sell, however they came to hold them.
// And it shows the seller exactly who, so a role given by accident can be
// taken back.
//
// Roles the BOT granted are never recorded: the actor on those entries is the
// Dues application itself, and those members are already in `subscriptions`.

import * as db from '../db.js';
import { guildRoleAuditLog, botUserId } from '../lib/discord.js';
import { soldRoleIdsFor } from './entitlements.js';
import { storesToCompAudit } from './stores.js';

// One page of audit log per store per pass, a handful of stores, a few
// seconds. The cron runs hourly and the cursor makes every pass resumable, so
// there is no reason for any single run to be long. Entries live 45 days,
// which is the real deadline this has to beat, and it beats it by weeks.
const STORE_BATCH = 8;
const BUDGET_MS = 6_000;

// The actor id Discord stamps on entries the bot caused. Asked of Discord
// (src/lib/discord.js botUserId) rather than assumed from the application id:
// without the right value here, every role Dues grants is logged as a comp the
// moment it is granted, and every paying member is counted twice.

// One store's pass. Reads forward from the stored cursor, records what a human
// added and clears what anybody removed, then advances the cursor to the
// newest entry it saw. Returns what changed, for the cron's response.
export async function auditStoreComps(store, { at = Math.floor(Date.now() / 1000) } = {}) {
  const storeId = store?.id ?? null;
  if (storeId === null || !store.guildId) return { recorded: 0, cleared: 0, skipped: 'no guild' };

  // Only roles this store actually SELLS. The global managed-role ledger is
  // deliberately not used here: it spans every store the platform has ever
  // seen, and a role another server sells is not this seller's to answer for.
  const sold = await soldRoleIdsFor(store);
  await db.pruneCompedGrants(storeId, [...sold]);
  if (!sold.size) {
    await db.updateStore(storeId, { auditCheckedAt: at, auditBlocked: 0 });
    return { recorded: 0, cleared: 0, skipped: 'sells no roles' };
  }

  const { entries, blocked } = await guildRoleAuditLog(store.guildId, { after: store.auditCursor ?? null });
  if (blocked) {
    // Invited before View Audit Log was in the invite, or the permission was
    // taken away. Recorded rather than retried into: the seller has to
    // re-invite the bot, and the dashboard says so.
    await db.updateStore(storeId, { auditBlocked: 1, auditCheckedAt: at });
    return { recorded: 0, cleared: 0, blocked: true };
  }

  const me = await botUserId();
  const owner = store.ownerDiscordId ? String(store.ownerDiscordId) : null;
  let recorded = 0;
  let cleared = 0;
  let newest = store.auditCursor ? String(store.auditCursor) : null;

  // Discord returns newest first; walk oldest first so a later removal in the
  // same page wins over an earlier add of the same role.
  for (const entry of [...entries].reverse()) {
    const id = String(entry.id ?? '');
    // Snowflakes are time-ordered and numeric, so "newest" is the largest —
    // string compare would put "9" after "10". BigInt, because a snowflake
    // does not survive a double.
    if (id && (!newest || BigInt(id) > BigInt(newest))) newest = id;
    const target = entry.target_id ? String(entry.target_id) : null;
    if (!target) continue;
    // Our own grants and revocations, and the seller's own roles in their own
    // server — neither is a comp, and the seller never counts against the plan
    // that bills them.
    if (me && String(entry.user_id ?? '') === me) continue;
    if (owner && target === owner) continue;

    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const roles = Array.isArray(change?.new_value) ? change.new_value : [];
      for (const role of roles) {
        const roleId = role?.id ? String(role.id) : null;
        if (!roleId || !sold.has(roleId)) continue;
        if (change.key === '$add') {
          await db.recordCompedGrant({ storeId, discordId: target, roleId, grantedBy: entry.user_id ?? null, at });
          recorded++;
        } else if (change.key === '$remove') {
          await db.clearCompedGrant({ storeId, discordId: target, roleId });
          cleared++;
        }
      }
    }
  }

  await db.updateStore(storeId, {
    auditCursor: newest,
    auditBlocked: 0,
    auditCheckedAt: at,
  });
  return { recorded, cleared, entries: entries.length };
}

// The cron's turn through the stores. Bounded by count and by clock, rotating
// on audit_checked_at so a budget that runs out resumes rather than starves.
export async function auditComps({ batch = STORE_BATCH, budgetMs = BUDGET_MS, at = Math.floor(Date.now() / 1000) } = {}) {
  const started = Date.now();
  // Hydrated: the audit reads guildId, ownerDiscordId and auditCursor, and
  // the raw rows carry those as snake_case.
  const stores = await storesToCompAudit(batch);
  let recorded = 0;
  let cleared = 0;
  let checked = 0;
  const blocked = [];
  for (const store of stores) {
    if (Date.now() - started > budgetMs) break;
    checked++;
    try {
      const r = await auditStoreComps(store, { at });
      recorded += r.recorded ?? 0;
      cleared += r.cleared ?? 0;
      if (r.blocked) blocked.push(store.slug);
    } catch (err) {
      // A store whose guild is gone, or a transient Discord failure. Stamp it
      // anyway so it goes to the back of the rotation instead of holding the
      // front of the queue against every other store.
      console.error(`[comps] audit of ${store.slug} failed: ${err.message}`);
      await db.updateStore(store.id, { auditCheckedAt: at }).catch(() => {});
    }
  }
  return { checked, recorded, cleared, ...(blocked.length ? { blocked } : {}) };
}

// STORES THAT PREDATE stripe_account_id. Their key was saved before the column
// existed, so the group they belong to is unknown until somebody asks Stripe.
// One bounded pass per cron run fills them in; after that the id is written at
// save time and this finds nothing. A key that no longer works is left alone —
// the store has bigger problems and the doctor already reports them.
export async function backfillStripeAccounts({ limit = 10 } = {}) {
  const { storesMissingStripeAccountId, updateStore } = await import('../db.js');
  const { storeById } = await import('./stores.js');
  const { stripeFetch } = await import('../lib/stripe.js');
  const rows = await storesMissingStripeAccountId(limit);
  let filled = 0;
  for (const row of rows) {
    try {
      // Through storeById so the sealed key is opened by the one place that
      // knows how; the raw row only carries the ciphertext.
      const store = await storeById(row.id);
      if (!store?.stripeKey || store.stripeKeyBroken) continue;
      const account = await stripeFetch('/v1/account', { key: store.stripeKey });
      if (!account?.id) continue;
      await updateStore(row.id, { stripeAccountId: String(account.id) });
      filled++;
    } catch (err) {
      console.error(`[comps] stripe account backfill for store ${row.id} failed: ${err.message}`);
    }
  }
  return { filled, remaining: Math.max(0, rows.length - filled) };
}
