// Site theme: dark by default, light on request. Loaded synchronously in
// <head> so the attribute lands before first paint — no flash.
(() => {
  try {
    if (localStorage.getItem('ripley-theme') === 'light') document.documentElement.dataset.theme = 'light';
  } catch { /* storage blocked — dark it is */ }
  addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      b.addEventListener('click', () => {
        const toLight = document.documentElement.dataset.theme !== 'light';
        if (toLight) document.documentElement.dataset.theme = 'light';
        else delete document.documentElement.dataset.theme;
        try { localStorage.setItem('ripley-theme', toLight ? 'light' : 'dark'); } catch { /* fine */ }
      });
    });
  });
})();
