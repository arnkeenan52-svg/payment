// Public discount preview: the checkout page's Apply button asks here
// whether a code is good for this product and what the price becomes.
// Read-only — the authoritative validation still happens at checkout,
// and uses are only counted by the completed-payment webhook.
import { guard, sendJson } from '../src/lib/http.js';
import { storeBySlug, planOf } from '../src/services/stores.js';
import { DEMO_SLUG, DEMO_DISCOUNT, demoPlans } from '../src/services/demo-store.js';
import { getDiscount } from '../src/db.js';
import { roundAmount, minCharge, formatAmount, normalize as normalizeCurrency } from '../src/lib/currency.js';

// This route is anonymous and answers "valid or not" for any code on any
// store, and codes may be as short as two characters — so without a ceiling
// it is an enumeration oracle (300 guesses a second, measured). A buyer
// retyping a code hits Apply a handful of times; thirty a minute from one
// address is nobody's checkout. Per warm instance, like every in-memory
// window here; the checkout itself validates the code again regardless.
const WINDOW_MS = 60_000;
const MAX_LOOKUPS_PER_WINDOW = 30;
const lookups = new Map(); // ip → { count, until }

function throttled(req) {
  const now = Date.now();
  if (lookups.size > 5000) {
    for (const [ip, w] of lookups) if (w.until <= now) lookups.delete(ip);
  }
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  const ip = forwarded || req.socket?.remoteAddress || 'unknown';
  const w = lookups.get(ip);
  if (!w || w.until <= now) {
    lookups.set(ip, { count: 1, until: now + WINDOW_MS });
    return false;
  }
  w.count += 1;
  return w.count > MAX_LOOKUPS_PER_WINDOW;
}

export default guard(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const slug = url.searchParams.get('store') ?? '';
  const code = (url.searchParams.get('code') ?? '').trim().toUpperCase();
  const planId = url.searchParams.get('plan') ?? '';
  if (!/^[a-z0-9-]{1,40}$/.test(slug) || !/^[A-Z0-9_-]{2,32}$/.test(code) || !planId) {
    return sendJson(res, 400, { error: 'bad request' });
  }
  if (throttled(req)) {
    return sendJson(res, 429, { error: 'Too many code attempts — wait a minute and try again.' });
  }
  if (slug === DEMO_SLUG) {
    const plan = demoPlans().find((p) => p.id === planId);
    if (!plan || code !== DEMO_DISCOUNT.code) {
      return sendJson(res, 404, { error: 'That discount code is not valid for this product.' });
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
  const now = Math.floor(Date.now() / 1000);
  const valid =
    plan &&
    d &&
    // A code scoped to one product covers that product's price options too —
    // an option is the same product at a different cadence, not a sibling.
    (d.planKey === null || d.planKey === plan.id || d.planKey === plan.variantOf) &&
    (d.expiresAt === null || d.expiresAt > now) &&
    (d.maxUses === null || d.uses < d.maxUses);
  if (!valid) {
    return sendJson(res, 404, { error: 'That discount code is not valid for this product.' });
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
