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

  addEventListener('DOMContentLoaded', () => {
    syncChrome();
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      b.addEventListener('click', () => {
        const toLight = document.documentElement.dataset.theme !== 'light';
        if (toLight) document.documentElement.dataset.theme = 'light';
        else delete document.documentElement.dataset.theme;
        try { sessionStorage.setItem('ripley-theme', toLight ? 'light' : 'dark'); } catch { /* fine */ }
        syncChrome();
      });
    });
  });
})();
