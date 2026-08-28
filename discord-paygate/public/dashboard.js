// Dues owner dashboard — Subscord-style app: left sidebar (Overview /
// Products / Members / Transactions / Discounts / Store / Settings), dense
// tables, one accent for the primary action of each screen. Views are
// hash-routed (#/ picker, #/setup/<guildId> wizard, #/store/<slug>/<section>).
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Discord roles display as @Name exactly once — a role literally named
// "@PREMIUM" must not render as "@@PREMIUM". Stored names stay verbatim.
const roleLabel = (r) => `@${String(r ?? '').replace(/^@+/, '')}`;
const usd = (n) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDT = (unix) =>
  new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
  ', ' + new Date(unix * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtD = (unix) => new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
// Date-only values pinned to end-of-day UTC (discount expiries) must list
// back the calendar day the owner picked, whatever their timezone.
const fmtDUtc = (unix) => new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

// A restricted key with a missing permission does not fail at paste time — it
// fails much later, on a buyer's checkout, with an opaque Stripe error. So the
// exact scopes are on screen next to the field. Keep in step with
// STRIPE_KEY_PERMISSIONS in src/lib/stripe.js.
const KEY_SCOPES = [
  ['Checkout Sessions', 'Write'],
  ['Products', 'Write'],
  ['Prices', 'Write'],
  ['Coupons', 'Write'],
  ['Webhook Endpoints', 'Write'],
  ['Subscriptions', 'Write'],
];
const keyScopesHtml = () => `
  <details class="key-scopes">
    <summary>Permissions a restricted key needs</summary>
    <ul>${KEY_SCOPES.map(([name, level]) => `<li><span>${name}</span><em>${level}</em></li>`).join('')}</ul>
    <p>Everything else can stay <em>None</em>. Dues never reads your balance, payouts or customer list.</p>
  </details>`;

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
  palette: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 2.5 2.5 0 0 0 1.8-4.2c-.6-.7-.1-1.8.9-1.8H17a5 5 0 0 0 5-5c0-5-4.5-9-10-9z"/><circle cx="7.5" cy="11.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="10.5" cy="7" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="7.5" r="1.2" fill="currentColor" stroke="none"/></svg>',
  card: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
};

const state = {
  me: null, guilds: null, botInvite: '', data: null, dataSlug: undefined,
  range: '30',
  rangePicked: null, // slug whose owner hand-picked a range this visit
  billInterval: 'month',
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
  if (!res.ok) throw new Error(out.detail ?? out.error ?? 'That did not work. Try again.');
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
    el.innerHTML = '<button class="btn-pill" id="login">Sign in with Discord</button>';
    $('#login').onclick = () => (window.location.href = '/auth/login');
    return;
  }
  el.innerHTML = `<a class="nav-link" href="/account">Account</a><span>@${esc(me.username ?? me.discordId)}</span><button class="btn-ghost" id="logout">Sign out</button>`;
  $('#logout').onclick = () => (window.location.href = '/auth/logout');
}

// "59.99" and "59,99" both parse. Number inputs on comma-decimal phones
// (Danish, German, …) silently refuse the dot key, so price fields are
// plain text with inputmode=decimal, parsed here.
function parsePrice(v) {
  const n = parseFloat(String(v ?? '').trim().replace(/[^0-9.,]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

// Photo picker: read the chosen file, downscale on a canvas so uploads stay
// around 100KB, hand back a data URL the API stores and serves via /api/img.
// Animated media (GIF, MP4, WebM) rides through untouched — a canvas pass
// would freeze the first frame — capped so the request stays deliverable.
function readPhoto(file, ok, err) {
  if (!file) return err('Pick an image file.');
  const type = file.type || '';
  if (type === 'image/gif' || type === 'video/mp4' || type === 'video/webm') {
    if (file.size > 3_000_000) return err('Keep GIFs and videos under 3MB.');
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => err('Could not read that file.');
    r.readAsDataURL(file);
    return;
  }
  // Some iOS pickers hand files with an empty MIME type — let the actual
  // decode below be the judge instead of refusing up front.
  if (type && !type.startsWith('image/')) return err('Pick an image, GIF, or MP4/WebM video.');
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const max = 1000;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    const keepAlpha = file.type === 'image/png' || file.type === 'image/gif';
    const data = c.toDataURL(keepAlpha ? 'image/png' : 'image/jpeg', 0.85);
    if (data.length > 2_000_000) return err('That photo is too large even after resizing — try a smaller one.');
    ok(data);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    err('Could not read that image.');
  };
  img.src = url;
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
  const action = g.store
    ? g.store.status === 'live'
      ? `Open ${I.arrow}`
      : `Finish setup ${I.arrow}`
    : `Set up ${I.plus}`;
  return `
    <a class="g-row" href="${g.store ? `#/store/${esc(g.store.slug)}` : `#/setup/${esc(g.id)}`}">
      ${icon}
      <span class="g-name">${esc(g.name)} ${chip}</span>
      <span class="g-action">${action}</span>
    </a>`;
}

// ── view: platform admin (OWNER_DISCORD_ID only) ─────────────────────────────
// The bird's-eye page: every signed-in account, every store anyone set up,
// and the platform's own numbers. The server enforces the gate; this view
// just renders what it is allowed to fetch.

const rel = (unix) => {
  const d = Math.floor(Date.now() / 1000) - unix;
  if (d < 90) return 'just now';
  if (d < 5400) return `${Math.round(d / 60)}m ago`;
  if (d < 129600) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
};

async function viewAdmin() {
  if (!state.me?.loggedIn) { location.replace('#/'); return; }
  $('#content').innerHTML = '<div class="admin-wrap"><div class="sk-row panel" aria-hidden="true"></div><div class="sk-row panel" aria-hidden="true"></div></div>';
  const res = await fetch('/api/admin/platform');
  if (!res.ok) {
    $('#content').innerHTML = `<div class="admin-wrap"><section class="panel sub-card"><p class="note-help">${
      res.status === 403 ? 'This page is only for the platform owner.' : 'Could not load platform data — refresh to try again.'
    }</p><a class="btn-secondary" href="#/">Back</a></section></div>`;
    return;
  }
  const d = await res.json();
  const t = d.totals;
  const conv = t.checkoutsStarted ? `${Math.round((t.checkoutsCompleted / t.checkoutsStarted) * 100)}%` : '—';

  const storeRow = (st) => `<tr>
      <td><a class="admin-store-link" href="#/store/${esc(st.slug)}">${esc(st.name)}</a><span class="dim"> /${esc(st.slug)}</span></td>
      <td>${st.ownerUsername ? '@' + esc(st.ownerUsername) : ''}<span class="dim"> ${esc(st.ownerDiscordId ?? '')}</span></td>
      <td>${st.status === 'live' ? '<span class="chip chip-good">Live</span>' : '<span class="chip chip-off">Draft</span>'}</td>
      <td>${esc(st.ownerTier)}</td>
      <td class="num">${st.members}</td>
      <td class="num">${usd(st.revenueUsd)}</td>
      <td class="dim">${st.createdAt ? fmtDT(st.createdAt) : '—'}</td>
    </tr>`;

  const userRow = (u) => `<tr>
      <td>${u.username ? '@' + esc(u.username) : ''}<span class="dim"> ${esc(u.discordId)}</span></td>
      <td>${u.seller ? '<span class="chip chip-code">Seller</span>' : ''}${
        u.entitled ? ' <span class="chip chip-good">Member</span>' : u.memberships ? ' <span class="chip chip-off">Lapsed</span>' : ''
      }</td>
      <td class="num">${u.memberships || ''}</td>
      <td class="num">${u.spentUsd ? usd(u.spentUsd) : ''}</td>
      <td class="dim">${fmtDT(u.joinedAt)}</td>
      <td class="dim">${rel(u.lastSeenAt)}</td>
    </tr>`;

  $('#content').innerHTML = `
    <div class="admin-wrap">
      <div class="admin-head">
        <div><h2 class="sec-title">Platform</h2>
        <p class="card-sub">Everything across Dues — only you can see this page.</p></div>
        <a class="btn-secondary" href="#/">${I.back} My servers</a>
      </div>

      <div class="ck-stats admin-stats">
        <div class="ck-stat"><span class="ck-num">${t.users}</span><span class="ck-lab">Signed-in accounts</span></div>
        <div class="ck-stat"><span class="ck-num">${t.storesLive}<span class="ck-sub">${t.storesDraft ? ` +${t.storesDraft} draft` : ''}</span></span><span class="ck-lab">Stores set up</span></div>
        <div class="ck-stat"><span class="ck-num ck-good">${t.activeMembers}</span><span class="ck-lab">Active members</span></div>
        <div class="ck-stat"><span class="ck-num ck-good">${usd(t.allTimeUsd)}</span><span class="ck-lab">All-time volume</span></div>
        <div class="ck-stat"><span class="ck-num">${t.checkoutsStarted}<span class="ck-sub"> ${conv} paid</span></span><span class="ck-lab">Checkouts started</span></div>
        <div class="ck-stat"><span class="ck-num ck-good">${usd(t.mrrUsd)}<span class="ck-sub">${t.payingOwners ? ` ${t.payingOwners} paying` : ''}</span></span><span class="ck-lab">Dues MRR</span></div>
      </div>

      <section class="panel table-panel">
        <div class="card-head"><div><h3>Stores</h3><p class="card-sub">Everyone who set up the bot — live and still in setup.</p></div></div>
        <div class="table-scroll"><table class="data-table t-pay"><thead><tr>
          <th>Store</th><th>Owner</th><th>Status</th><th>Plan</th><th class="num">Members</th><th class="num">Revenue</th><th>Created</th>
        </tr></thead><tbody>${d.stores.map(storeRow).join('') || '<tr><td colspan="7" class="dim">No stores yet.</td></tr>'}</tbody></table></div>
        <p class="rows-note">${d.stores.length} store(s) · ${t.sellers} seller(s)</p>
      </section>

      <section class="panel table-panel">
        <div class="card-head"><div><h3>Users</h3><p class="card-sub">Every Discord account that has signed in, most recent first.</p></div></div>
        <div class="table-tools">
          <label class="search-box">${I.search}<input id="au-search" type="search" placeholder="Search username or ID…" aria-label="Search users" /></label>
          <select id="au-filter" class="store-switch" aria-label="Filter users">
            <option value="">Everyone</option><option value="seller">Sellers</option><option value="member">Active members</option>
          </select>
        </div>
        <div class="table-scroll"><table class="data-table t-pay"><thead><tr>
          <th>User</th><th>Roles</th><th class="num">Purchases</th><th class="num">Spent</th><th>First seen</th><th>Last seen</th>
        </tr></thead><tbody id="au-body">${d.users.map(userRow).join('')}</tbody></table></div>
        <p class="rows-note" id="au-count">${d.users.length} account(s)</p>
      </section>
    </div>`;

  const apply = () => {
    const q = ($('#au-search').value ?? '').trim().toLowerCase();
    const f = $('#au-filter').value;
    const list = d.users.filter((u) => {
      const hitQ = !q || (u.username ?? '').toLowerCase().includes(q) || u.discordId.includes(q);
      const hitF = !f || (f === 'seller' && u.seller) || (f === 'member' && u.entitled);
      return hitQ && hitF;
    });
    $('#au-body').innerHTML = list.map(userRow).join('') || '<tr><td colspan="6" class="dim">No matches.</td></tr>';
    $('#au-count').textContent = `${list.length} account(s)`;
  };
  $('#au-search').addEventListener('input', apply);
  $('#au-filter').addEventListener('change', apply);
}

async function viewPicker() {
  const me = state.me;
  if (!me?.loggedIn) {
    $('#content').innerHTML = `
      <div class="picker-wrap"><section class="picker-card panel">
        <div class="picker-head"><a class="wiz-back" href="/">${I.back} Back</a><span></span></div>
        <p class="note-help" style="text-align:center">Sign in with Discord to see your servers and set up a store.</p>
        <button class="btn-pill" id="login2" style="align-self:center">Sign in with Discord</button>
      </section></div>`;
    $('#login2').onclick = () => (window.location.href = '/auth/login');
    return;
  }
  $('#content').innerHTML = `
    <div class="picker-wrap"><section class="picker-card panel">
      <div class="picker-head"><a class="wiz-back" href="/">${I.back} Back</a><span></span></div>
      <div class="picker-user">
        <span class="g-icon g-icon-fallback">${esc((me.username ?? '?').slice(0, 1).toUpperCase())}</span>
        <span>Logged in as <strong>${esc(me.username ?? me.discordId)}</strong></span>
        <button class="btn-ghost" id="logout2">Logout</button>
      </div>
      <div class="picker-welcome"><h1>Welcome to Dues</h1><p>Let’s get your Discord server monetized in a few steps.</p></div>
      ${me.isOwner ? `<a class="admin-link panel" href="#/admin">${I.gear}<span><strong>Platform admin</strong><em>Users, stores and totals across all of Dues</em></span>${I.arrow}</a>` : ''}
      <p class="picker-label">Your Servers</p>
      <div class="g-list" id="g-list"><div class="sk-row panel" aria-hidden="true"></div><div class="sk-row panel" aria-hidden="true"></div></div>
    </section></div>`;
  $('#logout2').onclick = () => (window.location.href = '/auth/logout');
  const status = await loadGuilds();
  const list = $('#g-list');
  if (!list) return;
  if (status === 'reauth') {
    list.innerHTML = `<p class="note-help">One more sign-in needed — a new permission lets Dues list your servers.</p>
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
  // Redirects REPLACE the history entry — a hash assignment would push,
  // trapping the Back button in a redirect loop forever.
  if (!g) {
    location.replace('#/');
    return;
  }
  if (g.store) {
    location.replace(`#/store/${g.store.slug}`);
    return;
  }
  // A wizard opened for a DIFFERENT server starts fresh — stale storeId
  // from an earlier setup would write this server's product and role into
  // the previous server's store.
  if (wiz.guildId !== guildId) {
    wiz.storeId = null;
    wiz.storeSlug = null;
    wiz.planKey = null;
  }
  wiz.guildId = guildId;
  renderSetupStep(g, wiz.storeId ? 3 : g.botIn ? 2 : 1);
}

function renderSetupStep(g, step) {
  if (step === 1) {
    wizShell(g, 1, `
      <h2>${I.bot} Invite the Dues bot</h2>
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
      <p class="note-help">Payments go straight to <strong>your own Stripe account</strong> — Dues never holds your money. Find the key in Stripe → Developers → API keys.</p>
      <label class="field">
        <span class="field-label">Store name <span aria-hidden="true">*</span></span>
        <input id="f-name" type="text" maxlength="60" value="${esc(g.name)}" autocomplete="organization" />
        <span class="field-help">Shown to buyers on your store page.</span>
        <span class="field-err" id="err-name" role="alert"></span>
      </label>
      <label class="field">
        <span class="field-label">Stripe API key <span aria-hidden="true">*</span></span>
        <input id="f-key" type="password" placeholder="rk_live_…" autocomplete="off" spellcheck="false" />
        <span class="field-help">A <strong>restricted key</strong> (rk_live_…) is the safer choice and what Stripe recommends — a secret key (sk_live_…) also works. Use the test-mode version of either while trying things out. Stored encrypted; validated with Stripe before anything is saved, and your webhook is registered automatically.</span>
        ${keyScopesHtml()}
        <span class="field-err" id="err-key" role="alert"></span>
      </label>
      <div class="wiz-actions"><button class="btn-pill" id="next2">Continue ${I.arrow}</button></div>`);
    $('#next2').onclick = async () => {
      const name = $('#f-name').value.trim();
      const key = $('#f-key').value.trim();
      fieldErr('name', ''); fieldErr('key', '');
      if (!name) return fieldErr('name', 'Give your store a name.');
      if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]/.test(key)) return fieldErr('key', 'That does not look like a Stripe API key — restricted (rk_live_…) or secret (sk_live_…) both work.');
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
          <input id="f-price" type="text" inputmode="decimal" placeholder="59.99" autocomplete="off" />
          <span class="field-err" id="err-price" role="alert"></span>
        </label>
        <label class="field">
          <span class="field-label">Billing</span>
          <select id="f-billing"><option value="lifetime" selected>One-time · lifetime</option><option value="month">Monthly subscription</option></select>
        </label>
      </div>
      <div class="field">
        <span class="field-label">Product photo</span>
        <div class="photo-row">
          <img id="f-photo-prev" class="photo-prev" alt="" hidden />
          <button type="button" class="btn-secondary" id="f-photo-btn">Choose photo</button>
          <button type="button" class="btn-ghost" id="f-photo-clear" hidden>Remove</button>
          <input id="f-photo" type="file" accept="image/*,video/mp4,video/webm" hidden />
        </div>
        <span class="field-help">Shown on your store page and in Stripe checkout. Or paste a link:</span>
        <input id="f-img" type="url" placeholder="https://…  (optional)" spellcheck="false" />
      </div>
      <div class="wiz-actions"><button class="btn-pill" id="next3">Continue ${I.arrow}</button></div>
      <p class="field-err" id="err-prod" role="alert"></p>`);
    let wizPhoto = null;
    $('#f-photo-btn').onclick = () => $('#f-photo').click();
    $('#f-photo').onchange = () => {
      fieldErr('prod', '');
      readPhoto(
        $('#f-photo').files[0],
        (data) => {
          wizPhoto = data;
          const prev = $('#f-photo-prev');
          if (data.startsWith('data:video/')) {
            prev.hidden = true;
          } else {
            prev.src = data;
            prev.hidden = false;
          }
          $('#f-photo-clear').hidden = false;
        },
        (msg) => fieldErr('prod', msg),
      );
    };
    $('#f-photo-clear').onclick = () => {
      wizPhoto = null;
      $('#f-photo').value = '';
      $('#f-photo-prev').hidden = true;
      $('#f-photo-clear').hidden = true;
    };
    $('#next3').onclick = async () => {
      const name = $('#f-pname').value.trim();
      const priceUsd = parsePrice($('#f-price').value);
      fieldErr('pname', ''); fieldErr('price', ''); fieldErr('prod', '');
      if (!name) return fieldErr('pname', 'Name your product.');
      if (!Number.isFinite(priceUsd) || priceUsd < 1) return fieldErr('price', 'Set a price of at least $1 — e.g. 59.99');
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
          ...(wizPhoto ? { imageData: wizPhoto } : {}),
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
    $('#role-hint').innerHTML = `Greyed roles sit at or above the bot’s top role <strong>${esc(data.botTop.name)}</strong> — drag Dues’s role higher in Server Settings → Roles to unlock them.`;
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
  // Setup is complete — clear the wizard so a later run for another server
  // starts from step 1 instead of inheriting this store's id.
  wiz.storeId = null;
  wiz.storeSlug = null;
  wiz.planKey = null;
  wiz.guildId = null;
  // The history entry stops being the finished wizard: Back from the
  // dashboard lands on the server picker, not a #/setup/<id> redirect loop.
  history.replaceState(null, '', '#/');
  const link = `${location.origin}/${slug}`;
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

function deltaChip(delta) {
  if (delta === null || delta === undefined) return '';
  const n = Math.abs(delta) >= 100 ? Math.round(Math.abs(delta)) : Math.abs(delta).toFixed(Math.abs(delta) < 10 ? 1 : 0);
  return `<span class="delta ${delta >= 0 ? 'up' : 'down'}"><span aria-hidden="true">${delta >= 0 ? '▲' : '▼'}</span>${n}%</span>`;
}

function statCard(label, value, icon, delta = null, sub = '', spark = '') {
  return `<div class="panel stat"><div class="stat-top"><span class="stat-label">${label}</span><span class="stat-ic">${icon}</span></div><span class="stat-value">${value}${deltaChip(delta)}</span>${spark}${sub ? `<span class="stat-sub">${sub}</span>` : ''}</div>`;
}

// Straight segments with round joins — the Stripe treatment. Spiky
// one-sale-a-day data stays honest and crisp; smoothing curves turned it
// into a sine wave.
// Smooth monotone cubic through every data point (Fritsch–Carlson slopes,
// emitted as beziers). No overshoot: the curve never invents a peak or dip
// the data doesn't have, so hover dots always sit exactly on the line.
function linePath(pts) {
  const n = pts.length;
  if (n === 0) return '';
  if (n === 1) return `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  if (n === 2)
    return `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}L${pts[1][0].toFixed(1)} ${pts[1][1].toFixed(1)}`;
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0] || 1));
  const m = [d[0]];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = Math.hypot(a, b);
    if (h > 3) { m[i] = (3 * d[i] * a) / h; m[i + 1] = (3 * d[i] * b) / h; }
  }
  let path = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = (pts[i + 1][0] - pts[i][0]) / 3;
    path += `C${(pts[i][0] + dx).toFixed(1)} ${(pts[i][1] + m[i] * dx).toFixed(1)} ${(pts[i + 1][0] - dx).toFixed(1)} ${(pts[i + 1][1] - m[i + 1] * dx).toFixed(1)} ${pts[i + 1][0].toFixed(1)} ${pts[i + 1][1].toFixed(1)}`;
  }
  return path;
}

// Tiny trajectory line inside a stat card. Dense windows are aggregated down
// to ~12 buckets (sums, so the shape stays truthful); all-zero windows render
// a muted baseline so the cards keep the same height with or without data.
function sparkSvg(vals) {
  if (vals.length < 2) return '';
  let v = vals;
  if (v.length > 12) {
    const size = Math.ceil(v.length / 12);
    const packed = [];
    for (let i = 0; i < v.length; i += size) packed.push(v.slice(i, i + size).reduce((s, n) => s + n, 0));
    v = packed;
  }
  const n = v.length;
  const W = 120, H = 34, p = 3;
  const max = Math.max(...v, 1);
  const x = (i) => p + (i / (n - 1)) * (W - 2 * p);
  const y = (val) => H - p - (val / max) * (H - 2 * p);
  const line = linePath(v.map((val, i) => [x(i), y(val)]));
  const flat = v.every((val) => val === 0);
  const gid = `sg${(sparkSvg.seq = (sparkSvg.seq ?? 0) + 1)}`;
  return `<svg class="stat-spark${flat ? ' flat' : ''}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style="stop-color:var(--accent);stop-opacity:0.18" />
      <stop offset="1" style="stop-color:var(--accent);stop-opacity:0" />
    </linearGradient></defs>
    <path class="spark-fill" fill="url(#${gid})" d="${line} L${x(n - 1).toFixed(1)} ${(H - p).toFixed(1)} L${x(0).toFixed(1)} ${(H - p).toFixed(1)} Z" />
    <path class="spark-line" d="${line}" fill="none" vector-effect="non-scaling-stroke" />
    <circle class="spark-dot" cx="${x(n - 1).toFixed(1)}" cy="${y(v[n - 1]).toFixed(1)}" r="2.4" />
  </svg>`;
}

// ── analytics: ranges, buckets, comparison ───────────────────────────────────
// Every range compares against the immediately preceding window of the same
// length; the comparison is named everywhere it is used.

const RANGES = [
  ['today', 'Today'],
  ['7', '7d'],
  ['30', '30d'],
  ['90', '90d'],
  ['12m', '12m'],
  ['all', 'All'],
];

function rangeWindows(range, payments) {
  const nowMs = Date.now();
  const day = 86400000;
  if (range === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { cur: [start.getTime(), nowMs], prev: [start.getTime() - day, start.getTime()], cmp: 'yesterday (same time)', grain: 'hour' };
  }
  if (range === '12m') {
    const start = new Date();
    start.setHours(0, 0, 0, 0); start.setDate(1); start.setMonth(start.getMonth() - 11);
    const prevStart = new Date(start);
    prevStart.setMonth(prevStart.getMonth() - 12);
    return { cur: [start.getTime(), nowMs], prev: [prevStart.getTime(), start.getTime()], cmp: 'the previous 12 months', grain: 'month' };
  }
  if (range === 'all') {
    const first = payments.length ? Math.min(...payments.map((p) => p.createdAt)) * 1000 : nowMs;
    return { cur: [first, nowMs], prev: null, cmp: null, grain: 'month' };
  }
  // Day ranges are calendar-aligned: full days, so "30d vs the previous 30d"
  // compares like with like.
  const days = Number(range);
  const d0 = new Date();
  d0.setHours(0, 0, 0, 0);
  const start = d0.getTime() - (days - 1) * day;
  return { cur: [start, nowMs], prev: [start - days * day, start], cmp: `the previous ${days} days`, grain: 'day' };
}

const inWin = (p, w) => w && p.createdAt * 1000 >= w[0] && p.createdAt * 1000 < w[1];

// Aligned bucket series for the chart: current window plus the previous
// window mapped onto the same bucket index (offset by one window length).
// valueOf decides what is summed per bucket: dollars for revenue, 1 for
// counts — the same machinery feeds the big chart and the card sparklines.
function bucketSeries(payments, win, valueOf = (p) => p.amountUsd) {
  const { cur, prev, grain } = win;
  const marks = [];
  if (grain === 'hour') {
    for (let h = 0; h < 24; h++) marks.push(cur[0] + h * 3600000);
  } else if (grain === 'day') {
    const days = Math.round((cur[1] - cur[0]) / 86400000);
    const d0 = new Date(cur[1]);
    d0.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) marks.push(d0.getTime() - i * 86400000);
  } else {
    const d = new Date(cur[0]);
    d.setDate(1); d.setHours(0, 0, 0, 0);
    const stop = new Date(cur[1]);
    while (d <= stop && marks.length < 24) {
      marks.push(d.getTime());
      d.setMonth(d.getMonth() + 1);
    }
  }
  const span = grain === 'hour' ? 3600000 : grain === 'day' ? 86400000 : 0;
  const offset = prev ? cur[0] - prev[0] : 0;
  const idxFor = (tMs, base) => {
    if (grain === 'month') {
      const pd = new Date(tMs);
      return marks.findIndex((m) => {
        const md = new Date(m + base);
        return md.getFullYear() === pd.getFullYear() && md.getMonth() === pd.getMonth();
      });
    }
    for (let i = marks.length - 1; i >= 0; i--) if (tMs >= marks[i] + base) return tMs < marks[i] + base + span || i === marks.length - 1 ? i : -1;
    return -1;
  };
  const curVals = marks.map(() => 0);
  const prevVals = prev ? marks.map(() => 0) : null;
  for (const p of payments) {
    const t = p.createdAt * 1000;
    if (t >= cur[0] && t < cur[1]) {
      const i = idxFor(t, 0);
      if (i >= 0) curVals[i] += valueOf(p);
    } else if (prev && t >= prev[0] && t < prev[1]) {
      const i = idxFor(t, -offset);
      if (i >= 0) prevVals[i] += valueOf(p);
    }
  }
  const labelFor = (i) => {
    const d = new Date(marks[i]);
    if (grain === 'hour') return d.toLocaleTimeString(undefined, { hour: 'numeric' });
    if (grain === 'day') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  };
  return { curVals, prevVals, labels: marks.map((_, i) => labelFor(i)) };
}

// Clean axis ceiling: 1/2/2.5/5 × 10^n.
function niceCeil(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// Revenue chart: the current period as a smooth monotone line with a quiet
// area beneath it, the previous period as a dashed muted line on the same
// scale, hairline gridlines with clean tick labels. Hover (wired after
// render) adds a crosshair, a dot on each line and a two-period tooltip.
function revenueChart(series) {
  const W = 920, H = 190, padL = 44, padB = 20, padT = 8;
  const { curVals, prevVals, labels } = series;
  const n = curVals.length || 1;
  const plotW = W - padL - 6, plotH = H - padB - padT;
  const maxRaw = Math.max(...curVals, ...(prevVals ?? [0]), 1);
  const max = niceCeil(maxRaw);
  const y = (v) => padT + plotH - (v / max) * plotH;
  const band = plotW / n;
  const x = (i) => padL + i * band + band / 2;
  const money = (v) => (max >= 1000 ? `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : `$${v}`);
  const base = padT + plotH;

  // Three quiet horizontals: a solid baseline and two dashed guides — the
  // Stripe-dashboard idiom, less ink than a full grid.
  const grid = [0, 0.5, 1]
    .map((f) => {
      const gy = y(max * f);
      const baselineRow = f === 0;
      return `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - 6}" y2="${gy.toFixed(1)}" stroke="var(--edge)" stroke-width="1"${baselineRow ? '' : ' stroke-dasharray="3 5" opacity="0.6"'} />
        <text x="${padL - 8}" y="${(gy + 3.5).toFixed(1)}" text-anchor="end" class="tick">${money(max * f)}</text>`;
    })
    .join('');

  const curPts = curVals.map((v, i) => [x(i), y(v)]);
  const curLine = linePath(curPts);
  const area =
    n > 1
      ? `<path class="area-fill" d="${curLine} L${x(n - 1).toFixed(1)} ${base.toFixed(1)} L${x(0).toFixed(1)} ${base.toFixed(1)} Z" fill="url(#rev-fade)" />`
      : '';
  const line =
    n > 1
      ? `<path class="cur-line" pathLength="1" d="${curLine}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`
      : `<circle cx="${x(0).toFixed(1)}" cy="${y(curVals[0] ?? 0).toFixed(1)}" r="3.5" fill="var(--accent)" />`;
  // Live endpoint: a marked dot with a quiet halo ring on the newest bucket.
  const endDot =
    n > 1
      ? `<circle class="end-halo" cx="${x(n - 1).toFixed(1)}" cy="${y(curVals[n - 1]).toFixed(1)}" r="7" fill="var(--accent)" opacity="0.14" />
         <circle class="end-dot" cx="${x(n - 1).toFixed(1)}" cy="${y(curVals[n - 1]).toFixed(1)}" r="3.2" fill="var(--accent)" stroke="var(--panel)" stroke-width="1.5" />`
      : '';

  const prevLine =
    prevVals && n > 1
      ? `<path class="prev-line" d="${linePath(prevVals.map((v, i) => [x(i), y(v)]))}" fill="none" stroke="var(--dim)" stroke-width="1.5" stroke-dasharray="5 5" stroke-linejoin="round" stroke-linecap="round" opacity="0.8" />`
      : '';

  // Selective direct label: the peak bucket only — and only when it fits
  // inside the frame (the tooltip still carries every bucket).
  const peak = curVals.indexOf(Math.max(...curVals));
  const peakY = y(curVals[peak]) - 8;
  const peakLabel =
    curVals[peak] > 0 && peakY >= padT + 9
      ? `<circle cx="${x(peak).toFixed(1)}" cy="${y(curVals[peak]).toFixed(1)}" r="3" fill="var(--accent)" />
         <text x="${x(peak).toFixed(1)}" y="${peakY.toFixed(1)}" text-anchor="middle" class="peak">${usd(curVals[peak])}</text>`
      : '';

  const xt = [0, Math.floor((n - 1) / 4), Math.floor((n - 1) / 2), Math.floor((3 * (n - 1)) / 4), n - 1].filter(
    (v, i, a) => a.indexOf(v) === i,
  );
  const xLabels = xt
    .map((i) => `<text x="${x(i).toFixed(1)}" y="${H - 5}" text-anchor="middle" class="tick">${esc(labels[i] ?? '')}</text>`)
    .join('');

  return `<svg class="rev-chart" viewBox="0 0 ${W} ${H}" data-max="${max}" role="img" aria-label="Revenue over time with previous-period comparison">
    <defs><linearGradient id="rev-fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style="stop-color:var(--accent);stop-opacity:0.2" />
      <stop offset="0.55" style="stop-color:var(--accent);stop-opacity:0.06" />
      <stop offset="1" style="stop-color:var(--accent);stop-opacity:0" />
    </linearGradient></defs>
    ${grid}${area}${prevLine}${line}${endDot}${peakLabel}${xLabels}
    <line class="xhairline" x1="0" y1="${padT}" x2="0" y2="${base}" stroke="var(--ink)" stroke-width="1" opacity="0" />
    <circle class="dot-prev" r="3" fill="var(--dim)" opacity="0" />
    <circle class="dot-cur" r="4" fill="var(--accent)" stroke="var(--panel)" stroke-width="1.5" opacity="0" />
  </svg>`;
}

// Crosshair, a dot riding each line, and one tooltip reading BOTH series at
// the hovered X — including the change between the two periods.
function wireChartHover(card, series) {
  const svg = card.querySelector('.rev-chart');
  if (!svg) return;
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  card.append(tip);
  const hair = svg.querySelector('.xhairline');
  const dotCur = svg.querySelector('.dot-cur');
  const dotPrev = svg.querySelector('.dot-prev');
  const { curVals, prevVals, labels } = series;
  const n = curVals.length;
  const padL = 44, W = 920, H = 190, padT = 8, padB = 20;
  const plotH = H - padB - padT;
  const max = Number(svg.dataset.max) || 1;
  const yFor = (v) => padT + plotH - (v / max) * plotH;
  const band = (W - padL - 6) / n;
  let last = -1;
  const show = (i, clientX, clientY) => {
    if (i < 0 || i >= n) return;
    if (i !== last) {
      last = i;
      tip.textContent = '';
      const t = document.createElement('div');
      t.className = 'chart-tip-title';
      t.textContent = labels[i];
      tip.append(t);
      const row = (cls, label, v) => {
        const r = document.createElement('div');
        r.className = 'chart-tip-row';
        const key = document.createElement('span');
        key.className = `tip-key ${cls}`;
        const val = document.createElement('strong');
        val.textContent = usd(v);
        const lbl = document.createElement('span');
        lbl.className = 'tip-lbl';
        lbl.textContent = label;
        r.append(key, val, lbl);
        tip.append(r);
      };
      row('cur', 'this period', curVals[i]);
      if (prevVals) {
        row('prev', 'previous', prevVals[i]);
        if (prevVals[i] > 0) {
          const d = ((curVals[i] - prevVals[i]) / prevVals[i]) * 100;
          const dr = document.createElement('div');
          dr.className = `tip-delta ${d >= 0 ? 'up' : 'down'}`;
          dr.textContent = `${d >= 0 ? '▲' : '▼'} ${Math.abs(d) >= 100 ? Math.round(Math.abs(d)) : Math.abs(d).toFixed(0)}% vs previous`;
          tip.append(dr);
        }
      }
      const xPos = padL + i * band + band / 2;
      hair.setAttribute('x1', xPos);
      hair.setAttribute('x2', xPos);
      hair.setAttribute('opacity', '0.22');
      dotCur.setAttribute('cx', xPos);
      dotCur.setAttribute('cy', yFor(curVals[i]));
      dotCur.setAttribute('opacity', '1');
      if (dotPrev && prevVals) {
        dotPrev.setAttribute('cx', xPos);
        dotPrev.setAttribute('cy', yFor(prevVals[i]));
        dotPrev.setAttribute('opacity', '0.9');
      }
    }
    tip.hidden = false;
    const box = card.getBoundingClientRect();
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(clientX - box.left + 14, 8), box.width - tw - 8)}px`;
    tip.style.top = `${Math.max(clientY - box.top - 14, 8)}px`;
  };
  svg.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    show(Math.floor((sx - padL) / band), e.clientX, e.clientY);
  });
  svg.addEventListener('pointerleave', () => {
    tip.hidden = true;
    last = -1;
    hair.setAttribute('opacity', '0');
    dotCur.setAttribute('opacity', '0');
    if (dotPrev) dotPrev.setAttribute('opacity', '0');
  });
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
        <td>${esc(p.planName)}<span class="row-when">${fmtDT(p.createdAt)}</span></td>
        <td class="num">${usd(p.amountUsd)}</td>
        <td>${chipFor(p)}</td>
        <td class="dim">${fmtDT(p.createdAt)}</td>
      </tr>`,
    )
    .join('');
}

// Checkout attempts. "Started" means the buyer reached Stripe's card form —
// an abandoned one leaves no payment behind, so this is the only place it
// shows up.
// "3m" between clicking Pay and the money landing — worth a column of its
// own: a wall of 40-minute completions usually means a payment-page problem.
function fmtDur(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec < 90) return `${Math.max(1, Math.round(sec))}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
}

function checkoutRows(list) {
  if (!list.length) return '<tr><td colspan="6" class="dim">No checkouts started yet.</td></tr>';
  return list
    .map(
      (c) => `<tr>
        <td>${c.username ? '@' + esc(c.username) : ''}<span class="dim"> ${esc(c.discordId)}</span></td>
        <td>${esc(c.planName)}${c.discountCode ? ` <span class="chip chip-code">${esc(c.discountCode)}</span>` : ''}<span class="row-when">${fmtDT(c.createdAt)}${
          c.completedAt ? ` · paid in ${fmtDur(c.completedAt - c.createdAt)}` : ''
        }</span></td>
        <td class="num">${usd(c.amountUsd)}</td>
        <td>${
          c.status === 'completed'
            ? '<span class="chip chip-good">Paid</span>'
            : '<span class="chip chip-warn">Not finished</span>'
        }</td>
        <td class="dim">${fmtDT(c.createdAt)}</td>
        <td class="dim">${
          c.completedAt
            ? `${fmtDT(c.completedAt)}<span class="ck-dur"> · ${fmtDur(c.completedAt - c.createdAt)}</span>`
            : '—'
        }</td>
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
  ['customize', 'Dashboard', 'palette'],
  ['billing', 'Billing', 'card'],
  ['settings', 'Settings', 'gear'],
];

function sectionOverview(data, store, slug) {
  const win = rangeWindows(state.range, data.payments);
  const inRange = data.payments.filter((p) => inWin(p, win.cur));
  const prevRange = win.prev ? data.payments.filter((p) => inWin(p, win.prev)) : null;
  const sum = (l) => l.reduce((s, p) => s + p.amountUsd, 0);
  const pct = (cur, prev) => (prevRange === null || prev <= 0 ? null : ((cur - prev) / prev) * 100);

  const rev = sum(inRange);
  const revPrev = prevRange ? sum(prevRange) : 0;
  const sales = inRange.length;
  const salesPrev = prevRange ? prevRange.length : 0;

  // First-ever purchase per buyer — "new members" is first purchases in the
  // window, not just activity.
  const firstBuy = new Map();
  for (const p of data.payments) {
    const t = firstBuy.get(p.discordId);
    if (t === undefined || p.createdAt < t) firstBuy.set(p.discordId, p.createdAt);
  }
  const newIn = (w) => (w ? [...firstBuy.values()].filter((t) => t * 1000 >= w[0] && t * 1000 < w[1]).length : 0);
  const newMembers = newIn(win.cur);
  const newMembersPrev = prevRange ? newIn(win.prev) : 0;


  const mrr = sum(data.payments.filter((p) => p.entitled && !p.lifetime));
  const mrrNew = sum(data.payments.filter((p) => p.entitled && !p.lifetime && inWin(p, win.cur)));

  const cmpNote = win.cmp ? `vs ${win.cmp}` : 'all time';
  const prevSub = (v, fmt = usd) => (prevRange === null ? cmpNote : `${fmt(v)} ${cmpNote}`);

  const series = bucketSeries(data.payments, win);

  // Card sparklines: each metric's trajectory across the current window,
  // bucketed exactly like the big chart.
  const firstBuys = [...firstBuy.values()].map((t) => ({ createdAt: t }));
  const sparks = {
    rev: sparkSvg(series.curVals),
    sales: sparkSvg(bucketSeries(data.payments, win, () => 1).curVals),
    members: sparkSvg(bucketSeries(firstBuys, win, () => 1).curVals),
    mrr: sparkSvg(bucketSeries(data.payments.filter((p) => !p.lifetime), win).curVals),
  };

  // Top products with per-product change vs the previous window.
  const byPlan = new Map();
  for (const p of inRange) byPlan.set(p.planName, (byPlan.get(p.planName) ?? 0) + p.amountUsd);
  const byPlanPrev = new Map();
  if (prevRange) for (const p of prevRange) byPlanPrev.set(p.planName, (byPlanPrev.get(p.planName) ?? 0) + p.amountUsd);
  const top = [...byPlan.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topMax = Math.max(...top.map(([, v]) => v), 1);
  const topDelta = (name, v) => {
    const prev = byPlanPrev.get(name) ?? 0;
    const d = pct(v, prev);
    return d === null ? '' : `<span class="delta ${d >= 0 ? 'up' : 'down'}"><span aria-hidden="true">${d >= 0 ? '▲' : '▼'}</span>${Math.abs(d) >= 100 ? Math.round(Math.abs(d)) : Math.abs(d).toFixed(0)}%</span>`;
  };

  const recent = data.payments.slice(0, 6);
  const seg = RANGES.map(
    ([k, lbl]) => `<button type="button" class="seg-btn${state.range === k ? ' active' : ''}" data-range="${k}" ${state.range === k ? 'aria-pressed="true"' : ''}>${lbl}</button>`,
  ).join('');

  // Owner-tunable dashboard: which stat cards show, the accent that paints
  // the charts, and the default period — saved per store.
  const prefs = store.dashboardPrefs ?? {};
  const cards = { revenue: true, sales: true, members: true, mrr: true, ...(prefs.cards ?? {}) };
  const statCards = [
    cards.revenue ? statCard('Revenue', usd(rev), I.dollar, pct(rev, revPrev), prevSub(revPrev), sparks.rev) : '',
    cards.sales ? statCard('Sales', sales, I.cart, pct(sales, salesPrev), prevSub(salesPrev, (v) => v), sparks.sales) : '',
    cards.members ? statCard('New members', newMembers, I.users, pct(newMembers, newMembersPrev), prevSub(newMembersPrev, (v) => v), sparks.members) : '',
    cards.mrr ? statCard('MRR', usd(mrr), I.infinity, null, mrrNew > 0 ? `+${usd(mrrNew)} added this period` : 'recurring, right now', sparks.mrr) : '',
  ].join('');
  return `
    <div class="ov-toolbar">
      <h2 class="sec-title">Overview</h2>
      <div class="seg" role="group" aria-label="Time period" id="range-seg">${seg}</div>
    </div>
    <div id="checklist-slot"></div>
    <div class="stat-grid five">
      ${statCards}
    </div>
    <div class="chart-grid">
      <section class="panel chart-card" id="rev-card">
        <div class="card-head"><div><h3>Revenue</h3><p class="card-sub">${win.cmp ? `This period against ${win.cmp}` : 'Monthly, all time'}</p></div>
          <div class="chart-side"><span class="chart-total">${usd(rev)}${deltaChip(pct(rev, revPrev))}</span>
            <span class="chart-legend"><span class="lg-key cur"></span>This period${series.prevVals ? '<span class="lg-key prev"></span>Previous' : ''}</span></div></div>
        ${revenueChart(series)}
      </section>
      <section class="panel chart-card">
        <div class="card-head"><div><h3>Top Products</h3><p class="card-sub">Revenue by product, ${win.cmp ? 'this period' : 'all time'}</p></div></div>
        ${
          top.length
            ? `<ul class="top-list">${top
                .map(
                  ([name, v]) => `<li><span class="top-meta"><strong>${esc(name)}</strong><span class="num">${usd(v)} ${topDelta(name, v)}</span></span>
                    <span class="top-bar"><span style="width:${Math.max((v / topMax) * 100, 2)}%"></span></span></li>`,
                )
                .join('')}</ul>`
            : '<div class="empty-chart">No sales in this period</div>'
        }
        <p class="rows-note">Active members: ${data.totals.activeMembers} · All-time revenue: ${usd(data.totals.allTimeUsd)}</p>
      </section>
    </div>
    <div class="chart-grid">
      <section class="panel table-panel">
        <div class="card-head"><div><h3>Recent Transactions</h3><p class="card-sub">Latest activity in your store</p></div>
        <a class="btn-secondary" href="#/store/${esc(slug)}/payments">View all ${I.arrow}</a></div>
        ${
          data.payments.length
            ? `<div class="table-scroll"><table class="data-table t-pay"><thead><tr><th>Customer</th><th>Product</th><th class="num">Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>${paymentsRows(data.payments.slice(0, 8))}</tbody></table></div>`
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
                    <span class="sale-meta"><strong>${p.username ? '@' + esc(p.username) : esc(p.discordId)}</strong><span class="dim">${esc(p.planName)} · ${fmtDT(p.createdAt)}</span></span>
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
      { ok: rolesOk, label: 'Bot role sits above the roles it delivers', href: null, hint: 'Drag the Dues role higher in Server Settings → Roles.' },
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
      <div class="card-head"><div><h3>Products</h3><p class="card-sub">This is the built-in store — its catalog comes from the deployment configuration.
        Set up your server’s own store to create and edit products right here.</p></div>
        <a class="btn-pill" style="text-decoration:none" href="#/">Set up your store</a></div>
    </section>`;
}

function productEditorFields(p = {}) {
  return `
    <div class="field-row">
      <label class="field"><span class="field-label">Name <span aria-hidden="true">*</span></span>
        <input class="pe-name" type="text" maxlength="80" value="${esc(p.name ?? '')}" placeholder="Premium" /></label>
      <label class="field"><span class="field-label">Price (USD) <span aria-hidden="true">*</span></span>
        <input class="pe-price" type="text" inputmode="decimal" value="${p.priceUsd ?? ''}" placeholder="59.99" autocomplete="off" /></label>
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
    <div class="field-row">
      <label class="field"><span class="field-label">Available until</span>
        <input class="pe-expires" type="date" />
        <span class="field-help">Optional — after this day it stops being sold. Buyers keep what they bought.</span></label>
      <label class="field"><span class="field-label">Who can buy</span>
        <select class="pe-gate"><option value="">Everyone</option></select>
        <span class="field-help">Optional — only members already holding this role can purchase.</span></label>
    </div>
    <label class="field"><span class="field-label">Role this product gives <span aria-hidden="true">*</span></span>
      <select class="pe-role"><option value="">Loading your server’s roles…</option></select>
      <span class="field-help pe-role-help">Buyers get this Discord role the moment payment clears.</span></label>
    <div class="field"><span class="field-label">Product photo</span>
      <div class="photo-row">
        <img class="pe-photo-prev photo-prev" alt="" hidden />
        <button type="button" class="btn-secondary pe-photo-btn">Choose photo</button>
        <button type="button" class="btn-ghost pe-photo-clear" hidden>Remove</button>
        <input class="pe-photo-file" type="file" accept="image/*,video/mp4,video/webm" hidden />
      </div>
      <span class="field-help">Or paste a link:</span>
      <input class="pe-img" type="url" value="${esc(p.imageUrl ?? '')}" placeholder="https://…  (optional)" spellcheck="false" /></div>
    <label class="field"><span class="field-label">Product link</span>
      <input class="pe-link" type="text" maxlength="40" value="${esc(p.linkSlug ?? '')}" placeholder="${esc(p.planKey ?? 'vip')}  (its own URL: /your-store/this)" spellcheck="false" autocapitalize="off" /></label>
    <label class="field"><span class="field-label">Success URL</span>
      <input class="pe-success" type="url" value="${esc(p.successUrl ?? '')}" placeholder="https://…  (optional — where buyers land after paying)" spellcheck="false" /></label>
    <div class="field pe-opts-block">
      <span class="field-label">More pricing options</span>
      <span class="field-help">Optional — sell this product at other billing choices too (say, Lifetime $500 and Monthly $50). Buyers pick one on the product page; every option delivers the same role.</span>
      <div class="pe-opts"></div>
      <button type="button" class="btn-secondary pe-opt-add">${I.plus} Add option</button>
    </div>`;
}

// One row of the create form's options repeater.
function optionRowHtml() {
  return `<div class="field-row pe-opt-row">
    <label class="field"><span class="field-label">Option label</span>
      <input class="po-label" type="text" maxlength="40" placeholder="Monthly" /></label>
    <label class="field"><span class="field-label">Price (USD)</span>
      <input class="po-price" type="text" inputmode="decimal" placeholder="50" autocomplete="off" /></label>
    <label class="field"><span class="field-label">Billing</span>
      <select class="po-billing">
        <option value="month">Monthly subscription</option>
        <option value="lifetime">One-time · lifetime</option>
      </select></label>
    <button type="button" class="btn-ghost po-remove" aria-label="Remove option">Remove</button>
  </div>`;
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
  // Parents first, each followed by its pricing options ("↳" rows). An
  // option is the same product at another price/cadence: it has no link, no
  // photo and no role of its own — those live on the product.
  const rowFor = (p, isOpt) => `<tr data-plan="${esc(p.planKey)}">
        <td class="prod-cell">${
          isOpt
            ? `<span class="prod-thumb prod-thumb-empty" aria-hidden="true"></span><span><span class="dim">↳</span> <strong>${esc(p.name)}</strong><span class="dim prod-roles"> option</span></span>`
            : `${p.imageUrl ? `<img class="prod-thumb" src="${esc(p.imageUrl)}" alt="" width="30" height="30" />` : '<span class="prod-thumb prod-thumb-empty"></span>'}
          <span><strong>${esc(p.name)}</strong><span class="dim prod-roles"> ${esc((p.roleNames ?? []).map(roleLabel).join(', '))}${p.requiredRoleId ? ` · ${esc(roleLabel(p.requiredRoleName ?? 'role'))} only` : ''}</span></span>`
        }</td>
        <td class="num">${usd(p.priceUsd)}</td>
        <td class="dim">${billingLabel(p)}${
          p.expiresAt ? (p.expiresAt * 1000 <= Date.now() ? ' · <strong>ended</strong>' : ` · ends ${new Date(p.expiresAt * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`) : ''
        }</td>
        <td class="num">${(membersBy.get(p.planKey) ?? new Set()).size}</td>
        <td class="num">${usd(revenueBy.get(p.planKey) ?? 0)}</td>
        <td><label class="switch"><input type="checkbox" class="prod-active" data-plan="${esc(p.planKey)}" ${p.active ? 'checked' : ''} /><span></span></label></td>
        <td class="row-actions">
          ${isOpt ? '' : `<button class="btn-ghost prod-opt" data-plan="${esc(p.planKey)}">${I.plus} Option</button>
          <button class="btn-ghost prod-copy" data-url="${esc(p.checkoutUrl)}">${I.copy} Link</button>`}
          <button class="btn-ghost prod-edit" data-plan="${esc(p.planKey)}">Edit</button>
          <button class="btn-ghost act-revoke prod-del" data-plan="${esc(p.planKey)}">Delete</button>
        </td>
      </tr>`;
  const rows = products
    .filter((p) => !p.variantOf)
    .map((p) => rowFor(p, false) + products.filter((v) => v.variantOf === p.planKey).map((v) => rowFor(v, true)).join(''))
    .join('');
  return `
    <h2 class="sec-title">Products</h2>
    <section class="panel table-panel">
      <div class="card-head"><div><h3>Products</h3><p class="card-sub">Create and edit everything here. You never need the Stripe dashboard.</p></div>
        <button class="btn-pill" id="prod-new">${I.plus} Add product</button></div>
      <form class="add-member" id="prod-form" hidden>
        <h3 id="pe-title">New product</h3>
        ${productEditorFields()}
        <div class="wiz-actions"><button class="btn-pill" type="submit" id="pe-save">Create product</button>
          <button class="btn-secondary" type="button" id="pe-cancel">Cancel</button></div>
        <p class="field-err" id="err-prod" role="alert"></p>
      </form>
      ${
        products.length
          ? `<div class="table-scroll"><table class="data-table t-products"><thead><tr><th>Product</th><th class="num">Price</th><th>Billing</th><th class="num">Members</th><th class="num">Revenue</th><th>Active</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
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
        <td class="dim">${d.expiresAt ? fmtDUtc(d.expiresAt) : 'Never'}</td>
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
            <input id="dc-amount" type="text" inputmode="decimal" placeholder="20" autocomplete="off" /></label>
        </div>
        <div class="field-row">
          <label class="field"><span class="field-label">Product</span>
            <select id="dc-plan"><option value="">All products</option>${products.filter((p) => !p.variantOf).map((p) => `<option value="${esc(p.planKey)}">${esc(p.name)}</option>`).join('')}</select></label>
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
          ? `<div class="table-scroll"><table class="data-table t-disc"><thead><tr><th>Code</th><th>Discount</th><th>Scope</th><th class="num">Uses</th><th>Expires</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
          : '<div class="empty-chart">No discount codes yet.</div>'
      }
      <p class="field-err" id="err-discounts" role="alert"></p>
    </section>`;
}

// One consistent settings card: title + description on the left of the head
// row, fields below, actions right-aligned in a hairline footer.
function setCard({ id = '', title, sub = '', body = '', foot = '' }) {
  return `<section class="panel set-card"${id ? ` id="${id}"` : ''}>
    <div class="set-head"><h3>${title}</h3>${sub ? `<p class="card-sub">${sub}</p>` : ''}</div>
    ${body}
    ${foot ? `<div class="set-foot">${foot}</div>` : ''}
  </section>`;
}

// ── storefront appearance ─────────────────────────────────────────────────────
// The platform's own tokens, doubling as the "Midnight" preset. Radius 16
// matches .panel in styles.css.
// Mirror of STORE_CATEGORIES in src/services/stores.js — keep in sync.
const STORE_CATS = [
  ['trading', 'Trading'], ['sports', 'Sports picks'], ['crypto', 'Crypto'], ['gaming', 'Gaming'],
  ['fitness', 'Fitness'], ['reselling', 'Reselling'], ['education', 'Education'],
  ['content', 'Content'], ['community', 'Community'], ['other', 'Other'],
];

const THEME_DEFAULTS = { bg: '#0a0a0a', panel: '#101010', text: '#f5f5f4', accent: '#ededed', pay: '#5865f2', radius: 16, font: 'default', bgPreset: '', bgUrl: '', material: 'glass' };

// Mirror of BG_PRESETS in src/lib/theme.js — ids, tones and how each one
// paints its picker thumbnail. `thumb` (an image) covers photo presets and
// stands in for the live cloud shader; css presets thumbnail themselves.
const BG_CATALOG = [
  { id: 'clouds-day', label: 'Clouds · day', tone: 'light', thumb: '/sky-day-tall.jpg', live: true },
  { id: 'clouds-night', label: 'Clouds · night', tone: 'dark', thumb: '/sky-night-tall.jpg', live: true },
  { id: 'sky-day', label: 'Sky · day', tone: 'light', thumb: '/sky-day-tall.jpg' },
  { id: 'sky-night', label: 'Sky · night', tone: 'dark', thumb: '/sky-night-tall.jpg' },
  { id: 'mountains', label: 'Mountains', tone: 'dark', thumb: '/bg/mountains.jpg' },
  { id: 'forest', label: 'Forest', tone: 'dark', thumb: '/bg/forest.jpg' },
  { id: 'dunes', label: 'Dunes', tone: 'dark', thumb: '/bg/dunes.jpg' },
  { id: 'lake', label: 'Lake', tone: 'dark', thumb: '/bg/lake.jpg' },
  { id: 'coast', label: 'Coast', tone: 'dark', thumb: '/bg/coast.jpg' },
  { id: 'meadow', label: 'Meadow', tone: 'light', thumb: '/bg/meadow.jpg' },
  { id: 'canyon', label: 'Canyon', tone: 'dark', thumb: '/bg/canyon.jpg' },
  { id: 'blossom', label: 'Blossom', tone: 'light', thumb: '/bg/blossom.jpg' },
  { id: 'city', label: 'City night', tone: 'dark', thumb: '/bg/city.jpg' },
  { id: 'volcano', label: 'Volcano', tone: 'dark', thumb: '/bg/volcano.jpg' },
  { id: 'cosmos', label: 'Cosmos', tone: 'dark', thumb: '/bg/cosmos.jpg' },
  { id: 'reef', label: 'Reef', tone: 'dark', thumb: '/bg/reef.jpg' },
  { id: 'aurora', label: 'Aurora', tone: 'dark' },
  { id: 'starfield', label: 'Starfield', tone: 'dark' },
  { id: 'fireflies', label: 'Fireflies', tone: 'dark' },
  { id: 'rain', label: 'Rain', tone: 'dark' },
  { id: 'snow', label: 'Snowfall', tone: 'dark' },
  { id: 'ocean', label: 'Deep ocean', tone: 'dark' },
  { id: 'lava', label: 'Lava', tone: 'dark' },
  { id: 'nebula', label: 'Nebula', tone: 'dark' },
  { id: 'synthwave', label: 'Synthwave', tone: 'dark' },
  { id: 'flow', label: 'Color flow', tone: 'dark' },
  { id: 'matrix', label: 'Matrix rain', tone: 'dark' },
  { id: 'hyperspace', label: 'Hyperspace', tone: 'dark' },
  { id: 'thunder', label: 'Thunderstorm', tone: 'dark' },
  { id: 'sakura', label: 'Sakura wind', tone: 'light' },
  { id: 'bubbles', label: 'Bubbles', tone: 'dark' },
  { id: 'confetti', label: 'Confetti', tone: 'dark' },
  { id: 'smoke', label: 'Smoke', tone: 'dark' },
  { id: 'golddust', label: 'Gold dust', tone: 'dark' },
  { id: 'midnight', label: 'Midnight', tone: 'dark' },
  { id: 'denim', label: 'Denim', tone: 'dark' },
  { id: 'royal', label: 'Royal', tone: 'dark' },
  { id: 'emerald', label: 'Emerald', tone: 'dark' },
  { id: 'rose', label: 'Rose', tone: 'dark' },
  { id: 'gold', label: 'Gold', tone: 'dark' },
  { id: 'slate', label: 'Slate', tone: 'dark' },
  { id: 'lavender', label: 'Lavender', tone: 'light' },
  { id: 'mint', label: 'Mint', tone: 'light' },
  { id: 'ember', label: 'Ember', tone: 'dark' },
];
const THEME_PRESETS = [
  ['Midnight', THEME_DEFAULTS],
  ['Ivory', { bg: '#faf9f7', panel: '#ffffff', text: '#161616', accent: '#161616', pay: '#5865f2', radius: 16, font: 'default' }],
  ['Blurple', { bg: '#0b0d1f', panel: '#131735', text: '#eceefc', accent: '#8b96f8', pay: '#5865f2', radius: 16, font: 'default' }],
  ['Emerald', { bg: '#071209', panel: '#0d2012', text: '#e9f6ec', accent: '#22c55e', pay: '#22c55e', radius: 16, font: 'default' }],
  ['Crimson', { bg: '#150a0d', panel: '#231016', text: '#f8ecee', accent: '#ef4466', pay: '#ef4466', radius: 12, font: 'default' }],
  ['Gold', { bg: '#131008', panel: '#211b0e', text: '#f8f3e6', accent: '#f2b03c', pay: '#f2b03c', radius: 8, font: 'serif' }],
];
const THEME_FONT_STACKS = {
  system: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "ui-serif, Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace",
};

// Mirror of themeCss in src/lib/theme.js — the saved theme is rendered by the
// server; this copy only paints the live preview iframe. Keep the two in sync.
function previewThemeCss(t) {
  const inkFor = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return ((((n >> 16) & 255) * 299 + (((n >> 8) & 255)) * 587 + (n & 255) * 114) / 1000) >= 150 ? '#0a0a0a' : '#ffffff';
  };
  const small = Math.min(t.radius, 12);
  const font = THEME_FONT_STACKS[t.font];
  return [
    `body { --bg: ${t.bg}; --panel: ${t.panel}; --panel-hover: color-mix(in srgb, ${t.panel} 92%, ${t.text}); --ink: ${t.text}; --dim: color-mix(in srgb, ${t.text} 58%, ${t.bg}); --edge: color-mix(in srgb, ${t.text} 14%, ${t.panel}); --accent: ${t.accent}; --accent-hot: color-mix(in srgb, ${t.accent} 85%, #ffffff); --edge-selected: ${t.accent}; }`,
    `body { background: ${t.bg}; color: ${t.text}; }`,
    `.pay-btn { background: ${t.pay}; color: ${inkFor(t.pay)}; }`,
    `.pay-btn:hover:not(:disabled) { background: color-mix(in srgb, ${t.pay} 86%, #000000); }`,
    `.checkout .panel, .checkout .order-product, .checkout .order-roles, .checkout .pay-panel, .checkout .order-extra { border-radius: ${t.radius}px; }`,
    `.checkout .pay-btn, .checkout .apply-btn, .checkout .method, .checkout input, .checkout .op-thumb { border-radius: ${small}px; }`,
    font ? `body, .checkout button, .checkout input, .order-title, .op-price, .pay-panel h2 { font-family: ${font}; }` : '',
  ].join('\n');
}

// WCAG-ish relative contrast between two hexes — enough to warn, not certify.
function contrastRatio(a, b) {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function appearanceBody(store) {
  const t = { ...THEME_DEFAULTS, ...(store.theme ?? {}) };
  const ink = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return ((((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000) >= 150 ? '#0a0a0a' : '#ffffff';
  };
  // Each preset is a thumbnail of the checkout itself — bg, card, two text
  // lines and the pay button — so choosing a theme is seeing it, not
  // decoding a color dot.
  const tile = ([name, p]) =>
    `<button type="button" class="th-tile" data-preset="${esc(name)}">
       <span class="th-tile-thumb" style="background:${p.bg}">
         <span class="th-tile-card" style="background:${p.panel};border-radius:${Math.max(3, Math.round(p.radius / 3))}px">
           <span class="th-tile-line" style="background:${p.text}"></span>
           <span class="th-tile-line th-tile-line2" style="background:${p.text}"></span>
           <span class="th-tile-btn" style="background:${p.pay}"></span>
         </span>
       </span>
       <span class="th-tile-name">${esc(name)}<svg class="th-tile-check" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg></span>
     </button>`;
  const sw = (key, label) =>
    `<label class="th-swatch">
       <input type="color" id="th-${key}" value="${esc(t[key])}" aria-label="${label} color" />
       <span class="th-sw-name">${label}</span>
       <code id="th-${key}-hex">${esc(t[key])}</code>
     </label>`;
  const seg = (val, label, stack) =>
    `<button type="button" class="th-seg-btn${t.font === val ? ' active' : ''}" data-font="${val}"${stack ? ` style="font-family:${stack}"` : ''}>${label}</button>`;
  return `
  <div class="th-layout">
    <div class="th-controls">
      <div class="th-block">
        <span class="th-block-lab">Theme</span>
        <div class="th-tiles" role="group" aria-label="Theme presets">${THEME_PRESETS.map(tile).join('')}</div>
      </div>
      <div class="th-block">
        <span class="th-block-lab">Background</span>
        <details class="bgp-dd">
          <summary class="bgp-sum"><span class="bgp-cur" id="bgp-current">None</span><svg class="bgp-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></summary>
          <div class="bgp-pop">
        <div class="bgp-grid" role="group" aria-label="Store background">
          <button type="button" class="bgp" data-bgp=""><span class="bgp-thumb bgp-none">&times;</span><span class="bgp-name">None</span></button>
          ${BG_CATALOG.map((b) =>
            `<button type="button" class="bgp" data-bgp="${b.id}">
               <span class="bgp-thumb">${
                 b.thumb
                   ? `<img src="${b.thumb}" alt="" loading="lazy" />${b.live ? '<span class="bgp-live">LIVE</span>' : ''}`
                   : `<span class="store-bg sbg-thumb" data-bg="${b.id}"><span class="sbg-a"></span><span class="sbg-b"></span><span class="sbg-c"></span></span>`
               }</span>
               <span class="bgp-name">${b.label}</span>
             </button>`).join('')}
        </div>
        <label class="bgp-url-row">
          <span class="th-sw-name">Or import your own — a GIF, image, or MP4/WebM video URL</span>
          <input type="url" id="th-bgurl" placeholder="https://…/background.gif" value="${esc(t.bgUrl ?? '')}" spellcheck="false" />
        </label>
          </div>
        </details>
      </div>
      <div class="th-block">
        <span class="th-block-lab">Material</span>
        <div class="th-seg" id="th-material-seg" role="group" aria-label="Card material" data-value="${esc(t.material ?? 'glass')}">
          <button type="button" class="th-seg-btn${(t.material ?? 'glass') === 'glass' ? ' active' : ''}" data-material="glass">Glass</button>
          <button type="button" class="th-seg-btn${t.material === 'liquid' ? ' active' : ''}" data-material="liquid">Liquid glass</button>
          <button type="button" class="th-seg-btn${t.material === 'solid' ? ' active' : ''}" data-material="solid">Solid</button>
        </div>
        <p class="note-help bgp-mat-note">Material shapes the cards over a background — glassy blur or solid panels. Corners at 0 make the store square.</p>
      </div>
      <div class="th-block">
        <span class="th-block-lab">Colors <span class="th-badge-warn" id="th-contrast" hidden>Low contrast</span></span>
        <div class="th-swatches">
          ${sw('bg', 'Background')}${sw('panel', 'Cards')}${sw('text', 'Text')}${sw('accent', 'Accent')}${sw('pay', 'Pay')}
        </div>
      </div>
      <div class="th-block">
        <span class="th-block-lab">Corners</span>
        <div class="th-range"><input type="range" id="th-radius" min="0" max="24" step="1" value="${t.radius}" aria-label="Corner radius" /><code id="th-radius-out">${t.radius}px</code></div>
      </div>
      <div class="th-block">
        <span class="th-block-lab">Type</span>
        <div class="th-seg" id="th-font-seg" role="group" aria-label="Storefront typeface" data-value="${esc(t.font)}">
          ${seg('default', 'Grotesk', '')}${seg('system', 'System', THEME_FONT_STACKS.system)}${seg('serif', 'Serif', THEME_FONT_STACKS.serif)}${seg('mono', 'Mono', THEME_FONT_STACKS.mono)}
        </div>
      </div>
      <p class="th-note">Everything previews live. Nothing changes for buyers until you save.</p>
      <p class="field-err" id="err-theme" role="alert"></p>
    </div>
    <div class="th-stage">
      ${
        store.status === 'live'
          ? `<div class="th-frame">
               <div class="th-frame-bar"><span class="th-frame-dot"></span><span class="th-frame-dot"></span><span class="th-frame-dot"></span><span class="th-frame-url">${esc(location.host)}/${esc(store.slug)}</span>
                 <div class="th-device" role="group" aria-label="Preview device">
                   <button type="button" class="th-dev-btn" data-device="desktop" aria-label="Desktop preview" title="Desktop"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg></button>
                   <button type="button" class="th-dev-btn" data-device="phone" aria-label="Phone preview" title="Phone"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18.5h2"/></svg></button>
                 </div>
               </div>
               <div class="th-viewport" id="th-viewport">
                 <!-- The STORE page, not ?view=checkout: an owner picking
                      colours and a background was being shown the checkout,
                      so the thing being themed was never the thing on screen. -->
                 <iframe id="th-preview" class="th-preview" src="/${esc(store.slug)}" title="Store preview" loading="lazy"></iframe>
               </div>
             </div>`
          : '<div class="th-stage-empty"><p class="note-help">Publish your store to see the live preview here.</p></div>'
      }
    </div>
  </div>`;
}

function sectionStore(store, link) {
  const linkRow = `<div class="share-row"><code class="share-link">${esc(link)}</code><button class="btn-secondary" id="copy-link">${I.copy} Copy</button><a class="btn-secondary st-open" href="${esc(link)}" target="_blank" rel="noopener">${I.external} Open</a></div>`;
  if (store.isDefault) {
    return `
      <h2 class="sec-title">Store</h2>
      <div class="settings-stack">
      ${setCard({
        title: 'Store link',
        sub: 'This is the platform’s built-in store — its identity comes from the deployment configuration.',
        body: linkRow,
      })}
      </div>`;
  }
  const live = store.status === 'live';
  // The section is long; a jump row up top keeps it navigable, and the
  // store's link — the thing owners come here for — is the first card.
  const subnav = `<nav class="st-subnav" aria-label="Store settings sections">${[
    ['st-card-link', 'Store link'],
    ['st-card-page', 'Store page'],
    ['st-card-theme', 'Appearance'],
    ['st-card-discover', 'Discover'],
  ].map(([id, l]) => `<button type="button" class="st-subnav-btn" data-target="${id}">${l}</button>`).join('')}</nav>`;
  return `
    <h2 class="sec-title">Store</h2>
    ${subnav}
    <div class="settings-stack">
    ${setCard({
      id: 'st-card-link',
      title: 'Store link',
      sub: 'One page with everything you sell — share it anywhere.',
      body: `
        <span class="st-status ${live ? 'live' : 'draft'}"><span class="st-dot"></span>${live ? 'Live — taking payments' : 'Draft — not public yet'}</span>
        ${linkRow}
        <p class="field-help st-products-note">Every product also has its own link — copy it with the Link button on <a href="#/store/${esc(store.slug)}/products">Products</a>.</p>
        <label class="field"><span class="field-label">Custom link</span>
          <div class="slug-row"><span class="slug-prefix">${esc(location.origin)}/</span><input id="st-slug" type="text" maxlength="40" value="${esc(store.slug)}" spellcheck="false" /></div>
          <span class="field-help">Changing the link breaks the old one immediately.</span></label>
        <p class="field-err" id="err-slug" role="alert"></p>`,
      foot: `<button class="btn-secondary" id="st-slug-save">Update link</button>`,
    })}
    ${setCard({
      id: 'st-card-page',
      title: 'Store page',
      sub: 'What buyers see at the top of your store.',
      body: `
        <label class="field"><span class="field-label">Store name</span>
          <input id="st-name" type="text" maxlength="60" value="${esc(store.name)}" /></label>
        <label class="field"><span class="field-label">Description</span>
          <input id="st-desc" type="text" maxlength="500" value="${esc(store.description ?? '')}" placeholder="One or two lines shown under your store name." /></label>
        <label class="field"><span class="field-label">Banner URL</span>
          <input id="st-banner" type="url" value="${esc(store.bannerUrl ?? '')}" placeholder="https://…  (1500×400 works best)" spellcheck="false" /></label>
        <label class="field"><span class="field-label">About</span>
          <textarea id="st-about" rows="4" maxlength="2000" placeholder="Tell buyers what your community offers. Blank lines make paragraphs.">${esc(store.about ?? '')}</textarea></label>
        <div class="field"><span class="field-label">Links</span>
          <div class="st-links">
            ${['discord', 'x', 'youtube', 'instagram', 'tiktok', 'website'].map((k) => `
              <input id="st-link-${k}" type="url" value="${esc(store.links?.[k] ?? '')}" placeholder="${k === 'x' ? 'X (Twitter)' : k[0].toUpperCase() + k.slice(1)} — https://…" spellcheck="false" />`).join('')}
          </div>
          <p class="field-help">Shown as icons on your store page. https:// links only.</p>
        </div>
        <label class="disc-toggle"><input id="st-members" type="checkbox" ${store.showMembers ? 'checked' : ''} />
          Show your live member count on the store page</label>
        <p class="field-err" id="err-store" role="alert"></p>`,
      foot: `<button class="btn-pill" id="st-save">Save changes</button>`,
    })}
    ${setCard({
      id: 'st-card-theme',
      title: 'Appearance',
      sub: 'Make the store yours — colors, corners and type. Buyers see it instantly.',
      body: appearanceBody(store),
      foot: `<span class="appearance-foot"><button class="btn-pill" id="th-save">Save appearance</button>
        <button class="btn-ghost" id="th-reset">Reset to default</button>
        <span class="note-help" id="th-note" role="status"></span></span>`,
    })}
    ${setCard({
      id: 'st-card-discover',
      title: 'Discover listing',
      sub: 'Put your store on dues.gg/discover — the public directory of communities. Off by default; entirely your call.',
      body: `
        <label class="disc-toggle">
          <input type="checkbox" id="dv-on" ${store.discoverable ? 'checked' : ''} />
          <span>List my store on Discover</span>
        </label>
        <label class="field disc-cat-field"><span class="field-label">Category</span>
          <select id="dv-cat" class="store-switch">
            <option value="">Pick one…</option>
            ${STORE_CATS.map(([k, l]) => `<option value="${k}" ${store.category === k ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
        <p class="field-err" id="err-disc" role="alert"></p>`,
      foot: `<button class="btn-secondary" id="dv-save">Save listing</button>`,
    })}
    </div>`;
}

// ── dashboard: this dashboard's OWN look. It used to be called Customize,
// which read as "customize my store" — the store's colours, background, type
// and live preview live under Store. Naming each for what it changes is the
// whole fix.
function sectionCustomize(store) {
  const prefs = store.dashboardPrefs ?? {};
  const cards = { revenue: true, sales: true, members: true, mrr: true, ...(prefs.cards ?? {}) };
  const ACCENTS = [
    ['', 'Default'], ['#5865f2', 'Blurple'], ['#3fb950', 'Green'], ['#f59e0b', 'Amber'],
    ['#ef4444', 'Red'], ['#ec4899', 'Pink'], ['#06b6d4', 'Cyan'],
  ];
  const curAccent = /^#[0-9a-f]{6}$/i.test(String(prefs.accent ?? '')) ? prefs.accent : '';
  return `
    <h2 class="sec-title">Dashboard</h2>
    <div class="settings-stack">
    ${setCard({
      id: 'dash-custom',
      title: 'Appearance',
      sub: 'Your dashboard, your way — saved for this store, on every device.',
      body: `<div class="dc-body">
        <div class="dc-row"><span class="dc-lab">Accent</span>
          <div class="dc-swatches" role="group" aria-label="Dashboard accent color">
            ${ACCENTS.map(([hex, name]) => `<button type="button" class="dc-swatch${curAccent === hex ? ' active' : ''}" data-accent="${hex}" title="${name}" aria-label="${name}" ${hex ? `style="background:${hex}"` : ''}>${hex ? '' : '<span class="dc-none"></span>'}</button>`).join('')}
            <label class="dc-custom" title="Custom color"><input type="color" id="dc-color" value="${curAccent || '#ededed'}" aria-label="Custom accent color" /></label>
          </div>
          <p class="field-help dc-help">Paints every chart, sparkline and highlight in the dashboard.</p></div>
        <div class="dc-row"><span class="dc-lab">Stat cards</span>
          <div class="dc-checks">
            ${[['revenue', 'Revenue'], ['sales', 'Sales'], ['members', 'New members'], ['mrr', 'MRR']]
              .map(([k, lbl]) => `<label class="dc-check"><input type="checkbox" data-card="${k}" ${cards[k] ? 'checked' : ''} />${lbl}</label>`).join('')}
          </div>
          <p class="field-help dc-help">Pick which numbers open the Overview.</p></div>
        <div class="dc-row"><span class="dc-lab">Default period</span>
          <select id="dc-range" class="store-switch">
            ${RANGES.map(([k, lbl]) => `<option value="${k}" ${(prefs.defaultRange ?? '30') === k ? 'selected' : ''}>${lbl}</option>`).join('')}
          </select>
          <p class="field-help dc-help">The range your analytics open on.</p></div>
        <p class="field-err" id="dc-note" role="alert"></p>
      </div>`,
      foot: `<button class="btn-pill" id="dc-save">Save</button>
        <button class="btn-ghost" id="dc-reset">Reset to default</button>`,
    })}
    ${setCard({
      title: 'Storefront',
      sub: 'What buyers see has its own controls — colors, corners and type live in the Store section.',
      body: `<div class="dc-body"><a class="btn-secondary dc-open" href="#/store/${esc(store.slug)}/store">${I.shop} Open store appearance</a></div>`,
    })}
    </div>`;
}

function wireCustomize(store, slug) {
  const prefs = store.dashboardPrefs ?? {};
  let pickedAccent = /^#[0-9a-f]{6}$/i.test(String(prefs.accent ?? '')) ? prefs.accent : '';
  const markSwatch = () => document.querySelectorAll('.dc-swatch').forEach((s) => s.classList.toggle('active', s.dataset.accent === pickedAccent));
  document.querySelectorAll('.dc-swatch').forEach((s) => {
    s.onclick = () => { pickedAccent = s.dataset.accent; markSwatch(); };
  });
  $('#dc-color').oninput = (e) => { pickedAccent = e.target.value.toLowerCase(); markSwatch(); };
  const saveDc = async (prefsBody) => {
    const btn = $('#dc-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    $('#dc-note').textContent = '';
    try {
      await api('/api/admin/store', { store: slug, dashboardPrefs: prefsBody });
      state.data = null;
      viewStore(slug);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Save';
      $('#dc-note').textContent = err.message;
    }
  };
  $('#dc-save').onclick = () => {
    const cardPicks = {};
    document.querySelectorAll('.dc-check input').forEach((c) => { cardPicks[c.dataset.card] = c.checked; });
    saveDc({
      accent: pickedAccent || null,
      cards: cardPicks,
      defaultRange: $('#dc-range').value,
    });
  };
  $('#dc-reset').onclick = () => saveDc(null);
}

// Billing gets its own top-level section so upgrading a plan is one click from
// the sidebar, not buried in Settings. The panel itself is renderBillingPanel().
function sectionBilling() {
  return `
    <h2 class="sec-title">Billing</h2>
    <div class="settings-stack">
    ${setCard({
      id: 'billing-panel',
      title: 'Your Dues plan',
      sub: 'Upgrade, downgrade or cancel anytime. One plan covers every store on your account.',
      body: `<div id="billing-body"><p class="note-help">Loading your plan…</p></div>`,
    })}
    </div>`;
}

function sectionSettings(store, isPlatformOwner) {
  return `
    <h2 class="sec-title">Settings</h2>
    <div class="settings-stack">
    ${
      !store.isDefault
        ? setCard({
            title: 'Payment method',
            sub: 'Payments go straight to your own Stripe account. Paste a new key to rotate it — Stripe checks it before anything is saved.',
            body: `
              <label class="field"><span class="field-label">Stripe API key</span>
                <input id="pm-key" type="password" placeholder="rk_live_…" autocomplete="off" spellcheck="false" /></label>
              ${keyScopesHtml()}
              <p class="field-err" id="err-pm" role="alert"></p>`,
            foot: `<button class="btn-secondary" id="pm-save">Update key</button>`,
          })
        : ''
    }
    ${
      !store.isDefault
        ? setCard({
            title: 'Sale notifications',
            sub: 'Every order is posted to a channel in your server the moment payment clears.',
            body: `
              <label class="field"><span class="field-label">Channel</span>
                <select id="nc-channel"><option value="">Loading channels…</option></select>
                <span class="field-help">The bot needs permission to post there. Off turns them off.</span></label>
              <p class="field-err" id="err-nc" role="alert"></p>`,
            foot: `<button class="btn-secondary" id="nc-save">Save</button>`,
          })
        : ''
    }
    ${/* No receipt-emails card: it said "nothing to configure" and then offered
          nothing to configure. Settings is for decisions, and a panel that
          only announces a behaviour is furniture. Buyers still get their
          confirmation email — see src/services/receipts. */ ''}
    ${
      !store.isDefault
        ? setCard({
            title: 'Danger zone',
            sub: 'Removes this store, its products and its discount codes. A store with payment history cannot be deleted.',
            body: `<p class="field-err" id="err-delete" role="alert"></p>`,
            foot: `<button class="btn-danger" id="store-delete">Delete this store</button>`,
          })
        : ''
    }
    </div>`;
}

// ── store dashboard: main view ───────────────────────────────────────────────

async function viewStore(slug) {
  // Stale-render guard: only the LATEST navigation may commit its render.
  // Without it a slow section fetch resolves after the user has switched
  // sections and overwrites the view they are looking at.
  const seq = (viewStore.seq = (viewStore.seq ?? 0) + 1);
  $('#content').innerHTML = '<div class="skeleton-list" style="margin-top:18px" aria-hidden="true"><div class="panel sk-row"></div><div class="panel sk-row"></div></div>';
  const data = await loadPayments(slug);
  if (seq !== viewStore.seq) return; // a newer navigation owns the view now
  if (!data) {
    $('#content').innerHTML = `
      <div class="picker-wrap"><section class="picker-card panel">
        <p class="note-help" style="text-align:center">This store is not yours to see. Sign in with the owner account, or pick one of your servers.</p>
        <a class="btn-pill" style="align-self:center;text-decoration:none" href="#/">Your servers</a>
      </section></div>`;
    return;
  }
  const store = data.stores.find((s) => s.slug === slug) ?? data.stores[0];
  const link = `${location.origin}/${store.slug}`;
  const section = location.hash.split('/')[3] ?? 'overview';
  // Saved dashboard preferences: the accent recolors every chart and active
  // element through the shell's --accent; the default period applies until
  // the owner picks a range by hand this visit.
  const dashPrefs = store.dashboardPrefs ?? {};
  const dashAccent = /^#[0-9a-f]{6}$/i.test(String(dashPrefs.accent ?? '')) ? dashPrefs.accent : null;
  if (dashPrefs.defaultRange && state.rangePicked !== store.slug && RANGES.some(([k]) => k === dashPrefs.defaultRange)) {
    state.range = dashPrefs.defaultRange;
  }
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
      ? '<h2 class="sec-title">Discounts</h2><section class="panel wiz-panel"><p class="note-help">This is the built-in store. Set up your server’s own store to create discount codes here.</p><a class="btn-pill" style="align-self:flex-start;text-decoration:none" href="#/">Set up your store</a></section>'
      : sectionDiscounts(discounts, products, slug);
  else if (section === 'store') body = sectionStore(store, link);
  else if (section === 'customize')
    body = store.isDefault
      ? '<h2 class="sec-title">Dashboard</h2><section class="panel wiz-panel"><p class="note-help">This is the built-in store — its dashboard uses the platform look. Set up your server’s own store to customize.</p><a class="btn-pill" style="align-self:flex-start;text-decoration:none" href="#/">Set up your store</a></section>'
      : sectionCustomize(store);
  else if (section === 'billing') body = sectionBilling();
  else if (section === 'settings') body = sectionSettings(store, isPlatformOwner);
  else if (section === 'payments') {
    const checkouts = data.checkouts ?? [];
    const ck = data.checkoutTotals ?? { started: 0, completed: 0, abandoned: 0, conversionPct: null };
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
        <div class="table-scroll"><table class="data-table t-pay"><thead><tr><th>Customer</th><th>Product</th><th class="num">Amount</th><th>Status</th><th>Date</th></tr></thead><tbody id="tx-body">${paymentsRows(data.payments)}</tbody></table></div>
        <p class="rows-note" id="tx-count">${data.payments.length} row(s)</p>
      </section>

      <section class="panel table-panel">
        <div class="card-head"><div><h3>Checkouts started</h3><p class="card-sub">Everyone who reached the card form — finished or not.</p></div></div>
        <div class="ck-stats">
          <div class="ck-stat"><span class="ck-num">${ck.started}</span><span class="ck-lab">Started</span></div>
          <div class="ck-stat"><span class="ck-num ck-good">${ck.completed}</span><span class="ck-lab">Paid</span></div>
          <div class="ck-stat"><span class="ck-num ck-warn">${ck.abandoned}</span><span class="ck-lab">Not finished</span></div>
          <div class="ck-stat"><span class="ck-num">${ck.conversionPct === null ? '—' : ck.conversionPct + '%'}</span><span class="ck-lab">Completed</span></div>
        </div>
        <div class="table-tools">
          <label class="search-box">${I.search}<input id="ck-search" type="search" placeholder="Search username, ID or product…" aria-label="Search checkouts" /></label>
          <select id="ck-status" class="store-switch" aria-label="Filter checkouts by status">
            <option value="">Status: all</option><option value="completed">Paid</option><option value="started">Not finished</option>
          </select>
        </div>
        <div class="table-scroll"><table class="data-table t-pay"><thead><tr><th>Customer</th><th>Product</th><th class="num">Amount</th><th>Status</th><th>Started</th><th>Paid</th></tr></thead><tbody id="ck-body">${checkoutRows(checkouts)}</tbody></table></div>
        <p class="rows-note" id="ck-count">${checkouts.length} row(s)</p>
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
            ? `<div class="table-scroll"><table class="data-table t-members"><thead><tr><th>Member</th><th>Products</th><th class="num">Total spent</th><th>Status</th><th></th></tr></thead><tbody>${memberRows}</tbody></table></div>
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

  const navItems = SECTIONS.filter(([k]) => !(store.isDefault && k === 'customize')).map(
    ([k, lbl, ic]) =>
      `<a class="side-item${k === section ? ' active' : ''}" href="#/store/${esc(slug)}/${k}" ${k === section ? 'aria-current="page"' : ''}>${I[ic]}<span>${lbl}</span></a>`,
  ).join('');

  if (seq !== viewStore.seq) return; // section fetches raced a newer navigation
  $('#content').innerHTML = `
    <div class="appshell"${dashAccent ? ` style="--accent:${dashAccent}"` : ''}>
      <aside class="sidebar">
        <div class="side-store"><a class="side-logo" href="#/" aria-label="All servers"><img src="/favicon.png" alt="" width="22" height="22" /></a>${switcher}</div>
        <nav class="side-nav" aria-label="Store sections">${navItems}</nav>
        <div class="side-foot">
          <a class="side-item" href="${esc(link)}" target="_blank" rel="noopener">${I.external}<span>View store</span></a>
          ${state.me?.isOwner ? `<a class="side-item" href="#/admin">${I.gear}<span>Platform admin</span></a>` : ''}
          <a class="side-item" href="#/">${I.back}<span>All servers</span></a>
        </div>
      </aside>
      <div class="app-body">${body}</div>
    </div>`;

  // Phone tab strip: show a right-edge fade only while tabs actually hide
  // off-screen, and drop it at the end of the scroll.
  const sb = document.querySelector('.sidebar');
  if (sb) {
    const updFade = () => sb.classList.toggle('scroll-more', sb.scrollWidth - sb.clientWidth - sb.scrollLeft > 8);
    sb.addEventListener('scroll', updFade, { passive: true });
    addEventListener('resize', updFade, { passive: true });
    updFade();
  }

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
    document.querySelectorAll('#range-seg .seg-btn').forEach((b) => {
      b.onclick = () => {
        state.range = b.dataset.range;
        state.rangePicked = store.slug; // a hand-picked range outranks the saved default
        viewStore(slug);
      };
    });
    const revCard = $('#rev-card');
    if (revCard) wireChartHover(revCard, bucketSeries(data.payments, rangeWindows(state.range, data.payments)));
    renderChecklist(store, slug);
    loadBilling()
      .then((b) => {
        if (!b || b.exempt || b.usage.limit === null || b.usage.members < b.usage.limit) return;
        const el = document.createElement('div');
        el.className = 'limit-banner';
        el.innerHTML = `<strong>Member limit reached</strong> — ${b.usage.members} of ${b.usage.limit} on the ${esc(b.current.name)} plan. New checkouts are paused. <a href="#/store/${esc(slug)}/billing">Upgrade your plan</a>`;
        document.querySelector('.app-body')?.prepend(el);
      })
      .catch(() => {});
  }

  if (section === 'payments') {
    // Checkouts share the section but not the filter — a completed checkout
    // and an active membership are different questions.
    const ckList = data.checkouts ?? [];
    const ckFiltered = () => {
      const q = ($('#ck-search').value ?? '').trim().toLowerCase();
      const st = $('#ck-status').value;
      return ckList.filter((c) => {
        const hitQ = !q || (c.username ?? '').toLowerCase().includes(q) || c.discordId.includes(q) || c.planName.toLowerCase().includes(q);
        return hitQ && (!st || c.status === st);
      });
    };
    const ckApply = () => {
      const list = ckFiltered();
      $('#ck-body').innerHTML = checkoutRows(list);
      $('#ck-count').textContent = `${list.length} row(s)`;
    };
    $('#ck-search').addEventListener('input', ckApply);
    $('#ck-status').addEventListener('change', ckApply);

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
      // Quote every cell AND neutralize spreadsheet formula injection: a value
      // that starts with = + - @ or a control char (e.g. a buyer username the
      // buyer chose) would otherwise run as a formula when the CSV is opened in
      // Excel/Sheets. Prefixing a single quote makes the cell inert text.
      const cell = (v) => {
        let s = String(v ?? '');
        if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
        return `"${s.replace(/"/g, '""')}"`;
      };
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
  if (section === 'store' && !store.isDefault) { wireStoreSettings(store, slug); wireAppearance(store, slug); wireDiscovery(store, slug); }
  if (section === 'customize' && !store.isDefault) wireCustomize(store, slug);
  if (section === 'billing') renderBillingPanel();
  if (section === 'settings') {
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
    wireReceiptSettings(store, slug);
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

// Products section wiring: create, edit (role picked right in the form),
// toggle, copy, delete.
function wireProducts(store, slug, products) {
  const form = $('#prod-form');
  let editing = null; // planKey when editing
  let rolesLoaded = false; // false = never loaded, null = load failed
  let rolesData = null;

  // The role select lives inside the form: the guild's roles load once per
  // section render, unusable ones stay visible but disabled with the reason.
  const fillRoles = async (selectedId, gateRoleId) => {
    const sel = form.querySelector('.pe-role');
    const help = form.querySelector('.pe-role-help');
    if (rolesLoaded === false) {
      try {
        rolesData = await api('/api/onboard', { step: 'roles', storeId: store.id });
        rolesLoaded = true;
      } catch (err) {
        rolesLoaded = null;
        sel.innerHTML = `<option value="">Couldn’t load roles</option>`;
        help.textContent = `${err.message} — invite the Dues bot to your server, then reopen this form. You can still save the product and attach its role later.`;
        return;
      }
    }
    if (rolesLoaded === null) return;
    const data = rolesData;
    sel.innerHTML =
      `<option value="">— pick a role —</option>` +
      data.roles
        .map((r) =>
          r.usable
            ? `<option value="${esc(r.id)}">${esc(roleLabel(r.name))}</option>`
            : `<option value="" disabled>${esc(roleLabel(r.name))} — ${esc(r.reason ?? 'unavailable')}</option>`,
        )
        .join('');
    if (selectedId && data.roles.some((r) => r.id === selectedId && r.usable)) sel.value = selectedId;
    help.textContent = `Buyers get this Discord role the moment payment clears. Greyed roles sit at or above the bot’s top role “${data.botTop.name}”.`;
    // The purchase gate accepts ANY role — the bot only reads it, so even
    // roles above the bot work here.
    const gate = form.querySelector('.pe-gate');
    if (gate) {
      gate.innerHTML =
        '<option value="">Everyone</option>' +
        data.roles.map((r) => `<option value="${esc(r.id)}">${esc(roleLabel(r.name))} only</option>`).join('');
      if (gateRoleId && data.roles.some((r) => r.id === gateRoleId)) gate.value = gateRoleId;
    }
  };

  let optionParent = null; // set = the form is adding a pricing option to that product
  const openForm = (p = null, forOptionOf = null) => {
    editing = p?.planKey ?? null;
    optionParent = forOptionOf;
    form.hidden = false;
    // Option modes strip the form down to what an option IS — a label, a
    // price and a cadence. Photo, description, link, role and limit belong
    // to the product and are inherited.
    const optMode = Boolean(forOptionOf || p?.variantOf);
    for (const sel of ['.pe-desc', '.pe-limit', '.pe-role', '.pe-link', '.pe-success', '.pe-expires', '.pe-gate']) {
      const box = form.querySelector(sel)?.closest('label.field, .field');
      if (box) box.hidden = optMode;
    }
    const photoBox = form.querySelector('.pe-photo-btn')?.closest('.field');
    if (photoBox) photoBox.hidden = optMode;
    // The options repeater exists for CREATE-a-product only.
    const optsBlock = form.querySelector('.pe-opts-block');
    if (optsBlock) {
      optsBlock.hidden = Boolean(p) || optMode;
      if (!p && !optMode) form.querySelector('.pe-opts').innerHTML = '';
    }
    $('#pe-title').textContent = forOptionOf
      ? `New option — ${forOptionOf.name}`
      : p
        ? (p.variantOf ? `Edit option — ${p.name}` : `Edit — ${p.name}`)
        : 'New product';
    $('#pe-save').textContent = forOptionOf ? 'Add option' : p ? 'Save changes' : 'Create product';
    form.querySelector('.pe-name').value = p?.name ?? '';
    form.querySelector('.pe-price').value = p?.priceUsd ?? '';
    form.querySelector('.pe-desc').value = p?.description ?? '';
    form.querySelector('.pe-billing').value = p && !p.lifetime ? 'month' : 'lifetime';
    form.querySelector('.pe-limit').value = p?.purchaseLimit ?? '';
    form.querySelector('.pe-img').value = p?.imageUrl ?? '';
    form.querySelector('.pe-success').value = p?.successUrl ?? '';
    const linkField = form.querySelector('.pe-link');
    linkField.value = p?.linkSlug ?? '';
    // The placeholder doubles as the default: this product's own plan key.
    linkField.placeholder = `${p?.planKey ?? 'vip'}  (its own URL: /your-store/this)`;
    form.querySelector('.pe-expires').value = p?.expiresAt ? new Date(p.expiresAt * 1000).toISOString().slice(0, 10) : '';
    fillRoles(p?.roleIds?.[0], p?.requiredRoleId ?? null);
    // photo picker state: undefined = untouched, string = new upload, null = removed
    photoPick = undefined;
    const prev = form.querySelector('.pe-photo-prev');
    prev.src = p?.imageUrl ?? '';
    prev.hidden = !p?.imageUrl;
    form.querySelector('.pe-photo-clear').hidden = !p?.imageUrl;
    form.querySelector('.pe-photo-file').value = '';
    form.scrollIntoView({ block: 'nearest' });
  };
  let photoPick;
  form.querySelector('.pe-photo-btn').onclick = () => form.querySelector('.pe-photo-file').click();
  form.querySelector('.pe-photo-file').onchange = () => {
    fieldErr('prod', '');
    readPhoto(
      form.querySelector('.pe-photo-file').files[0],
      (data) => {
        photoPick = data;
        const prev = form.querySelector('.pe-photo-prev');
        if (data.startsWith('data:video/')) {
          prev.hidden = true;
        } else {
          prev.src = data;
          prev.hidden = false;
        }
        form.querySelector('.pe-photo-clear').hidden = false;
      },
      (msg) => fieldErr('prod', msg),
    );
  };
  form.querySelector('.pe-photo-clear').onclick = () => {
    photoPick = null;
    form.querySelector('.pe-photo-file').value = '';
    form.querySelector('.pe-photo-prev').hidden = true;
    form.querySelector('.pe-photo-clear').hidden = true;
    form.querySelector('.pe-img').value = '';
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
      ...(photoPick !== undefined ? { imageData: photoPick } : {}),
      successUrl: form.querySelector('.pe-success').value.trim(),
      linkSlug: form.querySelector('.pe-link').value.trim().toLowerCase(),
      priceUsd: parsePrice(form.querySelector('.pe-price').value),
      lifetime: form.querySelector('.pe-billing').value === 'lifetime',
      purchaseLimit: form.querySelector('.pe-limit').value.trim() || null,
      expiresAt: form.querySelector('.pe-expires').value || null,
      requiredRoleId: form.querySelector('.pe-gate').value || null,
    };
    if (!fields.name) return fieldErr('prod', optionParent || products.find((x) => x.planKey === editing)?.variantOf ? 'Label the option — e.g. Monthly.' : 'Name your product.');
    if (!Number.isFinite(fields.priceUsd) || fields.priceUsd < 1) return fieldErr('prod', 'Set a price of at least $1 — e.g. 59.99');
    const btnEl = $('#pe-save');
    // Adding a pricing option to an existing product: one call, done.
    if (optionParent) {
      btnEl.disabled = true;
      btnEl.textContent = 'Saving…';
      try {
        await api('/api/onboard', {
          step: 'variant', storeId: store.id, planKey: optionParent.planKey,
          label: fields.name, priceUsd: fields.priceUsd, lifetime: fields.lifetime,
        });
        state.products = null;
        state.data = null;
        form.hidden = true;
        viewStore(slug);
      } catch (err) {
        btnEl.disabled = false;
        btnEl.textContent = 'Add option';
        fieldErr('prod', err.message);
      }
      return;
    }
    // Editing a pricing option: only its label, price and cadence are its own.
    const editingRow = editing ? products.find((x) => x.planKey === editing) : null;
    if (editingRow?.variantOf) {
      btnEl.disabled = true;
      btnEl.textContent = 'Saving…';
      try {
        await api('/api/onboard', {
          step: 'product-update', storeId: store.id, planKey: editing,
          name: fields.name, priceUsd: fields.priceUsd, lifetime: fields.lifetime,
        });
        state.products = null;
        state.data = null;
        form.hidden = true;
        viewStore(slug);
      } catch (err) {
        btnEl.disabled = false;
        btnEl.textContent = 'Save changes';
        fieldErr('prod', err.message);
      }
      return;
    }
    const roleId = form.querySelector('.pe-role').value;
    // A product that grants nothing sells nothing — require the role
    // whenever the list actually loaded (if it didn't, the product can
    // still be saved and the role attached once the bot is in the server).
    // An EXISTING product keeps its current role when none is picked — the
    // select can't preselect a role that became unusable (bot dragged below
    // it), and that must not block editing every other field.
    const keepsRole = editing && products.find((x) => x.planKey === editing)?.roleIds?.length;
    if (!roleId && rolesLoaded === true && !keepsRole) return fieldErr('prod', 'Pick the role this product gives.');
    const btn = $('#pe-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      let planKey = editing;
      if (editing) {
        // Unchanged expiry/gate stay OUT of the payload — an already-ended
        // product must stay editable (re-sending its past date would trip
        // the future-only validation on every unrelated save).
        const payload = { ...fields };
        const cur = products.find((x) => x.planKey === editing);
        const curDate = cur?.expiresAt ? new Date(cur.expiresAt * 1000).toISOString().slice(0, 10) : null;
        if ((payload.expiresAt ?? null) === curDate) delete payload.expiresAt;
        if ((payload.requiredRoleId ?? null) === (cur?.requiredRoleId ?? null)) delete payload.requiredRoleId;
        await api('/api/onboard', { step: 'product-update', storeId: store.id, planKey: editing, ...payload });
      } else {
        const out = await api('/api/onboard', { step: 'product', storeId: store.id, ...fields });
        planKey = out.plan.planKey;
        // From here on a retry must EDIT this product, never create a twin.
        editing = planKey;
        // apply the optional extras the create step doesn't take — a
        // rejection here must SURFACE (the product exists; the form stays
        // open in edit mode so the owner fixes the field and saves again),
        // never silently discard what was typed.
        if (fields.purchaseLimit !== undefined || fields.successUrl || fields.linkSlug || fields.expiresAt || fields.requiredRoleId) {
          try {
            await api('/api/onboard', {
              step: 'product-update', storeId: store.id, planKey,
              purchaseLimit: fields.purchaseLimit, successUrl: fields.successUrl, linkSlug: fields.linkSlug,
              expiresAt: fields.expiresAt, requiredRoleId: fields.requiredRoleId,
            });
          } catch (err) {
            state.products = null;
            state.data = null;
            fieldErr('prod', `Product created, but not everything saved: ${err.message} Fix the field and Save again.`);
            throw { handled: true };
          }
        }
      }
      // The product EXISTS now — drop the caches immediately so the next
      // Products render shows it even if the role attach below fails.
      state.products = null;
      state.data = null;
      const prevRole = editing ? products.find((x) => x.planKey === editing)?.roleIds?.[0] : null;
      if (roleId && roleId !== prevRole) {
        await api('/api/onboard', { step: 'role', storeId: store.id, planKey, roleId }).catch((err) => {
          fieldErr('prod', `Product saved, but the role could not be attached: ${err.message}`);
          throw { handled: true };
        });
      }
      // Extra pricing options typed into the create form — one call each. A
      // failure surfaces with the product already created (the form is in
      // edit mode by now, so a retry never duplicates the product).
      for (const row of form.querySelectorAll('.pe-opt-row')) {
        const label = row.querySelector('.po-label').value.trim();
        const priceUsd = parsePrice(row.querySelector('.po-price').value);
        if (!label && !row.querySelector('.po-price').value.trim()) continue; // untouched row
        if (!Number.isFinite(priceUsd) || priceUsd < 1) {
          fieldErr('prod', `Product created, but the "${label || 'option'}" price needs to be at least $1 — fix it and use + Option on the product row.`);
          throw { handled: true };
        }
        await api('/api/onboard', {
          step: 'variant', storeId: store.id, planKey,
          label, priceUsd, lifetime: row.querySelector('.po-billing').value === 'lifetime',
        }).catch((err) => {
          fieldErr('prod', `Product created, but the "${label || 'option'}" option failed: ${err.message} Add it with + Option on the product row.`);
          throw { handled: true };
        });
      }
      form.hidden = true;
      viewStore(slug);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = editing ? 'Save changes' : 'Create product';
      if (!err?.handled) fieldErr('prod', err.message);
    }
  };

  // Options repeater on the create form.
  form.querySelector('.pe-opt-add')?.addEventListener('click', () => {
    form.querySelector('.pe-opts').insertAdjacentHTML('beforeend', optionRowHtml());
  });
  form.querySelector('.pe-opts')?.addEventListener('click', (e) => {
    if (e.target.closest('.po-remove')) e.target.closest('.pe-opt-row').remove();
  });

  document.querySelectorAll('.prod-edit').forEach((b) => {
    b.onclick = () => openForm(products.find((p) => p.planKey === b.dataset.plan));
  });
  document.querySelectorAll('.prod-opt').forEach((b) => {
    b.onclick = () => openForm(null, products.find((p) => p.planKey === b.dataset.plan));
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
      const kids = products.filter((x) => x.variantOf === b.dataset.plan);
      const extra = kids.length ? ` Its ${kids.length} pricing option${kids.length === 1 ? '' : 's'} go with it.` : '';
      if (!confirm(`Delete "${p?.name ?? b.dataset.plan}"?\n\nBuyers keep what they already bought; the product just stops being sold.${extra}`)) return;
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
        amount: parsePrice($('#dc-amount').value),
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

function wireAppearance(store, slug) {
  const read = () => ({
    bg: $('#th-bg').value,
    panel: $('#th-panel').value,
    text: $('#th-text').value,
    accent: $('#th-accent').value,
    pay: $('#th-pay').value,
    radius: Number($('#th-radius').value),
    font: $('#th-font-seg')?.dataset.value ?? 'default',
    bgPreset: draftBg,
    bgUrl: ($('#th-bgurl')?.value ?? '').trim(),
    material: $('#th-material-seg')?.dataset.value ?? 'glass',
  });
  // The background the picker currently has selected ('' = none). Seeded from
  // the saved theme; clicks update it.
  let draftBg = store.theme?.bgPreset ?? '';
  // Paint the draft background into the same-origin preview frame. Media
  // elements are built with createElement — an owner-typed URL never becomes
  // markup. Live cloud presets preview as their still (no shader in a frame).
  const applyPreviewBg = (doc, t) => {
    doc.getElementById('store-bg-preview')?.remove();
    doc.querySelector('.store-bg')?.remove(); // the saved layer must not fight the draft
    const body = doc.body;
    const custom = t.bgUrl;
    const preset = !custom && t.bgPreset ? t.bgPreset : null;
    body.classList.remove('has-bg');
    delete body.dataset.bg;
    delete body.dataset.material;
    if (!custom && !preset) {
      doc.documentElement.removeAttribute('data-theme');
      return;
    }
    const def = BG_CATALOG.find((b) => b.id === preset);
    const id = preset ?? 'custom';
    const el = doc.createElement('div');
    el.id = 'store-bg-preview';
    el.className = 'store-bg';
    el.dataset.bg = id;
    el.setAttribute('aria-hidden', 'true');
    if (custom) {
      const isVideo = /\.(mp4|webm)(\?|#|$)/i.test(custom);
      const media = doc.createElement(isVideo ? 'video' : 'img');
      media.src = custom;
      if (isVideo) {
        media.muted = true;
        media.autoplay = true;
        media.loop = true;
        media.playsInline = true;
      } else {
        media.alt = '';
      }
      el.appendChild(media);
    } else if (def?.thumb) {
      const img = doc.createElement('img');
      img.src = def.thumb;
      img.alt = '';
      el.appendChild(img);
    } else {
      for (const cls of ['sbg-a', 'sbg-b', 'sbg-c']) {
        const span = doc.createElement('span');
        span.className = cls;
        el.appendChild(span);
      }
    }
    body.prepend(el);
    body.classList.add('has-bg');
    body.dataset.bg = id;
    body.dataset.material = t.material || 'glass';
    if (def?.tone === 'light') doc.documentElement.setAttribute('data-theme', 'light');
    else doc.documentElement.removeAttribute('data-theme');
  };
  const paint = () => {
    const t = read();
    for (const k of ['bg', 'panel', 'text', 'accent', 'pay']) $(`#th-${k}-hex`).textContent = t[k];
    document.querySelectorAll('.th-tile').forEach((b) => {
      const p = THEME_PRESETS.find(([n]) => n === b.dataset.preset)?.[1];
      b.classList.toggle('active', Boolean(p) && ['bg', 'panel', 'text', 'accent', 'pay'].every((k) => p[k] === t[k]) && p.radius === t.radius && p.font === t.font);
    });
    $('#th-radius-out').textContent = `${t.radius}px`;
    const warn = $('#th-contrast');
    if (warn) warn.hidden = contrastRatio(t.text, t.panel) >= 4.5;
    const frame = $('#th-preview');
    // Same-origin, so the preview styles the real page directly. If the
    // frame has not loaded yet, the load handler below repaints.
    try {
      const doc = frame?.contentDocument;
      if (doc?.body) {
        let el = doc.getElementById('theme-preview');
        if (!el) {
          el = doc.createElement('style');
          el.id = 'theme-preview';
          doc.head.appendChild(el);
        }
        el.textContent = previewThemeCss(t);
        doc.getElementById('store-theme')?.remove(); // the saved theme must not fight the draft
        applyPreviewBg(doc, t);
      }
    } catch { /* frame not ready yet */ }
    document.querySelectorAll('.bgp').forEach((b) => {
      b.classList.toggle('active', t.bgUrl ? false : (b.dataset.bgp ?? '') === (t.bgPreset ?? ''));
    });
    const cur = $('#bgp-current');
    if (cur) {
      const def = BG_CATALOG.find((b) => b.id === t.bgPreset);
      if (t.bgUrl) cur.innerHTML = '<span class="bgp-cur-thumb bgp-none">&#9654;</span><b>Custom import</b>';
      else if (!def) cur.innerHTML = '<span class="bgp-cur-thumb bgp-none">&times;</span><b>None</b>';
      else cur.innerHTML = (def.thumb
        ? `<span class="bgp-cur-thumb"><img src="${def.thumb}" alt="" /></span>`
        : `<span class="bgp-cur-thumb"><span class="store-bg sbg-thumb" data-bg="${def.id}"><span class="sbg-a"></span><span class="sbg-b"></span><span class="sbg-c"></span></span></span>`)
        + `<b>${def.label}</b>`;
    }
  };
  for (const id of ['th-bg', 'th-panel', 'th-text', 'th-accent', 'th-pay', 'th-radius']) {
    $(`#${id}`)?.addEventListener('input', paint);
    $(`#${id}`)?.addEventListener('change', paint);
  }
  $('#th-preview')?.addEventListener('load', paint);

  // The preview renders the page at a real viewport width and scales it to
  // fit the frame — an iframe left at the frame's own width is neither a
  // phone nor a desktop, just a cramped in-between.
  const DEVICE_W = { desktop: 1180, phone: 390 };
  let device = 'desktop';
  const fit = () => {
    const vp = $('#th-viewport');
    const frame = $('#th-preview');
    if (!vp || !frame) return;
    const w = DEVICE_W[device];
    const avail = vp.clientWidth;
    if (!avail) return;
    const scale = Math.min(1, avail / w);
    vp.classList.toggle('phone', device === 'phone');
    // phone gets a portrait window; desktop keeps the frame's CSS height
    vp.style.height = device === 'phone' ? `${Math.round(w * scale * 1.7)}px` : '';
    const h = vp.clientHeight;
    frame.style.width = `${w}px`;
    frame.style.height = `${Math.round(h / scale)}px`;
    frame.style.transform = `scale(${scale})`;
    frame.style.left = `${Math.max(0, Math.round((avail - w * scale) / 2))}px`;
  };
  document.querySelectorAll('.th-dev-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.device === device);
    b.onclick = () => {
      device = b.dataset.device;
      document.querySelectorAll('.th-dev-btn').forEach((x) => x.classList.toggle('active', x === b));
      fit();
    };
  });
  if ($('#th-viewport')) {
    new ResizeObserver(() => fit()).observe($('#th-viewport'));
    fit();
  }
  document.querySelectorAll('#th-font-seg .th-seg-btn').forEach((b) => {
    b.onclick = () => {
      $('#th-font-seg').dataset.value = b.dataset.font;
      document.querySelectorAll('#th-font-seg .th-seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      paint();
    };
  });
  document.querySelectorAll('.th-tile').forEach((b) => {
    b.onclick = () => {
      const p = THEME_PRESETS.find(([n]) => n === b.dataset.preset)?.[1];
      if (!p) return;
      for (const k of ['bg', 'panel', 'text', 'accent', 'pay']) $(`#th-${k}`).value = p[k];
      $('#th-radius').value = p.radius;
      $('#th-font-seg').dataset.value = p.font;
      document.querySelectorAll('#th-font-seg .th-seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.font === p.font));
      paint();
    };
  });
  document.querySelectorAll('.bgp').forEach((b) => {
    b.onclick = () => {
      draftBg = b.dataset.bgp ?? '';
      if (draftBg && $('#th-bgurl')) $('#th-bgurl').value = ''; // a preset replaces a custom import
      paint();
    };
  });
  $('#th-bgurl')?.addEventListener('input', () => {
    if (($('#th-bgurl').value ?? '').trim()) draftBg = '';
    paint();
  });
  document.querySelectorAll('#th-material-seg .th-seg-btn').forEach((b) => {
    b.onclick = () => {
      $('#th-material-seg').dataset.value = b.dataset.material;
      document.querySelectorAll('#th-material-seg .th-seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      paint();
    };
  });
  paint();

  $('#th-save').onclick = async () => {
    const btn = $('#th-save');
    fieldErr('theme', '');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await api('/api/admin/store', { store: slug, theme: read() });
      state.data = null;
      viewStore(slug);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Save appearance';
      fieldErr('theme', err.message);
    }
  };
  $('#th-reset').onclick = async () => {
    if (!confirm('Reset the store to the default Dues look?')) return;
    try {
      await api('/api/admin/store', { store: slug, theme: null });
      state.data = null;
      viewStore(slug);
    } catch (err) {
      fieldErr('theme', err.message);
    }
  };
}

function wireDiscovery(store, slug) {
  $('#dv-save').onclick = async () => {
    const btn = $('#dv-save');
    const on = $('#dv-on').checked;
    const cat = $('#dv-cat').value;
    fieldErr('disc', '');
    if (on && !cat) return fieldErr('disc', 'Pick a category so people can find you.');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await api('/api/admin/store', { store: slug, discoverable: on, category: cat || null });
      state.data = null;
      viewStore(slug);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Save listing';
      fieldErr('disc', err.message);
    }
  };
}

function wireStoreSettings(store, slug) {
  // Jump row: buttons, not anchors — a #fragment href would fight the hash
  // router. Scroll is computed, not scrollIntoView: the global
  // scroll-padding (sized for the home page's sticky nav) would park the
  // card far below the top of this header-scrolls-away page. Focus moves
  // with the jump so Tab continues from the card, and smooth motion honors
  // reduced-motion.
  const smoothOK = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Same right-edge fade the phone tab strip uses, while tabs hide off-screen.
  const subnavEl = document.querySelector('.st-subnav');
  if (subnavEl) {
    const updFade = () => subnavEl.classList.toggle('scroll-more', subnavEl.scrollWidth - subnavEl.clientWidth - subnavEl.scrollLeft > 8);
    subnavEl.addEventListener('scroll', updFade, { passive: true });
    addEventListener('resize', updFade, { passive: true });
    updFade();
  }
  const navBtns = [...document.querySelectorAll('.st-subnav-btn')];
  const setActiveTab = (id) => navBtns.forEach((x) => x.classList.toggle('active', x.dataset.target === id));
  navBtns.forEach((b) => {
    b.onclick = () => {
      const el = document.getElementById(b.dataset.target);
      if (!el) return;
      setActiveTab(b.dataset.target);
      el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
      scrollTo({ top: el.getBoundingClientRect().top + scrollY - 16, behavior: smoothOK ? 'smooth' : 'instant' });
    };
  });
  if (navBtns.length) {
    // Scroll-spy: the last card whose top crossed the upper third owns the
    // highlight; at the very bottom the last card wins even when it is too
    // short to reach that line. One listener at a time across re-renders.
    const cards = navBtns.map((x) => document.getElementById(x.dataset.target)).filter(Boolean);
    const spy = () => {
      if (!cards[0]?.isConnected) return;
      let cur = cards[0].id;
      const line = innerHeight * 0.35;
      for (const c of cards) if (c.getBoundingClientRect().top <= line) cur = c.id;
      if (scrollY + innerHeight >= document.documentElement.scrollHeight - 4) cur = cards[cards.length - 1].id;
      setActiveTab(cur);
    };
    if (window.__stSpyFn) removeEventListener('scroll', window.__stSpyFn);
    let spyRaf = 0;
    window.__stSpyFn = () => { if (!spyRaf) spyRaf = requestAnimationFrame(() => { spyRaf = 0; spy(); }); };
    addEventListener('scroll', window.__stSpyFn, { passive: true });
    spy();
  }
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
        about: $('#st-about').value,
        links: Object.fromEntries(['discord', 'x', 'youtube', 'instagram', 'tiktok', 'website'].map((k) => [k, $(`#st-link-${k}`).value])),
        showMembers: $('#st-members').checked,
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
    if (!confirm(`Change your store link to ${location.origin}/${slugNew}?\n\nThe old link stops working immediately.`)) return;
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

// Receipts are platform-run and always on — nothing to wire in Settings any
// more. The API for rotating the platform Resend key still exists for
// machine use; it just has no owner-facing UI.
// Sale notifications: pick the channel every order gets posted to. The
// server validates the pick and posts a test message before saving.
async function wireSaleNotifications(store, slug) {
  const sel = $('#nc-channel');
  const save = $('#nc-save');
  if (!sel || !save) return;
  save.onclick = async () => {
    fieldErr('nc', '');
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      await api('/api/admin/store', { store: slug, notifyChannelId: sel.value || null });
      state.data = null;
      save.textContent = sel.value ? 'Saved — check the channel' : 'Saved';
      setTimeout(() => { save.disabled = false; save.textContent = 'Save'; }, 1800);
    } catch (err) {
      save.disabled = false;
      save.textContent = 'Save';
      fieldErr('nc', err.message);
    }
  };
  try {
    const { channels } = await api('/api/onboard', { step: 'channels', storeId: store.id });
    sel.innerHTML =
      `<option value="">Off — no notifications</option>` +
      channels.map((c) => `<option value="${esc(c.id)}">#${esc(c.name)}</option>`).join('');
    if (store.notifyChannelId && channels.some((c) => c.id === store.notifyChannelId)) sel.value = store.notifyChannelId;
  } catch (err) {
    sel.innerHTML = `<option value="">Couldn’t load channels</option>`;
    fieldErr('nc', err.message);
  }
}

function wireReceiptSettings(store, slug) {
  wireSaleNotifications(store, slug);
  const del = $('#store-delete');
  if (!del) return;
  del.onclick = async () => {
    if (!confirm(`Delete the store “${store.name}”?\n\nIts products and discount codes are removed and ${location.origin}/${store.slug} stops working. This cannot be undone.`)) return;
    del.disabled = true;
    del.textContent = 'Deleting…';
    try {
      await api('/api/admin/store', { store: slug, action: 'delete' });
      state.data = null;
      state.products = null;
      location.hash = '#/';
    } catch (err) {
      del.disabled = false;
      del.textContent = 'Delete this store';
      fieldErr('delete', err.message);
    }
  };
}

// The Dues-plan card on Settings: usage meter + tier grid, wired to
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
  const yearly = state.billInterval === 'year';
  el.innerHTML = `
    <p class="note-help">Free covers your first 10 paying members. One plan covers every store on your account.${
      over ? ' <strong>You are at your limit — new checkouts are paused until you upgrade.</strong>' : ''
    }</p>
    <div class="usage-row"><span class="usage-nums">${b.usage.members} of ${b.usage.limit ?? 'unlimited'} members</span>
      ${b.usage.limit ? `<div class="usage-bar${over ? ' over' : ''}" role="img" aria-label="${pct}% of member limit used"><span style="width:${pct}%"></span></div>` : ''}
    </div>
    <div class="bill-toggle" role="group" aria-label="Billing interval">
      <button type="button" class="seg-btn bp-m${yearly ? '' : ' active'}">Monthly</button>
      <button type="button" class="seg-btn bp-y${yearly ? ' active' : ''}">Yearly</button>
      <span class="bt-free">2 months free<br /><span>on yearly plans</span></span>
    </div>
    <div class="tier-grid">
      ${b.tiers
        .map((t) => {
          const current = t.id === b.current.tier;
          const price = yearly ? (t.yearlyUsd ?? t.priceUsd * 10) : t.priceUsd;
          const btn = current
            ? '<button class="btn-secondary" disabled>Current plan</button>'
            : t.priceUsd > 0
              ? `<button class="btn-pill tier-buy" data-tier="${esc(t.id)}">Upgrade</button>`
              : '<span class="tier-cap dim">Default</span>';
          return `<div class="tier-card${current ? ' current' : ''}">
            <span class="tier-name">${esc(t.name)}</span>
            <span class="tier-price">$${price % 1 === 0 ? price : price.toFixed(2)}<span class="tier-per">/${yearly ? 'yr' : 'mo'}</span></span>
            <span class="tier-cap">${t.maxMembers === null ? 'Unlimited members' : `Up to ${t.maxMembers} members`}</span>
            ${btn}
          </div>`;
        })
        .join('')}
    </div>
    ${b.current.tier !== 'free' ? '<button class="btn-ghost" id="cancel-plan">Cancel plan — back to Free</button>' : ''}
    <p class="field-err" id="err-billing" role="alert"></p>`;
  el.querySelector('.bp-m').onclick = () => {
    state.billInterval = 'month';
    renderBillingPanel();
  };
  el.querySelector('.bp-y').onclick = () => {
    state.billInterval = 'year';
    renderBillingPanel();
  };
  document.querySelectorAll('.tier-buy').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Opening Stripe…';
      try {
        const out = await api('/api/billing', { action: 'checkout', tier: btn.dataset.tier, interval: state.billInterval === 'year' ? 'year' : 'month' });
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
      if (!confirm('Cancel your Dues plan?\n\nYour stores drop back to the Free limit (10 members). Existing members keep their roles.')) return;
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
  if (parts[0] === 'admin') return viewAdmin();
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
    t.textContent = 'Payment received — your Dues plan is being activated.';
    document.body.append(t);
    setTimeout(() => t.remove(), 6000);
  }
  await loadMe().catch(() => (state.me = { loggedIn: false }));
  renderNav();
  await route();
})().catch(() => {
  $('#content').innerHTML = '<section class="panel sub-card"><p class="note-help">Could not load the dashboard — refresh to try again.</p></section>';
});
