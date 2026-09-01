import { sendJson, guard } from '../../src/lib/http.js';
import { ownerAuthorized } from '../../src/lib/authz.js';
import { cronAuthorized } from '../cron/reconcile.js';
import { sessionUserId } from '../../src/lib/session.js';
import { allSubscriptionsWithUsers, isEntitled, checkoutAttempts, getUser, countStoreFollowers, getStoreMediaMeta, reviewSummary } from '../../src/db.js';
import { storesOwnedBy, everyStore, plansOf, defaultStore, bannerFor } from '../../src/services/stores.js';
import { canCustomise } from '../../src/services/billing.js';

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
  // — but only for the platform operator. Those legacy rows are the
  // platform's own early ledger, and the twin is created by whichever Discord
  // admin of that guild runs the onboarding wizard, which is deliberately
  // open (see the e2e scenario for the built-in server). Attributing them to
  // any twin handed a guild moderator the platform's payment history.
  const def = defaultStore();
  if (def && platformAdmin && !byId.has(null)) {
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
      // A manual grant is free by definition; the list-price fallback is for
      // provider events that arrived without an amount, not for gifts.
      amountUsd: s.paid_usd !== null && s.paid_usd !== undefined ? Number(s.paid_usd) : s.provider === 'manual' ? 0 : plan?.priceUsd ?? 0,
      // The currency THIS sale happened in, off the row itself — not the
      // store's current one. History does not get re-denominated.
      currency: s.currency ?? store.currency ?? 'usd',
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
      currency: a.currency ?? store.currency ?? 'usd',
      discountCode: a.discount_code ?? null,
      status: a.status,
      sessionId: a.session_id,
    });
  }
  const completed = checkouts.filter((c) => c.status === 'completed').length;

  // The owner's own view of each store they run. The follower number here is
  // the EXACT count, 0 included — the storefront hides small numbers, but the
  // person running the store is owed the truth. Still a count: the dashboard
  // never learns who any of them are.
  const storeRows = await Promise.all(
    stores.map(async (s) => {
      const managed = s.id !== null && s.id !== undefined;
      const banner = await bannerFor(s);
      const bannerMedia = managed ? await getStoreMediaMeta(s.id, 'banner') : null;
      return {
        id: s.id, slug: s.slug, name: s.name, status: s.status, guildId: s.guildId, isDefault: s.isDefault,
        // whether a key EXISTS — never the key, and never anything derived
        // from it. The setup checklist used to hard-code this as true.
        hasStripeKey: Boolean(s.hasOwnStripeKey),
        notifyChannelId: s.notifyChannelId ?? null, theme: s.theme ?? null,
        discoverable: Boolean(s.discoverable), category: s.category ?? null,
        description: s.description ?? null,
        // bannerUrl stays the PASTED link the settings form owns; the resolved
        // one (upload wins) and its kind ride alongside for the preview.
        bannerUrl: s.bannerUrl ?? null,
        bannerImageUrl: banner.url, bannerKind: banner.kind,
        hasBannerUpload: Boolean(bannerMedia),
        about: s.about ?? null, links: s.links ?? null, showMembers: Boolean(s.showMembers),
        dashboardPrefs: s.dashboardPrefs ?? null,
        followers: managed ? await countStoreFollowers(s.id) : null,
        reviewsOn: Boolean(s.reviewsOn),
        creatorName: s.creatorName ?? null,
        team: s.team ?? null,
        teamHeading: s.teamHeading ?? null,
        // What this store prices in. Every money figure the dashboard draws is
        // denominated in it, so it has to arrive with the payload rather than
        // be assumed.
        currency: s.currency ?? 'usd',
        // The crypto payout wallet, in full. It is a PUBLIC address — the
        // thing a buyer would send to — not a secret, and the settings form
        // has to be able to show the seller what is currently saved. What is
        // never sent anywhere is the private key, which Dues has never had.
        cryptoWallet: s.cryptoWallet ?? null,
        cryptoChain: s.cryptoChain ?? null,
        // The seller's own rating, and the real one: this is the same COUNT
        // and mean the storefront draws, reported even while the switch is
        // off, because turning the display off must not blind the seller to
        // what their buyers actually said.
        reviews: managed ? await reviewSummary(s.id) : { count: 0, average: null },
      };
    }),
  );

  const activeMembers = new Set(rows.filter((r) => r.entitled).map((r) => r.discordId));
  sendJson(res, 200, {
    // Whether this owner's plan includes a custom storefront look. The Store
    // section reads it to show the Appearance card as locked instead of
    // letting a free owner design a theme the save would then refuse.
    canCustomise: platformAdmin || (await canCustomise(uid)),
    // Every store the caller owns (for the dashboard's store switcher);
    // `payments` below honours the ?store filter.
    // This payload is what the dashboard's settings forms re-render from
    // after every save — it must carry EVERY editable store field, or a
    // saved value comes back looking blank and the next save wipes it.
    stores: storeRows,
    totals: {
      // One number per currency, never one number across them. An owner with a
      // USD store and a DKK store used to get their sum presented as dollars.
      byCurrency: rows.reduce((acc, r) => {
        const c = r.currency ?? 'usd';
        acc[c] = Math.round(((acc[c] ?? 0) + r.amountUsd) * 100) / 100;
        return acc;
      }, {}),
      // Kept for the headline figure, and only meaningful when the rows share
      // one currency — `currency` below says whether they do.
      allTimeUsd: Math.round(rows.reduce((sum, r) => sum + r.amountUsd, 0) * 100) / 100,
      // The single currency every row is in, or null when they differ. The
      // dashboard refuses to print a total it cannot name.
      currency: (() => {
        const all = new Set(rows.map((r) => r.currency ?? 'usd'));
        return all.size === 1 ? [...all][0] : null;
      })(),
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
