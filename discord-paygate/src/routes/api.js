import { config, planById } from '../config.js';
import { sendJson, readJsonBody } from '../lib/http.js';
import { sessionUserId } from '../lib/session.js';
import { getUser, subscriptionsForMember, isEntitled } from '../db.js';
import { createCheckoutSession } from '../lib/stripe.js';
import { createCharge } from '../lib/coinbase.js';

export function handlePlans(req, res) {
  sendJson(res, 200, {
    brand: config.brand,
    plans: config.plans.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      priceUsd: p.priceUsd,
      interval: p.interval,
      lifetime: Boolean(p.lifetime),
    })),
  });
}

export function handleMe(req, res) {
  const uid = sessionUserId(req);
  if (!uid) {
    sendJson(res, 200, { loggedIn: false });
    return;
  }
  const user = getUser(uid);
  // Lapsed rows are included too (entitled: false) so the storefront can show
  // "expired on …" on a plan card instead of pretending it was never bought.
  const subs = subscriptionsForMember(uid).map((s) => ({
    planId: s.plan_id,
    planName: planById(s.plan_id)?.name ?? s.plan_id,
    provider: s.provider,
    status: s.status,
    entitled: isEntitled(s),
    lifetime: s.status === 'active' && s.current_period_end === null,
    currentPeriodEnd: s.current_period_end,
    graceUntil: s.grace_until,
  }));
  sendJson(res, 200, { loggedIn: true, discordId: uid, username: user?.username ?? null, subscriptions: subs });
}

async function checkoutPlan(req, res) {
  const uid = sessionUserId(req);
  if (!uid) {
    sendJson(res, 401, { error: 'log in with Discord first' });
    return null;
  }
  const body = await readJsonBody(req).catch(() => null);
  const plan = body?.planId ? planById(body.planId) : null;
  if (!plan) {
    sendJson(res, 400, { error: 'unknown plan' });
    return null;
  }
  return { uid, plan };
}

export async function handleStripeCheckout(req, res) {
  const ctx = await checkoutPlan(req, res);
  if (!ctx) return;
  const session = await createCheckoutSession({ plan: ctx.plan, discordId: ctx.uid });
  sendJson(res, 200, { url: session.url });
}

export async function handleCoinbaseCheckout(req, res) {
  const ctx = await checkoutPlan(req, res);
  if (!ctx) return;
  const charge = await createCharge({ plan: ctx.plan, discordId: ctx.uid });
  sendJson(res, 200, { url: charge.hosted_url });
}
