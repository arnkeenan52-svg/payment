// Generate the full icon set from one vector source.
//
// WHY A SCRIPT AND NOT HAND-EXPORTED PNGS. Icons rot: someone changes the mark,
// updates the 512 and forgets the maskable, and Android ships a clipped logo for
// a year. Everything here derives from ONE authored SVG, so the set can never
// drift apart from itself.
//
// The SVG geometry is MEASURED from the original public/favicon.png, not
// eyeballed: the three bars sit at y 121/218/316, each 146 wide and ~75 tall,
// each sheared 37px to the left over its height, stepping 48px left per row.
// Tile #0a0a0a (the site's --bg), bars #ffffff, corner radius 105 on 512.
//
//   node scripts/gen-icons.mjs
//
// favicon.ico is NOT regenerated: the one in the tree already carries 16/32/48/64,
// which satisfies Google's "multiple of 48px" rule, and rewriting ICO containers
// needs a dependency this project does not otherwise want.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');

const BG = '#0a0a0a';
const INK = '#ffffff';

// The three sheared bars, at 512. Shared by every output so they cannot diverge.
const BARS = [
  'M250 121 H396 L359 196 H213 Z',
  'M202 218 H348 L311 294 H165 Z',
  'M153 316 H299 L262 391 H116 Z',
].join(' ');

// `rounded` = the browser-tab tile, which draws its own corners.
// `square`  = for surfaces that apply their OWN mask (iOS squircle, Android
//             maskable). Pre-rounded corners inside another mask leave dark
//             notches, which is the classic apple-touch-icon mistake.
// `inset`   = how much to shrink the mark. Android maskable icons may be
//             cropped to a circle of 80% diameter, so the mark has to sit well
//             inside that safe zone or the outer bars get sliced off.
const svg = ({ rounded = true, inset = 0 } = {}) => {
  const s = (512 - inset * 2) / 512;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" ${rounded ? 'rx="105" ry="105"' : ''} fill="${BG}"/>
  <g transform="translate(${inset} ${inset}) scale(${s.toFixed(6)})">
    <path d="${BARS}" fill="${INK}"/>
  </g>
</svg>`;
};

const png = (source, size, file) =>
  sharp(Buffer.from(source))
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(path.join(PUB, file))
    .then(() => console.log(`  ${file.padEnd(28)} ${size}x${size}`));

const rounded = svg();
// A full-bleed square: iOS rounds it, Android masks it.
const square = svg({ rounded: false });
// 96px of padding leaves the mark at ~62% of the canvas, comfortably inside
// Android's 80%-diameter safe circle.
const maskable = svg({ rounded: false, inset: 96 });

fs.writeFileSync(path.join(PUB, 'favicon.svg'), rounded);
console.log('  favicon.svg                  vector');

await Promise.all([
  // Google's guidance is a square favicon that is a multiple of 48px; 96 is the
  // sweet spot between "crisp in search results" and "a few hundred bytes".
  png(rounded, 96, 'favicon-96x96.png'),
  png(rounded, 32, 'favicon-32x32.png'),
  png(rounded, 512, 'favicon.png'),
  // 180 is the size current iOS actually wants; anything else gets resampled.
  png(square, 180, 'apple-touch-icon.png'),
  png(rounded, 192, 'icon-192.png'),
  png(rounded, 512, 'icon-512.png'),
  png(maskable, 512, 'icon-maskable-512.png'),
]);

const manifest = {
  name: 'Dues',
  short_name: 'Dues',
  description: 'Sell Discord roles. Keep every dollar.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: BG,
  theme_color: BG,
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
fs.writeFileSync(path.join(PUB, 'site.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log('  site.webmanifest             manifest');
