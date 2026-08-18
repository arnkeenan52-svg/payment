import { sendJson, sendText, guard } from '../src/lib/http.js';
import { sessionUserId } from '../src/lib/session.js';
import { reconcile } from '../src/services/entitlements.js';

// "Fix my access": re-runs the same idempotent reconcile the webhooks use for
// the signed-in member — heals a manually-removed role, a missed join, or a
// role change without waiting for the hourly sweep.
export default guard(async function handler(req, res) {
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  const uid = sessionUserId(req);
  if (!uid) {
    sendJson(res, 401, { error: 'log in with Discord first' });
    return;
  }
  try {
    const result = await reconcile(uid);
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    console.error(`[resync] ${uid} failed: ${err.message}`);
    sendJson(res, 502, { ok: false, error: 'Could not sync with Discord right now — try again in a minute.' });
  }
});
