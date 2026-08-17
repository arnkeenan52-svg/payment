// Tiny helpers shared by the router and route handlers.

const MAX_BODY = 1024 * 1024; // 1 MiB is plenty for any webhook or form we accept

// Raw body, exactly as sent. On Vercel this requires the function to export
// `config = { api: { bodyParser: false } }` — a parsed-and-reserialised body
// would break webhook signature verification. Defensive: if some runtime has
// already buffered the body onto req.body as bytes/string, use that.
export function readRawBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
    if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body));
    return Promise.reject(new Error('body was parsed upstream; raw bytes are gone (disable the body parser for this route)'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
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

// JSON body for ordinary API routes; tolerates runtimes (Vercel) that have
// already parsed it onto req.body.
export async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null && !Buffer.isBuffer(req.body) && typeof req.body === 'object') {
    return req.body;
  }
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString('utf8'));
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
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieHeader(name, value, { maxAge = null, path = '/' } = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax`;
  if (maxAge !== null) cookie += `; Max-Age=${maxAge}`;
  return cookie;
}
