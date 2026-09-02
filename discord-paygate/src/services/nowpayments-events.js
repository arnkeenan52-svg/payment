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
//
// Answers with what happened, because the caller's reply depends on it:
//   'granted'      the sale landed here, just now — the one-and-only time
//   'already'      the order was completed earlier; nothing to do twice
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
      console.warn(
        `[webhooks] nowpayments ${payment.payment_id} (order ${orderId}) is short: ` +
          `${settledFiat(payment).toFixed(2)} of ${Number(payment.price_amount ?? 0).toFixed(2)} ` +
          `${normalizeCurrency(payment.price_currency ?? attempt.currency).toUpperCase()} received — no access granted`,
      );
    } else if (DEAD.has(status)) {
      console.warn(`[webhooks] nowpayments ${payment.payment_id} (order ${orderId}) ended as ${status} — no access granted`);
    }
    return SHORT.has(status) ? 'short' : DEAD.has(status) ? 'dead' : 'pending';
  }

  // Completed — by an earlier delivery or by the cron — is the same sale
  // again under another delivery. (The attempt is marked completed only
  // AFTER the grant lands, below, so a delivery that died before it can
  // still be retried.)
  if (attempt.status === 'completed') return 'already';

  // Retakeable: a claim this old whose order is still not completed was left
  // by an invocation the platform killed before its catch could release it.
  // Longer than any invocation can live (the function limit is 60s), so a
  // live one is never stomped.
  const claim = `${payment.payment_id}:finished`;
  if (!(await db.claimEvent('nowpayments', claim, null, { retakeAfter: STALE_CLAIM }))) return 'in-progress';
  try {
    await settle(payment, attempt, store, orderId);
    return 'granted';
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

  // The row flip is the once-only signal: only the call that moved the order
  // from started to completed counts the discount use and pings the seller.
  // A throw here releases the claim and 5xxs the delivery; the retry finds
  // the subscription row upserted and flips the order then.
  const flipped = await db.markCheckoutCompleted(orderId);
  if (!flipped) return;
  // grant() answers null, without throwing, for a plan the store no longer
  // has: money forwarded on-chain, nothing delivered. Not a use of the code
  // and not a "new subscriber" — the seller is told what actually happened.
  if (landed && attempt.discount_code && store?.id !== null && store?.id !== undefined) {
    await db.incrementDiscountUse(store.id, attempt.discount_code).catch(() => {});
  }
  if (!landed) {
    console.error(`[webhooks] nowpayments ${payment.payment_id}: ${attempt.discord_id} paid for "${attempt.plan_id}", which store ${store?.slug ?? 'default'} no longer has — seller alerted`);
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
          title: landed ? '🎉 New Subscriber!' : '⚠️ Paid for a product that no longer exists',
          description: landed
            ? `**${buyer}** just subscribed to **${plan?.name ?? attempt.plan_id}**` +
              `${plan?.lifetime ? ' (lifetime)' : ''}.\n\n` +
              `Payment received: **${formatAmount(paidUsd, plan?.currency ?? currency)}**` +
              `${coin ? ` — paid in ${coin}` : ''}`
            : `**${buyer}** paid **${formatAmount(paidUsd, currency)}**${coin ? ` in ${coin}` : ''} for **${attempt.plan_id}**, which is no longer in this store — nothing was delivered. The funds are in your payout wallet; re-create the product with the same link and re-sync them, or refund them yourself.`,
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
