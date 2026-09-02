import { config } from '../config.js';
import * as db from '../db.js';
import { getUser } from '../db.js';
import { grant } from './entitlements.js';
import { storeById, defaultStore, planOf } from './stores.js';
import { postChannelMessage } from '../lib/discord.js';
import { formatAmount, normalize as normalizeCurrency } from '../lib/currency.js';
import { GRANTS_ACCESS, IN_FLIGHT, SHORT, DEAD, settledFiat, describeStatus } from '../lib/nowpayments.js';
import { purchaseBlocked } from './purchase-guard.js';

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
    } else if (!IN_FLIGHT.has(status)) {
      // A status none of the sets know — a new one from the provider, or a
      // re-read that came back without one. The buyer's screen shows it as
      // "checking", so this line is the only trace an operator will have.
      console.warn(`[webhooks] nowpayments ${payment.payment_id} (order ${orderId}) has unrecognised status "${status}" — no access granted, needs a look`);
    }
    return;
  }

  const currency = normalizeCurrency(payment.price_currency ?? attempt.currency);
  // What the order was for, not what the coin was worth: price_amount is the
  // fiat figure the invoice was created against, and it is the number the
  // seller's books, the sale ping and the member row all have to agree on.
  const paidUsd = Number(payment.price_amount ?? attempt.amount_usd ?? 0);
  const coin = String(payment.pay_currency ?? '').toUpperCase();

  // Money that landed but cannot be delivered. Crypto has no chargeback and
  // the coins are already forwarded to the seller's wallet, so the only
  // honest outcome is: nothing granted, the order left open (never
  // 'completed' — that word means the buyer got what they paid for), the
  // discount use not burned, and the SELLER told in the channel where a sale
  // ping would otherwise have landed. Best-effort like the sale ping.
  const alertUndelivered = async (why, hint) => {
    console.error(`[webhooks] nowpayments ${payment.payment_id} (order ${orderId}): ${attempt.discord_id} paid for "${attempt.plan_id}" but ${why} — nothing delivered, seller alerted`);
    if (!store?.notifyChannelId) return;
    try {
      const user = await getUser(attempt.discord_id).catch(() => null);
      const buyer = user?.username ? `@${user.username}` : `<@${attempt.discord_id}>`;
      await postChannelMessage(store.notifyChannelId, {
        embeds: [{
          title: '⚠️ Paid, but nothing was delivered',
          description:
            `**${buyer}** paid **${formatAmount(paidUsd, currency)}**${coin ? ` in ${coin}` : ''} for **${attempt.plan_id}**, ` +
            `but ${why}. Nothing was delivered. ${hint}`,
          color: 0xed4245,
          thumbnail: { url: 'https://dues.gg/icon-192.png' },
          footer: { text: store.name ?? config.brand },
          timestamp: new Date().toISOString(),
        }],
      });
    } catch (err) {
      console.error(`[webhooks] nowpayments undelivered alert for ${orderId} failed: ${err.message}`);
    }
  };

  // The rules that gated the sale at checkout, asked again now that the
  // money has arrived. A crypto invoice can sit open for hours, and in that
  // time the product can be switched off, reach its end date, sell out, or
  // the buyer can leave the server that gated it. The card rail's session
  // lives minutes, so it does not need this; here the answer at invoice time
  // is no proof of the answer at settlement.
  const plan = await planOf(store, attempt.plan_id);
  if (!plan) {
    await alertUndelivered(
      'that product is no longer in this store',
      'Refund them from your wallet, or re-create the product with the same link and add them from Members.',
    );
    return;
  }
  const blocked = await purchaseBlocked({ store, plan, uid: attempt.discord_id, atSettlement: true });
  if (blocked) {
    await alertUndelivered(
      `the sale is not allowed any more (${blocked.error.replace(/\.$/, '')})`,
      'Refund them from your wallet, or add them from Members if the sale should stand.',
    );
    return;
  }

  const landed = await grant({
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
  // grant() answers null, without throwing, when the plan vanished between
  // the check above and the write. Same outcome as an unknown plan.
  if (!landed) {
    await alertUndelivered(
      'that product is no longer in this store',
      'Refund them from your wallet, or re-create the product with the same link and add them from Members.',
    );
    return;
  }

  await db.markCheckoutCompleted(orderId).catch(() => {});
  if (attempt.discount_code && store?.id !== null && store?.id !== undefined) {
    await db.incrementDiscountUse(store.id, attempt.discount_code).catch(() => {});
  }

  // Sale ping to the owner's channel, same as a card sale — best-effort, and
  // never allowed to fail the grant that already happened.
  if (store?.notifyChannelId) {
    try {
      const user = await getUser(attempt.discord_id).catch(() => null);
      const buyer = user?.username ? `@${user.username}` : `<@${attempt.discord_id}>`;
      await postChannelMessage(store.notifyChannelId, {
        embeds: [{
          title: '🎉 New Subscriber!',
          description:
            `**${buyer}** just subscribed to **${plan.name}**` +
            `${plan.lifetime ? ' (lifetime)' : ''}.\n\n` +
            `Payment received: **${formatAmount(paidUsd, plan.currency ?? currency)}**` +
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
//
// `delivered` is whether OUR order row is completed. The provider saying
// `finished` is the money; the role is what they bought, and the screen
// only says "confirmed" — and sends them to the receipt — once the grant has
// actually landed. Until then (the IPN still on its way, or a settlement
// that could not deliver) the honest state is still pending.
export function publicPaymentView(payment, { currency, delivered } = {}) {
  const d = describeStatus(payment, { currency });
  if (d.state === 'paid' && delivered === false) {
    return {
      status: String(payment?.payment_status ?? '').toLowerCase(),
      state: 'pending',
      message: 'Payment received — checking on delivery…',
    };
  }
  return {
    status: String(payment?.payment_status ?? '').toLowerCase(),
    state: d.state,
    message: d.message,
  };
}
