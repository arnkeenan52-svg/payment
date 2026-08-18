const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (unix) =>
  new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
  ' ' + new Date(unix * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function chip(row) {
  if (row.lifetime) return '<span class="chip chip-good">Lifetime</span>';
  if (row.status === 'past_due') return '<span class="chip chip-warn">Past due</span>';
  if (row.entitled) return '<span class="chip chip-good">Active</span>';
  if (row.status === 'canceled') return '<span class="chip chip-off">Canceled</span>';
  return '<span class="chip chip-off">Expired</span>';
}

function render(data) {
  const t = data.totals;
  const rows = data.payments
    .map(
      (p) => `<tr>
        <td>${fmtDate(p.createdAt)}</td>
        <td>${p.username ? '@' + esc(p.username) : ''}<span class="dim"> ${esc(p.discordId)}</span></td>
        <td>${esc(p.planName)}</td>
        <td class="num">${usd(p.amountUsd)}</td>
        <td>${esc(p.provider)}</td>
        <td>${chip(p)}</td>
      </tr>`,
    )
    .join('');
  $('#content').innerHTML = `
    <div class="stat-grid">
      <div class="panel stat"><span class="stat-label">All-time payments</span><span class="stat-value">${usd(t.allTimeUsd)}</span></div>
      <div class="panel stat"><span class="stat-label">Purchases</span><span class="stat-value">${t.payments}</span></div>
      <div class="panel stat"><span class="stat-label">Active members</span><span class="stat-value">${t.activeMembers}</span></div>
      <div class="panel stat"><span class="stat-label">Lifetime members</span><span class="stat-value">${t.lifetimeMembers}</span></div>
    </div>
    <section class="panel table-panel">
      <p class="label">Payments</p>
      ${data.payments.length ? `<div class="table-scroll"><table class="data-table">
        <thead><tr><th>Date</th><th>Buyer</th><th>Plan</th><th class="num">Amount</th><th>Via</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>` : '<p class="note-help">No payments yet — share your store link to make the first sale.</p>'}
    </section>`;
}

function denied(status) {
  $('#content').innerHTML = `
    <section class="panel sub-card">
      <p class="note-help">${status === 401 ? 'Sign in with the owner Discord account to see the dashboard.' : 'This page is for the store owner only.'}</p>
      ${status === 401 ? '<button class="btn-pill" id="login">Sign in with Discord</button>' : ''}
    </section>`;
  const login = $('#login');
  if (login) login.onclick = () => (window.location.href = '/auth/login');
}

async function load() {
  const res = await fetch('/api/admin/payments');
  if (!res.ok) {
    denied(res.status);
    return;
  }
  render(await res.json());
}

load().catch(() => {
  $('#content').innerHTML = '<section class="panel sub-card"><p class="note-help">Could not load the dashboard — refresh to try again.</p></section>';
});
