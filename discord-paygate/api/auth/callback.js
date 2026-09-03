import { sendText, redirect, parseCookies, cookieHeader, guard } from '../../src/lib/http.js';
import { exchangeOAuthCode, fetchOAuthUser } from '../../src/lib/discord.js';
import { createSessionCookie, cookieAttrs } from '../../src/lib/session.js';
import { upsertUser, sessionGeneration } from '../../src/db.js';
import { reconcileEverywhere } from '../../src/services/entitlements.js';
import { STATE_COOKIE, PLAN_COOKIE, STORE_COOKIE } from './login.js';

// Set for a few minutes when Discord itself failed the exchange, so the
// refresh that lands on the mismatch branch below can tell "we spent your
// state cookie" apart from "your browser never kept it".
const FAIL_COOKIE = 'tl_oauth_fail';

// OAuth callback: state check → code exchange → identify → store the access
// token (we need it later for guilds.join) → reconcile so an already-paid
// buyer gets pulled into the guild with their role the moment they log in.
// Then land the buyer back on the plan they were buying, ready to pay.
export default guard(async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookies = parseCookies(req);
  if (!code || !state || !cookies[STATE_COOKIE] || state !== cookies[STATE_COOKIE]) {
    // The browser lost (or never kept) the state cookie — common across the
    // apex↔www host hop and in in-app browsers. Retry exactly once with a
    // fresh state; the ".r" marker in the returned state stops a loop.
    if (state && !state.endsWith('.r')) {
      redirect(res, '/auth/login?retry=1');
      return;
    }
    // The cookie can also be missing because WE spent it: the failure branch
    // below clears it on every Discord failure, so a refresh of that page
    // arrives here having kept every cookie it was given. Diagnosing a
    // cookie-refusing browser there sends a buyer who is mid-purchase to fix
    // a problem they do not have — name the outage that actually happened.
    if (cookies[FAIL_COOKIE]) {
      sendText(
        res,
        502,
        'Discord did not complete the sign-in. Go back to the store page and try again in a minute.',
        { 'set-cookie': cookieHeader(FAIL_COOKIE, '', { maxAge: 0, ...cookieAttrs() }) },
      );
      return;
    }
    sendText(
      res,
      400,
      'Sign-in could not complete because your browser did not keep the login cookie. ' +
        'If you opened this inside another app (like Discord), open it in your normal browser and try again from the store page.',
    );
    return;
  }

  let token;
  let me;
  try {
    token = await exchangeOAuthCode(code);
    me = await fetchOAuthUser(token.access_token);
  } catch (err) {
    // A code Discord refuses (reused, expired — `invalid_grant`) or Discord
    // down for the exchange. The state cookie is spent either way: if it
    // stayed, every refresh of this URL would match it and fail the same
    // way forever, never reaching the recovery branch above. Clear it, so
    // the next attempt mints a fresh login; the plan/store cookies stay so
    // that attempt still lands on the plan the buyer was buying.
    console.error(`[auth] discord sign-in for code ${code.slice(0, 8)}… failed: ${err.message}`);
    sendText(
      res,
      502,
      'Discord did not complete the sign-in. Go back to the store page and try again.',
      {
        'set-cookie': [
          cookieHeader(STATE_COOKIE, '', { maxAge: 0, ...cookieAttrs() }),
          cookieHeader(FAIL_COOKIE, '1', { maxAge: 300, ...cookieAttrs() }),
        ],
      },
    );
    return;
  }
  await upsertUser({
    discordId: me.id,
    username: me.username,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
  });

  try {
    await reconcileEverywhere(me.id);
  } catch (err) {
    console.error(`[auth] post-login reconcile for ${me.id} failed: ${err.message}`);
  }

  const plan = /^[a-z0-9_-]{1,64}$/i.test(cookies[PLAN_COOKIE] ?? '') ? cookies[PLAN_COOKIE] : '';
  const storeSlug = /^[a-z0-9-]{1,40}$/.test(cookies[STORE_COOKIE] ?? '') ? cookies[STORE_COOKIE] : '';
  // Every live flow carries the store it started from. A sign-in with no
  // store context (homepage, stale links) belongs on the dashboard — it is
  // never routed to any particular store.
  const base = storeSlug && storeSlug !== 'store' ? `/${encodeURIComponent(storeSlug)}` : '/dashboard';
  redirect(res, plan ? `${base}?plan=${encodeURIComponent(plan)}` : base, {
    'set-cookie': [
      createSessionCookie(me.id, await sessionGeneration(me.id)),
      cookieHeader(STATE_COOKIE, '', { maxAge: 0, ...cookieAttrs() }),
      cookieHeader(FAIL_COOKIE, '', { maxAge: 0, ...cookieAttrs() }),
      cookieHeader(PLAN_COOKIE, '', { maxAge: 0, ...cookieAttrs() }),
      cookieHeader(STORE_COOKIE, '', { maxAge: 0, ...cookieAttrs() }),
    ],
  });
});
