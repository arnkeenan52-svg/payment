import { grant } from './entitlements.js';

// Grants on charge:confirmed and charge:resolved. charge:pending is only a
// mempool sighting — never grant on it. Crypto can't auto-renew, so a grant
// is a fixed term of the plan's duration (lifetime plans stay lifetime).
// Dormant unless Coinbase credentials are configured (see capabilities()).
export async function processCoinbaseEvent(event) {
  if (event.type !== 'charge:confirmed' && event.type !== 'charge:resolved') return;
  const charge = event.data ?? {};
  const discordId = charge.metadata?.discord_id;
  const planId = charge.metadata?.plan_id;
  if (!discordId || !planId) {
    console.warn(`[webhooks] coinbase ${event.id}: charge without discord_id/plan_id metadata, ignoring`);
    return;
  }
  // periodEnd stays null → grant() applies the plan's own fixed duration
  // (or NULL expiry when the plan is lifetime).
  await grant({
    discordId,
    planId,
    provider: 'coinbase',
    providerRef: charge.code ?? charge.id,
    periodEnd: null,
  });
}
