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
import { config } from '../config.js';
import * as db from '../db.js';
import { openSecret } from '../lib/secretbox.js';
import { stripeFetch } from '../lib/stripe.js';
import { storeById } from './stores.js';
import { processStripeEvent } from './stripe-events.js';

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
