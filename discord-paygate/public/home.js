const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function load() {
  const [meRes, plansRes] = await Promise.all([fetch('/api/me'), fetch('/api/plans')]);
  const me = await meRes.json().catch(() => ({ loggedIn: false }));
  const data = await plansRes.json().catch(() => null);

  const account = $('#account');
  if (me.loggedIn) {
    account.innerHTML =
      `<a class="nav-link" href="/store">Store</a>` +
      `<a class="nav-link" href="/account">Account</a>` +
      `<a class="nav-link" href="/dashboard">Dashboard</a>` +
      `<span>@${esc(me.username ?? me.discordId)}</span><button class="btn-ghost" id="logout">Sign out</button>`;
    $('#logout').onclick = () => (window.location.href = '/auth/logout');
  } else {
    account.innerHTML =
      '<a class="nav-link" href="/store">Store</a><button class="btn-pill" id="login">Sign in with Discord</button>';
    $('#login').onclick = () => (window.location.href = '/auth/login');
  }

  // Point "Visit a live store" at the featured store with its real name.
  const server = data?.server;
  const link = $('#hero-store');
  if (link && server?.name) link.textContent = `Visit ${server.name}`;
}

load().catch(() => {});
