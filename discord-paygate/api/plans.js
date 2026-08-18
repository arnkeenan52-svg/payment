import { config, capabilities } from '../src/config.js';
import { sendJson, guard } from '../src/lib/http.js';
import { getGuild, guildIconUrl } from '../src/lib/discord.js';
import { effectiveRoleMap } from '../src/services/plan-config.js';
import { storeBySlug, plansOf } from '../src/services/stores.js';

// The server's own identity fronts every checkout: name and icon come from
// the live guild lookup via the bot (animated icons surface as .gif).
// Cached per guild per warm instance. When nothing real is known the name is
// null — the client hides it rather than showing filler.
const guildCache = new Map(); // guildId -> { at, name, iconUrl }
const GUILD_TTL_MS = 5 * 60 * 1000;

async function serverInfo(guildId, nameOverride = null) {
  const cached = guildCache.get(guildId);
  if (cached && Date.now() - cached.at < GUILD_TTL_MS) return cached;
  const guild = await getGuild(guildId);
  const info = {
    at: Date.now(),
    name: nameOverride || guild?.name || null,
    iconUrl: guildIconUrl(guild),
  };
  guildCache.set(guildId, info);
  return info;
}

export default guard(async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const store = await storeBySlug(url.searchParams.get('store') ?? '');
  if (!store) {
    sendJson(res, 404, { error: 'unknown store' });
    return;
  }
  const { name, iconUrl } = await serverInfo(store.guildId, store.isDefault ? config.discord.guildName : store.name);
  const roleMap = store.isDefault ? await effectiveRoleMap() : null;
  const plans = await plansOf(store);
  sendJson(res, 200, {
    brand: store.isDefault ? config.brand : store.name,
    platform: { name: config.platform },
    store: { slug: store.slug, status: store.status },
    // Guild id is public (it's in every invite link); the receipt page needs
    // it for the "Open on Discord" deep link.
    server: { name, guildId: store.guildId, iconUrl },
    capabilities: store.isDefault ? capabilities() : { stripe: Boolean(store.stripeKey), crypto: false },
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      priceUsd: p.priceUsd,
      interval: p.interval,
      lifetime: Boolean(p.lifetime),
      imageUrl: p.imageUrl ?? null,
      roleNames: (roleMap ? roleMap.get(p.id)?.roleNames : null) ?? p.roleNames ?? [],
      descriptionHighlight: p.descriptionHighlight ?? null,
    })),
  });
});
