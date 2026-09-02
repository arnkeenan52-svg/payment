const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Sign out is a POST: the session cookie rides on cross-site GETs, so a
// GET link could be fired by any third-party page (see api/auth/logout.js).
const signOut = () => {
  const f = document.createElement('form');
  f.method = 'post';
  f.action = '/auth/logout';
  document.body.appendChild(f);
  f.submit();
};
const fmtDate = (unix) => new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

let server = null;

function statusChip(sub) {
  if (sub.lifetime) return '<span class="chip chip-good">Lifetime</span>';
  if (sub.status === 'past_due') return '<span class="chip chip-warn">Payment issue — in grace</span>';
  if (sub.cancelsAt && sub.entitled) return '<span class="chip chip-warn">Ending</span>';
  if (sub.entitled) return '<span class="chip chip-good">Active</span>';
  if (sub.status === 'canceled') return '<span class="chip chip-off">Canceled</span>';
  return '<span class="chip chip-off">Expired</span>';
}

function subCard(sub) {
  const expiry = sub.lifetime
    ? 'Lifetime access — never expires. Nothing to manage, nothing renews.'
    : sub.cancelsAt
      ? `Cancelled. Your access runs until ${fmtDate(sub.cancelsAt)}, then the role is removed. Nothing further will be charged.`
      : sub.entitled
        ? `Renews ${fmtDate(sub.graceUntil ?? sub.currentPeriodEnd)}`
        : `Ended ${sub.currentPeriodEnd ? fmtDate(sub.currentPeriodEnd) : ''}`;
  const roles = sub.roleNames?.length ? `<div class="kv"><span>Discord role</span><span>${esc(sub.roleNames.map((r) => `@${String(r ?? '').replace(/^@+/, '')}`).join(', '))}</span></div>` : '';
  // Cancelling is the buyer's own to do. Hiding it behind "email the owner"
  // is how you end up with chargebacks instead of cancellations.
  const cancel = sub.cancellable
    ? `<div class="sub-actions">
         <button class="btn-ghost btn-danger" data-cancel="${esc(sub.ref)}">Cancel membership</button>
         <span class="note-help sub-cancel-note" data-note="${esc(sub.ref)}" role="status"></span>
       </div>`
    : '';
  return `
    <section class="panel sub-card">
      <div class="sub-head">
        <h2>${esc(sub.planName)}</h2>
        ${statusChip(sub)}
      </div>
      <div class="kv"><span>Server</span><span>${esc(sub.storeName ?? server?.name ?? 'Discord server')}</span></div>
      <div class="kv"><span>Purchased</span><span>${fmtDate(sub.createdAt)}</span></div>
      ${roles}
      <p class="note-help">${expiry}</p>
      ${cancel}
    </section>`;
}

async function cancelSub(btn) {
  const ref = btn.dataset.cancel;
  const note = document.querySelector(`[data-note="${CSS.escape(ref)}"]`);
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = 'Confirm cancel';
    if (note) note.textContent = 'You keep access until the end of the period you already paid for.';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Cancelling…';
  try {
    const res = await fetch('/api/subscription', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', subscriptionRef: ref }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not cancel just now.');
    await load();
  } catch (err) {
    btn.disabled = false;
    btn.dataset.confirm = '';
    btn.textContent = 'Cancel membership';
    if (note) note.textContent = err.message;
  }
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
    account.innerHTML = `${me.isOwner || me.seller ? '<a class="nav-link" href="/dashboard">Dashboard</a>' : ''}<span>@${esc(me.username ?? me.discordId)}</span><button class="btn-ghost" id="logout">Sign out</button>`;
    $('#logout').onclick = signOut;
  } else {
    account.innerHTML = '';
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
        <p class="note-help">No membership on this account yet. Buy through a server's store link and it will appear here.</p>
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
  el.querySelectorAll('[data-cancel]').forEach((b) => { b.onclick = () => cancelSub(b); });
}

load().catch(() => {
  $('#content').innerHTML = '<section class="panel sub-card"><p class="note-help">Could not load your account — refresh to try again.</p></section>';
});
