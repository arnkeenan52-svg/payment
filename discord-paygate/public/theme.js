// Site theme: black, every time the site is opened. The sun toggle switches
// to light for the CURRENT visit only (per-tab session) — a fresh open is
// always the brand's dark look. Loaded synchronously in <head> so the
// attribute lands before first paint — no flash.
(() => {
  try {
    localStorage.removeItem('ripley-theme'); // retire the old forever-choice
    if (sessionStorage.getItem('ripley-theme') === 'light') document.documentElement.dataset.theme = 'light';
  } catch { /* storage blocked — dark it is */ }

  // Keep the iOS status-bar / browser chrome painted the same colour as the
  // page background, so the top strip is never a stray grey. Reads the real
  // computed background so it's right on every page and both themes.
  const syncChrome = () => {
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') return;
      let m = document.querySelector('meta[name="theme-color"]');
      if (!m) { m = document.createElement('meta'); m.setAttribute('name', 'theme-color'); document.head.appendChild(m); }
      m.setAttribute('content', bg);
    } catch { /* no-op */ }
  };

  // iOS repaints its status bar ONLY at first paint. Safari 26 samples a fixed
  // element's background rather than reading theme-color, and it takes that
  // sample once — no script change moves it afterwards. The block at the top of
  // this file sets data-theme before first paint, so a reload lands on the face
  // the visitor chose. Scroll position rides across in sessionStorage.
  // UA-tested, not @supports: Chromium also answers to -webkit-touch-callout
  // and a desktop toggle must stay instant.
  const isIosWebKit = (() => {
    const ua = navigator.userAgent || '';
    const iOS = /iPhone|iPad|iPod/.test(ua)
      || (/Mac/.test(navigator.platform || '') && navigator.maxTouchPoints > 1);
    return iOS && /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|Android/.test(ua);
  })();

  (() => {
    let raw = null;
    try { raw = sessionStorage.getItem('ripley-scroll'); sessionStorage.removeItem('ripley-scroll'); } catch { /* fine */ }
    const y = raw === null ? 0 : parseInt(raw, 10) || 0;
    if (!y) return;
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    const put = () => window.scrollTo(0, y);
    requestAnimationFrame(() => requestAnimationFrame(put));
    addEventListener('load', put);
  })();

  addEventListener('DOMContentLoaded', () => {
    syncChrome();
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      b.addEventListener('click', () => {
        const toLight = document.documentElement.dataset.theme !== 'light';
        if (toLight) document.documentElement.dataset.theme = 'light';
        else delete document.documentElement.dataset.theme;
        try { sessionStorage.setItem('ripley-theme', toLight ? 'light' : 'dark'); } catch { /* fine */ }
        syncChrome();
        if (isIosWebKit) {
          try { sessionStorage.setItem('ripley-scroll', String(window.scrollY | 0)); } catch { /* fine */ }
          location.reload();
        }
      });
    });
  });
})();

// ---------------------------------------------------------------------------
// Google Preferred Sources.
// A footer button that lets a reader mark dues.gg as a preferred source in
// Google Search. It lives here rather than in the page markup because theme.js
// is the one script every page already loads in <head> — including the SEO
// pages stamped by scripts/gen-seo-pages.mjs — so the button appears site-wide
// from one place and survives a regeneration.
//
// The custom-trigger integration is deliberate. Google's drop-in button renders
// inside an iframe that paints its own white sheet, which reads as a hole in
// this footer. The link below is a real link to the same tool, so it still
// works with the library blocked or slow; once the library is up it takes the
// click over and runs the flow in-page, returning the reader to where they were.
// Docs: https://developers.google.com/search/docs/appearance/preferred-sources
// ---------------------------------------------------------------------------
(() => {
  const SRC = 'https://news.google.com/swg/js/v1/publisher.js';
  const DEEPLINK = 'https://www.google.com/preferences/source?q=dues.gg';
  const G = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style="flex:none"><path fill="#4285f4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"/><path fill="#34a853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"/><path fill="#fbbc04" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"/><path fill="#ea4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"/></svg>';

  const mount = () => {
    const footer = document.querySelector('.site-footer');
    if (!footer || footer.querySelector('.pref-source')) return;

    const a = document.createElement('a');
    a.className = 'btn-secondary pref-source';
    a.href = DEEPLINK;
    a.rel = 'noopener';
    // Layout only — colours come from .btn-secondary, so both themes are covered.
    a.style.cssText = 'grid-column:1/-1;justify-self:start;width:fit-content;display:inline-flex;align-items:center;gap:8px;font-size:12.5px;padding:8px 14px;border-radius:999px;margin-top:2px';
    a.innerHTML = G + '<span>Add Dues to your preferred sources</span>';
    footer.insertBefore(a, footer.querySelector('.footer-disclaimer'));

    const s = document.createElement('script');
    s.async = true;
    s.src = SRC;
    // Manual mode: nothing is auto-rendered, we bind the flow to our own link.
    s.setAttribute('preferred-sources-control', 'manual');
    document.head.appendChild(s);

    (self.PREFERRED_SOURCE = self.PREFERRED_SOURCE || []).push((ps) => {
      ps.init({ theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark' });
      a.addEventListener('click', (e) => { e.preventDefault(); ps.addPreferredSource(); });
    });
  };

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mount);
  else mount();
})();
