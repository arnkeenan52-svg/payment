import { sendJson, sendText, readJsonBody, guard } from '../../src/lib/http.js';
import { ownerAuthorized } from '../../src/lib/authz.js';
import { sessionUserId } from '../../src/lib/session.js';
import * as db from '../../src/db.js';
import { storeBySlug } from '../../src/services/stores.js';
import { sealSecret } from '../../src/lib/secretbox.js';
import { stripeFetch } from '../../src/lib/stripe.js';

// Store identity settings: name, description, banner, custom link (slug).
// Tenant stores only — the built-in store is env-configured.
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
  const store = await storeBySlug(String(body.store ?? ''));
  if (!store || store.id === null || store.id === undefined) {
    sendJson(res, 404, { error: 'unknown store' });
    return;
  }
  if (!(ownerAuthorized(req) || (store.ownerDiscordId && store.ownerDiscordId === uid))) {
    sendJson(res, 403, { error: 'not your store' });
    return;
  }

  const fields = {};
  // Rotate the Stripe key: validated against Stripe before anything is saved.
  if (body.stripeKey !== undefined && String(body.stripeKey).trim() !== '') {
    const key = String(body.stripeKey).trim();
    if (!/^(sk|rk)_(live|test)_/.test(key)) {
      return sendJson(res, 400, { error: 'That does not look like a Stripe secret key (sk_live_… or sk_test_…).' });
    }
    try {
      await stripeFetch('/v1/account', { key });
    } catch {
      return sendJson(res, 400, { error: 'Stripe rejected that key. Copy the Secret key from Stripe → Developers → API keys.' });
    }
    fields.stripeSecretEnc = sealSecret(key);
  }
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 60);
    if (!name) return sendJson(res, 400, { error: 'Give your store a name.' });
    fields.name = name;
  }
  if (body.description !== undefined) fields.description = String(body.description).trim().slice(0, 500) || null;
  if (body.bannerUrl !== undefined) {
    const u = String(body.bannerUrl).trim();
    if (u && !/^https:\/\/\S+$/.test(u)) return sendJson(res, 400, { error: 'The banner URL must start with https:// (1500×400 works best).' });
    fields.bannerUrl = u ? u.slice(0, 500) : null;
  }
  if (body.slug !== undefined) {
    const slug = String(body.slug).trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(slug)) {
      return sendJson(res, 400, { error: 'Links are 2–40 lowercase letters, numbers and dashes.' });
    }
    if (slug !== store.slug) {
      if (slug === 'store' || (await db.getStoreBySlug(slug))) {
        return sendJson(res, 409, { error: 'That link is taken — pick another.' });
      }
      fields.slug = slug;
    }
  }
  const row = await db.updateStore(store.id, fields);
  sendJson(res, 200, {
    ok: true,
    store: { slug: row.slug, name: row.name, description: row.description ?? null, bannerUrl: row.banner_url ?? null, status: row.status },
  });
});
