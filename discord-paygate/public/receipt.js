const $ = (sel) => document.querySelector(sel);
const fmtPrice = (usd) => `$${usd.toFixed(2)}`;

// Success is only claimed once the role has actually landed: we poll /api/me
// until the plan's subscription shows up entitled (the webhook grants it
// within seconds; Stripe redirects can outrun it).
const POLL_MS = 2000;
const GIVE_UP_MS = 90 * 1000;

function renderAccount(me) {
  const el = $('#account');
  if (!me.loggedIn) {
    el.innerHTML = '<button class="btn-ghost" id="login">Sign in with Discord</button>';
    $('#login').onclick = () => (window.location.href = '/auth/login');
    return;
  }
  el.innerHTML = `<span>@${String(me.username ?? me.discordId).replace(/[&<>"']/g, '')}</span>`;
}

const serverLabel = (server) => server.name || 'the server';

function showConfirmed(plan, server) {
  $('#check-ring').classList.remove('pending');
  $('#r-heading').textContent = 'Thank you for your purchase';
  $('#r-sub').textContent = 'Payment confirmed — welcome in.';
  const roles = plan.roleNames.length ? plan.roleNames.join(', ') : 'Your role';
  const callout = $('#r-callout');
  callout.classList.remove('pending');
  callout.textContent = `${roles} was assigned automatically — your channels in ${serverLabel(server)} are unlocked.`;
}

function showStillPending(server) {
  $('#r-sub').textContent = 'Payment received — your role is on its way.';
  $('#r-callout').textContent =
    `This is taking a little longer than usual. Your role lands automatically as soon as the payment ` +
    `provider confirms — no action needed. Check ${serverLabel(server)} again in a minute.`;
}

async function main() {
  const STORE_SLUG = new URLSearchParams(location.search).get('store') ?? '';
  const storeQS = /^[a-z0-9-]{1,40}$/.test(STORE_SLUG) ? `?store=${encodeURIComponent(STORE_SLUG)}` : '';
  // Back to THIS buyer's store; /store stays as the legacy-redirect fallback.
  if (storeQS) {
    const back = document.getElementById('back-store');
    if (back) back.href = `/${encodeURIComponent(STORE_SLUG)}`;
  }
  const [plansRes, meRes] = await Promise.all([fetch(`/api/plans${storeQS}`), fetch('/api/me')]);
  const { plans, server } = await plansRes.json();
  let me = await meRes.json();
  renderAccount(me);

  const requested = new URLSearchParams(window.location.search).get('plan');
  const plan = plans.find((p) => p.id === requested) ?? plans[0];
  if (!plan) return;

  $('#r-server').textContent = server.name || '—';
  $('#r-product').textContent = plan.name;
  $('#r-option').textContent = plan.lifetime ? 'One-time — lifetime access' : `Recurring — per ${plan.interval}`;
  $('#r-total').textContent = fmtPrice(plan.priceUsd);
  $('#open-discord-label').textContent = server.name ? `Open ${server.name} on Discord` : 'Open Discord';
  if (server.guildId) $('#open-discord').href = `https://discord.com/channels/${server.guildId}`;

  const entitled = () => (me.subscriptions ?? []).some((s) => s.planId === plan.id && s.entitled);
  const started = Date.now();
  while (!entitled() && Date.now() - started < GIVE_UP_MS) {
    if (!me.loggedIn) break; // can't observe the grant without a session — stay in pending copy
    await new Promise((r) => setTimeout(r, POLL_MS));
    me = await (await fetch('/api/me')).json();
  }

  if (entitled()) showConfirmed(plan, server);
  else showStillPending(server);
}

main();
