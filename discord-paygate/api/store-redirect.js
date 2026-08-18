// /store is a legacy alias, not a page: the built-in store lives at its own
// slug like every other store (nothing about it is special to buyers). Old
// links keep working through this permanent redirect, query intact.
import { defaultSlug } from '../src/services/stores.js';
import { guard } from '../src/lib/http.js';

export default guard(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.writeHead(308, { location: `/${defaultSlug()}${url.search}` });
  res.end();
});
