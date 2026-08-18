import { sendJson, sendText, guard } from '../src/lib/http.js';
import { ownerAuthorized } from '../src/lib/authz.js';
import { runDoctor } from '../src/services/doctor.js';
import { cronAuthorized } from './cron/reconcile.js';

// Full doctor report for: the CRON_SECRET bearer (machine use, unchanged) or
// the signed-in Discord user matching OWNER_DISCORD_ID (the owner
// page). Everyone else gets ONLY { ok } — enough to drive the storefront
// banner, zero configuration detail. Reports never contain secret values,
// only masked prefixes. Cached per warm instance; detail-authorized callers
// can force a re-run with ?fresh=1.

let cache = null; // { at, report }
const ttlMs = () => Number(process.env.DOCTOR_CACHE_SECONDS ?? 300) * 1000;

export default guard(async function handler(req, res) {
  if (req.method !== 'GET') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  const detail = cronAuthorized(req) || ownerAuthorized(req);
  const fresh = detail && new URL(req.url, 'http://localhost').searchParams.get('fresh') === '1';
  if (fresh || !cache || Date.now() - cache.at > ttlMs()) {
    cache = { at: Date.now(), report: await runDoctor() };
  }
  if (detail) {
    sendJson(res, 200, cache.report);
    return;
  }
  // `receipts` says whether buyer confirmation emails actually deliver
  // (key present AND a verified sender domain) — an on/off flag with zero
  // configuration detail, so the pipeline is verifiable from the outside.
  sendJson(res, 200, {
    ok: cache.report.ok,
    receipts: cache.report.checks.some((c) => c.id === 'email:resend-sender' && c.status === 'pass'),
  });
});
