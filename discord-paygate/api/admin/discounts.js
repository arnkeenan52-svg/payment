import { sendJson, sendText, readJsonBody, guard } from '../../src/lib/http.js';
import { ownerAuthorized } from '../../src/lib/authz.js';
import { sessionUserId } from '../../src/lib/session.js';
import * as db from '../../src/db.js';
import { adminStoreBySlug, planOf } from '../../src/services/stores.js';
import { roundAmount, minCharge, maxCharge, formatAmount, normalize as normalizeCurrency } from '../../src/lib/currency.js';

// Discount codes for a store: list / create / delete, owner-gated. Codes are
// stored locally; checkout turns a valid code into a one-shot Stripe coupon
// on the store's own account, and the completed-payment webhook counts uses.
export default guard(async function handler(req, res) {
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  const uid = sessionUserId(req);
  if (!uid && !ownerAuthorized(req)) {
    sendJson(res, 401, { error: 'sign in first' });
    return;
  }
  const body = await readJsonBody(req).catch(() => ({}));
  const store = await adminStoreBySlug(String(body.store ?? ''));
  if (!store || store.id === null || store.id === undefined) {
    sendJson(res, 404, { error: 'unknown store' });
    return;
  }
  if (!(ownerAuthorized(req) || (store.ownerDiscordId && store.ownerDiscordId === uid))) {
    sendJson(res, 403, { error: 'not your store' });
    return;
  }

  switch (body.action) {
    case 'list':
      sendJson(res, 200, { discounts: await db.discountsFor(store.id) });
      return;

    case 'create': {
      const code = String(body.code ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9_-]{2,32}$/.test(code)) {
        sendJson(res, 400, { error: 'Codes are 2–32 letters, numbers, dashes or underscores.' });
        return;
      }
      if (await db.getDiscount(store.id, code)) {
        sendJson(res, 409, { error: 'That code already exists.' });
        return;
      }
      const kind = body.kind === 'fixed' ? 'fixed' : 'percent';
      // A fixed discount is denominated in the store's currency, so it rounds
      // and bounds by that currency — not by cents and dollars.
      const dcur = normalizeCurrency(store.currency);
      const amount = kind === 'fixed' ? roundAmount(Number(body.amount), dcur) : Math.round(Number(body.amount) * 100) / 100;
      if (kind === 'percent' && (!Number.isFinite(amount) || amount < 1 || amount > 100)) {
        sendJson(res, 400, { error: 'Percent must be between 1 and 100.' });
        return;
      }
      if (kind === 'fixed' && (!Number.isFinite(amount) || amount < minCharge(dcur) || amount > maxCharge(dcur))) {
        sendJson(res, 400, { error: `Fixed discounts are ${formatAmount(minCharge(dcur), dcur)} to ${formatAmount(maxCharge(dcur), dcur)}.` });
        return;
      }
      let planKey = null;
      if (body.planKey) {
        const plan = await planOf(store, String(body.planKey));
        if (!plan) {
          sendJson(res, 400, { error: 'That product does not exist in this store.' });
          return;
        }
        planKey = plan.id;
      }
      const maxUses = body.maxUses === null || body.maxUses === undefined || body.maxUses === '' ? null : Math.round(Number(body.maxUses));
      if (maxUses !== null && (!Number.isFinite(maxUses) || maxUses < 1)) {
        sendJson(res, 400, { error: 'Usage limit must be a whole number of at least 1.' });
        return;
      }
      // A date-only value from the form means "valid through that day" in
      // the owner's intent — pin it to end-of-day UTC so the code neither
      // dies the evening before (west of UTC) nor lists back a different day.
      const rawExpiry = String(body.expiresAt ?? '');
      const expiresAt = body.expiresAt
        ? Math.floor(new Date(/^\d{4}-\d{2}-\d{2}$/.test(rawExpiry) ? `${rawExpiry}T23:59:59Z` : rawExpiry).getTime() / 1000)
        : null;
      if (expiresAt !== null && !(expiresAt > Math.floor(Date.now() / 1000))) {
        sendJson(res, 400, { error: 'The expiry must be in the future.' });
        return;
      }
      const discount = await db.createDiscount({ storeId: store.id, code, kind, amount, planKey, maxUses, expiresAt });
      sendJson(res, 200, { ok: true, discount });
      return;
    }

    case 'delete': {
      const code = String(body.code ?? '').trim().toUpperCase();
      if (!(await db.getDiscount(store.id, code))) {
        sendJson(res, 404, { error: 'unknown code' });
        return;
      }
      await db.deleteDiscount(store.id, code);
      sendJson(res, 200, { ok: true });
      return;
    }

    default:
      sendJson(res, 400, { error: 'unknown action' });
  }
});
