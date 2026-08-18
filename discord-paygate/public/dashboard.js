// Ripley owner dashboard: server picker → onboarding wizard → per-store
// dashboard (Overview / Payments / Settings). Views are hash-routed so
// back/refresh/deep-links behave (#/ , #/setup/<guildId> , #/store/<slug>).
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDT = (unix) =>
  new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
  ', ' + new Date(unix * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const I = {
  server: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  arrow: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>',
  check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  external: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>',
  bot: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M8 4h8"/><path d="M9 14h.01M15 14h.01"/></svg>',
};

const state = { me: null, guilds: null, botInvite: '', payments: null, settings: null };

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
  const res = await fetch(`/api/admin/payments${slug ? `?store=${encodeURIComponent(slug)}` : ''}`);
  if (!res.ok) return null;
  return res.json();
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

function shell(title, subtitle, body) {
  $('#content').innerHTML = `
    <div class="dash-head">
      <div><h1>${esc(title)}</h1><p class="tagline">${subtitle}</p></div>
    </div>
    ${body}`;
}

// ── view: server picker ───────────────────────────────────────────────────────

function guildRow(g) {
  const icon = g.iconUrl
    ? `<img class="g-icon" src="${esc(g.iconUrl)}" alt="" width="40" height="40" />`
    : `<span class="g-icon g-icon-fallback" aria-hidden="true">${esc((g.name || '?').slice(0, 1).toUpperCase())}</span>`;
  const chips = `${g.owner ? '<span class="chip chip-good">Owner</span>' : '<span class="chip chip-off">Admin</span>'}${
    g.store ? (g.store.status === 'live' ? '<span class="chip chip-good">Live</span>' : '<span class="chip chip-warn">Draft</span>') : ''
  }`;
  const action = g.store
    ? `<a class="btn-ghost row-action" href="#/store/${esc(g.store.slug)}" aria-label="Open ${esc(g.name)}">${I.arrow}</a>`
    : `<a class="btn-ghost row-action" href="#/setup/${esc(g.id)}" aria-label="Set up ${esc(g.name)}">${I.plus}</a>`;
  return `
    <a class="g-row panel" href="${g.store ? `#/store/${esc(g.store.slug)}` : `#/setup/${esc(g.id)}`}">
      ${icon}
      <span class="g-name">${esc(g.name)}</span>
      <span class="g-chips">${chips}</span>
      <span class="g-action">${action}</span>
    </a>`;
}

async function viewPicker() {
  if (!state.me?.loggedIn) {
    shell('Dashboard', 'Run your server\'s store from one place.', `
      <section class="panel sub-card">
        <p class="note-help">Sign in with Discord to see your servers and set up a store.</p>
        <button class="btn-pill" id="login2">Sign in with Discord</button>
      </section>`);
    $('#login2').onclick = () => (window.location.href = '/auth/login');
    return;
  }
  shell('Your servers', 'Pick a server to manage, or set a new one up.', '<div class="skeleton-list" aria-hidden="true"><div class="panel sk-row"></div><div class="panel sk-row"></div></div>');
  const status = await loadGuilds();
  if (status === 'reauth') {
    shell('Your servers', 'One more sign-in needed.', `
      <section class="panel sub-card">
        <p class="note-help">Ripley needs a fresh sign-in to list your servers (a new permission was added).</p>
        <button class="btn-pill" id="reauth">Sign in again</button>
      </section>`);
    $('#reauth').onclick = () => (window.location.href = '/auth/login');
    return;
  }
  if (status !== 'ok') {
    shell('Your servers', 'Could not load your servers.', '<section class="panel sub-card"><p class="note-help">Refresh to try again.</p></section>');
    return;
  }
  const rows = state.guilds.map(guildRow).join('');
  shell('Your servers', 'Pick a server to manage, or set a new one up.', `
    <div class="g-list">${rows || ''}</div>
    ${rows ? '' : `
      <section class="panel sub-card">
        <p class="note-help">No servers where you have <strong>Manage Server</strong> or <strong>Administrator</strong>. Create a Discord server first — then it appears here.</p>
      </section>`}
    <p class="note-help dash-foot">Servers where you hold Manage Server or Administrator are listed. Missing one? Ask the server owner to grant you Manage Server.</p>`);
}

// ── view: onboarding wizard ───────────────────────────────────────────────────

const wiz = { guildId: null, storeId: null, storeSlug: null, planKey: null, step: 1 };

function stepper(current) {
  const steps = ['Invite the bot', 'Connect Stripe', 'Create product', 'Pick the role'];
  return `
    <ol class="stepper" aria-label="Setup progress">
      ${steps
        .map((s, i) => {
          const n = i + 1;
          const cls = n < current ? 'done' : n === current ? 'now' : '';
          return `<li class="step-i ${cls}"><span class="step-dot">${n < current ? I.check : n}</span><span class="step-lbl">${s}</span></li>`;
        })
        .join('')}
    </ol>
    <div class="step-bar" aria-hidden="true"><span style="width:${((current - 1) / 3) * 100}%"></span></div>`;
}

function fieldErr(id, msg) {
  const el = $(`#err-${id}`);
  if (el) el.textContent = msg ?? '';
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
  const step = wiz.storeId ? 3 : g.botIn ? 2 : 1;
  renderSetupStep(g, step);
}

function renderSetupStep(g, step) {
  wiz.step = step;
  const head = `
    <a class="wiz-back" href="#/">${I.back} All servers</a>
    ${stepper(step)}`;

  if (step === 1) {
    shell(`Set up ${g.name}`, 'Four quick steps and your store is live.', `${head}
      <section class="panel wiz-panel">
        <h2>${I.bot} Invite the Ripley bot</h2>
        <p class="note-help">The bot delivers roles to buyers. Invite it to <strong>${esc(g.name)}</strong> with the Manage Roles permission, then come back here.</p>
        <div class="wiz-actions">
          <a class="btn-pill" href="${esc(state.botInvite)}&guild_id=${esc(g.id)}" target="_blank" rel="noopener">Invite the bot ${I.external}</a>
          <button class="btn-secondary" id="recheck">I added it — check again</button>
        </div>
        <p class="field-err" id="err-bot" role="alert"></p>
      </section>`);
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
    shell(`Set up ${g.name}`, 'Connect the Stripe account that gets paid.', `${head}
      <section class="panel wiz-panel">
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
        <div class="wiz-actions">
          <button class="btn-pill" id="next2">Continue ${I.arrow}</button>
        </div>
      </section>`);
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
        btn.textContent = 'Continue';
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
    shell(`Set up ${g.name}`, 'What are you selling?', `${head}
      <section class="panel wiz-panel">
        <h2>Create your product</h2>
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
        <div class="wiz-actions">
          <button class="btn-pill" id="next3">Create product ${I.arrow}</button>
        </div>
        <p class="field-err" id="err-prod" role="alert"></p>
      </section>`);
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
        btn.textContent = 'Create product';
        fieldErr('prod', data.error ?? 'Something went wrong — try again.');
        return;
      }
      wiz.planKey = data.plan.planKey;
      renderSetupStep(g, 4);
    };
    return;
  }

  // step 4 — role picker
  shell(`Set up ${g.name}`, 'Which role do buyers receive?', `${head}
    <section class="panel wiz-panel">
      <h2>Pick the role</h2>
      <p class="note-help" id="role-hint">Loading roles…</p>
      <div class="role-list" id="role-list"></div>
      <p class="field-err" id="err-role" role="alert"></p>
    </section>`);
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
          state.guilds = null; // refresh picker cache
          renderLive(g, out.store.slug);
        };
      list.append(row);
    }
  })();
}

function renderLive(g, slug) {
  const link = `${location.origin}/s/${slug}`;
  shell('Your store is live', `${esc(g.name)} is ready to sell.`, `
    <section class="panel wiz-panel wiz-done">
      <span class="done-ring">${I.check}</span>
      <h2>Share your store link</h2>
      <div class="share-row">
        <code class="share-link" id="share-link">${esc(link)}</code>
        <button class="btn-secondary" id="copy-link">${I.copy} Copy</button>
      </div>
      <p class="note-help">Buyers sign in with Discord, pay on Stripe, and get their role in seconds. Payments land in your Stripe account; every sale appears on this dashboard.</p>
      <div class="wiz-actions">
        <a class="btn-pill" href="${esc(link)}" target="_blank" rel="noopener">Open your store ${I.external}</a>
        <a class="btn-secondary" href="#/store/${esc(slug)}">Go to dashboard</a>
      </div>
    </section>`);
  $('#copy-link').onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      $('#copy-link').textContent = 'Copied!';
      setTimeout(() => ($('#copy-link').innerHTML = `${I.copy} Copy`), 1600);
    } catch {
      /* select fallback */
      const r = document.createRange();
      r.selectNode($('#share-link'));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    }
  };
}

// ── view: store dashboard ─────────────────────────────────────────────────────

function revenueChart(payments) {
  const days = 30;
  const now = new Date();
  const buckets = Array.from({ length: days }, () => 0);
  const labels = Array.from({ length: days }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (days - 1 - i));
    return d;
  });
  for (const p of payments) {
    const d = new Date(p.createdAt * 1000);
    const diff = Math.floor((now.setHours(0, 0, 0, 0), (new Date(now).setHours(23, 59, 59, 999) - d.getTime()) / 86400000));
    const idx = days - 1 - diff;
    if (idx >= 0 && idx < days) buckets[idx] += p.amountUsd;
  }
  const max = Math.max(...buckets, 1);
  const total = buckets.reduce((a, b) => a + b, 0);
  const W = 600, H = 120, bw = W / days;
  const bars = buckets
    .map((v, i) => {
      const h = Math.max(v > 0 ? 4 : 1.5, (v / max) * (H - 10));
      const d = labels[i];
      const lbl = `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${usd(v)}`;
      return `<rect x="${(i * bw + 2).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${h.toFixed(1)}" rx="2"
        fill="${v > 0 ? 'var(--accent)' : 'var(--edge)'}" opacity="${v > 0 ? 0.9 : 0.6}"><title>${esc(lbl)}</title></rect>`;
    })
    .join('');
  return `
    <div class="chart-head"><span class="stat-label">Last 30 days</span><span class="chart-total">${usd(total)}</span></div>
    <svg class="rev-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue per day over the last 30 days, totaling ${usd(total)}">${bars}</svg>`;
}

async function viewStore(slug) {
  shell('Dashboard', 'Loading…', '<div class="skeleton-list" aria-hidden="true"><div class="panel sk-row"></div><div class="panel sk-row"></div></div>');
  const data = await loadPayments(slug);
  if (!data) {
    shell('Dashboard', 'This store is not yours to see.', `
      <section class="panel sub-card"><p class="note-help">Sign in with the owner account, or pick one of your servers.</p>
      <a class="btn-pill" style="text-decoration:none;display:inline-block" href="#/">Your servers</a></section>`);
    return;
  }
  const store = data.stores.find((s) => s.slug === slug) ?? data.stores[0];
  const t = data.totals;
  const link = store.isDefault ? `${location.origin}/store` : `${location.origin}/s/${store.slug}`;
  const tab = (location.hash.split('/')[3] ?? 'overview');

  const tabs = ['overview', 'payments', 'settings']
    .map((x) => `<a class="tab${x === tab ? ' active' : ''}" href="#/store/${esc(slug)}/${x}" ${x === tab ? 'aria-current="page"' : ''}>${x[0].toUpperCase() + x.slice(1)}</a>`)
    .join('');

  const paymentsRows = (list) =>
    list
      .map(
        (p) => `<tr>
          <td>${fmtDT(p.createdAt)}</td>
          <td>${p.username ? '@' + esc(p.username) : ''}<span class="dim"> ${esc(p.discordId)}</span></td>
          <td>${esc(p.planName)}</td>
          <td class="num">${usd(p.amountUsd)}</td>
          <td>${p.lifetime ? '<span class="chip chip-good">Lifetime</span>' : p.entitled ? '<span class="chip chip-good">Active</span>' : `<span class="chip chip-off">${esc(p.status)}</span>`}</td>
        </tr>`,
      )
      .join('');

  let body = '';
  if (tab === 'overview') {
    body = `
      <div class="stat-grid">
        <div class="panel stat"><span class="stat-label">All-time revenue</span><span class="stat-value">${usd(t.allTimeUsd)}</span></div>
        <div class="panel stat"><span class="stat-label">Purchases</span><span class="stat-value">${t.payments}</span></div>
        <div class="panel stat"><span class="stat-label">Active members</span><span class="stat-value">${t.activeMembers}</span></div>
        <div class="panel stat"><span class="stat-label">Lifetime members</span><span class="stat-value">${t.lifetimeMembers}</span></div>
      </div>
      <section class="panel table-panel">${
        data.payments.length
          ? revenueChart(data.payments)
          : '<p class="note-help">No sales yet — share your store link and the chart wakes up.</p>'
      }</section>
      <section class="panel table-panel">
        <p class="label">Recent payments</p>
        ${
          data.payments.length
            ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Date</th><th>Buyer</th><th>Product</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>${paymentsRows(data.payments.slice(0, 6))}</tbody></table></div>`
            : `<p class="note-help">Your first sale will appear here. Share the store link:</p>
               <div class="share-row"><code class="share-link">${esc(link)}</code></div>`
        }
      </section>`;
  } else if (tab === 'payments') {
    body = `
      <section class="panel table-panel">
        <p class="label">All payments — newest first</p>
        ${
          data.payments.length
            ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Date</th><th>Buyer</th><th>Product</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>${paymentsRows(data.payments)}</tbody></table></div>`
            : '<p class="note-help">No payments yet.</p>'
        }
      </section>`;
  } else {
    const isPlatformOwner = Boolean(state.me?.isOwner);
    body = `
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
      }`;
  }

  shell(store.name, store.isDefault ? 'The built-in store.' : 'Your store on Ripley.', `
    <a class="wiz-back" href="#/">${I.back} All servers</a>
    <nav class="tabs" aria-label="Store sections">${tabs}</nav>
    ${body}`);

  const copy = $('#copy-link');
  if (copy)
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(link);
        copy.textContent = 'Copied!';
        setTimeout(() => (copy.innerHTML = `${I.copy} Copy`), 1600);
      } catch { /* noop */ }
    };

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
