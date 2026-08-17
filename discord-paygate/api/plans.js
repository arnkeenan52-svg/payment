import { config, capabilities } from '../src/config.js';
import { sendJson } from '../src/lib/http.js';

export default function handler(req, res) {
  sendJson(res, 200, {
    brand: config.brand,
    capabilities: capabilities(),
    plans: config.plans.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      priceUsd: p.priceUsd,
      interval: p.interval,
      lifetime: Boolean(p.lifetime),
    })),
  });
}
