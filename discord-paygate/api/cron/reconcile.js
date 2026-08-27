import crypto from 'node:crypto';
import { config } from '../../src/config.js';
import { sendJson, sendText, guard } from '../../src/lib/http.js';
import { sweepExpirations } from '../../src/services/entitlements.js';
import { healStoreWebhooks } from '../../src/services/webhook-heal.js';
import { refreshBrandAssets } from '../../src/services/brand-refresh.js';

// Replaces the old setInterval sweep — there is no long-lived process on
// Vercel. vercel.json schedules this; Vercel sends Authorization: Bearer
// <CRON_SECRET> when the CRON_SECRET env var is set. Constant-time compare
// so the endpoint can't be probed, and fail closed when the secret is unset.
export function cronAuthorized(req) {
  if (!config.cronSecret) return false;
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  const want = Buffer.from(`Bearer ${config.cronSecret}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export default guard(async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  if (!cronAuthorized(req)) {
    sendText(res, config.cronSecret ? 401 : 500, config.cronSecret ? 'unauthorized' : 'CRON_SECRET is not configured');
    return;
  }
  const result = await sweepExpirations();
  // Keep sellers' Stripe webhook registrations pointed at THIS deployment —
  // after a domain move they'd otherwise deliver into the old, dead host.
  const webhooks = await healStoreWebhooks().catch((err) => {
    console.warn(`[cron] webhook heal failed: ${err.message}`);
    return null;
  });
  // Keep the bot's already-posted cards and profile on the current brand —
  // an app_secrets flag makes this a no-op on every run after the first.
  const brand = await refreshBrandAssets().catch((err) => {
    console.warn(`[cron] brand refresh failed: ${err.message}`);
    return null;
  });
  sendJson(res, 200, { ok: true, ...result, ...(webhooks ? { webhooks } : {}), ...(brand ? { brand } : {}) });
});
