// Public discount preview: the checkout page's Apply button asks here
// whether a code is good for this product and what the price becomes.
// Read-only — the authoritative validation still happens at checkout,
// and uses are only counted by the completed-payment webhook.
import { guard, sendJson } from '../src/lib/http.js';
import { storeBySlug, planOf } from '../src/services/stores.js';
import { getDiscount } from '../src/db.js';

export default guard(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const slug = url.searchParams.get('store') ?? '';
  const code = (url.searchParams.get('code') ?? '').trim().toUpperCase();
  const planId = url.searchParams.get('plan') ?? '';
  if (!/^[a-z0-9-]{1,40}$/.test(slug) || !/^[A-Z0-9_-]{2,32}$/.test(code) || !planId) {
    return sendJson(res, 400, { error: 'bad request' });
  }
  const store = await storeBySlug(slug);
  const plan = store ? await planOf(store, planId) : null;
  const d = store && store.id !== null && store.id !== undefined ? await getDiscount(store.id, code) : null;
  const now = Math.floor(Date.now() / 1000);
  const valid =
    plan &&
    d &&
    (d.planKey === null || d.planKey === plan.id) &&
    (d.expiresAt === null || d.expiresAt > now) &&
    (d.maxUses === null || d.uses < d.maxUses);
  if (!valid) {
    return sendJson(res, 404, { error: 'That discount code is not valid for this product.' });
  }
  const off = d.kind === 'percent' ? (plan.priceUsd * Math.min(100, Math.max(1, d.amount))) / 100 : Math.min(d.amount, plan.priceUsd);
  const discountedUsd = Math.max(0, Math.round((plan.priceUsd - off) * 100) / 100);
  sendJson(res, 200, {
    code,
    kind: d.kind,
    amount: d.amount,
    priceUsd: plan.priceUsd,
    discountedUsd,
    saveUsd: Math.round((plan.priceUsd - discountedUsd) * 100) / 100,
  });
});
