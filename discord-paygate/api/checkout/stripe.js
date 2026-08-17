import { planById, capabilities } from '../../src/config.js';
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
  const plan = body?.planId ? planById(body.planId) : null;
  if (!plan) {
    sendJson(res, 400, { error: 'unknown plan' });
    return;
  }
  // Optional buyer note — rides into Stripe metadata so the owner sees it on
  // the payment in the Stripe dashboard.
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
  const session = await createCheckoutSession({ plan, discordId: uid, note });
  sendJson(res, 200, { url: session.url });
});
