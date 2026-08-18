import { sendText, redirect, parseCookies, cookieHeader, guard } from '../../src/lib/http.js';
import { exchangeOAuthCode, fetchOAuthUser } from '../../src/lib/discord.js';
import { createSessionCookie, cookieAttrs } from '../../src/lib/session.js';
import { upsertUser } from '../../src/db.js';
import { reconcileEverywhere } from '../../src/services/entitlements.js';
import { STATE_COOKIE, PLAN_COOKIE, STORE_COOKIE } from './login.js';

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
    sendText(
      res,
      400,
      'Sign-in could not complete because your browser did not keep the login cookie. ' +
        'If you opened this inside another app (like Discord), open it in your normal browser and try again from the store page.',
    );
    return;
  }

  const token = await exchangeOAuthCode(code);
  const me = await fetchOAuthUser(token.access_token);
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
  const base = storeSlug && storeSlug !== 'store' ? `/${encodeURIComponent(storeSlug)}` : '/store';
  redirect(res, plan ? `${base}?plan=${encodeURIComponent(plan)}` : base, {
    'set-cookie': [
      createSessionCookie(me.id),
      cookieHeader(STATE_COOKIE, '', { maxAge: 0, ...cookieAttrs() }),
      cookieHeader(PLAN_COOKIE, '', { maxAge: 0, ...cookieAttrs() }),
      cookieHeader(STORE_COOKIE, '', { maxAge: 0, ...cookieAttrs() }),
    ],
  });
});
