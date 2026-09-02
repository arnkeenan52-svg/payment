// A sale whose webhook never arrived. Stripe retries a failed delivery for up
// to three days and then stops; a misregistered endpoint, a stale signing
// secret or a host that answered 5xx past that window all end the same way:
// the buyer was charged on the seller's own Stripe account and Dues never
// learned — no role, no receipt, no sale ping, no dashboard row, and nothing
// that ever repaired it, because the sweep only reconciles rows that exist.
//
// The hourly cron asks Stripe instead. Every checkout Dues opens is recorded
// as a 'started' attempt before the buyer ever sees the card form, so a
// completed, paid session whose attempt is still 'started' an hour later is
// exactly a sale that was missed. It is processed through the same handler
// the webhook uses, under its own idempotency claim; the handler marks the
// attempt completed only once the grant has landed, and skips a session whose
// attempt is already completed — so a late real delivery after a backfill, or
// a backfill after a real delivery, does nothing twice.
import { config, capabilities } from '../config.js';
import * as db from '../db.js';
import { openSecret } from '../lib/secretbox.js';
import { stripeFetch } from '../lib/stripe.js';
import { getPayment, GRANTS_ACCESS, DEAD } from '../lib/nowpayments.js';
import { storeById } from './stores.js';
import { processStripeEvent } from './stripe-events.js';
import { processNowPayment } from './nowpayments-events.js';

const HOUR = 3600;
const WINDOW = 7 * 86400;

async function recoverFor(key, routeStore, now) {
  const scope = routeStore ? `s${routeStore.id}` : null;
  const qs = `status=complete&limit=100&created[gte]=${now - WINDOW}&created[lte]=${now - HOUR}`;
  const list = await stripeFetch(`/v1/checkout/sessions?${qs}`, { key });
  let recovered = 0;
  for (const s of list?.data ?? []) {
    if (s.status !== 'complete') continue;
    if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') continue;
    if (s.metadata?.kind === 'platform_plan') continue;
    if (!(s.client_reference_id ?? s.metadata?.discord_id) || !s.metadata?.plan_id) continue;
    // Two stores on one account see the same list; each takes only its own.
    const sid = s.metadata?.store_id;
    if (routeStore ? String(sid ?? '') !== String(routeStore.id) : sid) continue;
    // Only sessions Dues itself opened and never heard back about.
    const attempt = await db.getCheckoutAttempt(s.id);
    if (!attempt || attempt.status === 'completed') continue;
    const eventId = `backfill_${s.id}`;
    if (!(await db.claimEvent('stripe', eventId, scope))) continue;
    try {
      await processStripeEvent({ id: eventId, type: 'checkout.session.completed', data: { object: s } }, routeStore);
      recovered += 1;
      console.warn(`[backfill] recovered sale ${s.id} for ${routeStore?.slug ?? 'the built-in store'} — its webhook never arrived`);
    } catch (err) {
      await db.releaseEvent('stripe', eventId, scope);
      throw err;
    }
  }
  return recovered;
}

export async function backfillMissedSales({ now = Math.floor(Date.now() / 1000) } = {}) {
  let checked = 0;
  let recovered = 0;
  const failures = [];
  const seen = new Set();
  for (const row of await db.allStores()) {
    const key = row.stripe_secret_enc ? openSecret(row.stripe_secret_enc) : null;
    if (!key) continue;
    const store = await storeById(row.id);
    if (!store) continue;
    checked += 1;
    seen.add(key);
    try {
      recovered += await recoverFor(key, store, now);
    } catch (err) {
      failures.push(`${store.slug}: ${err.message}`);
      console.error(`[backfill] ${store.slug}: ${err.message}`);
    }
  }
  // The built-in store sells on the platform's own account.
  if (config.stripe.secretKey && !seen.has(config.stripe.secretKey)) {
    checked += 1;
    try {
      recovered += await recoverFor(config.stripe.secretKey, null, now);
    } catch (err) {
      failures.push(`built-in: ${err.message}`);
      console.error(`[backfill] built-in store: ${err.message}`);
    }
  }
  return { checked, recovered, ...(failures.length ? { failures } : {}) };
}

// The crypto rail has the same hole, and a shorter fuse: NOWPayments retries
// a failed IPN for minutes, not days, and an on-chain payment cannot be
// charged back — the coins are in the seller's wallet whether or not Dues
// ever heard. Every crypto order is a 'started' attempt carrying the
// provider's payment id from the moment the invoice exists, so the open ones
// older than an hour are exactly the payments to ask about, one lookup each.
// (Not the account-wide payment list: that pages over every store's
// payments to find the few that matter, and these rows already say which.)
// A finished one goes through the same idempotent handler the IPN uses; one
// the provider closed unpaid is closed here too, so it is not asked about
// again every hour for a week.
//
// Bounded twice — a batch per run and a wall-clock budget — because this
// runs inside the cron's own time limit after everything else in it, and a
// provider that answers slowly must not turn an hourly job into a timeout.
const CRYPTO_BATCH = 20;
const CRYPTO_BUDGET_MS = 15_000;

export async function backfillMissedCryptoSales({ now = Math.floor(Date.now() / 1000), budgetMs = CRYPTO_BUDGET_MS } = {}) {
  if (!capabilities().nowpayments) return { checked: 0, recovered: 0, closed: 0 };
  const started = Date.now();
  let checked = 0;
  let recovered = 0;
  let closed = 0;
  const failures = [];
  for (const attempt of await db.openCryptoAttempts({ since: now - WINDOW, until: now - HOUR, limit: CRYPTO_BATCH })) {
    if (Date.now() - started > budgetMs) break;
    checked += 1;
    try {
      const payment = await getPayment(attempt.provider_ref);
      const status = String(payment?.payment_status ?? '').toLowerCase();
      if (GRANTS_ACCESS.has(status)) {
        if ((await processNowPayment(payment)) === 'granted') {
          recovered += 1;
          console.warn(`[backfill] recovered crypto sale ${attempt.session_id} (payment ${attempt.provider_ref}) — its IPN never arrived`);
        }
      } else if (DEAD.has(status)) {
        await db.markCheckoutExpired(attempt.session_id);
        closed += 1;
      }
    } catch (err) {
      failures.push(`${attempt.session_id}: ${err.message}`);
      console.error(`[backfill] crypto ${attempt.session_id}: ${err.message}`);
    }
  }
  return { checked, recovered, closed, ...(failures.length ? { failures } : {}) };
}
