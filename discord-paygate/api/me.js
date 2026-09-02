import { config } from '../src/config.js';
import { sendJson, guard } from '../src/lib/http.js';
import { sessionUserId } from '../src/lib/session.js';
import { getUser, subscriptionsForMember, isEntitled, storesByOwner, storesFollowedBy } from '../src/db.js';
import { storeById, planOf } from '../src/services/stores.js';

export default guard(async function handler(req, res) {
  const uid = sessionUserId(req);
  if (!uid) {
    sendJson(res, 200, { loggedIn: false });
    return;
  }
  const user = await getUser(uid);
  // Lapsed rows are included too (entitled: false) so the storefront can show
  // "expired on …" on a plan card instead of pretending it was never bought.
  const storeCache = new Map();
  const storeFor = async (sid) => {
    const key = sid ?? 'default';
    if (!storeCache.has(key)) storeCache.set(key, await storeById(sid ?? null));
    return storeCache.get(key);
  };
  const subs = [];
  for (const s of await subscriptionsForMember(uid)) {
    const store = await storeFor(s.store_id === null || s.store_id === undefined ? null : Number(s.store_id));
    const plan = store ? await planOf(store, s.plan_id) : null;
    subs.push({
      planId: s.plan_id,
      planName: plan?.name ?? s.plan_id,
      priceUsd: plan?.priceUsd ?? null,
      roleNames: plan?.roleNames ?? [],
      storeSlug: store?.slug ?? null,
      storeName: store?.name ?? null,
      provider: s.provider,
      // The account page cancels by this ref; the server re-checks ownership
      // against the session before touching Stripe.
      ref: s.provider_ref,
      status: s.status,
      entitled: isEntitled(s),
      lifetime: s.status === 'active' && s.current_period_end === null,
      currentPeriodEnd: s.current_period_end === null ? null : Number(s.current_period_end),
      graceUntil: s.grace_until === null ? null : Number(s.grace_until),
      cancelsAt: s.cancels_at === null || s.cancels_at === undefined ? null : Number(s.cancels_at),
      // Recurring, live, and not already winding down — the only shape that
      // can be cancelled.
      cancellable:
        s.provider === 'stripe' &&
        s.status !== 'canceled' &&
        !s.cancels_at &&
        s.current_period_end !== null &&
        s.current_period_end !== undefined,
      // What Stripe actually charged (discounts applied); null on old rows.
      paidUsd: s.paid_usd === null || s.paid_usd === undefined ? null : Number(s.paid_usd),
      currency: s.currency ?? null,
      createdAt: Number(s.created_at),
    });
  }
  sendJson(res, 200, {
    loggedIn: true,
    discordId: uid,
    username: user?.username ?? null,
    isOwner: Boolean(config.ownerDiscordId) && uid === config.ownerDiscordId,
    // Runs at least one store — gates the Dashboard nav link for sellers.
    seller: (await storesByOwner(uid)).length > 0,
    // The slugs THIS caller follows, so a store page can render its own
    // button in the right state. Caller-scoped: the public payload carries
    // follower counts, never who they are.
    following: await storesFollowedBy(uid),
    subscriptions: subs,
  });
});
