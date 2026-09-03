// Public trigger for the one-shot Discord brand refresh — the same routine
// the hourly cron runs, callable on demand so a brand bump does not wait for
// the next tick. Safe without auth by construction: it takes no input, only
// re-applies the CURRENT shipped brand, no-ops once the version flags are
// set, and real attempts are throttled to one per two minutes inside the
// service. The summary it returns is the observability.
import { guard, sendJson } from '../src/lib/http.js';
import { refreshBrandAssets } from '../src/services/brand-refresh.js';

export default guard(async (req, res) => {
  const summary = await refreshBrandAssets().catch((err) => ({ error: err.message }));
  sendJson(res, 200, { ok: true, ran: Boolean(summary), ...(summary ? { summary } : {}) });
});
