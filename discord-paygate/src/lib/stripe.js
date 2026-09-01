import crypto from 'node:crypto';
import { config } from '../config.js';
import { toMinor, normalize as normalizeCurrency } from './currency.js';

// Verifies a `stripe-signature` header (format: t=<unix>,v1=<hex>[,v1=<hex>…])
// against the raw body. Constant-time compare, and the signed timestamp must
// be within the replay tolerance — a captured delivery is useless later.
export function verifyStripeSignature(rawBody, header, { now = Math.floor(Date.now() / 1000), secret = config.stripe.webhookSecret } = {}) {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const v1s = parts.filter(([k]) => k === 'v1').map(([, v]) => v).filter(Boolean);
  if (!t || !/^\d+$/.test(t) || v1s.length === 0) return false;

  if (Math.abs(now - Number(t)) > config.webhookToleranceSeconds) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.`)
    .update(rawBody)
    .digest('hex');
  const expectedBuf = Buffer.from(expected);
  return v1s.some((v1) => {
    const got = Buffer.from(v1);
    return got.length === expectedBuf.length && crypto.timingSafeEqual(got, expectedBuf);
  });
}

// ── Stripe REST (no SDK) ──────────────────────────────────────────────────────

// Stripe posts want application/x-www-form-urlencoded with bracket notation
// for nesting: { metadata: { plan_id: 'x' } } → metadata[plan_id]=x
function encodeForm(obj, prefix = '') {
  const pairs = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => pairs.push(...encodeForm({ [i]: v }, name)));
    } else if (typeof value === 'object') {
      pairs.push(...encodeForm(value, name));
    } else {
      pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    }
  }
  return pairs;
}

// Every request is pinned to one Stripe API version. Unpinned, each seller's
// account default applies, and Dues would be talking a different dialect to
// every store it serves. That is not merely untidy — before 2025-03-31.basil,
// a Checkout Session under Adaptive Pricing reported the BUYER's currency and
// converted amount in `currency`/`amount_total`, and from basil on it reports
// the seller's own. Unpinned, the same revenue row means different things on
// two seller accounts, and nothing in the response says which.
export const STRIPE_API_VERSION = '2025-03-31.basil';

export async function stripeFetch(path, { method = 'GET', form, key = config.stripe.secretKey } = {}) {
  const res = await fetch(`${config.stripe.apiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'stripe-version': STRIPE_API_VERSION,
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? encodeForm(form).join('&') : undefined,
    // The only provider client that had no timeout. A hung call ran the
    // webhook past Vercel's maxDuration, the idempotency claim stayed held,
    // and Stripe's retry of the same event found it already claimed — a
    // no-op. Bounded, the call fails, the claim is released, and the retry
    // does the work.
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`stripe: ${method} ${path} failed with ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

// ── API key shape ────────────────────────────────────────────────────────────
// Stripe now recommends restricted keys (rk_) over secret keys (sk_) for every
// new integration, so both are accepted everywhere a store owner supplies one.
// Liveness comes from the _live_ segment, never from the sk_ prefix: reading it
// off "sk_live_" alone silently files every rk_live_ store as a test store.

export const STRIPE_KEY_RE = /^(sk|rk)_(live|test)_[A-Za-z0-9]/;
export const isStripeKey = (key) => STRIPE_KEY_RE.test(String(key ?? '').trim());
export const stripeKeyMode = (key) => (/^(sk|rk)_live_/.test(String(key ?? '').trim()) ? 'live' : 'test');

// Exactly what Dues calls with a store's key. A restricted key missing any
// of these fails later with an opaque Stripe error, so the UI lists them and
// the onboarding check names the missing one.
export const STRIPE_KEY_PERMISSIONS = [
  ['Checkout Sessions', 'write', 'creating the checkout a buyer pays on'],
  ['Products', 'write', 'creating the product behind each plan'],
  ['Prices', 'write', 'creating the price for each plan'],
  ['Subscriptions', 'write', 'reading renewals, and cancelling when a buyer asks'],
  ['Coupons', 'write', 'applying your discount codes'],
  ['Webhook Endpoints', 'write', 'registering the endpoint that confirms payments'],
];

export const getSubscription = (id, key = config.stripe.secretKey) => stripeFetch(`/v1/subscriptions/${id}`, { key });

// ── price resolution ──────────────────────────────────────────────────────────

// The configured stripePriceId wins. When it does not exist on this account
// (wrong mode, wrong account, stale id), fall back to the newest ACTIVE price
// matching the plan's own terms: the plan's own currency, the exact amount,
// one-time for lifetime plans, or the plan's interval for recurring ones. The
// doctor surfaces the fallback as a warning so the owner can pin the real id.
//
// Matching on currency is not a nicety. Amounts are compared in MINOR units,
// and 1500 minor is ¥1500 but only $15.00 — without the currency filter a
// yen-priced plan would happily bind to a dollar price a hundredfold cheaper.
const PRICE_TTL_MS = 5 * 60_000;
const priceCache = new Map(); // planId -> { at, promise }

export function invalidatePriceCache() {
  priceCache.clear();
}

export function resolvePlanPrice(plan, key = config.stripe.secretKey) {
  // Currency is part of the key: the same plan id repriced into another
  // currency is a different Stripe price, and a five-minute stale hit here
  // would sell it at the old one.
  // The STORE is part of the key too. Managed-store plan ids are per-store
  // keys ("vip", "premium"), and one seller can run two stores on one Stripe
  // account — same key, same plan id, two different prices. Without the store
  // in here, store B's checkout took store A's cached price for five minutes.
  const cacheKey = `${plan.storeId ?? 'default'}:${key.slice(-8)}:${plan.id}:${normalizeCurrency(plan.currency)}`;
  const cached = priceCache.get(cacheKey);
  const at = Date.now();
  if (cached && at - cached.at <= PRICE_TTL_MS) return cached.promise;
  const promise = (async () => {
    if (plan.stripePriceId) {
      try {
        return { price: await stripeFetch(`/v1/prices/${plan.stripePriceId}`, { key }), source: 'configured' };
      } catch {
        /* fall through to amount matching */
      }
    }
    try {
      const currency = normalizeCurrency(plan.currency);
      const minor = toMinor(plan.priceUsd, currency);
      const type = plan.lifetime ? 'one_time' : 'recurring';
      const list = await stripeFetch(`/v1/prices?active=true&limit=100&type=${type}`, { key });
      const matches = (list.data ?? [])
        .filter((p) => p.active && String(p.currency).toLowerCase() === currency && p.unit_amount === minor)
        .filter((p) => plan.lifetime || p.recurring?.interval === plan.interval)
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
      return matches.length ? { price: matches[0], source: 'amount' } : null;
    } catch {
      return null;
    }
  })();
  priceCache.set(cacheKey, { at, promise });
  promise.then((r) => {
    if (!r) priceCache.delete(cacheKey);
  });
  return promise;
}

// ── what this seller can actually be paid in ─────────────────────────────────

// Dues never asks a seller for bank details and never stores them. The bank
// accounts live in the seller's own Stripe account, where they already are, and
// this reads back the list so the dashboard can offer the currencies the seller
// can genuinely settle — instead of offering all 133 and letting them pick one
// their payouts would fail in.
//
// Two facts come back:
//   defaultCurrency — the account's settlement currency
//   currencies      — every currency the account holds a bank account for
//
// Stripe's own rule for Adaptive Pricing is that a price's currency must be one
// of the account's settlement currencies, so this list is exactly the set of
// currencies a store may price in.
const PAYOUT_TTL_MS = 5 * 60_000;
const payoutCache = new Map();

export function invalidatePayoutCache() {
  payoutCache.clear();
}

export function payoutCurrencies(key = config.stripe.secretKey) {
  const cacheKey = String(key).slice(-8);
  const cached = payoutCache.get(cacheKey);
  const at = Date.now();
  if (cached && at - cached.at <= PAYOUT_TTL_MS) return cached.promise;
  const promise = (async () => {
    const account = await stripeFetch('/v1/account', { key });
    const defaultCurrency = normalizeCurrency(account.default_currency);
    let banks = account.external_accounts?.data ?? null;
    // The inline list stops at 10. Ask properly when there is an id to ask with,
    // but never let that second call fail the whole answer.
    if (account.id) {
      try {
        const list = await stripeFetch(
          `/v1/accounts/${account.id}/external_accounts?object=bank_account&limit=100`,
          { key },
        );
        if (Array.isArray(list.data)) banks = list.data;
      } catch {
        /* keep whatever the account object already gave us */
      }
    }
    const accounts = (banks ?? [])
      .filter((b) => b?.object === 'bank_account')
      .map((b) => ({
        currency: normalizeCurrency(b.currency),
        last4: b.last4 ?? null,
        bankName: b.bank_name ?? null,
        country: b.country ?? null,
        status: b.status ?? null,
        defaultForCurrency: Boolean(b.default_for_currency),
      }));
    // The default currency is settleable whether or not a bank account for it
    // came back on this call, so it is always in the list and always first.
    const currencies = [defaultCurrency, ...accounts.map((a) => a.currency)]
      .filter((c, i, all) => all.indexOf(c) === i);
    return { defaultCurrency, currencies, accounts };
  })();
  payoutCache.set(cacheKey, { at, promise });
  promise.catch(() => payoutCache.delete(cacheKey));
  return promise;
}

// ── webhook endpoint management ───────────────────────────────────────────────

export async function listWebhookEndpoints(key = config.stripe.secretKey) {
  return (await stripeFetch('/v1/webhook_endpoints?limit=100', { key })).data ?? [];
}

// The events a Dues endpoint must receive, in one place — createWebhookEndpoint
// registers exactly these, and ensureWebhookEvents brings ALREADY-REGISTERED
// endpoints up to the same list. Adding an event here without that second half
// would only ever reach stores onboarded after the deploy: every seller already
// selling would keep an endpoint subscribed to the old set and silently never
// receive the new event.
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  // Money going back out. Without these a refunded or charged-back buyer keeps
  // the role they no longer paid for, and the seller has to notice by hand.
  'charge.refunded',
  'charge.dispute.created',
];

// Add any missing events to an endpoint Stripe already holds. Returns the list
// that was added (empty when it was already complete), so callers can say so.
// Never REMOVES an event: an endpoint may legitimately carry extras a seller
// added themselves, and pruning someone else's configuration is not our call.
export async function ensureWebhookEvents(endpoint, key = config.stripe.secretKey) {
  const have = new Set(endpoint?.enabled_events ?? []);
  if (have.has('*')) return [];
  const missing = WEBHOOK_EVENTS.filter((e) => !have.has(e));
  if (!missing.length) return [];
  await stripeFetch(`/v1/webhook_endpoints/${endpoint.id}`, {
    method: 'POST',
    key,
    form: { enabled_events: [...have, ...missing] },
  });
  return missing;
}

export function createWebhookEndpoint(url, key = config.stripe.secretKey) {
  return stripeFetch('/v1/webhook_endpoints', {
    method: 'POST',
    key,
    form: {
      url,
      enabled_events: WEBHOOK_EVENTS,
      // Event payloads are rendered at the ENDPOINT's version, which the
      // request header above cannot reach. Pinning it here is what makes the
      // amount on an incoming event mean the same thing on every seller's
      // account as it does on every outgoing call.
      api_version: STRIPE_API_VERSION,
      description: 'Dues paygate — registered automatically by the setup doctor',
      metadata: { managed_by: 'ripley-paygate' },
    },
  });
}

// The URLs an already-registered endpoint may legitimately live on: the
// configured base plus its www/apex sibling (either can be the serving host).
export function webhookUrlCandidates() {
  const configured = `${config.publicBaseUrl}/webhooks/stripe`;
  const candidates = new Set([configured]);
  try {
    const u = new URL(configured);
    if (u.hostname.startsWith('www.')) candidates.add(configured.replace('://www.', '://'));
    else if (u.hostname.split('.').length === 2) candidates.add(configured.replace('://', '://www.'));
  } catch {
    /* keep just the configured form */
  }
  return [...candidates];
}

// Where Stripe must deliver. Stripe never follows redirects, so if the
// configured host answers our probe with one (apex → www), register on the
// host the redirect points at instead.
export async function canonicalWebhookUrl() {
  const configured = `${config.publicBaseUrl}/webhooks/stripe`;
  try {
    const res = await fetch(configured, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) return new URL(location, configured).toString();
  } catch {
    /* unreachable from here (local dev, tests) — register the configured form */
  }
  return configured;
}

// Stripe moved current_period_end off the subscription and onto its items
// (API 2025-03-31+). Read the top-level field for old API versions, fall back
// to the first item for new ones. May still be null — callers must treat that
// as "no period end from Stripe", never as lifetime.
export function subscriptionPeriodEnd(sub) {
  return sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end ?? null;
}

// The subscription an invoice belongs to also moved (top-level `subscription`
// → parent.subscription_details.subscription in newer API versions).
export function invoiceSubscriptionId(invoice) {
  return invoice?.subscription ?? invoice?.parent?.subscription_details?.subscription ?? null;
}

// Owners never open Stripe: when a tenant product has no usable price yet
// (created before price provisioning, or its price was edited), the price is
// created HERE, on their account, at first checkout — and pinned for reuse.
// Price edits clear the pinned id (updateStorePlan), so old Stripe
// subscriptions keep the price they were sold at, untouched.
export async function ensureTenantPrice(store, plan) {
  const resolved = await resolvePlanPrice(plan, store.stripeKey);
  if (resolved) return resolved.price;
  const db = await import('../db.js');
  const product = await stripeFetch('/v1/products', {
    method: 'POST',
    key: store.stripeKey,
    form: {
      name: plan.name,
      ...(plan.description ? { description: plan.description } : {}),
      ...(plan.imageUrl && plan.mediaKind !== 'video' ? { images: [plan.imageUrl] } : {}),
      default_price_data: {
        currency: normalizeCurrency(plan.currency),
        unit_amount: toMinor(plan.priceUsd, plan.currency),
        ...(plan.lifetime ? {} : { recurring: { interval: 'month' } }),
      },
    },
  });
  const priceId = typeof product.default_price === 'string' ? product.default_price : product.default_price?.id;
  await db.updateStorePlan(store.id, plan.id, { stripePriceId: priceId ?? null });
  invalidatePriceCache();
  return { id: priceId };
}

export async function createCheckoutSession({ plan, discordId, note = '', store = null, couponId = null, discountCode = null }) {
  const lifetime = Boolean(plan.lifetime);
  // A tenant store charges into ITS OWN Stripe account or not at all. The
  // fallback below exists for the built-in store (id null), whose stripeKey
  // IS the platform key by construction. openSecret() returns null when a
  // sealed key no longer decrypts — after a SECRET_KEY rotation, say — and
  // `??` would then have routed that seller's buyers into the platform's
  // Stripe account. Refuse; api/checkout/stripe.js turns the throw into a
  // clean error the seller can act on.
  if (store && store.id !== null && store.id !== undefined && !store.stripeKey) {
    throw new Error(`store ${store.slug}: its Stripe key cannot be read — reconnect Stripe in Settings before selling`);
  }
  const key = store?.stripeKey ?? config.stripe.secretKey;
  let priceId;
  const resolved = await resolvePlanPrice(plan, key);
  if (resolved) {
    priceId = resolved.price.id;
  } else if (store && !store.isDefault) {
    priceId = (await ensureTenantPrice(store, plan)).id;
  }
  if (!priceId) {
    throw new Error(
      `no usable Stripe price for plan "${plan.id}" (configured ${plan.stripePriceId}, and no active `
        + `${normalizeCurrency(plan.currency).toUpperCase()} ${lifetime ? 'one-time' : plan.interval} price of `
        + `${plan.priceUsd} on this account)`,
    );
  }
  // Every store — the built-in one included — is addressed by its own slug,
  // on the receipt and on the way back from a cancelled checkout alike.
  const storeQ = store?.slug ? `&store=${encodeURIComponent(store.slug)}` : '';
  const backTo = store?.slug ? `/${encodeURIComponent(store.slug)}` : '/';
  const successUrl = /^https:\/\/\S+$/.test(plan.successUrl ?? '')
    ? plan.successUrl
    : `${config.publicBaseUrl}/receipt?plan=${encodeURIComponent(plan.id)}${storeQ}`;
  return stripeFetch('/v1/checkout/sessions', {
    method: 'POST',
    key,
    form: {
      mode: lifetime ? 'payment' : 'subscription',
      client_reference_id: discordId,
      line_items: [{ price: priceId, quantity: 1 }],
      ...(couponId ? { discounts: [{ coupon: couponId }] } : {}),
      metadata: {
        plan_id: plan.id,
        discord_id: discordId,
        ...(store && !store.isDefault ? { store_id: String(store.id) } : {}),
        ...(note ? { buyer_note: note } : {}),
        ...(discountCode ? { discount_code: discountCode } : {}),
      },
      ...(lifetime
        ? {}
        : {
            subscription_data: {
              metadata: {
                plan_id: plan.id,
                discord_id: discordId,
                ...(store && !store.isDefault ? { store_id: String(store.id) } : {}),
              },
            },
          }),
      // Let Stripe present the price in the buyer's own currency. This is a
      // per-session override of the seller's dashboard toggle, so it works
      // without the seller configuring anything: Stripe picks the buyer's
      // local currency, converts at its own rate, and still settles the
      // seller in the currency the price is denominated in. Stripe charges
      // the SELLER nothing for it — the 2-4% sits in the rate the buyer is
      // quoted, and a buyer who prefers the original currency can switch back
      // on Stripe's page.
      //
      // It only engages when the price's currency is one of the seller's own
      // settlement currencies, which is exactly what the store-currency
      // picker constrains it to. Otherwise Stripe quietly presents the
      // original price, which is the old behaviour.
      adaptive_pricing: { enabled: true },
      success_url: successUrl,
      cancel_url: `${config.publicBaseUrl}${backTo}?checkout=cancelled`,
    },
  });
}
