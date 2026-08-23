// Site theme: black, every time the site is opened. The sun toggle switches
// to light for the CURRENT visit only (per-tab session) — a fresh open is
// always the brand's dark look. Loaded synchronously in <head> so the
// attribute lands before first paint — no flash.
(() => {
  try {
    localStorage.removeItem('ripley-theme'); // retire the old forever-choice
    if (sessionStorage.getItem('ripley-theme') === 'light') document.documentElement.dataset.theme = 'light';
  } catch { /* storage blocked — dark it is */ }
  addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      b.addEventListener('click', () => {
        const toLight = document.documentElement.dataset.theme !== 'light';
        if (toLight) document.documentElement.dataset.theme = 'light';
        else delete document.documentElement.dataset.theme;
        try { sessionStorage.setItem('ripley-theme', toLight ? 'light' : 'dark'); } catch { /* fine */ }
      });
    });
  });
})();
