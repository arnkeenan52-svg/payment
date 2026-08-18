import { sendJson, guard } from '../../src/lib/http.js';
import { ownerAuthorized } from '../../src/lib/authz.js';
import { cronAuthorized } from '../cron/reconcile.js';
import { sessionUserId } from '../../src/lib/session.js';
import { allSubscriptionsWithUsers, isEntitled } from '../../src/db.js';
import { storesOwnedBy, everyStore, plansOf } from '../../src/services/stores.js';

// Payments timeline + totals, scoped to the stores the caller owns. The
// platform owner (OWNER_DISCORD_ID) and the cron secret see everything.
// Amounts come from each store's plan catalog (what checkout charges);
// refunds made in the Stripe dashboard are not tracked here.
export default guard(async function handler(req, res) {
  const uid = sessionUserId(req);
  const platformAdmin = ownerAuthorized(req) || cronAuthorized(req);
  if (!platformAdmin && !uid) {
    sendJson(res, 401, { error: 'sign in first' });
    return;
  }

  const stores = platformAdmin ? await everyStore() : await storesOwnedBy(uid);
  if (!stores.length) {
    sendJson(res, 403, { error: 'no stores on this account' });
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const slugFilter = url.searchParams.get('store');
  const visible = slugFilter ? stores.filter((s) => s.slug === slugFilter) : stores;
  if (!visible.length) {
    sendJson(res, 403, { error: 'not your store' });
    return;
  }

  const byId = new Map(visible.map((s) => [s.id, s]));
  const planCache = new Map();
  const plansFor = async (store) => {
    const key = store.id ?? 'default';
    if (!planCache.has(key)) planCache.set(key, await plansOf(store));
    return planCache.get(key);
  };

  const raw = await allSubscriptionsWithUsers(visible.map((s) => s.id));
  const rows = [];
  for (const s of raw) {
    const sid = s.store_id === null || s.store_id === undefined ? null : Number(s.store_id);
    const store = byId.get(sid);
    if (!store) continue;
    const plan = (await plansFor(store)).find((p) => p.id === s.plan_id);
    rows.push({
      createdAt: Number(s.created_at),
      discordId: s.discord_id,
      username: s.username ?? null,
      storeSlug: store.slug,
      storeName: store.name,
      planId: s.plan_id,
      planName: plan?.name ?? s.plan_id,
      amountUsd: plan?.priceUsd ?? 0,
      provider: s.provider,
      status: s.status,
      entitled: isEntitled(s),
      lifetime: s.status === 'active' && s.current_period_end === null,
    });
  }

  const activeMembers = new Set(rows.filter((r) => r.entitled).map((r) => r.discordId));
  sendJson(res, 200, {
    // Every store the caller owns (for the dashboard's store switcher);
    // `payments` below honours the ?store filter.
    stores: stores.map((s) => ({ id: s.id, slug: s.slug, name: s.name, status: s.status, guildId: s.guildId, isDefault: s.isDefault })),
    totals: {
      allTimeUsd: Math.round(rows.reduce((sum, r) => sum + r.amountUsd, 0) * 100) / 100,
      payments: rows.length,
      activeMembers: activeMembers.size,
      lifetimeMembers: new Set(rows.filter((r) => r.lifetime).map((r) => r.discordId)).size,
    },
    payments: rows,
  });
});
