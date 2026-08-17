import { config, capabilities } from '../src/config.js';
import { sendJson } from '../src/lib/http.js';
import { getGuild, guildIconUrl } from '../src/lib/discord.js';

// The server's own icon (animated GIF when the guild has one) fronts the
// checkout. Resolved via the bot and cached per warm instance so storefront
// traffic doesn't hammer Discord; null lets the client fall back to /logo.png.
let iconCache = null; // { at, url }
const ICON_TTL_MS = 5 * 60 * 1000;

async function serverIconUrl() {
  if (iconCache && Date.now() - iconCache.at < ICON_TTL_MS) return iconCache.url;
  const url = guildIconUrl(await getGuild());
  iconCache = { at: Date.now(), url };
  return url;
}

export default async function handler(req, res) {
  sendJson(res, 200, {
    brand: config.brand,
    platform: { name: config.platform },
    // Guild id is public (it's in every invite link); the receipt page needs
    // it for the "Open on Discord" deep link.
    server: {
      name: config.discord.guildName,
      guildId: config.discord.guildId,
      iconUrl: await serverIconUrl(),
    },
    capabilities: capabilities(),
    plans: config.plans.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      priceUsd: p.priceUsd,
      interval: p.interval,
      lifetime: Boolean(p.lifetime),
      roleNames: p.roleNames ?? [],
      descriptionHighlight: p.descriptionHighlight ?? null,
    })),
  });
}
