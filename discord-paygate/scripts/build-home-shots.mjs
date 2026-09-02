#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// build-home-shots — the three product stills the homepage shows.
//
// The landing page argues that a buyer pays and a Discord role lands. Until
// now it only SAID so: the first screen was copy over a sky, and the stills
// left in public/ from earlier rounds had drifted — land-storefront.png and
// land-checkout.png predate the storefront's banner/avatar header, the
// Products/About tabs and the "YOUR ORDER" summary, and shot-store.png still
// says Ripley. A screenshot that shows a product the visitor will not
// recognise when they sign up is worse than no screenshot.
//
// So the stills are SHOT, not drawn, and shot from this repo: the dev server
// serves /demo (the hosted demo store, fixed fixtures, nothing purchasable)
// and /demo/vip-access (its checkout), and the dashboard is rendered by the
// same fixture harness verify-dash.mjs uses. Re-run this after any change to
// the storefront, the checkout or the dashboard and the homepage is current
// again.
//
//   PORT=5731 node scripts/dev-server.js &
//   node scripts/build-home-shots.mjs --base http://127.0.0.1:5731
//
// Every clip is taken from a live element's box, never from hand-tuned pixel
// offsets, so a layout change moves the crop with it instead of silently
// slicing a heading in half. Output is WebP at 2× the largest size the page
// ever displays them at — a phone decoding a 1920×1080 PNG to show a 470px
// slice of it was the old way, and it cost 8MB of bitmap per frame.
// ─────────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright';
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'http://127.0.0.1:5731').replace(/\/$/, '');

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});

// clip: a CSS-pixel box measured from the page, shot at dsf 2, written at
// `out` device pixels wide. sharp does the downscale because Chromium's own
// resampler is not available at screenshot time.
async function shoot({ url, viewport, wait = 1800, box, width, file, quality = 80 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(BASE + url, { waitUntil: 'load' });
  await page.waitForTimeout(wait);
  const clip = typeof box === 'function' ? await page.evaluate(box) : box;
  const png = await page.screenshot({ clip });
  await ctx.close();
  const dest = path.join(OUT, file);
  const info = await sharp(png).resize({ width }).webp({ quality, effort: 6 }).toFile(dest);
  console.log(`${file.padEnd(24)} ${info.width}x${info.height}  ${(info.size / 1024).toFixed(0)}KB`);
}

// ── 1 · the storefront, as a buyer lands on it ──────────────────────────────
// From the top of the store column down through both product cards: the
// server's name, its member count, the roles it includes, and two priced
// products. Everything the hero claims, in one frame.
await shoot({
  url: '/demo', viewport: { width: 820, height: 1500 }, file: 'home-store.webp', width: 1040,
  box: () => {
    const col = document.querySelector('.shop-col').getBoundingClientRect();
    const av = document.querySelector('.shop-avatar').getBoundingClientRect();
    // Start above the avatar rather than at the top of the column: a store with
    // no banner image renders a plain dark plate there, and a third of the
    // frame spent on it is a third of the frame spent on nothing.
    const top = av.y - 22;
    // Stop at the bottom of the FIRST ROW of products. Running past it opens a
    // sliver of the next row, which reads as a rendering fault rather than as a
    // crop.
    const cards = [...document.querySelectorAll('.shop-grid > *')];
    const row = cards.length ? Math.max(...cards.filter((c) => c.getBoundingClientRect().y < cards[0].getBoundingClientRect().bottom).map((c) => c.getBoundingClientRect().bottom)) : col.bottom;
    return { x: col.x, y: top, width: col.width, height: Math.round(Math.min(row + 2, col.bottom) - top) };
  },
});

// ── 2 · the checkout, whole ─────────────────────────────────────────────────
// The card is clipped end to end on purpose: the product, the @VIP role it
// carries, the price, the method and the pay button are one argument and half
// of it proves nothing.
await shoot({
  url: '/demo/vip-access', viewport: { width: 760, height: 1400 }, file: 'home-checkout.webp', width: 640,
  box: () => {
    const r = document.querySelector('.panel.order-card').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: Math.round(r.height) };
  },
});

await browser.close();
