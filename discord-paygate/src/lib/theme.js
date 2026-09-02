// Per-store storefront theming.
//
// A theme is a handful of validated design tokens, never free-form CSS. The
// checkout page is where buyers type nothing but still authorize money, so an
// owner must not be able to inject arbitrary styles into it — attribute
// selectors and background-image URLs make raw CSS an exfiltration surface.
// Tokens in, CSS out, all of it built here on the server.
//
// Derived values (borders, dim text, hover shades) come from color-mix so the
// palette stays coherent from three inputs instead of asking owners to design
// nine grays.

const HEX = /^#[0-9a-fA-F]{6}$/;

// Font stacks that need no font files: every option renders from what the
// buyer's device already has (the default keeps the platform's own faces).
export const THEME_FONTS = {
  default: null, // the platform stack already in styles.css
  system: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "ui-serif, Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace",
};

export const THEME_KEYS = ['bg', 'panel', 'text', 'accent', 'pay', 'radius', 'font', 'bgPreset', 'bgUrl', 'material'];

// Where the paid line falls inside a store's look.
//
// The COLOUR WAY is free: every preset, every custom colour, corners, type and
// material. So is a plain gradient ground — these ten are flat CSS gradients
// with no animation and no photograph behind them, which is the cheap half of
// the catalogue in every sense.
//
// NO PART OF A LOOK IS PAID. Every colour, corner, typeface and material,
// every one of the backgrounds in the catalogue below, and an image the
// seller imports by URL: all of it is free, on every plan. A storefront that
// looks like it cost something is what sells the seller's roles, and charging
// for that was taxing our own shop window. What a plan buys is member
// capacity, and nothing about how a store looks.
//
// There is deliberately no usesPaidLook()/freeLook() pair any more. A gate
// that always answers "allowed" is worse than no gate: the next reader has to
// prove it is dead before they can trust the page they are looking at.
//
// FREE_BG_PRESETS is derived from BG_PRESETS below rather than listed by
// hand, so a preset added to the catalogue is available the moment it exists.
// public/dashboard.js mirrors the catalogue for its picker; a scenario in the
// suite holds the two lists together.

// The background catalog. Every preset is served from this origin — CSS
// scenes, the live cloud shader, or a JPG under /bg — so picking one can
// never point a buyer's browser anywhere but dues.gg. `tone: 'light'`
// presets flip the checkout onto the light token set so text stays readable
// on a bright ground; `live` mounts the WebGL cloud canvas; `img` names a
// local photo layer.
export const BG_PRESETS = {
  // clouds — the brand sky, drifting live
  'clouds-day': { tone: 'light', live: true, label: 'Clouds · day' },
  'clouds-night': { tone: 'dark', live: true, label: 'Clouds · night' },
  // stills of the same sky
  'sky-day': { tone: 'light', img: '/sky-day-tall.jpg', label: 'Sky photo · day' },
  'sky-night': { tone: 'dark', img: '/sky-night-tall.jpg', label: 'Sky photo · night' },
  // painted landscapes (public/bg/*.jpg, generated in-house)
  mountains: { tone: 'dark', img: '/bg/mountains.jpg', label: 'Mountains' },
  forest: { tone: 'dark', img: '/bg/forest.jpg', label: 'Forest' },
  dunes: { tone: 'dark', img: '/bg/dunes.jpg', label: 'Dunes' },
  lake: { tone: 'dark', img: '/bg/lake.jpg', label: 'Lake' },
  coast: { tone: 'dark', img: '/bg/coast.jpg', label: 'Coast' },
  meadow: { tone: 'light', img: '/bg/meadow.jpg', label: 'Meadow' },
  canyon: { tone: 'dark', img: '/bg/canyon.jpg', label: 'Canyon' },
  blossom: { tone: 'light', img: '/bg/blossom.jpg', label: 'Blossom' },
  city: { tone: 'dark', img: '/bg/city.jpg', label: 'City night' },
  volcano: { tone: 'dark', img: '/bg/volcano.jpg', label: 'Volcano' },
  cosmos: { tone: 'dark', img: '/bg/cosmos.jpg', label: 'Cosmos' },
  reef: { tone: 'dark', img: '/bg/reef.jpg', label: 'Reef' },
  // animated CSS scenes
  aurora: { tone: 'dark', label: 'Aurora' },
  starfield: { tone: 'dark', label: 'Starfield' },
  fireflies: { tone: 'dark', label: 'Fireflies' },
  rain: { tone: 'dark', label: 'Rain' },
  snow: { tone: 'dark', label: 'Snowfall' },
  ocean: { tone: 'dark', label: 'Deep ocean' },
  lava: { tone: 'dark', label: 'Lava' },
  nebula: { tone: 'dark', label: 'Nebula' },
  synthwave: { tone: 'dark', label: 'Synthwave' },
  flow: { tone: 'dark', label: 'Color flow' },
  matrix: { tone: 'dark', label: 'Matrix rain' },
  hyperspace: { tone: 'dark', label: 'Hyperspace' },
  thunder: { tone: 'dark', label: 'Thunderstorm' },
  sakura: { tone: 'light', label: 'Sakura wind' },
  bubbles: { tone: 'dark', label: 'Bubbles' },
  confetti: { tone: 'dark', label: 'Confetti' },
  smoke: { tone: 'dark', label: 'Smoke' },
  golddust: { tone: 'dark', label: 'Gold dust' },
  // quiet gradients
  midnight: { tone: 'dark', label: 'Midnight' },
  denim: { tone: 'dark', label: 'Denim' },
  royal: { tone: 'dark', label: 'Royal' },
  emerald: { tone: 'dark', label: 'Emerald' },
  rose: { tone: 'dark', label: 'Rose' },
  gold: { tone: 'dark', label: 'Gold' },
  slate: { tone: 'dark', label: 'Slate' },
  lavender: { tone: 'light', label: 'Lavender' },
  mint: { tone: 'light', label: 'Mint' },
  ember: { tone: 'dark', label: 'Ember' },
};

// Every preset, by id. Nothing here is gated — see the note at the top.
export const FREE_BG_PRESETS = Object.freeze(Object.keys(BG_PRESETS));


export const THEME_MATERIALS = ['glass', 'liquid', 'solid'];

// Validate an owner-supplied theme object. Unknown keys are dropped (forward
// compatibility), bad VALUES are an error (a typoed hex should never save as
// silence). Returns a clean object, or null when nothing usable remains.
export function validateTheme(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('theme must be an object');
  const out = {};
  for (const key of ['bg', 'panel', 'text', 'accent', 'pay']) {
    const v = input[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || !HEX.test(v.trim())) throw new Error(`theme.${key} must be a hex color like #22c55e`);
    out[key] = v.trim().toLowerCase();
  }
  if (input.radius !== undefined && input.radius !== null && input.radius !== '') {
    const r = Number(input.radius);
    if (!Number.isInteger(r) || r < 0 || r > 24) throw new Error('theme.radius must be a whole number from 0 to 24');
    out.radius = r;
  }
  if (input.font !== undefined && input.font !== null && input.font !== '') {
    if (!Object.hasOwn(THEME_FONTS, input.font)) throw new Error(`theme.font must be one of: ${Object.keys(THEME_FONTS).join(', ')}`);
    if (input.font !== 'default') out.font = input.font;
  }
  if (input.bgPreset !== undefined && input.bgPreset !== null && input.bgPreset !== '') {
    if (typeof input.bgPreset !== 'string' || !Object.hasOwn(BG_PRESETS, input.bgPreset)) {
      throw new Error('theme.bgPreset is not one of the built-in backgrounds');
    }
    out.bgPreset = input.bgPreset;
  }
  if (input.bgUrl !== undefined && input.bgUrl !== null && input.bgUrl !== '') {
    out.bgUrl = validateBgUrl(input.bgUrl);
  }
  if (input.material !== undefined && input.material !== null && input.material !== '') {
    if (!THEME_MATERIALS.includes(input.material)) throw new Error(`theme.material must be one of: ${THEME_MATERIALS.join(', ')}`);
    out.material = input.material;
  }
  return Object.keys(out).length ? out : null;
}

// An owner-imported background: a GIF, image, or MP4/WebM the owner hosts.
// Never reaches CSS (no url() injection surface) — it renders as a media
// ELEMENT with an escaped attribute. https only, a real parseable URL, and a
// recognizable media extension, so "javascript:" and friends have no door.
//
// What this check IS: a scheme gate and a typo catcher. What it is NOT: a
// promise about the bytes. The extension is read off the URL we were handed,
// and the host is free to answer it with a 302 somewhere else, with a 400MB
// file, or with a socket it never closes — all three are reproducible, none
// of them is stoppable from here, and none of them is worse than what any
// hotlinked image on any site can do. What actually bounds the damage is the
// shape of the destination: the value only ever becomes the `src` of an
// <img>/<video> that carries no-referrer (bgLayer below), so it cannot run
// script, cannot read the page, cannot reach the checkout's fields, and is
// never fetched by OUR server — grep for it: nothing on the server side
// touches a seller-supplied URL, so there is no SSRF here to have.
//
// The one thing a third-party host does learn is that a browser asked it for
// a picture: its IP and user agent. Only proxying every import through
// dues.gg would take that away, and that would hand us the server-side fetch
// of an attacker-chosen URL we currently do not have. Not worth the trade.
function validateBgUrl(v) {
  if (typeof v !== 'string' || v.length > 600) throw new Error('theme.bgUrl must be a URL under 600 characters');
  let u;
  try {
    u = new URL(v.trim());
  } catch {
    throw new Error('theme.bgUrl is not a valid URL');
  }
  if (u.protocol !== 'https:') throw new Error('theme.bgUrl must be https://');
  if (!/\.(gif|png|jpe?g|webp|avif|mp4|webm)$/i.test(u.pathname)) {
    throw new Error('theme.bgUrl must end in .gif, .png, .jpg, .webp, .avif, .mp4 or .webm');
  }
  return u.href;
}

export const isVideoBg = (url) => /\.(mp4|webm)$/i.test(new URL(url).pathname);

const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The store background, described by a validated theme. Returns null when the
// theme asks for no background, else everything the page needs:
//   markup  — the .store-bg layer to drop just inside <body>
//   bodyAttrs — attributes for the <body> tag (bg id + material)
//   lightTone — flip the page onto the light token set
//   needsSky — mount /sky.js (live cloud presets)
export function bgLayer(theme) {
  const t = theme ?? {};
  const custom = t.bgUrl ?? null;
  const preset = !custom && t.bgPreset ? t.bgPreset : null;
  if (!custom && !preset) return null;
  const def = preset ? BG_PRESETS[preset] : null;
  const id = preset ?? 'custom';
  let inner = '';
  if (custom) {
    // no-referrer, because the host on the other end of an import is a
    // stranger to the BUYER. Without it every visit to this store announces
    // itself to that host as coming from https://dues.gg/ (measured: the
    // browser default is strict-origin-when-cross-origin, so it sends the
    // origin — not the slug — but announcing a Dues buyer at all is not ours
    // to give away). Its IP and user agent still reach the host; that is
    // what asking a browser for a picture costs, and only proxying every
    // import would change it.
    //
    // Deliberately NOT crossorigin: that makes the request CORS-mode, and a
    // host that does not send access-control-allow-origin then renders
    // nothing at all. It would break honest imports to withhold a cookie
    // from a host that already has the IP.
    inner = isVideoBg(custom)
      ? `<video src="${escAttr(custom)}" autoplay muted loop playsinline disablepictureinpicture referrerpolicy="no-referrer" aria-hidden="true"></video>`
      : `<img src="${escAttr(custom)}" alt="" aria-hidden="true" referrerpolicy="no-referrer" />`;
  } else if (def.live) {
    inner = '<canvas data-dues-sky></canvas>';
  } else if (def.img) {
    inner = `<img src="${escAttr(def.img)}" alt="" aria-hidden="true" />`;
  } else {
    // CSS scenes draw on three generic layers
    inner = '<span class="sbg-a"></span><span class="sbg-b"></span><span class="sbg-c"></span>';
  }
  const material = t.material ?? 'glass';
  return {
    markup: `<div class="store-bg" data-bg="${escAttr(id)}" aria-hidden="true">${inner}</div>`,
    bodyAttrs: ` class="has-bg" data-bg="${escAttr(id)}" data-material="${escAttr(material)}"`,
    lightTone: Boolean(def?.tone === 'light'),
    needsSky: Boolean(def?.live),
  };
}

// Perceived luminance → readable ink on a colored button. The one derivation
// CSS cannot do for us.
const inkFor = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const yiq = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
  return yiq >= 150 ? '#0a0a0a' : '#ffffff';
};

// Build the <style> body for a validated theme. Safe by construction: every
// interpolated value has passed validateTheme, so only hex colors, small
// integers and fixed stacks ever reach the CSS.
export function themeCss(theme) {
  const t = theme ?? {};
  const lines = [];
  const vars = [];
  if (t.bg) vars.push(`--bg: ${t.bg}`);
  if (t.panel) {
    vars.push(`--panel: ${t.panel}`);
    vars.push(`--panel-hover: color-mix(in srgb, ${t.panel} 92%, ${t.text ?? '#ffffff'})`);
  }
  if (t.text) {
    vars.push(`--ink: ${t.text}`);
    vars.push(`--dim: color-mix(in srgb, ${t.text} 58%, ${t.bg ?? '#0a0a0a'})`);
  }
  if (t.text || t.panel) vars.push(`--edge: color-mix(in srgb, ${t.text ?? '#ffffff'} 14%, ${t.panel ?? '#101010'})`);
  if (t.accent) {
    vars.push(`--accent: ${t.accent}`);
    vars.push(`--accent-hot: color-mix(in srgb, ${t.accent} 85%, #ffffff)`);
    vars.push(`--edge-selected: ${t.accent}`);
  }
  if (vars.length) lines.push(`body { ${vars.map((v) => `${v};`).join(' ')} }`);
  if (t.bg) lines.push(`body { background: ${t.bg}; }`);
  if (t.text) lines.push(`body { color: ${t.text}; }`);
  if (t.pay) {
    lines.push(`.pay-btn { background: ${t.pay}; color: ${inkFor(t.pay)}; }`);
    lines.push(`.pay-btn:hover:not(:disabled) { background: color-mix(in srgb, ${t.pay} 86%, #000000); }`);
  }
  // The wordmark ships as a white PNG. public/styles.css inverts it under
  // html[data-theme='light'], but a store's lightness comes from --bg, not
  // from that attribute — so a light colour way leaves it near-white on
  // near-white.
  //
  // With a background layer the mark is NOT on the wallpaper either: the two
  // places it appears, the header and the footer, wear 68% of --bg (see
  // styles.css), so --bg decides there as well. A light-tone preset sets
  // data-theme='light' for the COLUMN, and styles.css was reading that as
  // permission to paint a black mark onto a black store's dark chrome bar —
  // measured on sakura and mint. Hence the explicit `none`, at a specificity
  // that outranks the html[data-theme='light'] rule and comes after it.
  if (t.bg) {
    const lightGround = inkFor(t.bg) === '#0a0a0a';
    if (t.bgPreset || t.bgUrl) {
      lines.push(`body.has-bg .platform-mark, body.has-bg .powered-mark { filter: ${lightGround ? 'invert(1)' : 'none'}; }`);
    } else if (lightGround) {
      lines.push('.platform-mark, .powered-mark { filter: invert(1); }');
    }
  }
  if (t.radius !== undefined) {
    const small = Math.min(t.radius, 12);
    // .shop-banner is deliberately absent: it runs flush to the column rails
    // with hard corners, and rounding it reopens the gap the frame closes.
    // .prod-shot/.prod-ph are absent for the same reason — the card clips
    // them, and an inner radius leaves a double-rounded sliver at the corner.
    lines.push(`.checkout .panel, .checkout .order-product, .checkout .order-roles, .checkout .pay-panel, .checkout .order-extra, .prod-card, .shop-avatar, .shop-tm { border-radius: ${t.radius}px; }`);
    lines.push(`.checkout .pay-btn, .checkout .apply-btn, .checkout .method, .checkout input, .checkout .op-thumb, .shop-btn, .shop-icon-btn, .shop-rvform textarea, .shop-rv-reply { border-radius: ${small}px; }`);
  }
  if (t.font && THEME_FONTS[t.font]) {
    lines.push(`body, .checkout button, .checkout input { font-family: ${THEME_FONTS[t.font]}; }`);
    lines.push(`.order-title, .op-price, .pay-panel h2, .shop-name, .shop-sec, .prod-name, .prod-price, .shop-rv-name, .shop-tm-name { font-family: ${THEME_FONTS[t.font]}; }`);
  }
  return lines.join('\n');
}
