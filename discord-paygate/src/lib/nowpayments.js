// NOWPayments — the crypto rail.
// ============================================================================
//
// THE ONE RULE: Dues never holds funds, and neither does its account.
//
// Confirmed against the live dashboard (28 Aug 2026):
//
//   Custody                    ENABLED — it could NOT be switched off yet.
//                              The confirm dialog refuses while the payout
//                              wallet list is empty, and it is empty. So the
//                              account today WOULD hold funds if a payment
//                              were created without a payout address.
//   Payout wallet list         empty
//   Payment covering           2%   (a deposit within 2% of the price is
//                                    auto-finished by NOWPayments itself)
//   Short-payment default      Partially Paid
//   Withdrawal fee             paid by Receiver (the seller nets the payout
//                                    minus the on-chain fee)
//   Wrong-asset auto-process   ON   (a buyer who sends the wrong coin to the
//                                    invoice address has it converted at the
//                                    current rate instead of bounced)
//
// Two consequences run through this whole file:
//
//   1. `payout_address` is a precondition, not an option. createPayment throws
//      rather than build a request without one. A missing wallet must fail
//      loudly at checkout, where it is a configuration error the seller can
//      fix, and never quietly at settlement, where it is money sitting in
//      someone else's account. Custody-off is the target state; until then
//      the per-payment payout address is what keeps the guarantee true.
//
//   2. NOTHING here reads the account balance. No /balance, no payout-from-
//      balance, no "do we have funds" check. The balance is required to be
//      irrelevant: every code path works identically whether it is zero,
//      non-zero, or the endpoint does not answer at all. That is what makes
//      switching custody off later a no-op for this code.
//
// Docs: https://documenter.getpostman.com/view/7907941/2s93JusNJt

import crypto from 'node:crypto';
import { config } from '../config.js';
import { normalize as normalizeCurrency, formatAmount } from './currency.js';

const api = () => config.nowpayments.apiBase;

async function npFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${api()}${path}`, {
    method,
    headers: {
      'x-api-key': config.nowpayments.apiKey,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`nowpayments: ${method} ${path} failed with ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

// ── signature ───────────────────────────────────────────────────────────────

// NOWPayments does NOT sign the raw bytes. It signs a re-serialisation of the
// payload with its keys sorted, so the body must be parsed, sorted and
// stringified again before the HMAC can be computed. That makes verification
// sensitive to how the object is rebuilt, which is why the sort is recursive:
// a nested object left in its original key order produces a different string
// and a signature that never matches.
//
// JSON.stringify(value, replacerArray) only filters TOP-LEVEL keys, so the
// documented one-liner is wrong for nested payloads. This walks the structure.
export function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${sortedJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function verifyIpnSignature(parsedBody, header) {
  if (!header || !config.nowpayments.ipnSecret) return false;
  const expected = Buffer.from(
    crypto.createHmac('sha512', config.nowpayments.ipnSecret).update(sortedJson(parsedBody)).digest('hex'),
  );
  const got = Buffer.from(String(header).trim());
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

// ── coins ───────────────────────────────────────────────────────────────────

// Never hardcoded. Which coins are enabled is a per-merchant setting that can
// change in the dashboard without a deploy, so the list is read live and only
// ORDERED here.
//
// The ordering is not cosmetic. A payout is an on-chain transfer whose gas is
// flat, so on an expensive chain it can cost more than a small membership is
// worth — cheap chains first is what keeps a $10 sale from losing money to
// its own settlement.
const CHAIN_RANK = [
  ['sol', 'trx', 'usdtsol', 'usdcsol', 'usdttrc20', 'usdcmatic', 'matic', 'usdtmatic', 'base', 'usdcbase'],
  ['bnb', 'usdtbsc', 'usdcbsc', 'ltc', 'doge', 'xrp', 'ada', 'algo'],
  ['btc', 'eth', 'usdterc20', 'usdcerc20', 'dai'],
];
const rankOf = (t) => {
  const i = CHAIN_RANK.findIndex((tier) => tier.includes(t));
  return i === -1 ? CHAIN_RANK.length : i;
};

let coinCache = null;
export function invalidateCoinCache() { coinCache = null; }

export async function merchantCoins() {
  const at = Date.now();
  if (coinCache && at - coinCache.at < 5 * 60_000) return coinCache.promise;
  const promise = (async () => {
    const out = await npFetch('/merchant/coins');
    const list = (out?.selectedCurrencies ?? out?.currencies ?? [])
      .map((c) => String(c).toLowerCase());
    return list
      .map((ticker, i) => ({ ticker, rank: rankOf(ticker), seen: i }))
      .sort((a, b) => a.rank - b.rank || a.seen - b.seen)
      .map((c) => c.ticker);
  })();
  coinCache = { at, promise };
  // An empty list is answered but never remembered. It is what a response
  // of an unexpected shape decodes to, and what a dashboard with every coin
  // toggled off returns — either way the next request should ask again
  // rather than refuse every coin for five minutes.
  promise.then((list) => { if (!list.length && coinCache?.promise === promise) coinCache = null; }, () => { coinCache = null; });
  return promise;
}

// Is this address one NOWPayments can actually send `currency` to?
//
// There is no endpoint that lists the coins payouts can settle in — only
// the deposit list (/merchant/coins), which answers a different question.
// This is the provider's own check for the exact pair the seller is about
// to save: a coin it cannot pay out in fails here the same way a malformed
// address does. The success body is a bare "OK", not JSON, so this does not
// go through npFetch.
//
// Returns { ok: true } or { ok: false, message } — and THROWS when the
// provider could not be asked at all, so the caller can tell "no" from
// "unknown" and treat only the latter as advisory.
export async function validatePayoutAddress({ address, currency, extraId = null }) {
  const res = await fetch(`${api()}/payout/validate-address`, {
    method: 'POST',
    headers: { 'x-api-key': config.nowpayments.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ address, currency: String(currency).toLowerCase(), extra_id: extraId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return { ok: true };
  const detail = await res.text().catch(() => '');
  if (res.status === 400) {
    let message = detail;
    try { message = JSON.parse(detail)?.message ?? detail; } catch { /* plain text */ }
    return { ok: false, message: String(message).slice(0, 300) };
  }
  throw new Error(`nowpayments: POST /payout/validate-address failed with ${res.status}: ${detail.slice(0, 300)}`);
}

export const minimumFor = (from, to) =>
  npFetch(`/min-amount?currency_from=${encodeURIComponent(from)}&currency_to=${encodeURIComponent(to)}`);

export const estimate = (amount, from, to) =>
  npFetch(`/estimate?amount=${amount}&currency_from=${encodeURIComponent(from)}&currency_to=${encodeURIComponent(to)}`);

// ── the invoice ─────────────────────────────────────────────────────────────

// The dashboard does have an IPN callback field, but the callback is set
// per-request anyway: the API's own IPN instructions say to pass
// ipn_callback_url on create_payment, and a URL that ships with the code
// cannot be left pointing at a dead deploy by whoever last edited a dashboard
// this code never reads.
export function ipnCallbackUrl() {
  return `${config.publicBaseUrl.replace(/\/$/, '')}/api/webhooks/nowpayments`;
}

export async function createPayment({ plan, store, amount, payCurrency, orderId }) {
  const payout = String(store?.cryptoWallet ?? '').trim();
  if (!payout) {
    // See the note at the top of this file. This is the custody guard and it
    // is deliberately an exception rather than a fallback.
    throw new Error('nowpayments: refusing to create a payment with no payout address — funds would settle into the platform balance');
  }
  const payoutChain = String(store?.cryptoChain ?? '').trim().toLowerCase();
  if (!payoutChain) {
    // The chain is part of the same guarantee. An address without a chain
    // is not "pay them in whatever the buyer chose": that sends BTC to a
    // Solana address, which is the one outcome worse than custody.
    throw new Error('nowpayments: refusing to create a payment with a payout address but no payout chain');
  }
  const currency = normalizeCurrency(plan.currency);
  const body = {
    price_amount: Number(amount ?? plan.priceUsd),
    price_currency: currency,
    pay_currency: String(payCurrency).toLowerCase(),
    // Where the money actually goes. Without this the account's Custody
    // setting keeps it.
    payout_address: payout,
    // The coin the SELLER is paid in, which is a property of their wallet —
    // not of whatever the buyer chose to send. A seller with a Solana wallet
    // is paid in SOL whether the buyer paid in BTC or USDT.
    payout_currency: payoutChain,
    order_id: orderId,
    order_description: `${plan.name} — ${store?.name ?? config.brand}`,
    ipn_callback_url: ipnCallbackUrl(),
    // Locks the exchange rate for the invoice window, so a buyer who takes
    // ten minutes to send does not land short because the coin moved.
    is_fixed_rate: true,
    // The buyer covers the service fee. The seller still absorbs the on-chain
    // payout fee — the account is set to "withdrawal fee paid by Receiver" —
    // which is exactly why cheap chains are ranked first above.
    is_fee_paid_by_user: true,
  };
  return npFetch('/payment', { method: 'POST', body });
}

export const getPayment = (id) => npFetch(`/payment/${encodeURIComponent(id)}`);

// Recon reads PAYMENTS, never the balance: this is the list of what was
// forwarded, not of what is being held. (See rule 2 at the top.)
export const listPayments = ({ limit = 100, page = 0 } = {}) =>
  npFetch(`/payment/?limit=${Number(limit)}&page=${Number(page)}&sortBy=created_at&orderBy=desc`);

// ── payment status ──────────────────────────────────────────────────────────

// Access is granted on `finished` and on nothing else.
//
// That single rule is what makes the two awkward account settings harmless:
//
//   • Payment covering 2% — a deposit within 2% of the price is finished by
//     NOWPayments itself. The tolerance is deliberately NOT re-implemented
//     here; trusting their status means the day Fintan changes 2% to 5% this
//     code already agrees with the dashboard instead of contradicting it.
//   • Short-payment default Partially Paid — an underpayment outside that
//     tolerance arrives as `partially_paid`, which is a buyer who still owes
//     money, not a sale.
//
// `confirming` is a mempool sighting and `sending` is the forward in flight.
// Both are states to SHOW, never states to unlock a paid role on.
export const GRANTS_ACCESS = new Set(['finished']);
export const IN_FLIGHT = new Set(['waiting', 'confirming', 'confirmed', 'sending']);
export const SHORT = new Set(['partially_paid']);
// `cancelled` is not in the API reference's list of nine statuses. The
// provider's own status article is where it lives: a merchant can mark a
// partially_paid payment cancelled to tell the buyer to get in touch, and
// NOWPayments' Node SDK maps both spellings of it. It is terminal and it is
// not a sale. Left unrecognised it was the one dead payment whose screen kept
// saying "Checking on this payment…", and whose seat the backfill never
// released until the seven-day window dropped it.
// https://nowpayments.zendesk.com/hc/en-us/articles/18395434917149-Payment-statuses
export const DEAD = new Set(['failed', 'refunded', 'expired', 'cancelled', 'canceled']);

// Mirrors the dashboard's "Payment covering" setting. Used ONLY for wording
// and for recon logging — never to decide whether something is paid.
export const COVERING_TOLERANCE = 0.02;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// What actually landed, expressed in the ORDER's own fiat currency, or null
// when nothing here can say.
//
// Wrong-asset auto-processing is ON, so the coin that arrives is not
// necessarily `pay_currency`: a buyer who sends the wrong token to the
// invoice address has it converted at the current rate and credited anyway.
// That makes `actually_paid` — denominated in the coin the invoice ASKED for —
// the wrong thing to reason about on its own. `actually_paid_at_fiat` is the
// value of what genuinely arrived, and it is the ONLY field that says so.
//
// There used to be a ratio fallback, `(actually_paid / pay_amount) * price`,
// for payments that arrive without it. That is the wrong-asset assumption
// spelled out — the very assumption paidInRequestedCoin below refuses to make
// on the same evidence — so it turned an unknown into a precise-looking
// dollar figure and put it in front of the buyer. One rule, one answer: no
// fiat figure, no number quoted.
export function settledFiat(p) {
  const atFiat = num(p?.actually_paid_at_fiat);
  return atFiat > 0 ? atFiat : null;
}

// True when the deposit is denominated in the coin the invoice asked for.
// A false here means "do not quote them a figure in pay_currency" — telling
// someone who paid in ETH to send more SOL is worse than saying nothing.
//
// It takes evidence to answer true. `actually_paid_at_fiat` is the only
// field that says what the deposit was worth independently of the coin the
// invoice asked for; without it, "nothing contradicts it" is also "nothing
// supports it", and the wrong-asset case — the one this exists for — is
// exactly the one that arrives without a fiat figure to contradict.
export function paidInRequestedCoin(p) {
  const atFiat = num(p?.actually_paid_at_fiat);
  const paid = num(p?.actually_paid);
  const asked = num(p?.pay_amount);
  const price = num(p?.price_amount);
  if (paid <= 0 || asked <= 0 || price <= 0) return false;
  if (atFiat <= 0) return false; // no evidence either way — say nothing
  // If the fiat value of the deposit disagrees with what that many units of
  // pay_currency would be worth, a different asset arrived and was converted.
  const impliedFiat = (paid / asked) * price;
  return Math.abs(impliedFiat - atFiat) <= Math.max(0.01, impliedFiat * 0.05);
}

export function describeStatus(p, { currency } = {}) {
  const s = String(p?.payment_status ?? '').toLowerCase();
  if (GRANTS_ACCESS.has(s)) return { state: 'paid', message: 'Payment confirmed.' };
  if (SHORT.has(s)) {
    const cur = normalizeCurrency(currency ?? p?.price_currency ?? 'usd');
    const settled = settledFiat(p);
    const owedFiat = settled === null ? 0 : Math.max(0, num(p?.price_amount) - settled);
    // The shortfall is quoted in the order's own money, because that figure
    // is true no matter which coin actually turned up — but only when the
    // provider said what the deposit was worth. Without that there is no
    // shortfall to quote in any unit, so the wording below carries none. The
    // coin amount is added only when the deposit really was in the coin they
    // picked.
    if (owedFiat > 0) {
      const coin = String(p?.pay_currency ?? '').toUpperCase();
      const owedCoin = Math.max(0, num(p?.pay_amount) - num(p?.actually_paid));
      const inCoin = paidInRequestedCoin(p) && owedCoin > 0
        ? ` (about ${trimCoin(owedCoin)} ${coin})`
        : '';
      return {
        state: 'short',
        message: `Underpaid — ${formatAmount(owedFiat, cur)} of this order is still outstanding${inCoin}. Send the difference to the same address to complete it.`,
      };
    }
    return { state: 'short', message: 'Underpaid — the amount received was below the order total. Send the difference to the same address to complete it.' };
  }
  if (IN_FLIGHT.has(s)) return { state: 'pending', message: 'Confirming on-chain…' };
  if (DEAD.has(s)) return { state: 'dead', message: 'This payment did not complete.' };
  // A status none of the sets know (or none at all) is not an on-chain
  // confirmation in progress — claiming one would tell the buyer the money
  // is on its way when nothing here knows that. Neutral wording, still
  // polled; the webhook side logs the status so it can be found.
  return { state: 'pending', message: 'Checking on this payment…' };
}

// Crypto amounts are long and mostly zeros; 8 significant decimals is the
// most any chain here needs and trailing noise only makes it harder to copy.
function trimCoin(n) {
  return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}
