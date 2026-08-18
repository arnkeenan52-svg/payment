import { capabilities } from '../../src/config.js';
import { storeBySlug, planOf } from '../../src/services/stores.js';
import { sendJson, sendText, readJsonBody, guard } from '../../src/lib/http.js';
import { sessionUserId } from '../../src/lib/session.js';
import { createCheckoutSession } from '../../src/lib/stripe.js';

export default guard(async function handler(req, res) {
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  if (!capabilities().stripe) {
    sendJson(res, 501, { error: 'card payments are not enabled' });
    return;
  }
  const uid = sessionUserId(req);
  if (!uid) {
    sendJson(res, 401, { error: 'log in with Discord first' });
    return;
  }
  const body = await readJsonBody(req).catch(() => null);
  const store = await storeBySlug(typeof body?.store === 'string' ? body.store : '');
  if (!store || store.status !== 'live') {
    sendJson(res, 404, { error: 'unknown store' });
    return;
  }
  const plan = body?.planId ? await planOf(store, body.planId) : null;
  if (!plan) {
    sendJson(res, 400, { error: 'unknown plan' });
    return;
  }
  // Optional buyer note — rides into Stripe metadata so the owner sees it on
  // the payment in the Stripe dashboard.
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
  let session;
  try {
    session = await createCheckoutSession({ plan, discordId: uid, note, store });
  } catch (err) {
    // Buyers get a plain sentence, never raw Stripe internals; the owner sees
    // the exact cause (wrong-mode key, missing price, …) on /diagnostics.
    console.error(`[checkout] stripe session for ${uid}/${plan.id} (store ${store.slug}) failed: ${err.message}`);
    sendJson(res, 502, {
      error: "Payment could not be started — the store's payment setup is incomplete. Please try again shortly.",
    });
    return;
  }
  sendJson(res, 200, { url: session.url });
});
