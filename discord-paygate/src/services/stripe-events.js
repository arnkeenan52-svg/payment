import { config } from '../config.js';
import { getSubscription, subscriptionPeriodEnd, invoiceSubscriptionId, stripeFetch } from '../lib/stripe.js';
import { getSubscriptionByRef, setSubscriptionStatus, markCheckoutCompleted, getCheckoutAttempt } from '../db.js';
import { grant, markPastDue, cancel, reconcile } from './entitlements.js';
import { storeById, defaultStore, planOf } from './stores.js';
import { sendReceiptEmail } from '../lib/email.js';
import { postChannelMessage } from '../lib/discord.js';
import { getUser } from '../db.js';
import { activatePlatformPlan, applyPlatformSubscriptionEvent, isPlatformSubscription } from './billing.js';
import { fromMinor, formatAmount, normalize as normalizeCurrency } from '../lib/currency.js';

// Which store an event belongs to. SECURITY: a per-store endpoint verified
// this delivery with that store's OWN signing secret, so the event provably
// belongs to routeStore — event metadata (which the paying Stripe account
// fully controls) must never reassign it to another tenant. Metadata and the
// stored subscription row are trusted only on the platform endpoint (Dues's
// own account), where routeStore is null.
async function resolveStore(routeStore, metadataStoreId, row = null) {
  if (routeStore) {
    // Two stores on ONE Stripe account each get their own endpoint, and Stripe
    // delivers every event to both. An event that names another store — in
    // its metadata, or through the subscription row it renews — belongs to
    // that store's endpoint: answer null so the caller DROPS it here, and
    // never re-attribute it to routeStore. (A tenant cannot reach another
    // tenant this way: the other endpoint verifies with its own secret.)
    if (metadataStoreId && String(metadataStoreId) !== String(routeStore.id)) return null;
    if (row && row.store_id !== null && row.store_id !== undefined && Number(row.store_id) !== Number(routeStore.id)) return null;
    return routeStore;
  }
  if (metadataStoreId) return (await storeById(metadataStoreId)) ?? defaultStore();
  if (row && row.store_id !== null && row.store_id !== undefined) return storeById(row.store_id);
  return defaultStore();
}

// Whether a subscription-keyed event on a per-store endpoint is this store's
// to act on. No row at all is left to the handler, which no-ops on it.
async function ownsRef(routeStore, ref) {
  if (!routeStore) return true;
  const row = await getSubscriptionByRef('stripe', ref);
  return !row || (await resolveStore(routeStore, null, row)) !== null;
}

// Handled events: checkout.session.completed, invoice.paid,
// invoice.payment_failed, customer.subscription.updated,
// customer.subscription.deleted. Everything else is acknowledged and dropped.
export async function processStripeEvent(event, routeStore = null) {
  const obj = event.data?.object ?? {};
  switch (event.type) {
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.completed': {
      // A store owner buying a Dues plan — platform billing, not a buyer
      // membership. This only ever happens on Dues's own account (the
      // platform endpoint, routeStore null). SECURITY: ignore a platform_plan
      // marker on a per-store endpoint — a tenant must not activate a platform
      // tier by stamping metadata on an event from their own Stripe account.
      if (obj.metadata?.kind === 'platform_plan') {
        if (routeStore) return;
        await activatePlatformPlan({
          ownerDiscordId: obj.metadata?.owner_discord_id ?? obj.client_reference_id,
          tierId: obj.metadata?.tier,
          subscriptionId: obj.subscription ?? null,
        });
        return;
      }
      // The money has to have MOVED. Delayed-notification methods (SEPA, ACH,
      // Bacs, OXXO…) complete the session with payment_status 'unpaid' and
      // settle days later — Stripe then sends async_payment_succeeded (which
      // lands in this same case) or async_payment_failed. A 100%-off coupon
      // reports no_payment_required. Anything else granted a role, mailed a
      // paid receipt and pinged the seller for money that never arrived.
      if (obj.payment_status !== 'paid' && obj.payment_status !== 'no_payment_required') {
        console.log(`[webhooks] stripe ${event.id}: session ${obj.id} is ${obj.payment_status ?? 'unpaid'} — waiting for async_payment_succeeded`);
        return;
      }
      // Already completed — by a delivery or by the cron's backfill — so this
      // is the same sale again under another event id. Nothing happens twice.
      // (The attempt is marked completed only AFTER the grant lands, below, so
      // a delivery that crashed before it can still be retried.)
      if (obj.id && (await getCheckoutAttempt(obj.id))?.status === 'completed') {
        console.log(`[webhooks] stripe ${event.id}: session ${obj.id} already completed — nothing to do twice`);
        return;
      }
      const discordId = obj.client_reference_id ?? obj.metadata?.discord_id;
      const planId = obj.metadata?.plan_id;
      if (!discordId || !planId) {
        console.warn(`[webhooks] stripe ${event.id}: checkout session without discord_id/plan_id, ignoring`);
        return;
      }
      const store = await resolveStore(routeStore, obj.metadata?.store_id);
      if (store === null) {
        console.log(`[webhooks] stripe ${event.id}: session ${obj.id} belongs to store ${obj.metadata?.store_id}, not this endpoint's — dropped`);
        return;
      }
      // A redeemed discount counts its use once the GRANT has landed, not
      // before it. Counted up here, a grant that threw sent the webhook to
      // 500, Stripe retried, and the retry counted the same sale again —
      // burning a seller's five-use promotion two uses at a time.
      const countDiscount = async () => {
        if (!obj.metadata?.discount_code || store?.id === null || store?.id === undefined) return;
        const { incrementDiscountUse } = await import('../db.js');
        await incrementDiscountUse(store.id, obj.metadata.discount_code).catch(() => {});
      };
      // What Stripe actually charged (discounts included). The plan's list
      // price is only a fallback for events without an amount.
      // amount_total is in MINOR units and the divisor is not always 100 — a
      // ¥1500 sale reports 1500, which /100 would record and announce as ¥15.
      const paidCurrency = normalizeCurrency(obj.currency ?? store?.currency);
      const paidUsd = typeof obj.amount_total === 'number' ? fromMinor(obj.amount_total, paidCurrency) : null;
      // Sale ping to the owner's chosen channel (best-effort): every order
      // posts an embed the moment the grant lands.
      const notifySale = async ({ orphan = false } = {}) => {
        if (!store?.notifyChannelId) return;
        const plan = await planOf(store, planId);
        const user = await getUser(discordId).catch(() => null);
        const buyer = user?.username ? `@${user.username}` : `<@${discordId}>`;
        const amount = paidUsd ?? plan?.priceUsd ?? 0;
        await postChannelMessage(store.notifyChannelId, {
          embeds: [{
            title: orphan ? '⚠️ Paid for a product that no longer exists' : '🎉 New Subscriber!',
            description: orphan
              ? `**${buyer}** paid **${formatAmount(amount, paidCurrency)}** for **${planId}**, which is no longer in this store — nothing was delivered. Refund them from your Stripe dashboard, or re-create the product with the same link and re-sync them.`
              : `**${buyer}** just subscribed to **${plan?.name ?? planId}**` +
              `${plan?.lifetime ? ' (lifetime)' : ''}.\n\nPayment received: **${formatAmount(amount, plan?.currency ?? paidCurrency)}**`,
            // Blurple, not white. A white embed stripe is invisible against
            // Discord's light theme -- the accent bar renders #ffffff on an
            // #f2f3f5 embed, so every seller whose members run light mode has
            // been getting an alert with no accent on it at all.
            color: 0x5865f2,
            thumbnail: { url: 'https://dues.gg/icon-192.png' },
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
          amountUsd: paidUsd ?? plan?.priceUsd ?? 0,
          currency: plan?.currency ?? paidCurrency,
          lifetime: Boolean(plan?.lifetime),
          discordUsername: user?.username ?? null,
          reference: obj.id,
        });
      };
      if (obj.mode === 'subscription' && obj.subscription) {
        // Fetch the subscription for its real period end; Stripe moved
        // current_period_end onto items, subscriptionPeriodEnd handles both.
        const sub = await getSubscription(obj.subscription, store?.stripeKey ?? config.stripe.secretKey);
        const landed = await grant({
          discordId,
          planId,
          provider: 'stripe',
          providerRef: obj.subscription,
          periodEnd: subscriptionPeriodEnd(sub),
          store,
          paidUsd,
          currency: paidCurrency,
        });
        if (obj.id) await markCheckoutCompleted(obj.id).catch(() => {});
        // grant() answers null, without throwing, for a plan the store no
        // longer has: money taken, nothing delivered. Not a 500 — a retry
        // cannot bring the product back — but never silent either.
        if (landed) {
          await countDiscount();
          await emailReceipt();
          await notifySale();
        } else {
          console.error(`[webhooks] stripe ${event.id}: ${discordId} paid for "${planId}", which store ${store?.slug ?? 'default'} no longer has — seller alerted`);
          await notifySale({ orphan: true });
        }
      } else {
        // One-time payment (lifetime plans; grant() maps lifetime → NULL
        // expiry, and falls back to plan duration for any one-off term plan).
        const landed = await grant({
          discordId,
          planId,
          provider: 'stripe',
          providerRef: obj.payment_intent ?? obj.id,
          periodEnd: null,
          store,
          paidUsd,
          currency: paidCurrency,
        });
        if (obj.id) await markCheckoutCompleted(obj.id).catch(() => {});
        if (landed) {
          await countDiscount();
          await emailReceipt();
          await notifySale();
        } else {
          console.error(`[webhooks] stripe ${event.id}: ${discordId} paid for "${planId}", which store ${store?.slug ?? 'default'} no longer has — seller alerted`);
          await notifySale({ orphan: true });
        }
      }
      return;
    }

    case 'checkout.session.async_payment_failed': {
      // The delayed payment never cleared. Nothing was granted (the completed
      // event was unpaid), so this is a no-op unless a row exists to end.
      const ref = obj.mode === 'subscription' && obj.subscription ? obj.subscription : (obj.payment_intent ?? obj.id);
      if (routeStore && !(await ownsRef(routeStore, ref))) return;
      await cancel('stripe', ref);
      return;
    }

    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const subId = invoiceSubscriptionId(obj);
      if (!subId) return;
      // Platform-plan renewal: refresh the owner's paid period and stop —
      // there is no buyer entitlement behind this subscription. Only on the
      // platform's own endpoint: a per-store endpoint has no business
      // writing platform-billing state.
      if (!routeStore && (await isPlatformSubscription(subId))) {
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
      if (store === null) return; // another store's subscriber, on this store's endpoint
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
      if (!routeStore && (await applyPlatformSubscriptionEvent(subId, { status: 'past_due' }))) return;
      if (!(await ownsRef(routeStore, subId))) return;
      await markPastDue('stripe', subId);
      return;
    }

    case 'customer.subscription.updated': {
      // SECURITY: platform-billing state moves only from the platform's own
      // endpoint. A seller can sign anything to THEIR store's endpoint (its
      // secret lives in their Stripe dashboard), and this event used to flip
      // their own Dues tier to paid-for-ten-years.
      if (
        !routeStore &&
        (await applyPlatformSubscriptionEvent(obj.id, {
          status: obj.status === 'active' || obj.status === 'trialing' ? 'active' : obj.status,
          periodEnd: subscriptionPeriodEnd(obj) ?? undefined,
        }))
      )
        return;
      const row = await getSubscriptionByRef('stripe', obj.id);
      if (!row) return;
      if (routeStore && (await resolveStore(routeStore, null, row)) === null) return;
      // Same rule as markPastDue: a deliberately revoked row is not resurrected
      // by routine traffic. Stripe still calls the subscription 'active' after a
      // refund or a dispute (nothing here cancels it at Stripe), and the buyer's
      // own cancel button posts cancel_at_period_end, which emits exactly this
      // event.
      if (row.status === 'canceled') return;
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
      if (!routeStore && (await applyPlatformSubscriptionEvent(obj.id, { status: 'canceled' }))) return;
      if (!(await ownsRef(routeStore, obj.id))) return;
      await cancel('stripe', obj.id);
      return;
    }

    // ── money going back out ────────────────────────────────────────────────
    case 'charge.refunded': {
      // Stripe fires this for PARTIAL refunds too, with refunded:false on the
      // charge. A partial refund is not a reversal of the sale — $5 back as
      // goodwill does not end someone's membership — so only a full refund
      // revokes. amount is checked as well as the flag because a zero-amount
      // charge would otherwise satisfy the comparison on its own.
      const amount = Number(obj.amount ?? 0);
      const refunded = Number(obj.amount_refunded ?? 0);
      if (obj.refunded !== true && !(amount > 0 && refunded >= amount)) return;
      await revokeForPayment(obj, routeStore);
      return;
    }

    case 'charge.dispute.created': {
      // A chargeback. The bank has already pulled the money; waiting for the
      // dispute to resolve would leave a non-paying member holding the role
      // for weeks. If the seller wins, the buyer can be re-added by hand — the
      // subscription row is still there, only its status moved.
      await revokeForPayment(obj, routeStore);
      return;
    }

    default:
      return;
  }
}

// Revoke whatever a refunded/disputed payment bought. Stripe hands us a Charge
// (charge.refunded) or a Dispute (charge.dispute.created); both carry the
// payment_intent, which is exactly what a one-off or lifetime purchase is
// stored under. A SUBSCRIPTION payment is stored under the subscription id
// instead, so when the direct lookup misses we walk the charge's invoice back
// to its subscription and revoke that.
//
// Deliberately quiet when nothing matches: a Stripe account can carry charges
// that have nothing to do with Dues, and those are not our business to act on.
async function revokeForPayment(obj, routeStore = null) {
  // On a per-store endpoint, only this store's own rows are ever ended.
  const cancelOwned = async (ref) => ((await ownsRef(routeStore, ref)) ? cancel('stripe', ref) : null);
  const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id ?? null;
  if (pi && (await cancelOwned(pi))) return true;

  // Subscription payments: the charge names the invoice, the invoice names the
  // subscription. A Dispute carries no invoice, so fetch its charge first.
  let invoiceId = typeof obj.invoice === 'string' ? obj.invoice : obj.invoice?.id ?? null;
  const key = routeStore?.stripeKey ?? config.stripe.secretKey;
  if (!invoiceId && obj.object === 'dispute') {
    const chargeId = typeof obj.charge === 'string' ? obj.charge : obj.charge?.id ?? null;
    if (chargeId) {
      const charge = await stripeFetch(`/v1/charges/${chargeId}`, { key }).catch(() => null);
      invoiceId = typeof charge?.invoice === 'string' ? charge.invoice : charge?.invoice?.id ?? null;
      const chargePi = typeof charge?.payment_intent === 'string' ? charge.payment_intent : charge?.payment_intent?.id ?? null;
      if (!pi && chargePi && (await cancelOwned(chargePi))) return true;
    }
  }
  if (!invoiceId) return false;
  const invoice = await stripeFetch(`/v1/invoices/${invoiceId}`, { key }).catch(() => null);
  const subId = invoice ? invoiceSubscriptionId(invoice) : null;
  if (!subId) return false;
  // A refunded PLATFORM plan payment is the seller's own Dues subscription,
  // not a buyer's membership — it has no role behind it to take away.
  if (!routeStore && (await isPlatformSubscription(subId))) return false;
  return Boolean(await cancelOwned(subId));
}
