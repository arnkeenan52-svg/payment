import { config } from '../config.js';
import * as db from '../db.js';
import { getUser } from '../db.js';
import { grant } from './entitlements.js';
import { storeById, defaultStore, planOf } from './stores.js';
import { postChannelMessage } from '../lib/discord.js';
import { formatAmount, normalize as normalizeCurrency } from '../lib/currency.js';
import { GRANTS_ACCESS, SHORT, DEAD, settledFiat, describeStatus } from '../lib/nowpayments.js';

// What to do with a NOWPayments payment.
//
// The argument is the payment as the API reports it — the webhook re-reads it
// rather than trusting the IPN body, because NOWPayments' IPN has no replay
// protection of any kind: no timestamp, no nonce, nothing to bound how old a
// captured delivery is. Re-reading makes a replayed IPN harmless, since the
// answer is always the payment's CURRENT state.
//
// Access is granted on `finished` only. `partially_paid` is a buyer who still
// owes money (the account's short-payment default), and anything in flight is
// a state to show, not a sale.
export async function processNowPayment(payment) {
  const orderId = String(payment?.order_id ?? '').trim();
  const status = String(payment?.payment_status ?? '').toLowerCase();
  if (!orderId) {
    console.warn(`[webhooks] nowpayments ${payment?.payment_id}: payment without order_id, ignoring`);
    return;
  }
  // The order row is the ONLY link from "money arrived" back to which buyer
  // bought which product: the IPN carries our order id and nothing else.
  const attempt = await db.getCheckoutAttempt(orderId);
  if (!attempt) {
    console.warn(`[webhooks] nowpayments ${payment.payment_id}: order ${orderId} is not one of ours, ignoring`);
    return;
  }
  const store = attempt.store_id === null || attempt.store_id === undefined
    ? defaultStore()
    : await storeById(attempt.store_id);

  if (!GRANTS_ACCESS.has(status)) {
    // Logged rather than silent: a seller asking "where is my sale?" needs
    // the shortfall to be findable, and a short payment is the one failure
    // mode that looks identical to success from the buyer's side.
    if (SHORT.has(status)) {
      console.warn(
        `[webhooks] nowpayments ${payment.payment_id} (order ${orderId}) is short: ` +
          `${settledFiat(payment).toFixed(2)} of ${Number(payment.price_amount ?? 0).toFixed(2)} ` +
          `${normalizeCurrency(payment.price_currency ?? attempt.currency).toUpperCase()} received — no access granted`,
      );
    } else if (DEAD.has(status)) {
      console.warn(`[webhooks] nowpayments ${payment.payment_id} (order ${orderId}) ended as ${status} — no access granted`);
    }
    return;
  }

  const currency = normalizeCurrency(payment.price_currency ?? attempt.currency);
  // What the order was for, not what the coin was worth: price_amount is the
  // fiat figure the invoice was created against, and it is the number the
  // seller's books, the sale ping and the member row all have to agree on.
  const paidUsd = Number(payment.price_amount ?? attempt.amount_usd ?? 0);

  await grant({
    discordId: attempt.discord_id,
    planId: attempt.plan_id,
    provider: 'nowpayments',
    // The payment id is stable across every IPN for this order, so a repeat
    // delivery updates the same subscription row instead of minting another.
    providerRef: String(payment.payment_id),
    // Crypto cannot auto-renew — there is no card to charge again — so the
    // grant is a fixed term of the plan's own duration (lifetime stays
    // lifetime). Passing a period end here would be inventing one.
    periodEnd: null,
    store,
    paidUsd,
    currency,
  });

  await db.markCheckoutCompleted(orderId).catch(() => {});
  if (attempt.discount_code && store?.id !== null && store?.id !== undefined) {
    await db.incrementDiscountUse(store.id, attempt.discount_code).catch(() => {});
  }

  // Sale ping to the owner's channel, same as a card sale — best-effort, and
  // never allowed to fail the grant that already happened.
  if (store?.notifyChannelId) {
    try {
      const plan = await planOf(store, attempt.plan_id);
      const user = await getUser(attempt.discord_id).catch(() => null);
      const buyer = user?.username ? `@${user.username}` : `<@${attempt.discord_id}>`;
      const coin = String(payment.pay_currency ?? '').toUpperCase();
      await postChannelMessage(store.notifyChannelId, {
        embeds: [{
          title: '🎉 New Subscriber!',
          description:
            `**${buyer}** just subscribed to **${plan?.name ?? attempt.plan_id}**` +
            `${plan?.lifetime ? ' (lifetime)' : ''}.\n\n` +
            `Payment received: **${formatAmount(paidUsd, plan?.currency ?? currency)}**` +
            `${coin ? ` — paid in ${coin}` : ''}`,
          color: 0x5865f2,
          thumbnail: { url: 'https://dues.gg/icon-192.png' },
          footer: { text: store.name ?? config.brand },
          timestamp: new Date().toISOString(),
        }],
      });
    } catch (err) {
      console.error(`[webhooks] nowpayments sale ping for ${orderId} failed: ${err.message}`);
    }
  }
}

// What the buyer's own pay screen polls for. Shaped for a browser, so it
// carries no address, no ids and nothing about the seller's wallet.
export function publicPaymentView(payment, { currency } = {}) {
  const d = describeStatus(payment, { currency });
  return {
    status: String(payment?.payment_status ?? '').toLowerCase(),
    state: d.state,
    message: d.message,
  };
}
