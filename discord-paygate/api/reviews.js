// Store reviews. The one rule everything here enforces:
//
//   A rating is arithmetic over rows the payment ledger can prove. A seller
//   controls whether the rating block EXISTS on their page. A seller never
//   controls WHICH ROWS IT CONTAINS.
//
// So: only an account that actually paid this store may write one; the author
// may edit or withdraw their own; the seller may reply and nothing else. There
// is deliberately no endpoint, parameter or flag by which a seller can remove,
// hide, reorder or filter an individual review — a seller who can subtract a
// one-star has authored the average, and an average someone authored is not a
// rating. The seller's only lever is the all-or-nothing switch on their store,
// which hides the score and every review together.
import { sendJson, sendText, readJsonBody, guard } from '../src/lib/http.js';
import { sessionUserId } from '../src/lib/session.js';
import * as db from '../src/db.js';
import { storeBySlug } from '../src/services/stores.js';
import { DEMO_SLUG } from '../src/services/demo-store.js';

const MAX_BODY = 1500;
const PAGE = 20;
// A buyer's first impression is not a review. Three days is long enough that
// "I paid and the roles arrived" has become "was this worth it", and short
// enough that nobody forgets they meant to say something.
const COOLING_SECONDS = 72 * 60 * 60;
const WINDOW_SECONDS = 60;
const MAX_WRITES_PER_WINDOW = 10;

const nowSec = () => Math.floor(Date.now() / 1000);

// What a review looks like to ANY client. Note what is absent: the author's
// Discord snowflake. The storefront gets a display name and nothing that
// identifies the account behind it to other buyers.
const publicReview = (r, { viewerId = null } = {}) => ({
  id: r.id,
  rating: r.rating,
  body: r.body,
  createdAt: r.createdAt,
  edited: r.updatedAt > r.createdAt,
  reply: r.replyBody ? { body: r.replyBody, at: r.replyAt } : null,
  mine: viewerId !== null && String(r.authorDiscordId) === String(viewerId),
});

// The reviewer's display name. Reviews are public under the reviewer's Discord
// username — the composer says so before they post — but the id never ships.
async function nameFor(discordId) {
  const u = await db.getUser(discordId).catch(() => null);
  return u?.username ?? null;
}

async function withNames(rows, viewerId) {
  return Promise.all(
    rows.map(async (r) => ({ ...publicReview(r, { viewerId }), author: await nameFor(r.authorDiscordId) })),
  );
}

// The write gate, asked up front. Exactly the checks the POST runs, in the
// same order, so the storefront offers the composer only to someone whose
// post will land — and can say why to someone whose post would not.
async function writeBlock(store, uid) {
  if (!uid) return 'signin';
  if (store.ownerDiscordId && String(store.ownerDiscordId) === String(uid)) return 'owner';
  const purchaseAt = await db.firstPurchaseAt(store.id, uid);
  if (purchaseAt === null) return 'notbuyer';
  if (nowSec() - purchaseAt < COOLING_SECONDS) return 'cooling';
  return null;
}

async function resolveStore(slug) {
  if (!/^[a-z0-9-]{1,40}$/.test(slug) || slug === DEMO_SLUG) return null;
  const store = await storeBySlug(slug);
  // The built-in store is virtual (id null): no row, so no review ledger.
  if (!store || store.id === null || store.id === undefined) return null;
  return store;
}

export default guard(async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const uid = sessionUserId(req);

  if (req.method === 'GET') {
    const store = await resolveStore(String(url.searchParams.get('store') ?? '').toLowerCase());
    if (!store) return sendJson(res, 404, { error: 'unknown store' });
    // Reviews off = the section does not exist publicly. Two people still see
    // rows: the SELLER, because hiding reviews from their storefront must not
    // blind them to what buyers said; and a REVIEWER, who gets back their own
    // row only, because words you wrote should not become unreachable to you
    // just because someone else switched the display off.
    const isOwner = uid && store.ownerDiscordId && String(store.ownerDiscordId) === String(uid);
    const block = await writeBlock(store, uid);
    if (!store.reviewsOn && !isOwner) {
      const own = uid ? await db.getReviewByAuthor(store.id, uid) : null;
      return sendJson(res, 200, {
        reviews: own ? await withNames([own], uid) : [],
        count: 0,
        average: null,
        more: false,
        on: false,
        canWrite: block === null,
        writeBlock: block,
      });
    }

    const beforeRaw = url.searchParams.get('before');
    // Digits are not enough: twenty of them pass the regex, overflow a bigint
    // on Postgres, and 500 the endpoint. SQLite shrugged, so the suite never saw it.
    const before = beforeRaw && /^\d{1,15}$/.test(beforeRaw) && Number.isSafeInteger(Number(beforeRaw)) ? Number(beforeRaw) : null;
    const rows = await db.listReviews(store.id, { limit: PAGE + 1, before });
    const page = rows.slice(0, PAGE);
    const summary = await db.reviewSummary(store.id);
    return sendJson(res, 200, {
      reviews: await withNames(page, uid),
      count: summary.count,
      average: summary.average,
      more: rows.length > PAGE,
      cursor: page.length ? page[page.length - 1].id : null,
      on: Boolean(store.reviewsOn),
      canWrite: block === null,
      writeBlock: block,
    });
  }

  if (req.method !== 'POST') return sendText(res, 405, 'method not allowed');
  if (!uid) return sendJson(res, 401, { error: 'sign in first' });

  const body = await readJsonBody(req).catch(() => ({}));
  const store = await resolveStore(String(body.store ?? '').toLowerCase());
  if (!store) return sendJson(res, 404, { error: 'unknown store' });
  const action = String(body.action ?? 'write');

  // ── the seller's reply ──────────────────────────────────────────────────
  // Reachable only by the store's owner, and it can set exactly one column.
  if (action === 'reply') {
    if (!store.ownerDiscordId || String(store.ownerDiscordId) !== String(uid)) {
      return sendJson(res, 403, { error: 'not your store' });
    }
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id <= 0) return sendJson(res, 400, { error: 'which review?' });
    const target = await db.getReviewById(id);
    if (!target || target.storeId !== store.id) return sendJson(res, 404, { error: 'unknown review' });
    const text = body.body === null || body.body === '' ? null : String(body.body).trim().slice(0, MAX_BODY);
    await db.setReviewReply(id, store.id, text || null);
    return sendJson(res, 200, { ok: true, id, reply: text || null });
  }

  // ── the buyer's own review ──────────────────────────────────────────────
  // A seller reviewing their own store is the one number nobody should trust,
  // the same reasoning that stops an owner following their own store.
  if (store.ownerDiscordId && String(store.ownerDiscordId) === String(uid)) {
    return sendJson(res, 409, { error: 'You cannot review your own store.' });
  }

  if (action === 'withdraw') {
    const gone = await db.deleteOwnReview(store.id, uid);
    const summary = await db.reviewSummary(store.id);
    return sendJson(res, 200, { ok: true, withdrawn: gone, count: summary.count, average: summary.average });
  }
  if (action !== 'write') return sendJson(res, 400, { error: 'unknown action' });

  // The gate: real money, recorded by a webhook, from this account to this
  // store. Deliberately indifferent to whether the membership is still active
  // — otherwise a seller could silence a critic by revoking them.
  const purchaseAt = await db.firstPurchaseAt(store.id, uid);
  if (purchaseAt === null) {
    return sendJson(res, 403, { error: 'Only people who bought from this store can review it.' });
  }
  if (nowSec() - purchaseAt < COOLING_SECONDS) {
    return sendJson(res, 403, { error: 'Reviews open three days after your purchase — give it a proper go first.' });
  }

  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return sendJson(res, 400, { error: 'Pick a rating from 1 to 5 stars.' });
  }
  const text = body.body === null || body.body === undefined ? '' : String(body.body).trim();
  if (text.length > MAX_BODY) {
    return sendJson(res, 400, { error: `Keep it under ${MAX_BODY} characters.` });
  }

  const recent = await db.countRecentReviewsBy(uid, nowSec() - WINDOW_SECONDS);
  if (recent >= MAX_WRITES_PER_WINDOW) {
    return sendJson(res, 429, { error: 'Slow down a moment and try again.' });
  }

  const saved = await db.upsertReview({ storeId: store.id, discordId: uid, rating, body: text || null, purchaseAt });
  const summary = await db.reviewSummary(store.id);
  return sendJson(res, 200, {
    ok: true,
    review: { ...publicReview(saved, { viewerId: uid }), author: await nameFor(uid) },
    count: summary.count,
    average: summary.average,
  });
});
