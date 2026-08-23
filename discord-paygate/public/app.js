const $ = (sel) => document.querySelector(sel);
// Which store this page shows: /<slug> (or legacy /s/<slug>). Every store —
// the platform's own included — lives at its unique slug; there is no
// special path that belongs to any store.
const STORE_SLUG =
  (location.pathname.match(/^\/s\/([a-z0-9-]+)$/) ?? [])[1] ??
  ((location.pathname.match(/^\/([a-z0-9-]+)$/) ?? [])[1] ?? '');
const storeQS = STORE_SLUG ? `?store=${encodeURIComponent(STORE_SLUG)}` : '';
const loginStoreQ = STORE_SLUG ? `&store=${encodeURIComponent(STORE_SLUG)}` : '';

const fmtDate = (unix) =>
  new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtPrice = (usd) => `$${usd.toFixed(2)}`;
// Product names and usernames are other people's text — escape everything
// that rides into innerHTML, no exceptions.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  view: 'checkout',
  store: null,
  brand: null,
  server: null,
  platform: { name: 'Ripley' },
  me: { loggedIn: false },
  planId: null,
  method: null,
  // Set by the Apply button after the server confirms the code for the
  // selected plan: { code, planId, discountedUsd, saveUsd }.
  discount: null,
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
  if (STORE_SLUG) return;
  try {
    const { ok } = await (await fetch('/api/setup-check')).json();
    if (ok === false) {
      const banner = document.createElement('div');
      banner.className = 'doctor-banner';
      banner.append(
        document.createTextNode(
          '⚠ This store is misconfigured — payments may be charged without access being granted. ',
        ),
      );
      const link = document.createElement('a');
      link.href = '/dashboard';
      link.textContent = 'Owner: open the dashboard →';
      banner.append(link);
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
    el.innerHTML = '<button class="btn-pill" id="login">Sign in with Discord</button>';
    $('#login').onclick = () => (window.location.href = `/auth/login?x=1${loginStoreQ}`);
    return;
  }
  const entitled = (me.subscriptions ?? []).filter((s) => s.entitled);
  const badge = entitled.length ? `<span class="badge">${entitled.map((s) => s.planName).join(' · ')}</span>` : '';
  const links = `<a class="nav-link" href="/account">Account</a>${me.isOwner ? '<a class="nav-link" href="/dashboard">Dashboard</a>' : ''}`;
  el.innerHTML = `${badge}${links}<span>@${esc(me.username ?? me.discordId)}</span><button class="btn-ghost" id="logout">Sign out</button>`;
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
  // Product thumbnail: the tenant product's own image; the built-in store
  // keeps its bundled animated shot. Nothing renders when there is none.
  const shot = $('#product-shot');
  if (shot) {
    // Tenant stores show their own product image or nothing; only the legacy
    // built-in store falls back to its shipped art. Never another store's.
    const art = STORE_SLUG ? plan.imageUrl : (plan.imageUrl ?? '/product.gif');
    if (art) {
      shot.src = art;
      shot.hidden = false;
    } else shot.hidden = true;
  }
  // ONLY the server's own Discord icon (animated GIF when the guild has
  // one) is ever shown — no stand-in logo. Hidden until Discord answers.
  // Selected by its own class: the shop view's .logo sits earlier in the DOM.
  const logo = $('.op-server-icon');
  if (state.server?.iconUrl) {
    logo.src = state.server.iconUrl;
    logo.alt = state.server.name ?? '';
    logo.hidden = false;
  } else {
    logo.hidden = true;
  }
  // Never render filler as though it were real content: the line shows only
  // when Discord (or an explicit env override) gave us an actual name.
  const nameEl = $('#server-name');
  if (state.server?.name) {
    nameEl.textContent = state.server.name;
    nameEl.hidden = false;
    document.title = `${state.server.name} — Checkout`;
  } else {
    nameEl.hidden = true;
  }
  $('#plan-name').textContent = plan.name;
  renderTagline($('#plan-desc'), plan.description, plan.descriptionHighlight);
  $('#price').textContent = fmtPrice(plan.priceUsd);
  // Roles the buyer receives, as blurple chips — Discord's own concept in
  // Discord's own color.
  const rolesBox = $('#roles-box');
  const chips = $('#roles-chips');
  if (rolesBox && chips) {
    const names = plan.roleNames ?? [];
    if (names.length) {
      chips.innerHTML = names.map((n) => `<span class="chip">${n.replace(/[&<>"']/g, '')}</span>`).join('');
      rolesBox.hidden = false;
    } else rolesBox.hidden = true;
  }
  // Discount codes exist on onboarded stores only.
  const df = $('#discount-field');
  if (df) df.hidden = !STORE_SLUG;
}

function renderOptions() {
  const box = $('#options');
  box.innerHTML = '';
  for (const plan of state.plans) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `option${plan.id === state.planId ? ' selected' : ''}`;
    row.innerHTML = `
      <span class="opt-name">${esc(plan.lifetime ? (state.plans.length > 1 ? plan.name : 'One Time') : plan.name)}<small>${plan.lifetime ? '(lifetime)' : `/ ${esc(plan.interval)}`}</small></span>
      <span class="opt-price">${fmtPrice(plan.priceUsd)}</span>`;
    row.onclick = () => {
      state.planId = plan.id;
      render();
      // A code applied to the old plan is re-checked against the new one.
      if (state.discount && state.discount.planId !== plan.id) applyDiscount();
    };
    box.append(row);
  }
}

function renderMethods() {
  const box = $('#methods');
  box.innerHTML = '';
  const methods = [];
  if (state.capabilities.crypto) methods.push({ id: 'coinbase', html: `${ICON_CRYPTO}<span>Crypto</span>` });
  if (state.capabilities.stripe) methods.push({ id: 'stripe', html: `${ICON_CARD}<span>Card</span>` });
  if (!methods.some((m) => m.id === state.method)) state.method = methods.at(-1)?.id ?? null;

  for (const m of methods) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `method${m.id === state.method ? ' selected' : ''}`;
    tile.innerHTML = m.html;
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
      '<div class="callout pending">The owner is still setting up checkout. Check back soon.</div>';
    return;
  }
  panel.hidden = false;

  const card = state.method === 'stripe';
  $('#pay-title').textContent = card ? 'Pay with Card' : 'Pay with Crypto';
  $('#pay-sub').textContent = card
    ? 'Secure payment processed by Stripe'
    : 'Secure payment processed by Coinbase Commerce';
  $('#trust-row').innerHTML = card
    ? `<span>${ICON_CHECK} Secured by Stripe</span><span>${ICON_LOCK} 100% Secure</span>`
    : `<span>${ICON_CHECK} Coinbase Commerce</span><span>${ICON_LOCK} 100% Secure</span>`;

  renderCta();

  const note = $('#redirect-note');
  const showingPay = Boolean($('#cta-area .pay-btn')) && state.me.loggedIn;
  note.textContent = showingPay
    ? `${card ? 'Stripe' : 'Coinbase'}’s secure checkout opens next to finish your payment.`
    : '';
}

// Order-summary rows above the pay action (checkout blueprint): subtotal,
// the applied discount as a negative line, a dashed rule, then the total.
function renderTotals(plan, applied, payable) {
  const box = $('#totals');
  if (!box) return;
  if (!plan || !payable) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('#tot-sub').textContent = fmtPrice(plan.priceUsd);
  const saveRow = $('#tot-save-row');
  if (applied) {
    saveRow.hidden = false;
    $('#tot-save-label').textContent = `Discount (${applied.code})`;
    $('#tot-save').textContent = `−${fmtPrice(applied.saveUsd)}`;
  } else saveRow.hidden = true;
  $('#tot-final').textContent = fmtPrice(applied ? applied.discountedUsd : plan.priceUsd);
}

function renderCta() {
  const area = $('#cta-area');
  area.innerHTML = '';
  const plan = selectedPlan();
  if (!plan) {
    renderTotals(null, null, false);
    return;
  }

  // Sign-in comes before purchase, enforced here in the UI as well as by the
  // API's 401: a logged-out visitor never sees a Pay button. The login link
  // carries the plan so the OAuth round trip lands them back here, ready.
  // The demo store is the exception — nothing is for sale, so anonymous
  // visitors see the real Pay button and pay() shows the demo notice.
  if (!state.me.loggedIn && !state.capabilities.demo) {
    renderTotals(plan, state.discount && state.discount.planId === plan.id ? state.discount : null, true);
    const btn = document.createElement('button');
    btn.className = 'pay-btn';
    btn.textContent = 'Sign in with Discord to continue';
    btn.onclick = () => (window.location.href = `/auth/login?plan=${encodeURIComponent(plan.id)}${loginStoreQ}`);
    area.append(btn);
    return; // no extra note — the reference keeps this area clean
  }

  const sub = ownedSub(plan);
  if (sub?.entitled) {
    renderTotals(plan, null, false);
    const settled = document.createElement('div');
    settled.className = 'settled';
    settled.innerHTML = sub.lifetime
      ? 'Yours — lifetime<small>Nothing to manage. Your access never expires.</small>'
      : `Active until ${fmtDate(sub.currentPeriodEnd)}`;
    area.append(settled);
    return;
  }

  const applied = state.discount && state.discount.planId === plan.id ? state.discount : null;
  renderTotals(plan, applied, true);
  const btn = document.createElement('button');
  btn.className = 'pay-btn';
  btn.textContent = `Pay ${fmtPrice(applied ? applied.discountedUsd : plan.priceUsd)} with ${state.method === 'coinbase' ? 'Crypto' : 'Card'}`;
  btn.onclick = () => pay(btn, plan);
  area.append(btn);
}

// The Apply button: confirm the code with the server and show the buyer the
// real discounted total before they ever reach Stripe.
async function applyDiscount() {
  const input = $('#discount-code');
  const btn = $('#discount-apply');
  const msg = $('#discount-msg');
  const plan = selectedPlan();
  if (!input || !plan) return;
  const code = input.value.trim().toUpperCase();
  if (!code) {
    state.discount = null;
    msg.textContent = 'Enter a code first.';
    msg.className = 'discount-msg err';
    renderCta();
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const res = await fetch(
      `/api/discount?store=${encodeURIComponent(STORE_SLUG)}&code=${encodeURIComponent(code)}&plan=${encodeURIComponent(plan.id)}`,
    );
    let data = {};
    try {
      data = JSON.parse(await res.text());
    } catch {
      data = {};
    }
    if (!res.ok) throw new Error(data.error || 'That discount code is not valid for this product.');
    state.discount = { code, planId: plan.id, discountedUsd: data.discountedUsd, saveUsd: data.saveUsd };
    msg.textContent = `${code} applied. You save ${fmtPrice(data.saveUsd)} — new total ${fmtPrice(data.discountedUsd)}.`;
    msg.className = 'discount-msg ok';
  } catch (err) {
    state.discount = null;
    msg.textContent = err.message;
    msg.className = 'discount-msg err';
  }
  btn.disabled = false;
  btn.textContent = 'Apply';
  syncDiscountSummary();
  renderCta();
}

// The dropdown's label shows the applied code even while collapsed.
function syncDiscountSummary() {
  const summary = $('#discount-summary');
  if (!summary) return;
  summary.textContent = state.discount ? `Discount applied — ${state.discount.code}` : 'Have a discount code?';
}

function wireDiscount() {
  const input = $('#discount-code');
  const btn = $('#discount-apply');
  const msg = $('#discount-msg');
  if (!input || !btn) return;
  btn.onclick = () => applyDiscount();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyDiscount();
    }
  });
  // Editing the code voids the previous approval until Apply is hit again.
  input.addEventListener('input', () => {
    if (state.discount) {
      state.discount = null;
      msg.textContent = '';
      msg.className = 'discount-msg';
      syncDiscountSummary();
      renderCta();
    }
  });
}

// Reference-style error panel below the pay card: heading, message,
// Try Again (re-runs the same payment) and Dismiss.
function showPayError(message, retry) {
  const slot = $('#error-slot');
  slot.innerHTML = `
    <div class="error-panel" role="alert">
      <p class="error-head">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 7v6"/><circle cx="12" cy="16.6" r="0.5" fill="currentColor"/></svg>
        Payment Error
      </p>
      <p class="error-msg"></p>
      <div class="error-actions">
        <button class="try-again" type="button">Try Again</button>
        <button class="dismiss" type="button">Dismiss</button>
      </div>
    </div>`;
  slot.querySelector('.error-msg').textContent = message;
  slot.querySelector('.try-again').onclick = () => {
    slot.innerHTML = '';
    retry();
  };
  slot.querySelector('.dismiss').onclick = () => (slot.innerHTML = '');
}

async function pay(btn, plan) {
  // The hosted demo store demos the whole flow but sells nothing.
  if (state.capabilities.demo) {
    $('#notice').innerHTML =
      '<div class="callout pending">This is Ripley\u2019s demo store \u2014 nothing is for sale. <a href="/api/invite">Invite Ripley</a> to open yours in minutes.</div>';
    return;
  }
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Redirecting…';
  const discountCode = $('#discount-code')?.value.trim() ?? '';
  try {
    const res = await fetch(`/api/checkout/${state.method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planId: plan.id,
        ...(STORE_SLUG ? { store: STORE_SLUG } : {}),
        ...(discountCode ? { discountCode } : {}),
      }),
    });
    if (res.status === 401) {
      window.location.href = `/auth/login?plan=${encodeURIComponent(plan.id)}${loginStoreQ}`;
      return;
    }
    // The body may not be JSON (a proxy error page, an empty 500) — parse
    // defensively so buyers see a plain sentence, never a JSON parse error.
    let data = {};
    try {
      data = JSON.parse(await res.text());
    } catch {
      data = {};
    }
    if (!res.ok || !data.url) throw new Error(data.error || 'The payment did not start. Try again in a moment.');
    window.location.href = data.url;
  } catch (err) {
    showPayError(err.message, () => pay(btn, plan));
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
  const shop = $('#shop');
  const card = document.querySelector('.order-card');
  const multi = state.plans.length > 1;
  if (shop) shop.hidden = state.view !== 'shop';
  if (card) card.hidden = state.view === 'shop';
  const back = $('#back-to-shop');
  if (back) back.hidden = !(multi && state.view === 'checkout');
  if (state.view === 'shop') {
    renderShop();
    return;
  }
  renderOptions();
  renderMethods();
  renderPayPanel();
}

// ── shop view: the store's overall page, every product as a card ─────────────
function renderShop() {
  const banner = $('#shop-banner');
  if (state.store?.bannerUrl) {
    banner.src = state.store.bannerUrl;
    banner.hidden = false;
  } else banner.hidden = true;
  const icon = $('#shop-icon');
  if (state.server?.iconUrl) {
    icon.src = state.server.iconUrl;
    icon.hidden = false;
  } else icon.hidden = true;
  $('#shop-name').textContent = state.brand ?? state.server?.name ?? '';
  const desc = (state.store?.description ?? '').trim();
  $('#shop-desc').textContent = desc;
  $('#shop-desc').hidden = !desc;
  // Trust chips: the live member count (only when the owner shows it) plus
  // two platform facts that hold for every Ripley store.
  const ICON_MEMBERS = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="8" r="3.4"/><path d="M2.8 20c.7-3.4 3.2-5.2 6.2-5.2s5.5 1.8 6.2 5.2"/><path d="M15.5 5.2a3.4 3.4 0 0 1 0 5.9M18.2 14.9c1.7.8 2.7 2.4 3 5.1"/></svg>';
  const ICON_LOCK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
  const ICON_BOLT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L3 14h7l-1 8 12-13h-8l0-7z"/></svg>';
  const trust = $('#shop-trust');
  const count = state.store?.memberCount;
  trust.innerHTML =
    (Number.isFinite(count) && count > 0 ? `<span class="shop-chip">${ICON_MEMBERS}<strong>${count}</strong>&nbsp;members</span>` : '') +
    `<span class="shop-chip">${ICON_LOCK}Secured by Stripe</span>` +
    `<span class="shop-chip">${ICON_BOLT}Roles delivered automatically</span>`;
  // Social links: fixed keys, saved as https URLs in the dashboard.
  const LINK_ICONS = {
    discord: '<svg width="17" height="13" viewBox="0 0 127 96" fill="currentColor" aria-hidden="true"><path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z"/></svg>',
    x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-6.4L6.4 22H3.2l7.3-8.3L1.2 2h6.4l4.4 5.9L18.9 2zm-1.1 18h1.7L7.1 3.9H5.3L17.8 20z"/></svg>',
    youtube: '<svg width="16" height="12" viewBox="0 0 24 17" fill="currentColor" aria-hidden="true"><path d="M23.5 2.7A3 3 0 0 0 21.4.5C19.6 0 12 0 12 0S4.4 0 2.6.5A3 3 0 0 0 .5 2.7 31.2 31.2 0 0 0 0 8.5a31.2 31.2 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.2c1.8.5 9.4.5 9.4.5s7.6 0 9.4-.5a3 3 0 0 0 2.1-2.2 31.2 31.2 0 0 0 .5-5.8 31.2 31.2 0 0 0-.5-5.8zM9.6 12.1V4.9l6.3 3.6-6.3 3.6z"/></svg>',
    instagram: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="5"/><circle cx="12" cy="12" r="4.4"/><circle cx="17.6" cy="6.4" r="1.3" fill="currentColor" stroke="none"/></svg>',
    tiktok: '<svg width="13" height="15" viewBox="0 0 20 23" fill="currentColor" aria-hidden="true"><path d="M15.5 0h-3.8v15.1a3.3 3.3 0 1 1-3.3-3.3c.3 0 .7 0 1 .1V8a7.2 7.2 0 0 0-1-.1 7.1 7.1 0 1 0 7.1 7.1V7.6a9 9 0 0 0 4.8 1.4V5.2A5.2 5.2 0 0 1 15.5 0z"/></svg>',
    website: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9.2"/><path d="M2.8 12h18.4M12 2.8c2.6 2.6 3.9 5.8 3.9 9.2s-1.3 6.6-3.9 9.2c-2.6-2.6-3.9-5.8-3.9-9.2s1.3-6.6 3.9-9.2z"/></svg>',
  };
  const linksBox = $('#shop-links');
  const links = state.store?.links ?? {};
  const linkHtml = Object.keys(LINK_ICONS)
    .filter((k) => typeof links[k] === 'string' && /^https:\/\//.test(links[k]))
    .map((k) => `<a class="shop-link" href="${esc(links[k])}" target="_blank" rel="noopener noreferrer" aria-label="${esc(k === 'x' ? 'X (Twitter)' : k)}">${LINK_ICONS[k]}</a>`)
    .join('');
  linksBox.innerHTML = linkHtml;
  linksBox.hidden = !linkHtml;
  // About: plain text, escaped, split into paragraphs.
  const about = (state.store?.about ?? '').trim();
  const aboutBox = $('#shop-about-box');
  if (about) {
    $('#shop-about').innerHTML = about.split(/\n+/).map((line) => `<p>${esc(line.trim())}</p>`).join('');
    aboutBox.hidden = false;
  } else aboutBox.hidden = true;
  const grid = $('#shop-grid');
  $('#shop-empty').hidden = state.plans.length > 0;
  grid.innerHTML = '';
  for (const plan of state.plans) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'prod-card';
    const per = plan.lifetime ? 'lifetime' : `/ ${esc(plan.interval ?? 'month')}`;
    card.innerHTML =
      (plan.imageUrl
        ? `<img class="prod-shot" src="${esc(plan.imageUrl)}" alt="" loading="lazy" onerror="this.remove()" />`
        : `<span class="prod-ph" aria-hidden="true">${esc((plan.name || '?').slice(0, 1).toUpperCase())}</span>`) +
      `<span class="prod-name">${esc(plan.name)}</span>` +
      ((plan.roleNames ?? []).length
        ? `<span class="prod-roles">${plan.roleNames.slice(0, 3).map((r) => `<span class="prod-role">@${esc(r)}</span>`).join('')}</span>`
        : '') +
      (plan.description ? `<p class="prod-desc">${esc(plan.description)}</p>` : '') +
      `<span class="prod-foot"><span class="prod-price">${fmtPrice(plan.priceUsd)}</span><span class="prod-per">${per}</span></span>`;
    card.onclick = () => openCheckout(plan.id);
    grid.append(card);
  }
}

function openCheckout(planId) {
  state.planId = planId;
  state.view = 'checkout';
  history.pushState({ plan: planId }, '', `${window.location.pathname}?plan=${encodeURIComponent(planId)}`);
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function openShop() {
  state.view = 'shop';
  history.pushState({}, '', window.location.pathname);
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// The browser's back button walks between shop and checkout naturally.
addEventListener('popstate', () => {
  const plan = new URLSearchParams(window.location.search).get('plan');
  if (plan && state.plans.some((p) => p.id === plan)) {
    state.planId = plan;
    state.view = 'checkout';
  } else {
    state.view = state.plans.length > 1 ? 'shop' : 'checkout';
  }
  render();
});

async function main() {
  checkSetup();
  renderNotice();
  const [plansRes, meRes] = await Promise.all([fetch(`/api/plans${storeQS}`), fetch('/api/me')]);
  if (!plansRes.ok) {
    // Unclaimed or renamed slug: a clear dead-end beats a ghost checkout.
    document.querySelector('.order-card').innerHTML = `
      <h1 class="order-title">Store Not Found</h1>
      <p class="order-sub">There is no store at this link${STORE_SLUG ? ` (/${STORE_SLUG})` : ''}.
        Check the link your community shared — or start your own store with Ripley.</p>
      <a class="btn-pill" style="display:inline-block;text-decoration:none;margin-top:8px" href="/">Go to ripleybot.com</a>`;
    return;
  }
  const plansBody = await plansRes.json();
  state.plans = plansBody.plans;
  state.capabilities = plansBody.capabilities;
  state.server = plansBody.server;
  state.store = plansBody.store ?? null;
  state.brand = plansBody.brand ?? null;
  state.platform = plansBody.platform ?? state.platform;
  state.me = await meRes.json();

  // Back from the OAuth round trip (or a shared link): land on that plan,
  // scrolled to the pay button, instead of the top of the page.
  const search = new URLSearchParams(window.location.search);
  const requested = search.get('plan');
  const requestedPlan = state.plans.find((p) => p.id === requested);
  state.planId = requestedPlan?.id ?? state.plans[0]?.id ?? null;
  // The overall store page: multi-product stores open on the shop. A ?plan
  // deep link, a checkout return, or the dashboard preview (?view=checkout)
  // goes straight to the order card. One-product stores skip the shop.
  state.view =
    requestedPlan || state.plans.length <= 1 || search.get('checkout') || search.get('view') === 'checkout'
      ? 'checkout'
      : 'shop';
  const back = $('#back-to-shop');
  if (back) back.onclick = openShop;
  wireDiscount();
  render();
  if (requestedPlan && state.me.loggedIn) {
    $('#cta-area')?.scrollIntoView({ block: 'center' });
    $('#cta-area .pay-btn')?.focus({ preventScroll: true });
  }
}

main();
