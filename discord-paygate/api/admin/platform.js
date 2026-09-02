// The platform owner's bird's-eye view: every account that has signed in,
// every store anyone has set up, and the topline numbers across all of them.
//
// Gate: OWNER_DISCORD_ID only. This is stricter than /api/admin/payments —
// a store owner sees their own stores there, but this endpoint spans every
// tenant's buyers and owners, so nobody else gets any of it. The user rows
// come from allUsersSafe, which never selects the OAuth token columns.

import { config } from '../../src/config.js';
import { sendJson, guard } from '../../src/lib/http.js';
import { ownerAuthorized } from '../../src/lib/authz.js';
import { sessionUserId } from '../../src/lib/session.js';
import { allUsersSafe, allPlatformBilling, allSubscriptionsWithUsers, checkoutAttempts, isEntitled } from '../../src/db.js';
import { everyStore, defaultStore, plansOf } from '../../src/services/stores.js';
import { tierById, tierStillPaid } from '../../src/services/billing.js';

export default guard(async function handler(req, res) {
  if (!await sessionUserId(req)) return sendJson(res, 401, { error: 'sign in first' });
  if (!await ownerAuthorized(req)) return sendJson(res, 403, { error: 'platform owner only' });

  const stores = await everyStore();
  const def = defaultStore();
  const subs = await allSubscriptionsWithUsers(null);
  const attempts = await checkoutAttempts(null, { limit: 5000 });
  const userRows = await allUsersSafe({ limit: 2000 });
  const billingRows = await allPlatformBilling();

  // Price every subscription from its store's catalog — the same rule the
  // per-store payments endpoint uses. Legacy rows (store_id null) belong to
  // the env-configured default store.
  const planCache = new Map();
  const plansFor = async (store) => {
    const key = store.id ?? 'default';
    if (!planCache.has(key)) planCache.set(key, await plansOf(store).catch(() => []));
    return planCache.get(key);
  };
  const storeOf = (sid) => {
    if (sid === null || sid === undefined) {
      if (!def) return null;
      return stores.find((s) => String(s.guildId) === String(def.guildId)) ?? def;
    }
    return stores.find((s) => s.id === Number(sid)) ?? null;
  };

  const perStore = new Map(); // store key -> { revenue, buyers:Set, live:Set }
  const perUser = new Map();  // discord_id -> { spent, memberships, entitled }
  let gmv = 0;
  for (const s of subs) {
    const sid = s.store_id === null || s.store_id === undefined ? null : Number(s.store_id);
    const store = storeOf(sid);
    const catalog = store ? await plansFor(sid === null && def ? def : store) : [];
    // What was CHARGED when the row knows it; the list price only for rows
    // that predate paid_usd; and a manual grant is a gift — 0 revenue here,
    // exactly as the seller's own dashboard prices it.
    const paid = s.paid_usd === null || s.paid_usd === undefined ? null : Number(s.paid_usd);
    const amount = s.provider === 'manual' ? 0 : Number.isFinite(paid) ? paid : (catalog.find((p) => p.id === s.plan_id)?.priceUsd ?? 0);
    gmv += amount;
    const skey = store ? store.id ?? 'default' : 'orphan';
    const st = perStore.get(skey) ?? { revenue: 0, buyers: new Set(), live: new Set() };
    st.revenue += amount;
    st.buyers.add(s.discord_id);
    if (isEntitled(s)) st.live.add(s.discord_id);
    perStore.set(skey, st);
    const u = perUser.get(s.discord_id) ?? { spent: 0, memberships: 0, entitled: false };
    u.spent += amount;
    u.memberships += 1;
    u.entitled = u.entitled || isEntitled(s);
    perUser.set(s.discord_id, u);
  }

  const sellerIds = new Set(stores.map((s) => s.ownerDiscordId).filter(Boolean));
  const tierOf = new Map(billingRows.map((r) => [r.owner_discord_id, tierStillPaid(r) ? tierById(r.tier) : null]));
  const mrrUsd = [...tierOf.values()].reduce((sum, t) => sum + (t?.priceUsd ?? 0), 0);

  const storeRows = stores.map((s) => {
    const agg = perStore.get(s.id ?? 'default') ?? { revenue: 0, buyers: new Set(), live: new Set() };
    return {
      id: s.id ?? null,
      slug: s.slug,
      name: s.name,
      status: s.status ?? 'live',
      guildId: s.guildId ?? null,
      ownerDiscordId: s.ownerDiscordId ?? null,
      ownerUsername: userRows.find((u) => u.discord_id === s.ownerDiscordId)?.username ?? null,
      ownerTier: tierOf.get(s.ownerDiscordId)?.name ?? 'Free',
      members: agg.live.size,
      buyers: agg.buyers.size,
      revenueUsd: Math.round(agg.revenue * 100) / 100,
      createdAt: s.createdAt ? Number(s.createdAt) : null,
    };
  });

  const users = userRows.map((u) => ({
    discordId: u.discord_id,
    username: u.username ?? null,
    joinedAt: Number(u.created_at),
    lastSeenAt: Number(u.updated_at),
    seller: sellerIds.has(u.discord_id),
    memberships: perUser.get(u.discord_id)?.memberships ?? 0,
    entitled: perUser.get(u.discord_id)?.entitled ?? false,
    spentUsd: Math.round((perUser.get(u.discord_id)?.spent ?? 0) * 100) / 100,
  }));

  const completedAttempts = attempts.filter((a) => a.status === 'completed').length;
  sendJson(res, 200, {
    totals: {
      users: users.length,
      sellers: sellerIds.size,
      stores: stores.length,
      storesLive: storeRows.filter((s) => s.status === 'live').length,
      storesDraft: storeRows.filter((s) => s.status !== 'live').length,
      buyers: perUser.size,
      activeMembers: [...perUser.values()].filter((u) => u.entitled).length,
      allTimeUsd: Math.round(gmv * 100) / 100,
      checkoutsStarted: attempts.length,
      checkoutsCompleted: completedAttempts,
      payingOwners: [...tierOf.values()].filter(Boolean).length,
      mrrUsd: Math.round(mrrUsd * 100) / 100,
    },
    stores: storeRows,
    users,
  });
});
