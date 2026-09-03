// After a domain move (ripleybot.com → dues.gg), the webhook endpoints
// registered on sellers' Stripe accounts still point at the OLD domain —
// Stripe would deliver checkout events into a void and paid roles would
// never arrive. The hourly cron calls this: for every managed store it
// compares the registered endpoint against the current PUBLIC_BASE_URL and,
// on mismatch, registers the current URL, stores the new signing secret,
// and removes the stale registration. Idempotent and best-effort per store —
// one store's broken key never blocks the others.
import { config } from '../config.js';
import * as db from '../db.js';
import { openSecret } from '../lib/secretbox.js';
import { stripeFetch, createWebhookEndpoint, ensureWebhookEvents } from '../lib/stripe.js';

let lastRun = 0;

export async function healStoreWebhooks() {
  // Real deployments only, and at most once an hour per warm instance — the
  // cron fires hourly anyway; this guard just absorbs manual cron pokes.
  if (!config.publicBaseUrl.startsWith('https://')) return { checked: 0, healed: 0 };
  if (Date.now() - lastRun < 55 * 60 * 1000) return { checked: 0, healed: 0, throttled: true };
  lastRun = Date.now();
  let checked = 0;
  let healed = 0;
  for (const row of await db.allStores()) {
    const key = row.stripe_secret_enc ? openSecret(row.stripe_secret_enc) : null;
    if (!key) continue;
    checked += 1;
    const want = `${config.publicBaseUrl}/webhooks/stripe/${row.id}`;
    try {
      const eps = await stripeFetch('/v1/webhook_endpoints?limit=100', { key });
      const ours = (eps.data ?? []).filter((e) => String(e.url ?? '').endsWith(`/webhooks/stripe/${row.id}`));
      const live = ours.find((e) => e.url === want && e.status !== 'disabled');
      if (live) {
        // The endpoint is in the right place, but it was registered against
        // whatever event list shipped that day. Bring it up to the current one
        // — otherwise a seller who onboarded before an event was added never
        // receives it, and the feature silently does not exist for them.
        const added = await ensureWebhookEvents(live, key).catch(() => []);
        if (added.length) {
          healed += 1;
          console.log(`[webhook-heal] store ${row.id} subscribed to ${added.join(', ')}`);
        }
        continue;
      }
      const made = await createWebhookEndpoint(want, key);
      await db.updateStore(row.id, { stripeWebhookSecret: made.secret });
      for (const e of ours) {
        if (e.url !== want) await stripeFetch(`/v1/webhook_endpoints/${e.id}`, { method: 'DELETE', key }).catch(() => {});
      }
      healed += 1;
      console.log(`[webhook-heal] store ${row.id} re-registered at ${want}`);
    } catch (err) {
      console.warn(`[webhook-heal] store ${row.id}: ${err.message}`);
    }
  }
  return { checked, healed };
}
