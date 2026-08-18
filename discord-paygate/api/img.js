// Serves product photos that owners uploaded in the dashboard. The photo is
// stored as a data URL on the plan row (client-side downscaled, ~100KB); this
// endpoint turns it back into a real image response with cache headers, so
// storefronts and Stripe checkout can reference a plain https URL.
import { guard, sendText } from '../src/lib/http.js';
import { storeBySlug } from '../src/services/stores.js';
import { getPlanImage } from '../src/db.js';

const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

export default guard(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const slug = url.searchParams.get('store') ?? '';
  const planKey = url.searchParams.get('plan') ?? '';
  if (!/^[a-z0-9-]{1,40}$/.test(slug) || !/^[a-z0-9-]{1,64}$/.test(planKey)) {
    return sendText(res, 400, 'bad request');
  }
  const store = await storeBySlug(slug);
  if (!store || store.id === null) return sendText(res, 404, 'not found');
  const data = await getPlanImage(store.id, planKey);
  const m = data ? DATA_URL.exec(data) : null;
  if (!m) return sendText(res, 404, 'not found');
  const body = Buffer.from(m[2], 'base64');
  res.writeHead(200, {
    'content-type': m[1],
    'content-length': body.length,
    'cache-control': 'public, max-age=3600',
  });
  res.end(body);
});
