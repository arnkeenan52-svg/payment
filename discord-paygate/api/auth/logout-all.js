import { sendJson, guard } from '../../src/lib/http.js';
import { sessionUserId, clearSessionCookie, revokeAllSessions } from '../../src/lib/session.js';

// "Log out everywhere": bumps the caller's session generation so every cookie
// issued so far — a stolen laptop's included — is refused from now on, then
// clears this browser's. POST + JSON only, from a same-origin fetch: a
// cross-site form cannot send application/json, and the session cookie is
// SameSite=Lax besides.
export default guard(async function handler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    sendJson(res, 415, { error: 'send JSON' });
    return;
  }
  const uid = await sessionUserId(req);
  if (!uid) {
    sendJson(res, 401, { error: 'sign in first' });
    return;
  }
  await revokeAllSessions(uid);
  res.setHeader('set-cookie', clearSessionCookie());
  sendJson(res, 200, { ok: true });
});
