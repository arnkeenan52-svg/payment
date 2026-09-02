const $ = (sel) => document.querySelector(sel);
// Same rule as the storefront: the amount carries its own currency, and a
// zero-decimal one must not be printed with cents it does not have.
let PAGE_CURRENCY = 'usd';
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'vnd', 'vuv', 'xaf', 'xof', 'xpf', 'isk', 'ugx']);
const fmtPrice = (amount, cur = PAGE_CURRENCY) => {
  const c = String(cur ?? PAGE_CURRENCY).toLowerCase();
  const dp = ZERO_DECIMAL.has(c) ? 0 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: c.toUpperCase(),
      minimumFractionDigits: dp, maximumFractionDigits: dp,
    }).format(Number(amount));
  } catch {
    return `${c.toUpperCase()} ${Number(amount).toFixed(dp)}`;
  }
};

// Success is only claimed once the role has actually landed: we poll /api/me
// until the plan's subscription shows up entitled (the webhook grants it
// within seconds; Stripe redirects can outrun it).
const POLL_MS = 2000;
const GIVE_UP_MS = 90 * 1000;

function renderAccount(me) {
  const el = $('#account');
  if (!me.loggedIn) {
    el.innerHTML = '<button class="btn-ghost" id="login">Sign in with Discord</button>';
    $('#login').onclick = () => (window.location.href = '/auth/login');
    return;
  }
  el.innerHTML = `<span>@${String(me.username ?? me.discordId).replace(/[&<>"']/g, '')}</span>`;
}

const serverLabel = (server) => server.name || 'the server';

function showConfirmed(plan, server) {
  $('#check-ring').classList.remove('pending');
  $('#r-heading').textContent = 'Thank you for your purchase';
  $('#r-sub').textContent = 'Payment confirmed — welcome in.';
  // Same @Name-exactly-once convention as every other role render.
  const roles = plan.roleNames.length ? plan.roleNames.map((r) => `@${String(r ?? '').replace(/^@+/, '')}`).join(', ') : 'Your role';
  const callout = $('#r-callout');
  callout.classList.remove('pending');
  callout.textContent = `${roles} was assigned automatically — your channels in ${serverLabel(server)} are unlocked.`;
}

function showStillPending(server) {
  $('#r-sub').textContent = 'Payment received — your role is on its way.';
  $('#r-callout').textContent =
    `This is taking a little longer than usual. Your role lands automatically as soon as the payment ` +
    `provider confirms — no action needed. Check ${serverLabel(server)} again in a minute.`;
}

// A receipt URL with no order behind it — no store, an unknown store, or no
// ?plan. Bailing out silently left the page on "Payment received / Finishing
// up your order…" with a pulsing ring and a dash in every field, forever: a
// payment-shaped promise about an order that does not exist. Say so instead.
function showNotFound() {
  // display:flex on the ring outranks the UA's [hidden] rule, so the style wins.
  $('#check-ring').style.display = 'none';
  $('#r-heading').textContent = 'No order to show';
  $('#r-sub').textContent = 'This link does not point at a purchase.';
  $('#r-details').hidden = true;
  const callout = $('#r-callout');
  callout.classList.remove('pending');
  callout.innerHTML =
    'Check the link your community sent you. If you have already paid, your purchases are listed under <a href="/account">My account</a>.';
}

async function main() {
  const STORE_SLUG = new URLSearchParams(location.search).get('store') ?? '';
  const storeQS = /^[a-z0-9-]{1,40}$/.test(STORE_SLUG) ? `?store=${encodeURIComponent(STORE_SLUG)}` : '';
  // Back to THIS buyer's store; /store stays as the legacy-redirect fallback.
  if (storeQS) {
    const back = document.getElementById('back-store');
    if (back) back.href = `/${encodeURIComponent(STORE_SLUG)}`;
  }
  const [plansRes, meRes] = await Promise.all([fetch(`/api/plans${storeQS}`), fetch('/api/me')]);
  let me = await meRes.json();
  renderAccount(me);
  if (!plansRes.ok) return showNotFound(); // an unknown store: nothing to name and nothing to poll for
  const plansBody = await plansRes.json();
  const plans = plansBody.plans ?? [];
  const server = plansBody.server ?? {};
  // Plan ids are unique only WITHIN a store ("vip" exists in many), so every
  // look at the buyer's own rows is scoped to this store — never another
  // seller's product, price or role on this seller's receipt.
  const STORE = String(plansBody.store?.slug ?? STORE_SLUG);
  const mine = (s) => s.storeSlug === STORE;

  const requested = new URLSearchParams(window.location.search).get('plan');
  // No `?? plans[0]`. That named the store's FIRST product, at its price, on
  // the receipt for whatever was actually bought whenever the bought product
  // had since been taken off sale. Better to say less than to say wrong.
  // A product since taken off sale is absent from /api/plans, but the buyer's
  // own subscription row still names it — and the confirmed screen reads its
  // roleNames, which the bare placeholder never carried (it threw instead).
  const owned = (me.subscriptions ?? []).find((s) => mine(s) && s.planId === requested);
  // The currency comes from the buyer's own row first: with every product
  // taken off sale there is no catalogue left to borrow a symbol from.
  const plan = plans.find((p) => p.id === requested)
    ?? (requested ? { id: requested, name: owned?.planName ?? 'Your purchase', roleNames: owned?.roleNames ?? [], lifetime: owned?.lifetime ?? false, interval: '', priceUsd: null, currency: owned?.currency ?? plans[0]?.currency } : null);
  if (!plan) return showNotFound();

  $('#r-server').textContent = server.name || '—';
  $('#r-product').textContent = plan.name;
  $('#r-option').textContent = plan.lifetime ? 'One-time — lifetime access' : plan.interval ? `Recurring — per ${plan.interval}` : '';
  // The charged amount (discounts applied) beats the list price the moment
  // the buyer's subscription row lands; until then the list price stands in.
  const paidFor = (m) => (m.subscriptions ?? []).find((s) => mine(s) && s.planId === plan.id && s.paidUsd !== null && s.paidUsd !== undefined);
  PAGE_CURRENCY = String(plan.currency ?? PAGE_CURRENCY).toLowerCase();
  const renderTotal = (m) => {
    const v = paidFor(m)?.paidUsd ?? plan.priceUsd;
    $('#r-total').textContent = v === null || v === undefined ? '—' : fmtPrice(v, plan.currency);
  };
  renderTotal(me);
  $('#open-discord-label').textContent = server.name ? `Open ${server.name} on Discord` : 'Open Discord';
  if (server.guildId) $('#open-discord').href = `https://discord.com/channels/${server.guildId}`;

  const entitled = () => (me.subscriptions ?? []).some((s) => mine(s) && s.planId === plan.id && s.entitled);
  const started = Date.now();
  while (!entitled() && Date.now() - started < GIVE_UP_MS) {
    if (!me.loggedIn) break; // can't observe the grant without a session — stay in pending copy
    await new Promise((r) => setTimeout(r, POLL_MS));
    me = await (await fetch('/api/me')).json();
  }

  renderTotal(me);
  if (entitled()) showConfirmed(plan, server);
  else showStillPending(server);
}

main();
