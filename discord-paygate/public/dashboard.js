// Ripley owner dashboard — Subscord-style app shell: full-width top tab bar
// (Overview / Payments / Settings) with a store switcher, stat-card row,
// chart cards, and a searchable transactions table. Views are hash-routed
// (#/ picker, #/setup/<guildId> wizard, #/store/<slug>/<tab>).
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDT = (unix) =>
  new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
  ', ' + new Date(unix * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const I = {
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  arrow: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>',
  check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  external: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>',
  bot: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M8 4h8"/><path d="M9 14h.01M15 14h.01"/></svg>',
  search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  dollar: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  users: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  zap: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L3 14h7l-1 8 12-13h-8l0-7z"/></svg>',
  infinity: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 12c-2-2.7-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.3 6-4zm0 0c2 2.7 4 4 6 4a4 4 0 1 0 0-8c-2 0-4 1.3-6 4z"/></svg>',
  cart: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="21" r="1.5"/><circle cx="19" cy="21" r="1.5"/><path d="M2 3h3l2.6 12.5a2 2 0 0 0 2 1.5h8.7a2 2 0 0 0 2-1.6L22 8H6"/></svg>',
};

const state = { me: null, guilds: null, botInvite: '', data: null, dataSlug: undefined };

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

async function loadPayments(slug) {
  if (state.data && state.dataSlug === slug) return state.data;
  const res = await fetch(`/api/admin/payments${slug ? `?store=${encodeURIComponent(slug)}` : ''}`);
  if (!res.ok) return null;
  state.data = await res.json();
  state.dataSlug = slug;
  return state.data;
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

// ── view: server picker (Subscord-style centred panel) ───────────────────────

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
  list.innerHTML =
    state.guilds.map(guildRow).join('') ||
    '<p class="note-help">No servers where you hold <strong>Manage Server</strong> or <strong>Administrator</strong>.</p>';
}

// ── view: onboarding wizard ───────────────────────────────────────────────────

const wiz = { guildId: null, storeId: null, storeSlug: null, planKey: null };

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
  $('#content').innerHTML = `
    <div class="wiz-wrap"><section class="panel wiz-card">
      <div class="wiz-head">
        <div><h1>Set up ${esc(g.name)}</h1><p class="note-help">Let's get your Discord server monetized in a few steps.</p></div>
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
      <p class="note-help">The bot delivers roles to buyers. Invite it to <strong>${esc(g.name)}</strong> with the Manage Roles permission, then come back here.</p>
      <div class="wiz-actions">
        <a class="btn-pill" href="${esc(state.botInvite)}&guild_id=${esc(g.id)}" target="_blank" rel="noopener">Invite the bot ${I.external}</a>
        <button class="btn-secondary" id="recheck">I added it — check again</button>
      </div>
      <p class="field-err" id="err-bot" role="alert"></p>`);
    $('#recheck').onclick = async () => {
      const btn = $('#recheck');
      btn.disabled = true;
      btn.textContent = 'Checking…';
      await loadGuilds();
      const fresh = state.guilds.find((x) => x.id === g.id);
      if (fresh?.botIn) renderSetupStep(fresh, 2);
      else {
        btn.disabled = false;
        btn.textContent = 'I added it — check again';
        fieldErr('bot', 'Not seeing the bot in that server yet — finish the invite and try again.');
      }
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
      <div class="wiz-actions"><button class="btn-pill" id="next2">Next step ${I.arrow}</button></div>`);
    $('#next2').onclick = async () => {
      const name = $('#f-name').value.trim();
      const key = $('#f-key').value.trim();
      fieldErr('name', ''); fieldErr('key', '');
      if (!name) return fieldErr('name', 'Give your store a name.');
      if (!/^(sk|rk)_(live|test)_/.test(key)) return fieldErr('key', 'That does not look like a Stripe secret key (sk_live_… or sk_test_…).');
      const btn = $('#next2');
      btn.disabled = true;
      btn.textContent = 'Validating with Stripe…';
      const res = await fetch('/api/onboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ step: 'store', guildId: g.id, name, stripeKey: key }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        btn.disabled = false;
        btn.textContent = 'Next step';
        fieldErr('key', data.detail ?? data.error ?? 'Something went wrong — try again.');
        return;
      }
      wiz.storeId = data.store.id;
      wiz.storeSlug = data.store.slug;
      renderSetupStep(g, 3);
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
      <div class="wiz-actions"><button class="btn-pill" id="next3">Next step ${I.arrow}</button></div>
      <p class="field-err" id="err-prod" role="alert"></p>`);
    $('#next3').onclick = async () => {
      const name = $('#f-pname').value.trim();
      const priceUsd = Number($('#f-price').value);
      fieldErr('pname', ''); fieldErr('price', ''); fieldErr('prod', '');
      if (!name) return fieldErr('pname', 'Name your product.');
      if (!Number.isFinite(priceUsd) || priceUsd < 1) return fieldErr('price', 'Set a price of at least $1.');
      const btn = $('#next3');
      btn.disabled = true;
      btn.textContent = 'Creating on your Stripe…';
      const res = await fetch('/api/onboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          step: 'product',
          storeId: wiz.storeId,
          name,
          description: $('#f-pdesc').value.trim(),
          imageUrl: $('#f-img').value.trim(),
          priceUsd,
          lifetime: $('#f-billing').value === 'lifetime',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        btn.disabled = false;
        btn.textContent = 'Next step';
        fieldErr('prod', data.error ?? 'Something went wrong — try again.');
        return;
      }
      wiz.planKey = data.plan.planKey;
      renderSetupStep(g, 4);
    };
    return;
  }

  wizShell(g, 4, `
    <h2>Pick the role buyers receive</h2>
    <p class="note-help" id="role-hint">Loading roles…</p>
    <div class="role-list" id="role-list"></div>
    <p class="field-err" id="err-role" role="alert"></p>`);
  (async () => {
    const res = await fetch('/api/onboard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'roles', storeId: wiz.storeId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('#role-hint').textContent = data.error ?? 'Could not load roles — refresh to retry.';
      return;
    }
    $('#role-hint').innerHTML = `Greyed roles sit at or above the bot's top role <strong>${esc(data.botTop.name)}</strong> — drag Ripley's role higher in Server Settings → Roles to unlock them.`;
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
          const done = await fetch('/api/onboard', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ step: 'role', storeId: wiz.storeId, planKey: wiz.planKey, roleId: role.id }),
          });
          const out = await done.json().catch(() => ({}));
          if (!done.ok) {
            row.disabled = false;
            fieldErr('role', out.error ?? 'Could not save the role — try again.');
            return;
          }
          state.guilds = null;
          state.data = null;
          renderLive(g, out.store.slug);
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
        <a class="btn-pill" href="${esc(link)}" target="_blank" rel="noopener">View your store ${I.external}</a>
        <a class="btn-secondary" href="#/store/${esc(slug)}">Go to dashboard</a>
      </div>
    </div>`);
  $('#copy-link').onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      $('#copy-link').textContent = 'Copied!';
      setTimeout(() => ($('#copy-link').innerHTML = `${I.copy} Copy`), 1600);
    } catch { /* noop */ }
  };
}

// ── view: store dashboard (Subscord app shell) ───────────────────────────────

function statCard(label, value, icon) {
  return `<div class="panel stat"><div class="stat-top"><span class="stat-label">${label}</span><span class="stat-ic">${icon}</span></div><span class="stat-value">${value}</span></div>`;
}

function revenueChart(payments) {
  const days = 30;
  const dayMs = 86400000;
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const buckets = Array.from({ length: days }, () => 0);
  for (const p of payments) {
    const idx = days - 1 - Math.floor((end.getTime() - p.createdAt * 1000) / dayMs);
    if (idx >= 0 && idx < days) buckets[idx] += p.amountUsd;
  }
  const max = Math.max(...buckets, 1);
  const total = buckets.reduce((a, b) => a + b, 0);
  const W = 920, H = 160, bw = W / days;
  const bars = buckets
    .map((v, i) => {
      const h = Math.max(v > 0 ? 5 : 2, (v / max) * (H - 12));
      const d = new Date(end.getTime() - (days - 1 - i) * dayMs);
      const lbl = `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${usd(v)}`;
      return `<rect x="${(i * bw + 3).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw - 6).toFixed(1)}" height="${h.toFixed(1)}" rx="2.5"
        fill="${v > 0 ? 'var(--accent)' : 'var(--edge)'}" opacity="${v > 0 ? 0.92 : 0.55}"><title>${esc(lbl)}</title></rect>`;
    })
    .join('');
  return `<svg class="rev-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue per day over the last 30 days, totaling ${usd(total)}">${bars}</svg>`;
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
  const t = data.totals;
  const link = store.isDefault ? `${location.origin}/store` : `${location.origin}/s/${store.slug}`;
  const tab = location.hash.split('/')[3] ?? 'overview';
  const now = Date.now() / 1000;
  const rev30 = data.payments.filter((p) => now - p.createdAt < 30 * 86400).reduce((s, p) => s + p.amountUsd, 0);

  const tabs = [
    ['overview', 'Overview'],
    ['payments', 'Transactions'],
    ['settings', 'Settings'],
  ]
    .map(([k, lbl]) => `<a class="apptab${k === tab ? ' active' : ''}" href="#/store/${esc(slug)}/${k}" ${k === tab ? 'aria-current="page"' : ''}>${lbl}</a>`)
    .join('');

  const switcher =
    data.stores.length > 1
      ? `<select id="store-switch" class="store-switch" aria-label="Switch store">${data.stores
          .map((s) => `<option value="${esc(s.slug)}" ${s.slug === slug ? 'selected' : ''}>${esc(s.name)}</option>`)
          .join('')}</select>`
      : `<span class="store-switch-label">${esc(store.name)}</span>`;

  let body = '';
  if (tab === 'overview') {
    const recent = data.payments.slice(0, 5);
    body = `
      <div class="stat-grid five">
        ${statCard('30-Day Revenue', usd(rev30), I.dollar)}
        ${statCard('All-Time Revenue', usd(t.allTimeUsd), I.dollar)}
        ${statCard('Sales', t.payments, I.cart)}
        ${statCard('Active Members', t.activeMembers, I.users)}
        ${statCard('Lifetime Members', t.lifetimeMembers, I.infinity)}
      </div>
      <div class="chart-grid">
        <section class="panel chart-card">
          <div class="card-head"><div><h3>Revenue Over Time</h3><p class="card-sub">Daily revenue, last 30 days</p></div><span class="chart-total">${usd(rev30)}</span></div>
          ${data.payments.length ? revenueChart(data.payments) : '<div class="empty-chart">No data available</div>'}
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
      </div>
      <section class="panel table-panel">
        <div class="card-head"><div><h3>Transactions</h3><p class="card-sub">Recent transactions from your store</p></div>
        <a class="btn-secondary" href="#/store/${esc(slug)}/payments">View all ${I.arrow}</a></div>
        ${
          data.payments.length
            ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Customer</th><th>Product</th><th class="num">Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>${paymentsRows(data.payments.slice(0, 8))}</tbody></table></div>`
            : `<div class="empty-chart">No transactions yet — share your store link:<br /><code class="share-link" style="margin-top:10px;display:inline-block">${esc(link)}</code></div>`
        }
      </section>`;
  } else if (tab === 'payments') {
    body = `
      <section class="panel table-panel">
        <div class="card-head"><div><h3>Transactions</h3><p class="card-sub">View your transactions.</p></div></div>
        <div class="table-tools">
          <label class="search-box">${I.search}<input id="tx-search" type="search" placeholder="Search username or Discord ID…" aria-label="Search transactions" /></label>
          <select id="tx-status" class="store-switch" aria-label="Filter by status">
            <option value="">Status: all</option><option value="lifetime">Lifetime</option><option value="active">Active</option><option value="ended">Ended</option>
          </select>
        </div>
        <div class="table-scroll"><table class="data-table"><thead><tr><th>Customer</th><th>Product</th><th class="num">Amount</th><th>Status</th><th>Date</th></tr></thead><tbody id="tx-body">${paymentsRows(data.payments)}</tbody></table></div>
        <p class="rows-note" id="tx-count">${data.payments.length} row(s)</p>
      </section>`;
  } else {
    const isPlatformOwner = Boolean(state.me?.isOwner);
    body = `
      <div class="settings-grid">
      <section class="panel wiz-panel">
        <h2>Store link</h2>
        <div class="share-row"><code class="share-link" id="share-link">${esc(link)}</code>
        <button class="btn-secondary" id="copy-link">${I.copy} Copy</button></div>
        <p class="note-help">Status: ${store.status === 'live' ? 'Live — taking payments.' : 'Draft — finish setup to go live.'}</p>
      </section>
      ${
        isPlatformOwner
          ? `<section class="panel wiz-panel">
              <h2>Receipt emails</h2>
              <p class="note-help" id="settings-state">Checking…</p>
              <label class="field">
                <span class="field-label">Resend API key</span>
                <input id="f-resend" type="password" placeholder="re_…" autocomplete="off" spellcheck="false" />
                <span class="field-help">Buyers get an emailed receipt after checkout. Get a key at resend.com — stored encrypted.</span>
                <span class="field-err" id="err-resend" role="alert"></span>
              </label>
              <label class="field">
                <span class="field-label">From address</span>
                <input id="f-from" type="text" placeholder="Receipts <receipts@yourdomain.com>" />
                <span class="field-help">Must be a domain verified in your Resend account.</span>
              </label>
              <div class="wiz-actions"><button class="btn-pill" id="save-settings">Save</button></div>
            </section>`
          : ''
      }
      </div>`;
  }

  $('#content').innerHTML = `
    <div class="appbar">
      <div class="appbar-left">
        <a class="appbar-logo" href="#/" aria-label="All servers"><img src="/favicon.png" alt="" width="26" height="26" /></a>
        <nav class="appbar-tabs" aria-label="Store sections">${tabs}</nav>
      </div>
      <div class="appbar-right">
        ${switcher}
        <a class="btn-ghost appbar-view" href="${esc(link)}" target="_blank" rel="noopener" aria-label="Open store page">${I.external}</a>
      </div>
    </div>
    <div class="app-body">${body}</div>`;

  const sw = $('#store-switch');
  if (sw) sw.onchange = () => (location.hash = `#/store/${sw.value}/${tab}`);

  const copy = $('#copy-link');
  if (copy)
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(link);
        copy.textContent = 'Copied!';
        setTimeout(() => (copy.innerHTML = `${I.copy} Copy`), 1600);
      } catch { /* noop */ }
    };

  if (tab === 'payments') {
    const apply = () => {
      const q = ($('#tx-search').value ?? '').trim().toLowerCase();
      const st = $('#tx-status').value;
      const filtered = data.payments.filter((p) => {
        const hitQ = !q || (p.username ?? '').toLowerCase().includes(q) || p.discordId.includes(q) || p.planName.toLowerCase().includes(q);
        const hitS =
          !st ||
          (st === 'lifetime' && p.lifetime) ||
          (st === 'active' && p.entitled && !p.lifetime) ||
          (st === 'ended' && !p.entitled);
        return hitQ && hitS;
      });
      $('#tx-body').innerHTML = paymentsRows(filtered);
      $('#tx-count').textContent = `${filtered.length} row(s)`;
    };
    $('#tx-search').oninput = apply;
    $('#tx-status').onchange = apply;
  }

  if (tab === 'settings' && state.me?.isOwner) {
    (async () => {
      const res = await fetch('/api/admin/settings');
      if (!res.ok) return;
      const s = await res.json();
      $('#settings-state').textContent = s.receiptEmails
        ? `Receipt emails are ON — sending from ${s.receiptFrom}`
        : 'Receipt emails are OFF — add a Resend API key to turn them on.';
      $('#f-from').value = s.receiptFrom ?? '';
    })();
    $('#save-settings').onclick = async () => {
      const btn = $('#save-settings');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resendApiKey: $('#f-resend').value.trim(), receiptFrom: $('#f-from').value.trim() }),
      });
      const out = await res.json().catch(() => ({}));
      btn.disabled = false;
      btn.textContent = 'Save';
      if (!res.ok) return fieldErr('resend', out.error ?? 'Could not save.');
      fieldErr('resend', '');
      $('#settings-state').textContent = out.receiptEmails
        ? `Receipt emails are ON — sending from ${out.receiptFrom}`
        : 'Receipt emails are OFF — add a Resend API key to turn them on.';
      $('#f-resend').value = '';
    };
  }
}

// ── router ────────────────────────────────────────────────────────────────────

async function route() {
  const hash = location.hash || '#/';
  const parts = hash.slice(2).split('/');
  if (parts[0] === 'setup' && parts[1]) return viewSetup(parts[1]);
  if (parts[0] === 'store' && parts[1]) return viewStore(parts[1]);
  return viewPicker();
}

window.addEventListener('hashchange', () => route().catch(() => {}));

(async () => {
  await loadMe().catch(() => (state.me = { loggedIn: false }));
  renderNav();
  await route();
})().catch(() => {
  $('#content').innerHTML = '<section class="panel sub-card"><p class="note-help">Could not load the dashboard — refresh to try again.</p></section>';
});
