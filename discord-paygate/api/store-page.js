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

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let template = null;
const load = () => (template ??= fs.readFileSync(path.join(config.root, 'public', 'store.html'), 'utf8'));

export default guard(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const slug = (url.searchParams.get('store') ?? '').toLowerCase();
  let head = null;
  if (/^[a-z0-9-]{1,40}$/.test(slug)) {
    const store = await storeBySlug(slug).catch(() => null);
    if (store) {
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
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    // Short shared cache: link unfurlers and buyers get fresh store data
    // within a minute of an edit, without a function hit per page view.
    'cache-control': 'public, s-maxage=60, stale-while-revalidate=300',
  });
  res.end(html);
});
