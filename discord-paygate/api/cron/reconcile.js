import crypto from 'node:crypto';
import { config } from '../../src/config.js';
import { sendJson, sendText } from '../../src/lib/http.js';
import { sweepExpirations } from '../../src/services/entitlements.js';

// Replaces the old setInterval sweep — there is no long-lived process on
// Vercel. vercel.json schedules this; Vercel sends Authorization: Bearer
// <CRON_SECRET> when the CRON_SECRET env var is set. Constant-time compare
// so the endpoint can't be probed, and fail closed when the secret is unset.
function authorized(req) {
  if (!config.cronSecret) return false;
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  const want = Buffer.from(`Bearer ${config.cronSecret}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  if (!authorized(req)) {
    sendText(res, config.cronSecret ? 401 : 500, config.cronSecret ? 'unauthorized' : 'CRON_SECRET is not configured');
    return;
  }
  const result = await sweepExpirations();
  sendJson(res, 200, { ok: true, ...result });
}
