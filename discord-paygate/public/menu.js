// Mobile menu — one shared script for every page with a #menu-btn.
// Disclosure-nav pattern (button aria-expanded/controls + nav sheet), armed
// for the ways phone browsers actually break drawers:
// - iOS-proof scroll lock: overflow:hidden alone loses to touch momentum, so
//   the body is frozen in place (position:fixed at the current scroll) and
//   the scroll restored on close; the scrim also eats touchmove.
// - Everything behind the sheet turns inert while open, so Tab and screen
//   readers cannot wander into the covered page.
// - Focus moves to the first link on open and back to the button on close.
// - Escape, the scrim, any link, and leaving the mobile breakpoint
//   (rotation, resize, foldables) all close it — nothing can strand the
//   scrim over an unscrollable page.
(() => {
  const btn = document.getElementById('menu-btn');
  if (!btn) return;
  const menu = document.getElementById('mobile-menu');
  const scrim = document.getElementById('menu-scrim');
  const mobile = matchMedia('(max-width: 760px)');
  let isOpen = false;
  let lockedY = 0;

  // The sheet hangs off the real nav height, which differs by viewport and
  // changes if the header wraps.
  const syncNavHeight = () => {
    const nav = document.querySelector('.top');
    if (nav) document.documentElement.style.setProperty('--nav-h', `${Math.round(nav.getBoundingClientRect().height)}px`);
  };
  addEventListener('resize', () => { if (isOpen) syncNavHeight(); }, { passive: true });

  const lock = () => {
    lockedY = window.scrollY;
    document.documentElement.classList.add('menu-open');
    const b = document.body.style;
    b.position = 'fixed';
    b.top = `-${lockedY}px`;
    b.left = '0';
    b.right = '0';
    b.width = '100%';
  };
  const unlock = () => {
    document.documentElement.classList.remove('menu-open');
    const b = document.body.style;
    b.position = ''; b.top = ''; b.left = ''; b.right = ''; b.width = '';
    // Instant, not smooth — the restore must be imperceptible, and the
    // page's scroll-behavior would animate a plain scrollTo.
    window.scrollTo({ top: lockedY, behavior: 'instant' });
  };

  const behind = () => [...document.querySelectorAll('main, footer')];
  const setInertBehind = (on) => {
    for (const el of behind()) {
      try { el.inert = on; } catch { /* pre-inert engines keep normal order */ }
    }
  };

  const setOpen = (open, { returnFocus = true } = {}) => {
    if (open === isOpen) return;
    isOpen = open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      syncNavHeight();
      lock();
      menu.hidden = false;
      if (scrim) scrim.hidden = false;
      setInertBehind(true);
      // Two frames so the browser commits display before the transition runs.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        menu.classList.add('open');
        scrim?.classList.add('open');
      }));
      const first = menu.querySelector('a, button');
      if (first) setTimeout(() => { if (isOpen) first.focus({ preventScroll: true }); }, 90);
    } else {
      menu.classList.remove('open');
      scrim?.classList.remove('open');
      setInertBehind(false);
      unlock();
      // Hide after the sheet finishes sliding, not mid-animation.
      setTimeout(() => {
        if (isOpen) return;
        menu.hidden = true;
        if (scrim) scrim.hidden = true;
      }, 260);
      if (returnFocus) btn.focus({ preventScroll: true });
    }
  };

  btn.addEventListener('click', () => setOpen(!isOpen));
  // A tapped link closes the sheet and lets the navigation take focus.
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false, { returnFocus: false }); });
  scrim?.addEventListener('click', () => setOpen(false));
  scrim?.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) setOpen(false);
  });
  const onBreakpoint = (ev) => { if (!ev.matches && isOpen) setOpen(false, { returnFocus: false }); };
  if (mobile.addEventListener) mobile.addEventListener('change', onBreakpoint);
  else mobile.addListener?.(onBreakpoint);
})();
