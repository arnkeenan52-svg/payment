// Tiny helpers shared by the router and route handlers.

// 1 MiB is plenty for any webhook or form, and it is the ceiling every
// signature-verifying path keeps. Routes that carry an owner's upload (a
// product photo, a store banner) pass their own larger maxBytes: Vercel
// pre-parses those bodies, but under the dev shim (and therefore the whole
// e2e suite) the stream is read here, where a 1 MiB cap rejected uploads the
// data-URL whitelist itself allows.
const MAX_BODY = 1024 * 1024;

// Raw body, exactly as sent — signatures are HMACs over these bytes.
// CRITICAL Vercel detail: the platform defines req.body as a LAZY GETTER that
// parses (and consumes) the stream on first access. Merely probing req.body
// destroys the raw bytes, so we inspect the property descriptor instead:
// a getter (or absent property) means the stream is still untouched — read it.
// Only a plain pre-set value is used directly (Buffer/string), and a plain
// parsed object is a clean, catchable error — never a function crash.
export function readRawBody(req, maxBytes = MAX_BODY) {
  const desc = Object.getOwnPropertyDescriptor(req, 'body');
  if (desc && 'value' in desc && desc.value !== undefined && desc.value !== null) {
    if (Buffer.isBuffer(desc.value)) return Promise.resolve(desc.value);
    if (typeof desc.value === 'string') return Promise.resolve(Buffer.from(desc.value));
    return Promise.reject(new Error('RAW_BODY_UNAVAILABLE'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// JSON body for ordinary API routes. Here a parsed req.body is welcome —
// accessing the Vercel getter is fine because we want the parsed value.
export async function readJsonBody(req, { maxBytes = MAX_BODY } = {}) {
  if (req.body !== undefined && req.body !== null && !Buffer.isBuffer(req.body) && typeof req.body === 'object') {
    return cleanBody(req.body);
  }
  if (typeof req.body === 'string') return cleanBody(req.body.length ? JSON.parse(req.body) : {});
  const raw = await readRawBody(req, maxBytes);
  if (raw.length === 0) return {};
  return cleanBody(JSON.parse(raw.toString('utf8')));
}

// What every handler may assume about a parsed body: it is an object, and
// none of its strings carry U+0000. The literal `null` is valid JSON, so
// JSON.parse hands it back and the `.catch(() => ({}))` every caller wraps
// this in never fires — the next `body.store` was a TypeError and a 500.
// The NUL byte has no place in any field Dues stores, and the two storage
// engines disagree about it in the worst way: Postgres refuses it with a 500
// ("invalid byte sequence for encoding UTF8"), SQLite silently truncates the
// string at it. Strip it once here rather than in each of the forty fields.
function cleanBody(parsed) {
  if (!parsed || typeof parsed !== 'object') return {};
  return stripNul(parsed);
}

function stripNul(v) {
  if (typeof v === 'string') return v.includes('\0') ? v.replaceAll('\0', '') : v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = stripNul(v[i]);
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) v[k] = stripNul(v[k]);
  }
  return v;
}

// On Vercel there is no outer router to catch a throwing handler — an
// uncaught error becomes an opaque FUNCTION_INVOCATION_FAILED page. Every
// api/ default export is wrapped in this instead.
export function guard(handler) {
  return async function guarded(req, res) {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[api] ${req.method} ${req.url} → ${err.stack ?? err.message}`);
      if (!res.headersSent) sendText(res, 500, 'internal error');
      else res.end();
    }
  };
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

export function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

export function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { location, ...extraHeaders });
  res.end();
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    // A value that will not decode is still a value: one stray `%` in ANY
    // cookie on the domain must not turn every session-reading route into a
    // 500. An undecodable session simply fails the HMAC check downstream.
    let value = part.slice(i + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep the raw value
    }
    out[part.slice(0, i).trim()] = value;
  }
  return out;
}

export function cookieHeader(name, value, { maxAge = null, path = '/', domain = null, secure = false } = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax`;
  if (maxAge !== null) cookie += `; Max-Age=${maxAge}`;
  if (domain) cookie += `; Domain=${domain}`;
  if (secure) cookie += `; Secure`;
  return cookie;
}
