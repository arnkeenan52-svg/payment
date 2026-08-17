import { readRawBody, sendText } from '../lib/http.js';
import { verifyStripeSignature, getSubscription, subscriptionPeriodEnd, invoiceSubscriptionId } from '../lib/stripe.js';
import { verifyCoinbaseSignature, withinTolerance } from '../lib/coinbase.js';
import { claimEvent, releaseEvent, getSubscriptionByRef, setSubscriptionStatus } from '../db.js';
import { grant, markPastDue, cancel, reconcile } from '../services/entitlements.js';

// Shared tail of both webhook routes. By the time this runs the signature and
// replay window are verified. The PRIMARY KEY claim decides duplicates, the
// provider gets its 200 immediately, and the real work happens after the ack —
// a slow Discord call must never time a delivery out into a retry storm.
// If processing throws, the claim is released so the provider's retry is a
// real second attempt rather than a no-op swallowed by idempotency.
function ackThenProcess(res, provider, eventId, work) {
  if (!claimEvent(provider, eventId)) {
    sendText(res, 200, 'duplicate');
    return;
  }
  sendText(res, 200, 'ok');
  setImmediate(async () => {
    try {
      await work();
    } catch (err) {
      releaseEvent(provider, eventId);
      console.error(`[webhooks] ${provider} event ${eventId} failed (claim released for retry): ${err.stack ?? err.message}`);
    }
  });
}

// ── Stripe: POST /webhooks/stripe ─────────────────────────────────────────────
// Subscribed events: checkout.session.completed, invoice.paid,
// invoice.payment_failed, customer.subscription.updated,
// customer.subscription.deleted

export async function handleStripeWebhook(req, res) {
  const raw = await readRawBody(req);
  if (!verifyStripeSignature(raw, req.headers['stripe-signature'])) {
    sendText(res, 400, 'invalid signature');
    return;
  }
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    sendText(res, 400, 'invalid payload');
    return;
  }
  if (!event?.id || !event?.type) {
    sendText(res, 400, 'invalid payload');
    return;
  }

  ackThenProcess(res, 'stripe', event.id, () => processStripeEvent(event));
}

async function processStripeEvent(event) {
  const obj = event.data?.object ?? {};
  switch (event.type) {
    case 'checkout.session.completed': {
      const discordId = obj.client_reference_id ?? obj.metadata?.discord_id;
      const planId = obj.metadata?.plan_id;
      if (!discordId || !planId) {
        console.warn(`[webhooks] stripe ${event.id}: checkout session without discord_id/plan_id, ignoring`);
        return;
      }
      if (obj.mode === 'subscription' && obj.subscription) {
        // Fetch the subscription for its real period end; Stripe moved
        // current_period_end onto items, subscriptionPeriodEnd handles both.
        const sub = await getSubscription(obj.subscription);
        await grant({
          discordId,
          planId,
          provider: 'stripe',
          providerRef: obj.subscription,
          periodEnd: subscriptionPeriodEnd(sub),
        });
      } else {
        // One-time payment (lifetime plans; grant() maps lifetime → NULL
        // expiry, and falls back to plan duration for any one-off term plan).
        await grant({
          discordId,
          planId,
          provider: 'stripe',
          providerRef: obj.payment_intent ?? obj.id,
          periodEnd: null,
        });
      }
      return;
    }

    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const subId = invoiceSubscriptionId(obj);
      if (!subId) return;
      const row = getSubscriptionByRef('stripe', subId);
      if (!row) {
        // Renewal for a subscription we never saw a checkout for — nothing to
        // attach it to; checkout.session.completed is the source of truth.
        console.warn(`[webhooks] stripe ${event.id}: invoice for unknown subscription ${subId}, ignoring`);
        return;
      }
      const sub = await getSubscription(subId);
      await grant({
        discordId: row.discord_id,
        planId: row.plan_id,
        provider: 'stripe',
        providerRef: subId,
        periodEnd: subscriptionPeriodEnd(sub),
      });
      return;
    }

    case 'invoice.payment_failed': {
      const subId = invoiceSubscriptionId(obj);
      if (subId) await markPastDue('stripe', subId);
      return;
    }

    case 'customer.subscription.updated': {
      const row = getSubscriptionByRef('stripe', obj.id);
      if (!row) return;
      if (obj.status === 'active' || obj.status === 'trialing') {
        const periodEnd = subscriptionPeriodEnd(obj);
        setSubscriptionStatus(row.id, {
          status: 'active',
          // Never write NULL for a term plan: keep the previous expiry if the
          // event carries no period end (NULL is reserved for lifetime).
          currentPeriodEnd: periodEnd ?? row.current_period_end,
          graceUntil: null,
        });
        await reconcile(row.discord_id);
      }
      return;
    }

    case 'customer.subscription.deleted': {
      await cancel('stripe', obj.id);
      return;
    }

    default:
      return; // unhandled event types are acknowledged and dropped
  }
}

// ── Coinbase Commerce: POST /webhooks/coinbase ────────────────────────────────
// Grants on charge:confirmed and charge:resolved. charge:pending is only a
// mempool sighting — never grant on it. Crypto can't auto-renew, so a grant is
// a fixed term of the plan's duration (lifetime plans stay lifetime).

export async function handleCoinbaseWebhook(req, res) {
  const raw = await readRawBody(req);
  if (!verifyCoinbaseSignature(raw, req.headers['x-cc-webhook-signature'])) {
    sendText(res, 400, 'invalid signature');
    return;
  }
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendText(res, 400, 'invalid payload');
    return;
  }
  const event = body?.event;
  if (!event?.id || !event?.type) {
    sendText(res, 400, 'invalid payload');
    return;
  }
  if (!withinTolerance(event.created_at)) {
    sendText(res, 400, 'stale event');
    return;
  }

  ackThenProcess(res, 'coinbase', event.id, () => processCoinbaseEvent(event));
}

async function processCoinbaseEvent(event) {
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
