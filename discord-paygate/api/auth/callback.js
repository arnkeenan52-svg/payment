import { sendText, redirect, parseCookies, cookieHeader, guard } from '../../src/lib/http.js';
import { exchangeOAuthCode, fetchOAuthUser } from '../../src/lib/discord.js';
import { createSessionCookie } from '../../src/lib/session.js';
import { upsertUser } from '../../src/db.js';
import { reconcile } from '../../src/services/entitlements.js';
import { STATE_COOKIE, PLAN_COOKIE } from './login.js';

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
    sendText(res, 400, 'OAuth state mismatch — start again from /auth/login');
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
    await reconcile(me.id);
  } catch (err) {
    console.error(`[auth] post-login reconcile for ${me.id} failed: ${err.message}`);
  }

  const plan = /^[a-z0-9_-]{1,64}$/i.test(cookies[PLAN_COOKIE] ?? '') ? cookies[PLAN_COOKIE] : '';
  redirect(res, plan ? `/?plan=${encodeURIComponent(plan)}` : '/', {
    'set-cookie': [
      createSessionCookie(me.id),
      cookieHeader(STATE_COOKIE, '', { maxAge: 0 }),
      cookieHeader(PLAN_COOKIE, '', { maxAge: 0 }),
    ],
  });
});
