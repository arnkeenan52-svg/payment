import crypto from 'node:crypto';
import { config } from '../config.js';

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

export async function stripeFetch(path, { method = 'GET', form, key = config.stripe.secretKey } = {}) {
  const res = await fetch(`${config.stripe.apiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? encodeForm(form).join('&') : undefined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`stripe: ${method} ${path} failed with ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

export const getSubscription = (id, key = config.stripe.secretKey) => stripeFetch(`/v1/subscriptions/${id}`, { key });

// ── price resolution ──────────────────────────────────────────────────────────

// The configured stripePriceId wins. When it does not exist on this account
// (wrong mode, wrong account, stale id), fall back to the newest ACTIVE price
// matching the plan's own terms: USD, the exact amount, one-time for lifetime
// plans, or the plan's interval for recurring ones. The doctor surfaces the
// fallback as a warning so the owner can pin the real id.
const PRICE_TTL_MS = 5 * 60_000;
const priceCache = new Map(); // planId -> { at, promise }

export function invalidatePriceCache() {
  priceCache.clear();
}

export function resolvePlanPrice(plan, key = config.stripe.secretKey) {
  const cacheKey = `${key.slice(-8)}:${plan.id}`;
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
      const cents = Math.round(Number(plan.priceUsd) * 100);
      const type = plan.lifetime ? 'one_time' : 'recurring';
      const list = await stripeFetch(`/v1/prices?active=true&limit=100&type=${type}`, { key });
      const matches = (list.data ?? [])
        .filter((p) => p.active && String(p.currency).toLowerCase() === 'usd' && p.unit_amount === cents)
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

// ── webhook endpoint management ───────────────────────────────────────────────

export async function listWebhookEndpoints(key = config.stripe.secretKey) {
  return (await stripeFetch('/v1/webhook_endpoints?limit=100', { key })).data ?? [];
}

export function createWebhookEndpoint(url, key = config.stripe.secretKey) {
  return stripeFetch('/v1/webhook_endpoints', {
    method: 'POST',
    key,
    form: {
      url,
      enabled_events: [
        'checkout.session.completed',
        'invoice.paid',
        'invoice.payment_succeeded',
        'invoice.payment_failed',
        'customer.subscription.updated',
        'customer.subscription.deleted',
      ],
      description: 'Ripley paygate — registered automatically by the setup doctor',
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
      ...(plan.imageUrl ? { images: [plan.imageUrl] } : {}),
      default_price_data: {
        currency: 'usd',
        unit_amount: Math.round(plan.priceUsd * 100),
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
      `no usable Stripe price for plan "${plan.id}" (configured ${plan.stripePriceId}, and no active USD ${lifetime ? 'one-time' : plan.interval} price of $${plan.priceUsd} on this account)`,
    );
  }
  const storeQ = store && !store.isDefault ? `&store=${encodeURIComponent(store.slug)}` : '';
  // Every store — the built-in one included — returns buyers to its own slug.
  const backTo = store?.slug ? `/${encodeURIComponent(store.slug)}` : '/store';
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
      success_url: successUrl,
      cancel_url: `${config.publicBaseUrl}${backTo}?checkout=cancelled`,
    },
  });
}
