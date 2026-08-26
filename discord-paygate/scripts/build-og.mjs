// Render the link preview card.
//
// Authored at 1200x630 and shot at deviceScaleFactor 2, which is the 2400x1260
// the og:image:width/height meta tags declare. 1200x630 is the ratio every
// platform agrees on (1.91:1); shooting at 2x means the card is still sharp on
// the retina panels most links are opened on.
//
//   node scripts/build-og.mjs        # writes public/og-card.png
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'og-card.png');

function chromiumPath() {
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch { /* not installed the usual way */ }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const dirs = fs.existsSync(root)
    ? fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()
    : [];
  for (const d of dirs) {
    const p = path.join(root, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`no chromium under ${root} — set FILM_CHROME`);
}

const browser = await chromium.launch({
  executablePath: process.env.FILM_CHROME || chromiumPath(),
  args: ['--force-color-profile=srgb', '--hide-scrollbars'],
});
const page = await (await browser.newContext({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 2,
})).newPage();

let failed = null;
page.on('pageerror', (e) => { failed = e.message; });
await page.goto(`file://${path.join(ROOT, 'hero', 'og-card.html')}`);
// Gates on the webfonts AND the mark. A card shot before either resolves looks
// almost right, and this is the one image that appears on every shared link.
await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
if (failed) throw new Error(`the card threw before rendering: ${failed}`);

await page.screenshot({ path: OUT });
await browser.close();

// A link preview is fetched by a crawler on someone else's schedule, so weight
// matters more than it would for a page asset.
//
// A card that is mostly flat greys, one blue and one screenshot quantises to a
// 256-colour palette essentially for free: measured on this design, 1267KB down
// to 445KB for a mean absolute error of 0.41 out of 255, which is 0.16% and
// invisible. pngquant does it best; Pillow does it well enough and is what this
// box actually has.
let shrunk = false;
try {
  execFileSync('pngquant', ['--quality=82-96', '--speed', '1', '--force', '--output', OUT, OUT]);
  shrunk = true;
} catch { /* fall through to Pillow */ }
if (!shrunk) {
  try {
    execFileSync('python3', ['-c', [
      'import sys',
      'from PIL import Image',
      'p = sys.argv[1]',
      'im = Image.open(p).convert("RGB")',
      'im.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).save(p, optimize=True)',
    ].join('\n'), OUT]);
    shrunk = true;
  } catch { /* neither available */ }
}
if (!shrunk) process.stdout.write('[og] no quantiser available, shipping the full-depth PNG\n');

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
process.stdout.write(`[og] wrote public/og-card.png · 2400x1260 · ${kb}KB\n`);
