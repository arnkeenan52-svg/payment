// Local development shim: mounts the SAME serverless handler functions that
// Vercel runs (api/**) onto a plain node:http server, serves the storefront
// from public/, and mirrors the vercel.json rewrites (/auth/*, /webhooks/*).
// The e2e suite boots this file, so tests exercise the exact handler code
// that ships — the only production difference is Vercel's routing layer.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, printBanner } from '../src/config.js';
import { sendText } from '../src/lib/http.js';

import plans from '../api/plans.js';
import me from '../api/me.js';
import authLogin from '../api/auth/login.js';
import authCallback from '../api/auth/callback.js';
import authLogout from '../api/auth/logout.js';
import checkoutStripe from '../api/checkout/stripe.js';
import checkoutCoinbase from '../api/checkout/coinbase.js';
import webhookStripe from '../api/webhooks/stripe.js';
import webhookCoinbase from '../api/webhooks/coinbase.js';
import cronReconcile from '../api/cron/reconcile.js';
import setupCheck from '../api/setup-check.js';
import adminRoles from '../api/admin/roles.js';
import adminPlanRole from '../api/admin/plan-role.js';
import adminPayments from '../api/admin/payments.js';
import resync from '../api/resync.js';

const PUBLIC_DIR = path.join(config.root, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
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

// Path → handler, including the pretty aliases vercel.json rewrites provide.
const routes = {
  '/api/plans': plans,
  '/api/me': me,
  '/api/auth/login': authLogin,
  '/auth/login': authLogin,
  '/api/auth/callback': authCallback,
  '/auth/callback': authCallback,
  '/api/auth/logout': authLogout,
  '/auth/logout': authLogout,
  '/api/checkout/stripe': checkoutStripe,
  '/api/checkout/coinbase': checkoutCoinbase,
  '/api/webhooks/stripe': webhookStripe,
  '/webhooks/stripe': webhookStripe,
  '/api/webhooks/coinbase': webhookCoinbase,
  '/webhooks/coinbase': webhookCoinbase,
  '/api/cron/reconcile': cronReconcile,
  '/api/setup-check': setupCheck,
  '/api/admin/roles': adminRoles,
  '/api/admin/plan-role': adminPlanRole,
  '/api/admin/payments': adminPayments,
  '/api/resync': resync,
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const handler = routes[url.pathname];
    if (handler) {
      await handler(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      serveStatic(res, 'index.html');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/receipt') {
      serveStatic(res, 'receipt.html');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/diagnostics') {
      serveStatic(res, 'diagnostics.html');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/store') {
      serveStatic(res, 'store.html');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/terms') {
      serveStatic(res, 'terms.html');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/privacy') {
      serveStatic(res, 'privacy.html');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/account') {
      serveStatic(res, 'account.html');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/dashboard') {
      serveStatic(res, 'dashboard.html');
      return;
    }
    if (req.method === 'GET' && /^\/[a-zA-Z0-9._-]+$/.test(url.pathname)) {
      serveStatic(res, url.pathname.slice(1));
      return;
    }
    sendText(res, 404, 'not found');
  } catch (err) {
    console.error(`[server] ${req.method} ${req.url} → ${err.stack ?? err.message}`);
    if (!res.headersSent) sendText(res, 500, 'internal error');
    else res.end();
  }
});

server.listen(config.port, () => {
  const actualPort = server.address().port;
  console.log(`[tradeleaks] listening on http://localhost:${actualPort}`);
  printBanner(actualPort);
});

// Leave no stray servers behind: exit promptly and predictably on signals.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[tradeleaks] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
