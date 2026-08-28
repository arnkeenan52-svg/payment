// Following a store. A signed-in Discord account may follow a tenant store;
// the store gets a follower COUNT and nothing else — no client, owner or
// buyer, is ever handed a roster of who follows it.
//
// Both directions are idempotent, because the button is the kind of thing
// people double-tap: following twice inserts nothing and still answers 200,
// and unfollowing something you do not follow is a 200, not a 404.
import { sendJson, sendText, readJsonBody, guard } from '../src/lib/http.js';
import { sessionUserId } from '../src/lib/session.js';
import * as db from '../src/db.js';
import { storeBySlug } from '../src/services/stores.js';
import { DEMO_SLUG } from '../src/services/demo-store.js';

// Counted from the follow ledger itself rather than a side counter: nothing
// to drift, and a repeat follow (which inserts no row) costs the caller
// nothing. Generous for a human, useless for inflating a number.
const WINDOW_SECONDS = 60;
const MAX_FOLLOWS_PER_WINDOW = 20;

export default guard(async function handler(req, res) {
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  const uid = sessionUserId(req);
  if (!uid) {
    sendJson(res, 401, { error: 'sign in first' });
    return;
  }
  const body = await readJsonBody(req).catch(() => ({}));
  const action = String(body.action ?? 'follow');
  if (action !== 'follow' && action !== 'unfollow') {
    sendJson(res, 400, { error: 'unknown action' });
    return;
  }
  const slug = String(body.store ?? '').toLowerCase();
  // The demo store and the built-in (virtual, id null) store have no row to
  // key a follow on, so they are unknown here exactly like a typo'd link —
  // the same thing /api/plans says by reporting them followable: false.
  const store = /^[a-z0-9-]{1,40}$/.test(slug) && slug !== DEMO_SLUG ? await storeBySlug(slug) : null;
  if (!store || store.id === null || store.id === undefined) {
    sendJson(res, 404, { error: 'unknown store' });
    return;
  }

  if (action === 'follow') {
    // A seller padding their own store 0 → 1 is exactly the number nobody
    // should trust, so the one account that cannot follow a store is its own.
    if (store.ownerDiscordId && String(store.ownerDiscordId) === String(uid)) {
      sendJson(res, 409, { error: 'You cannot follow your own store.' });
      return;
    }
    const recent = await db.countRecentFollowsBy(uid, Math.floor(Date.now() / 1000) - WINDOW_SECONDS);
    if (recent >= MAX_FOLLOWS_PER_WINDOW) {
      sendJson(res, 429, { error: 'That is a lot of follows — try again in a minute.' });
      return;
    }
    await db.followStore(store.id, uid);
  } else {
    await db.unfollowStore(store.id, uid);
  }

  // Recomputed after the write, so the number the button shows is the number
  // the database holds — never the client's optimistic guess.
  sendJson(res, 200, {
    ok: true,
    store: store.slug,
    following: action === 'follow',
    followers: await db.countStoreFollowers(store.id),
  });
});
