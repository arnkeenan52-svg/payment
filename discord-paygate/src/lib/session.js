import crypto from 'node:crypto';
import { config } from '../config.js';
import { parseCookies, cookieHeader } from './http.js';

export const SESSION_COOKIE = 'tl_session';
const SESSION_TTL_SECONDS = 7 * 24 * 3600;

const sign = (payload) =>
  crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');

export function createSessionCookie(discordId) {
  const payload = Buffer.from(
    JSON.stringify({ uid: discordId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }),
  ).toString('base64url');
  return cookieHeader(SESSION_COOKIE, `${payload}.${sign(payload)}`, { maxAge: SESSION_TTL_SECONDS });
}

export function clearSessionCookie() {
  return cookieHeader(SESSION_COOKIE, '', { maxAge: 0 });
}

// Returns the logged-in discord id, or null for missing/tampered/expired cookies.
export function sessionUserId(req) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = raw.slice(0, dot);
  const mac = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!uid || exp < Math.floor(Date.now() / 1000)) return null;
    return String(uid);
  } catch {
    return null;
  }
}
