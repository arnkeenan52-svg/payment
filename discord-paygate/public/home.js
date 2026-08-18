const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function load() {
  const me = await (await fetch('/api/me')).json().catch(() => ({ loggedIn: false }));

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

}

load().catch(() => {});
