import { config, planById } from '../src/config.js';
import { sendJson, guard } from '../src/lib/http.js';
import { sessionUserId } from '../src/lib/session.js';
import { getUser, subscriptionsForMember, isEntitled } from '../src/db.js';

export default guard(async function handler(req, res) {
  const uid = sessionUserId(req);
  if (!uid) {
    sendJson(res, 200, { loggedIn: false });
    return;
  }
  const user = await getUser(uid);
  // Lapsed rows are included too (entitled: false) so the storefront can show
  // "expired on …" on a plan card instead of pretending it was never bought.
  const subs = (await subscriptionsForMember(uid)).map((s) => {
    const plan = planById(s.plan_id);
    return {
      planId: s.plan_id,
      planName: plan?.name ?? s.plan_id,
      priceUsd: plan?.priceUsd ?? null,
      roleNames: plan?.roleNames ?? [],
      provider: s.provider,
      status: s.status,
      entitled: isEntitled(s),
      lifetime: s.status === 'active' && s.current_period_end === null,
      currentPeriodEnd: s.current_period_end === null ? null : Number(s.current_period_end),
      graceUntil: s.grace_until === null ? null : Number(s.grace_until),
      createdAt: Number(s.created_at),
    };
  });
  sendJson(res, 200, {
    loggedIn: true,
    discordId: uid,
    username: user?.username ?? null,
    isOwner: Boolean(config.ownerDiscordId) && uid === config.ownerDiscordId,
    subscriptions: subs,
  });
});
