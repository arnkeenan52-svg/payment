// Seed a throwaway database with a store that looks like a real one, so the
// hero tour can be recorded against the actual dashboard rather than a mock.
//
// Deterministic on purpose: a seeded PRNG, not Math.random, so re-recording a
// scene months from now produces the same chart shape and the same numbers. A
// hero tour whose revenue graph changes between takes cannot be re-cut.
//
// Goes through db.js's own exported helpers rather than raw SQL, so the seed
// cannot drift from the schema or from how the app actually writes these rows.
//
//   DB_PATH=/tmp/hero.sqlite node scripts/seed-demo.mjs
import * as db from '../src/db.js';

const OWNER = process.env.SEED_OWNER_ID || '410000000000000001';
const GUILD = process.env.SEED_GUILD_ID || '420000000000000001';
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

// xorshift32: tiny, deterministic, good enough for a plausible sales curve.
let s = 0x2f6e2b1;
const rnd = () => {
  s ^= s << 13; s >>>= 0;
  s ^= s >> 17;
  s ^= s << 5; s >>>= 0;
  return s / 0x100000000;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];

const PRODUCTS = [
  { key: 'vip', name: 'VIP Access', price: 49.99, lifetime: true, weight: 34, role: 'VIP' },
  { key: 'signals', name: 'Signals Monthly', price: 14.99, lifetime: false, days: 30, weight: 52, role: 'Signals' },
  { key: 'inner', name: 'Inner Circle', price: 79.99, lifetime: true, weight: 14, role: 'Inner Circle' },
];
const NAMES = ['halo', 'cosmo', 'luna', 'vega', 'sirius', 'rigel', 'atlas', 'orion', 'nova', 'lyra', 'draco', 'phoenix', 'aurora', 'zenith', 'echo'];

await db.ensureSchema();

// The owner needs an access_token or the dashboard's server picker answers 428
// ("sign in again") and the tour never reaches a store. The value is never
// used against real Discord — scripts/hero-mock-discord.mjs answers instead.
await db.upsertUser({ discordId: OWNER, username: 'duesq', accessToken: 'seed-access-token', refreshToken: 'seed-refresh-token' });

const store = await db.createStore({
  slug: 'dues-membership',
  name: 'Dues Membership',
  ownerDiscordId: OWNER,
  guildId: GUILD,
  stripeSecretEnc: null,
  status: 'live',
});
const storeId = store.id ?? store;

await db.updateStore(storeId, {
  description: 'Premium roles, private channels and member-only drops.',
  discoverable: 1,
  category: 'trading',
});

for (const [i, p] of PRODUCTS.entries()) {
  await db.createStorePlan({
    storeId,
    planKey: p.key,
    name: p.name,
    description: `Everything in ${p.name}.`,
    imageUrl: null,
    priceUsd: p.price,
    lifetime: p.lifetime ? 1 : 0,
    durationDays: p.days ?? null,
    stripePriceId: `price_seed_${p.key}`,
    variantOf: null,
  });
  await db.setStorePlanRoles(storeId, p.key, [`90000000000000${i + 1}`], [p.role]);
}

// 145 completed sales across 90 days, weighted so the most recent 30 hold 68
// of them — the growth curve the Overview chart exists to show. Plus a handful
// of abandoned checkouts, or the conversion stat reads a suspicious 100%.
const weighted = PRODUCTS.flatMap((p) => Array(p.weight).fill(p));
let n = 0;

async function sale(fromDay, toDay) {
  const p = pick(weighted);
  const at = now - Math.floor((fromDay + rnd() * (toDay - fromDay)) * DAY);
  n += 1;
  const discordId = String(500000000000000000n + BigInt(n) * 7919n);
  await db.upsertUser({ discordId, username: `${pick(NAMES)}${100 + (n % 99)}` });
  await db.recordCheckoutAttempt({ storeId, planId: p.key, discordId, sessionId: `cs_seed_${n}`, amountUsd: p.price });
  await db.markCheckoutCompleted(`cs_seed_${n}`, at);
  await db.upsertSubscription({
    discordId,
    planId: p.key,
    provider: 'stripe',
    providerRef: `sub_seed_${n}`,
    status: 'active',
    currentPeriodEnd: p.lifetime ? null : at + (p.days ?? 30) * DAY,
    storeId,
    paidUsd: p.price,
  });
}

for (let i = 0; i < 77; i += 1) await sale(30, 90); // the older two thirds
for (let i = 0; i < 68; i += 1) await sale(0, 30); // the last 30 days
for (let i = 0; i < 11; i += 1) {
  await db.recordCheckoutAttempt({
    storeId, planId: 'signals', discordId: `6${i}00000000000000`, sessionId: `cs_drop_${i}`, amountUsd: 14.99,
  });
}

await db.createDiscount({ storeId, code: 'LAUNCH20', kind: 'percent', amount: 20 });

console.log(`[seed] store ${storeId} "Dues Membership" · ${n} members · ${PRODUCTS.length} products · 1 discount`);
console.log(`[seed] owner ${OWNER} · guild ${GUILD} · db ${process.env.DB_PATH ?? '(default)'}`);
