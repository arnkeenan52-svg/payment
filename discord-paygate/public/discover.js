// The directory lists stores that price in different currencies, so a bare $
// on every card is simply wrong for most of them. Intl carries each currency's
// symbol and decimal count; the zero-decimal set is the one thing it needs told.
const DISC_ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'vnd', 'vuv', 'xaf', 'xof', 'xpf', 'isk', 'ugx']);
const fmtFrom = (amount, cur) => {
  const c = String(cur ?? 'usd').toLowerCase();
  const dp = DISC_ZERO_DECIMAL.has(c) ? 0 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: c.toUpperCase(),
      minimumFractionDigits: dp, maximumFractionDigits: dp,
    }).format(Number(amount));
  } catch {
    return `${c.toUpperCase()} ${Number(amount).toFixed(dp)}`;
  }
};

// /discover — the public directory. Opt-in stores only; every number on a
// card is real (live members, actual product count, actual lowest price).
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CATS = [
  ['', 'All'], ['trading', 'Trading'], ['sports', 'Sports picks'], ['crypto', 'Crypto'],
  ['gaming', 'Gaming'], ['fitness', 'Fitness'], ['reselling', 'Reselling'],
  ['education', 'Education'], ['content', 'Content'], ['community', 'Community'], ['other', 'Other'],
];
const catLabel = (k) => CATS.find(([c]) => c === k)?.[1] ?? null;

let all = [];
let activeCat = '';

function card(s) {
  const initial = esc((s.name || '?').slice(0, 1).toUpperCase());
  // Only stores that actually uploaded or linked a banner get the strip. A
  // placeholder slab on every other card would be louder than no banner and
  // would say nothing true about the store.
  const banner = s.bannerUrl
    ? `<span class="disc-banner">${s.bannerKind === 'video'
        ? `<video class="disc-banner-media" src="${esc(s.bannerUrl)}" autoplay muted loop playsinline preload="metadata" disablepictureinpicture aria-hidden="true" onerror="this.closest('.disc-banner').hidden = true"></video>`
        : `<img class="disc-banner-media" src="${esc(s.bannerUrl)}" alt="" loading="lazy" decoding="async" onerror="this.closest('.disc-banner').hidden = true" />`}</span>`
    : '';
  const icon = s.iconUrl
    ? `<img class="disc-icon" src="${esc(s.iconUrl)}" alt="" width="44" height="44" loading="lazy" />`
    : `<span class="disc-icon disc-icon-fallback">${initial}</span>`;
  const meta = [
    `${s.products} product${s.products === 1 ? '' : 's'}`,
    `from ${fmtFrom(s.fromUsd, s.currency)}`,
    s.members > 0 ? `${s.members} member${s.members === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  // The store's own accent, validated server-side, as a signature hairline.
  const accent = /^#[0-9a-fA-F]{6}$/.test(s.accent ?? '') ? s.accent : null;
  return `
    <a class="disc-card panel" href="/${esc(s.slug)}"${accent ? ` style="--disc-accent:${accent}"` : ''}>
      ${accent ? '<span class="disc-accent" aria-hidden="true"></span>' : ''}
      ${banner}
      <span class="disc-head">
        ${icon}
        <span class="disc-title">
          <strong>${esc(s.name)}</strong>
          ${s.category ? `<span class="disc-cat">${esc(catLabel(s.category) ?? '')}</span>` : ''}
        </span>
      </span>
      ${s.description ? `<span class="disc-desc">${esc(s.description)}</span>` : ''}
      <span class="disc-meta">${esc(meta)}</span>
    </a>`;
}

function render() {
  const q = ($('#disc-q').value ?? '').trim().toLowerCase();
  const list = all.filter((s) => {
    const hitQ = !q || s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q);
    return hitQ && (!activeCat || s.category === activeCat);
  });
  $('#disc-grid').innerHTML = list.length
    ? list.map(card).join('')
    : `<div class="disc-empty panel">
         <strong>${all.length ? 'Nothing matches that yet.' : 'No communities listed yet.'}</strong>
         <p>${all.length ? 'Try another search or category.' : 'Run a Discord community? Set up your store and switch on Discover from your dashboard.'}</p>
         ${all.length ? '' : '<a class="btn-pill" href="/dashboard">Open the dashboard</a>'}
       </div>`;
}

function renderCats() {
  const counts = new Map();
  for (const s of all) if (s.category) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
  $('#disc-cats').innerHTML = CATS
    .filter(([k]) => k === '' || counts.has(k))
    .map(([k, label]) => `<button type="button" class="disc-chip${k === activeCat ? ' active' : ''}" data-cat="${k}">${label}</button>`)
    .join('');
  document.querySelectorAll('.disc-chip').forEach((b) => {
    b.onclick = () => { activeCat = b.dataset.cat; renderCats(); render(); };
  });
}

async function loadAccount() {
  const me = await (await fetch('/api/me')).json().catch(() => ({ loggedIn: false }));
  const account = $('#account');
  const menuAccount = $('#menu-account');
  if (me.loggedIn) {
    account.innerHTML = `<a class="nav-link" href="/account">Account</a><a class="nav-link" href="/dashboard">Dashboard</a><span>@${esc(me.username ?? me.discordId)}</span>`;
    if (menuAccount) menuAccount.innerHTML = `<a href="/dashboard">Dashboard</a><a href="/account">Account</a>`;
  } else {
    account.innerHTML = '<button class="btn-pill" id="login">Sign in with Discord</button>';
    $('#login').onclick = () => (window.location.href = '/auth/login');
    if (menuAccount) menuAccount.innerHTML = `<a class="accent" href="/auth/login">Sign in with Discord</a>`;
  }
}

// mobile menu: same behavior as the landing page


(async () => {
  loadAccount().catch(() => {});
  try {
    all = (await (await fetch('/api/discover')).json()).stores ?? [];
  } catch {
    all = [];
  }
  renderCats();
  render();
  $('#disc-q').addEventListener('input', render);
})();
