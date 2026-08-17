const $ = (sel) => document.querySelector(sel);

const fmtDate = (unix) =>
  new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtPrice = (usd) => `$${usd.toFixed(2)}`;

const ICON_CARD =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>';
const ICON_CRYPTO =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 8h4a2 2 0 1 1 0 4H9m0 0h5a2 2 0 1 1 0 4H9m2-10v12"/></svg>';
const ICON_CHECK =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.7 2.7L16 9.5"/></svg>';
const ICON_LOCK =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';

const state = {
  plans: [],
  capabilities: { stripe: false, crypto: false },
  server: null,
  platform: { name: 'Ripley' },
  me: { loggedIn: false },
  planId: null,
  method: null,
};

const selectedPlan = () => state.plans.find((p) => p.id === state.planId) ?? state.plans[0];
const ownedSub = (plan) =>
  (state.me.subscriptions ?? []).reduce((best, s) => {
    if (s.planId !== plan.id) return best;
    if (!best || (s.entitled && !best.entitled)) return s;
    return best;
  }, null);

// One clear banner when the setup doctor is failing — a misconfigured
// deployment must never quietly accept money. The public endpoint returns
// only { ok }, no configuration detail.
async function checkSetup() {
  try {
    const { ok } = await (await fetch('/api/setup-check')).json();
    if (ok === false) {
      const banner = document.createElement('div');
      banner.className = 'doctor-banner';
      banner.textContent =
        '⚠ This store is misconfigured — payments may be charged without access being granted. ' +
        'Owner: run `npm run doctor` (or GET /api/setup-check with your CRON_SECRET) and fix the failures before selling.';
      document.body.prepend(banner);
    }
  } catch {
    /* the storefront still works if the check itself is unreachable */
  }
}

function renderAccount() {
  const el = $('#account');
  const me = state.me;
  if (!me.loggedIn) {
    el.innerHTML = '<button class="btn-ghost" id="login">Sign in with Discord</button>';
    $('#login').onclick = () => (window.location.href = '/auth/login');
    return;
  }
  const entitled = (me.subscriptions ?? []).filter((s) => s.entitled);
  const badge = entitled.length ? `<span class="badge">${entitled.map((s) => s.planName).join(' · ')}</span>` : '';
  el.innerHTML = `${badge}<span>@${me.username ?? me.discordId}</span><button class="btn-ghost" id="logout">Sign out</button>`;
  $('#logout').onclick = () => (window.location.href = '/auth/logout');
}

// The one accent phrase in the headline (optional, from plans.json).
function renderTagline(el, text, highlight) {
  el.textContent = '';
  const at = highlight ? text.indexOf(highlight) : -1;
  if (at === -1) {
    el.textContent = text;
    return;
  }
  el.append(document.createTextNode(text.slice(0, at)));
  const hl = document.createElement('span');
  hl.className = 'hl';
  hl.textContent = highlight;
  el.append(hl, document.createTextNode(text.slice(at + highlight.length)));
}

function renderBrand() {
  const plan = selectedPlan();
  if (!plan) return;
  // The server's own Discord icon (animated GIF when the guild has one);
  // /logo.png stays as the fallback when Discord can't be reached.
  if (state.server?.iconUrl) {
    const logo = $('.logo');
    logo.src = state.server.iconUrl;
    logo.alt = state.server.name;
  }
  if (state.server?.name) $('#server-name').textContent = state.server.name;
  $('#plan-name').textContent = plan.name;
  renderTagline($('#plan-desc'), plan.description, plan.descriptionHighlight);
  $('#price').textContent = fmtPrice(plan.priceUsd);
}

function renderOptions() {
  const panel = $('#options-panel');
  // A single-plan catalog needs no chooser — keep the page simple.
  if (state.plans.length < 2) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const box = $('#options');
  box.innerHTML = '';
  for (const plan of state.plans) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `option${plan.id === state.planId ? ' selected' : ''}`;
    row.innerHTML = `
      <span class="opt-name">${plan.lifetime ? 'One Time' : plan.name}<small>${plan.lifetime ? '(lifetime)' : `/ ${plan.interval}`}</small></span>
      <span class="opt-price">${fmtPrice(plan.priceUsd)}</span>`;
    row.onclick = () => {
      state.planId = plan.id;
      render();
    };
    box.append(row);
  }
}

function renderMethods() {
  const box = $('#methods');
  box.innerHTML = '';
  const methods = [];
  if (state.capabilities.crypto) methods.push({ id: 'coinbase', label: 'Crypto', icon: ICON_CRYPTO, badge: '' });
  if (state.capabilities.stripe) methods.push({ id: 'stripe', label: 'Card', icon: ICON_CARD, badge: '<span class="provider-badge">Stripe</span>' });
  if (!methods.some((m) => m.id === state.method)) state.method = methods.at(-1)?.id ?? null;

  for (const m of methods) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `method${m.id === state.method ? ' selected' : ''}`;
    tile.innerHTML = `${m.icon}<span>${m.label}</span>${m.badge}`;
    tile.onclick = () => {
      state.method = m.id;
      render();
    };
    box.append(tile);
  }
}

function renderPayPanel() {
  const plan = selectedPlan();
  const panel = $('#pay-panel');
  if (!plan) {
    panel.hidden = true;
    return;
  }

  // No payment method is live: tell buyers plainly instead of showing a
  // button that can only fail. (The owner sees the red doctor banner too.)
  if (!state.method) {
    panel.hidden = true;
    $('#notice').innerHTML =
      '<div class="callout pending">Checkout is still being set up by the owner — check back soon.</div>';
    return;
  }
  panel.hidden = false;

  const card = state.method === 'stripe';
  $('#pay-title').textContent = card ? 'Pay with Card' : 'Pay with Crypto';
  $('#pay-pill').textContent = '0% added fees';
  $('#pay-sub').textContent = card
    ? 'Pay with card or debit. Payment goes directly to the server owner via Stripe.'
    : 'Pay with crypto via Coinbase Commerce. Payment goes directly to the server owner.';
  $('#trust-row').innerHTML = card
    ? `<span>${ICON_CHECK} Secured by Stripe</span><span>${ICON_LOCK} Encrypted checkout</span>`
    : `<span>${ICON_CHECK} Coinbase Commerce</span><span>${ICON_LOCK} On-chain settlement</span>`;

  renderCta();

  const note = $('#redirect-note');
  const showingPay = Boolean($('#cta-area .pay-btn')) && state.me.loggedIn;
  note.textContent = showingPay
    ? `You'll be redirected to ${card ? "Stripe's" : "Coinbase's"} secure checkout page to complete your payment.`
    : '';
}

function renderCta() {
  const area = $('#cta-area');
  area.innerHTML = '';
  const plan = selectedPlan();
  if (!plan) return;

  // Sign-in comes before purchase, enforced here in the UI as well as by the
  // API's 401: a logged-out visitor never sees a Pay button. The login link
  // carries the plan so the OAuth round trip lands them back here, ready.
  if (!state.me.loggedIn) {
    const btn = document.createElement('button');
    btn.className = 'pay-btn';
    btn.textContent = 'Sign in with Discord to continue';
    btn.onclick = () => (window.location.href = `/auth/login?plan=${encodeURIComponent(plan.id)}`);
    area.append(btn);
    return;
  }

  const sub = ownedSub(plan);
  if (sub?.entitled) {
    const settled = document.createElement('div');
    settled.className = 'settled';
    settled.innerHTML = sub.lifetime
      ? 'Yours — lifetime<small>Nothing to manage. Your access never expires.</small>'
      : `Active until ${fmtDate(sub.currentPeriodEnd)}`;
    area.append(settled);
    return;
  }

  const btn = document.createElement('button');
  btn.className = 'pay-btn';
  btn.textContent = `Pay ${fmtPrice(plan.priceUsd)} with ${state.method === 'coinbase' ? 'Crypto' : 'Card'}`;
  btn.onclick = () => pay(btn, plan);
  area.append(btn);
}

function showPayError(message) {
  $('#cta-area .pay-error')?.remove();
  const err = document.createElement('div');
  err.className = 'pay-error';
  err.textContent = message;
  $('#cta-area').append(err);
}

async function pay(btn, plan) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Redirecting…';
  try {
    const res = await fetch(`/api/checkout/${state.method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: plan.id }),
    });
    if (res.status === 401) {
      window.location.href = `/auth/login?plan=${encodeURIComponent(plan.id)}`;
      return;
    }
    const data = await res.json();
    if (!res.ok || !data.url) throw new Error(data.error || 'Payment could not be started. Try again.');
    window.location.href = data.url;
  } catch (err) {
    showPayError(err.message);
    btn.disabled = false;
    btn.textContent = original;
  }
}

function renderNotice() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') === 'cancelled') {
    $('#notice').innerHTML = '<div class="callout pending">Checkout cancelled — nothing was charged.</div>';
  }
}

function render() {
  renderAccount();
  renderBrand();
  renderOptions();
  renderMethods();
  renderPayPanel();
}

async function main() {
  checkSetup();
  renderNotice();
  const [plansRes, meRes] = await Promise.all([fetch('/api/plans'), fetch('/api/me')]);
  const plansBody = await plansRes.json();
  state.plans = plansBody.plans;
  state.capabilities = plansBody.capabilities;
  state.server = plansBody.server;
  state.platform = plansBody.platform ?? state.platform;
  state.me = await meRes.json();

  // Back from the OAuth round trip (or a shared link): land on that plan,
  // scrolled to the pay button, instead of the top of the page.
  const requested = new URLSearchParams(window.location.search).get('plan');
  const requestedPlan = state.plans.find((p) => p.id === requested);
  state.planId = requestedPlan?.id ?? state.plans[0]?.id ?? null;
  render();
  if (requestedPlan && state.me.loggedIn) {
    $('#cta-area')?.scrollIntoView({ block: 'center' });
    $('#cta-area .pay-btn')?.focus({ preventScroll: true });
  }
}

main();
