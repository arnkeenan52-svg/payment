// Measure how a candidate film background survives the real encoder.
//
// WHY THIS EXISTS. Four hero videos were rejected as "bad quality" and the
// cause was not resolution — it was the background. Encoded exactly the way the
// film is encoded, the ground we shipped measured:
//
//     mean luma 23.8   saturation 0.001   widest flat band 590px
//
// A saturation of 0.001 is, arithmetically, no colour at all, and 8-bit h264
// cannot hold a gradient that dark without banding into wide flat plateaus. The
// reference film everyone was pointing at sits at mean luma 177 and saturation
// 0.195 — and it is 360p at 383kbps. The difference was never resolution.
//
// This script exists so that claim stays checkable rather than becoming folklore.
//
//   node scripts/measure-ground.mjs
//
// It renders each candidate at the film's own deviceScaleFactor, encodes with
// the film's own x264 settings, and reports the three numbers that matter:
// mean luma, mean saturation, and the widest run of identical luma along a
// scanline — which is the width of a visible band.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const OUT = process.env.GROUND_OUT || '/tmp/ground';
const DPR = Number(process.env.FILM_DPR || 2);

// The dither is an SVG feTurbulence overlay at very low opacity, and it is
// STATIC — the same pattern on every frame. That matters more than it sounds:
// measured against temporal grain (ffmpeg noise=alls=N:allf=t+u), which is
// different every frame and which the encoder therefore has to pay for in full:
//
//     none      widest band 269px    468 kbps
//     noise=2   widest band  97px   3773 kbps
//     noise=4   widest band  12px   7975 kbps
//
// An 8-17x bitrate explosion. A static pattern costs a fraction of that because
// it is identical frame to frame, and still narrows the widest band by a third.
const DITHER = `
  <svg style="position:fixed;inset:0;width:100%;height:100%;opacity:0.05;pointer-events:none;mix-blend-mode:overlay">
    <filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/>
    <feColorMatrix type="saturate" values="0"/></filter>
    <rect width="100%" height="100%" filter="url(#n)"/></svg>`;

const CANDIDATES = {
  shipped: {
    dither: false,
    bg: `linear-gradient(50deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.02) 100%),
         linear-gradient(140deg,#0a0a0a 0%,#0a0a0a 12.2%,#121212 12.2%,#161616 31%,
         #1a1a1a 47%,#1a1a1a 53%,#161616 71%,#121212 87.2%,#0a0a0a 87.2%,#0a0a0a 100%)`,
  },
  light: {
    dither: false,
    bg: `radial-gradient(120% 90% at 18% 8%, #eef0ff 0%, #dfe3ff 38%, #c9d0ff 68%, #b7c0fb 100%)`,
  },
  lightDither: {
    dither: true,
    bg: `radial-gradient(120% 90% at 18% 8%, #eef0ff 0%, #dfe3ff 38%, #c9d0ff 68%, #b7c0fb 100%)`,
  },
  // A dark beat is allowed, but it has to be SATURATED dark. The reference's
  // own dark section measures saturation 0.42 — a deep navy, never a grey.
  darkNavy: {
    dither: true,
    bg: `radial-gradient(120% 100% at 50% 30%, #1c2154 0%, #141a44 42%, #0b0d1f 100%)`,
  },
};

function chromiumPath() {
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch { /* not installed the usual way */ }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const d = fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()[0];
  return path.join(root, d, 'chrome-linux', 'chrome');
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.FILM_CHROME || chromiumPath(),
  args: ['--force-color-profile=srgb', '--hide-scrollbars'],
});

const results = [];
for (const [name, c] of Object.entries(CANDIDATES)) {
  const page = await (await browser.newContext({
    viewport: { width: 1920, height: 1080 }, deviceScaleFactor: DPR,
  })).newPage();
  await page.setContent(
    `<body style="margin:0;width:1920px;height:1080px;background:${c.bg}">${c.dither ? DITHER : ''}</body>`);
  await page.waitForTimeout(300);
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  // 30 identical frames: enough for the encoder to settle into its steady state,
  // which is where a static background's real cost shows up.
  for (let i = 0; i < 30; i += 1) {
    await page.screenshot({ path: path.join(dir, `f${String(i).padStart(3, '0')}.png`) });
  }
  await page.close();

  const mp4 = path.join(OUT, `${name}.mp4`);
  execFileSync('ffmpeg', [
    '-v', 'error', '-framerate', '30', '-i', path.join(dir, 'f%03d.png'),
    '-vf', 'scale=1920:1080:flags=lanczos',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
    '-x264-params', 'aq-mode=3:deblock=-1:-1:psy-rd=1.00:0.15:ref=5:bframes=4',
    '-pix_fmt', 'yuv420p', '-an', '-y', mp4,
  ], { stdio: ['ignore', 'inherit', 'inherit'] });

  // Decode one frame back OUT of the encode — measuring the source would miss
  // the entire effect, since the banding is something the encoder introduces.
  const shot = path.join(OUT, `${name}-decoded.png`);
  execFileSync('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', mp4, '-frames:v', '1', '-y', shot],
    { stdio: ['ignore', 'inherit', 'inherit'] });
  results.push({ name, mp4, shot, bytes: fs.statSync(mp4).size });
}
await browser.close();

// The measurement itself is a few lines of pixel arithmetic; keeping it here
// rather than in a notebook is the difference between a reproducible claim and
// a remembered one.
const { execFileSync: run } = await import('node:child_process');
const py = `
import sys, numpy as np
from PIL import Image
name, shot, byts = sys.argv[1], sys.argv[2], int(sys.argv[3])
a = np.array(Image.open(shot).convert('RGB'))
Y = (0.299*a[:,:,0] + 0.587*a[:,:,1] + 0.114*a[:,:,2]).astype(int)
mx = a.max(axis=2).astype(float); mn = a.min(axis=2).astype(float)
sat = float(np.where(mx > 0, (mx - mn)/np.maximum(mx, 1), 0).mean())
row = Y[Y.shape[0]//2 + 340, :]
w = best = 1
for i in range(1, len(row)):
    w = w + 1 if row[i] == row[i-1] else 1
    best = max(best, w)
print(f"  {name:14s} luma {Y.mean():6.1f}   sat {sat:6.3f}   widest band {best:4d}px   {byts/1000:7.1f} kB/s")
`;
process.stdout.write('\n[ground] one scanline through each encoded candidate\n');
for (const r of results) run('python3', ['-c', py, r.name, r.shot, String(r.bytes)], { stdio: ['ignore', 'inherit', 'inherit'] });
process.stdout.write('\nA beat may not sit on a large smooth gradient below luma ~60.\nIf a beat must be dark, make it SATURATED dark and keep the ramp short.\n');
