import crypto from 'node:crypto';
import { sendText, redirect, parseCookies, cookieHeader } from '../lib/http.js';
import { authorizeUrl, exchangeOAuthCode, fetchOAuthUser } from '../lib/discord.js';
import { createSessionCookie, clearSessionCookie } from '../lib/session.js';
import { upsertUser } from '../db.js';
import { reconcile } from '../services/entitlements.js';

const STATE_COOKIE = 'tl_oauth_state';

export function handleLogin(req, res) {
  const state = crypto.randomBytes(16).toString('hex');
  redirect(res, authorizeUrl(state), {
    'set-cookie': cookieHeader(STATE_COOKIE, state, { maxAge: 600 }),
  });
}

// OAuth callback: state check → code exchange → identify → store the access
// token (we need it later for guilds.join) → reconcile so an already-paid
// buyer gets pulled into the guild with their roles the moment they log in.
export async function handleCallback(req, res, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = parseCookies(req)[STATE_COOKIE];
  if (!code || !state || !expectedState || state !== expectedState) {
    sendText(res, 400, 'OAuth state mismatch — start again from /auth/login');
    return;
  }

  const token = await exchangeOAuthCode(code);
  const me = await fetchOAuthUser(token.access_token);
  upsertUser({
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

export function handleLogout(req, res) {
  redirect(res, '/', { 'set-cookie': clearSessionCookie() });
}
