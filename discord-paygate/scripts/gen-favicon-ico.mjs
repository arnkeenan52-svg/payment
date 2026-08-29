#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// gen-favicon-ico — build /favicon.ico from the shipped favicon.svg.
//
// WHY. Google fetches /favicon.ico by default. Search Central says:
//
//   "Your favicon must be a square (1:1 aspect ratio) that's at least 8x8px.
//    While the minimum size requirement is 8x8px, we recommend using a favicon
//    that's larger than 48x48px so that it looks good on various surfaces."
//   — https://developers.google.com/search/docs/appearance/favicon-in-search
//
// READ THAT CAREFULLY, because an earlier version of this header did not. It
// quoted a SUPERSEDED revision of that page — "a multiple of 48 pixels in
// size" — and reasoned from it that a 16x16 icon was disqualified. Google
// relaxed the rule. A 16x16 square ICO clears the hard floor; it misses a
// recommendation, not a requirement, and it is NOT why a site shows the globe
// placeholder in search results. Do not cite that sentence anywhere; it is not
// in the published text.
//
// So this file exists for two smaller, true reasons. The tree held ONE 16x16
// image, which is under the recommended size and renders soft on every surface
// Google puts it on. And three places disagreed about what was in it: the
// markup declared sizes="32x32", scripts/gen-icons.mjs claimed it "already
// carries 16/32/48/64", and the file itself carried neither. Three answers
// about one 449-byte file, none of them from reading it. So this script reads
// its own output back.
//
// The actual hard guideline on that page, and the one this project was
// breaking, is a different sentence: "The favicon URL must be stable (don't
// change the URL frequently)." The icon hrefs carried ?v= that moved on every
// ship. That is fixed in the page markup, not here.
//
// WHY NOT gen-icons.mjs. That script is from the monochrome era — it builds a
// #0a0a0a mark and needs `sharp`, which is not a dependency of this project and
// is not installed. The icons actually shipping are the blue Dues tile. Running
// it would revert the brand. This script derives from public/favicon.svg, which
// IS what ships, so the .ico can never disagree with the tab icon beside it.
//
// No new dependency: Chromium (already here for the visual checks) rasterises,
// and an ICO is a header, a directory, and the PNGs themselves.
//
//   node scripts/gen-favicon-ico.mjs
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');

// At and above the size Google recommends, and nothing under it — a 16x16
// entry alongside these would only give a picker something soft to choose.
const SIZES = [48, 96];

const svg = fs.readFileSync(path.join(PUB, 'favicon.svg'), 'utf8');

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});

const pngs = [];
for (const size of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.setContent(
    `<style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden}
     svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    { waitUntil: 'load' },
  );
  pngs.push({ size, buf: await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size } }) });
  await ctx.close();
}
await browser.close();

// ICONDIR (6 bytes) + one ICONDIRENTRY (16 bytes) each + the PNG payloads.
// PNG-in-ICO has been readable since Vista and by every current browser and
// crawler; it is what keeps a 96px entry down to a couple of kilobytes.
const dir = Buffer.alloc(6 + 16 * pngs.length);
dir.writeUInt16LE(0, 0);              // reserved
dir.writeUInt16LE(1, 2);              // 1 = icon
dir.writeUInt16LE(pngs.length, 4);

let offset = dir.length;
pngs.forEach(({ size, buf }, i) => {
  const e = 6 + 16 * i;
  dir.writeUInt8(size & 0xff, e);      // 0 would mean 256; 48 and 96 fit
  dir.writeUInt8(size & 0xff, e + 1);
  dir.writeUInt8(0, e + 2);            // palette size, 0 for truecolour
  dir.writeUInt8(0, e + 3);            // reserved
  dir.writeUInt16LE(1, e + 4);         // colour planes
  dir.writeUInt16LE(32, e + 6);        // bits per pixel
  dir.writeUInt32LE(buf.length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += buf.length;
});

const out = Buffer.concat([dir, ...pngs.map((p) => p.buf)]);
const file = path.join(PUB, 'favicon.ico');
fs.writeFileSync(file, out);

// Read it back. The whole reason this file exists is that nobody checked.
const back = fs.readFileSync(file);
const count = back.readUInt16LE(4);
const found = [];
for (let i = 0; i < count; i++) {
  const e = 6 + 16 * i;
  const w = back.readUInt8(e) || 256;
  const h = back.readUInt8(e + 1) || 256;
  const len = back.readUInt32LE(e + 8);
  const off = back.readUInt32LE(e + 12);
  const payload = back.subarray(off, off + len);
  const isPng = payload.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  // A PNG's IHDR carries the real dimensions; trust those over the directory.
  const realW = isPng ? payload.readUInt32BE(16) : null;
  const realH = isPng ? payload.readUInt32BE(20) : null;
  if (w !== h) throw new Error(`entry ${i} is ${w}x${h}, not square`);
  // 48 is Google's RECOMMENDED floor ("larger than 48x48px"), not a hard rule —
  // the hard rule is square and at least 8x8. We hold ourselves to the
  // recommendation because there is no reason not to, but the message says what
  // it is rather than inventing a requirement.
  if (w < 48) throw new Error(`entry ${i} is ${w}px — below the 48px Google recommends for search surfaces`);
  if (!isPng) throw new Error(`entry ${i} is not a PNG payload`);
  if (realW !== w || realH !== h) throw new Error(`entry ${i} claims ${w}x${h} but the PNG is ${realW}x${realH}`);
  found.push(`${w}x${h} (${len}B)`);
}
console.log(`public/favicon.ico  ${found.join(', ')}  — ${back.length}B total`);
