import { planById, capabilities } from '../../src/config.js';
import { sendJson, sendText, readJsonBody, guard } from '../../src/lib/http.js';
import { sessionUserId } from '../../src/lib/session.js';
import { createCharge } from '../../src/lib/coinbase.js';

// Dormant unless Coinbase credentials are configured; the storefront hides
// its CTA behind the same capability flag.
export default guard(async function handler(req, res) {
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  if (!capabilities().crypto) {
    sendJson(res, 501, { error: 'crypto payments are not enabled' });
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
  const charge = await createCharge({ plan, discordId: uid });
  sendJson(res, 200, { url: charge.hosted_url });
});
