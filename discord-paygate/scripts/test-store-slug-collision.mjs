// Regression test: the virtual built-in store must never shadow a real one.
//
// THE INCIDENT THIS PINS DOWN. The built-in store is virtual: it exists only
// when DISCORD_GUILD_ID is set, and it lives at slugify(BRAND). BRAND defaults
// to 'Tradeleaks' (src/config.js) — the name of the deployment's first tenant.
// So the day a guild id was first set on production (to let the bot post
// welcome cards), a virtual store materialised holding the slug 'tradeleaks',
// which a real, live, selling tenant store already owned.
//
// storeBySlug then rejected that real store as an "impostor" — its guild did
// not match the newly configured one — and served the env catalog instead.
// Buyers opening the tenant's link got the platform's own products; the owner's
// dashboard resolved the read-only twin and showed "this is the built-in store"
// where their products and discounts had been. Nothing was deleted; a real
// business was simply shadowed out of existence by a config change.
//
// The rule this test locks in: a managed row on ANOTHER guild is a real tenant
// that already holds the slug, and it wins outright. Squatting stays blocked at
// write time by isReservedSlug, which only ever applied to NEW claims.
//
//   node scripts/test-store-slug-collision.mjs
//
// Runs standalone rather than inside scripts/e2e-test.js because it needs its
// own BRAND / DISCORD_GUILD_ID, and config.js reads those once at import.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB = path.join(os.tmpdir(), `dues-slug-collision-${process.pid}.sqlite`);
process.env.DB_PATH = DB;
process.env.ENV_PATH = '/nonexistent/.env';
process.env.SESSION_SECRET = 'x'.repeat(32);
process.env.OWNER_DISCORD_ID = '410000000000000001';
// Production's exact shape: a guild id is set, and BRAND is left unset so it
// falls back to the legacy default that collides with the tenant's slug.
process.env.DISCORD_GUILD_ID = '1540823394172403904';
delete process.env.BRAND;

const OWNER = '410000000000000001';
const TENANT_GUILD = '999000111222333444'; // the tenant's own server — NOT the built-in guild

const db = await import('../src/db.js');
const stores = await import('../src/services/stores.js');
const { config } = await import('../src/config.js');

const fail = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail.push(label);
};

try {
  await db.ensureSchema();
  await db.upsertUser({ discordId: OWNER, username: 'owner', accessToken: 't', refreshToken: 'r' });

  const created = await db.createStore({
    slug: 'tradeleaks',
    name: 'Tradeleaks',
    ownerDiscordId: OWNER,
    guildId: TENANT_GUILD,
    stripeSecretEnc: null,
    status: 'live',
  });
  const storeId = created.id ?? created;
  await db.createStorePlan({
    storeId,
    planKey: 'vip',
    name: 'VIP Access',
    priceUsd: 49.99,
    lifetime: 1,
    roleNames: JSON.stringify(['VIP']),
    active: 1,
  });

  // The collision must actually be set up, or the rest proves nothing.
  check(stores.defaultSlug() === 'tradeleaks', 'the built-in slug collides with the tenant slug', `brand="${config.brand}"`);
  check(String(config.discord.guildId) !== TENANT_GUILD, 'the built-in guild differs from the tenant guild');

  const resolved = await stores.storeBySlug('tradeleaks');
  check(resolved?.isDefault === false && resolved?.id === storeId, 'buyers at the tenant link reach the TENANT store, not the built-in one');

  const sold = (await stores.sellablePlansOf(resolved)).map((p) => p.name);
  check(sold.includes('VIP Access'), "the tenant's own catalog is what sells", sold.join(', ') || 'nothing');

  const owned = await stores.storesOwnedBy(OWNER);
  check(owned.every((s) => !s.isDefault), 'the owner dashboard lists no phantom built-in twin', `${owned.length} store(s)`);
  check(new Set(owned.map((s) => s.slug)).size === owned.length, 'no two dashboard entries share a slug');

  const every = await stores.everyStore();
  check(every.every((s) => !s.isDefault), 'the platform-admin list drops the twin too', `${every.length} store(s)`);

  // The anti-squatting guard must still hold for NEW foreign claims.
  check(stores.isReservedSlug('tradeleaks', '777000111222333444') === true, 'a foreign store still cannot CLAIM the brand slug');
  check(stores.isReservedSlug('tradeleaks', config.discord.guildId) === false, "the built-in guild's own store may still hold it");
} finally {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { fs.unlinkSync(f); } catch { /* never existed */ }
  }
}

if (fail.length) {
  console.error(`\nFAILED (${fail.length}): the built-in store can still shadow a real one\n`);
  process.exit(1);
}
console.log('\nAll store-slug collision checks green.\n');
