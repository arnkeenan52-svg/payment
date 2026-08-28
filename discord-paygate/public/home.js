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

// ── hero media: the product tour ─────────────────────────────────────────────
// ONE FILE FOR BOTH THEMES. This used to hold a dark cut and a light cut and
// swap them whenever data-theme changed. The film now contains its own tonal
// range — it runs near-black, morphs a live store preview blue to black to
// white, and spends a whole beat on a light Ivory storefront — so a separate
// light cut would be showing the same thing twice.
//
// DEFERRED ON PURPOSE. The markup ships preload="none" and no autoplay, so the
// browser fetches nothing until this runs. Before that it was preload="auto"
// plus autoplay, which meant every visitor pulled the whole file immediately,
// competing with CSS, fonts and the poster during first paint — on a phone that
// reads as the hero stuttering, which is exactly what got reported.
//
// The trade: with JS off the poster is all you get. Acceptable for a decorative
// loop, and the poster is a real frame of the film rather than a blank plate.
(() => {
  const v = document.getElementById('hero-media');
  if (!v || v.tagName !== 'VIDEO') return;
  const V = '191';
  let started = false;

  const sound = document.getElementById('hero-sound');
  const cutBtn = document.getElementById('hero-cut');

  // TWO GRADES OF ONE FILM. They are frame-synchronised by construction —
  // rendered from the same engine at the same timings with the same cursor path
  // and the same soundtrack — so the playhead survives a swap and the switch
  // reads as the lights changing rather than as a different video loading.
  // Dark is the default because that is the cut the homepage is built around.
  const KEY = 'dues.herocut';
  const read = () => {
    // A private window, cleared site data, or a browser set to block storage
    // all throw here rather than returning null. The film must play regardless.
    try { return localStorage.getItem(KEY); } catch { return null; }
  };
  const write = (val) => { try { localStorage.setItem(KEY, val); } catch { /* not important enough to break on */ } };
  let cut = read() === 'light' ? 'light' : 'dark';
  const fileFor = (c) => (c === 'light' ? '/hero-tour.mp4' : '/hero-tour-dark.mp4');
  const posterFor = (c) => (c === 'light' ? '/hero-poster.webp' : '/hero-poster-dark.webp');

  const paintCut = () => {
    if (!cutBtn) return;
    const light = cut === 'light';
    cutBtn.setAttribute('aria-pressed', String(light));
    cutBtn.setAttribute('aria-label', light
      ? 'Switch the tour to the dark version'
      : 'Switch the tour to the light version');
  };

  const begin = () => {
    if (started) return;
    started = true;
    v.poster = `${posterFor(cut)}?v=${V}`;
    v.src = `${fileFor(cut)}?v=${V}`;
    v.load();
    v.play().catch(() => {}); // refused autoplay → the poster holds; no harm
    // The buttons appear only once there is something to act on. Revealing them
    // beside a poster with no file attached would offer controls that do
    // nothing.
    if (sound) sound.hidden = false;
    if (cutBtn) { cutBtn.hidden = false; paintCut(); }
  };

  if (cutBtn) {
    paintCut();
    cutBtn.addEventListener('click', () => {
      cut = cut === 'light' ? 'dark' : 'light';
      write(cut);
      paintCut();
      if (!started) return;              // nothing attached yet; begin() will use it
      // Carry the playhead and the mute state across. Both cuts are exactly
      // 20.0s and share every cut point, so the same t is the same moment.
      const at = v.currentTime;
      const wasMuted = v.muted;
      v.poster = `${posterFor(cut)}?v=${V}`;
      v.src = `${fileFor(cut)}?v=${V}`;
      v.load();
      const resume = () => {
        try { v.currentTime = at; } catch { /* metadata not ready enough; start over */ }
        v.muted = wasMuted;
        v.play().catch(() => {});
      };
      v.addEventListener('loadedmetadata', resume, { once: true });
    });
  }

  // Sound is opt-in because it has to be: a loop that starts unmuted is a loop
  // the browser refuses to autoplay. The click is the user gesture that lets it
  // through. aria-pressed drives BOTH the announced state and (via CSS) the
  // icon, so the two cannot disagree.
  if (sound) {
    sound.addEventListener('click', () => {
      const on = v.muted; // about to become unmuted
      v.muted = !on;
      sound.setAttribute('aria-pressed', String(on));
      sound.setAttribute('aria-label', on ? 'Turn tour sound off' : 'Turn tour sound on');
      if (on) v.play().catch(() => {});
    });
  }
  const schedule = () => {
    if ('requestIdleCallback' in window) requestIdleCallback(begin, { timeout: 2000 });
    else setTimeout(begin, 200);
  };
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });

  // A visitor who scrolls straight past should not pay to decode a loop they
  // cannot see.
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!started) return;
        if (entry.isIntersecting) v.play().catch(() => {});
        else v.pause();
      },
      { threshold: 0 },
    );
    io.observe(v);
  }
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

