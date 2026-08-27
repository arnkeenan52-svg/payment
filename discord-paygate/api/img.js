// Serves product photos that owners uploaded in the dashboard. The photo is
// stored as a data URL on the plan row (client-side downscaled, ~100KB); this
// endpoint turns it back into a real image response with cache headers, so
// storefronts and Stripe checkout can reference a plain https URL.
import { guard, sendText } from '../src/lib/http.js';
import { adminStoreBySlug } from '../src/services/stores.js';
import { getPlanImage } from '../src/db.js';

const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif)|video\/(?:mp4|webm));base64,([A-Za-z0-9+/=]+)$/;

export default guard(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const slug = url.searchParams.get('store') ?? '';
  const planKey = url.searchParams.get('plan') ?? '';
  if (!/^[a-z0-9-]{1,40}$/.test(slug) || !/^[a-z0-9-]{1,64}$/.test(planKey)) {
    return sendText(res, 400, 'bad request');
  }
  // adminStoreBySlug, not storeBySlug: the buyer-facing draft guard maps a
  // draft that shares the built-in store's slug to the env store, which
  // 404ed every photo the owner uploaded while setting that draft up.
  const store = await adminStoreBySlug(slug);
  if (!store || store.id === null) return sendText(res, 404, 'not found');
  const data = await getPlanImage(store.id, planKey);
  const m = data ? DATA_URL.exec(data) : null;
  if (!m) return sendText(res, 404, 'not found');
  const body = Buffer.from(m[2], 'base64');
  const common = {
    'content-type': m[1],
    'cache-control': 'public, max-age=3600',
    'accept-ranges': 'bytes',
    // The MIME is already whitelisted by DATA_URL; nosniff stops a browser
    // from ever reinterpreting the bytes as anything else.
    'x-content-type-options': 'nosniff',
  };
  // Range support: Safari refuses to play <video> from servers that answer a
  // byte-range request with a plain 200, so honour single ranges.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    if (!Number.isFinite(start) || start >= body.length || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${body.length}` });
      return res.end();
    }
    const chunk = body.subarray(start, end + 1);
    res.writeHead(206, {
      ...common,
      'content-length': chunk.length,
      'content-range': `bytes ${start}-${end}/${body.length}`,
    });
    return res.end(chunk);
  }
  res.writeHead(200, { ...common, 'content-length': body.length });
  res.end(body);
});
