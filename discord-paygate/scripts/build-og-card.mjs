// Build the link-preview card by photographing the real homepage.
//
// WHY A RENDER AND NOT A DESIGNED CARD. The card used to be a clouds photo with
// the mark and a tagline centred on it — a poster, not the product. The brief
// was to match Foundable's, and theirs is a picture of their actual homepage:
// nav bar, real headline, the real composer input, the microline, over their
// sky. Someone who taps the link lands on exactly what the preview showed. A
// poster breaks that promise, so this screenshots the page itself.
//
// Rendered at 1200x630 (the canonical Open Graph size — Discord, iMessage,
// WhatsApp, Twitter and Slack all crop to it) with deviceScaleFactor 2, then
// downscaled 2:1 with Lanczos. That supersampling is what keeps the headline
// and the hairline chrome crisp; a straight 1x shot of the same frame aliases
// on the type.
//
//   node scripts/build-og-card.mjs            # serves public/ itself
//   OG_URL=https://dues.gg node scripts/build-og-card.mjs
//
// Writes public/og-card.jpg. Re-run it whenever the hero changes.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(PUBLIC, 'og-card.jpg');
const W = 1200;
const H = 630;

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.ico': 'image/x-icon', '.json': 'application/json',
};

// A local server rather than hitting production: the card must be built from
// the working tree, so a hero change and its card ship in the same commit.
async function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(PUBLIC, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(PUBLIC)) { res.statusCode = 403; return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const local = process.env.OG_URL ? null : await serve();
const base = process.env.OG_URL ?? local.base;

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });

// The day face, to match the bright sky the brief asked for. The site stores
// the choice in sessionStorage, so set it before any script runs.
await page.addInitScript(() => { try { sessionStorage.setItem('ripley-theme', 'light'); } catch { /* private mode */ } });
await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });

// The sky is a WebGL canvas that animates in — let it settle before shooting.
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(2600);

// The capture bar types rotating example slugs, so a shot lands on whatever
// half-finished word was on screen ("traderworl"). Pin it LAST, after the
// rotator has had its say, so every re-render produces the same clean frame.
// Locked with a property + setAttribute override rather than a
// MutationObserver that rewrites it: observing an attribute you also write is
// a mutation loop, and it kept the page busy until the screenshot timed out.
await page.evaluate(() => {
  const input = document.querySelector('#captureForm input, .capture input');
  if (!input) return;
  input.setAttribute('placeholder', 'your-server');
  Object.defineProperty(input, 'placeholder', { get: () => 'your-server', set: () => {}, configurable: true });
  const setAttr = input.setAttribute.bind(input);
  input.setAttribute = (name, value) => setAttr(name, name === 'placeholder' ? 'your-server' : value);
});
await page.waitForTimeout(400);

const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
await browser.close();
if (local) local.server.close();

// Downscale the 2x capture and encode. sharp is already a dependency (the
// welcome cards use it), so no new install for a build-time script.
const { default: sharp } = await import('sharp');
await sharp(shot)
  .resize(W, H, { fit: 'fill', kernel: 'lanczos3' })
  .jpeg({ quality: 88, progressive: true, chromaSubsampling: '4:4:4', mozjpeg: true })
  .toFile(OUT);

const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`[og] ${path.relative(ROOT, OUT)} — ${W}x${H}, ${kb} KB, from ${base}`);
if (kb > 800) console.warn('[og] over 800 KB: WhatsApp and iMessage start skipping previews around there');
