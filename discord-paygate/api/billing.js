import { sendJson, sendText, readJsonBody, guard } from '../src/lib/http.js';
import { sessionUserId } from '../src/lib/session.js';
import { capabilities } from '../src/config.js';
import { TIERS, tierById, billingFor, memberUsage, createBillingCheckout, cancelBilling } from '../src/services/billing.js';

// The signed-in owner's Ripley plan: read it, upgrade it (Stripe Checkout on
// Ripley's own account), or cancel it. Buyer payments never touch this.
export default guard(async function handler(req, res) {
  const uid = sessionUserId(req);
  if (!uid) {
    sendJson(res, 401, { error: 'sign in first' });
    return;
  }

  if (req.method === 'GET') {
    const { tier, row, exempt } = await billingFor(uid);
    const members = await memberUsage(uid);
    sendJson(res, 200, {
      tiers: TIERS,
      current: {
        tier: tier.id,
        name: tier.name,
        maxMembers: tier.maxMembers,
        status: row?.status ?? null,
        periodEnd: row?.current_period_end === null || row?.current_period_end === undefined ? null : Number(row.current_period_end),
      },
      usage: { members, limit: tier.maxMembers },
      exempt,
    });
    return;
  }

  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  const body = await readJsonBody(req).catch(() => ({}));

  if (body.action === 'checkout') {
    if (!capabilities().stripe) {
      sendJson(res, 501, { error: 'card payments are not enabled' });
      return;
    }
    const tier = tierById(String(body.tier ?? ''));
    if (!tier || tier.priceUsd <= 0) {
      sendJson(res, 400, { error: 'Pick a paid plan to upgrade to.' });
      return;
    }
    const { exempt } = await billingFor(uid);
    if (exempt) {
      sendJson(res, 400, { error: 'You run the platform — no plan needed.' });
      return;
    }
    let session;
    try {
      session = await createBillingCheckout(uid, tier);
    } catch (err) {
      console.error(`[billing] checkout for ${uid}/${tier.id} failed: ${err.message}`);
      sendJson(res, 502, { error: 'Could not start the upgrade — please try again shortly.' });
      return;
    }
    sendJson(res, 200, { url: session.url });
    return;
  }

  if (body.action === 'cancel') {
    const result = await cancelBilling(uid);
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  sendJson(res, 400, { error: 'unknown action' });
});
