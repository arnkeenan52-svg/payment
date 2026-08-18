// Ripley owner dashboard — Subscord-style app: left sidebar (Overview /
// Products / Members / Transactions / Discounts / Store / Settings), dense
// tables, one accent for the primary action of each screen. Views are
// hash-routed (#/ picker, #/setup/<guildId> wizard, #/store/<slug>/<section>).
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDT = (unix) =>
  new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
  ', ' + new Date(unix * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtD = (unix) => new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

const I = {
  plus: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  arrow: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  back: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  copy: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  external: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>',
  bot: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M8 4h8"/><path d="M9 14h.01M15 14h.01"/></svg>',
  search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  dollar: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  users: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  infinity: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 12c-2-2.7-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.3 6-4zm0 0c2 2.7 4 4 6 4a4 4 0 1 0 0-8c-2 0-4 1.3-6 4z"/></svg>',
  cart: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="21" r="1.5"/><circle cx="19" cy="21" r="1.5"/><path d="M2 3h3l2.6 12.5a2 2 0 0 0 2 1.5h8.7a2 2 0 0 0 2-1.6L22 8H6"/></svg>',
  home: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  box: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
  tag: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4L12 22 2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
  gear: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>',
  shop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16l1 5a3 3 0 0 1-3 3 3 3 0 0 1-3-3 3 3 0 0 1-6 0 3 3 0 0 1-3 3 3 3 0 0 1-3-3l1-5z"/><path d="M5 12v9h14v-9M9 21v-6h6v6"/></svg>',
};

const state = {
  me: null, guilds: null, botInvite: '', data: null, dataSlug: undefined,
  range: '30',
  products: null, productsSlug: undefined,
  discounts: null, discountsSlug: undefined,
};

// ── data ──────────────────────────────────────────────────────────────────────

async function loadMe() {
  state.me = await (await fetch('/api/me')).json();
}

async function loadGuilds() {
  const res = await fetch('/api/my/guilds');
  if (res.status === 428) return 'reauth';
  if (!res.ok) return 'denied';
  const data = await res.json();
  state.guilds = data.guilds;
  state.botInvite = data.botInvite;
  return 'ok';
}

async function loadBilling() {
  const res = await fetch('/api/billing');
  if (!res.ok) return null;
  return res.json();
}

async function loadPayments(slug) {
  if (state.data && state.dataSlug === slug) return state.data;
  const res = await fetch(`/api/admin/payments${slug ? `?store=${encodeURIComponent(slug)}` : ''}`);
  if (!res.ok) return null;
  state.data = await res.json();
  state.dataSlug = slug;
  return state.data;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.detail ?? out.error ?? 'Something went wrong — try again.');
  return out;
}

async function loadProducts(store) {
  if (state.products && state.productsSlug === store.slug) return state.products;
  const out = await api('/api/onboard', { step: 'products', storeId: store.id });
  state.products = out.products;
  state.productsSlug = store.slug;
  return state.products;
}

// ── shell ─────────────────────────────────────────────────────────────────────

function renderNav() {
  const el = $('#account');
  const me = state.me;
  if (!me?.loggedIn) {
    el.innerHTML = '<a class="nav-link" href="/store">Store</a><button class="btn-pill" id="login">Sign in with Discord</button>';
    $('#login').onclick = () => (window.location.href = '/auth/login');
    return;
  }
  el.innerHTML = `<a class="nav-link" href="/store">Store</a><a class="nav-link" href="/account">Account</a>${
    me.isOwner ? '<a class="nav-link" href="/diagnostics">Diagnostics</a>' : ''
  }<span>@${esc(me.username ?? me.discordId)}</span><button class="btn-ghost" id="logout">Sign out</button>`;
  $('#logout').onclick = () => (window.location.href = '/auth/logout');
}

function fieldErr(id, msg) {
  const el = $(`#err-${id}`);
  if (el) el.textContent = msg ?? '';
}

const copyBtn = (btn, text) => async () => {
  try {
    await navigator.clipboard.writeText(text);
    const prev = btn.innerHTML;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.innerHTML = prev), 1500);
  } catch { /* noop */ }
};

// ── view: server picker ───────────────────────────────────────────────────────

function guildRow(g) {
  const icon = g.iconUrl
    ? `<img class="g-icon" src="${esc(g.iconUrl)}" alt="" width="40" height="40" />`
    : `<span class="g-icon g-icon-fallback" aria-hidden="true">${esc((g.name || '?').slice(0, 1).toUpperCase())}</span>`;
  const chip = g.store
    ? g.store.status === 'live'
      ? '<span class="chip chip-good">Live</span>'
      : '<span class="chip chip-warn">Draft</span>'
    : g.owner
      ? '<span class="chip chip-off">Owner</span>'
      : '<span class="chip chip-off">Admin</span>';
  return `
    <a class="g-row" href="${g.store ? `#/store/${esc(g.store.slug)}` : `#/setup/${esc(g.id)}`}">
      ${icon}
      <span class="g-name">${esc(g.name)} ${chip}</span>
      <span class="g-action">${g.store ? I.arrow : I.plus}</span>
    </a>`;
}

async function viewPicker() {
  const me = state.me;
  if (!me?.loggedIn) {
    $('#content').innerHTML = `
      <div class="picker-wrap"><section class="picker-card panel">
        <div class="picker-head"><a class="wiz-back" href="/">${I.back} Back</a><img src="/ripley.png" alt="Ripley" height="20" class="platform-mark" /><span></span></div>
        <p class="note-help" style="text-align:center">Sign in with Discord to see your servers and set up a store.</p>
        <button class="btn-pill" id="login2" style="align-self:center">Sign in with Discord</button>
      </section></div>`;
    $('#login2').onclick = () => (window.location.href = '/auth/login');
    return;
  }
  $('#content').innerHTML = `
    <div class="picker-wrap"><section class="picker-card panel">
      <div class="picker-head"><a class="wiz-back" href="/">${I.back} Back</a><img src="/ripley.png" alt="Ripley" height="20" class="platform-mark" /><span></span></div>
      <div class="picker-user">
        <span class="g-icon g-icon-fallback">${esc((me.username ?? '?').slice(0, 1).toUpperCase())}</span>
        <span>Logged in as <strong>${esc(me.username ?? me.discordId)}</strong></span>
        <button class="btn-ghost" id="logout2">Logout</button>
      </div>
      <div class="picker-welcome"><h1>Welcome to Ripley</h1><p>Let’s get your Discord server monetized in a few steps.</p></div>
      <p class="picker-label">Your Servers</p>
      <div class="g-list" id="g-list"><div class="sk-row panel" aria-hidden="true"></div><div class="sk-row panel" aria-hidden="true"></div></div>
    </section></div>`;
  $('#logout2').onclick = () => (window.location.href = '/auth/logout');
  const status = await loadGuilds();
  const list = $('#g-list');
  if (!list) return;
  if (status === 'reauth') {
    list.innerHTML = `<p class="note-help">One more sign-in needed — a new permission lets Ripley list your servers.</p>
      <button class="btn-pill" id="reauth">Sign in again</button>`;
    $('#reauth').onclick = () => (window.location.href = '/auth/login');
    return;
  }
  if (status !== 'ok') {
    list.innerHTML = '<p class="note-help">Could not load your servers — refresh to try again.</p>';
    return;
  }
  if (!state.guilds.length) {
    list.innerHTML = `<p class="note-help">No servers where you hold <strong>Manage Server</strong> or <strong>Administrator</strong>.</p>
      <a class="btn-pill" style="align-self:flex-start;text-decoration:none" href="${esc(state.botInvite)}" target="_blank" rel="noopener">Invite the bot ${I.external}</a>`;
    return;
  }
  list.innerHTML = state.guilds.map(guildRow).join('');
}

// ── view: onboarding wizard ───────────────────────────────────────────────────

const wiz = { guildId: null, storeId: null, storeSlug: null, planKey: null, poll: null };

function stepper(current) {
  const steps = ['Invite the bot', 'Connect Stripe', 'Create a product', 'Pick the role'];
  return `
    <div class="wiz-progress"><span>Step ${current} of 4</span><span>${current - 1} completed</span></div>
    <div class="step-bar" aria-hidden="true"><span style="width:${((current - 1) / 3) * 100}%"></span></div>
    <ol class="stepper" aria-label="Setup progress">
      ${steps
        .map((s, i) => {
          const n = i + 1;
          const cls = n < current ? 'done' : n === current ? 'now' : '';
          return `<li class="step-i ${cls}"><span class="step-dot">${n < current ? I.check : n}</span><span class="step-lbl">${s}</span></li>`;
        })
        .join('')}
    </ol>`;
}

function wizShell(g, current, inner) {
  clearInterval(wiz.poll);
  $('#content').innerHTML = `
    <div class="wiz-wrap"><section class="panel wiz-card">
      <div class="wiz-head">
        <div><h1>Set up ${esc(g.name)}</h1><p class="note-help">Let’s get your Discord server monetized in a few steps.</p></div>
        <a class="wiz-back" href="#/">${I.back} All servers</a>
      </div>
      ${stepper(current)}
      ${inner}
    </section></div>`;
}

async function viewSetup(guildId) {
  if (!state.guilds) await loadGuilds();
  const g = (state.guilds ?? []).find((x) => x.id === guildId);
  if (!g) {
    location.hash = '#/';
    return;
  }
  if (g.store) {
    location.hash = `#/store/${g.store.slug}`;
    return;
  }
  wiz.guildId = guildId;
  renderSetupStep(g, wiz.storeId ? 3 : g.botIn ? 2 : 1);
}

function renderSetupStep(g, step) {
  if (step === 1) {
    wizShell(g, 1, `
      <h2>${I.bot} Invite the Ripley bot</h2>
      <p class="note-help">The bot delivers roles to buyers. Invite it to <strong>${esc(g.name)}</strong>, then hit Continue — this page also advances by itself the moment the bot joins.</p>
      <div class="wiz-actions">
        <a class="btn-secondary" id="invite-link" href="${esc(state.botInvite)}&guild_id=${esc(g.id)}" target="_blank" rel="noopener">Invite the bot ${I.external}</a>
        <button class="btn-pill" id="recheck">Continue ${I.arrow}</button>
      </div>
      <p class="note-help" id="bot-wait" hidden>Waiting for the bot to join ${esc(g.name)}…</p>
      <p class="field-err" id="err-bot" role="alert"></p>`);
    // Presence check via the bot token only — never the rate-limited
    // user-guilds listing, which broke the old "check again" button.
    const botCheck = async () => {
      const out = await api('/api/onboard', { step: 'botcheck', guildId: g.id }).catch(() => ({}));
      return out.botIn === true;
    };
    const advance = () => {
      clearInterval(wiz.poll);
      wiz.poll = null;
      renderSetupStep({ ...g, botIn: true }, 2);
    };
    $('#invite-link').addEventListener('click', () => {
      const wait = $('#bot-wait');
      if (wait) wait.hidden = false;
      clearInterval(wiz.poll);
      let tries = 0;
      wiz.poll = setInterval(async () => {
        if (++tries > 40) return clearInterval(wiz.poll);
        if (await botCheck()) advance();
      }, 3000);
    });
    $('#recheck').onclick = async () => {
      const btn = $('#recheck');
      btn.disabled = true;
      btn.textContent = 'Checking…';
      fieldErr('bot', '');
      if (await botCheck()) return advance();
      btn.disabled = false;
      btn.innerHTML = `Continue ${I.arrow}`;
      fieldErr('bot', 'Not seeing the bot in that server yet — finish the invite in the Discord tab, then hit Continue.');
    };
    return;
  }

  if (step === 2) {
    wizShell(g, 2, `
      <h2>Connect Stripe</h2>
      <p class="note-help">Payments go straight to <strong>your own Stripe account</strong> — Ripley never holds your money. Find the key in Stripe → Developers → API keys.</p>
      <label class="field">
        <span class="field-label">Store name <span aria-hidden="true">*</span></span>
        <input id="f-name" type="text" maxlength="60" value="${esc(g.name)}" autocomplete="organization" />
        <span class="field-help">Shown to buyers on your store page.</span>
        <span class="field-err" id="err-name" role="alert"></span>
      </label>
      <label class="field">
        <span class="field-label">Stripe secret key <span aria-hidden="true">*</span></span>
        <input id="f-key" type="password" placeholder="sk_live_…" autocomplete="off" spellcheck="false" />
        <span class="field-help">Starts with sk_live_ (or sk_test_ while testing). Stored encrypted; validated with Stripe before anything is saved. Your webhook is registered automatically.</span>
        <span class="field-err" id="err-key" role="alert"></span>
      </label>
      <div class="wiz-actions"><button class="btn-pill" id="next2">Continue ${I.arrow}</button></div>`);
    $('#next2').onclick = async () => {
      const name = $('#f-name').value.trim();
      const key = $('#f-key').value.trim();
      fieldErr('name', ''); fieldErr('key', '');
      if (!name) return fieldErr('name', 'Give your store a name.');
      if (!/^(sk|rk)_(live|test)_/.test(key)) return fieldErr('key', 'That does not look like a Stripe secret key (sk_live_… or sk_test_…).');
      const btn = $('#next2');
      btn.disabled = true;
      btn.textContent = 'Validating with Stripe…';
      try {
        const data = await api('/api/onboard', { step: 'store', guildId: g.id, name, stripeKey: key });
        wiz.storeId = data.store.id;
        wiz.storeSlug = data.store.slug;
        renderSetupStep(g, 3);
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = `Continue ${I.arrow}`;
        fieldErr('key', err.message);
      }
    };
    return;
  }

  if (step === 3) {
    wizShell(g, 3, `
      <h2>Create a product</h2>
      <label class="field">
        <span class="field-label">Product name <span aria-hidden="true">*</span></span>
        <input id="f-pname" type="text" maxlength="80" placeholder="Premium" />
        <span class="field-err" id="err-pname" role="alert"></span>
      </label>
      <label class="field">
        <span class="field-label">Description</span>
        <input id="f-pdesc" type="text" maxlength="300" placeholder="Everything, for life." />
        <span class="field-help">One line buyers see under the product name.</span>
      </label>
      <div class="field-row">
        <label class="field">
          <span class="field-label">Price (USD) <span aria-hidden="true">*</span></span>
          <input id="f-price" type="number" inputmode="decimal" min="1" max="10000" step="0.01" placeholder="59.99" />
          <span class="field-err" id="err-price" role="alert"></span>
        </label>
        <label class="field">
          <span class="field-label">Billing</span>
          <select id="f-billing"><option value="lifetime" selected>One-time · lifetime</option><option value="month">Monthly subscription</option></select>
        </label>
      </div>
      <label class="field">
        <span class="field-label">Image URL</span>
        <input id="f-img" type="url" placeholder="https://…  (optional)" spellcheck="false" />
        <span class="field-help">Shown on your store page and in Stripe checkout.</span>
      </label>
      <div class="wiz-actions"><button class="btn-pill" id="next3">Continue ${I.arrow}</button></div>
      <p class="field-err" id="err-prod" role="alert"></p>`);
    $('#next3').onclick = async () => {
      const name = $('#f-pname').value.trim();
      const priceUsd = Number($('#f-price').value);
      fieldErr('pname', ''); fieldErr('price', ''); fieldErr('prod', '');
      if (!name) return fieldErr('pname', 'Name your product.');
      if (!Number.isFinite(priceUsd) || priceUsd < 1) return fieldErr('price', 'Set a price of at least $1.');
      const btn = $('#next3');
      btn.disabled = true;
      btn.textContent = 'Creating your product…';
      try {
        const data = await api('/api/onboard', {
          step: 'product',
          storeId: wiz.storeId,
          name,
          description: $('#f-pdesc').value.trim(),
          imageUrl: $('#f-img').value.trim(),
          priceUsd,
          lifetime: $('#f-billing').value === 'lifetime',
        });
        wiz.planKey = data.plan.planKey;
        renderSetupStep(g, 4);
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = `Continue ${I.arrow}`;
        fieldErr('prod', err.message);
      }
    };
    return;
  }

  wizShell(g, 4, `
    <h2>Pick the role buyers receive</h2>
    <p class="note-help" id="role-hint">Loading roles…</p>
    <div class="role-list" id="role-list"></div>
    <p class="field-err" id="err-role" role="alert"></p>`);
  (async () => {
    let data;
    try {
      data = await api('/api/onboard', { step: 'roles', storeId: wiz.storeId });
    } catch (err) {
      $('#role-hint').textContent = err.message;
      return;
    }
    $('#role-hint').innerHTML = `Greyed roles sit at or above the bot’s top role <strong>${esc(data.botTop.name)}</strong> — drag Ripley’s role higher in Server Settings → Roles to unlock them.`;
    const list = $('#role-list');
    list.innerHTML = '';
    for (const role of data.roles) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'role-row';
      row.disabled = !role.usable;
      row.innerHTML = `<span class="role-dot" style="background:${role.color ?? 'var(--dim)'}"></span>
        <span class="role-name">${esc(role.name)}</span>
        <span class="role-pos">${role.usable ? `#${role.position}` : esc(role.reason ?? '')}</span>`;
      if (role.usable)
        row.onclick = async () => {
          row.disabled = true;
          try {
            const out = await api('/api/onboard', { step: 'role', storeId: wiz.storeId, planKey: wiz.planKey, roleId: role.id });
            state.guilds = null;
            state.data = null;
            state.products = null;
            renderLive(g, out.store.slug);
          } catch (err) {
            row.disabled = false;
            fieldErr('role', err.message);
          }
        };
      list.append(row);
    }
  })();
}

function renderLive(g, slug) {
  const link = `${location.origin}/s/${slug}`;
  wizShell(g, 4, `
    <div class="wiz-done">
      <span class="done-ring">${I.check}</span>
      <h2>Your store is live</h2>
      <div class="share-row">
        <code class="share-link" id="share-link">${esc(link)}</code>
        <button class="btn-secondary" id="copy-link">${I.copy} Copy</button>
      </div>
      <p class="note-help">Buyers sign in with Discord, pay on Stripe, and get their role in seconds. Every sale lands on this dashboard.</p>
      <div class="wiz-actions">
        <a class="btn-pill" href="#/store/${esc(slug)}">Go to dashboard ${I.arrow}</a>
        <a class="btn-secondary" href="${esc(link)}" target="_blank" rel="noopener">View your store ${I.external}</a>
      </div>
    </div>`);
  $('#copy-link').onclick = copyBtn($('#copy-link'), link);
}

// ── store dashboard: shared bits ─────────────────────────────────────────────

function statCard(label, value, icon, delta = null) {
  const chip =
    delta === null
      ? ''
      : `<span class="delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}${Math.round(delta)}%</span>`;
  return `<div class="panel stat"><div class="stat-top"><span class="stat-label">${label}</span><span class="stat-ic">${icon}</span></div><span class="stat-value">${value}${chip}</span></div>`;
}

// Daily bars for bounded ranges; monthly bars for all-time.
function revenueChart(payments, rangeDays) {
  const W = 920, H = 150;
  let buckets, labelFor;
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  if (rangeDays) {
    const dayMs = 86400000;
    buckets = Array.from({ length: rangeDays }, () => 0);
    for (const p of payments) {
      const idx = rangeDays - 1 - Math.floor((end.getTime() - p.createdAt * 1000) / dayMs);
      if (idx >= 0 && idx < rangeDays) buckets[idx] += p.amountUsd;
    }
    labelFor = (i) => new Date(end.getTime() - (rangeDays - 1 - i) * dayMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } else {
    const first = payments.length ? Math.min(...payments.map((p) => p.createdAt)) : Date.now() / 1000;
    const months = [];
    const d = new Date(first * 1000);
    d.setDate(1); d.setHours(0, 0, 0, 0);
    const stop = new Date();
    while (d <= stop && months.length < 24) {
      months.push(new Date(d));
      d.setMonth(d.getMonth() + 1);
    }
    buckets = months.map(() => 0);
    for (const p of payments) {
      const pd = new Date(p.createdAt * 1000);
      const idx = months.findIndex((m) => m.getFullYear() === pd.getFullYear() && m.getMonth() === pd.getMonth());
      if (idx >= 0) buckets[idx] += p.amountUsd;
    }
    labelFor = (i) => months[i].toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  }
  const max = Math.max(...buckets, 1);
  const total = buckets.reduce((a, b) => a + b, 0);
  const bw = W / buckets.length;
  const bars = buckets
    .map((v, i) => {
      const h = Math.max(v > 0 ? 5 : 2, (v / max) * (H - 12));
      const pad = Math.min(3, bw * 0.15);
      return `<rect x="${(i * bw + pad).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw - pad * 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2"
        fill="${v > 0 ? 'var(--accent)' : 'var(--edge)'}" opacity="${v > 0 ? 0.92 : 0.55}"><title>${esc(`${labelFor(i)}: ${usd(v)}`)}</title></rect>`;
    })
    .join('');
  return `<svg class="rev-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue over time, totaling ${usd(total)}">${bars}</svg>`;
}

function chipFor(p) {
  return p.lifetime
    ? '<span class="chip chip-good">Lifetime</span>'
    : p.entitled
      ? '<span class="chip chip-good">Active</span>'
      : `<span class="chip chip-off">${esc(p.status)}</span>`;
}

function paymentsRows(list) {
  return list
    .map(
      (p) => `<tr>
        <td>${p.username ? '@' + esc(p.username) : ''}<span class="dim"> ${esc(p.discordId)}</span></td>
        <td>${esc(p.planName)}</td>
        <td class="num">${usd(p.amountUsd)}</td>
        <td>${chipFor(p)}</td>
        <td class="dim">${fmtDT(p.createdAt)}</td>
      </tr>`,
    )
    .join('');
}

// ── store dashboard: sections ────────────────────────────────────────────────

const SECTIONS = [
  ['overview', 'Overview', 'home'],
  ['products', 'Products', 'box'],
  ['members', 'Members', 'users'],
  ['payments', 'Transactions', 'cart'],
  ['discounts', 'Discounts', 'tag'],
  ['store', 'Store', 'shop'],
  ['settings', 'Settings', 'gear'],
];

function sectionOverview(data, store, slug) {
  const rangeDays = state.range === 'all' ? null : Number(state.range);
  const nowS = Date.now() / 1000;
  const cut = rangeDays ? nowS - rangeDays * 86400 : 0;
  const inRange = data.payments.filter((p) => p.createdAt >= cut);
  const prevRange = rangeDays ? data.payments.filter((p) => p.createdAt >= cut - rangeDays * 86400 && p.createdAt < cut) : [];
  const sum = (l) => l.reduce((s, p) => s + p.amountUsd, 0);
  const rev = sum(inRange);
  const revPrev = sum(prevRange);
  const delta = rangeDays && revPrev > 0 ? ((rev - revPrev) / revPrev) * 100 : null;
  const salesDelta = rangeDays && prevRange.length > 0 ? ((inRange.length - prevRange.length) / prevRange.length) * 100 : null;
  const mrr = sum(data.payments.filter((p) => p.entitled && !p.lifetime));
  const label = rangeDays ? `${rangeDays}-Day` : 'All-Time';

  const byPlan = new Map();
  for (const p of inRange) byPlan.set(p.planName, (byPlan.get(p.planName) ?? 0) + p.amountUsd);
  const top = [...byPlan.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topMax = Math.max(...top.map(([, v]) => v), 1);

  const recent = data.payments.slice(0, 6);
  return `
    <div class="ov-toolbar">
      <h2 class="sec-title">Overview</h2>
      <select id="range-sel" class="store-switch" aria-label="Time period">
        <option value="7" ${state.range === '7' ? 'selected' : ''}>Last 7 days</option>
        <option value="30" ${state.range === '30' ? 'selected' : ''}>Last 30 days</option>
        <option value="90" ${state.range === '90' ? 'selected' : ''}>Last 90 days</option>
        <option value="all" ${state.range === 'all' ? 'selected' : ''}>All time</option>
      </select>
    </div>
    <div id="checklist-slot"></div>
    <div class="stat-grid five">
      ${statCard(`${label} Revenue`, usd(rev), I.dollar, delta)}
      ${statCard(`${label} Sales`, inRange.length, I.cart, salesDelta)}
      ${statCard('MRR', usd(mrr), I.dollar)}
      ${statCard('Active Members', data.totals.activeMembers, I.users)}
      ${statCard('All-Time Revenue', usd(data.totals.allTimeUsd), I.infinity)}
    </div>
    <div class="chart-grid">
      <section class="panel chart-card">
        <div class="card-head"><div><h3>Revenue Over Time</h3><p class="card-sub">${rangeDays ? `Daily revenue, last ${rangeDays} days` : 'Monthly revenue, all time'}</p></div><span class="chart-total">${usd(rev)}</span></div>
        ${inRange.length || !rangeDays ? revenueChart(inRange, rangeDays) : '<div class="empty-chart">No data in this period</div>'}
      </section>
      <section class="panel chart-card">
        <div class="card-head"><div><h3>Top Products</h3><p class="card-sub">Revenue by product, ${rangeDays ? `last ${rangeDays} days` : 'all time'}</p></div></div>
        ${
          top.length
            ? `<ul class="top-list">${top
                .map(
                  ([name, v]) => `<li><span class="top-meta"><strong>${esc(name)}</strong><span class="num">${usd(v)}</span></span>
                    <span class="top-bar"><span style="width:${Math.max((v / topMax) * 100, 2)}%"></span></span></li>`,
                )
                .join('')}</ul>`
            : '<div class="empty-chart">No sales in this period</div>'
        }
      </section>
    </div>
    <div class="chart-grid">
      <section class="panel table-panel">
        <div class="card-head"><div><h3>Recent Transactions</h3><p class="card-sub">Latest activity in your store</p></div>
        <a class="btn-secondary" href="#/store/${esc(slug)}/payments">View all ${I.arrow}</a></div>
        ${
          data.payments.length
            ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Customer</th><th>Product</th><th class="num">Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>${paymentsRows(data.payments.slice(0, 8))}</tbody></table></div>`
            : `<div class="empty-chart">No transactions yet — share your store link from the Store section.</div>`
        }
      </section>
      <section class="panel chart-card">
        <div class="card-head"><div><h3>Recent Sales</h3><p class="card-sub">Latest purchases</p></div></div>
        ${
          recent.length
            ? `<ul class="sales-list">${recent
                .map(
                  (p) => `<li><span class="g-icon g-icon-fallback sale-ic">${esc((p.username ?? '?').slice(0, 1).toUpperCase())}</span>
                    <span class="sale-meta"><strong>${p.username ? '@' + esc(p.username) : esc(p.discordId)}</strong><span class="dim">${esc(p.planName)}</span></span>
                    <span class="sale-amt">${usd(p.amountUsd)}</span></li>`,
                )
                .join('')}</ul>`
            : '<div class="empty-chart">No recent sales</div>'
        }
      </section>
    </div>`;
}

// Setup checklist: shown until everything passes (tenant stores only).
async function renderChecklist(store, slug) {
  const slot = $('#checklist-slot');
  if (!slot || store.isDefault) return;
  try {
    const products = await loadProducts(store);
    const withRoles = products.filter((p) => (p.roleIds ?? []).length);
    let rolesOk = true;
    if (withRoles.length) {
      const data = await api('/api/onboard', { step: 'roles', storeId: store.id }).catch(() => null);
      if (data) {
        const usable = new Set(data.roles.filter((r) => r.usable).map((r) => r.id));
        rolesOk = withRoles.every((p) => p.roleIds.every((rid) => usable.has(rid)));
      }
    }
    const checks = [
      { ok: true, label: 'Payment method connected — Stripe' },
      { ok: products.length > 0, label: 'First product created', href: `#/store/${slug}/products` },
      { ok: store.status === 'live' && withRoles.length > 0, label: 'Store published with a role to deliver', href: `#/store/${slug}/products` },
      { ok: rolesOk, label: 'Bot role sits above the roles it delivers', href: null, hint: 'Drag the Ripley role higher in Server Settings → Roles.' },
    ];
    if (checks.every((c) => c.ok)) return;
    slot.innerHTML = `<section class="panel checklist"><div class="card-head"><div><h3>Finish setting up</h3><p class="card-sub">A couple of steps left before everything runs on its own.</p></div></div>
      <ul class="check-list">${checks
        .map(
          (c) => `<li class="${c.ok ? 'ok' : ''}"><span class="check-dot">${c.ok ? I.check : ''}</span>
            <span>${esc(c.label)}${!c.ok && c.hint ? ` — <span class="dim">${esc(c.hint)}</span>` : ''}</span>
            ${!c.ok && c.href ? `<a class="btn-ghost" href="${c.href}">Fix ${I.arrow}</a>` : ''}</li>`,
        )
        .join('')}</ul></section>`;
  } catch { /* checklist is best-effort */ }
}

function billingLabel(p) {
  return p.lifetime ? 'One-time · lifetime' : `Monthly${p.durationDays && p.durationDays !== 31 ? ` · ${p.durationDays}d` : ''}`;
}

function sectionProductsDefault(data) {
  return `
    <h2 class="sec-title">Products</h2>
    <section class="panel table-panel">
      <div class="card-head"><div><h3>Products</h3><p class="card-sub">This store’s catalog is configured by the platform (plans.json + /diagnostics role mapping).</p></div></div>
    </section>`;
}

function productEditorFields(p = {}) {
  return `
    <div class="field-row">
      <label class="field"><span class="field-label">Name <span aria-hidden="true">*</span></span>
        <input class="pe-name" type="text" maxlength="80" value="${esc(p.name ?? '')}" placeholder="Premium" /></label>
      <label class="field"><span class="field-label">Price (USD) <span aria-hidden="true">*</span></span>
        <input class="pe-price" type="number" inputmode="decimal" min="1" max="10000" step="0.01" value="${p.priceUsd ?? ''}" placeholder="49.99" /></label>
    </div>
    <label class="field"><span class="field-label">Description</span>
      <input class="pe-desc" type="text" maxlength="300" value="${esc(p.description ?? '')}" placeholder="One line buyers see under the name." /></label>
    <div class="field-row">
      <label class="field"><span class="field-label">Billing</span>
        <select class="pe-billing">
          <option value="lifetime" ${p.lifetime !== false ? 'selected' : ''}>One-time · lifetime</option>
          <option value="month" ${p.lifetime === false ? 'selected' : ''}>Monthly subscription</option>
        </select></label>
      <label class="field"><span class="field-label">Purchase limit</span>
        <input class="pe-limit" type="number" min="1" step="1" value="${p.purchaseLimit ?? ''}" placeholder="No cap" />
        <span class="field-help">Optional cap on total buyers.</span></label>
    </div>
    <label class="field"><span class="field-label">Image URL</span>
      <input class="pe-img" type="url" value="${esc(p.imageUrl ?? '')}" placeholder="https://…  (optional)" spellcheck="false" /></label>
    <label class="field"><span class="field-label">Success URL</span>
      <input class="pe-success" type="url" value="${esc(p.successUrl ?? '')}" placeholder="https://…  (optional — where buyers land after paying)" spellcheck="false" /></label>`;
}

function sectionProducts(products, data, slug) {
  const revenueBy = new Map();
  const membersBy = new Map();
  for (const p of data.payments) {
    revenueBy.set(p.planId, (revenueBy.get(p.planId) ?? 0) + p.amountUsd);
    if (p.entitled) {
      if (!membersBy.has(p.planId)) membersBy.set(p.planId, new Set());
      membersBy.get(p.planId).add(p.discordId);
    }
  }
  const rows = products
    .map(
      (p) => `<tr data-plan="${esc(p.planKey)}">
        <td class="prod-cell">${p.imageUrl ? `<img class="prod-thumb" src="${esc(p.imageUrl)}" alt="" width="30" height="30" />` : '<span class="prod-thumb prod-thumb-empty"></span>'}
          <span><strong>${esc(p.name)}</strong><span class="dim prod-roles"> ${esc((p.roleNames ?? []).join(', '))}</span></span></td>
        <td class="num">${usd(p.priceUsd)}</td>
        <td class="dim">${billingLabel(p)}</td>
        <td class="num">${(membersBy.get(p.planKey) ?? new Set()).size}</td>
        <td class="num">${usd(revenueBy.get(p.planKey) ?? 0)}</td>
        <td><label class="switch"><input type="checkbox" class="prod-active" data-plan="${esc(p.planKey)}" ${p.active ? 'checked' : ''} /><span></span></label></td>
        <td class="row-actions">
          <button class="btn-ghost prod-copy" data-url="${esc(p.checkoutUrl)}">${I.copy} Link</button>
          <button class="btn-ghost prod-edit" data-plan="${esc(p.planKey)}">Edit</button>
          <button class="btn-ghost act-revoke prod-del" data-plan="${esc(p.planKey)}">Delete</button>
        </td>
      </tr>`,
    )
    .join('');
  return `
    <h2 class="sec-title">Products</h2>
    <section class="panel table-panel">
      <div class="card-head"><div><h3>Products</h3><p class="card-sub">Everything is created and edited here — you never need the Stripe dashboard.</p></div>
        <button class="btn-pill" id="prod-new">${I.plus} Add product</button></div>
      <form class="add-member" id="prod-form" hidden>
        <h3 id="pe-title">New product</h3>
        ${productEditorFields()}
        <div class="wiz-actions"><button class="btn-pill" type="submit" id="pe-save">Create product</button>
          <button class="btn-secondary" type="button" id="pe-cancel">Cancel</button></div>
        <p class="field-err" id="err-prod" role="alert"></p>
      </form>
      <div id="prod-roles-slot"></div>
      ${
        products.length
          ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Product</th><th class="num">Price</th><th>Billing</th><th class="num">Members</th><th class="num">Revenue</th><th>Active</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
          : '<div class="empty-chart">No products yet. <button class="btn-pill" id="prod-new-2">Add your first product</button></div>'
      }
      <p class="field-err" id="err-products" role="alert"></p>
    </section>`;
}

function sectionDiscounts(discounts, products, slug) {
  const rows = discounts
    .map(
      (d) => `<tr>
        <td><code>${esc(d.code)}</code></td>
        <td>${d.kind === 'percent' ? `${d.amount}% off` : `${usd(d.amount)} off`}</td>
        <td class="dim">${d.planKey ? esc(products.find((p) => p.planKey === d.planKey)?.name ?? d.planKey) : 'All products'}</td>
        <td class="num">${d.uses}${d.maxUses ? ` / ${d.maxUses}` : ''}</td>
        <td class="dim">${d.expiresAt ? fmtD(d.expiresAt) : 'Never'}</td>
        <td class="row-actions"><button class="btn-ghost act-revoke disc-del" data-code="${esc(d.code)}">Delete</button></td>
      </tr>`,
    )
    .join('');
  return `
    <h2 class="sec-title">Discounts</h2>
    <section class="panel table-panel">
      <div class="card-head"><div><h3>Discount codes</h3><p class="card-sub">Buyers enter these at checkout; the discount is applied on Stripe.</p></div>
        <button class="btn-pill" id="disc-new">${I.plus} New code</button></div>
      <form class="add-member" id="disc-form" hidden>
        <div class="field-row">
          <label class="field"><span class="field-label">Code <span aria-hidden="true">*</span></span>
            <input id="dc-code" type="text" maxlength="32" placeholder="LAUNCH20" style="text-transform:uppercase" spellcheck="false" /></label>
          <label class="field"><span class="field-label">Type</span>
            <select id="dc-kind"><option value="percent">Percent off</option><option value="fixed">Fixed USD off</option></select></label>
          <label class="field"><span class="field-label">Amount <span aria-hidden="true">*</span></span>
            <input id="dc-amount" type="number" min="1" step="0.01" placeholder="20" /></label>
        </div>
        <div class="field-row">
          <label class="field"><span class="field-label">Product</span>
            <select id="dc-plan"><option value="">All products</option>${products.map((p) => `<option value="${esc(p.planKey)}">${esc(p.name)}</option>`).join('')}</select></label>
          <label class="field"><span class="field-label">Usage limit</span>
            <input id="dc-max" type="number" min="1" step="1" placeholder="Unlimited" /></label>
          <label class="field"><span class="field-label">Expires</span>
            <input id="dc-exp" type="date" /></label>
        </div>
        <div class="wiz-actions"><button class="btn-pill" type="submit">Create code</button></div>
        <p class="field-err" id="err-disc" role="alert"></p>
      </form>
      ${
        discounts.length
          ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Code</th><th>Discount</th><th>Scope</th><th class="num">Uses</th><th>Expires</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
          : '<div class="empty-chart">No discount codes yet.</div>'
      }
      <p class="field-err" id="err-discounts" role="alert"></p>
    </section>`;
}

function sectionStore(store, link) {
  if (store.isDefault) {
    return `
      <h2 class="sec-title">Store</h2>
      <section class="panel wiz-panel">
        <h3>Store link</h3>
        <div class="share-row"><code class="share-link">${esc(link)}</code><button class="btn-secondary" id="copy-link">${I.copy} Copy</button></div>
        <p class="note-help">This is the platform’s built-in store — its identity comes from the deployment configuration.</p>
      </section>`;
  }
  return `
    <h2 class="sec-title">Store</h2>
    <div class="settings-grid">
    <section class="panel wiz-panel">
      <h3>Store page</h3>
      <label class="field"><span class="field-label">Store name</span>
        <input id="st-name" type="text" maxlength="60" value="${esc(store.name)}" /></label>
      <label class="field"><span class="field-label">Description</span>
        <input id="st-desc" type="text" maxlength="500" value="${esc(store.description ?? '')}" placeholder="One or two lines shown under your store name." /></label>
      <label class="field"><span class="field-label">Banner URL</span>
        <input id="st-banner" type="url" value="${esc(store.bannerUrl ?? '')}" placeholder="https://…  (1500×400 works best)" spellcheck="false" /></label>
      <div class="wiz-actions"><button class="btn-pill" id="st-save">Save changes</button></div>
      <p class="field-err" id="err-store" role="alert"></p>
    </section>
    <section class="panel wiz-panel">
      <h3>Store link</h3>
      <div class="share-row"><code class="share-link">${esc(link)}</code><button class="btn-secondary" id="copy-link">${I.copy} Copy</button></div>
      <label class="field"><span class="field-label">Custom link</span>
        <div class="slug-row"><span class="slug-prefix">${esc(location.origin)}/s/</span><input id="st-slug" type="text" maxlength="40" value="${esc(store.slug)}" spellcheck="false" /></div>
        <span class="field-help">Changing the link breaks the old one immediately.</span></label>
      <div class="wiz-actions"><button class="btn-secondary" id="st-slug-save">Update link</button></div>
      <p class="field-err" id="err-slug" role="alert"></p>
      <p class="note-help">Status: ${store.status === 'live' ? 'Live — taking payments.' : 'Draft — finish setup to go live.'}</p>
    </section>
    </div>`;
}

function sectionSettings(store, isPlatformOwner) {
  return `
    <h2 class="sec-title">Settings</h2>
    <div class="settings-grid">
    ${
      !store.isDefault
        ? `<section class="panel wiz-panel">
            <h3>Payment method</h3>
            <p class="note-help">Payments land in your own Stripe account. Paste a new secret key to rotate it — validated with Stripe before saving.</p>
            <label class="field"><span class="field-label">Stripe secret key</span>
              <input id="pm-key" type="password" placeholder="sk_live_…" autocomplete="off" spellcheck="false" /></label>
            <div class="wiz-actions"><button class="btn-secondary" id="pm-save">Update key</button></div>
            <p class="field-err" id="err-pm" role="alert"></p>
          </section>`
        : ''
    }
    <section class="panel wiz-panel" id="billing-panel">
      <h3>Ripley plan</h3>
      <div id="billing-body"><p class="note-help">Loading your plan…</p></div>
    </section>
    ${
      !isPlatformOwner
        ? `<section class="panel wiz-panel">
            <h3>Receipt emails</h3>
            <p class="note-help">Handled by Ripley automatically — every buyer gets an emailed receipt after checkout. Nothing to configure.</p>
          </section>`
        : `<section class="panel wiz-panel">
            <h3>Receipt emails <span class="chip chip-off">platform-wide</span></h3>
            <p class="note-help" id="settings-state">Checking…</p>
            <label class="field">
              <span class="field-label">Resend API key</span>
              <input id="f-resend" type="password" placeholder="re_…" autocomplete="off" spellcheck="false" />
              <span class="field-help">One key powers receipts for EVERY store on Ripley — tenants never configure anything. Stored encrypted.</span>
              <span class="field-err" id="err-resend" role="alert"></span>
            </label>
            <label class="field">
              <span class="field-label">From address</span>
              <input id="f-from" type="text" placeholder="Receipts <receipts@yourdomain.com>" />
              <span class="field-help">Must be a domain verified in your Resend account.</span>
            </label>
            <div class="wiz-actions"><button class="btn-pill" id="save-settings">Save</button></div>
          </section>`
    }
    </div>`;
}

// ── store dashboard: main view ───────────────────────────────────────────────

async function viewStore(slug) {
  $('#content').innerHTML = '<div class="skeleton-list" style="margin-top:18px" aria-hidden="true"><div class="panel sk-row"></div><div class="panel sk-row"></div></div>';
  const data = await loadPayments(slug);
  if (!data) {
    $('#content').innerHTML = `
      <div class="picker-wrap"><section class="picker-card panel">
        <p class="note-help" style="text-align:center">This store is not yours to see. Sign in with the owner account, or pick one of your servers.</p>
        <a class="btn-pill" style="align-self:center;text-decoration:none" href="#/">Your servers</a>
      </section></div>`;
    return;
  }
  const store = data.stores.find((s) => s.slug === slug) ?? data.stores[0];
  const link = store.isDefault ? `${location.origin}/store` : `${location.origin}/s/${store.slug}`;
  const section = location.hash.split('/')[3] ?? 'overview';
  const isPlatformOwner = Boolean(state.me?.isOwner);

  // Tenant-only management data, fetched only for the sections that need it.
  let products = null;
  let discounts = null;
  if (!store.isDefault && (section === 'products' || section === 'discounts')) {
    try {
      products = await loadProducts(store);
    } catch (err) {
      products = [];
      console.error(err);
    }
  }
  if (!store.isDefault && section === 'discounts') {
    if (state.discounts && state.discountsSlug === slug) discounts = state.discounts;
    else {
      discounts = (await api('/api/admin/discounts', { store: slug, action: 'list' }).catch(() => ({ discounts: [] }))).discounts;
      state.discounts = discounts;
      state.discountsSlug = slug;
    }
  }

  let body = '';
  if (section === 'overview') body = sectionOverview(data, store, slug);
  else if (section === 'products') body = store.isDefault ? sectionProductsDefault(data) : sectionProducts(products, data, slug);
  else if (section === 'discounts')
    body = store.isDefault
      ? '<h2 class="sec-title">Discounts</h2><section class="panel wiz-panel"><p class="note-help">Discount codes are available on stores created through onboarding.</p></section>'
      : sectionDiscounts(discounts, products, slug);
  else if (section === 'store') body = sectionStore(store, link);
  else if (section === 'settings') body = sectionSettings(store, isPlatformOwner);
  else if (section === 'payments') {
    body = `
      <h2 class="sec-title">Transactions</h2>
      <section class="panel table-panel">
        <div class="card-head"><div><h3>Transactions</h3><p class="card-sub">Every purchase in your store.</p></div>
          <button class="btn-secondary" id="tx-export">Export CSV</button></div>
        <div class="table-tools">
          <label class="search-box">${I.search}<input id="tx-search" type="search" placeholder="Search username, ID or product…" aria-label="Search transactions" /></label>
          <select id="tx-status" class="store-switch" aria-label="Filter by status">
            <option value="">Status: all</option><option value="lifetime">Lifetime</option><option value="active">Active</option><option value="ended">Ended</option>
          </select>
        </div>
        <div class="table-scroll"><table class="data-table"><thead><tr><th>Customer</th><th>Product</th><th class="num">Amount</th><th>Status</th><th>Date</th></tr></thead><tbody id="tx-body">${paymentsRows(data.payments)}</tbody></table></div>
        <p class="rows-note" id="tx-count">${data.payments.length} row(s)</p>
      </section>`;
  } else if (section === 'members') {
    const byMember = new Map();
    for (const p of data.payments) {
      const m = byMember.get(p.discordId) ?? {
        discordId: p.discordId, username: p.username, products: new Set(), spent: 0, entitled: false, lifetime: false, last: 0,
      };
      m.username = m.username ?? p.username;
      m.spent += p.amountUsd;
      if (p.entitled) { m.entitled = true; m.products.add(p.planName); }
      if (p.lifetime) m.lifetime = true;
      m.last = Math.max(m.last, p.createdAt);
      byMember.set(p.discordId, m);
    }
    const members = [...byMember.values()].sort((a, b) => b.last - a.last);
    const memberRows = members
      .map(
        (m) => `<tr data-member="${esc(m.discordId)}">
          <td>${m.username ? '@' + esc(m.username) : ''}<span class="dim"> ${esc(m.discordId)}</span></td>
          <td>${esc([...m.products].join(', ') || '—')}</td>
          <td class="num">${usd(m.spent)}</td>
          <td>${m.lifetime ? '<span class="chip chip-good">Lifetime</span>' : m.entitled ? '<span class="chip chip-good">Active</span>' : '<span class="chip chip-off">Ended</span>'}</td>
          <td class="row-actions">
            <button class="btn-ghost act-resync" data-id="${esc(m.discordId)}">Re-sync</button>
            ${m.entitled && !m.lifetime ? `<button class="btn-ghost act-extend" data-id="${esc(m.discordId)}">Extend</button>` : ''}
            ${m.entitled ? `<button class="btn-ghost act-revoke" data-id="${esc(m.discordId)}">Revoke</button>` : ''}
          </td>
        </tr>`,
      )
      .join('');
    body = `
      <h2 class="sec-title">Members</h2>
      <section class="panel table-panel">
        <div class="card-head"><div><h3>Members</h3><p class="card-sub">Manage who has access.</p></div>
        <button class="btn-pill" id="add-member-toggle">${I.plus} Add member</button></div>
        <form class="add-member" id="add-member" hidden>
          <label class="field"><span class="field-label">Discord user ID</span>
            <input id="am-id" type="text" inputmode="numeric" placeholder="123456789012345678" spellcheck="false" />
            <span class="field-help">Discord → Settings → Advanced → Developer Mode, then right-click the user → Copy User ID.</span>
          </label>
          <label class="field"><span class="field-label">Product</span><select id="am-plan"><option value="">Loading…</option></select></label>
          <div class="wiz-actions"><button class="btn-pill" type="submit">Grant access</button></div>
          <p class="field-err" id="err-am" role="alert"></p>
        </form>
        ${
          members.length
            ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Member</th><th>Products</th><th class="num">Total spent</th><th>Status</th><th></th></tr></thead><tbody>${memberRows}</tbody></table></div>
               <p class="rows-note">${members.length} member(s)</p>`
            : '<div class="empty-chart">No members yet.</div>'
        }
        <p class="field-err" id="err-member" role="alert"></p>
      </section>`;
  }

  const switcher =
    data.stores.length > 1
      ? `<select id="store-switch" class="store-switch side-switch" aria-label="Switch store">${data.stores
          .map((s) => `<option value="${esc(s.slug)}" ${s.slug === slug ? 'selected' : ''}>${esc(s.name)}</option>`)
          .join('')}</select>`
      : `<span class="side-store-name">${esc(store.name)}</span>`;

  const navItems = SECTIONS.map(
    ([k, lbl, ic]) =>
      `<a class="side-item${k === section ? ' active' : ''}" href="#/store/${esc(slug)}/${k}" ${k === section ? 'aria-current="page"' : ''}>${I[ic]}<span>${lbl}</span></a>`,
  ).join('');

  $('#content').innerHTML = `
    <div class="appshell">
      <aside class="sidebar">
        <div class="side-store"><a class="side-logo" href="#/" aria-label="All servers"><img src="/favicon.png" alt="" width="22" height="22" /></a>${switcher}</div>
        <nav class="side-nav" aria-label="Store sections">${navItems}</nav>
        <div class="side-foot">
          <a class="side-item" href="${esc(link)}" target="_blank" rel="noopener">${I.external}<span>View store</span></a>
          <a class="side-item" href="#/">${I.back}<span>All servers</span></a>
        </div>
      </aside>
      <div class="app-body">${body}</div>
    </div>`;

  const sw = $('#store-switch');
  if (sw)
    sw.onchange = () => {
      state.products = null;
      state.discounts = null;
      location.hash = `#/store/${sw.value}/${section}`;
    };

  const copy = $('#copy-link');
  if (copy) copy.onclick = copyBtn(copy, link);

  // ── section wiring ──────────────────────────────────────────────────────────

  if (section === 'overview') {
    $('#range-sel').onchange = () => {
      state.range = $('#range-sel').value;
      viewStore(slug);
    };
    renderChecklist(store, slug);
    loadBilling()
      .then((b) => {
        if (!b || b.exempt || b.usage.limit === null || b.usage.members < b.usage.limit) return;
        const el = document.createElement('div');
        el.className = 'limit-banner';
        el.innerHTML = `<strong>Member limit reached</strong> — ${b.usage.members} of ${b.usage.limit} on the ${esc(b.current.name)} plan. New checkouts are paused. <a href="#/store/${esc(slug)}/settings">Upgrade your plan</a>`;
        document.querySelector('.app-body')?.prepend(el);
      })
      .catch(() => {});
  }

  if (section === 'payments') {
    const filtered = () => {
      const q = ($('#tx-search').value ?? '').trim().toLowerCase();
      const st = $('#tx-status').value;
      return data.payments.filter((p) => {
        const hitQ = !q || (p.username ?? '').toLowerCase().includes(q) || p.discordId.includes(q) || p.planName.toLowerCase().includes(q);
        const hitS =
          !st ||
          (st === 'lifetime' && p.lifetime) ||
          (st === 'active' && p.entitled && !p.lifetime) ||
          (st === 'ended' && !p.entitled);
        return hitQ && hitS;
      });
    };
    const apply = () => {
      const list = filtered();
      $('#tx-body').innerHTML = paymentsRows(list);
      $('#tx-count').textContent = `${list.length} row(s)`;
    };
    $('#tx-search').oninput = apply;
    $('#tx-status').onchange = apply;
    $('#tx-export').onclick = () => {
      const rows = filtered();
      const head = 'date,username,discord_id,store,product,amount_usd,status,provider';
      const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [head, ...rows.map((p) =>
        [new Date(p.createdAt * 1000).toISOString(), p.username ?? '', p.discordId, p.storeSlug, p.planName, p.amountUsd.toFixed(2), p.status, p.provider].map(cell).join(','),
      )].join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `ripley-transactions-${slug}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
  }

  if (section === 'members') wireMembers(slug);
  if (section === 'products' && !store.isDefault) wireProducts(store, slug, products);
  if (section === 'discounts' && !store.isDefault) wireDiscounts(store, slug);
  if (section === 'store' && !store.isDefault) wireStoreSettings(store, slug);
  if (section === 'settings') {
    renderBillingPanel();
    const pmSave = $('#pm-save');
    if (pmSave)
      pmSave.onclick = async () => {
        const key = $('#pm-key').value.trim();
        fieldErr('pm', '');
        if (!key) return fieldErr('pm', 'Paste the new secret key first.');
        pmSave.disabled = true;
        pmSave.textContent = 'Validating…';
        try {
          await api('/api/admin/store', { store: slug, stripeKey: key });
          pmSave.textContent = 'Updated ✓';
          $('#pm-key').value = '';
          setTimeout(() => { pmSave.disabled = false; pmSave.textContent = 'Update key'; }, 1600);
        } catch (err) {
          pmSave.disabled = false;
          pmSave.textContent = 'Update key';
          fieldErr('pm', err.message);
        }
      };
    if (isPlatformOwner) wireReceiptSettings();
  }
}

function wireMembers(slug) {
  const memberCall = (payload) => api('/api/admin/member', { store: slug, ...payload });
  document.querySelectorAll('.act-revoke[data-id]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      if (!confirm(`Remove this membership?\n\nTheir role is taken away immediately. ${id}`)) return;
      btn.disabled = true;
      btn.textContent = 'Removing…';
      try {
        await memberCall({ action: 'revoke', discordId: id });
        state.data = null;
        route();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Revoke';
        fieldErr('member', err.message);
      }
    };
  });
  document.querySelectorAll('.act-extend').forEach((btn) => {
    btn.onclick = async () => {
      const days = Number(prompt('Extend this membership by how many days?', '30'));
      if (!Number.isFinite(days) || days < 1) return;
      btn.disabled = true;
      btn.textContent = 'Extending…';
      try {
        await memberCall({ action: 'extend', discordId: btn.dataset.id, days });
        state.data = null;
        route();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Extend';
        fieldErr('member', err.message);
      }
    };
  });
  document.querySelectorAll('.act-resync').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Syncing…';
      try {
        await memberCall({ action: 'resync', discordId: btn.dataset.id });
        btn.textContent = 'Synced ✓';
        setTimeout(() => { btn.disabled = false; btn.textContent = 'Re-sync'; }, 1800);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Re-sync';
        fieldErr('member', err.message);
      }
    };
  });
  const toggle = $('#add-member-toggle');
  const form = $('#add-member');
  if (!toggle || !form) return;
  toggle.onclick = () => {
    form.hidden = !form.hidden;
    if (!form.hidden && $('#am-plan').options.length <= 1) {
      fetch(`/api/plans?store=${encodeURIComponent(slug)}`)
        .then((r) => r.json())
        .then((d) => {
          $('#am-plan').innerHTML = (d.plans ?? [])
            .map((p) => `<option value="${esc(p.id)}">${esc(p.name)} — $${p.priceUsd}</option>`)
            .join('');
        })
        .catch(() => {});
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const id = $('#am-id').value.trim();
    fieldErr('am', '');
    if (!/^\d{17,20}$/.test(id)) return fieldErr('am', 'That is not a Discord user ID (17–20 digits).');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Granting…';
    try {
      await memberCall({ action: 'grant', discordId: id, planId: $('#am-plan').value });
      state.data = null;
      route();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Grant access';
      fieldErr('am', err.message);
    }
  };
}

// Products section wiring: create (then role pick), edit, toggle, copy, delete.
function wireProducts(store, slug, products) {
  const form = $('#prod-form');
  let editing = null; // planKey when editing

  const openForm = (p = null) => {
    editing = p?.planKey ?? null;
    form.hidden = false;
    $('#pe-title').textContent = p ? `Edit — ${p.name}` : 'New product';
    $('#pe-save').textContent = p ? 'Save changes' : 'Create product';
    form.querySelector('.pe-name').value = p?.name ?? '';
    form.querySelector('.pe-price').value = p?.priceUsd ?? '';
    form.querySelector('.pe-desc').value = p?.description ?? '';
    form.querySelector('.pe-billing').value = p && !p.lifetime ? 'month' : 'lifetime';
    form.querySelector('.pe-limit').value = p?.purchaseLimit ?? '';
    form.querySelector('.pe-img').value = p?.imageUrl ?? '';
    form.querySelector('.pe-success').value = p?.successUrl ?? '';
    form.scrollIntoView({ block: 'nearest' });
  };
  for (const id of ['prod-new', 'prod-new-2']) {
    const b = document.getElementById(id);
    if (b) b.onclick = () => openForm();
  }
  $('#pe-cancel').onclick = () => (form.hidden = true);

  form.onsubmit = async (e) => {
    e.preventDefault();
    fieldErr('prod', '');
    const fields = {
      name: form.querySelector('.pe-name').value.trim(),
      description: form.querySelector('.pe-desc').value.trim(),
      imageUrl: form.querySelector('.pe-img').value.trim(),
      successUrl: form.querySelector('.pe-success').value.trim(),
      priceUsd: Number(form.querySelector('.pe-price').value),
      lifetime: form.querySelector('.pe-billing').value === 'lifetime',
      purchaseLimit: form.querySelector('.pe-limit').value.trim() || null,
    };
    if (!fields.name) return fieldErr('prod', 'Name your product.');
    if (!Number.isFinite(fields.priceUsd) || fields.priceUsd < 1) return fieldErr('prod', 'Set a price of at least $1.');
    const btn = $('#pe-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      if (editing) {
        await api('/api/onboard', { step: 'product-update', storeId: store.id, planKey: editing, ...fields });
        state.products = null;
        viewStore(slug);
      } else {
        const out = await api('/api/onboard', { step: 'product', storeId: store.id, ...fields });
        // apply the optional extras the create step doesn't take
        await api('/api/onboard', {
          step: 'product-update', storeId: store.id, planKey: out.plan.planKey,
          purchaseLimit: fields.purchaseLimit, successUrl: fields.successUrl,
        }).catch(() => {});
        form.hidden = true;
        await pickRoleFor(store, slug, out.plan.planKey, fields.name);
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = editing ? 'Save changes' : 'Create product';
      fieldErr('prod', err.message);
    }
  };

  document.querySelectorAll('.prod-edit').forEach((b) => {
    b.onclick = () => openForm(products.find((p) => p.planKey === b.dataset.plan));
  });
  document.querySelectorAll('.prod-copy').forEach((b) => {
    b.onclick = copyBtn(b, b.dataset.url);
  });
  document.querySelectorAll('.prod-active').forEach((cb) => {
    cb.onchange = async () => {
      try {
        await api('/api/onboard', { step: 'product-update', storeId: store.id, planKey: cb.dataset.plan, active: cb.checked });
        state.products = null;
      } catch (err) {
        cb.checked = !cb.checked;
        fieldErr('products', err.message);
      }
    };
  });
  document.querySelectorAll('.prod-del').forEach((b) => {
    b.onclick = async () => {
      const p = products.find((x) => x.planKey === b.dataset.plan);
      if (!confirm(`Delete "${p?.name ?? b.dataset.plan}"?\n\nBuyers keep what they already bought; the product just stops being sold.`)) return;
      b.disabled = true;
      try {
        await api('/api/onboard', { step: 'product-delete', storeId: store.id, planKey: b.dataset.plan });
        state.products = null;
        viewStore(slug);
      } catch (err) {
        b.disabled = false;
        fieldErr('products', err.message);
      }
    };
  });
}

// Inline role picker for a just-created product.
async function pickRoleFor(store, slug, planKey, productName) {
  const slot = $('#prod-roles-slot');
  slot.innerHTML = `<section class="panel wiz-panel"><h3>Which role does “${esc(productName)}” grant?</h3>
    <p class="note-help" id="pr-hint">Loading roles…</p><div class="role-list" id="pr-list"></div>
    <p class="field-err" id="err-pr" role="alert"></p></section>`;
  slot.scrollIntoView({ block: 'nearest' });
  let data;
  try {
    data = await api('/api/onboard', { step: 'roles', storeId: store.id });
  } catch (err) {
    $('#pr-hint').textContent = err.message;
    return;
  }
  $('#pr-hint').innerHTML = `Greyed roles sit at or above the bot’s top role <strong>${esc(data.botTop.name)}</strong>.`;
  const list = $('#pr-list');
  for (const role of data.roles) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'role-row';
    row.disabled = !role.usable;
    row.innerHTML = `<span class="role-dot" style="background:${role.color ?? 'var(--dim)'}"></span>
      <span class="role-name">${esc(role.name)}</span>
      <span class="role-pos">${role.usable ? `#${role.position}` : esc(role.reason ?? '')}</span>`;
    if (role.usable)
      row.onclick = async () => {
        row.disabled = true;
        try {
          await api('/api/onboard', { step: 'role', storeId: store.id, planKey, roleId: role.id });
          state.products = null;
          state.data = null;
          viewStore(slug);
        } catch (err) {
          row.disabled = false;
          fieldErr('pr', err.message);
        }
      };
    list.append(row);
  }
}

function wireDiscounts(store, slug) {
  const form = $('#disc-form');
  $('#disc-new').onclick = () => (form.hidden = !form.hidden);
  form.onsubmit = async (e) => {
    e.preventDefault();
    fieldErr('disc', '');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      await api('/api/admin/discounts', {
        store: slug,
        action: 'create',
        code: $('#dc-code').value,
        kind: $('#dc-kind').value,
        amount: Number($('#dc-amount').value),
        planKey: $('#dc-plan').value || null,
        maxUses: $('#dc-max').value || null,
        expiresAt: $('#dc-exp').value || null,
      });
      state.discounts = null;
      viewStore(slug);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Create code';
      fieldErr('disc', err.message);
    }
  };
  document.querySelectorAll('.disc-del').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Delete code ${b.dataset.code}?`)) return;
      b.disabled = true;
      try {
        await api('/api/admin/discounts', { store: slug, action: 'delete', code: b.dataset.code });
        state.discounts = null;
        viewStore(slug);
      } catch (err) {
        b.disabled = false;
        fieldErr('discounts', err.message);
      }
    };
  });
}

function wireStoreSettings(store, slug) {
  $('#st-save').onclick = async () => {
    const btn = $('#st-save');
    fieldErr('store', '');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await api('/api/admin/store', {
        store: slug,
        name: $('#st-name').value,
        description: $('#st-desc').value,
        bannerUrl: $('#st-banner').value,
      });
      state.data = null;
      viewStore(slug);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Save changes';
      fieldErr('store', err.message);
    }
  };
  $('#st-slug-save').onclick = async () => {
    const btn = $('#st-slug-save');
    const slugNew = $('#st-slug').value.trim().toLowerCase();
    fieldErr('slug', '');
    if (slugNew === store.slug) return;
    if (!confirm(`Change your store link to ${location.origin}/s/${slugNew}?\n\nThe old link stops working immediately.`)) return;
    btn.disabled = true;
    btn.textContent = 'Updating…';
    try {
      const out = await api('/api/admin/store', { store: slug, slug: slugNew });
      state.data = null;
      state.products = null;
      state.discounts = null;
      location.hash = `#/store/${out.store.slug}/store`;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Update link';
      fieldErr('slug', err.message);
    }
  };
}

function wireReceiptSettings() {
  (async () => {
    const res = await fetch('/api/admin/settings');
    if (!res.ok) return;
    const s = await res.json();
    const el = $('#settings-state');
    if (!el) return;
    el.textContent = s.receiptEmails
      ? `Receipt emails are ON — sending from ${s.receiptFrom}`
      : 'Receipt emails are OFF — add a Resend API key to turn them on.';
    $('#f-from').value = s.receiptFrom ?? '';
  })();
  const save = $('#save-settings');
  if (!save) return;
  save.onclick = async () => {
    save.disabled = true;
    save.textContent = 'Saving…';
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resendApiKey: $('#f-resend').value.trim(), receiptFrom: $('#f-from').value.trim() }),
    });
    const out = await res.json().catch(() => ({}));
    save.disabled = false;
    save.textContent = 'Save';
    if (!res.ok) return fieldErr('resend', out.error ?? 'Could not save.');
    fieldErr('resend', '');
    $('#settings-state').textContent = out.receiptEmails
      ? `Receipt emails are ON — sending from ${out.receiptFrom}`
      : 'Receipt emails are OFF — add a Resend API key to turn them on.';
    $('#f-resend').value = '';
  };
}

// The Ripley-plan card on Settings: usage meter + tier grid, wired to
// /api/billing (upgrade → Stripe Checkout, cancel → back to Free).
async function renderBillingPanel() {
  const el = $('#billing-body');
  if (!el) return;
  const b = await loadBilling().catch(() => null);
  if (!b) {
    el.innerHTML = '<p class="note-help">Could not load your plan — refresh to try again.</p>';
    return;
  }
  if (b.exempt) {
    el.innerHTML = '<p class="note-help">Platform owner — unlimited members, nothing to pay.</p>';
    return;
  }
  const pct = b.usage.limit ? Math.min(100, Math.round((b.usage.members / b.usage.limit) * 100)) : 0;
  const over = b.usage.limit !== null && b.usage.members >= b.usage.limit;
  el.innerHTML = `
    <p class="note-help">Free covers your first 10 paying members. One plan covers every store on your account.${
      over ? ' <strong>You are at your limit — new checkouts are paused until you upgrade.</strong>' : ''
    }</p>
    <div class="usage-row"><span class="usage-nums">${b.usage.members} of ${b.usage.limit ?? 'unlimited'} members</span>
      ${b.usage.limit ? `<div class="usage-bar${over ? ' over' : ''}" role="img" aria-label="${pct}% of member limit used"><span style="width:${pct}%"></span></div>` : ''}
    </div>
    <div class="tier-grid">
      ${b.tiers
        .map((t) => {
          const current = t.id === b.current.tier;
          const btn = current
            ? '<button class="btn-secondary" disabled>Current plan</button>'
            : t.priceUsd > 0
              ? `<button class="btn-pill tier-buy" data-tier="${esc(t.id)}">Upgrade</button>`
              : '<span class="tier-cap dim">Default</span>';
          return `<div class="tier-card${current ? ' current' : ''}">
            <span class="tier-name">${esc(t.name)}</span>
            <span class="tier-price">$${t.priceUsd}<span class="tier-per">/mo</span></span>
            <span class="tier-cap">${t.maxMembers === null ? 'Unlimited members' : `Up to ${t.maxMembers} members`}</span>
            ${btn}
          </div>`;
        })
        .join('')}
    </div>
    ${b.current.tier !== 'free' ? '<button class="btn-ghost" id="cancel-plan">Cancel plan — back to Free</button>' : ''}
    <p class="field-err" id="err-billing" role="alert"></p>`;
  document.querySelectorAll('.tier-buy').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Opening Stripe…';
      try {
        const out = await api('/api/billing', { action: 'checkout', tier: btn.dataset.tier });
        window.location.href = out.url;
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Upgrade';
        fieldErr('billing', err.message);
      }
    };
  });
  const cancelBtn = $('#cancel-plan');
  if (cancelBtn)
    cancelBtn.onclick = async () => {
      if (!confirm('Cancel your Ripley plan?\n\nYour stores drop back to the Free limit (10 members). Existing members keep their roles.')) return;
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Canceling…';
      await api('/api/billing', { action: 'cancel' }).catch(() => {});
      renderBillingPanel();
    };
}

// ── router ────────────────────────────────────────────────────────────────────

async function route() {
  clearInterval(wiz.poll);
  const hash = location.hash || '#/';
  const parts = hash.slice(2).split('/');
  if (parts[0] === 'setup' && parts[1]) return viewSetup(parts[1]);
  if (parts[0] === 'store' && parts[1]) return viewStore(parts[1]);
  return viewPicker();
}

window.addEventListener('hashchange', () => route().catch(() => {}));

(async () => {
  // Back from a plan upgrade on Stripe: acknowledge, then let the webhook land.
  const upgraded = new URLSearchParams(location.search).get('upgraded');
  if (upgraded) {
    history.replaceState(null, '', location.pathname + location.hash);
    const t = document.createElement('div');
    t.className = 'toast-ok';
    t.setAttribute('role', 'status');
    t.textContent = 'Payment received — your Ripley plan is being activated.';
    document.body.append(t);
    setTimeout(() => t.remove(), 6000);
  }
  await loadMe().catch(() => (state.me = { loggedIn: false }));
  renderNav();
  await route();
})().catch(() => {
  $('#content').innerHTML = '<section class="panel sub-card"><p class="note-help">Could not load the dashboard — refresh to try again.</p></section>';
});
