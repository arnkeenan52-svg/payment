// Render and encode the hero film.
//
// The film is VECTOR — CSS shapes, 3D transforms and text — so unlike a screen
// recording there is no "source resolution" to be limited by: it can be rendered
// at any size. It is rendered at deviceScaleFactor 2 (3840x2160) and downscaled
// 2:1, which is supersampling: every output pixel is the average of four, which
// is a real quality gain on exactly what this film is made of — hard-edged
// wedges and small text, the two things that alias worst.
//
// Every frame is produced by seeking to an explicit time, never by playing in
// real time, so capture speed cannot affect the result and the same commit
// always renders the same pixels.
//
//   node scripts/build-film.mjs            # full render + encode
//   node scripts/build-film.mjs --frames   # frames only, skip the encode
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRAMES = process.env.FILM_FRAMES || path.join(ROOT, 'tmp-film-frames');
const FPS = 30;
const DPR = Number(process.env.FILM_DPR || 2);
// The poster is NOT frame 0: the film deliberately opens on bare ground, so
// frame 0 is an empty plate and would be a poster that says nothing. The endcard
// is the frame that carries brand plus product, and it is what the loop settles
// on either side of the seam.
const POSTER_AT = Number(process.env.FILM_POSTER_AT || 19.45);

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
  throw new Error(`no chromium under ${root} — set FILM_CHROME`);
}

const browser = await chromium.launch({
  executablePath: process.env.FILM_CHROME || chromiumPath(),
  args: ['--force-color-profile=srgb', '--hide-scrollbars', '--disable-lcd-text'],
});
const page = await (await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: DPR,
})).newPage();

let failed = null;
page.on('pageerror', (e) => { failed = e.message; });
await page.goto(`file://${path.join(ROOT, 'hero', 'film.html')}?scene=film`);
// Gates on fonts AND every image decode. A frame shot before either resolves
// looks almost right, which is the kind of error nobody catches until it ships.
await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
if (failed) throw new Error(`the film threw before rendering: ${failed}`);

const duration = await page.evaluate(() => window.__duration);
const total = Math.round(duration * FPS);
fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

process.stdout.write(`[film] ${duration}s · ${total} frames · ${1920 * DPR}x${1080 * DPR}\n`);
for (let i = 0; i < total; i += 1) {
  await page.evaluate((t) => window.__seek(t), i / FPS);
  await page.screenshot({ path: path.join(FRAMES, `f${String(i).padStart(4, '0')}.png`) });
  if (i % 60 === 0) process.stdout.write(`[film] ${i}/${total}\r`);
}
await page.evaluate((t) => window.__seek(t), POSTER_AT);
await page.screenshot({ path: path.join(FRAMES, 'poster.png') });
if (failed) throw new Error(`the film threw while rendering: ${failed}`);
await browser.close();
process.stdout.write(`[film] ${total}/${total} frames done\n`);

if (process.argv.includes('--frames')) process.exit(0);

// Encoder settings carried over from scripts/encode-hero.sh, where they were
// arrived at by measurement. NOT -tune animation: it is built for flat cartoons,
// sets psy_rd=0.40 and deblock=1:1:1, and smears exactly the text this film is
// made of. aq-mode=3 biases to dark scenes, which this film mostly is.
const run = (args) => execFileSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });

// The soundtrack is BUILT HERE, in the same command as the picture, and not by
// hand afterwards. Every accent in it is scored to a frame number — the clicks
// are the frames the cursor presses — so a mux done as a separate manual step
// is a standing invitation for the two to drift a cut apart. One command, one
// source of truth for both halves.
const AUDIO = path.join(ROOT, 'tmp-film-audio.wav');
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-film-audio.mjs')], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, FILM_AUDIO: AUDIO },
});

run([
  '-v', 'error', '-stats', '-framerate', String(FPS), '-i', path.join(FRAMES, 'f%04d.png'),
  '-i', AUDIO,
  '-vf', `scale=1920:1080:flags=lanczos`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
  '-x264-params', 'aq-mode=3:deblock=-1:-1:psy-rd=1.00:0.15:ref=5:bframes=4',
  '-g', '60', '-pix_fmt', 'yuv420p',
  // AAC-LC at 160k stereo: the one profile every browser decodes without a
  // second thought. The hero plays MUTED by default and the visitor opts in
  // with the speaker button, so this track costs nothing until it is wanted.
  '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000',
  '-shortest', '-movflags', '+faststart',
  '-y', path.join(ROOT, 'public', 'hero-tour.mp4'),
]);
run([
  '-v', 'error', '-i', path.join(FRAMES, 'poster.png'),
  '-vf', 'scale=1920:1080:flags=lanczos', '-c:v', 'libwebp', '-quality', '84',
  '-y', path.join(ROOT, 'public', 'hero-poster.webp'),
]);
process.stdout.write('[film] wrote public/hero-tour.mp4 (with soundtrack) and public/hero-poster.webp\n');
