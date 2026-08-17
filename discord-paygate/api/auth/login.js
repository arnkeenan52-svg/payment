import crypto from 'node:crypto';
import { redirect, cookieHeader } from '../../src/lib/http.js';
import { authorizeUrl } from '../../src/lib/discord.js';

export const STATE_COOKIE = 'tl_oauth_state';

export default function handler(req, res) {
  const state = crypto.randomBytes(16).toString('hex');
  redirect(res, authorizeUrl(state), {
    'set-cookie': cookieHeader(STATE_COOKIE, state, { maxAge: 600 }),
  });
}
