import { sendJson, sendText, readJsonBody, guard } from '../../src/lib/http.js';
import { ownerAuthorized } from '../../src/lib/authz.js';
import { cronAuthorized } from '../cron/reconcile.js';
import { sessionUserId } from '../../src/lib/session.js';
import * as db from '../../src/db.js';
import { adminStoreBySlug, planOf } from '../../src/services/stores.js';
import { reconcile } from '../../src/services/entitlements.js';

const now = () => Math.floor(Date.now() / 1000);

// Member management for a store's owner: revoke a membership (roles come
// off), re-sync a member, or manually grant a product — the same idempotent
// reconcile path payments use, so every action converges on truth.
export default guard(async function handler(req, res) {
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  const uid = sessionUserId(req);
  const platformAdmin = ownerAuthorized(req) || cronAuthorized(req);
  if (!platformAdmin && !uid) {
    sendJson(res, 401, { error: 'sign in first' });
    return;
  }
  const body = await readJsonBody(req).catch(() => ({}));
  const store = await adminStoreBySlug(String(body.store ?? ''));
  if (!store) {
    sendJson(res, 404, { error: 'unknown store' });
    return;
  }
  const ownsThis = platformAdmin || (store.ownerDiscordId && store.ownerDiscordId === uid);
  if (!ownsThis) {
    sendJson(res, 403, { error: 'not your store' });
    return;
  }
  const memberId = String(body.discordId ?? '');
  if (!/^\d{17,20}$/.test(memberId)) {
    sendJson(res, 400, { error: 'That is not a Discord user ID (17–20 digits).' });
    return;
  }

  const storeMatches = (s) => {
    const sid = s.store_id === null || s.store_id === undefined ? null : Number(s.store_id);
    return sid === (store.id ?? null);
  };

  switch (body.action) {
    // Remove the membership: every live subscription of this member in this
    // store is canceled, then reconcile takes the managed roles away.
    case 'revoke': {
      const mine = (await db.subscriptionsForMember(memberId)).filter(storeMatches);
      const subs = mine.filter((s) => s.status === 'active' || s.status === 'past_due');
      // Nothing live, but the member HAS had a row here: the first click may
      // have canceled the row and then lost the Discord call (a 5xx, or the
      // paid role sitting above the bot). Answering 404 made that click the
      // last one possible — the row was already canceled, so the button could
      // never be retried. Reconcile anyway: it takes back whatever is still
      // held, and is a no-op when nothing is.
      if (!subs.length && !mine.length) {
        sendJson(res, 404, { error: 'No membership for that member in this store.' });
        return;
      }
      for (const sub of subs) {
        await db.setSubscriptionStatus(sub.id, { status: 'canceled', graceUntil: null });
      }
      const result = await reconcile(memberId, store);
      sendJson(res, 200, { ok: true, revoked: subs.length, removed: result.removed });
      return;
    }

    // Manually grant a product (Subscord's "manually add subscribers").
    case 'grant': {
      const plan = await planOf(store, String(body.planId ?? ''));
      if (!plan) {
        sendJson(res, 400, { error: 'Pick a product to grant.' });
        return;
      }
      await db.upsertSubscription({
        discordId: memberId,
        planId: plan.id,
        provider: 'manual',
        // No timestamp in the ref. (provider, provider_ref) is the upsert key,
        // so a double-click on Grant used to book the same member twice; one
        // ref per member per plan makes the second click a no-op.
        providerRef: `manual:${store.id ?? 'default'}:${memberId}:${plan.id}`,
        status: 'active',
        currentPeriodEnd: plan.lifetime ? null : now() + (plan.durationDays ?? 31) * 86400,
        graceUntil: null,
        storeId: store.id ?? null,
      });
      const result = await reconcile(memberId, store);
      sendJson(res, 200, { ok: true, granted: plan.id, added: result.added, joined: result.joined });
      return;
    }

    case 'resync': {
      const result = await reconcile(memberId, store);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    // Extend a live membership by N days (from its current expiry, or from
    // now when it had already lapsed). Lifetime rows have nothing to extend.
    case 'extend': {
      const days = Math.round(Number(body.days));
      if (!Number.isFinite(days) || days < 1 || days > 3660) {
        sendJson(res, 400, { error: 'Days must be a whole number between 1 and 3660.' });
        return;
      }
      const subs = (await db.subscriptionsForMember(memberId)).filter(
        (s) => storeMatches(s) && (s.status === 'active' || s.status === 'past_due') && s.current_period_end !== null,
      );
      if (!subs.length) {
        sendJson(res, 404, { error: 'No extendable membership (lifetime access never expires).' });
        return;
      }
      for (const sub of subs) {
        const base = Math.max(Number(sub.current_period_end), now());
        await db.setSubscriptionStatus(sub.id, { status: 'active', currentPeriodEnd: base + days * 86400, graceUntil: null });
      }
      const result = await reconcile(memberId, store);
      sendJson(res, 200, { ok: true, extended: subs.length, days, ...result });
      return;
    }

    default:
      sendJson(res, 400, { error: 'unknown action' });
  }
});
