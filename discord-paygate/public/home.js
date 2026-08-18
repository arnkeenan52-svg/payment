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
      (me.isOwner ? '<a class="nav-link" href="/dashboard">Dashboard</a>' : '') +
      `<span>@${esc(me.username ?? me.discordId)}</span><button class="btn-ghost" id="logout">Sign out</button>`;
    $('#logout').onclick = () => (window.location.href = '/auth/logout');
  } else {
    account.innerHTML =
      '<a class="nav-link" href="/store">Store</a><button class="btn-pill" id="login">Sign in with Discord</button>';
    $('#login').onclick = () => (window.location.href = '/auth/login');
  }

  // Live store card: the real server (name + icon) and the real price.
  const plan = data?.plans?.[0];
  if (plan) {
    const card = $('#store-card');
    card.hidden = false;
    $('#store-name').textContent = data.server?.name ?? plan.name;
    $('#store-desc').textContent = `${plan.name} — ${plan.description}`;
    $('#store-cta').textContent = `Get ${plan.name} · $${plan.priceUsd}`;
    $('#hero-buy').textContent = `Get ${plan.name} · $${plan.priceUsd} →`;
    // Only the server's real Discord icon is ever shown — no stand-in logo.
    if (data.server?.iconUrl) {
      const icon = $('#store-icon');
      icon.src = data.server.iconUrl;
      icon.alt = data.server?.name ?? '';
      icon.hidden = false;
    }
  }
}

load().catch(() => {});
