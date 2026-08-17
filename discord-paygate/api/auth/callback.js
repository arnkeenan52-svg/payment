import { sendText, redirect, parseCookies, cookieHeader } from '../../src/lib/http.js';
import { exchangeOAuthCode, fetchOAuthUser } from '../../src/lib/discord.js';
import { createSessionCookie } from '../../src/lib/session.js';
import { upsertUser } from '../../src/db.js';
import { reconcile } from '../../src/services/entitlements.js';
import { STATE_COOKIE } from './login.js';

// OAuth callback: state check → code exchange → identify → store the access
// token (we need it later for guilds.join) → reconcile so an already-paid
// buyer gets pulled into the guild with their role the moment they log in.
export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = parseCookies(req)[STATE_COOKIE];
  if (!code || !state || !expectedState || state !== expectedState) {
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

  redirect(res, '/', {
    'set-cookie': [createSessionCookie(me.id), cookieHeader(STATE_COOKIE, '', { maxAge: 0 })],
  });
}
