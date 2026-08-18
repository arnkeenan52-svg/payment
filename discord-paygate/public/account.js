const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (unix) => new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

let server = null;

function statusChip(sub) {
  if (sub.lifetime) return '<span class="chip chip-good">Lifetime</span>';
  if (sub.status === 'past_due') return '<span class="chip chip-warn">Payment issue — in grace</span>';
  if (sub.entitled) return '<span class="chip chip-good">Active</span>';
  if (sub.status === 'canceled') return '<span class="chip chip-off">Canceled</span>';
  return '<span class="chip chip-off">Expired</span>';
}

function subCard(sub) {
  const expiry = sub.lifetime
    ? 'Lifetime access — never expires. Nothing to manage, nothing renews.'
    : sub.entitled
      ? `Access until ${fmtDate(sub.graceUntil ?? sub.currentPeriodEnd)}`
      : `Ended ${sub.currentPeriodEnd ? fmtDate(sub.currentPeriodEnd) : ''}`;
  const roles = sub.roleNames?.length ? `<div class="kv"><span>Discord role</span><span>${esc(sub.roleNames.join(', '))}</span></div>` : '';
  return `
    <section class="panel sub-card">
      <div class="sub-head">
        <h2>${esc(sub.planName)}</h2>
        ${statusChip(sub)}
      </div>
      <div class="kv"><span>Server</span><span>${esc(server?.name ?? 'Discord server')}</span></div>
      <div class="kv"><span>Purchased</span><span>${fmtDate(sub.createdAt)}</span></div>
      ${roles}
      <p class="note-help">${expiry}</p>
    </section>`;
}

async function resync() {
  const btn = $('#resync');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  const note = $('#resync-note');
  try {
    const res = await fetch('/api/resync', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Sync failed — try again in a minute.');
    const changed = (data.added?.length ?? 0) + (data.removed?.length ?? 0);
    note.textContent = data.joined
      ? 'You were added to the server with your role. Check Discord!'
      : changed
        ? 'Fixed! Your Discord roles were updated.'
        : 'Everything already matches — your access is in order.';
  } catch (err) {
    note.textContent = err.message;
  }
  btn.disabled = false;
  btn.textContent = 'Re-sync my access';
}

async function load() {
  const [meRes, plansRes] = await Promise.all([fetch('/api/me'), fetch('/api/plans')]);
  const me = await meRes.json();
  server = (await plansRes.json()).server ?? null;
  const el = $('#content');

  const account = $('#account');
  if (me.loggedIn) {
    account.innerHTML = `<a class="nav-link" href="/store">Store</a>${me.isOwner ? '<a class="nav-link" href="/dashboard">Dashboard</a>' : ''}<span>@${esc(me.username ?? me.discordId)}</span><button class="btn-ghost" id="logout">Sign out</button>`;
    $('#logout').onclick = () => (window.location.href = '/auth/logout');
  } else {
    account.innerHTML = '<a class="nav-link" href="/store">Store</a>';
  }

  if (!me.loggedIn) {
    el.innerHTML = `
      <section class="panel sub-card">
        <p class="note-help">Sign in with Discord to see and manage your membership.</p>
        <button class="btn-pill" id="login">Sign in with Discord</button>
      </section>`;
    $('#login').onclick = () => (window.location.href = '/auth/login');
    return;
  }

  const subs = me.subscriptions ?? [];
  if (!subs.length) {
    el.innerHTML = `
      <section class="panel sub-card">
        <p class="note-help">No membership on this account yet.</p>
        <a class="btn-pill" style="display:inline-block;text-decoration:none" href="/store">Get Premium →</a>
      </section>`;
    return;
  }

  el.innerHTML = `
    ${subs.map(subCard).join('')}
    <section class="panel sub-card">
      <h2>Missing your role?</h2>
      <p class="note-help">If your Discord role ever goes missing, one click puts everything back the way it should be.</p>
      <button class="btn-pill" id="resync">Re-sync my access</button>
      <p class="note-help" id="resync-note"></p>
    </section>`;
  $('#resync').onclick = resync;
}

load().catch(() => {
  $('#content').innerHTML = '<section class="panel sub-card"><p class="note-help">Could not load your account — refresh to try again.</p></section>';
});
