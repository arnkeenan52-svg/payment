// Server-rendered store page: store.html with the head's link-preview tags
// replaced per store, so sharing dues.gg/<slug> in Discord (or
// anywhere) unfurls with the store's name, description and the product
// photo the owner added. Unfurlers never execute JS — only tags rendered
// here count. The rest of the page stays the same client-driven checkout.
import fs from 'node:fs';
import path from 'node:path';
import { guard, sendText } from '../src/lib/http.js';
import { config } from '../src/config.js';
import { storeBySlug, sellablePlansOf, bannerFor } from '../src/services/stores.js';
import { DEMO_SLUG, DEMO_NAME, DEMO_THEME, demoPlans } from '../src/services/demo-store.js';
import { validateTheme, themeCss, bgLayer } from '../src/lib/theme.js';
import { themeIfPaid } from '../src/services/billing.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// dues.gg serves on the apex directly — the base URL IS the canonical host.
const canonicalBase = () => config.publicBaseUrl;

let template = null;
const load = () => (template ??= fs.readFileSync(path.join(config.root, 'public', 'store.html'), 'utf8'));

const matchPlan = (plans, seg) => plans.find((p) => (p.linkSlug ?? p.id ?? p.planKey) === seg || p.id === seg || p.planKey === seg);

export default guard(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const slug = (url.searchParams.get('store') ?? '').toLowerCase();
  const productSeg = (url.searchParams.get('product') ?? '').toLowerCase() || null;
  let head = null;
  let themeStyle = '';
  let bg = null;
  if (slug === DEMO_SLUG) {
    // The hosted demo store: fixed head and the Emerald theme, no DB behind it.
    try {
      const theme = validateTheme(DEMO_THEME);
      themeStyle = `\n  <style id="store-theme">${themeCss(theme)}</style>`;
      bg = bgLayer(theme);
    } catch { /* the default look, then */ }
    const demoPlan = productSeg ? matchPlan(demoPlans(), productSeg) : null;
    const title = demoPlan ? `${demoPlan.name} — ${DEMO_NAME}` : `${DEMO_NAME} — Demo Store`;
    const desc = demoPlan
      ? `${demoPlan.description} $${demoPlan.priceUsd.toFixed(2)}${demoPlan.lifetime ? ' · lifetime' : '/month'} — a Dues demo product.`
      : 'Walk a live Dues checkout — themed store page, products and discounts. Nothing here is for sale.';
    const image = `${config.publicBaseUrl}/shot-store.png`;
    head = `<title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:image" content="${esc(image)}" />
  <meta property="og:image:alt" content="${esc(title)}" />
  <meta property="og:site_name" content="${esc(config.platform)}" />
  <meta property="og:locale" content="en_US" />
  <meta property="og:url" content="${esc(`${canonicalBase()}/${DEMO_SLUG}`)}" />
  <link rel="canonical" href="${esc(`${canonicalBase()}/${DEMO_SLUG}`)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@duesdiscord" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${esc(image)}" />
  <meta name="twitter:image:alt" content="${esc(title)}" />`;
  } else if (/^[a-z0-9-]{1,40}$/.test(slug)) {
    const store = await storeBySlug(slug).catch(() => null);
    if (store) {
      // The owner's theme, server-rendered so the page never flashes the
      // default look. Re-validated here: only tokens ever reach the CSS,
      // whatever ended up in the database. themeIfPaid returns null for a
      // store on the free plan, so a free storefront renders the platform's
      // own black — the tokens are parked on the row, not lost.
      try {
        const theme = validateTheme(await themeIfPaid(store));
        if (theme) {
          themeStyle = `\n  <style id="store-theme">${themeCss(theme)}</style>`;
          bg = bgLayer(theme);
        }
      } catch {
        /* an unusable stored theme renders the default look */
      }
      const plans = await sellablePlansOf(store).catch(() => []);
      const matched = productSeg ? matchPlan(plans, productSeg) : null;
      // A link may name a price OPTION of a product — the page (and its
      // unfurl) belongs to the product itself: parent name and photo, the
      // option's own price.
      const linkedPlan = matched?.variantOf ? plans.find((p) => p.id === matched.variantOf) ?? matched : matched;
      // The preview image is the product's own photo when there is one
      // (uploads serve from /api/img over https); the platform shot otherwise.
      const productImg = (linkedPlan ? [linkedPlan] : plans)
        .filter((p) => p?.mediaKind !== 'video' && !/\.(mp4|webm)([?#]|$)/i.test(p?.imageUrl ?? ''))
        .map((p) => p.imageUrl)
        .find((u) => typeof u === 'string' && u.startsWith('https://'));
      // The store's banner is the picture its owner chose for the page, so it
      // leads the unfurl — except on a PRODUCT link, where the card's title is
      // that product and its own photo is what belongs beside it. Video
      // banners are skipped: unfurlers render an <img> and nothing else, so an
      // mp4 would be a broken card.
      const banner = linkedPlan ? { url: null, kind: null } : await bannerFor(store).catch(() => ({ url: null, kind: null }));
      const image = (banner.kind === 'image' && banner.url) || productImg || `${config.publicBaseUrl}/shot-store.png`;
      const title = linkedPlan ? `${linkedPlan.name} — ${store.name}` : `${store.name} — Membership`;
      const desc = linkedPlan
        ? `${(linkedPlan.description ?? '').trim() || `Join ${store.name}.`} $${linkedPlan.priceUsd.toFixed(2)}${linkedPlan.lifetime ? ' · lifetime' : '/month'} — roles delivered in seconds.`
        : (store.description ?? '').trim() ||
          `Join ${store.name} — pay securely with Stripe, your Discord role arrives in seconds.`;
      head = `<title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:image" content="${esc(image)}" />
  <meta property="og:image:alt" content="${esc(title)}" />
  <!-- The platform, not the store: this is the pill X lays over the card and
       the line Discord prints above the title, so a seller's link unfurls as
       "Dues · <their store>" rather than as an unattributed screenshot. The
       store's own name is already the og:title. No width/height here — the
       image is usually the seller's own product photo, and declaring
       dimensions we have not measured is worse than declaring none. -->
  <meta property="og:site_name" content="${esc(config.platform)}" />
  <meta property="og:locale" content="en_US" />
  <meta property="og:url" content="${esc(`${canonicalBase()}/${store.slug}${linkedPlan ? `/${encodeURIComponent(linkedPlan.linkSlug ?? linkedPlan.id)}` : ''}`)}" />
  <link rel="canonical" href="${esc(`${canonicalBase()}/${store.slug}${linkedPlan ? `/${encodeURIComponent(linkedPlan.linkSlug ?? linkedPlan.id)}` : ''}`)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@duesdiscord" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${esc(image)}" />
  <meta name="twitter:image:alt" content="${esc(title)}" />`;
    }
  }
  let html;
  try {
    html = load();
  } catch (err) {
    console.error(`[store-page] template unreadable: ${err.message}`);
    return sendText(res, 500, 'internal error');
  }
  // Replacement is a function so $-patterns in seller text stay literal —
  // a description like "Win $$$ daily" must not corrupt the served head.
  if (head) html = html.replace(/<!-- og:begin[\s\S]*?<!-- og:end -->/, () => head);
  if (themeStyle) html = html.replace('</head>', `${themeStyle}\n</head>`);
  // The owner's background: a layer just inside <body>, material attributes
  // on the body tag, the light token set for bright grounds, and the cloud
  // shader for the live presets. All of it built from validated tokens.
  if (bg) {
    html = html.replace('<body>', () => `<body${bg.bodyAttrs}>\n  ${bg.markup}`);
    if (bg.lightTone) html = html.replace('<html lang="en">', '<html lang="en" data-theme="light">');
    if (bg.needsSky) html = html.replace('</body>', () => `  <script src="/sky.js" defer></script>\n</body>`);
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    // Short shared cache: link unfurlers and buyers get fresh store data
    // within a minute of an edit, without a function hit per page view.
    'cache-control': 'public, s-maxage=60, stale-while-revalidate=300',
  });
  res.end(html);
});
