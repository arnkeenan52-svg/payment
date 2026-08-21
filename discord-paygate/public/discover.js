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
  const icon = s.iconUrl
    ? `<img class="disc-icon" src="${esc(s.iconUrl)}" alt="" width="44" height="44" loading="lazy" />`
    : `<span class="disc-icon disc-icon-fallback">${initial}</span>`;
  const meta = [
    `${s.products} product${s.products === 1 ? '' : 's'}`,
    `from $${Number(s.fromUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    s.members > 0 ? `${s.members} member${s.members === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  // The store's own accent, validated server-side, as a signature hairline.
  const accent = /^#[0-9a-fA-F]{6}$/.test(s.accent ?? '') ? s.accent : null;
  return `
    <a class="disc-card panel" href="/${esc(s.slug)}"${accent ? ` style="--disc-accent:${accent}"` : ''}>
      ${accent ? '<span class="disc-accent" aria-hidden="true"></span>' : ''}
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
const menuBtn = $('#menu-btn');
if (menuBtn) {
  const menu = $('#mobile-menu');
  const scrim = $('#menu-scrim');
  let isOpen = false;
  const syncNavHeight = () => {
    const nav = document.querySelector('.top');
    if (nav) document.documentElement.style.setProperty('--nav-h', `${Math.round(nav.getBoundingClientRect().height)}px`);
  };
  const setOpen = (open) => {
    isOpen = open;
    menuBtn.setAttribute('aria-expanded', String(open));
    document.documentElement.classList.toggle('menu-open', open);
    if (open) {
      syncNavHeight();
      menu.hidden = false;
      if (scrim) scrim.hidden = false;
      requestAnimationFrame(() => requestAnimationFrame(() => { menu.classList.add('open'); scrim?.classList.add('open'); }));
    } else {
      menu.classList.remove('open');
      scrim?.classList.remove('open');
      setTimeout(() => { if (!isOpen) { menu.hidden = true; if (scrim) scrim.hidden = true; } }, 260);
    }
  };
  menuBtn.onclick = () => setOpen(!isOpen);
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  scrim?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen) { setOpen(false); menuBtn.focus(); } });
}

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
