// The public directory: every LIVE store whose owner opted in. Only fields a
// buyer could already see on the storefront leave this endpoint — plus real
// aggregates (product count, lowest price, live members). Nothing here is
// ranked by anything we cannot defend: members descending, then age.

import { sendJson, guard } from '../src/lib/http.js';
import { everyStore, plansOf, bannerFor } from '../src/services/stores.js';
import { countLiveMembers } from '../src/db.js';
import { getGuild, guildIconUrl } from '../src/lib/discord.js';

const cache = { at: 0, body: null };
const TTL_MS = 60 * 1000;

export default guard(async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const fresh = url.searchParams.get('fresh') === '1';
  if (fresh || Date.now() - cache.at > TTL_MS || !cache.body) {
    const stores = (await everyStore()).filter((s) => !s.isDefault && s.status === 'live' && s.discoverable);
    const rows = [];
    for (const s of stores) {
      const plans = (await plansOf(s).catch(() => [])).filter((p) => p.active !== false);
      if (!plans.length) continue; // nothing to buy = nothing to list
      const guild = await getGuild(s.guildId).catch(() => null);
      // Same resolution the storefront uses: an uploaded banner wins over a
      // pasted link and is served from /api/img. Reading the raw column here
      // meant every uploaded banner showed as no banner in the directory.
      const banner = await bannerFor(s);
      rows.push({
        slug: s.slug,
        name: s.name,
        description: s.description ?? null,
        category: s.category ?? null,
        iconUrl: guildIconUrl(guild),
        bannerUrl: banner.url,
        bannerKind: banner.kind,
        accent: s.theme?.accent ?? null,
        products: plans.length,
        fromUsd: Math.min(...plans.map((p) => p.priceUsd)),
        members: await countLiveMembers([s.id]),
        createdAt: s.createdAt ?? null,
      });
    }
    rows.sort((a, b) => b.members - a.members || (b.createdAt ?? 0) - (a.createdAt ?? 0));
    cache.at = Date.now();
    cache.body = { stores: rows };
  }
  res.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=600');
  sendJson(res, 200, cache.body);
});
