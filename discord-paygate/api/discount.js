// Public discount preview: the checkout page's Apply button asks here
// whether a code is good for this product and what the price becomes.
// Read-only — the authoritative validation still happens at checkout,
// and uses are only counted by the completed-payment webhook.
import { guard, sendJson } from '../src/lib/http.js';
import { sessionUserId } from '../src/lib/session.js';
import { storeBySlug, planOf } from '../src/services/stores.js';
import { DEMO_SLUG, DEMO_DISCOUNT, demoPlans } from '../src/services/demo-store.js';
import { getDiscount } from '../src/db.js';
import { roundAmount, minCharge, formatAmount, normalize as normalizeCurrency } from '../src/lib/currency.js';

// A 200-or-404 answer with no login and no limit is an oracle: walk a
// wordlist against any store and every private code it ever made falls out,
// discount and all. Misses are therefore budgeted — per asker (the session
// when there is one, else the address) and per store, so a spread of
// addresses buys nothing either. A valid code costs nothing against the
// budget: only guessing does. Once over it, everything is refused alike,
// so the throttle itself does not leak.
const WINDOW_SECONDS = 10 * 60;
const MAX_MISSES_PER_ASKER = 8;
const MAX_MISSES_PER_STORE = 300;
const misses = new Map(); // key → [unix seconds of each miss in the window]

function missesBy(key, now) {
  const list = (misses.get(key) ?? []).filter((t) => t > now - WINDOW_SECONDS);
  if (list.length) misses.set(key, list); else misses.delete(key);
  return list;
}

function recordMiss(keys, now) {
  // Kept small: entries older than the window are dropped on every write.
  if (misses.size > 5000) for (const k of misses.keys()) missesBy(k, now);
  for (const key of keys) misses.set(key, [...missesBy(key, now), now]);
}

async function askerKey(req) {
  const uid = await sessionUserId(req);
  if (uid) return `u:${uid}`;
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
  const keys = [await askerKey(req), `s:${slug}`];
  if (missesBy(keys[0], now).length >= MAX_MISSES_PER_ASKER || missesBy(keys[1], now).length >= MAX_MISSES_PER_STORE) {
    return sendJson(res, 429, { error: 'Too many code attempts — try again in a few minutes.' });
  }
  const miss = () => {
    recordMiss(keys, now);
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
  const d = store && store.id !== null && store.id !== undefined ? await getDiscount(store.id, code) : null;
  const valid =
    plan &&
    d &&
    // A code scoped to one product covers that product's price options too —
    // an option is the same product at a different cadence, not a sibling.
    (d.planKey === null || d.planKey === plan.id || d.planKey === plan.variantOf) &&
    (d.expiresAt === null || d.expiresAt > now) &&
    (d.maxUses === null || d.uses < d.maxUses);
  if (!valid) {
    return miss();
  }
  // Rounded to what the currency can express. Rounding a yen price to two
  // decimals invents a half-yen that Stripe will refuse at the card form.
  const cur = normalizeCurrency(plan.currency ?? store.currency);
  const off = d.kind === 'percent' ? (plan.priceUsd * Math.min(100, Math.max(1, d.amount))) / 100 : Math.min(d.amount, plan.priceUsd);
  const discountedUsd = Math.max(0, roundAmount(plan.priceUsd - off, cur));
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
