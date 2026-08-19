const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function load() {
  const me = await (await fetch('/api/me')).json().catch(() => ({ loggedIn: false }));

  const account = $('#account');
  const menuAccount = $('#menu-account');
  if (me.loggedIn) {
    account.innerHTML =
      `<a class="nav-link" href="/account">Account</a>` +
      `<a class="nav-link" href="/dashboard">Dashboard</a>` +
      `<span>@${esc(me.username ?? me.discordId)}</span><button class="btn-ghost" id="logout">Sign out</button>`;
    $('#logout').onclick = () => (window.location.href = '/auth/logout');
    if (menuAccount)
      menuAccount.innerHTML =
        `<a href="/dashboard">Dashboard</a><a href="/account">Account</a>` +
        `<a href="/auth/logout">Sign out <span class="dim">@${esc(me.username ?? me.discordId)}</span></a>`;
  } else {
    account.innerHTML = '<button class="btn-pill" id="login">Sign in with Discord</button>';
    $('#login').onclick = () => (window.location.href = '/auth/login');
    if (menuAccount) menuAccount.innerHTML = `<a class="accent" href="/auth/login">Sign in with Discord</a>`;
  }
}

// ── mobile menu ───────────────────────────────────────────────────────────────

const menuBtn = $('#menu-btn');
if (menuBtn) {
  const menu = $('#mobile-menu');
  const scrim = $('#menu-scrim');
  let isOpen = false;
  // The sheet hangs off the real nav height, which differs by viewport and
  // changes if the header wraps.
  const syncNavHeight = () => {
    const nav = document.querySelector('.top');
    if (nav) document.documentElement.style.setProperty('--nav-h', `${Math.round(nav.getBoundingClientRect().height)}px`);
  };
  addEventListener('resize', () => { if (isOpen) syncNavHeight(); }, { passive: true });
  const setOpen = (open) => {
    isOpen = open;
    menuBtn.setAttribute('aria-expanded', String(open));
    document.documentElement.classList.toggle('menu-open', open);
    if (open) {
      syncNavHeight();
      menu.hidden = false;
      if (scrim) scrim.hidden = false;
      // Two frames so the browser commits display before the transition runs.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        menu.classList.add('open');
        scrim?.classList.add('open');
      }));
    } else {
      menu.classList.remove('open');
      scrim?.classList.remove('open');
      // Hide after the sheet finishes sliding, not mid-animation.
      setTimeout(() => {
        if (isOpen) return;
        menu.hidden = true;
        if (scrim) scrim.hidden = true;
      }, 260);
    }
  };
  menuBtn.onclick = () => setOpen(!isOpen);
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) setOpen(false);
  });
  scrim?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) {
      setOpen(false);
      menuBtn.focus();
    }
  });
}

// ── nav: hairline + glass only once the page scrolls ──────────────────────────
{
  const top = document.querySelector('body.home .top');
  if (top) {
    let raf = 0;
    const sync = () => {
      raf = 0;
      top.classList.toggle('scrolled', window.scrollY > 8);
    };
    addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(sync); }, { passive: true });
    sync();
  }
}

// ── scroll reveals: sections rise in as they enter the viewport ───────────────
if (!matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
  const els = document.querySelectorAll(
    '.kicker, .section-title, .section-sub, .feat-cell, .price-card, .hiw-step, .faq-item, .trio, .calc, .cta-panel, .pm-chips, .pm-note, .uc-grid > *, .trio-title, .bill-toggle, .price-note, .xcta h2, .xcta .hero-ctas',
  );
  const io = new IntersectionObserver(
    (entries) => entries.forEach((en) => {
      if (!en.isIntersecting) return;
      en.target.classList.add('in');
      io.unobserve(en.target);
    }),
    { rootMargin: '0px 0px -10% 0px', threshold: 0.05 },
  );
  els.forEach((el) => {
    // Anything already on screen at load skips the reveal — no pop-in.
    const r = el.getBoundingClientRect();
    if (r.top < innerHeight * 0.85 && r.bottom > 0) return;
    el.classList.add('rv');
    io.observe(el);
  });
  // Siblings in a grid land one after another, not all at once.
  document.querySelectorAll('.fgrid, .price-grid, .hiw, .trio-grid, .uc-grid').forEach((grid) => {
    [...grid.children].forEach((c, i) => { c.style.transitionDelay = `${Math.min(i * 55, 275)}ms`; });
  });
}

// ── hero media: animated tour image, upgraded to real video when proven ──────
// The markup ships an animated WebP <img> — it renders and moves everywhere:
// no codec negotiation, no autoplay policy, no range requests, works with JS
// disabled. Here we build a <video> OFF-DOM and swap it in only after the
// browser has decoded frames AND started playback, so a broken video stack
// can never take the motion away.
(() => {
  const img = $('#hero-media');
  if (!img) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    img.src = '/shot-dashboard.png?v=56'; // hold a still frame instead
    return;
  }

  const v = document.createElement('video');
  v.className = 'hero-video';
  v.muted = true;
  v.loop = true;
  v.autoplay = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.setAttribute('playsinline', ''); // older iOS reads the attribute, not the prop
  v.width = 1280;
  v.height = 800;
  v.setAttribute('aria-label', img.alt);

  const sources = [
    ['/hero-demo.mp4?v=56', 'video/mp4; codecs="avc1.640020"'],
    ['/hero-demo.webm?v=56', 'video/webm; codecs="vp9"'],
  ];
  const playable = sources.filter(([, t]) => v.canPlayType(t) !== '');
  if (!playable.length) return; // the animated image simply stays

  let upgraded = false;
  v.addEventListener('playing', () => {
    if (upgraded || v.readyState < 2) return;
    upgraded = true;
    img.replaceWith(v);
  });

  let at = 0;
  const load = () => {
    v.src = playable[at][0];
    v.load();
    v.play().catch(() => {}); // refused autoplay → the image stays; no harm done
  };
  v.addEventListener('error', () => {
    at += 1;
    if (!upgraded && at < playable.length) load();
  });
  load();
})();

// ── pricing: monthly / yearly toggle (two months free on yearly) ─────────────
(() => {
  const bt = document.querySelector('.bill-toggle');
  if (!bt) return;
  const m = bt.querySelector('.bt-m');
  const y = bt.querySelector('.bt-y');
  const set = (yearly) => {
    m.classList.toggle('active', !yearly);
    y.classList.toggle('active', yearly);
    m.setAttribute('aria-pressed', String(!yearly));
    y.setAttribute('aria-pressed', String(yearly));
    document.querySelectorAll('.price-amt').forEach((el) => {
      const v = Number(yearly ? el.dataset.y : el.dataset.m);
      el.querySelector('.pa-num').textContent = `$${v % 1 === 0 ? v : v.toFixed(2)}`;
      el.querySelector('.price-per').textContent = yearly ? '/year' : '/month';
    });
  };
  m.onclick = () => set(false);
  y.onclick = () => set(true);
  bt.querySelector('.bill-switch')?.addEventListener('click', () => set(!y.classList.contains('active')));
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
