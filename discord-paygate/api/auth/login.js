import crypto from 'node:crypto';
import { redirect, cookieHeader, guard } from '../../src/lib/http.js';
import { cookieAttrs } from '../../src/lib/session.js';
import { authorizeUrl } from '../../src/lib/discord.js';

export const STATE_COOKIE = 'tl_oauth_state';
// Which plan the buyer was on when they hit "Sign in to continue" — the
// callback sends them back to it so they land ready to pay, not at the top.
export const PLAN_COOKIE = 'tl_checkout_plan';

export default guard(function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const plan = /^[a-z0-9_-]{1,64}$/i.test(url.searchParams.get('plan') ?? '') ? url.searchParams.get('plan') : '';
  // A ".r" suffix marks an automatic retry after a state mismatch. It rides
  // inside the OAuth state (server round-trip, no cookies needed), so the
  // callback can stop after ONE retry instead of looping on browsers that
  // refuse cookies entirely.
  const retry = url.searchParams.get('retry') === '1';
  const state = crypto.randomBytes(16).toString('hex') + (retry ? '.r' : '');
  const cookies = [cookieHeader(STATE_COOKIE, state, { maxAge: 600, ...cookieAttrs() })];
  if (plan) cookies.push(cookieHeader(PLAN_COOKIE, plan, { maxAge: 600, ...cookieAttrs() }));
  redirect(res, authorizeUrl(state), { 'set-cookie': cookies });
});
