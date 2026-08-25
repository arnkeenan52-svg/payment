// Re-shoot the hero tour against the real dashboard, at 2x.
//
// WHY THIS EXISTS. The previous master was 1080p, and the edit pushes in on
// several scenes. A push-in on a 1080p source is an upscale, so those moments
// are soft before any encoder touches them — three encode passes hit that wall
// and none of them could move it. Recording at deviceScaleFactor 2 means a
// 1.5x push-in still has native pixels to show.
//
// It drives the actual app, not a mock: a seeded SQLite database (see
// scripts/seed-demo.mjs), a minted session cookie, and the real dashboard
// rendering real rows. What you record is what the product looks like.
//
//   node scripts/seed-demo.mjs                     # once, DB_PATH set
//   node scripts/dev-server.js &                   # same DB_PATH + SESSION_SECRET
//   node scripts/record-hero.mjs --scene overview  # a still, for review
//   node scripts/record-hero.mjs --scene overview --frames   # the frame sequence
//
// Frames land in tmp-hero-frames/<scene>/ as PNGs, ready for ffmpeg. They are
// deliberately not encoded here: cutting and encoding is encode-hero.sh's job
// and it already carries the settings reasoning.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.HERO_BASE_URL || 'http://127.0.0.1:4311';
const COOKIE = process.env.HERO_COOKIE || (fs.existsSync('/tmp/hero-cookie.txt') ? fs.readFileSync('/tmp/hero-cookie.txt', 'utf8').trim() : '');
const OUT = process.env.HERO_OUT || path.join(ROOT, 'tmp-hero-frames');
const THEME = process.env.HERO_THEME === 'light' ? 'light' : 'dark';

// 1920x1080 CSS at dpr 2 = a 3840x2160 capture. The edit's push-ins crop into
// that, so even a 2x zoom lands at or above 1080p native.
const VIEW = { width: 1920, height: 1080 };
const DPR = Number(process.env.HERO_DPR || 2);
const FPS = 30;

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1]?.startsWith('--') ? true : process.argv[i + 1]) ?? true;
};
const WANT = arg('scene', 'overview');
const FRAMES = process.argv.includes('--frames');

// Scenes are declared, not hand-coded inline, so the shot list is reviewable
// and a single scene can be re-shot without touching the others.
// Scenes are declared, not hand-coded inline, so the shot list is reviewable
// and one scene can be re-shot without touching the others.
//
// `enter` runs before the camera rolls: the dashboard is a single page behind
// a server picker, so every scene starts by opening the store. Hash routes are
// deliberately NOT hardcoded — clicking the same control a seller clicks means
// the shoot cannot silently drift from the real navigation.
// Prefer Playwright's own resolution; fall back to scanning the shared
// browsers directory, whose name carries a build number and so moves when the
// image updates. Pinning a literal path here would rot.
function chromiumPath() {
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch { /* not installed the usual way */ }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse() : [];
  for (const d of dirs) {
    const p = path.join(root, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`no chromium under ${root} — set HERO_CHROME to its path`);
}

const OPEN_STORE = [{ click: 'text=Dues Membership' }];

const SCENES = {
  overview: {
    path: '/dashboard',
    enter: OPEN_STORE,
    settle: 'text=Revenue',
    beats: [
      { hold: 1.2 },
      { click: 'text=90d', hold: 1.6 },
    ],
  },
  products: { path: '/dashboard', enter: [...OPEN_STORE, { click: 'text=Products' }], settle: 'text=VIP Access', beats: [{ hold: 1.5 }] },
  customize: { path: '/dashboard', enter: [...OPEN_STORE, { click: 'text=Customize' }], settle: 'text=Appearance', beats: [{ hold: 1.5 }] },
};

const scene = SCENES[WANT];
if (!scene) {
  console.error(`[record] unknown scene "${WANT}" — known: ${Object.keys(SCENES).join(', ')}`);
  process.exit(1);
}
if (!COOKIE) {
  console.error('[record] no session cookie: set HERO_COOKIE or write /tmp/hero-cookie.txt');
  process.exit(1);
}

const browser = await chromium.launch({
  // PLAYWRIGHT_BROWSERS_PATH points at a shared install whose directory name
  // carries the build number, so it moves when the image updates. Resolve it
  // rather than pinning a path that will rot.
  executablePath: process.env.HERO_CHROME || chromiumPath(),
  args: ['--force-color-profile=srgb', '--disable-lcd-text', '--hide-scrollbars'],
});
const ctx = await browser.newContext({
  viewport: VIEW,
  deviceScaleFactor: DPR,
  colorScheme: THEME === 'light' ? 'light' : 'dark',
  reducedMotion: 'no-preference',
});
const url = new URL(BASE);
await ctx.addCookies([{ name: 'tl_session', value: COOKIE, domain: url.hostname, path: '/' }]);

const page = await ctx.newPage();
await page.addInitScript((t) => {
  try { localStorage.setItem('theme', t); } catch {}
  document.documentElement.dataset.theme = t;
}, THEME);

await page.goto(`${BASE}${scene.path}`, { waitUntil: 'networkidle' });
for (const step of scene.enter ?? []) {
  await page.click(step.click, { timeout: 10000 });
  await page.waitForTimeout(600);
}
// A scene that never reaches its subject is a wasted shoot and, worse, a
// plausible-looking wrong frame. Fail rather than shoot the picker again.
await page.waitForSelector(scene.settle, { timeout: 15000 }).catch(() => {
  throw new Error(`settle selector "${scene.settle}" never appeared — the scene did not reach its subject`);
});
await page.waitForTimeout(700); // let entrance transitions land

const dir = path.join(OUT, `${WANT}-${THEME}`);
fs.mkdirSync(dir, { recursive: true });

if (!FRAMES) {
  const file = path.join(dir, 'still.png');
  await page.screenshot({ path: file });
  const { width, height } = await page.evaluate(() => ({ width: innerWidth * devicePixelRatio, height: innerHeight * devicePixelRatio }));
  console.log(`[record] ${WANT}/${THEME} still → ${file}  (${width}x${height})`);
} else {
  // Capture on a fixed grid rather than in real time: a screenshot takes far
  // longer than 33ms, so recording "live" would drop frames unevenly. Stepping
  // the UI and shooting each step gives an even 30fps that plays back smoothly.
  let n = 0;
  const shoot = async () => {
    await page.screenshot({ path: path.join(dir, `f${String(n).padStart(5, '0')}.png`) });
    n += 1;
  };
  for (const beat of scene.beats) {
    if (beat.click) await page.click(beat.click, { timeout: 5000 }).catch(() => {});
    if (beat.hover) await page.hover(beat.hover, { timeout: 5000 }).catch(() => {});
    for (let i = 0; i < Math.round((beat.hold ?? 1) * FPS); i += 1) await shoot();
  }
  console.log(`[record] ${WANT}/${THEME} → ${n} frames in ${dir} (${(n / FPS).toFixed(1)}s at ${FPS}fps)`);
}

await browser.close();
