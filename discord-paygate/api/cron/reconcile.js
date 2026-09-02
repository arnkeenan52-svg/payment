import crypto from 'node:crypto';
import { config } from '../../src/config.js';
import { sendJson, sendText, guard } from '../../src/lib/http.js';
import { sweepExpirations } from '../../src/services/entitlements.js';
import { healStoreWebhooks } from '../../src/services/webhook-heal.js';
import { refreshBrandAssets } from '../../src/services/brand-refresh.js';
import { backfillMissedSales, backfillMissedCryptoSales } from '../../src/services/backfill.js';
import { purgeWebhookEvents } from '../../src/db.js';

// Webhook idempotency claims outlive any provider's retries by this much and
// are then dropped; Stripe retries for three days, NOWPayments for minutes.
const CLAIM_RETENTION = 7 * 86400;

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
  // A sub-job that fails is named in the response — nobody reads the logs of
  // an hourly job, and a webhook heal that has failed since the domain move
  // must not look like a healthy run from outside.
  const failures = [];
  const attempt = (name, fn) => fn().catch((err) => {
    console.error(`[cron] ${name} failed: ${err.message}`);
    failures.push(`${name}: ${err.message}`);
    return null;
  });
  // Keep sellers' Stripe webhook registrations pointed at THIS deployment —
  // after a domain move they'd otherwise deliver into the old, dead host.
  const webhooks = await attempt('webhook heal', healStoreWebhooks);
  // Keep the bot's already-posted cards and profile on the current brand —
  // an app_secrets flag makes this a no-op on every run after the first.
  const brand = await attempt('brand refresh', refreshBrandAssets);
  // Sales whose webhook never arrived: ask Stripe, process what was missed.
  const backfill = await attempt('sale backfill', backfillMissedSales);
  // Crypto sales whose IPN never arrived: ask the provider about every open
  // order, process what finished.
  const cryptoBackfill = await attempt('crypto backfill', backfillMissedCryptoSales);
  // Claims no retry can ever match again, off the table every webhook inserts into.
  const claimsPurged = await attempt('claim purge', () => purgeWebhookEvents(Math.floor(Date.now() / 1000) - CLAIM_RETENTION));
  sendJson(res, 200, {
    ok: failures.length === 0,
    ...result,
    ...(webhooks ? { webhooks } : {}),
    ...(brand ? { brand } : {}),
    ...(backfill ? { backfill } : {}),
    ...(cryptoBackfill ? { cryptoBackfill } : {}),
    ...(claimsPurged === null ? {} : { claimsPurged }),
    ...(failures.length ? { failures } : {}),
  });
});
