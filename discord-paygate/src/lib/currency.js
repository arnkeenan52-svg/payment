// Currency facts, all of them taken from Stripe's own documentation rather than
// from memory — getting any of this wrong charges a buyer the wrong amount.
//
//   https://docs.stripe.com/currencies
//   https://docs.stripe.com/payments/currencies/localize-prices
//
// The rule that matters: the Stripe API always wants amounts in the currency's
// MINOR unit. For most currencies that is amount × 100. For the zero-decimal
// currencies below it is amount × 1 — sending ¥1500 as 150000 charges a buyer
// a hundred times the sticker price, and nothing in the API rejects it.

// Every presentment currency Stripe lists for card payments (133 of them).
// Local payment methods are narrower: iDEAL is EUR-only, BLIK is PLN-only.
export const CURRENCIES = [
  'aed', 'afn', 'amd', 'ang', 'aoa', 'ars', 'aud', 'awg', 'azn', 'bam', 'bbd', 'bdt',
  'bif', 'bmd', 'bnd', 'bob', 'brl', 'bsd', 'bwp', 'byn', 'bzd', 'cad', 'cdf', 'chf',
  'clp', 'cny', 'cop', 'crc', 'cve', 'czk', 'djf', 'dkk', 'dop', 'dzd', 'egp', 'etb',
  'eur', 'fjd', 'fkp', 'gbp', 'gel', 'gip', 'gmd', 'gnf', 'gtq', 'gyd', 'hkd', 'hnl',
  'htg', 'huf', 'idr', 'ils', 'inr', 'isk', 'jmd', 'jpy', 'kes', 'kgs', 'khr', 'kmf',
  'krw', 'kyd', 'kzt', 'lak', 'lbp', 'lkr', 'lrd', 'lsl', 'mad', 'mdl', 'mga', 'mkd',
  'mmk', 'mnt', 'mop', 'mur', 'mvr', 'mwk', 'mxn', 'myr', 'mzn', 'nad', 'ngn', 'nio',
  'nok', 'npr', 'nzd', 'pab', 'pen', 'pgk', 'php', 'pkr', 'pln', 'pyg', 'qar', 'ron',
  'rsd', 'rub', 'rwf', 'sar', 'sbd', 'scr', 'sek', 'sgd', 'shp', 'sle', 'sos', 'srd',
  'std', 'szl', 'thb', 'tjs', 'top', 'try', 'ttd', 'twd', 'tzs', 'uah', 'ugx', 'usd',
  'uyu', 'uzs', 'vnd', 'vuv', 'wst', 'xaf', 'xcd', 'xcg', 'xof', 'xpf', 'yer', 'zar',
  'zmw',
];

const SUPPORTED = new Set(CURRENCIES);

// "For the following zero-decimal currencies, the charge and the amount are the
// same, without requiring multiplication." — the amount goes to Stripe as-is.
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

// ISK and UGX are the trap. Both are zero-decimal in the real world — you cannot
// charge a fraction of either — but Stripe's docs require them sent as a
// two-decimal value whose minor part is always 00: "to charge 5 ISK, provide an
// amount value of 500". So they multiply by 100 like everyone else, yet must be
// entered and displayed as whole units.
const WHOLE_UNITS_X100 = new Set(['isk', 'ugx']);

// HUF and TWD are deliberately absent: Stripe treats them as zero-decimal for
// PAYOUTS only, and accepts ordinary two-decimal charges. Dues never creates a
// payout, so on the charge path they are unremarkable two-decimal currencies.

export const isSupported = (c) => SUPPORTED.has(String(c ?? '').toLowerCase());

export const normalize = (c) => {
  const low = String(c ?? '').trim().toLowerCase();
  return SUPPORTED.has(low) ? low : 'usd';
};

// How much to multiply a human-facing amount by to reach Stripe's minor unit.
export const minorFactor = (c) => (ZERO_DECIMAL.has(normalize(c)) ? 1 : 100);

// How many decimal places a seller may type, and a buyer should see. Note this
// is NOT log10(minorFactor): ISK has a factor of 100 and zero decimals.
export const decimals = (c) => {
  const cur = normalize(c);
  return ZERO_DECIMAL.has(cur) || WHOLE_UNITS_X100.has(cur) ? 0 : 2;
};

// Major → minor. Rounds to the currency's own precision FIRST, so a stray
// 1500.4 JPY cannot smuggle a fraction into an integer field.
export const toMinor = (amount, c) => {
  const cur = normalize(c);
  const dp = decimals(cur);
  const rounded = Math.round(Number(amount) * 10 ** dp) / 10 ** dp;
  return Math.round(rounded * minorFactor(cur));
};

// Minor → major, back through the same factor.
export const fromMinor = (minor, c) => Number(minor) / minorFactor(normalize(c));

// Round a typed amount to what the currency can actually express.
export const roundAmount = (amount, c) => {
  const dp = decimals(c);
  return Math.round(Number(amount) * 10 ** dp) / 10 ** dp;
};

// Stripe refuses charges below these, so the product form has to as well —
// otherwise the seller saves a price that fails at the buyer's checkout, which
// is the worst possible place to discover it. Major units, from the docs table.
// Currencies Stripe does not list a minimum for fall back to the USD 0.50 rule.
const MIN_CHARGE = {
  usd: 0.5, aed: 2, ars: 0.5, aud: 0.5, brl: 0.5, cad: 0.5, chf: 0.5, cop: 0.5,
  czk: 15, dkk: 2.5, eur: 0.5, gbp: 0.3, hkd: 4, huf: 175, idr: 0.5, ils: 0.5,
  inr: 0.5, jpy: 50, krw: 50, mxn: 10, myr: 2, nok: 3, nzd: 0.5, php: 0.5,
  pln: 2, ron: 2, rub: 0.5, sek: 3, sgd: 0.5, thb: 10, zar: 0.5,
};

export const minCharge = (c) => {
  const cur = normalize(c);
  if (MIN_CHARGE[cur] !== undefined) return MIN_CHARGE[cur];
  // No published minimum: hold the line at the smallest unit the currency has.
  return decimals(cur) === 0 ? 1 : 0.5;
};

// "8 digits for all other currencies, for a maximum charge of 999,999.99" —
// with wider ceilings for the three currencies Stripe calls out by name.
const MAX_MINOR = { idr: 999_999_999_999, cop: 9_999_999_999, inr: 999_999_999 };

export const maxCharge = (c) => {
  const cur = normalize(c);
  return (MAX_MINOR[cur] ?? 99_999_999) / minorFactor(cur);
};

// One place that decides whether a price is chargeable at all, so the product
// form, the API and the doctor cannot drift apart on the answer.
export function validateAmount(amount, c) {
  const cur = normalize(c);
  const n = Number(amount);
  if (!Number.isFinite(n)) return { ok: false, reason: 'not a number' };
  const rounded = roundAmount(n, cur);
  const lo = minCharge(cur);
  const hi = maxCharge(cur);
  if (rounded < lo) return { ok: false, reason: `below the ${cur.toUpperCase()} minimum of ${lo}`, min: lo };
  if (rounded > hi) return { ok: false, reason: `above the ${cur.toUpperCase()} maximum of ${hi}`, max: hi };
  return { ok: true, amount: rounded };
}

// Display. Intl knows every currency's symbol, placement and decimal count, so
// there is no table to keep in sync — and no reason to ever print a bare "$".
export function formatAmount(amount, c, locale = 'en-US') {
  const cur = normalize(c);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: cur.toUpperCase(),
      minimumFractionDigits: decimals(cur),
      maximumFractionDigits: decimals(cur),
    }).format(Number(amount));
  } catch {
    return `${cur.toUpperCase()} ${Number(amount).toFixed(decimals(cur))}`;
  }
}
