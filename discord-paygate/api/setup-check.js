import { sendJson, sendText } from '../src/lib/http.js';
import { runDoctor } from '../src/services/doctor.js';
import { cronAuthorized } from './cron/reconcile.js';

// With the CRON_SECRET bearer: the full doctor report (check-by-check, with
// fixes). Without it: ONLY { ok } — enough for the storefront to show its
// misconfiguration banner, with zero configuration detail exposed publicly.
// The result is cached per warm instance so storefront visits don't hammer
// Stripe and Discord.

let cache = null; // { at, report }
const ttlMs = () => Number(process.env.DOCTOR_CACHE_SECONDS ?? 300) * 1000;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  if (!cache || Date.now() - cache.at > ttlMs()) {
    cache = { at: Date.now(), report: await runDoctor() };
  }
  if (cronAuthorized(req)) {
    sendJson(res, 200, cache.report);
    return;
  }
  sendJson(res, 200, { ok: cache.report.ok });
}
