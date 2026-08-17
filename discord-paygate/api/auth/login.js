import crypto from 'node:crypto';
import { redirect, cookieHeader } from '../../src/lib/http.js';
import { authorizeUrl } from '../../src/lib/discord.js';

export const STATE_COOKIE = 'tl_oauth_state';
// Which plan the buyer was on when they hit "Sign in to continue" — the
// callback sends them back to it so they land ready to pay, not at the top.
export const PLAN_COOKIE = 'tl_checkout_plan';

export default function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const plan = /^[a-z0-9_-]{1,64}$/i.test(url.searchParams.get('plan') ?? '') ? url.searchParams.get('plan') : '';
  const state = crypto.randomBytes(16).toString('hex');
  const cookies = [cookieHeader(STATE_COOKIE, state, { maxAge: 600 })];
  if (plan) cookies.push(cookieHeader(PLAN_COOKIE, plan, { maxAge: 600 }));
  redirect(res, authorizeUrl(state), { 'set-cookie': cookies });
}
