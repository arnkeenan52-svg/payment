#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// verify-phone-footer — the phone footer, measured the way a phone measures it.
//
// WHY THIS FILE EXISTS. Two things about the bottom of the landing page have
// now been reported three times, and every fix was signed off in a desktop
// browser that cannot see either of them.
//
// 1. THE BAND. iOS Safari tints the strip behind its own toolbars. Older
//    versions read <meta name="theme-color">; Safari 26 samples the
//    background-COLOR of a fixed element pinned within a few px of the viewport
//    edge and falls back to the page ground. At the bottom of this page the
//    only fixed element on that edge is .footer, whose colour lives entirely in
//    a background-IMAGE gradient — background-color is transparent. So the
//    sample falls through to the page ground and paints a dark navy band under
//    a blue footer. Neither signal has ever followed the footer, so both are
//    checked here.
//
// 2. THE REVEAL. The footer pins to the viewport and the sheet lifts off it,
//    but only while the whole footer FITS. When it does not fit the effect does
//    not fail — it DISARMS. No error; the page quietly stops doing the thing.
//    The fit is measured against 100svh. On a desktop engine svh, lvh and
//    innerHeight are ONE number; on iOS they are three, and svh is ~90-115px
//    smaller than lvh. A check run at 390x844 — the iPhone 13's LARGE viewport
//    — hands the guard 99px it will never have on the device, so the check
//    passes and the phone does not.
//
// So this harness never uses a device's nominal height. It runs each phone
// three ways:
//
//   small     w x svh   what the FIT GUARD sees. Does the blind arm, and with
//                       how much room to spare?
//   large     w x lvh   what the EYE sees at the bottom of a scroll, once the
//                       toolbar has collapsed.
//   disarmed  w x lvh   the same, with the footer forced past any budget so the
//                       guard genuinely switches off. The degraded path has to
//                       look right too — that is the whole point.
//
// No expected colour is written down here. Every one is READ from the PIXEL at
// the footer's bottom edge, which is not the same as its last gradient stop —
// .footer::after shades the base of the gradient, so the nominal colour and the
// visible one differ by up to 19 RGB. A backstop that matches the stop instead
// of the pixel leaves a step exactly where the seam shows, and a backstop that
// drifts from the gradient entirely is its own historical bug (v193 shipped the
// FIRST stop and put a pale band across the bottom of the day face). A constant
// in a test file catches neither. The rendered edge catches both.
//
//   node scripts/verify-phone-footer.mjs [--base URL] [--path /index.html]
// ─────────────────────────────────────────────────────────────────────────────

import { chromium, devices } from 'playwright';
import { inflateSync } from 'node:zlib';

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const BASE = arg('--base', 'http://127.0.0.1:4310');
const PATH = arg('--path', '/');
const URL_ = BASE.replace(/\/$/, '') + PATH;

// name, layout width, lvh (toolbars collapsed), svh (toolbars showing).
// The svh figures are what iOS Safari reports on the device, not a ratio.
const PHONES = [
  ['iPhone SE 2/3', 375, 667, 553],
  ['iPhone 13 mini', 375, 812, 698],
  ['iPhone 13/14', 390, 844, 745],
  ['iPhone 15/16', 393, 852, 753],
  ['iPhone 11 / XR', 414, 896, 780],
  ['iPhone 14 Pro Max', 430, 932, 833],
  ['Android small', 360, 800, 720],
  // The phone block is an OR list — (hover:none),(pointer:coarse),(max-width:639px)
  // — so every touch device runs it, tablets included. This row is here so that
  // is measured rather than assumed; it is not expected to arm.
  ['iPad mini (touch)', 744, 1133, 1044],
];

// Phones the reveal is expected to arm on, with room to spare. The SE class is
// exempt: a full-height footer cannot honestly fit a 553px viewport, and the
// point of the band fix is that the disarmed page still looks right there.
const MUST_ARM = new Set(['iPhone 13 mini', 'iPhone 13/14', 'iPhone 15/16', 'iPhone 11 / XR', 'iPhone 14 Pro Max', 'Android small']);
const MIN_SLACK = 24;

// The page grounds — the sky. If either turns up at the bottom of the screen,
// or in a tint signal while the footer owns the screen, the band is back.
const SKY = { night: '#131b2d', day: '#70a3e6' };

const fails = [];
const say = (s) => console.log(s);
const fail = (s) => { fails.push(s); console.log(`  ✗ ${s}`); };

const rgb = (s) => {
  const m = String(s ?? '').match(/rgba?\(([^)]+)\)/);
  if (m) {
    const n = m[1].split(',').map(parseFloat);
    return { c: [n[0] | 0, n[1] | 0, n[2] | 0], a: n.length > 3 ? n[3] : 1 };
  }
  const h = String(s ?? '').trim().match(/^#([0-9a-f]{6})$/i);
  if (h) return { c: [parseInt(h[1].slice(0, 2), 16), parseInt(h[1].slice(2, 4), 16), parseInt(h[1].slice(4, 6), 16)], a: 1 };
  return null;
};
const hex = (v) => {
  const p = rgb(v);
  return p ? '#' + p.c.map((x) => x.toString(16).padStart(2, '0')).join('') : String(v ?? '?');
};
const dist = (a, b) => {
  const x = rgb(a), y = rgb(b);
  if (!x || !y) return 999;
  return Math.max(...[0, 1, 2].map((i) => Math.abs(x.c[i] - y.c[i])));
};

// ── a PNG reader, because the point is to read PAINTED pixels ────────────────
// A computed style says what the page believes; a screenshot says what a person
// sees. zlib is in the standard library and the clips here are a few hundred
// rows, so this stays a dependency-free read.
function decodePng(buf) {
  let p = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unexpected PNG bit depth ${bitDepth}`);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error(`unexpected PNG colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return { w, h, ch, px: out };
}

// One representative colour per row: the median of a horizontal sample, so a
// link or a rule cannot pass itself off as the ground.
function rowColours(png) {
  const { w, h, ch, px } = png;
  const step = Math.max(1, Math.floor(w / 24));
  const rows = [];
  for (let y = 0; y < h; y++) {
    const rs = [], gs = [], bs = [];
    for (let x = 0; x < w; x += step) {
      const i = y * w * ch + x * ch;
      rs.push(px[i]); gs.push(px[i + 1]); bs.push(px[i + 2]);
    }
    const mid = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    rows.push(`rgb(${mid(rs)}, ${mid(gs)}, ${mid(bs)})`);
  }
  return rows;
}

// The colour a person sees at the very bottom of the screen. Everything else
// is judged against this, never against a value read out of a stylesheet.
const edgeColour = async (page, w, h) => {
  const shot = await page.screenshot({ clip: { x: 0, y: h - 2, width: w, height: 2 } });
  return rowColours(decodePng(shot)).pop();
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});

async function open(theme, w, h, extraCss) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    userAgent: devices['iPhone 13'].userAgent,
  });
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    try { sessionStorage.setItem('ripley-theme', t === 'night' ? 'dark' : 'light'); } catch { /* private mode */ }
  }, theme);
  await page.goto(URL_, { waitUntil: 'load' });
  if (extraCss) await page.addStyleTag({ content: extraCss });
  await page.waitForTimeout(450);
  return { ctx, page };
}

// Everything the page has settled into — plus the footer's own last gradient
// stop, which is the single source of truth every other colour is judged by.
const readState = (page) => page.evaluate(() => {
  const H = document.documentElement;
  const f = document.querySelector('.footer');
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:-9px;top:0;width:1px;height:100svh;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const svh = Math.round(probe.getBoundingClientRect().height);
  probe.remove();

  const wm = f ? f.querySelector('.footer-watermark') : null;
  const reserve = wm && getComputedStyle(wm).display !== 'none' ? parseFloat(getComputedStyle(wm).marginBottom) || 0 : 0;
  // The bottom-edge sample band is display:none outside WebKit by design — the
  // @supports gate keeps it out of every other render tree — so it is checked
  // as a DECLARATION rather than as a painted box. Its computed style still
  // resolves while it is display:none, which is exactly what WebKit will paint.
  const bandEl = document.querySelector('.ui-tint-b');
  const bandCs = bandEl ? getComputedStyle(bandEl) : null;
  const img = f ? getComputedStyle(f).backgroundImage : '';
  const stops = img.match(/rgba?\([^)]+\)/g) || [];
  const vh = H.clientHeight;

  // What an engine sampling the bottom edge would find: fixed boxes touching
  // it, in paint order, with an opaque background-color.
  const bottomSamples = [];
  document.querySelectorAll('*').forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed') return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    if (Math.abs(r.bottom - vh) > 6) return;
    const bg = cs.backgroundColor;
    if (/rgba\([^)]*,\s*0\s*\)/.test(bg)) return;   // transparent — not a sample point
    bottomSamples.push({ tag: (el.className && String(el.className).split(' ')[0]) || el.tagName, bg });
  });

  return {
    svh, reserve,
    band: bandCs ? { position: bandCs.position, bottom: bandCs.bottom, bg: bandCs.backgroundColor } : null,
    footH: f ? f.offsetHeight : -1,
    footBottom: f ? Math.round(f.getBoundingClientRect().bottom) : -1,
    footBgColor: f ? getComputedStyle(f).backgroundColor : null,
    lastStop: stops.length ? stops[stops.length - 1] : null,
    ground: getComputedStyle(H).backgroundColor,
    meta: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content')),
    bottomSamples,
    blind: H.hasAttribute('data-blind'),
    near: H.hasAttribute('data-footer-near'),
    revealed: H.hasAttribute('data-footer-revealed'),
    footH_var: H.style.getPropertyValue('--footH'),
    scrollRestoration: ('scrollRestoration' in history) ? history.scrollRestoration : 'n/a',
    navOpacity: Number(getComputedStyle(document.querySelector('.nav')).opacity),
    vh,
  };
});

say(`phone footer — ${URL_}\n`);

for (const theme of ['night', 'day']) {
  say(`── ${theme} ───────────────────────────────────────────────────────────`);
  for (const [name, w, lvh, svh] of PHONES) {
    // ── small: what the fit guard sees ──────────────────────────────────────
    {
      const { ctx, page } = await open(theme, w, svh);
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(350);
      const s = await readState(page);
      const edge = await edgeColour(page, w, svh);
      // the page's own arithmetic: the reserve is the band Safari's toolbar
      // covers by design, so it is not charged against the small viewport.
      const slack = (s.svh - 24) - (s.footH - s.reserve);
      say(`${name.padEnd(18)} ${String(w).padStart(3)}x${svh} small     footer=${s.footH} content=${s.footH - s.reserve} budget=${s.svh - 24} slack=${slack >= 0 ? '+' : ''}${slack} blind=${s.blind}`);

      if (MUST_ARM.has(name)) {
        if (!s.blind) fail(`${name} ${theme}: the reveal disarmed on the small viewport — footer content ${s.footH - s.reserve} over a budget of ${s.svh - 24}`);
        else if (slack < MIN_SLACK) fail(`${name} ${theme}: the reveal armed with only ${slack}px to spare (want ${MIN_SLACK}) — one wrapped label switches it off again`);
      }
      if (dist(s.ground, edge) > 3) {
        fail(`${name} ${theme}: page ground ${hex(s.ground)} is not the footer's painted bottom edge ${hex(edge)}`);
      }
      if (dist(s.footBgColor, edge) > 3) {
        fail(`${name} ${theme}: .footer background-color is ${hex(s.footBgColor)}, not its own painted edge ${hex(edge)} — that is the value Safari 26 samples`);
      }
      await ctx.close();
    }

    // ── large, and the same again with the guard genuinely switched off ─────
    // The forced-tall footer has to be tall RELATIVE to the viewport, or the
    // scenario quietly stops disarming anything on a big screen — a check that
    // passes without testing its own premise.
    for (const [mode, css] of [['large', null], ['disarmed', `.footer-directory{padding-top:${lvh}px}`]]) {
      const { ctx, page } = await open(theme, w, lvh, css);
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(400);
      const s = await readState(page);
      if (mode === 'disarmed' && s.blind) {
        fail(`${name} ${theme}: the forced-tall footer still armed — the disarmed scenario is not testing what it claims to`);
      }
      // No reveal, no reason to take the header away. On a handset the blind
      // cannot fit, hiding the nav for the whole footer costs the visitor
      // their way back up and buys nothing in exchange.
      if (!s.blind && s.revealed) {
        fail(`${name} ${theme} ${mode}: the header is hidden over a footer that never rises — data-footer-revealed is set with no blind behind it`);
      }
      if (!s.blind && s.footH_var) {
        fail(`${name} ${theme} ${mode}: --footH is still ${s.footH_var} for a footer that is not pinned — stale state`);
      }

      // the tint signals, both of them, while the footer owns the screen
      const edge = await edgeColour(page, w, lvh);
      const metaBad = s.meta.filter((m) => dist(m, edge) > 3);
      if (metaBad.length) {
        fail(`${name} ${theme} ${mode}: <meta theme-color> is ${metaBad.map(hex).join(', ')} at the bottom of the page, not the footer's edge ${hex(edge)} — that is the band on Safari 15-25`);
      }
      if (!s.band) {
        fail(`${name} ${theme} ${mode}: no .ui-tint-b element — the bottom edge has no sample point for a WebKit that reads one`);
      } else {
        if (s.band.position !== 'fixed' || s.band.bottom !== '0px') {
          fail(`${name} ${theme} ${mode}: .ui-tint-b is ${s.band.position} at bottom:${s.band.bottom} — it has to be pinned to the edge to be sampled`);
        }
        if (dist(s.band.bg, edge) > 3) {
          fail(`${name} ${theme} ${mode}: .ui-tint-b reports ${hex(s.band.bg)}, not the footer's edge ${hex(edge)}`);
        }
      }
      const sample = s.bottomSamples[s.bottomSamples.length - 1];
      if (sample && dist(sample.bg, edge) > 3) {
        fail(`${name} ${theme} ${mode}: the fixed box on the bottom edge, .${sample.tag}, is ${hex(sample.bg)} rather than the footer's edge ${hex(edge)}`);
      }

      // and the pixels themselves, below the footer's own bottom edge
      const gap = s.vh - s.footBottom;
      if (gap > 0) {
        const shot = await page.screenshot({ clip: { x: 0, y: s.footBottom, width: w, height: gap } });
        const off = rowColours(decodePng(shot)).filter((r) => dist(r, edge) > 8);
        if (off.length) {
          fail(`${name} ${theme} ${mode}: ${off.length}px of ${gap}px below the footer is not its colour — ${hex(off[0])} vs ${hex(edge)}`);
        }
      }
      if (dist(edge, SKY[theme]) <= 6) {
        fail(`${name} ${theme} ${mode}: the last row of the screen is the sky ${SKY[theme]} — the band is back`);
      }
      say(`${' '.repeat(18)} ${String(w).padStart(3)}x${lvh} ${mode.padEnd(9)} bottomPx=${hex(edge)} gapBelowFooter=${gap} blind=${s.blind}`);
      await ctx.close();
    }

    // ── the blind actually runs, rather than merely being armed ─────────────
    // Arming is a data attribute; the reveal is the sky's clip growing while
    // the sheet lifts. Those are different claims and only one of them is what
    // the person holding the phone sees.
    if (MUST_ARM.has(name)) {
      const { ctx, page } = await open(theme, w, lvh);
      const track = await page.evaluate(async () => {
        const H = document.documentElement;
        const sky = document.querySelector('.hero-sky');
        const footer = document.querySelector('.footer');
        const end = H.scrollHeight - H.clientHeight;
        const seen = [];
        for (let i = 0; i <= 8; i++) {
          scrollTo(0, Math.round(end - (H.clientHeight * 1.2) * (1 - i / 8)));
          await new Promise((r) => setTimeout(r, 90));
          const clip = (sky && sky.style.clipPath) || '';
          const nums = clip.match(/[\d.]+(?=px)/g);
          seen.push({
            cut: nums && nums.length >= 3 ? parseFloat(nums[2]) : 0,
            pinned: getComputedStyle(footer).position === 'fixed',
            nav: Number(getComputedStyle(document.querySelector('.nav')).opacity),
          });
        }
        return seen;
      });
      const cuts = track.map((t) => t.cut);
      if (!cuts.some((c) => c > 0)) {
        fail(`${name} ${theme}: the sky is never cut on the way to the bottom — the blind is armed but the reveal does not run`);
      }
      for (let i = 1; i < cuts.length; i++) {
        if (cuts[i] + 1 < cuts[i - 1]) {
          fail(`${name} ${theme}: the sky cut went backwards mid-reveal (${cuts[i - 1]} → ${cuts[i]}) — the blind stutters`);
          break;
        }
      }
      if (!track[track.length - 1].pinned) fail(`${name} ${theme}: the footer is not pinned at the end of the reveal`);
      if (track[0].nav < 0.99) fail(`${name} ${theme}: the header was already faded a viewport and a half from the bottom`);
      if (track[track.length - 1].nav > 0.01) fail(`${name} ${theme}: the header never faded out over the revealed footer`);
      say(`${' '.repeat(18)} ${String(w).padStart(3)}x${lvh} reveal    skyCut ${cuts[0]}→${cuts[cuts.length - 1]}px  nav ${track[0].nav}→${track[track.length - 1].nav}`);
      await ctx.close();
    }

    // ── the header comes back on the way up ─────────────────────────────────
    {
      const { ctx, page } = await open(theme, w, lvh);
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(350);
      const bottom = await readState(page);
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(400);
      const top = await readState(page);
      if (!bottom.revealed) fail(`${name} ${theme}: data-footer-revealed never set at the bottom of the page`);
      if (top.navOpacity < 0.99) fail(`${name} ${theme}: the header did not come back on scroll-up (opacity ${top.navOpacity})`);
      if (top.revealed) fail(`${name} ${theme}: data-footer-revealed still set after scrolling back to the top`);
      const skyBack = top.meta.filter((m) => dist(m, SKY[theme]) > 2);
      if (skyBack.length) fail(`${name} ${theme}: back at the top, <meta theme-color> is ${skyBack.map(hex).join(', ')} rather than the sky ${SKY[theme]}`);
      // The ground must go back to the sky up here. iOS rubber-bands the whole
      // page on a pull-down and paints the canvas above it, so a ground left on
      // the footer's colour would trade the band at the bottom for the same
      // defect at the top — on phones and on any touch tablet.
      if (dist(top.ground, SKY[theme]) > 2) fail(`${name} ${theme}: at scroll-top the page ground is ${hex(top.ground)}, not the sky ${SKY[theme]} — that is a strip of footer blue on every pull-down`);
      if (top.band && dist(top.band.bg, SKY[theme]) > 2) fail(`${name} ${theme}: at scroll-top .ui-tint-b reports ${hex(top.band.bg)} rather than the sky ${SKY[theme]}`);
      await ctx.close();
    }
  }
  // ── the theme button must not cost the visitor scroll restoration ───────
  // On iOS the toggle reloads the page to re-sample the status bar, carrying
  // the scroll position across by hand — which means switching
  // history.scrollRestoration to 'manual'. Left there, every later reload and
  // every Back lands at the top of a six-thousand-pixel page. The device UA is
  // what selects that code path, and these contexts carry it.
  {
    const { ctx, page } = await open(theme, 390, 844);
    await page.evaluate(() => scrollTo(0, 2000));
    await page.waitForTimeout(200);
    await page.click('[data-theme-toggle]');
    await page.waitForTimeout(1400);
    const after = await page.evaluate(() => ({
      restoration: ('scrollRestoration' in history) ? history.scrollRestoration : 'n/a',
      y: Math.round(scrollY),
    }));
    if (after.restoration === 'manual') {
      fail(`${theme}: the theme toggle left history.scrollRestoration on 'manual' — every later reload and Back lands at the top of the page`);
    }
    say(`${' '.repeat(18)} theme toggle  scrollRestoration=${after.restoration} landedAt=${after.y}`);
    await ctx.close();
  }

  say('');
}

// ── the day family: sky at the head, paper at the foot ──────────────────────
// These pages have no blind and no theme toggle — but they have the same edge
// problem in its simplest form. html is painted sky so that a pull-down at the
// top blends, and the page turns to paper 820px in, so the bottom of the
// screen is near-white with a sky-blue strip behind Safari's toolbar. One
// value for two different edges.
const DAY_PAGES = ['/terms', '/privacy', '/discover', '/help', '/guides/', '/vs/whop', '/tools/', '/use-cases/trading'];
say('── day pages (no blind, no toggle) ────────────────────────────────────');
for (const path of DAY_PAGES) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    userAgent: devices['iPhone 13'].userAgent,
  });
  const page = await ctx.newPage();
  const res = await page.goto(BASE.replace(/\/$/, '') + path, { waitUntil: 'load' }).catch(() => null);
  if (!res || res.status() >= 400) { fail(`${path}: ${res ? res.status() : 'unreachable'}`); await ctx.close(); continue; }
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(350);
  const st = await page.evaluate(() => {
    const q = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el) : null; };
    const top = q('.ui-tint'), bot = q('.ui-tint-b');
    return {
      hasTop: !!top, hasBot: !!bot,
      topBg: top && top.backgroundColor, botBg: bot && bot.backgroundColor,
      botPos: bot && bot.position, botEdge: bot && bot.bottom,
      paper: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    };
  });
  const edge = await edgeColour(page, 390, 844);
  if (!st.hasTop || !st.hasBot) {
    fail(`${path}: missing the ${!st.hasTop ? 'top' : 'bottom'} tint strip — iOS has nothing to sample at that edge`);
  } else {
    if (st.botPos !== 'fixed' || st.botEdge !== '0px') fail(`${path}: .ui-tint-b is ${st.botPos} at bottom:${st.botEdge}`);
    // Judged against the page's own paper token, not against a sampled pixel.
    // The bottom row of these pages is whatever content happens to land there
    // — a dashed footer rule, the edge of a frosted panel, a line of links —
    // and that moves by ten or twenty units between runs. The paper is the
    // thing the strip has to agree with, and it does not move.
    if (dist(st.botBg, st.paper) > 2) fail(`${path}: the bottom strip reports ${hex(st.botBg)} but the page's paper is ${hex(st.paper)}`);
    if (dist(st.topBg, st.botBg) <= 4) fail(`${path}: both strips report ${hex(st.topBg)} — this page is sky at the top and paper at the foot, they cannot be one value`);
    // and the pixels still have to rule out the reported defect itself: a band
    // of sky blue under a near-white footer.
    if (dist(edge, '#70a3e6') <= 30) fail(`${path}: the foot of the page paints ${hex(edge)}, which is the sky — the band is there`);
  }
  say(`${path.padEnd(24)} top=${hex(st.topBg)} bottom=${hex(st.botBg)} paper=${hex(st.paper)} paintedFoot=${hex(edge)}`);
  await ctx.close();
}
say('');

await browser.close();

if (fails.length) {
  say(`${fails.length} problem(s):`);
  fails.forEach((f) => say(`  • ${f}`));
  process.exit(1);
}
say('The footer owns the bottom of the screen on every phone: its colour is the page');
say('ground, its own background-color, the theme-color meta and the bottom-edge sample,');
say('in all three viewport states — and the header comes back on the way up.');
