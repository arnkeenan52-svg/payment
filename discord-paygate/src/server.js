import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, printBanner } from './config.js';
import { sendText } from './lib/http.js';
import { handleStripeWebhook, handleCoinbaseWebhook } from './routes/webhooks.js';
import { handleLogin, handleCallback, handleLogout } from './routes/auth.js';
import { handlePlans, handleMe, handleStripeCheckout, handleCoinbaseCheckout } from './routes/api.js';
import { sweepExpirations } from './services/entitlements.js';

const PUBLIC_DIR = path.join(config.root, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serveStatic(res, file) {
  const resolved = path.join(PUBLIC_DIR, file);
  if (!resolved.startsWith(PUBLIC_DIR) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    sendText(res, 404, 'not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(resolved)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(resolved));
}

const routes = {
  'GET /': (req, res) => serveStatic(res, 'index.html'),
  'GET /auth/login': handleLogin,
  'GET /auth/callback': handleCallback,
  'GET /auth/logout': handleLogout,
  'GET /api/plans': handlePlans,
  'GET /api/me': handleMe,
  'POST /api/checkout/stripe': handleStripeCheckout,
  'POST /api/checkout/coinbase': handleCoinbaseCheckout,
  'POST /webhooks/stripe': handleStripeWebhook,
  'POST /webhooks/coinbase': handleCoinbaseWebhook,
  'GET /healthz': (req, res) => sendText(res, 200, 'ok'),
};

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    await handler(req, res, url);
    return;
  }
  if (req.method === 'GET' && /^\/[a-zA-Z0-9._-]+$/.test(url.pathname)) {
    serveStatic(res, url.pathname.slice(1));
    return;
  }
  sendText(res, 404, 'not found');
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      console.error(`[server] ${req.method} ${req.url} → ${err.stack ?? err.message}`);
      if (!res.headersSent) sendText(res, 500, 'internal error');
      else res.end();
    }
  });
}

const server = createServer();
server.listen(config.port, () => {
  const actualPort = server.address().port;
  // Parseable first line (the e2e suite reads the port from it), banner after.
  console.log(`[tradeleaks] listening on http://localhost:${actualPort}`);
  printBanner(actualPort);
});

// The reconcile timer: the expiry sweep runs on boot and then on an interval,
// so lapsed grace windows and ended terms lose roles even if a webhook never
// arrives. unref'd so it cannot hold a dying process open.
const sweep = () =>
  sweepExpirations()
    .then(({ lapsed }) => {
      if (lapsed > 0) console.log(`[sweep] expired ${lapsed} subscription(s)`);
    })
    .catch((err) => console.error(`[sweep] failed: ${err.message}`));
sweep();
setInterval(sweep, config.sweepIntervalSeconds * 1000).unref();

// Leave no stray servers behind: exit promptly and predictably on signals.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[tradeleaks] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
