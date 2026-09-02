// Buyer-facing subscription controls. Today that means one thing: cancelling a
// recurring membership without having to email the server owner or, worse, ask
// their bank — a chargeback costs the owner a fee and counts against their
// Stripe dispute rate.
//
// Cancellation is always at period end. The buyer paid for the current period,
// so they keep the role until it runs out; Stripe then fires
// customer.subscription.deleted and the existing webhook path lifts the role.
// Nothing here touches Discord directly.

import { sendJson, guard, readJsonBody } from '../src/lib/http.js';
import { sessionUserId } from '../src/lib/session.js';
import { subscriptionsForMember, markSubscriptionCancelling } from '../src/db.js';
import { storeById } from '../src/services/stores.js';
import { stripeFetch, subscriptionPeriodEnd } from '../src/lib/stripe.js';

export default guard(async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  const uid = await sessionUserId(req);
  if (!uid) return sendJson(res, 401, { error: 'Sign in with Discord first.' });

  const body = await readJsonBody(req).catch(() => ({}));
  if (body.action !== 'cancel') return sendJson(res, 400, { error: 'Unknown action.' });

  const ref = String(body.subscriptionRef ?? '').trim();
  if (!ref) return sendJson(res, 400, { error: 'Which membership?' });

  // Ownership is decided here, from the session's own rows — never from the id
  // in the request. Otherwise anyone signed in could cancel a stranger's
  // subscription by guessing a sub_ id.
  const mine = (await subscriptionsForMember(uid)).find((s) => s.provider_ref === ref);
  if (!mine) return sendJson(res, 404, { error: 'No membership of yours matches that.' });

  if (mine.provider !== 'stripe') {
    return sendJson(res, 400, { error: 'That membership was not paid by card — contact the server owner to cancel it.' });
  }
  if (mine.current_period_end === null || mine.current_period_end === undefined) {
    return sendJson(res, 400, { error: 'That is a one-off purchase, so there is nothing recurring to cancel.' });
  }
  if (mine.status === 'canceled' || mine.cancels_at) {
    return sendJson(res, 200, { ok: true, alreadyCancelled: true, endsAt: Number(mine.cancels_at ?? mine.current_period_end) });
  }

  const store = await storeById(mine.store_id === null || mine.store_id === undefined ? null : Number(mine.store_id));
  if (!store?.stripeKey) return sendJson(res, 409, { error: 'That store is not accepting card payments right now.' });

  let sub;
  try {
    sub = await stripeFetch(`/v1/subscriptions/${encodeURIComponent(ref)}`, {
      method: 'POST',
      form: { cancel_at_period_end: 'true' },
      key: store.stripeKey,
    });
  } catch (err) {
    // A restricted key without Subscriptions:write lands here. Say so, rather
    // than leaving the buyer staring at a dead button.
    console.error(`[subscription] cancel ${ref} failed: ${err.message}`);
    return sendJson(res, 502, { error: 'Stripe would not cancel that just now. Try again shortly, or contact the server owner.' });
  }

  // Stripe moved current_period_end onto the items; the shared helper reads
  // both shapes, and the stored value is the fallback.
  const endsAt = Number(subscriptionPeriodEnd(sub) ?? mine.current_period_end);
  await markSubscriptionCancelling(mine.id, endsAt);
  return sendJson(res, 200, { ok: true, endsAt, cancelAtPeriodEnd: true });
});
