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
//
// Answers with what happened, because the caller's reply depends on it:
//   'granted'      the sale landed here, just now — the one-and-only time
//   'already'      the order was completed earlier; nothing to do twice
//   'undelivered'  the money landed and could not be delivered; the seller
//                  has been told, once, and the order is closed
//   'in-progress'  another invocation holds the claim on this very work
//   'pending' | 'short' | 'dead' | 'ignored'   nothing to grant (yet, or ever)
//
// How long a claim on the finished work may stand with the order still open
// before a later delivery may take it over — see below.
export const STALE_CLAIM = 5 * 60;

// The idempotency claim lives HERE and is keyed on the payment id plus the
// outcome, never on the IPN body's status. NOWPayments delivers one IPN per
// transition, each re-read here answers with the payment's CURRENT state, so
// on a fast chain several deliveries all read `finished` — a claim per
// delivery let each of them run the completion side effects again. The work
// is claimed instead: one grant, one discount use, one sale ping per
// payment, whichever delivery (or the cron's backfill) got there first.
export async function processNowPayment(payment) {
  const orderId = String(payment?.order_id ?? '').trim();
  const status = String(payment?.payment_status ?? '').toLowerCase();
  if (!orderId) {
    console.warn(`[webhooks] nowpayments ${payment?.payment_id}: payment without order_id, ignoring`);
    return 'ignored';
  }
  // The order row is the ONLY link from "money arrived" back to which buyer
  // bought which product: the IPN carries our order id and nothing else.
  const attempt = await db.getCheckoutAttempt(orderId);
  if (!attempt) {
    console.warn(`[webhooks] nowpayments ${payment.payment_id}: order ${orderId} is not one of ours, ignoring`);
    return 'ignored';
  }
  const store = attempt.store_id === null || attempt.store_id === undefined
    ? defaultStore()
    : await storeById(attempt.store_id);

  if (!GRANTS_ACCESS.has(status)) {
    // Logged rather than silent: a seller asking "where is my sale?" needs
    // the shortfall to be findable, and a short payment is the one failure
    // mode that looks identical to success from the buyer's side.
    if (SHORT.has(status)) {
      // The figure is quoted only when the provider reported one. Deriving it
      // from the coin ratio assumes the deposit was in the coin the invoice
      // asked for, which is exactly what an underpayment may not have been.
      const settled = settledFiat(payment);
      const total = `${Number(payment.price_amount ?? 0).toFixed(2)} ${normalizeCurrency(payment.price_currency ?? attempt.currency).toUpperCase()}`;
      console.warn(
        `[webhooks] nowpayments ${payment.payment_id} (order ${orderId}) is short: ` +
          (settled === null
            ? `the provider did not report what the deposit was worth, against ${total} owed`
            : `${settled.toFixed(2)} of ${total} received`) +
          ' — no access granted',
      );
    } else if (DEAD.has(status)) {
      console.warn(`[webhooks] nowpayments ${payment.payment_id} (order ${orderId}) ended as ${status} — no access granted`);
    } else if (!IN_FLIGHT.has(status)) {
      // A status none of the sets know — a new one from the provider, or a
      // re-read that came back without one. The buyer's screen shows it as
      // "checking", so this line is the only trace an operator will have.
      console.warn(`[webhooks] nowpayments ${payment.payment_id} (order ${orderId}) has unrecognised status "${status}" — no access granted, needs a look`);
    }
    return SHORT.has(status) ? 'short' : DEAD.has(status) ? 'dead' : 'pending';
  }

  // Completed — by an earlier delivery or by the cron — is the same sale
  // again under another delivery. (The attempt is marked completed only
  // AFTER the grant lands, below, so a delivery that died before it can
  // still be retried.)
  if (attempt.status === 'completed') return 'already';

  // Money that landed and could not be delivered was answered once, in the
  // seller's channel, and the order closed. That answer is terminal: nothing
  // re-announces it, so a replayed IPN cannot post the same red embed again,
  // and — the reason it matters — a guard that happens to pass again days
  // later cannot grant a sale the seller was told to refund. Delivering it
  // anyway stays available as what it should be: the seller's deliberate
  // call, from Members.
  if (attempt.status === 'undelivered') return 'undelivered';

  // Retakeable: a claim this old whose order is still not completed was left
  // by an invocation the platform killed before its catch could release it.
  // Longer than any invocation can live (the function limit is 60s), so a
  // live one is never stomped.
  const claim = `${payment.payment_id}:finished`;
  if (!(await db.claimEvent('nowpayments', claim, null, { retakeAfter: STALE_CLAIM }))) return 'in-progress';
  try {
    return await settle(payment, attempt, store, orderId);
  } catch (err) {
    await db.releaseEvent('nowpayments', claim);
    throw err;
  }
}

async function settle(payment, attempt, store, orderId) {
  const currency = normalizeCurrency(payment.price_currency ?? attempt.currency);
  // What the order was for, not what the coin was worth: price_amount is the
  // fiat figure the invoice was created against, and it is the number the
  // seller's books, the sale ping and the member row all have to agree on.
  const paidUsd = Number(payment.price_amount ?? attempt.amount_usd ?? 0);
  const coin = String(payment.pay_currency ?? '').toUpperCase();

  // Money that landed but cannot be delivered. Crypto has no chargeback and
  // the coins are already forwarded to the seller's wallet, so the only
  // honest outcome is: nothing granted, the order closed as 'undelivered'
  // (never 'completed' — that word means the buyer got what they paid for),
  // the discount use not burned, and the SELLER told in the channel where a
  // sale ping would otherwise have landed. Best-effort like the sale ping.
  //
  // Closing the row is what makes the answer once-only. Left open it was
  // re-asked by the hourly cron for the whole seven-day backfill window: the
  // same red embed to the seller every hour, counted as a recovered sale
  // every hour, and granted on its own the moment the blocking condition
  // happened to clear — after the seller had been told to refund. The flip is
  // the once-only signal here, exactly as markCheckoutCompleted is for the
  // sale ping.
  const alertUndelivered = async (why, hint) => {
    const first = await db.markCheckoutUndelivered(orderId);
    console.error(`[webhooks] nowpayments ${payment.payment_id} (order ${orderId}): ${attempt.discord_id} paid for "${attempt.plan_id}" but ${why} — nothing delivered, seller alerted`);
    if (!first || !store?.notifyChannelId) return;
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
    return 'undelivered';
  }
  const blocked = await purchaseBlocked({ store, plan, uid: attempt.discord_id, atSettlement: true });
  if (blocked) {
    await alertUndelivered(
      `the sale is not allowed any more (${blocked.error.replace(/\.$/, '')})`,
      'Refund them from your wallet, or add them from Members if the sale should stand.',
    );
    return 'undelivered';
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
    return 'undelivered';
  }

  // The row flip is the once-only signal: only the call that moved the order
  // from started to completed counts the discount use and pings the seller.
  // A throw here releases the claim and 5xxs the delivery; the retry finds
  // the subscription row upserted and flips the order then.
  const flipped = await db.markCheckoutCompleted(orderId);
  if (!flipped) return 'granted';
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
  return 'granted';
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
