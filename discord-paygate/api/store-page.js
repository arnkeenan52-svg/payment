// Server-rendered store page: store.html with the head's link-preview tags
// replaced per store, so sharing ripleybot.com/<slug> in Discord (or
// anywhere) unfurls with the store's name, description and the product
// photo the owner added. Unfurlers never execute JS — only tags rendered
// here count. The rest of the page stays the same client-driven checkout.
import fs from 'node:fs';
import path from 'node:path';
import { guard, sendText } from '../src/lib/http.js';
import { config } from '../src/config.js';
import { storeBySlug, sellablePlansOf } from '../src/services/stores.js';
import { DEMO_SLUG, DEMO_NAME, DEMO_THEME } from '../src/services/demo-store.js';
import { validateTheme, themeCss } from '../src/lib/theme.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let template = null;
const load = () => (template ??= fs.readFileSync(path.join(config.root, 'public', 'store.html'), 'utf8'));

export default guard(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const slug = (url.searchParams.get('store') ?? '').toLowerCase();
  let head = null;
  let themeStyle = '';
  if (slug === DEMO_SLUG) {
    // The hosted demo store: fixed head and the Emerald theme, no DB behind it.
    try {
      themeStyle = `\n  <style id="store-theme">${themeCss(validateTheme(DEMO_THEME))}</style>`;
    } catch { /* the default look, then */ }
    const title = `${DEMO_NAME} — Demo Store`;
    const desc = 'Walk a live Ripley checkout — themed store page, products and discounts. Nothing here is for sale.';
    const image = `${config.publicBaseUrl}/shot-store.png`;
    head = `<title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:image" content="${esc(image)}" />
  <meta property="og:url" content="${esc(`${config.publicBaseUrl}/${DEMO_SLUG}`)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${esc(image)}" />`;
  } else if (/^[a-z0-9-]{1,40}$/.test(slug)) {
    const store = await storeBySlug(slug).catch(() => null);
    if (store) {
      // The owner's theme, server-rendered so the page never flashes the
      // default look. Re-validated here: only tokens ever reach the CSS,
      // whatever ended up in the database.
      try {
        const theme = validateTheme(store.theme);
        if (theme) themeStyle = `\n  <style id="store-theme">${themeCss(theme)}</style>`;
      } catch {
        /* an unusable stored theme renders the default look */
      }
      const plans = await sellablePlansOf(store).catch(() => []);
      // The preview image is the store's own product photo when there is one
      // (uploads serve from /api/img over https); the platform shot otherwise.
      const productImg = plans.map((p) => p.imageUrl).find((u) => typeof u === 'string' && u.startsWith('https://'));
      const image = productImg ?? `${config.publicBaseUrl}/shot-store.png`;
      const title = `${store.name} — Membership`;
      const desc =
        (store.description ?? '').trim() ||
        `Join ${store.name} — pay securely with Stripe, your Discord role arrives in seconds.`;
      head = `<title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:image" content="${esc(image)}" />
  <meta property="og:url" content="${esc(`${config.publicBaseUrl}/${store.slug}`)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${esc(image)}" />`;
    }
  }
  let html;
  try {
    html = load();
  } catch (err) {
    console.error(`[store-page] template unreadable: ${err.message}`);
    return sendText(res, 500, 'internal error');
  }
  if (head) html = html.replace(/<!-- og:begin[\s\S]*?<!-- og:end -->/, head);
  if (themeStyle) html = html.replace('</head>', `${themeStyle}\n</head>`);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    // Short shared cache: link unfurlers and buyers get fresh store data
    // within a minute of an edit, without a function hit per page view.
    'cache-control': 'public, s-maxage=60, stale-while-revalidate=300',
  });
  res.end(html);
});
