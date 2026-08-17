import { config, capabilities } from '../src/config.js';
import { sendJson, guard } from '../src/lib/http.js';
import { getGuild, guildIconUrl } from '../src/lib/discord.js';

// The server's own identity fronts the checkout: name and icon come from the
// live guild lookup via the bot (animated icons surface as .gif). Cached per
// warm instance. DISCORD_GUILD_NAME only overrides; when nothing real is
// known the name is null — the client hides it rather than showing filler.
let guildCache = null; // { at, name, iconUrl }
const GUILD_TTL_MS = 5 * 60 * 1000;

async function serverInfo() {
  if (guildCache && Date.now() - guildCache.at < GUILD_TTL_MS) return guildCache;
  const guild = await getGuild();
  guildCache = {
    at: Date.now(),
    name: config.discord.guildName || guild?.name || null,
    iconUrl: guildIconUrl(guild),
  };
  return guildCache;
}

export default guard(async function handler(req, res) {
  const { name, iconUrl } = await serverInfo();
  sendJson(res, 200, {
    brand: config.brand,
    platform: { name: config.platform },
    // Guild id is public (it's in every invite link); the receipt page needs
    // it for the "Open on Discord" deep link.
    server: { name, guildId: config.discord.guildId, iconUrl },
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
});
