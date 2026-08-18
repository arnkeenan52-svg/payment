const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function load() {
  const me = await (await fetch('/api/me')).json().catch(() => ({ loggedIn: false }));

  const account = $('#account');
  const menuAccount = $('#menu-account');
  if (me.loggedIn) {
    account.innerHTML =
      `<a class="nav-link" href="/store">Store</a>` +
      `<a class="nav-link" href="/account">Account</a>` +
      `<a class="nav-link" href="/dashboard">Dashboard</a>` +
      `<span>@${esc(me.username ?? me.discordId)}</span><button class="btn-ghost" id="logout">Sign out</button>`;
    $('#logout').onclick = () => (window.location.href = '/auth/logout');
    if (menuAccount)
      menuAccount.innerHTML =
        `<a href="/dashboard">Dashboard</a><a href="/store">Store</a><a href="/account">Account</a>` +
        `<a href="/auth/logout">Sign out <span class="dim">@${esc(me.username ?? me.discordId)}</span></a>`;
  } else {
    account.innerHTML =
      '<a class="nav-link" href="/store">Store</a><button class="btn-pill" id="login">Sign in with Discord</button>';
    $('#login').onclick = () => (window.location.href = '/auth/login');
    if (menuAccount) menuAccount.innerHTML = `<a href="/store">Store</a><a class="accent" href="/auth/login">Sign in with Discord</a>`;
  }
}

// ── mobile menu ───────────────────────────────────────────────────────────────

const menuBtn = $('#menu-btn');
if (menuBtn) {
  const menu = $('#mobile-menu');
  const setOpen = (open) => {
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
  };
  menuBtn.onclick = () => setOpen(menu.hidden);
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) setOpen(false);
  });
}

// ── hero demo: auto-cycling product views (crossfade, pause on hover) ─────────
// Reads like a product gif but stays crisp: the three real screenshots rotate
// with a caption + dots. Reduced motion disables the auto-advance; the dots
// still switch views by hand.

(() => {
  const demo = $('#hero-demo');
  if (!demo) return;
  const slides = [...demo.querySelectorAll('.demo-slide')];
  const dotsBox = $('#demo-dots');
  const caption = $('#demo-caption');
  let at = 0;
  let timer = null;
  const dots = slides.map((s, i) => {
    const d = document.createElement('button');
    d.type = 'button';
    d.className = 'hd-dot' + (i === 0 ? ' active' : '');
    d.setAttribute('aria-label', s.dataset.caption);
    d.onclick = () => {
      show(i);
      restart();
    };
    dotsBox.append(d);
    return d;
  });
  const show = (i) => {
    at = i;
    slides.forEach((s, k) => s.classList.toggle('active', k === i));
    dots.forEach((d, k) => d.classList.toggle('active', k === i));
    caption.textContent = slides[i].dataset.caption;
  };
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const start = () => {
    if (reduce.matches || timer) return;
    timer = setInterval(() => show((at + 1) % slides.length), 3800);
  };
  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  const restart = () => {
    stop();
    start();
  };
  demo.addEventListener('pointerenter', stop);
  demo.addEventListener('pointerleave', start);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  start();
})();

// ── savings calculator ────────────────────────────────────────────────────────
// Ripley's flat tiers vs. publicly listed competitor pricing. Percentages are
// applied to gross monthly sales; the footnote on the page covers the caveats.

const RIPLEY_TIERS = [
  { max: 10, cost: 0, label: 'Free plan · 0% of sales' },
  { max: 50, cost: 5.99, label: 'Starter · $5.99/mo · 0% of sales' },
  { max: 500, cost: 19.99, label: 'Growth · $19.99/mo · 0% of sales' },
  { max: Infinity, cost: 49.99, label: 'Scale · $49.99/mo · 0% of sales' },
];

function calc() {
  const subsEl = $('#c-subs');
  if (!subsEl) return;
  const subs = Number(subsEl.value);
  const price = Number($('#c-price').value);
  const revenue = subs * price;
  const tier = RIPLEY_TIERS.find((t) => subs <= t.max);
  const costs = {
    ripley: tier.cost,
    whop: revenue * 0.03,
    lp: 29 + revenue * 0.035,
    uc: 49,
  };
  const max = Math.max(...Object.values(costs), 1);
  const money = (n) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  $('#c-subs-out').textContent = String(subs);
  $('#c-price-out').textContent = `$${price}`;
  $('#c-ripley').textContent = money(costs.ripley);
  $('#c-ripley-plan').textContent = tier.label;
  $('#c-whop').textContent = money(costs.whop);
  $('#c-lp').textContent = money(costs.lp);
  $('#c-uc').textContent = money(costs.uc);
  $('#c-bar-ripley').style.width = `${Math.max((costs.ripley / max) * 100, 1.5)}%`;
  $('#c-bar-whop').style.width = `${(costs.whop / max) * 100}%`;
  $('#c-bar-lp').style.width = `${(costs.lp / max) * 100}%`;
  $('#c-bar-uc').style.width = `${(costs.uc / max) * 100}%`;
  const worst = Math.max(costs.whop, costs.lp, costs.uc);
  $('#c-save').textContent = `$${Math.max(Math.round((worst - costs.ripley) * 12), 0).toLocaleString()}`;
}

for (const id of ['c-subs', 'c-price']) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', calc);
}
calc();

// ── scroll reveal ─────────────────────────────────────────────────────────────
// Marketing page only: sections fade up as they enter the viewport; grid items
// stagger 60ms. Content is only hidden AFTER JS runs, so no-JS never blanks
// the page, and reduced-motion gets a plain fast fade (see styles.css).
(() => {
  if (!('IntersectionObserver' in window)) return;
  const singles = document.querySelectorAll('.frow-copy, .frow-visual, .calc, .section-title, .section-sub, .price-note, .xcta h2');
  const grids = document.querySelectorAll('.trio-grid, .steps-grid, .price-grid');
  const targets = [];
  for (const el of singles) targets.push(el);
  for (const grid of grids)
    [...grid.children].forEach((el, i) => {
      el.style.setProperty('--rv-d', `${Math.min(i * 60, 240)}ms`);
      targets.push(el);
    });
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) {
          e.target.classList.add('rv-in');
          io.unobserve(e.target);
        }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  for (const el of targets) {
    if (el.getBoundingClientRect().top < window.innerHeight * 0.9) continue; // already visible: never hide it
    el.classList.add('rv');
    io.observe(el);
  }
})();

load().catch(() => {});
