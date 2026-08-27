// Welcome card renderer — the image posted when someone joins a server.
//
// Built as an SVG and rasterized with sharp (libvips), so the only runtime
// cost is one small PNG encode. Deliberately NOT Playwright: a headless
// browser would be a ~400MB image and a second of CPU per join, for a card
// that is a rectangle, a circle and three lines of text.
//
// Fonts are the fragile part of SVG rasterization: librsvg resolves families
// through fontconfig, so the bundled TTFs in assets/fonts must be installed
// on the system (the Dockerfile copies them into /usr/share/fonts). A
// missing family silently falls back to something ugly rather than throwing,
// so we check once and warn loudly instead of shipping wrong-looking cards.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const GROTESK = 'Dues Grotesk'; // headline / wordmark
const SANS = 'Dues Sans'; // supporting text
const W = 1200;
const H = 600;

// Discord display names are attacker-controlled text landing inside SVG
// markup: escape the XML metacharacters, drop control characters that would
// break the parser outright, and cap the length so a 32-char name cannot
// push the headline off the card.
// Truncation happens later, against the rendered headline width, not here:
// escaping first would let a single "&" count as five characters ("&amp;")
// toward the limit.
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// librsvg exposes no text-measurement API, so the headline is fitted with an
// estimate: Space Grotesk Bold averages ~0.52em per character across mixed
// case. The name is truncated first (a 32-char name plus the suffix would
// otherwise shrink the line to nothing), then the size steps down until the
// estimate fits. Both guards are needed - either alone still overflows.
const SAFE_W = W - 120; // 60px of breathing room each side
const NAME_MAX = 22;
function fitHeadline(rawName) {
  const name = rawName.length > NAME_MAX ? `${rawName.slice(0, NAME_MAX - 1)}\u2026` : rawName;
  const line = `${name} just joined the server`;
  let size = 50;
  while (size > 28 && line.length * size * 0.52 > SAFE_W) size -= 2;
  return { line: esc(line), size };
}

let fontsChecked = null;
async function fontsPresent() {
  if (fontsChecked !== null) return fontsChecked;
  try {
    const { stdout } = await promisify(execFile)('fc-list', [':', 'family']);
    fontsChecked = stdout.includes(GROTESK) && stdout.includes(SANS);
  } catch {
    fontsChecked = false; // no fontconfig at all
  }
  if (!fontsChecked) {
    console.warn(
      `[welcome-card] brand fonts not installed (looking for "${GROTESK}" / "${SANS}") — ` +
        'cards will render in a fallback face. Copy assets/fonts/*.ttf into /usr/share/fonts and run fc-cache -f.',
    );
  }
  return fontsChecked;
}

// Both faces of the brand sky: dark rides the night clouds, light the day
// ones. Text is white on either — the same treatment as the og-card and the
// site banner — with the bg hex as the paint-before-the-image fallback.
const THEMES = {
  dark: { bg: '#131b2d', text: '#ffffff', sub: '#c6d0e2', ring: '#ffffff', watermark: 'rgba(255,255,255,0.08)', mark: '#ffffff', sky: 'sky-night-card.jpg' },
  light: { bg: '#70a3e6', text: '#ffffff', sub: 'rgba(255,255,255,0.9)', ring: '#ffffff', watermark: 'rgba(255,255,255,0.12)', mark: '#ffffff', sky: 'sky-day-card.jpg' },
};

// The cloud ground, embedded as a data URI so librsvg needs no file access.
// Cached per theme; sliced to cover whatever card size asks for it. A soft
// navy gradient sits on top so white text stays readable over bright clouds.
//
// A missing ground must never cost the card itself: a deployment that forgot
// to ship the JPGs (the worker image copies assets file-by-file) degrades to
// the flat brand color under the same scrim, and warns loudly once, instead
// of throwing away every welcome message over a decoration.
const skyCache = new Map();
function skyLayer(t, w, h) {
  if (!skyCache.has(t.sky)) {
    try {
      const bytes = readFileSync(fileURLToPath(new URL(`../../assets/${t.sky}`, import.meta.url)));
      skyCache.set(t.sky, `data:image/jpeg;base64,${bytes.toString('base64')}`);
    } catch (err) {
      console.warn(`[welcome-card] sky ground assets/${t.sky} unreadable (${err.code ?? err.message}) — rendering flat ${t.bg}`);
      skyCache.set(t.sky, null);
    }
  }
  const ground = skyCache.get(t.sky);
  return (
    (ground ? `<image x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" href="${ground}" />` : '') +
    `<rect width="${w}" height="${h}" fill="url(#duesScrim)" />`
  );
}
const SCRIM_DEF =
  '<defs><linearGradient id="duesScrim" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#10192d" stop-opacity="0.18"/>' +
  '<stop offset="0.55" stop-color="#10192d" stop-opacity="0.30"/>' +
  '<stop offset="1" stop-color="#10192d" stop-opacity="0.44"/>' +
  '</linearGradient></defs>';

// The faint repeating wordmark behind everything, like a pressed watermark.
// Alternate rows are offset so the grid reads as a weave, not a table.
function watermark(text, t, height = H) {
  const rows = [];
  for (let row = 0, y = 46; y < height + 120; row += 1, y += 116) {
    const x = row % 2 === 0 ? -70 : -230;
    rows.push(
      `<text x="${x}" y="${y}" font-family="${GROTESK}" font-size="84" font-weight="700" ` +
        `fill="${t.watermark}" letter-spacing="8" transform="skewX(-12)">` +
        `${new Array(8).fill(text).join('   ')}</text>`,
    );
  }
  return rows.join('');
}

// The Dues lockup — the real asset, not a redrawing of it.
//
// This used to be three hand-authored <path> elements with a comment claiming
// "same geometry as the site logo". It was not: the bars in the real mark step
// progressively LEFT as they descend, with a much wider stagger, and the hand
// version stepped right into a tight compressed stack. A logo is not a thing to
// approximate — composite the file the rest of the site ships.
//
// assets/ rather than public/, because public/ is excluded wholesale by
// .dockerignore and re-including one file out of it has already cost us a
// broken image build once.
const LOGO = fileURLToPath(new URL('../../assets/dues-mark.png', import.meta.url));
const LOGO_RATIO = 1165 / 253; // the asset's own aspect, transparent padding trimmed off

// The asset is a near-white silhouette on transparency, so it can be recoloured
// for either theme by filling a rectangle and punching the logo's alpha
// through it. Cached per theme: this is the same handful of bytes every card.
const logoCache = new Map();
async function logoLayer(sharp, t, theme, x, y, h) {
  const w = Math.round(h * LOGO_RATIO);
  const key = `${theme}:${h}`;
  if (!logoCache.has(key)) {
    const mask = await sharp(LOGO).resize(w, h, { fit: 'contain' }).png().toBuffer();
    const tinted = await sharp({ create: { width: w, height: h, channels: 4, background: t.mark } })
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer();
    logoCache.set(key, `data:image/png;base64,${tinted.toString('base64')}`);
  }
  return `<image x="${x}" y="${y}" width="${w}" height="${h}" href="${logoCache.get(key)}" />`;
}

/**
 * Render the join card.
 *
 * @param {object} o
 * @param {string} o.username           display name shown on the card
 * @param {Buffer|null} [o.avatarPng]   already-fetched avatar bytes (any format sharp reads)
 * @param {number|null} [o.memberNumber] "Member #N"; omitted when null
 * @param {'dark'|'light'} [o.theme]
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function renderWelcomeCard({ username, avatarPng = null, memberNumber = null, theme = 'dark' }) {
  const { default: sharp } = await import('sharp');
  await fontsPresent();
  const t = THEMES[theme] ?? THEMES.dark;
  const logo = await logoLayer(sharp, t, theme, 64, 54, 40);
  const headline = fitHeadline(clean(username) || 'a new member');

  // Avatar: circle-cropped through a mask so any square source works, then
  // inlined as a data URI. 260px on a 600px card keeps it dominant without
  // crowding the headline.
  const AV = 260;
  const CY = 244;
  let avatarLayer = '';
  if (avatarPng) {
    const circle = Buffer.from(
      `<svg width="${AV}" height="${AV}"><circle cx="${AV / 2}" cy="${AV / 2}" r="${AV / 2}" fill="#fff"/></svg>`,
    );
    const cropped = await sharp(avatarPng)
      .resize(AV, AV, { fit: 'cover' })
      .composite([{ input: circle, blend: 'dest-in' }])
      .png()
      .toBuffer();
    const href = `data:image/png;base64,${cropped.toString('base64')}`;
    avatarLayer =
      `<circle cx="${W / 2}" cy="${CY}" r="${AV / 2 + 7}" fill="none" stroke="${t.ring}" stroke-width="7" />` +
      `<image x="${W / 2 - AV / 2}" y="${CY - AV / 2}" width="${AV}" height="${AV}" href="${href}" />`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${SCRIM_DEF}
  <rect width="${W}" height="${H}" fill="${t.bg}" />
  ${skyLayer(t, W, H)}
  ${watermark('DUES', t)}
  ${logo}
  ${avatarLayer}
  <text x="${W / 2}" y="452" text-anchor="middle" font-family="${GROTESK}" font-size="${headline.size}" font-weight="700" fill="${t.text}" letter-spacing="-1">${headline.line}</text>
  ${
    memberNumber
      ? `<text x="${W / 2}" y="512" text-anchor="middle" font-family="${SANS}" font-size="33" fill="${t.sub}">Member #${Number(memberNumber)}</text>`
      : ''
  }
</svg>`;

  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

// ── banner cards ──────────────────────────────────────────────────────────────
// The same chrome as the join card — ground, pressed watermark, mark and
// wordmark — but sized as a header strip and carrying a title instead of a
// member. Used for the pinned #rules post, so a channel the bot owns looks
// like it belongs to the same product as everything else.

const BANNER_H = 400;

// Same estimate-and-shrink approach as fitHeadline, against the banner's own
// width budget. A title is author-written rather than user-supplied, so there
// is no truncation step: an over-long title shrinks instead of being cut.
function fitTitle(text, max, min, perChar) {
  let size = max;
  while (size > min && text.length * size * perChar > SAFE_W) size -= 2;
  return size;
}

/**
 * Render a titled header card.
 *
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.subtitle]
 * @param {'dark'|'light'} [o.theme]
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function renderBannerCard({ title, subtitle = '', theme = 'dark' }) {
  const { default: sharp } = await import('sharp');
  await fontsPresent();
  const t = THEMES[theme] ?? THEMES.dark;
  const logo = await logoLayer(sharp, t, theme, 64, 54, 40);
  const head = clean(title) || 'Dues';
  const sub = clean(subtitle);
  const headSize = fitTitle(head, 76, 34, 0.56);
  const subSize = fitTitle(sub, 30, 20, 0.5);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${BANNER_H}" viewBox="0 0 ${W} ${BANNER_H}">
  ${SCRIM_DEF}
  <rect width="${W}" height="${BANNER_H}" fill="${t.bg}" />
  ${skyLayer(t, W, BANNER_H)}
  ${watermark('DUES', t, BANNER_H)}
  ${logo}
  <text x="${W / 2}" y="${sub ? 258 : 282}" text-anchor="middle" font-family="${GROTESK}" font-size="${headSize}" font-weight="700" fill="${t.text}" letter-spacing="-2">${esc(head)}</text>
  ${sub ? `<text x="${W / 2}" y="312" text-anchor="middle" font-family="${SANS}" font-size="${subSize}" fill="${t.sub}">${esc(sub)}</text>` : ''}
</svg>`;

  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}
