import crypto from 'node:crypto';
import { config } from '../config.js';

// Coinbase Commerce signs the raw body with HMAC-SHA256 (hex) in the
// X-CC-Webhook-Signature header. Constant-time compare; the replay window is
// enforced separately against the signed event's created_at timestamp.
export function verifyCoinbaseSignature(rawBody, header) {
  if (!header) return false;
  const expected = Buffer.from(
    crypto.createHmac('sha256', config.coinbase.webhookSecret).update(rawBody).digest('hex'),
  );
  const got = Buffer.from(header.trim());
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

// created_at lives inside the signed payload, so a forged timestamp can't
// pass the HMAC — checking it kills replays of genuinely captured deliveries.
export function withinTolerance(createdAtIso, { now = Date.now() } = {}) {
  const ts = Date.parse(createdAtIso ?? '');
  if (Number.isNaN(ts)) return false;
  return Math.abs(now - ts) <= config.webhookToleranceSeconds * 1000;
}

export async function createCharge({ plan, discordId }) {
  const res = await fetch(`${config.coinbase.apiBase}/charges`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cc-api-key': config.coinbase.apiKey,
      'x-cc-version': '2018-03-22',
    },
    body: JSON.stringify({
      name: `${config.brand} — ${plan.name}`,
      description: plan.description,
      pricing_type: 'fixed_price',
      local_price: { amount: String(plan.priceUsd), currency: 'USD' },
      metadata: { discord_id: discordId, plan_id: plan.id },
      redirect_url: `${config.publicBaseUrl}/receipt?plan=${encodeURIComponent(plan.id)}`,
      cancel_url: `${config.publicBaseUrl}/?checkout=cancelled`,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`coinbase: create charge failed with ${res.status}: ${detail.slice(0, 300)}`);
  }
  return (await res.json()).data;
}
