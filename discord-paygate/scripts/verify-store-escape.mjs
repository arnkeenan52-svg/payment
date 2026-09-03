// Storefront escape harness — "from this screen, where can I go?"
//
// The suite drives HTTP handlers; every screen below is drawn by public/app.js
// in a browser, so none of it is reachable from scripts/e2e-test.js. This is
// the gate for the one property a checkout must never lose: whatever screen a
// person is standing on, something on it takes them somewhere else.
//
// It grew out of a seller's report — "when making a purchase of a role from
// the view store section and I cannot leave there". A store with exactly ONE
// product routes straight into its order card, and that card had no link back
// to the store page; a crypto payment replaced the pay button with an address
// and offered nothing at all. Both are asserted here, at a phone width and a
// desktop one, signed out, as a buyer and as the store's owner.
//
//   node scripts/verify-store-escape.mjs            # assert, exit non-zero on failure
//   node scripts/verify-store-escape.mjs --shots    # also write screenshots
//
// The API surface is stubbed (fixtures, no database) exactly like
// scripts/verify-dash.mjs: these screens are client renders, so a fixture is
// the whole input.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = path.join(ROOT, 'scratch', 'escape');

const STORES = {
  'solo-shop': { name: 'Solo Shop', products: ['vip'] },
  'big-shop': { name: 'Big Shop', products: ['vip', 'signals', 'inner'] },
};
const PLAN = {
  vip: { id: 'vip', name: 'VIP Access', priceUsd: 25, lifetime: true, interval: 'lifetime' },
  signals: { id: 'signals', name: 'Signals Monthly', priceUsd: 14.99, lifetime: false, interval: 'month' },
  inner: { id: 'inner', name: 'Inner Circle', priceUsd: 79.99, lifetime: true, interval: 'lifetime' },
};
const plansFor = (slug) =>
  STORES[slug].products.map((k) => ({
    ...PLAN[k], currency: 'usd', description: `Everything in ${PLAN[k].name}.`,
    imageUrl: null, mediaKind: null, roleNames: ['VIP'], descriptionHighlight: null,
    linkSlug: null, variantOf: null, expiresAt: null, requiredRoleName: null, durationDays: null,
  }));

// Who is looking. The browser carries it in a cookie so one stub can answer
// for all three without a second server.
const PERSONA = {
  out: { loggedIn: false },
  buyer: { loggedIn: true, discordId: '1', username: 'buyer', isOwner: false, seller: false, owns: [], following: [], subscriptions: [] },
  owner: { loggedIn: true, discordId: '2', username: 'owner', isOwner: false, seller: true, owns: Object.keys(STORES), following: [], subscriptions: [] },
};

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/json', '.woff2': 'font/woff2', '.json': 'application/json', '.gif': 'image/gif', '.jpg': 'image/jpeg' };

function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const who = /persona=(\w+)/.exec(req.headers.cookie ?? '')?.[1] ?? 'out';
    if (url.pathname === '/api/me') return send(200, PERSONA[who] ?? PERSONA.out);
    if (url.pathname === '/api/plans') {
      const slug = url.searchParams.get('store');
      if (!STORES[slug]) return send(404, { error: 'no store' });
      return send(200, {
        brand: STORES[slug].name,
        platform: { name: 'Dues' },
        store: { slug, status: 'live', description: 'Roles and channels.', bannerUrl: null, bannerKind: null, theme: null, about: null, links: null, memberCount: null, followers: 0, followable: true, creatorName: null, team: null, teamHeading: null, reviews: { count: 0, average: null, on: false } },
        server: { name: STORES[slug].name, guildId: '1', iconUrl: null },
        currency: 'usd',
        // Both rails on: the crypto pay screen is one of the screens under test.
        capabilities: { stripe: true, crypto: false, nowpayments: true },
        plans: plansFor(slug),
      });
    }
    if (url.pathname === '/api/checkout/crypto') {
      if (req.method === 'POST') {
        return send(200, {
          orderId: 'ord_1', payAddress: 'bc1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxxx',
          payAmount: '0.00042', payCurrency: 'btc', qrSvg: '',
          expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
        });
      }
      if (url.searchParams.get('coins')) return send(200, { ready: true, coins: ['btc', 'eth'] });
      return send(200, { state: 'waiting', message: 'Waiting for your payment…' });
    }
    if (url.pathname.startsWith('/api/')) return send(200, {});
    let full = path.join(PUBLIC, url.pathname === '/' ? '/index.html' : url.pathname);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      full = path.join(PUBLIC, 'store.html'); // every /<slug> serves the storefront shell
    }
    try {
      const buf = await readFile(full);
      res.writeHead(200, { 'content-type': MIME[path.extname(full)] ?? 'application/octet-stream' });
      res.end(buf);
    } catch {
      res.writeHead(404).end('nope');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Every control a person could press to leave this screen, with the ones that
// have been pushed out of a clipping container marked — a link scrolled out of
// its own overflow:hidden header is not on the screen.
const escapes = () => {
  const clipped = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflow === 'hidden' || cs.overflowX === 'hidden') {
        const a = el.getBoundingClientRect();
        const b = p.getBoundingClientRect();
        if (a.right > b.right + 1 || a.left < b.left - 1) return true;
      }
    }
    return false;
  };
  return [...document.querySelectorAll('a[href], button')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !clipped(el);
    })
    .map((el) => ({
      id: el.id || null,
      label: (el.textContent ?? '').replace(/\s+/g, ' ').trim() || el.getAttribute('aria-label') || '(icon)',
      href: el.getAttribute('href'),
    }));
};

let failures = 0;
const ok = (cond, what) => {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${what}`);
  } else console.log(`  ✓ ${what}`);
};

const WIDTHS = [
  { w: 390, h: 844 },
  { w: 1440, h: 900 },
];

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.ESCAPE_CHROME ?? '/opt/pw-browsers/chromium' });
if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });

for (const persona of ['out', 'buyer', 'owner']) {
  for (const { w, h } of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addCookies([{ name: 'persona', value: persona, domain: '127.0.0.1', path: '/' }]);
    const page = await ctx.newPage();
    const at = `${persona}@${w}`;
    const shot = async (name) => {
      if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, `${name}__${persona}__${w}.png`), fullPage: true });
    };

    // ── every order card carries a link up to the store page ────────────────
    // The one-product store is the case that regressed: it is routed straight
    // into its checkout, so this link is the only thing between the buyer and
    // a page with no way off it.
    for (const [slug, url, label] of [
      ['solo-shop', '/solo-shop', 'Solo Shop'],
      ['solo-shop', '/solo-shop?checkout=cancelled', 'Solo Shop'], // back from Stripe, nothing charged
      ['big-shop', '/big-shop?plan=vip', 'All products'],
    ]) {
      await page.goto(base + url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(250);
      await page.evaluate(() => window.scrollTo(0, 0));
      const back = page.locator('#back-to-shop');
      const there = await back.isVisible();
      ok(there, `${at} ${url}: the order card offers a way up to the store page`);
      ok(there && ((await back.textContent()) ?? '').includes(label), `${at} ${url}: it says where it goes ("${label}")`);
      await shot(`checkout${url.includes('cancelled') ? '-cancelled' : ''}-${slug}`);

      // and it lands on the store page, which carries the store's own controls
      if (!there) {
        ok(false, `${at} ${url}: pressing it reaches the store page`);
        continue;
      }
      await back.click();
      await page.waitForTimeout(300);
      ok(await page.locator('#shop').isVisible(), `${at} ${url}: pressing it reaches the store page`);
      ok(await page.locator('#shop-join').isVisible(), `${at} ${url}: which is not the same page — it has the store's Join button`);
    }

    // ── the header is the escape of last resort, so it must be reachable ────
    await page.goto(`${base}/solo-shop`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);
    const aff = await page.evaluate(escapes);
    ok(aff.some((a) => a.href === '/'), `${at}: the header logo leaves the store`);
    if (persona !== 'out') {
      ok(aff.some((a) => a.href === '/account'), `${at}: a signed-in visitor can reach their account`);
    }
    if (persona === 'owner') {
      // The seller arrives from their dashboard, often in a fresh tab where the
      // browser's back button is dead. "/dashboard" dropped them at the store
      // picker; the way back has to be to THIS store.
      ok(
        aff.some((a) => a.href === '/dashboard#/store/solo-shop/overview'),
        `${at}: the store's owner is offered the dashboard for THIS store`,
      );
    }

    // ── the crypto pay screen ──────────────────────────────────────────────
    // It removes the pay button on purpose (a second invoice would split the
    // payment across two addresses) and hides the method tiles, so the cancel
    // control is the only thing on it that goes anywhere.
    if (persona !== 'out') {
      await page.goto(`${base}/solo-shop`, { waitUntil: 'networkidle' });
      await page.locator('.method', { hasText: 'Crypto' }).first().click();
      await page.waitForTimeout(250);
      await page.locator('.coin').first().click();
      await page.waitForTimeout(150);
      await page.locator('.pay-btn').first().click();
      await page.waitForTimeout(600);
      ok(await page.locator('#cryptopay').isVisible(), `${at}: the crypto pay screen is showing`);
      ok(!(await page.locator('#methods').isVisible()), `${at}: its method tiles are gone while an order is open`);
      ok(await page.locator('#cryptopay-cancel').isVisible(), `${at}: and it offers a way off it`);
      await shot('crypto-pay');
      await page.locator('#cryptopay-cancel').click();
      await page.waitForTimeout(300);
      ok(!(await page.locator('#cryptopay').isVisible()), `${at}: pressing it closes the payment`);
      ok(await page.locator('#cta-area .pay-btn').isVisible(), `${at}: and gives the buyer a pay button back`);
      ok(await page.locator('#methods').isVisible(), `${at}: with the payment methods to choose from again`);
    }

    await ctx.close();
  }
}

await browser.close();
server.close();

if (failures) {
  console.error(`\n${failures} escape check(s) failed.`);
  process.exit(1);
}
console.log('\nStorefront escape checks green.');
process.exit(0);
