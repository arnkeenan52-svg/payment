import { getSubscription, subscriptionPeriodEnd, invoiceSubscriptionId } from '../lib/stripe.js';
import { getSubscriptionByRef, setSubscriptionStatus } from '../db.js';
import { grant, markPastDue, cancel, reconcile } from './entitlements.js';

// Handled events: checkout.session.completed, invoice.paid,
// invoice.payment_failed, customer.subscription.updated,
// customer.subscription.deleted. Everything else is acknowledged and dropped.
export async function processStripeEvent(event) {
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
        // One-time payment (the lifetime plan; grant() maps lifetime → NULL
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
      const row = await getSubscriptionByRef('stripe', subId);
      if (!row) {
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
      const row = await getSubscriptionByRef('stripe', obj.id);
      if (!row) return;
      if (obj.status === 'active' || obj.status === 'trialing') {
        const periodEnd = subscriptionPeriodEnd(obj);
        await setSubscriptionStatus(row.id, {
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
      return;
  }
}
