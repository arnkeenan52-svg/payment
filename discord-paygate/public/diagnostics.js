const $ = (sel) => document.querySelector(sel);

// Owner-only view of the setup doctor. The API decides authorization: the
// full report only comes back when the signed-in Discord user matches
// OWNER_DISCORD_ID (or the caller holds the CRON_SECRET). Reports contain
// masked prefixes only — secrets never reach this page.

const ICON = { pass: '✓', fail: '✕', warn: '!', skip: '–' };

function renderAccount(me) {
  const el = $('#account');
  if (!me.loggedIn) {
    el.innerHTML = '<button class="btn-pill" id="login">Sign in with Discord</button>';
    $('#login').onclick = () => (window.location.href = '/auth/login');
    return;
  }
  el.innerHTML = `<span>@${me.username ?? me.discordId}</span><button class="btn-ghost" id="logout">Sign out</button>`;
  $('#logout').onclick = () => (window.location.href = '/auth/logout');
}

function renderReport(report) {
  const counts = report.checks.reduce((acc, c) => ((acc[c.status] = (acc[c.status] ?? 0) + 1), acc), {});
  $('#diag-summary').textContent = report.ok
    ? `All checks passing — safe to take payments. (${counts.pass ?? 0} passed, ${counts.warn ?? 0} warnings)`
    : `${counts.fail ?? 0} check(s) failing — do NOT take payments until fixed: buyers would be charged and the role grant would fail.`;

  const body = $('#diag-body');
  body.innerHTML = '';

  const rerun = document.createElement('button');
  rerun.className = 'btn-pill';
  rerun.textContent = 'Re-run checks';
  rerun.style.alignSelf = 'flex-start';
  rerun.onclick = async () => {
    rerun.disabled = true;
    rerun.textContent = 'Running…';
    await load(true);
  };
  body.append(rerun);

  for (const c of report.checks) {
    const row = document.createElement('section');
    row.className = `panel diag-row diag-${c.status}`;
    const fix = c.fix ? `<p class="diag-fix">FIX: ${escapeHtml(c.fix)}</p>` : '';
    row.innerHTML = `
      <p class="diag-name"><span class="diag-icon">${ICON[c.status] ?? '?'}</span>${escapeHtml(c.name)}<span class="diag-status">${c.status.toUpperCase()}</span></p>
      <p class="diag-detail">${escapeHtml(c.detail ?? '')}</p>
      ${fix}`;
    body.append(row);
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function renderDenied(me) {
  $('#diag-summary').textContent = 'This view is for the store owner.';
  $('#diag-body').innerHTML = me.loggedIn
    ? `<div class="callout pending">Signed in as @${escapeHtml(me.username ?? me.discordId)} — not the configured owner. Set OWNER_DISCORD_ID to your Discord user id in the environment to unlock this page.</div>`
    : '<div class="callout pending">Sign in with Discord (top right) as the store owner to see the setup report.</div>';
}

// ── plan role picker ──────────────────────────────────────────────────────────
// The deployment already holds a valid bot token and guild id, so the guild's
// roles are fetched server-side and picked here — no hand-copied snowflakes.
// Roles the bot cannot grant are flagged with the reason.

async function renderPicker() {
  const res = await fetch('/api/admin/roles');
  if (!res.ok) return; // not the owner (or roles unavailable) — checks table already explains
  const data = await res.json();

  const box = document.createElement('section');
  box.className = 'panel picker';
  const current = data.plans
    .map((p) => `${escapeHtml(p.name)} → ${p.roleNames.length ? escapeHtml(p.roleNames.join(', ')) : p.roleIds.join(', ')}${p.source === 'override' ? ' (picked)' : ' (from plans.json)'}`)
    .join(' · ');
  box.innerHTML = `
    <p class="label">Plan role — pick the role buyers receive</p>
    <p class="diag-detail" style="padding-left:0">Current: ${current}. The bot's top role is
      "${escapeHtml(data.botTop.name)}" (position ${data.botTop.position}); greyed roles sit at or above it or can't be granted.</p>
    <div class="role-list"></div>`;
  const list = box.querySelector('.role-list');

  for (const role of data.roles) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `role-row${role.usable ? '' : ' unusable'}`;
    row.disabled = !role.usable;
    row.innerHTML = `
      <span class="role-dot" style="background:${role.color ?? '#4a4a4a'}"></span>
      <span class="role-name">${escapeHtml(role.name)}</span>
      <span class="role-pos">pos ${role.position}</span>
      ${role.usable ? '<span class="role-use">Use for Premium</span>' : `<span class="role-why">${escapeHtml(role.reason)}</span>`}`;
    if (role.usable) {
      row.onclick = async () => {
        row.disabled = true;
        const resp = await fetch('/api/admin/plan-role', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ planId: data.plans[0].id, roleId: role.id }),
        });
        const out = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          alert(out.error ?? 'could not set the role');
          row.disabled = false;
          return;
        }
        await load(true); // re-run the doctor so the verdicts update immediately
      };
    }
    list.append(row);
  }
  $('#diag-body').append(box);
}

let me = { loggedIn: false };

async function load(fresh = false) {
  const report = await (await fetch(`/api/setup-check${fresh ? '?fresh=1' : ''}`)).json();
  if (Array.isArray(report.checks)) {
    renderReport(report);
    await renderPicker();
  } else {
    renderDenied(me);
  }
}

async function main() {
  me = await (await fetch('/api/me')).json();
  renderAccount(me);
  await load();
}

main();
