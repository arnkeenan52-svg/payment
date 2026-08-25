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

// ── hero media: the product-tour video, themed to the page ───────────────────
// DEFERRED ON PURPOSE. The markup ships the video with preload="none" and no
// autoplay, so the browser fetches nothing until this runs. Before that it was
// preload="auto" + autoplay, which meant every visitor pulled the whole file
// immediately, competing with CSS, fonts and the poster for bandwidth during
// first paint — on a phone or a slow connection that reads as the hero
// stuttering, which is exactly what got reported. The poster is ~5KB and
// paints straight away; the video arrives when the page is otherwise done.
//
// The trade: with JS off the poster is all you get. That is acceptable for a
// decorative loop, and it is the same still the video opens on.
(() => {
  const v = document.getElementById('hero-media');
  if (!v || v.tagName !== 'VIDEO') return;
  const V = '120';
  const srcFor = (light) => `/hero-tour-${light ? 'light' : 'dark'}.mp4?v=${V}`;

  let started = false;
  const apply = () => {
    const light = document.documentElement.dataset.theme === 'light';
    const want = srcFor(light);
    v.poster = `/hero-poster-${light ? 'light' : 'dark'}.webp?v=${V}`;
    if (started && v.getAttribute('data-src') === want) return; // already on it
    v.setAttribute('data-src', want);
    v.src = want;
    v.load();
    v.play().catch(() => {}); // refused autoplay → the poster holds; no harm
    started = true;
  };

  // Wait for the page to finish its critical work before asking for ~5MB.
  // requestIdleCallback where it exists; the load event everywhere else. Both
  // are guarded so the video starts exactly once.
  const begin = () => {
    if (started) return;
    apply();
  };
  const schedule = () => {
    if ('requestIdleCallback' in window) requestIdleCallback(begin, { timeout: 2000 });
    else setTimeout(begin, 200);
  };
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });

  // A visitor who never scrolls past the hero should still get it, and a
  // visitor who scrolls straight past should not pay for it at all.
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!started) return; // not fetched yet — the schedule above owns that
        if (entry.isIntersecting) v.play().catch(() => {});
        else v.pause(); // scrolled past: stop burning decode on an unseen loop
      },
      { threshold: 0 },
    );
    io.observe(v);
  }

  // Follow the sun/moon toggle (it flips data-theme on <html>). Before the
  // video has started this only swaps the poster, which is the point: toggling
  // the theme must not pull the video forward.
  new MutationObserver(() => {
    const light = document.documentElement.dataset.theme === 'light';
    v.poster = `/hero-poster-${light ? 'light' : 'dark'}.webp?v=${V}`;
    if (started) apply();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
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
    // Yearly shows the effective monthly rate — the discount is the point —
    // with the real billed amount spelled out underneath.
    document.querySelectorAll('.price-amt').forEach((el) => {
      const yr = Number(el.dataset.y);
      const v = yearly ? yr / 12 : Number(el.dataset.m);
      el.querySelector('.pa-num').textContent = `$${v % 1 === 0 ? v : v.toFixed(2)}`;
      el.querySelector('.price-per').textContent = '/month';
      const bill = el.parentElement.querySelector('.price-bill');
      if (bill) {
        bill.hidden = !yearly || yr === 0;
        if (yearly && yr) bill.textContent = `Billed $${yr.toFixed(2)} a year — 2 months free`;
      }
    });
  };
  m.onclick = () => set(false);
  y.onclick = () => set(true);
  bt.querySelector('.bill-switch')?.addEventListener('click', () => set(!y.classList.contains('active')));
})();

// ── savings calculator ────────────────────────────────────────────────────────
// Dues's flat tiers vs. publicly listed competitor pricing. Percentages are
// applied to gross monthly sales; the footnote on the page covers the caveats.

const RIPLEY_TIERS = [
  { max: 10, cost: 0, label: 'Free plan · 0% of sales' },
  { max: 50, cost: 14.99, label: 'Pro · $14.99/mo · 0% of sales' },
  { max: 500, cost: 44.99, label: 'Max · $44.99/mo · 0% of sales' },
  { max: Infinity, cost: 134.99, label: 'Unlimited · $134.99/mo · 0% of sales' },
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
    // Upgrade.Chat's own docs describe a cut on top of processing ("what you
    // keep after Payment Processor and Upgrade.Chat fees") and it applies on
    // every plan, paid ones included. Their published plan price and rate are
    // both floors, so the row is labelled "from" and modelled with the LOWEST
    // rate in circulation — understating them rather than the reverse.
    uc: 49 + revenue * 0.029,
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

