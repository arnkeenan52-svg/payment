const $ = (sel) => document.querySelector(sel);
// Discord roles display as @Name exactly once. Stored names must stay
// verbatim (role delivery matches by name), and a role literally named
// "@PREMIUM" would otherwise render as "@@PREMIUM".
const roleLabel = (r) => `@${String(r ?? '').replace(/^@+/, '')}`;
// Which store this page shows: /<slug> (or legacy /s/<slug>). Every store —
// the platform's own included — lives at its unique slug; there is no
// special path that belongs to any store. Slugs and product links are stored
// lowercase [a-z0-9-]; the path is decoded and lowercased first so a link
// that picked up capitals or percent-encoding in transit (chat apps love
// both) still reaches the store it names instead of quietly parsing as no
// store at all.
const CLEAN_PATH = (() => {
  try { return decodeURIComponent(location.pathname).toLowerCase(); } catch { return location.pathname.toLowerCase(); }
})();
const PATH_MATCH =
  CLEAN_PATH.match(/^\/s\/([a-z0-9-]+)\/?$/) ??
  CLEAN_PATH.match(/^\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/) ??
  CLEAN_PATH.match(/^\/([a-z0-9-]+)\/?$/);
const STORE_SLUG = PATH_MATCH?.[1] ?? '';
// Product links: /<store>/<product> — resolved against linkSlug or plan key.
const PRODUCT_SLUG = CLEAN_PATH.startsWith('/s/') ? null : PATH_MATCH?.[2] ?? null;
const storeQS = STORE_SLUG ? `?store=${encodeURIComponent(STORE_SLUG)}` : '';
const loginStoreQ = STORE_SLUG ? `&store=${encodeURIComponent(STORE_SLUG)}` : '';

const fmtDate = (unix) =>
  new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
// The store's currency, learned from /api/plans. Until that lands there is
// nothing to show a price for, so the initial value is only a safety net.
let PAGE_CURRENCY = 'usd';
// Zero-decimal currencies: ¥1500 has no cents to print, and toFixed(2) on one
// invents a precision the currency does not have. Intl knows the rest —
// symbol, placement, grouping — so there is no table of those to keep.
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
// Product names and usernames are other people's text — escape everything
// that rides into innerHTML, no exceptions.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Sign out is a POST: the session cookie rides on cross-site GETs, so a
// GET link could be fired by any third-party page (see api/auth/logout.js).
const signOut = () => {
  const f = document.createElement('form');
  f.method = 'post';
  f.action = '/auth/logout';
  document.body.appendChild(f);
  f.submit();
};

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
  capabilities: { stripe: false, crypto: false, nowpayments: false },
  // Crypto: which coins this store takes, which one the buyer picked, and
  // the live payment once one exists. `coins: null` means "not asked yet" —
  // distinct from an empty list, which means "asked, and there are none".
  coins: null,
  coin: null,
  cryptoOrder: null,
  view: 'checkout',
  store: null,
  brand: null,
  server: null,
  platform: { name: 'Dues' },
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
  const badge = entitled.length ? `<span class="badge">${entitled.map((s) => esc(s.planName)).join(' · ')}</span>` : '';
  const links = `<a class="nav-link" href="/account">Account</a>${me.isOwner || me.seller ? '<a class="nav-link" href="/dashboard">Dashboard</a>' : ''}`;
  el.innerHTML = `${badge}${links}<span>@${esc(me.username ?? me.discordId)}</span><button class="btn-ghost" id="logout">Sign out</button>`;
  $('#logout').onclick = signOut;
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

// Price options: a plan whose variantOf names another plan is one PRICE
// OPTION of that product (e.g. Monthly $50 under a Lifetime $500 product).
// The parent carries the product's identity — name, photo, description,
// link — and each option carries its own price and billing.
const parentOf = (plan) => (plan?.variantOf && state.plans.find((p) => p.id === plan.variantOf)) || plan;
const groupFor = (plan) => {
  const par = parentOf(plan);
  return [par, ...state.plans.filter((p) => p.variantOf === par.id)];
};

// A product's media is a video when the upload said so, or when a pasted
// link plainly is one — either way the storefront shows a muted loop.
const isVideoMedia = (plan) =>
  plan?.mediaKind === 'video' || /\.(mp4|webm)([?#]|$)/i.test(plan?.imageUrl ?? '');

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
    let vid = $('#product-shot-video');
    if (art && isVideoMedia(plan)) {
      shot.hidden = true;
      if (!vid) {
        vid = document.createElement('video');
        vid.id = 'product-shot-video';
        vid.className = shot.className;
        vid.muted = true;
        vid.autoplay = true;
        vid.loop = true;
        vid.playsInline = true;
        vid.setAttribute('aria-hidden', 'true');
        vid.addEventListener('loadeddata', () => vid.classList.add('loaded'), { once: true });
        shot.after(vid);
      }
      if (vid.getAttribute('src') !== art) vid.src = art;
      vid.hidden = false;
    } else {
      if (vid) {
        vid.hidden = true;
        vid.removeAttribute('src');
      }
      if (art) {
        shot.src = art;
        shot.hidden = false;
      } else shot.hidden = true;
    }
  }
  // ONLY the server's own Discord icon (animated GIF when the guild has
  // one) is ever shown — no stand-in logo. Hidden until Discord answers.
  // Selected by its own class: the shop view's .logo sits earlier in the DOM.
  const logo = $('.op-server-icon');
  if (state.server?.iconUrl && logo.dataset.failed !== state.server.iconUrl) {
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
    // Match the server-rendered product page title, so the tab (and history
    // entries) name the product being bought, not a generic "Checkout".
    // A price option's page is titled by its PRODUCT, not the option label.
    document.title = `${parentOf(plan).name} — ${state.server.name}`;
  } else {
    nameEl.hidden = true;
  }
  $('#plan-name').textContent = parentOf(plan).name;
  renderTagline($('#plan-desc'), plan.description, plan.descriptionHighlight);
  $('#price').textContent = fmtPrice(plan.priceUsd, plan.currency);
  // Roles the buyer receives, as blurple chips — Discord's own concept in
  // Discord's own color.
  const rolesBox = $('#roles-box');
  const chips = $('#roles-chips');
  if (rolesBox && chips) {
    const names = plan.roleNames ?? [];
    if (names.length) {
      chips.innerHTML = names.map((n) => `<span class="chip">${esc(roleLabel(n))}</span>`).join('');
      rolesBox.hidden = false;
    } else rolesBox.hidden = true;
  }
  // Discount codes exist on onboarded stores only — and once a crypto
  // payment exists its amount is already quoted on-chain, so a code applied
  // afterwards could only change a number the buyer is no longer paying.
  const df = $('#discount-field');
  if (df) df.hidden = !STORE_SLUG || Boolean(state.cryptoOrder);
  // Availability + gating, spelled out where the buyer decides. The server
  // enforces both at checkout — these lines just make the page honest.
  const par = parentOf(plan);
  const bits = [];
  if (par.requiredRoleName) bits.push(`For ${roleLabel(par.requiredRoleName)} members only`);
  if (par.expiresAt) {
    bits.push(`Available until ${new Date(par.expiresAt * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`);
  }
  let gate = $('#gate-note');
  if (!gate) {
    gate = document.createElement('p');
    gate.id = 'gate-note';
    gate.className = 'tagline';
    gate.style.cssText = 'font-weight:600;opacity:0.85;';
    $('#roles-box')?.after(gate);
  }
  gate.textContent = bits.join(' · ');
  gate.hidden = bits.length === 0;
}

// The order card is a PRODUCT page: it shows exactly the product its link
// names — one product, one link. The store's other products live in the shop
// (the "All products" button above), never as a cross-sell picker inside
// someone else's checkout. The one picker that DOES belong here is the
// product's own pricing options (e.g. Lifetime vs Monthly), when the owner
// added any.
function renderOptions() {
  const box = $('#options');
  box.innerHTML = '';
  const plan = selectedPlan();
  if (!plan) return;
  const group = groupFor(plan);
  const label = $('#options-label');
  if (label) label.textContent = group.length > 1 ? 'Select option' : 'Your order';
  if (group.length === 1) {
    const row = document.createElement('div');
    row.className = 'option selected';
    row.style.cursor = 'default';
    row.innerHTML = `
      <span class="opt-name">${esc(plan.name)}<small>${plan.lifetime ? '(lifetime)' : `/ ${esc(plan.interval)}`}</small></span>
      <span class="opt-price">${fmtPrice(plan.priceUsd)}</span>`;
    box.append(row);
    return;
  }
  const par = group[0];
  for (const opt of group) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `option${opt.id === state.planId ? ' selected' : ''}`;
    // The parent row predates its options and is named after the product —
    // its option label is its cadence. Added options are named by the owner.
    const optName = opt.id === par.id ? (opt.lifetime ? 'Lifetime' : 'Monthly') : opt.name;
    // The cadence suffix is dropped when the label already IS the cadence —
    // "Lifetime (lifetime)" said the same word twice.
    const cadence = opt.lifetime ? '(lifetime)' : `/ ${esc(opt.interval)}`;
    const sameWord = String(optName).trim().toLowerCase() === (opt.lifetime ? 'lifetime' : String(opt.interval ?? '').toLowerCase());
    row.innerHTML = `
      <span class="opt-name">${esc(optName)}${sameWord ? '' : `<small>${cadence}</small>`}</span>
      <span class="opt-price">${fmtPrice(opt.priceUsd)}</span>`;
    row.onclick = () => {
      state.planId = opt.id;
      render();
      // A code applied to the old option is re-checked against the new one.
      if (state.discount && state.discount.planId !== opt.id) applyDiscount();
    };
    box.append(row);
  }
}

function renderMethods() {
  const box = $('#methods');
  box.innerHTML = '';
  const methods = [];
  if (state.capabilities.crypto) methods.push({ id: 'coinbase', html: `${ICON_CRYPTO}<span>Crypto</span>` });
  // The NOWPayments rail. Offered only when the platform has credentials AND
  // this seller has set a payout wallet — /api/plans folds both into one flag,
  // because a button that can only answer "this store hasn't finished setting
  // up" is worse than no button.
  if (state.capabilities.nowpayments) methods.push({ id: 'crypto', html: `${ICON_CRYPTO}<span>Crypto</span>` });
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
  const np = state.method === 'crypto';
  $('#pay-title').textContent = card ? 'Pay with Card' : 'Pay with Crypto';
  $('#pay-sub').textContent = card
    ? 'Secure payment processed by Stripe'
    : np
      ? 'Paid on-chain, forwarded straight to the seller'
      : 'Secure payment processed by Coinbase Commerce';
  $('#trust-row').innerHTML = card
    ? `<span>${ICON_CHECK} Secured by Stripe</span><span>${ICON_LOCK} 100% Secure</span>`
    : np
      ? `<span>${ICON_CHECK} Roles the moment it confirms</span><span>${ICON_LOCK} 100% Secure</span>`
      : `<span>${ICON_CHECK} Coinbase Commerce</span><span>${ICON_LOCK} 100% Secure</span>`;

  renderCoinPicker();
  renderCta();
  renderCryptoPay();

  const note = $('#redirect-note');
  const showingPay = Boolean($('#cta-area .pay-btn')) && state.me.loggedIn;
  note.textContent = showingPay && !np
    ? `${card ? 'Stripe' : 'Coinbase'}’s secure checkout opens next to finish your payment.`
    : '';
}

// Which coins this store takes. Read live from the merchant account rather
// than hardcoded: enabled coins are a per-seller setting that changes without
// a deploy, and the order they arrive in is cheapest-to-settle first.
const COIN_LABEL = {
  btc: 'Bitcoin', eth: 'Ethereum', sol: 'Solana', trx: 'Tron', ltc: 'Litecoin',
  doge: 'Dogecoin', xrp: 'XRP', ada: 'Cardano', bnb: 'BNB', matic: 'Polygon',
  pol: 'Polygon', dai: 'DAI', usdterc20: 'USDT · Ethereum', usdttrc20: 'USDT · Tron',
  usdtsol: 'USDT · Solana', usdtbsc: 'USDT · BNB Chain', usdtmatic: 'USDT · Polygon',
  usdcerc20: 'USDC · Ethereum', usdcsol: 'USDC · Solana', usdcmatic: 'USDC · Polygon',
  usdcbase: 'USDC · Base', usdcbsc: 'USDC · BNB Chain',
};
const coinLabel = (t) => COIN_LABEL[t] ?? t.toUpperCase();

// What the browser is allowed to keep from a ?coins=1 answer. `ready:false`
// and an empty list say the same thing — there is nothing here to pay with —
// and neither is worth remembering: a half-configured store that finishes its
// setup a minute later would still show an empty grid to a page that was
// already open. null means "ask again on the next open".
const coinsFromAnswer = (data) => {
  const list = data && data.ready !== false && Array.isArray(data.coins) ? data.coins : [];
  return list.length ? list : null;
};

async function renderCoinPicker() {
  const box = $('#coinpick');
  if (!box) return;
  if (state.method !== 'crypto' || state.cryptoOrder) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const grid = $('#coinpick-grid');
  const msg = $('#coinpick-msg');
  if (state.coins === null) {
    msg.textContent = 'Loading coins…';
    state.coins = [];
    let failed = false;
    let empty = false;
    try {
      const res = await fetch(`/api/checkout/crypto?coins=1&store=${encodeURIComponent(STORE_SLUG)}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      state.coins = coinsFromAnswer(data);
      // A 200 that carries nothing payable is as useless as no answer at all.
      empty = state.coins === null;
    } catch {
      // A transient failure must not leave the picker empty for the life of
      // the page: forget the answer so the next open asks again.
      state.coins = null;
      failed = true;
    }
    if (failed || empty) {
      grid.innerHTML = '';
      msg.textContent = '';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn-ghost';
      retry.textContent = failed
        ? 'Could not load coins — try again'
        : 'No coins available right now — try again';
      retry.onclick = () => render();
      msg.append(retry);
      return;
    }
    renderCoinPicker();
    return;
  }
  msg.textContent = state.coins.length ? '' : 'No coins are available for this store right now.';
  grid.innerHTML = '';
  for (const ticker of state.coins) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `coin${ticker === state.coin ? ' selected' : ''}`;
    tile.innerHTML = `<b>${ticker.toUpperCase()}</b><span>${coinLabel(ticker)}</span>`;
    tile.onclick = () => {
      state.coin = ticker;
      render();
    };
    grid.append(tile);
  }
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
  $('#tot-sub').textContent = fmtPrice(plan.priceUsd, plan.currency);
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
  // A crypto payment already showing its address is not a thing to start
  // again — a second invoice for the same order would send the buyer to a
  // second address and split their payment across two of them.
  if (state.cryptoOrder) return;
  const btn = document.createElement('button');
  btn.className = 'pay-btn';
  const crypto = state.method === 'crypto' || state.method === 'coinbase';
  btn.textContent = `Pay ${fmtPrice(applied ? applied.discountedUsd : plan.priceUsd)} with ${crypto ? 'Crypto' : 'Card'}`;
  if (state.method === 'crypto' && !state.coin) {
    btn.disabled = true;
    btn.textContent = 'Pick a coin above';
  }
  btn.onclick = () => pay(btn, plan);
  area.append(btn);
  // One quiet, factual line under the buy action: renewing plans really can
  // be cancelled from /account; lifetime plans really never bill again. A
  // crypto term is neither: there is no card to charge again, so the grant
  // is a fixed term that simply ends — nothing renews and nothing is there
  // to cancel. Promising "cancel anytime" on that rail would be a lie.
  const assure = document.createElement('p');
  assure.className = 'pay-assure';
  const termDays = Number(plan.durationDays);
  assure.textContent = plan.lifetime
    ? 'One-time payment — no renewals, ever.'
    : crypto
      ? `One-time payment for ${termDays > 0 ? `${termDays} days` : 'a fixed term'} of access — nothing renews, nothing is charged again.`
      : 'Cancel anytime from your account.';
  area.append(assure);
}

// ── the crypto pay screen ────────────────────────────────────────────────────
//
// There is no hosted checkout to redirect to: the payment forwards straight
// to the seller's own wallet, so the address is shown here and this page
// watches it. Everything below is display — the grant is decided entirely by
// the signed webhook, never by anything this browser reports.

let cryptoPoll = null;

async function startCryptoPayment(plan, discountCode) {
  const res = await fetch('/api/checkout/crypto', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      planId: plan.id,
      payCurrency: state.coin,
      ...(STORE_SLUG ? { store: STORE_SLUG } : {}),
      ...(discountCode ? { discountCode } : {}),
    }),
  });
  if (res.status === 401) {
    window.location.href = `/auth/login?plan=${encodeURIComponent(plan.id)}${loginStoreQ}`;
    return;
  }
  let data = {};
  try {
    data = JSON.parse(await res.text());
  } catch {
    data = {};
  }
  if (!res.ok || !data.payAddress) {
    throw new Error(data.error || 'The payment did not start. Try again in a moment.');
  }
  state.cryptoOrder = data;
  render();
  renderCryptoPay();
  watchCryptoPayment();
}

function renderCryptoPay() {
  const box = $('#cryptopay');
  if (!box) return;
  const o = state.cryptoOrder;
  if (!o) {
    box.hidden = true;
    stopCryptoClock();
    return;
  }
  box.hidden = false;

  // The QR arrives as SVG markup from our own server — no third-party script
  // on a payment page, and one implementation rather than one per client.
  const qr = $('#cryptopay-qr');
  if (qr) {
    if (o.qrSvg && qr.dataset.for !== o.orderId) {
      qr.innerHTML = o.qrSvg;
      qr.dataset.for = o.orderId;
    }
    qr.hidden = !o.qrSvg;
  }

  const coin = String(o.payCurrency ?? '').toUpperCase();
  // NOT the usual "any other token is lost forever" line, because on this
  // account it would be false: wrong-asset deposits are auto-converted, so a
  // different coin arrives as money — just less of it than the order needs.
  // The wrong NETWORK is the unrecoverable mistake, and saying both things
  // accurately is more use to a buyer than one scary sentence that is half
  // wrong.
  const warn = $('#cryptopay-warn');
  if (warn) {
    warn.innerHTML =
      `<b>Send ${esc(coin)} on the ${esc(coin)} network only.</b> A transfer sent over a different network cannot be recovered. ` +
      'Another coin sent to this address is converted at the current rate, which usually leaves the order short of the total.';
  }

  $('#cryptopay-address').textContent = o.payAddress;
  $('#cryptopay-coin').textContent = coin;
  $('#cryptopay-amount').textContent = String(o.payAmount);

  // A memo/tag exists only on some chains, and on those a payment without it
  // cannot be matched to an order at all — so it is never styled as an
  // optional extra, and those chains get no QR to scan past it.
  const memo = $('#cryptopay-memo');
  if (memo) {
    memo.hidden = !o.payExtraId;
    if (o.payExtraId) $('#cryptopay-memo-value').textContent = o.payExtraId;
  }

  wireCopy('#cryptopay-copy', () => o.payAddress);
  wireCopy('#cryptopay-copy-amount', () => String(o.payAmount));
  startCryptoClock(o.expiresAt);
}

// Copy buttons swap to a tick for a moment. Falls back to selecting the text
// when the clipboard is refused (an insecure origin, or a denied permission) —
// silently doing nothing on a page whose whole job is "copy this exactly" is
// the one outcome worth ruling out.
function wireCopy(sel, value) {
  const btn = $(sel);
  if (!btn) return;
  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(value());
      btn.classList.add('done');
      setTimeout(() => btn.classList.remove('done'), 1600);
    } catch {
      const target = btn.parentElement?.querySelector('code');
      if (target) {
        const range = document.createRange();
        range.selectNodeContents(target);
        const sel2 = window.getSelection();
        sel2.removeAllRanges();
        sel2.addRange(range);
      }
    }
  };
}

// The quoted coin amount is fixed-rate, so it has an expiry. Counting down to
// it is the difference between "this number is still good" and a buyer sending
// against a rate that lapsed twenty minutes ago and landing short.
let cryptoClock = null;
function stopCryptoClock() {
  if (cryptoClock) clearInterval(cryptoClock);
  cryptoClock = null;
}
function startCryptoClock(expiresAt) {
  stopCryptoClock();
  const el = $('#cryptopay-clock');
  if (!el) return;
  const until = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(until)) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const tick = () => {
    const left = Math.max(0, Math.floor((until - Date.now()) / 1000));
    const hh = String(Math.floor(left / 3600)).padStart(2, '0');
    const mm = String(Math.floor((left % 3600) / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');
    el.textContent = `${hh}:${mm}:${ss}`;
    el.classList.toggle('out', left === 0);
    if (left === 0) {
      stopCryptoClock();
      const t = $('#cryptopay-status-text');
      // Not "cancelled": the address still works. What lapsed is the quoted
      // amount, and sending the old figure now is how a buyer underpays.
      if (t) t.textContent = 'The quoted rate has expired — start the payment again for a fresh amount.';
    }
  };
  tick();
  cryptoClock = setInterval(tick, 1000);
}

function watchCryptoPayment() {
  if (cryptoPoll) clearInterval(cryptoPoll);
  const order = state.cryptoOrder?.orderId;
  if (!order) return;
  const tick = async () => {
    try {
      const res = await fetch(`/api/checkout/crypto?store=${encodeURIComponent(STORE_SLUG)}&order=${encodeURIComponent(order)}`);
      if (!res.ok) return;
      const data = await res.json();
      const el = $('#cryptopay-status-text');
      if (el) el.textContent = data.message ?? 'Waiting for your payment…';
      if (data.state === 'paid') {
        clearInterval(cryptoPoll);
        cryptoPoll = null;
        stopCryptoClock();
        // Reload rather than patch the page: the roles, the owned-plan badge
        // and the account chip all change at once, and the server already
        // knows the new truth.
        window.location.href = `/receipt?plan=${encodeURIComponent(state.planId ?? '')}${STORE_SLUG ? `&store=${encodeURIComponent(STORE_SLUG)}` : ''}`;
      }
      if (data.state === 'dead') {
        clearInterval(cryptoPoll);
        cryptoPoll = null;
        stopCryptoClock();
      }
    } catch {
      /* a dropped poll is not an error worth showing — the next one retries */
    }
  };
  tick();
  cryptoPoll = setInterval(tick, 6000);
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

// THE DEMO CHECKOUT.
//
// /demo sells nothing, and it used to say so with a sentence: a grey callout
// reading "nothing is for sale". Accurate, and a dead end — the one moment a
// visitor asks to see the product work, answered by a notice saying it does
// not. This plays the flow instead: the checkout a buyer really lands on,
// filling itself in, charging nothing, granting the role.
//
// IT CANNOT TAKE A PAYMENT AND IT CANNOT TAKE A CARD. There is no <form>, no
// <input>, no submit target and no fetch anywhere in this function — every
// field is a <div> whose textContent is written by a timer. A page that looks
// like a checkout must be incapable of accepting a card number rather than
// merely uninterested in one. The number shown is 4242 4242 4242 4242, the
// test card Stripe publishes, and a Demo badge sits on the panel throughout.
function demoCheckout(plan) {
  const price = fmtPrice(plan.priceUsd);
  const role = plan.roleNames?.[0] ? `@${plan.roleNames[0]}` : '@VIP';
  const recurring = plan.interval ? ` / ${plan.interval}` : '';
  const back = document.createElement('div');
  back.className = 'dcx-back';
  back.setAttribute('role', 'dialog');
  back.setAttribute('aria-modal', 'true');
  back.setAttribute('aria-label', 'Demo checkout');
  back.innerHTML = `
    <div class="dcx">
      <div class="dcx-side">
        <button class="dcx-x" type="button" aria-label="Close demo checkout">&times;</button>
        <div class="dcx-brand" style="margin-left:38px"><img src="/favicon.png" alt=""/>${esc(state.brand ?? 'Dues Membership')}</div>
        <div class="dcx-lead">${plan.interval ? 'Subscribe to' : 'Pay'} ${esc(plan.name)}</div>
        <div class="dcx-amt">${price}${recurring}</div>
        <div class="dcx-rule"></div>
        <div class="dcx-line"><b>${esc(plan.name)}</b><span>${price}${recurring}</span></div>
        <div class="dcx-note">${esc(plan.description ?? '')}</div>
        <div class="dcx-rule"></div>
        <div class="dcx-line sum"><span>Subtotal</span><span>${price}</span></div>
        <div class="dcx-line sum"><span>Platform fee</span><span>$0.00</span></div>
        <div class="dcx-line due"><span>Total due</span><span>${price}</span></div>
        <div class="dcx-trust">
          The seller keeps every cent — Dues takes no platform fee and never touches the money.
          The role lands in Discord the moment the payment clears.
        </div>
      </div>
      <div class="dcx-pay">
        <span class="dcx-badge">Demo</span>
        <div class="dcx-lab">Email</div>
        <div class="dcx-f" data-f="email"><span class="t"></span><span class="caret"></span></div>
        <div class="dcx-lab">Card information</div>
        <div class="dcx-card">
          <div class="dcx-f" data-f="card"><span class="t"></span><span class="caret"></span><span class="dcx-brandmark">VISA</span></div>
          <div class="pair">
            <div class="dcx-f" data-f="exp"><span class="t"></span><span class="caret"></span></div>
            <div class="dcx-f" data-f="cvc"><span class="t"></span><span class="caret"></span></div>
          </div>
        </div>
        <div class="dcx-lab">Cardholder name</div>
        <div class="dcx-f" data-f="name"><span class="t"></span><span class="caret"></span></div>
        <button class="dcx-btn" type="button" disabled>Pay ${price}</button>
        <div class="dcx-foot">
          <svg width="12" height="15" viewBox="0 0 12 15" fill="none" aria-hidden="true"><path d="M3 6V4a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.5"/><rect x="0.75" y="6" width="10.5" height="8" rx="2" fill="currentColor"/></svg>
          Checkout secured by Dues
        </div>
        <div class="dcx-grant"><span class="pill">${esc(role)}</span> granted in ${esc(state.brand ?? 'this server')}</div>
        <div class="dcx-out">
          <a class="primary" href="/api/invite">Open your own store</a>
          <button type="button" data-close>Close</button>
        </div>
      </div>
    </div>`;
  document.body.append(back);
  requestAnimationFrame(() => back.classList.add('in'));

  const timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));
  const f = (k) => back.querySelector(`[data-f="${k}"]`);
  const btn = back.querySelector('.dcx-btn');
  const prevFocus = document.activeElement;

  const close = () => {
    timers.forEach(clearTimeout);
    document.removeEventListener('keydown', onKey);
    back.classList.remove('in');
    setTimeout(() => back.remove(), 220);
    if (prevFocus?.focus) prevFocus.focus();
  };
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', (e) => {
    if (e.target === back || e.target.closest('[data-close], .dcx-x')) close();
  });
  back.querySelector('.dcx-x').focus();

  // Someone who has asked not to be animated at gets the finished state.
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Type into a div, character by character. Not a form field, by design.
  const type = (el, text, start, per) => {
    at(start - 60, () => el.classList.add('on'));
    [...text].forEach((_, i) => at(start + i * per, () => {
      el.querySelector('.t').textContent = text.slice(0, i + 1);
    }));
    at(start + text.length * per + 140, () => el.classList.remove('on'));
  };

  const settle = () => {
    f('email').querySelector('.t').textContent = 'nova@example.com';
    f('card').querySelector('.t').textContent = '4242 4242 4242 4242';
    f('exp').querySelector('.t').textContent = '04 / 29';
    f('cvc').querySelector('.t').textContent = '123';
    f('name').querySelector('.t').textContent = 'Nova Almeida';
    back.querySelector('.dcx-brandmark').classList.add('in');
  };

  const succeed = () => {
    btn.classList.remove('press');
    btn.classList.add('done');
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 5" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Payment successful';
    at(320, () => back.querySelector('.dcx-grant').classList.add('in'));
    at(700, () => back.querySelector('.dcx-out').classList.add('in'));
  };

  if (still) { settle(); succeed(); return; }

  type(f('email'), 'nova@example.com', 380, 34);
  type(f('card'), '4242 4242 4242 4242', 1080, 32);
  at(1080 + 8 * 32, () => back.querySelector('.dcx-brandmark').classList.add('in'));
  type(f('exp'), '04 / 29', 1820, 46);
  type(f('cvc'), '123', 2180, 52);
  type(f('name'), 'Nova Almeida', 2440, 40);
  at(3020, () => { btn.disabled = false; btn.classList.add('press'); });
  at(3180, () => {
    btn.classList.remove('press');
    btn.innerHTML = '<span class="dcx-spin"></span>Processing…';
  });
  at(4200, succeed);
}

async function pay(btn, plan) {
  // The hosted demo store demos the whole flow but sells nothing.
  if (state.capabilities.demo) {
    demoCheckout(plan);
    return;
  }
  btn.disabled = true;
  const original = btn.textContent;
  const discountCode = $('#discount-code')?.value.trim() ?? '';
  if (state.method === 'crypto') {
    btn.textContent = 'Creating payment…';
    try {
      await startCryptoPayment(plan, discountCode);
    } catch (err) {
      showPayError(err.message, () => pay(btn, plan));
      btn.disabled = false;
      btn.textContent = original;
    }
    return;
  }
  btn.textContent = 'Redirecting…';
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
  // Products only, like main(): a one-product store whose product has price
  // options must not grow an "All products" button leading to a one-card shop.
  const multi = state.plans.filter((p) => !p.variantOf).length > 1;
  if (shop) shop.hidden = state.view !== 'shop';
  if (card) card.hidden = state.view === 'shop';
  // The checkout wrapper caps itself at 640px with its own padding; the shop
  // page is a full-bleed framed column and has to shed that shaping.
  document.body.classList.toggle('shop-view', state.view === 'shop');
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

// ── shop view: the store's overall page, every product a card ────────────────
// Module-level so the Join button can reach it.
function setTab(tab) {
  const shopEl = $('#shop');
  if (!shopEl) return;
  // Anything that is not a section this store actually has lands on Products.
  // A browser can still be running this script against a CACHED store.html
  // that has a retired button in it; without this normalisation that click
  // would set a tab no pane answers to and hide the whole storefront.
  if (!hasSection(tab)) tab = 'products';
  shopEl.dataset.tab = tab;
  // aria-current, not just a class: the underline is the only thing that says
  // which section you are in, and a screen reader cannot see an underline.
  $('#shop-tabs')?.querySelectorAll('.shop-tab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  });
  $('#shop-pane-products').hidden = tab !== 'products';
  $('#shop-pane-reviews')?.toggleAttribute('hidden', tab !== 'reviews');
  $('#shop-about-box').hidden = tab !== 'about';
  if (tab === 'reviews') loadReviews();
}

// Which sections this store actually has. The About tab needs About text; the
// Reviews tab needs the seller's switch on. Neither is ever shown as an empty
// room the visitor walked into for nothing.
function hasSection(tab) {
  if (tab === 'about') return Boolean((state.store?.about ?? '').trim()) || Boolean(state.store?.team?.length);
  if (tab === 'reviews') return Boolean(state.store?.reviews?.on);
  return tab === 'products';
}

// ── reviews ──────────────────────────────────────────────────────────────────
// Every number here is the server's. The list is whatever /api/reviews returns
// and the score is whatever /api/plans counted — the client never computes an
// average from the page it happens to be showing, because that would drift
// from the truth the moment the list is paginated.
const reviewState = { loaded: false, loading: false, cursor: null, more: false, rows: [], canWrite: false, writeBlock: null, mine: null };

const starRow = (n, cls = '') =>
  `<span class="shop-stars ${cls}" role="img" aria-label="${n} out of 5">` +
  [1, 2, 3, 4, 5].map((i) => `<span class="${i <= n ? 'on' : 'off'}" aria-hidden="true">&#9733;</span>`).join('') +
  '</span>';

const initialsOf = (name) =>
  String(name ?? '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase() || '?';

function reviewCard(r) {
  const when = r.createdAt ? fmtDate(r.createdAt) : '';
  return `<article class="shop-rv${r.mine ? ' mine' : ''}">
    <span class="shop-rv-face" aria-hidden="true">${esc(initialsOf(r.author))}</span>
    <div class="shop-rv-body">
      <div class="shop-rv-top">
        <b class="shop-rv-name">${esc(r.author ?? 'A buyer')}</b>
        ${r.mine ? '<span class="shop-rv-you">You</span>' : ''}
      </div>
      ${starRow(r.rating)}
      ${r.body ? `<p class="shop-rv-text">${esc(r.body)}</p>` : ''}
      <p class="shop-rv-when">${esc(when)}${r.edited ? ' &middot; edited' : ''}</p>
      ${r.reply ? `<div class="shop-rv-reply"><b>Reply from the store</b><p>${esc(r.reply.body)}</p></div>` : ''}
    </div>
  </article>`;
}

async function loadReviews(force = false) {
  if (reviewState.loading) return;
  if (reviewState.loaded && !force) return renderReviews();
  reviewState.loading = true;
  try {
    const r = await fetch(`/api/reviews?store=${encodeURIComponent(STORE_SLUG)}`);
    const data = await r.json();
    reviewState.rows = data.reviews ?? [];
    reviewState.cursor = data.cursor ?? null;
    reviewState.more = Boolean(data.more);
    reviewState.mine = reviewState.rows.find((x) => x.mine) ?? null;
    // Whether THIS viewer may post, decided by the same gate the write hits.
    reviewState.canWrite = Boolean(data.canWrite);
    reviewState.writeBlock = data.writeBlock ?? null;
    reviewState.loaded = true;
  } catch {
    // A storefront that cannot reach the review feed still sells products.
  } finally {
    reviewState.loading = false;
  }
  renderReviews();
}

function renderReviews() {
  const list = $('#shop-rvlist');
  if (!list) return;
  const rows = reviewState.rows;
  list.innerHTML = rows.filter((r) => !r.mine).map(reviewCard).join('');
  $('#shop-rvempty').hidden = rows.length > 0;
  // The score at the head of the pane is the same server figure as the row
  // under the store name, held to the same threshold.
  const rv = state.store?.reviews;
  const score = $('#shop-rvscore');
  if (score) {
    const enough = rv && rv.count >= MIN_RATED && rv.average !== null;
    score.hidden = !enough;
    if (enough) {
      $('#shop-rvscore-num').textContent = rv.average.toFixed(1);
      $('#shop-rvscore-count').textContent = `(${rv.count} reviews)`;
    }
  }
  const more = $('#shop-rvmore');
  if (more) {
    more.hidden = !reviewState.more;
    if (!more.dataset.wired) {
      more.dataset.wired = '1';
      more.addEventListener('click', async () => {
        more.disabled = true;
        try {
          const r = await fetch(`/api/reviews?store=${encodeURIComponent(STORE_SLUG)}&before=${reviewState.cursor}`);
          const data = await r.json();
          reviewState.rows = reviewState.rows.concat(data.reviews ?? []);
          reviewState.cursor = data.cursor ?? null;
          reviewState.more = Boolean(data.more);
        } catch { /* the button simply stays */ }
        more.disabled = false;
        renderReviews();
      });
    }
  }
  renderMyReview();
}

// The composer. It appears only for someone who can actually post — a buyer
// past the cooling window — so the button is never a tease that 403s.
function renderMyReview() {
  const box = $('#shop-rvmine');
  if (!box) return;
  const mine = reviewState.mine;
  if (!state.me.loggedIn && !mine) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (mine && !box.dataset.editing) {
    box.innerHTML =
      reviewCard(mine) +
      '<div class="shop-rv-acts">' +
      '<button type="button" class="shop-desc-more" id="rv-edit">Edit your review</button>' +
      '<button type="button" class="shop-desc-more" id="rv-del">Withdraw it</button>' +
      '</div>';
    $('#rv-edit').onclick = () => { box.dataset.editing = '1'; renderMyReview(); };
    $('#rv-del').onclick = async () => {
      await postReview({ action: 'withdraw' });
    };
    return;
  }
  // No review yet and the server says this viewer cannot write one: a buyer
  // inside the cooling window or someone who never bought gets the reason in
  // the server's own words; the seller (who cannot rate their own store) and
  // anyone else get nothing rather than a form that 403s.
  if (!mine && !reviewState.canWrite) {
    const why = {
      notbuyer: 'Only people who bought from this store can review it.',
      cooling: 'Reviews open three days after your purchase — give it a proper go first.',
    }[reviewState.writeBlock];
    box.hidden = !why;
    if (why) box.innerHTML = `<p class="shop-rvform-note">${esc(why)}</p>`;
    return;
  }
  const pick = Number(box.dataset.pick ?? mine?.rating ?? 0);
  box.innerHTML = `
    <div class="shop-rvform">
      <p class="shop-rvform-lead">${mine ? 'Edit your review' : 'Bought from this store? Say how it went.'}</p>
      <div class="shop-rvpick" id="rv-pick" role="group" aria-label="Your rating">
        ${[1, 2, 3, 4, 5]
          .map((i) => `<button type="button" class="shop-rvpick-star${i <= pick ? ' on' : ''}" data-n="${i}" aria-label="${i} star${i > 1 ? 's' : ''}" aria-pressed="${i === pick}">&#9733;</button>`)
          .join('')}
      </div>
      <textarea id="rv-text" maxlength="1500" rows="3" placeholder="What did you actually get out of it?">${esc(mine?.body ?? '')}</textarea>
      <p class="shop-rvform-note">Posted publicly under your Discord name.</p>
      <p class="shop-rvform-err" id="rv-err" role="alert"></p>
      <div class="shop-rv-acts">
        <button type="button" class="shop-btn shop-rvsave" id="rv-save">${mine ? 'Save changes' : 'Post review'}</button>
        ${mine ? '<button type="button" class="shop-desc-more" id="rv-cancel">Cancel</button>' : ''}
      </div>
    </div>`;
  box.querySelectorAll('.shop-rvpick-star').forEach((b) => {
    b.onclick = () => { box.dataset.pick = b.dataset.n; renderMyReview(); };
  });
  if ($('#rv-cancel')) $('#rv-cancel').onclick = () => { delete box.dataset.editing; delete box.dataset.pick; renderMyReview(); };
  $('#rv-save').onclick = async () => {
    const rating = Number(box.dataset.pick ?? mine?.rating ?? 0);
    if (!rating) { $('#rv-err').textContent = 'Pick a rating first.'; return; }
    await postReview({ action: 'write', rating, body: $('#rv-text').value });
  };
}

async function postReview(payload) {
  const err = $('#rv-err');
  const save = $('#rv-save');
  if (save) { save.disabled = true; }
  try {
    const r = await fetch('/api/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ store: STORE_SLUG, ...payload }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401) { window.location.href = `/auth/login?x=1${loginStoreQ}`; return; }
      if (err) err.textContent = data.error ?? 'That did not go through.';
      return;
    }
    // The score comes back from the server after every write, so the number on
    // screen is the number the database holds — never a local recount.
    if (state.store) state.store.reviews = { ...(state.store.reviews ?? {}), count: data.count, average: data.average };
    renderRating();
    const box = $('#shop-rvmine');
    if (box) { delete box.dataset.editing; delete box.dataset.pick; }
    await loadReviews(true);
  } finally {
    if (save) save.disabled = false;
  }
}

// The rating row under the store name. Hidden outright below the threshold:
// "5.0" off a single review reads as a fact about a store and is not one.
const MIN_RATED = 5;
function renderRating() {
  const el = $('#shop-rating');
  if (!el) return;
  const rv = state.store?.reviews;
  if (!rv?.on || !rv.count) { el.hidden = true; return; }
  el.hidden = false;
  const enough = rv.count >= MIN_RATED && rv.average !== null;
  $('#shop-rating-num').textContent = enough ? rv.average.toFixed(1) : '';
  $('#shop-rating-num').hidden = !enough;
  $('#shop-rating-count').textContent = `${rv.count} review${rv.count === 1 ? '' : 's'}`;
  el.classList.toggle('unrated', !enough);
  if (!el.dataset.wired) {
    el.dataset.wired = '1';
    el.addEventListener('click', () => {
      setTab('reviews');
      $('#shop-pane-reviews')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

// Exact below ten thousand, then abbreviated: a follower count is a claim, and
// "12.4K" is only honest because the real number is still what was counted.
const fmtCount = (n) => (n < 10000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`);

const SHOP_ICONS = {
  people: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 20v-2a4 4 0 0 0-3-3.87"/></svg>',
  discord: '<svg width="16" height="12" viewBox="0 0 127 96" fill="currentColor" aria-hidden="true"><path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z"/></svg>',
};
const LINK_ICONS = {
  discord: SHOP_ICONS.discord,
  x: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-6.4L6.4 22H3.2l7.3-8.3L1.2 2h6.4l4.4 5.9L18.9 2zm-1.1 18h1.7L7.1 3.9H5.3L17.8 20z"/></svg>',
  youtube: '<svg width="18" height="13" viewBox="0 0 24 17" fill="currentColor" aria-hidden="true"><path d="M23.5 2.7A3 3 0 0 0 21.4.5C19.6 0 12 0 12 0S4.4 0 2.6.5A3 3 0 0 0 .5 2.7 31.2 31.2 0 0 0 0 8.5a31.2 31.2 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.2c1.8.5 9.4.5 9.4.5s7.6 0 9.4-.5a3 3 0 0 0 2.1-2.2 31.2 31.2 0 0 0 .5-5.8 31.2 31.2 0 0 0-.5-5.8zM9.6 12.1V4.9l6.3 3.6-6.3 3.6z"/></svg>',
  instagram: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="5"/><circle cx="12" cy="12" r="4.4"/><circle cx="17.6" cy="6.4" r="1.3" fill="currentColor" stroke="none"/></svg>',
  tiktok: '<svg width="15" height="17" viewBox="0 0 20 23" fill="currentColor" aria-hidden="true"><path d="M15.5 0h-3.8v15.1a3.3 3.3 0 1 1-3.3-3.3c.3 0 .7 0 1 .1V8a7.2 7.2 0 0 0-1-.1 7.1 7.1 0 1 0 7.1 7.1V7.6a9 9 0 0 0 4.8 1.4V5.2A5.2 5.2 0 0 1 15.5 0z"/></svg>',
  website: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9.2"/><path d="M2.8 12h18.4M12 2.8c2.6 2.6 3.9 5.8 3.9 9.2s-1.3 6.6-3.9 9.2c-2.6-2.6-3.9-5.8-3.9-9.2s1.3-6.6 3.9-9.2z"/></svg>',
};
const socialLinks = () => {
  const links = state.store?.links ?? {};
  return Object.keys(LINK_ICONS).filter((k) => typeof links[k] === 'string' && /^https:\/\//.test(links[k]));
};

// One card, one shape — the Products grid is the only thing that builds these.
function productCard(plan) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'prod-card';
  const group = groupFor(plan);
  // "from" quotes the CHEAPEST option, so the cadence beside it has to be
  // that same option's — the parent's flag would price a $50/month option as
  // "from $50.00 lifetime" for a product whose lifetime price is $500.
  const cheapest = group.reduce((a, b) => (b.priceUsd < a.priceUsd ? b : a), group[0]);
  const priceHtml =
    group.length > 1 ? `<span class="prod-from">from</span> ${fmtPrice(cheapest.priceUsd)}` : fmtPrice(plan.priceUsd);
  // The interval is the same weight and colour as the amount: "$49.99 / month"
  // has to read as one string, not a number with a footnote.
  const per = cheapest.lifetime ? ' lifetime' : ` / ${esc(cheapest.interval ?? 'month')}`;
  const now = Math.floor(Date.now() / 1000);
  const roleCount = Array.isArray(plan.roleNames) ? plan.roleNames.length : 0;
  const meta =
    group.length > 1 ? `${group.length} options`
    : plan.expiresAt && plan.expiresAt > now ? 'Limited'
    : roleCount ? `${SHOP_ICONS.people}${roleCount} role${roleCount > 1 ? 's' : ''}`
    : '';
  const ph = `<span class="prod-ph" aria-hidden="true">${esc((plan.name || '?').slice(0, 1).toUpperCase())}</span>`;
  const media = plan.imageUrl
    ? (isVideoMedia(plan)
        ? `<video class="prod-shot media-fade" src="${esc(plan.imageUrl)}" autoplay muted loop playsinline preload="metadata" aria-hidden="true" onloadeddata="this.classList.add('loaded')"></video>`
        : `<img class="prod-shot media-fade" src="${esc(plan.imageUrl)}" alt="" loading="lazy" onload="this.classList.add('loaded')" />`)
    : ph;
  card.innerHTML =
    `<span class="prod-media">${media}<span class="prod-name">${esc(plan.name)}</span></span>` +
    `<span class="prod-foot"><span class="prod-price">${priceHtml}<span class="prod-per">${per}</span></span>` +
    `<span class="prod-meta">${meta}</span></span>`;
  // A dead image URL must not collapse .prod-media to 0px: swap in the same
  // letter tile the no-image branch uses, so the card keeps its shape and the
  // absolutely-positioned .prod-name stays inside .prod-card's overflow:hidden.
  const shot = card.querySelector('.prod-shot');
  if (shot) shot.onerror = () => { shot.outerHTML = ph; };
  card.onclick = () => openCheckout(plan.id);
  return card;
}

function renderShop() {
  // Restore the store-level title (a product page may have set its own).
  if (state.server?.name)
    document.title = `${state.server.name} — ${state.capabilities?.demo ? 'Demo Store' : 'Membership'}`;

  // Banner: image or video, and the slot never collapses — the identity block
  // hangs off its lower edge, so an absent banner still needs its height.
  // Null-guarded because a browser can hold a cached copy of the previous
  // store.html while already running this script: during a deploy the two
  // are versioned separately, and a hard throw here would blank the whole
  // storefront rather than lose one banner.
  const bImg = $('#shop-banner');
  const bVid = $('#shop-banner-video');
  const bUrl = state.store?.bannerUrl ?? null;
  const bVideo = state.store?.bannerKind === 'video';
  if (bImg) bImg.hidden = !bUrl || bVideo;
  if (bVid) bVid.hidden = !bUrl || !bVideo;
  if (bUrl && bVideo) { if (bVid && bVid.src !== bUrl) bVid.src = bUrl; }
  else if (bUrl && bImg) { if (bImg.src !== bUrl) bImg.src = bUrl; }
  $('#shop-hero')?.classList.toggle('no-banner', !bUrl);

  const name = state.brand ?? state.server?.name ?? '';
  const icon = $('#shop-icon');
  const iconPh = $('#shop-icon-ph');
  if (!icon || !iconPh) return;
  // The letter is always ready: the image's onerror swaps to it mid-render,
  // and a url that already failed counts as no icon on every later render.
  iconPh.textContent = (name || '?').slice(0, 1).toUpperCase();
  if (state.server?.iconUrl && icon.dataset.failed !== state.server.iconUrl) {
    icon.src = state.server.iconUrl;
    icon.hidden = false;
    iconPh.hidden = true;
  } else {
    icon.hidden = true;
    iconPh.hidden = false;
  }
  $('#shop-name').textContent = name;

  // The reference puts a star rating here. We have no reviews and will not
  // invent them, so the slot carries the true equivalent: which server this is.
  const sub = $('#shop-sub');
  const serverName = state.server?.name ?? '';
  const showSub = Boolean(serverName) && serverName !== name;
  sub.innerHTML = showSub ? `${SHOP_ICONS.discord}<span>${esc(serverName)}</span>` : '';
  sub.hidden = !showSub;

  const desc = (state.store?.description ?? '').trim();
  const descEl = $('#shop-desc');
  $('#shop-desc-text').textContent = desc;
  descEl.hidden = !desc;
  const more = $('#shop-desc-more');
  if (more) {
    const long = desc.length > 140;
    descEl.classList.toggle('clamped', long);
    more.hidden = !long;
    more.innerHTML = '&#8230; see more';
    more.onclick = () => {
      const nowClamped = descEl.classList.toggle('clamped');
      more.innerHTML = nowClamped ? '&#8230; see more' : 'see less';
    };
  }

  // The store's own links, and nothing else. This line used to also carry
  // "Secured by Stripe" and "Instant role delivery" — platform boilerplate
  // identical on every Dues store, which told a buyer nothing about THIS one
  // and pushed the store's real identity further down the page.
  const linkHtml = socialLinks()
    .map((k) => `<a class="shop-mlink" href="${esc(state.store.links[k])}" target="_blank" rel="noopener noreferrer" aria-label="${esc(k === 'x' ? 'X (Twitter)' : k)}">${LINK_ICONS[k]}</a>`)
    .join('');
  const metaline = $('#shop-metaline');
  metaline.innerHTML = linkHtml ? `<span class="shop-mgroup">${linkHtml}</span>` : '';
  metaline.hidden = !linkHtml; // an empty flex row still eats its margin

  // Counts are whatever the server counted. Followers stay hidden below ten:
  // "1 follower" reads worse than no number, and hiding is not lying.
  const joined = $('#shop-joined');
  const bits = [];
  const count = state.store?.memberCount;
  if (Number.isFinite(count) && count > 0) bits.push(`<span><b>${count}</b> members</span>`);
  const followers = state.store?.followers;
  if (Number.isFinite(followers) && followers >= 10) bits.push(`<span><b>${fmtCount(followers)}</b> followers</span>`);
  joined.innerHTML = bits.join('');
  joined.hidden = bits.length === 0;

  // Where the reference stacks member faces, we stack the roles a buyer
  // actually receives — real data in the same visual idiom.
  const roleLine = $('#shop-roleline');
  const roles = [...new Set(state.plans.filter((p) => !p.variantOf).flatMap((p) => p.roleNames ?? []))].filter(Boolean);
  if (roles.length) {
    const chips = roles.slice(0, 3)
      .map((r) => `<span class="shop-rolechip">${esc(String(r).replace(/^@/, '').slice(0, 2).toUpperCase())}</span>`)
      .join('');
    const shown = roles.slice(0, 2).map((r) => esc(String(r).startsWith('@') ? r : `@${r}`)).join(', ');
    const rest = roles.length - Math.min(2, roles.length);
    roleLine.innerHTML =
      `<span class="shop-rolestack" aria-hidden="true">${chips}</span>` +
      `<span>Includes <b>${shown}</b>${rest > 0 ? ` and ${rest} more role${rest > 1 ? 's' : ''}` : ''}</span>`;
    roleLine.hidden = false;
  } else roleLine.hidden = true;

  // About: plain text, escaped, split into paragraphs.
  const about = (state.store?.about ?? '').trim();
  if (about) $('#shop-about').innerHTML = about.split(/\n+/).map((line) => `<p>${esc(line.trim())}</p>`).join('');

  // Who is behind the store — the seller's own claim, rendered as written.
  const creator = (state.store?.creatorName ?? '').trim();
  const creatorEl = $('#shop-creator');
  if (creatorEl) {
    $('#shop-creator-name').textContent = creator;
    creatorEl.hidden = !creator;
  }

  // The team, also the seller's claim. No presence dots: Discord does not tell
  // us who is online, and a permanently-green dot is a made-up status.
  const team = Array.isArray(state.store?.team) ? state.store.team : [];
  const teamBox = $('#shop-team');
  if (teamBox) {
    teamBox.hidden = team.length === 0;
    if (team.length) {
      $('#shop-team-head').textContent = (state.store?.teamHeading ?? '').trim() || 'Team';
      $('#shop-team-grid').innerHTML = team
        .map(
          (m) => `<div class="shop-tm">
            <span class="shop-tm-face" aria-hidden="true">${esc(initialsOf(m.name))}</span>
            <b class="shop-tm-name">${esc(m.name)}</b>
            ${m.title ? `<span class="shop-tm-title">${esc(m.title)}</span>` : ''}
            ${m.handle ? `<span class="shop-tm-handle">@${esc(m.handle)}</span>` : ''}
          </div>`,
        )
        .join('');
    }
  }
  const aboutHead = $('#shop-about-head');
  if (aboutHead) aboutHead.hidden = !about;

  // Tabs: Products · Reviews · About. Each appears only when the store has
  // that section, and when only Products is left the whole bar goes with it,
  // because a single tab is a switch with one position. The Products pane
  // shows either way: setTab runs below regardless of the bar being on screen.
  const tabs = $('#shop-tabs');
  const aboutTab = $('#shop-tab-about');
  const reviewsTab = $('#shop-tab-reviews');
  const hasAboutPane = hasSection('about');
  const hasReviews = hasSection('reviews');
  if (aboutTab) aboutTab.hidden = !hasAboutPane;
  if (reviewsTab) reviewsTab.hidden = !hasReviews;
  renderRating();
  if (tabs) {
    const extra = (hasAboutPane ? 1 : 0) + (hasReviews ? 1 : 0);
    tabs.hidden = extra === 0;
    // Tells the stylesheet to put the identity/pane hairline back when the bar
    // is not there to draw it.
    $('#shop').dataset.tabs = extra ? 'on' : 'off';
    if (!tabs.dataset.wired) {
      tabs.dataset.wired = '1';
      tabs.querySelectorAll('.shop-tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    }
  }

  const products = state.plans.filter((p) => !p.variantOf);
  $('#shop-empty').hidden = products.length > 0;
  const grid = $('#shop-grid');
  grid.innerHTML = '';
  for (const plan of products) grid.append(productCard(plan));

  // The one blue button on the page used to do nothing. With a single product
  // it opens that checkout; otherwise it takes you to the grid.
  const join = $('#shop-join');
  if (join && !join.dataset.wired) {
    join.dataset.wired = '1';
    join.addEventListener('click', () => {
      const only = state.plans.filter((p) => !p.variantOf);
      if (only.length === 1) { openCheckout(only[0].id); return; }
      setTab('products');
      $('#shop-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  wireFollow();

  // Share: copies the store's canonical link (desktop) or opens the native
  // share sheet (touch). Frontend-only — no network, nothing invented.
  const share = $('#shop-share');
  if (share && STORE_SLUG) {
    share.hidden = false;
    if (!share.dataset.wired) {
      share.dataset.wired = '1';
      share.addEventListener('click', async () => {
        const url = `${location.origin}/${STORE_SLUG}`;
        const title = state.brand ?? state.server?.name ?? 'Dues store';
        if (navigator.share && window.matchMedia?.('(pointer: coarse)').matches) {
          try { await navigator.share({ title, url }); } catch { /* sheet dismissed */ }
          return;
        }
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          // Clipboard API can be denied (permissions, http) — fall back.
          const tmp = document.createElement('textarea');
          tmp.value = url;
          tmp.style.cssText = 'position:fixed;top:-200px;opacity:0';
          document.body.append(tmp);
          tmp.select();
          try { document.execCommand('copy'); } catch { /* nothing left to try */ }
          tmp.remove();
        }
        share.classList.add('copied');
        clearTimeout(share._copiedTimer);
        share._copiedTimer = setTimeout(() => share.classList.remove('copied'), 1800);
      });
    }
  }

  setTab($('#shop')?.dataset.tab || 'products');
}


// Following: the count shown is always the server's COUNT(*). The button flips
// optimistically because that is the user's own state, but the NUMBER never
// moves until the server says what it is.
function wireFollow() {
  const btn = $('#shop-follow');
  if (!btn) return;
  if (!state.store?.followable) { btn.hidden = true; return; }
  btn.hidden = false;
  const following = Boolean(state.me?.following?.includes(STORE_SLUG));
  btn.dataset.following = following ? '1' : '0';
  btn.setAttribute('aria-pressed', following ? 'true' : 'false');
  if (btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', async () => {
    if (!state.me?.loggedIn) {
      // Come back and finish the follow the visitor actually asked for.
      try { sessionStorage.setItem('dues.follow', STORE_SLUG); } catch { /* private mode */ }
      location.href = `/auth/login?store=${encodeURIComponent(STORE_SLUG)}`;
      return;
    }
    const was = btn.dataset.following === '1';
    btn.dataset.following = was ? '0' : '1';
    btn.setAttribute('aria-pressed', was ? 'false' : 'true');
    const ok = await postFollow(was ? 'unfollow' : 'follow');
    if (!ok) {
      btn.dataset.following = was ? '1' : '0';
      btn.setAttribute('aria-pressed', was ? 'true' : 'false');
    }
  });
}

async function postFollow(action) {
  try {
    const res = await fetch('/api/follow', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ store: STORE_SLUG, action }),
    });
    if (!res.ok) return false;
    const body = await res.json();
    if (state.store) state.store.followers = body.followers;
    state.me = state.me ?? {};
    const set = new Set(state.me.following ?? []);
    if (body.following) set.add(STORE_SLUG); else set.delete(STORE_SLUG);
    state.me.following = [...set];
    if (state.view === 'shop') renderShop();
    return true;
  } catch {
    return false;
  }
}

// Every product owns a link: /<store>/<linkSlug or plan key>.
const productPath = (plan) => `/${STORE_SLUG}/${encodeURIComponent(plan.linkSlug ?? plan.id)}`;

function openCheckout(planId) {
  const plan = state.plans.find((p) => p.id === planId);
  state.planId = planId;
  state.view = 'checkout';
  history.pushState({ plan: planId }, '', plan ? productPath(plan) : `/${STORE_SLUG}?plan=${encodeURIComponent(planId)}`);
  render();
  // A code applied on another product's page is re-checked against this one.
  if (state.discount && state.discount.planId !== planId) applyDiscount();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function openShop() {
  state.view = 'shop';
  history.pushState({}, '', `/${STORE_SLUG}`);
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// The browser's back button walks between shop, checkout and product links.
addEventListener('popstate', () => {
  const seg = (location.pathname.match(/^\/[a-z0-9-]+\/([a-z0-9-]+)$/) ?? [])[1] ?? null;
  const plan =
    new URLSearchParams(window.location.search).get('plan') ??
    (seg ? (state.plans.find((p) => (p.linkSlug ?? p.id) === seg || p.id === seg)?.id ?? null) : null);
  if (plan && state.plans.some((p) => p.id === plan)) {
    state.planId = plan;
    state.view = 'checkout';
  } else {
    state.view = state.plans.filter((p) => !p.variantOf).length > 1 ? 'shop' : 'checkout';
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
        Check the link your community shared — or start your own store with Dues.</p>
      <a class="btn-pill" style="display:inline-block;text-decoration:none;margin-top:8px" href="/">Go to dues.gg</a>`;
    return;
  }
  const plansBody = await plansRes.json();
  state.plans = plansBody.plans;
  // Learn the store's currency before anything renders a price. Every plan in
  // a store shares it, so the first plan answers for the page; the store-level
  // value is the fallback for a store with nothing for sale yet.
  PAGE_CURRENCY = String(plansBody.plans?.[0]?.currency ?? plansBody.currency ?? 'usd').toLowerCase();
  state.capabilities = plansBody.capabilities;
  state.server = plansBody.server;
  state.store = plansBody.store ?? null;
  state.brand = plansBody.brand ?? null;
  state.platform = plansBody.platform ?? state.platform;
  state.me = await meRes.json();

  // Finish a follow that sent the visitor through Discord login: they already
  // asked for it, so completing it on return is the answer to their click, not
  // a new action taken on their behalf.
  try {
    if (sessionStorage.getItem('dues.follow') === STORE_SLUG) {
      sessionStorage.removeItem('dues.follow');
      if (state.me?.loggedIn && state.store?.followable && !state.me.following?.includes(STORE_SLUG)) {
        postFollow('follow');
      }
    }
  } catch { /* private mode: the follow is simply not resumed */ }

  // Back from the OAuth round trip (or a shared link): land on that plan,
  // scrolled to the pay button, instead of the top of the page.
  const search = new URLSearchParams(window.location.search);
  const requested = search.get('plan');
  const requestedPlan =
    state.plans.find((p) => p.id === requested) ??
    (PRODUCT_SLUG ? state.plans.find((p) => (p.linkSlug ?? p.id) === PRODUCT_SLUG || p.id === PRODUCT_SLUG) : undefined);
  state.planId = requestedPlan?.id ?? state.plans[0]?.id ?? null;
  // A product link that matches nothing (renamed link, deleted product) must
  // NEVER quietly open the checkout of some other product — that sells the
  // buyer the wrong thing. It lands on the shop instead, where every product
  // is visible and correctly priced.
  const deadProductLink = Boolean(PRODUCT_SLUG) && !requestedPlan;
  // The overall store page: multi-product stores open on the shop. A ?plan
  // deep link, a checkout return, or the dashboard preview (?view=checkout)
  // goes straight to the order card. One-PRODUCT stores skip the shop —
  // a product's price options don't count as separate products.
  // A store with NOTHING sellable (every product paused or expired) is not a
  // one-product store: state.planId is null exactly then, and the shop's
  // empty-state copy is the only honest page — never a nameless order card.
  const productCount = state.plans.filter((p) => !p.variantOf).length;
  state.view =
    state.planId && !deadProductLink && (requestedPlan || productCount === 1 || search.get('checkout') || search.get('view') === 'checkout')
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

// Browser chrome takes the store's colour, not the platform's.
//
// A store page carries no theme-color of its own, so Safari tinted its bottom
// bar from the platform's default ground — a navy band across the foot of a
// black storefront, sitting on top of the pay button. Safari 26 ignores this
// tag and samples the .ui-tint-b strip instead; everything else still reads
// it, so both paths are covered. The value comes from the body's COMPUTED
// background, which is whatever the seller's theme resolved to, rather than a
// second copy of the palette that could drift from it.
(function syncChrome() {
  const paint = () => {
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return;
      let m = document.querySelector('meta[name="theme-color"]');
      if (!m) {
        m = document.createElement('meta');
        m.setAttribute('name', 'theme-color');
        document.head.appendChild(m);
      }
      m.setAttribute('content', bg);
    } catch { /* a tinted bar is never worth throwing over */ }
  };
  paint();
  addEventListener('pageshow', paint);
})();
