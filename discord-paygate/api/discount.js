// Public discount preview: the checkout page's Apply button asks here
// whether a code is good for this product and what the price becomes.
// Read-only — the authoritative validation still happens at checkout,
// and uses are only counted by the completed-payment webhook.
import { guard, sendJson } from '../src/lib/http.js';
import { sessionUserId } from '../src/lib/session.js';
import { storeBySlug, planOf } from '../src/services/stores.js';
import { DEMO_SLUG, DEMO_DISCOUNT, demoPlans } from '../src/services/demo-store.js';
import { countDiscountMisses, countDiscountMissesForStore, recordDiscountMiss } from '../src/db.js';
import { resolveDiscount } from '../src/services/purchase-guard.js';
import { roundAmount, minCharge, formatAmount, normalize as normalizeCurrency } from '../src/lib/currency.js';

// A 200-or-404 answer with no login and no limit is an oracle: walk a
// wordlist against any store and every private code it ever made falls out,
// discount and all. Misses are therefore budgeted PER ASKER — the session when
// there is one, else the address. A valid code costs nothing against the
// budget: only guessing does. Once over it, everything is refused alike, so
// the throttle itself does not leak.
//
// Two things this deliberately does NOT do:
//
//  * keep the count in memory. This ships as serverless functions, so a
//    module-level Map is a fresh budget on every instance and every cold
//    start — a guesser fans out across instances and each hands them another
//    eight answers. The count lives in the database, like the review and
//    follow windows.
//
//  * refuse anyone on a STORE-wide count. A shared budget is a switch a
//    stranger can flip: a few hundred misses (0.5/second) and every buyer of
//    that store — signed in or not — is told "too many code attempts" when
//    they apply the seller's real, advertised code, for as long as the
//    attacker cares to keep it renewed. Refusing the seller's own customers
//    to slow a guesser down is a worse outcome than the guessing. The store
//    count is kept as a SIGNAL: one log line when a store crosses it, so a
//    walk is visible to whoever reads the logs, and nobody's checkout breaks.
const WINDOW_SECONDS = 10 * 60;
const MAX_MISSES_PER_ASKER = 8;
const MAX_MISSES_PER_STORE = 300;

function askerKey(req, uid) {
  if (uid) return `u:${uid}`;
  // On the platform this deploys to, x-forwarded-for is written by the
  // platform's own proxy, so its first entry is the client it accepted the
  // connection from. Elsewhere (a local dev server) it is whatever the client
  // said — the socket address is the fallback when the header is absent.
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return `ip:${fwd || req.socket?.remoteAddress || '?'}`;
}

export default guard(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const slug = url.searchParams.get('store') ?? '';
  const code = (url.searchParams.get('code') ?? '').trim().toUpperCase();
  const planId = url.searchParams.get('plan') ?? '';
  if (!/^[a-z0-9-]{1,40}$/.test(slug) || !/^[A-Z0-9_-]{2,32}$/.test(code) || !planId) {
    return sendJson(res, 400, { error: 'bad request' });
  }
  const now = Math.floor(Date.now() / 1000);
  const since = now - WINDOW_SECONDS;
  // One identity for both jobs below: who the budget is kept for, and whose
  // reservations do not count against their own code.
  const uid = await sessionUserId(req);
  const asker = askerKey(req, uid);
  if ((await countDiscountMisses(asker, since)) >= MAX_MISSES_PER_ASKER) {
    return sendJson(res, 429, { error: 'Too many code attempts — try again in a few minutes.' });
  }
  // A walk spread over hundreds of addresses spends nobody's per-asker budget,
  // so the store's own count has to bound it — but it may only refuse the
  // GUESSING. A store-wide refusal that also covered valid codes would be a
  // switch a stranger could flip: flood a store and its real buyers are told
  // "too many code attempts" when they apply the seller's advertised code.
  // Past the cap a miss is 429 and a real code still answers 200.
  const storeOverrun = (await countDiscountMissesForStore(slug, since).catch(() => 0)) >= MAX_MISSES_PER_STORE;
  const miss = async () => {
    await recordDiscountMiss(asker, slug, since).catch(() => {});
    if (storeOverrun) {
      return sendJson(res, 429, { error: 'Too many code attempts — try again in a few minutes.' });
    }
    const storeMisses = await countDiscountMissesForStore(slug, since).catch(() => 0);
    if (storeMisses === MAX_MISSES_PER_STORE) {
      console.warn(`[discount] ${slug}: ${storeMisses} refused code previews in the last ${WINDOW_SECONDS / 60} minutes — someone is walking this store's codes`);
    }
    return sendJson(res, 404, { error: 'That discount code is not valid for this product.' });
  };
  if (slug === DEMO_SLUG) {
    const plan = demoPlans().find((p) => p.id === planId);
    if (!plan || code !== DEMO_DISCOUNT.code) {
      return miss();
    }
    const cur = normalizeCurrency(plan.currency);
    const off = (plan.priceUsd * DEMO_DISCOUNT.amount) / 100;
    const discountedUsd = Math.max(0, roundAmount(plan.priceUsd - off, cur));
    return sendJson(res, 200, {
      code, kind: DEMO_DISCOUNT.kind, amount: DEMO_DISCOUNT.amount,
      priceUsd: plan.priceUsd, discountedUsd, currency: cur,
      saveUsd: roundAmount(plan.priceUsd - discountedUsd, cur),
    });
  }
  const store = await storeBySlug(slug);
  const plan = store ? await planOf(store, planId) : null;
  // One answer, shared with both checkouts. The preview used to re-implement
  // the validity rules and skip the one the rails added: a use another buyer
  // holds on an open checkout. It then told a buyer "applied, you save $5"
  // for a code the Pay button refused a second later — and a crypto invoice
  // holds a use for the life of the invoice, so that window is long.
  const applied = plan ? await resolveDiscount({ store, plan, code, uid }) : { error: 'unknown plan' };
  if (applied.error || !applied.row) {
    return miss();
  }
  const d = applied.row;
  // Rounded to what the currency can express. Rounding a yen price to two
  // decimals invents a half-yen that Stripe will refuse at the card form.
  const cur = normalizeCurrency(plan.currency ?? store.currency);
  const discountedUsd = applied.priceAfter;
  // Stripe refuses a charge below its per-currency minimum, but happily takes
  // a zero one (that is how 100%-off and free trials work). So the failing
  // band is strictly between the two — and a buyer must find out here, not at
  // the card form after Stripe rejects the invoice with its own wording.
  if (discountedUsd > 0 && discountedUsd < minCharge(cur)) {
    return sendJson(res, 409, {
      error: `That code brings the total under the ${cur.toUpperCase()} minimum of ${formatAmount(minCharge(cur), cur)}, which no card payment can clear.`,
    });
  }
  sendJson(res, 200, {
    code,
    kind: d.kind,
    amount: d.amount,
    priceUsd: plan.priceUsd,
    discountedUsd,
    currency: cur,
    saveUsd: roundAmount(plan.priceUsd - discountedUsd, cur),
  });
});
