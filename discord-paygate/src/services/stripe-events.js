import { config } from '../config.js';
import { getSubscription, subscriptionPeriodEnd, invoiceSubscriptionId } from '../lib/stripe.js';
import { getSubscriptionByRef, setSubscriptionStatus } from '../db.js';
import { grant, markPastDue, cancel, reconcile } from './entitlements.js';
import { storeById, defaultStore, planOf } from './stores.js';
import { sendReceiptEmail } from '../lib/email.js';
import { getUser } from '../db.js';

// Which store an event belongs to: the per-store endpoint that received it
// (routeStore), the store_id our checkout stamped into metadata, or the row
// we already hold for the Stripe subscription — falling back to the default
// store for pre-multi-tenant deliveries.
async function resolveStore(routeStore, metadataStoreId, row = null) {
  if (metadataStoreId) return (await storeById(metadataStoreId)) ?? routeStore ?? defaultStore();
  if (row && row.store_id !== null && row.store_id !== undefined) return storeById(row.store_id);
  return routeStore ?? defaultStore();
}

// Handled events: checkout.session.completed, invoice.paid,
// invoice.payment_failed, customer.subscription.updated,
// customer.subscription.deleted. Everything else is acknowledged and dropped.
export async function processStripeEvent(event, routeStore = null) {
  const obj = event.data?.object ?? {};
  switch (event.type) {
    case 'checkout.session.completed': {
      const discordId = obj.client_reference_id ?? obj.metadata?.discord_id;
      const planId = obj.metadata?.plan_id;
      if (!discordId || !planId) {
        console.warn(`[webhooks] stripe ${event.id}: checkout session without discord_id/plan_id, ignoring`);
        return;
      }
      const store = await resolveStore(routeStore, obj.metadata?.store_id);
      // Emailed receipt (best-effort, bounded): Stripe checkout collects the
      // buyer's email — a failed send never fails the grant.
      const emailReceipt = async () => {
        const to = obj.customer_details?.email ?? obj.customer_email ?? null;
        if (!to) return;
        const plan = await planOf(store, planId);
        const user = await getUser(discordId).catch(() => null);
        await sendReceiptEmail({
          to,
          storeName: store?.name ?? config.brand,
          planName: plan?.name ?? planId,
          amountUsd: plan?.priceUsd ?? (obj.amount_total ?? 0) / 100,
          lifetime: Boolean(plan?.lifetime),
          discordUsername: user?.username ?? null,
          reference: obj.id,
        });
      };
      if (obj.mode === 'subscription' && obj.subscription) {
        // Fetch the subscription for its real period end; Stripe moved
        // current_period_end onto items, subscriptionPeriodEnd handles both.
        const sub = await getSubscription(obj.subscription, store?.stripeKey ?? config.stripe.secretKey);
        await grant({
          discordId,
          planId,
          provider: 'stripe',
          providerRef: obj.subscription,
          periodEnd: subscriptionPeriodEnd(sub),
          store,
        });
        await emailReceipt();
      } else {
        // One-time payment (lifetime plans; grant() maps lifetime → NULL
        // expiry, and falls back to plan duration for any one-off term plan).
        await grant({
          discordId,
          planId,
          provider: 'stripe',
          providerRef: obj.payment_intent ?? obj.id,
          periodEnd: null,
          store,
        });
        await emailReceipt();
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
      const store = await resolveStore(routeStore, null, row);
      const sub = await getSubscription(subId, store?.stripeKey ?? config.stripe.secretKey);
      await grant({
        discordId: row.discord_id,
        planId: row.plan_id,
        provider: 'stripe',
        providerRef: subId,
        periodEnd: subscriptionPeriodEnd(sub),
        store,
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
        await reconcile(row.discord_id, await resolveStore(routeStore, null, row));
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
