import { config } from '../config.js';
import { getSubscription, subscriptionPeriodEnd, invoiceSubscriptionId } from '../lib/stripe.js';
import { getSubscriptionByRef, setSubscriptionStatus, markCheckoutCompleted } from '../db.js';
import { grant, markPastDue, cancel, reconcile } from './entitlements.js';
import { storeById, defaultStore, planOf } from './stores.js';
import { sendReceiptEmail } from '../lib/email.js';
import { postChannelMessage } from '../lib/discord.js';
import { getUser } from '../db.js';
import { activatePlatformPlan, applyPlatformSubscriptionEvent, isPlatformSubscription } from './billing.js';

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
      // A store owner buying a Ripley plan — platform billing, not a buyer
      // membership. Lands on the default endpoint (Ripley's own account).
      if (obj.metadata?.kind === 'platform_plan') {
        await activatePlatformPlan({
          ownerDiscordId: obj.metadata?.owner_discord_id ?? obj.client_reference_id,
          tierId: obj.metadata?.tier,
          subscriptionId: obj.subscription ?? null,
        });
        return;
      }
      // Close the loop on the attempt row logged when this session was made.
      // Stripe replays this event on retry, so the update is idempotent.
      if (obj.id) await markCheckoutCompleted(obj.id).catch(() => {});
      const discordId = obj.client_reference_id ?? obj.metadata?.discord_id;
      const planId = obj.metadata?.plan_id;
      if (!discordId || !planId) {
        console.warn(`[webhooks] stripe ${event.id}: checkout session without discord_id/plan_id, ignoring`);
        return;
      }
      const store = await resolveStore(routeStore, obj.metadata?.store_id);
      // A redeemed discount counts its use only once payment completed.
      if (obj.metadata?.discount_code && store?.id !== null && store?.id !== undefined) {
        const { incrementDiscountUse } = await import('../db.js');
        await incrementDiscountUse(store.id, obj.metadata.discount_code).catch(() => {});
      }
      // Sale ping to the owner's chosen channel (best-effort): every order
      // posts an embed the moment the grant lands.
      const notifySale = async () => {
        if (!store?.notifyChannelId) return;
        const plan = await planOf(store, planId);
        const user = await getUser(discordId).catch(() => null);
        const buyer = user?.username ? `@${user.username}` : `<@${discordId}>`;
        const amount = plan?.priceUsd ?? (obj.amount_total ?? 0) / 100;
        await postChannelMessage(store.notifyChannelId, {
          embeds: [{
            title: '🎉 New Subscriber!',
            description:
              `**${buyer}** just subscribed to **${plan?.name ?? planId}**` +
              `${plan?.lifetime ? ' (lifetime)' : ''}.\n\nPayment received: **$${Number(amount).toFixed(2)}**`,
            color: 0xffffff,
            footer: { text: store.name },
            timestamp: new Date().toISOString(),
          }],
        });
      };
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
        await notifySale();
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
        await notifySale();
      }
      return;
    }

    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const subId = invoiceSubscriptionId(obj);
      if (!subId) return;
      // Platform-plan renewal: refresh the owner's paid period and stop —
      // there is no buyer entitlement behind this subscription.
      if (await isPlatformSubscription(subId)) {
        const sub = await getSubscription(subId).catch(() => null);
        await applyPlatformSubscriptionEvent(subId, { status: 'active', periodEnd: sub ? subscriptionPeriodEnd(sub) : undefined });
        return;
      }
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
      if (!subId) return;
      if (await applyPlatformSubscriptionEvent(subId, { status: 'past_due' })) return;
      await markPastDue('stripe', subId);
      return;
    }

    case 'customer.subscription.updated': {
      if (
        await applyPlatformSubscriptionEvent(obj.id, {
          status: obj.status === 'active' || obj.status === 'trialing' ? 'active' : obj.status,
          periodEnd: subscriptionPeriodEnd(obj) ?? undefined,
        })
      )
        return;
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
      if (await applyPlatformSubscriptionEvent(obj.id, { status: 'canceled' })) return;
      await cancel('stripe', obj.id);
      return;
    }

    default:
      return;
  }
}
