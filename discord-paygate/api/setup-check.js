import { config } from '../src/config.js';
import { sendJson, sendText, guard } from '../src/lib/http.js';
import { sessionUserId } from '../src/lib/session.js';
import { runDoctor } from '../src/services/doctor.js';
import { cronAuthorized } from './cron/reconcile.js';

// Full doctor report for: the CRON_SECRET bearer (machine use, unchanged) or
// the signed-in Discord user matching OWNER_DISCORD_ID (the /diagnostics
// page). Everyone else gets ONLY { ok } — enough to drive the storefront
// banner, zero configuration detail. Reports never contain secret values,
// only masked prefixes. Cached per warm instance; detail-authorized callers
// can force a re-run with ?fresh=1.

let cache = null; // { at, report }
const ttlMs = () => Number(process.env.DOCTOR_CACHE_SECONDS ?? 300) * 1000;

function ownerAuthorized(req) {
  const uid = sessionUserId(req);
  return Boolean(uid && config.ownerDiscordId && uid === config.ownerDiscordId);
}

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
  sendJson(res, 200, { ok: cache.report.ok });
});
