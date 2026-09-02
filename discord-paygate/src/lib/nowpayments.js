// NOWPayments — the crypto rail.
// ============================================================================
//
// THE ONE RULE: Dues never holds funds, and neither does its account.
//
// Read from the live dashboard (28 Aug 2026). These are settings someone saw,
// not behaviour anyone has watched money go through:
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
// WHAT THE PROVIDER'S OWN DOCUMENTATION SAYS, AND WHAT IT DOES NOT.
//
// It says settlement is a transfer OUT to a wallet: `sending` is "the funds
// are being sent to your personal wallet", `finished` is "the funds have
// reached your personal address", and the fees page describes the
// non-custodial flow as "we process the payment, charge the NOWPayments
// service fee, and make the payout to your wallet". So forwarding is the
// documented shape of a settled payment, with no second call to make.
//
// It does NOT document `payout_address` on POST /payment. The create-payment
// field list defines `payout_currency` as "currency of your external
// payout_address, required when payout_adress is specified" and
// `payout_extra_id` as "extra id or memo or tag for external payout_address"
// — two fields that exist only to describe a third the docs never define.
// The help centre's own endpoint reference omits all three. Every claim below
// about a PER-PAYMENT payout address is therefore inference from those two
// references, not a documented guarantee, and NOTHING in this repo has ever
// watched a real coin arrive at a seller's wallet. What is documented, in the
// same breath, is that the account's own settlement target is a single
// account-level payout wallet per currency ("the address for withdrawal is
// the same as the wallet address designated as the 'Payout wallet'") and that
// the Mass Payouts API refuses any address that is not whitelisted, a request
// that "takes up to 24-48 hours". If the payment-level field turns out to be
// subject to that same whitelist, per-seller forwarding cannot work at all.
// See the open question at the top of README's crypto section.
//
// Two consequences run through this whole file:
//
//   1. `payout_address` is a precondition, not an option. createPayment throws
//      rather than build a request without one. A missing wallet must fail
//      loudly at checkout, where it is a configuration error the seller can
//      fix, and never quietly at settlement, where it is money sitting in
//      someone else's account. Custody-off is the target state; until then
//      the per-payment payout address is what keeps the guarantee true — IF
//      it is honoured, which is the sentence above.
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

// The minimum is per PAIR and per FLOW. Their docs say the flow flags
// "allows you to see current minimum amounts for corresponsing flows (it may
// differ from the standard flow!)", and their fees page is blunter: "the
// minimum amounts you see on the status page are calculated for standard rate
// payments only! Fixed-rate minimum amounts are usually higher." createPayment
// below sends both flags, so asking without them quotes a floor the payment
// would not actually accept — and the one caller uses this figure to tell a
// buyer which coin to pick instead.
export const minimumFor = (from, to) =>
  npFetch(
    `/min-amount?currency_from=${encodeURIComponent(from)}&currency_to=${encodeURIComponent(to)}` +
      '&is_fixed_rate=true&is_fee_paid_by_user=true',
  );

export const estimate = (amount, from, to) =>
  npFetch(`/estimate?amount=${amount}&currency_from=${encodeURIComponent(from)}&currency_to=${encodeURIComponent(to)}`);

// ── the invoice ─────────────────────────────────────────────────────────────

// There is no IPN URL field in the NOWPayments dashboard, so the callback is
// per-request: every create carries its own ipn_callback_url or the payment
// completes and nothing is ever told about it.
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
    // Locks the exchange rate so the quoted coin amount cannot drift out from
    // under a buyer mid-payment. It BUYS THAT WITH TIME: their docs say "the
    // rate of exchange will be frozen for 10 minutes. If there are no incoming
    // payments during this period, the payment status changes to 'expired'" —
    // against the 7-day window a floating-rate payment gets. And "no callbacks
    // are sent after a payment expires. Deposits can still be received, but
    // they will not trigger any further IPN callbacks."
    is_fixed_rate: true,
    // The buyer covers the service fee ("it allows you to transfer all
    // commissions on payment to your customer"). It is not independent of the
    // line above: "the fee-paid-by-user option always assumes fixed rate and
    // cannot be activated for regular rate" — set alone it would turn
    // is_fixed_rate on anyway. The seller still absorbs the on-chain payout
    // fee — the account is set to "withdrawal fee paid by Receiver" — which is
    // exactly why cheap chains are ranked first above.
    is_fee_paid_by_user: true,
  };
  return npFetch('/payment', { method: 'POST', body });
}

export const getPayment = (id) => npFetch(`/payment/${encodeURIComponent(id)}`);

// Recon reads PAYMENTS, never the balance: this is the list of what was
// forwarded, not of what is being held. (See rule 2 at the top.)
//
// UNUSED, and it would 403 if it were called: their docs put this endpoint
// behind a JWT ("required for using 'Get list of payments' and 'Create
// payout'"), obtained from POST /v1/auth with the DASHBOARD EMAIL AND
// PASSWORD and valid for five minutes. Dues holds neither credential and
// should not: the backfill asks about the payment ids it already recorded,
// one lookup each, which needs only the API key.
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
export const DEAD = new Set(['failed', 'refunded', 'expired']);

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
