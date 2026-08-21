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

export const THEME_KEYS = ['bg', 'panel', 'text', 'accent', 'pay', 'radius', 'font'];

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
  return Object.keys(out).length ? out : null;
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
  if (t.radius !== undefined) {
    const small = Math.min(t.radius, 12);
    lines.push(`.checkout .panel, .checkout .order-product, .checkout .order-roles, .checkout .pay-panel, .checkout .order-extra { border-radius: ${t.radius}px; }`);
    lines.push(`.checkout .pay-btn, .checkout .apply-btn, .checkout .method, .checkout input, .checkout .op-thumb { border-radius: ${small}px; }`);
  }
  if (t.font && THEME_FONTS[t.font]) {
    lines.push(`body, .checkout button, .checkout input { font-family: ${THEME_FONTS[t.font]}; }`);
    lines.push(`.order-title, .op-price, .pay-panel h2 { font-family: ${THEME_FONTS[t.font]}; }`);
  }
  return lines.join('\n');
}
