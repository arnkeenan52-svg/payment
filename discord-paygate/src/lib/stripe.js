import crypto from 'node:crypto';
import { config } from '../config.js';

// Verifies a `stripe-signature` header (format: t=<unix>,v1=<hex>[,v1=<hex>…])
// against the raw body. Constant-time compare, and the signed timestamp must
// be within the replay tolerance — a captured delivery is useless later.
export function verifyStripeSignature(rawBody, header, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const v1s = parts.filter(([k]) => k === 'v1').map(([, v]) => v).filter(Boolean);
  if (!t || !/^\d+$/.test(t) || v1s.length === 0) return false;

  if (Math.abs(now - Number(t)) > config.webhookToleranceSeconds) return false;

  const expected = crypto
    .createHmac('sha256', config.stripe.webhookSecret)
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

export async function stripeFetch(path, { method = 'GET', form } = {}) {
  const res = await fetch(`${config.stripe.apiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.stripe.secretKey}`,
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

export const getSubscription = (id) => stripeFetch(`/v1/subscriptions/${id}`);

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

export async function createCheckoutSession({ plan, discordId, note = '' }) {
  const lifetime = Boolean(plan.lifetime);
  return stripeFetch('/v1/checkout/sessions', {
    method: 'POST',
    form: {
      mode: lifetime ? 'payment' : 'subscription',
      client_reference_id: discordId,
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      metadata: { plan_id: plan.id, discord_id: discordId, ...(note ? { buyer_note: note } : {}) },
      ...(lifetime ? {} : { subscription_data: { metadata: { plan_id: plan.id, discord_id: discordId } } }),
      success_url: `${config.publicBaseUrl}/receipt?plan=${encodeURIComponent(plan.id)}`,
      cancel_url: `${config.publicBaseUrl}/?checkout=cancelled`,
    },
  });
}
