import { redirect, sendText, parseCookies, guard } from '../../src/lib/http.js';
import { clearSessionCookie, SESSION_COOKIE } from '../../src/lib/session.js';

// Signing out is a POST. The session cookie is SameSite=Lax, which browsers
// still send on cross-site top-level GETs — so a GET that cleared it would
// let any third-party link, redirect or meta refresh sign a seller out in
// the middle of a task. The pages' own Sign out buttons submit a form; a
// bare GET (an old bookmark, a hand-typed URL) gets a confirm page instead.
const confirmPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#131b2d" />
  <meta name="robots" content="noindex" />
  <title>Sign out — Dues</title>
  <style>
    html { background: #101827; color: #f2f5fa; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
    main { max-width: 360px; width: 100%; padding: 28px; border: 1px solid rgba(148, 163, 190, 0.16); background: #182338; border-radius: 12px; }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0 0 20px; color: #b7c1d4; }
    .row { display: flex; gap: 12px; align-items: center; }
    button { font: inherit; font-weight: 600; color: #fff; background: #5865f2; border: 0; border-radius: 8px; padding: 10px 18px; cursor: pointer; }
    button:hover { background: #4752e8; }
    a { color: #b7c1d4; }
  </style>
</head>
<body>
  <main>
    <h1>Sign out of Dues?</h1>
    <p>You will need to sign in with Discord again to manage your store or membership.</p>
    <form method="post" action="/auth/logout" class="row">
      <button type="submit">Sign out</button>
      <a href="/">Stay signed in</a>
    </form>
  </main>
</body>
</html>
`;

export default guard(function handler(req, res) {
  if (req.method === 'POST') {
    // Lax keeps the session cookie off cross-site POSTs, so a POST that
    // carries one is same-site by construction. One without it has nothing
    // to sign out of and clears nothing.
    const signedIn = Boolean(parseCookies(req)[SESSION_COOKIE]);
    redirect(res, '/', signedIn ? { 'set-cookie': clearSessionCookie() } : {});
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'method not allowed', { allow: 'GET, POST' });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? '' : confirmPage);
});
