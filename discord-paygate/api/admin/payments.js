import { planById } from '../../src/config.js';
import { sendJson, guard } from '../../src/lib/http.js';
import { ownerAuthorized } from '../../src/lib/authz.js';
import { cronAuthorized } from '../cron/reconcile.js';
import { sessionUserId } from '../../src/lib/session.js';
import { allSubscriptionsWithUsers, isEntitled } from '../../src/db.js';

// Owner dashboard data: the all-time payments timeline and its totals.
// Amounts come from the plan catalog (what checkout charges); refunds made in
// the Stripe dashboard are not tracked here.
export default guard(async function handler(req, res) {
  if (!(ownerAuthorized(req) || cronAuthorized(req))) {
    sendJson(res, sessionUserId(req) ? 403 : 401, { error: 'owner only' });
    return;
  }
  const rows = (await allSubscriptionsWithUsers()).map((s) => {
    const plan = planById(s.plan_id);
    return {
      createdAt: Number(s.created_at),
      discordId: s.discord_id,
      username: s.username ?? null,
      planId: s.plan_id,
      planName: plan?.name ?? s.plan_id,
      amountUsd: plan?.priceUsd ?? 0,
      provider: s.provider,
      status: s.status,
      entitled: isEntitled(s),
      lifetime: s.status === 'active' && s.current_period_end === null,
    };
  });
  const activeMembers = new Set(rows.filter((r) => r.entitled).map((r) => r.discordId));
  sendJson(res, 200, {
    totals: {
      allTimeUsd: Math.round(rows.reduce((sum, r) => sum + r.amountUsd, 0) * 100) / 100,
      payments: rows.length,
      activeMembers: activeMembers.size,
      lifetimeMembers: new Set(rows.filter((r) => r.lifetime).map((r) => r.discordId)).size,
    },
    payments: rows,
  });
});
