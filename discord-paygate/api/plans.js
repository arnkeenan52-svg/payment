import { config, capabilities } from '../src/config.js';
import { sendJson } from '../src/lib/http.js';

export default function handler(req, res) {
  sendJson(res, 200, {
    brand: config.brand,
    // Guild id is public (it's in every invite link); the receipt page needs
    // it for the "Open on Discord" deep link.
    server: { name: config.discord.guildName, guildId: config.discord.guildId },
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
