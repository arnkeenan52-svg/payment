import crypto from 'node:crypto';
import { config } from '../config.js';
import { parseCookies, cookieHeader } from './http.js';
import { sessionGeneration, bumpSessionGeneration } from '../db.js';

export const SESSION_COOKIE = 'tl_session';
const SESSION_TTL_SECONDS = 7 * 24 * 3600;
// How long a user's session generation is trusted in-process before the DB
// is asked again. Keeps the hot path free of a read per request; a revoke on
// another instance takes effect there within this window (the instance that
// performed it refreshes its own cache at once).
const GENERATION_CACHE_MS = 60 * 1000;

const sign = (payload) =>
  crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');

// Shared attributes for every auth cookie: registrable-domain scope (so apex
// and www share them across the OAuth hop) and Secure on HTTPS deployments.
export const cookieAttrs = () => ({ domain: config.cookieDomain, secure: config.secureCookies });

// `generation` is the user's current session generation (users.session_gen);
// the cookie is refused once the row moves past it ("log out everywhere").
export function createSessionCookie(discordId, generation) {
  const payload = Buffer.from(
    JSON.stringify({ uid: discordId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS, gen: generation }),
  ).toString('base64url');
  return cookieHeader(SESSION_COOKIE, `${payload}.${sign(payload)}`, { maxAge: SESSION_TTL_SECONDS, ...cookieAttrs() });
}

// Logout clears both the domain-scoped cookie and any older host-only one.
export function clearSessionCookie() {
  const clears = [cookieHeader(SESSION_COOKIE, '', { maxAge: 0, ...cookieAttrs() })];
  if (config.cookieDomain) clears.push(cookieHeader(SESSION_COOKIE, '', { maxAge: 0 }));
  return clears;
}

// uid -> { gen, at } — the generation last read for that user, and when.
const generationCache = new Map();

async function currentGeneration(uid) {
  const hit = generationCache.get(uid);
  if (hit && Date.now() - hit.at < GENERATION_CACHE_MS) return hit.gen;
  const gen = await sessionGeneration(uid);
  // Entries are never evicted individually; a flat cap keeps the map from
  // growing with every user that ever signed in on this instance.
  if (generationCache.size >= 10_000) generationCache.clear();
  generationCache.set(uid, { gen, at: Date.now() });
  return gen;
}

// Invalidates every session cookie this user holds, on every device, and
// returns the generation a replacement cookie must carry.
export async function revokeAllSessions(uid) {
  const gen = await bumpSessionGeneration(uid);
  generationCache.set(uid, { gen, at: Date.now() });
  return gen;
}

// Returns the logged-in discord id, or null for missing/tampered/expired/revoked cookies.
export async function sessionUserId(req) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = raw.slice(0, dot);
  const mac = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;
  let uid;
  let exp;
  let gen;
  try {
    ({ uid, exp, gen } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
  // exp must be a real number: a payload missing it must fail closed, never
  // be treated as a non-expiring session (undefined < now is false).
  if (!uid || typeof exp !== 'number' || exp < Math.floor(Date.now() / 1000)) return null;
  // Cookies issued before generations existed carry none; they stay valid
  // until their own expiry so a deploy does not log everyone out, and the
  // next login issues one with a generation. Anything else that is not a
  // number is a forgery attempt, and a stale generation is a revoked session.
  if (gen !== undefined) {
    if (typeof gen !== 'number' || gen !== (await currentGeneration(String(uid)))) return null;
  }
  return String(uid);
}
