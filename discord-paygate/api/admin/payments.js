import { sendJson, guard } from '../../src/lib/http.js';
import { ownerAuthorized } from '../../src/lib/authz.js';
import { cronAuthorized } from '../cron/reconcile.js';
import { sessionUserId } from '../../src/lib/session.js';
import { allSubscriptionsWithUsers, isEntitled, checkoutAttempts, getUser } from '../../src/db.js';
import { storesOwnedBy, everyStore, plansOf, defaultStore } from '../../src/services/stores.js';

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
  // Pre-multi-tenant rows carry store_id null (the env-configured store).
  // When a managed store has taken that guild over, attribute those legacy
  // payments to it — one server, one store, one history — while still
  // pricing them from the env catalog they were sold from.
  const def = defaultStore();
  if (def && !byId.has(null)) {
    const twin = visible.find((s) => String(s.guildId) === String(def.guildId));
    if (twin) byId.set(null, twin);
  }
  const planCache = new Map();
  const plansFor = async (store) => {
    const key = store.id ?? 'default';
    if (!planCache.has(key)) planCache.set(key, await plansOf(store));
    return planCache.get(key);
  };

  const fetchIds = visible.map((s) => s.id);
  if (byId.has(null) && !fetchIds.includes(null)) fetchIds.push(null);
  const raw = await allSubscriptionsWithUsers(fetchIds);
  const rows = [];
  for (const s of raw) {
    const sid = s.store_id === null || s.store_id === undefined ? null : Number(s.store_id);
    const store = byId.get(sid);
    if (!store) continue;
    const catalog = sid === null && def ? await plansFor(def) : await plansFor(store);
    const plan = catalog.find((p) => p.id === s.plan_id);
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

  // Checkout attempts: everyone who reached Stripe's card form, paid or not.
  // Without these an owner cannot tell "nobody clicked" from "everybody bails".
  const attemptRows = await checkoutAttempts(fetchIds);
  const nameCache = new Map();
  const nameOf = async (discordId) => {
    if (!nameCache.has(discordId)) nameCache.set(discordId, (await getUser(discordId).catch(() => null))?.username ?? null);
    return nameCache.get(discordId);
  };
  const checkouts = [];
  for (const a of attemptRows) {
    const sid = a.store_id === null || a.store_id === undefined ? null : Number(a.store_id);
    const store = byId.get(sid);
    if (!store) continue;
    const catalog = sid === null && def ? await plansFor(def) : await plansFor(store);
    checkouts.push({
      createdAt: Number(a.created_at),
      completedAt: a.completed_at === null || a.completed_at === undefined ? null : Number(a.completed_at),
      discordId: a.discord_id,
      username: await nameOf(a.discord_id),
      storeSlug: store.slug,
      storeName: store.name,
      planId: a.plan_id,
      planName: catalog.find((p) => p.id === a.plan_id)?.name ?? a.plan_id,
      amountUsd: Number(a.amount_usd ?? 0),
      discountCode: a.discount_code ?? null,
      status: a.status,
      sessionId: a.session_id,
    });
  }
  const completed = checkouts.filter((c) => c.status === 'completed').length;

  const activeMembers = new Set(rows.filter((r) => r.entitled).map((r) => r.discordId));
  sendJson(res, 200, {
    // Every store the caller owns (for the dashboard's store switcher);
    // `payments` below honours the ?store filter.
    stores: stores.map((s) => ({ id: s.id, slug: s.slug, name: s.name, status: s.status, guildId: s.guildId, isDefault: s.isDefault, notifyChannelId: s.notifyChannelId ?? null, theme: s.theme ?? null, discoverable: Boolean(s.discoverable), category: s.category ?? null })),
    totals: {
      allTimeUsd: Math.round(rows.reduce((sum, r) => sum + r.amountUsd, 0) * 100) / 100,
      payments: rows.length,
      activeMembers: activeMembers.size,
      lifetimeMembers: new Set(rows.filter((r) => r.lifetime).map((r) => r.discordId)).size,
    },
    payments: rows,
    checkouts,
    checkoutTotals: {
      started: checkouts.length,
      completed,
      abandoned: checkouts.length - completed,
      // null rather than 0 when nothing has started — "0% conversion" reads as
      // a failure, "no data yet" is the truth.
      conversionPct: checkouts.length ? Math.round((completed / checkouts.length) * 1000) / 10 : null,
    },
  });
});
