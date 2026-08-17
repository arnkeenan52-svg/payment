import { planById, capabilities } from '../../src/config.js';
import { sendJson, sendText, readJsonBody } from '../../src/lib/http.js';
import { sessionUserId } from '../../src/lib/session.js';
import { createCheckoutSession } from '../../src/lib/stripe.js';

export default async function handler(req, res) {
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
  const session = await createCheckoutSession({ plan, discordId: uid });
  sendJson(res, 200, { url: session.url });
}
