const $ = (sel) => document.querySelector(sel);

const fmtDate = (unix) =>
  new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

async function checkout(kind, planId, button) {
  button.disabled = true;
  try {
    const res = await fetch(`/api/checkout/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId }),
    });
    const data = await res.json();
    if (res.status === 401) {
      window.location.href = '/auth/login';
      return;
    }
    if (!res.ok || !data.url) throw new Error(data.error || 'checkout failed');
    window.location.href = data.url;
  } catch (err) {
    alert(err.message);
    button.disabled = false;
  }
}

function renderAccount(me) {
  const el = $('#account');
  if (!me.loggedIn) {
    el.innerHTML = '<button class="btn-login" id="login">Sign in with Discord</button>';
    $('#login').onclick = () => (window.location.href = '/auth/login');
    return;
  }
  const entitled = me.subscriptions.filter((s) => s.entitled);
  const active = entitled.length
    ? `<span class="badge">${entitled.map((s) => s.planName).join(' · ')}</span>`
    : '';
  el.innerHTML = `${active}<span>@${me.username ?? me.discordId}</span><button class="btn-ghost" id="logout">Sign out</button>`;
  $('#logout').onclick = () => (window.location.href = '/auth/logout');
}

function renderPlans(plans, me, capabilities) {
  // One sub per plan card: a live subscription beats a lapsed one.
  const owned = new Map();
  for (const s of me.subscriptions ?? []) {
    const cur = owned.get(s.planId);
    if (!cur || (s.entitled && !cur.entitled)) owned.set(s.planId, s);
  }
  $('#plans').innerHTML = '';
  for (const plan of plans) {
    const sub = owned.get(plan.id);
    const card = document.createElement('article');
    card.className = 'plan';
    const status = sub
      ? sub.entitled
        ? `<p class="owned">${
            sub.lifetime
              ? 'Yours — lifetime'
              : sub.status === 'past_due'
                ? `Payment issue — access until ${fmtDate(sub.graceUntil)}`
                : `Active until ${fmtDate(sub.currentPeriodEnd)}`
          }</p>`
        : `<p class="owned lapsed">${
            sub.status === 'canceled' ? 'Cancelled — rejoin below' : `Expired ${fmtDate(sub.currentPeriodEnd)} — buy again below`
          }</p>`
      : '';
    // A lifetime plan the member already owns has nothing to buy, renew or
    // manage — show that instead of payment buttons.
    const ownedForever = Boolean(sub?.entitled && sub.lifetime);
    card.innerHTML = `
      <h2>${plan.name}</h2>
      <p class="desc">${plan.description}</p>
      <p class="price">$${plan.priceUsd}<small>${plan.lifetime ? 'one-time · lifetime access' : `/ ${plan.interval}`}</small></p>
      ${status}
      ${ownedForever
        ? '<p class="settled">Nothing to manage — your access never expires.</p>'
        : `<div class="ctas">
             ${capabilities.stripe ? '<button class="cta-card">Pay with card</button>' : ''}
             ${capabilities.crypto ? '<button class="cta-crypto">Pay with crypto</button>' : ''}
           </div>`}`;
    if (!ownedForever) {
      const cardBtn = card.querySelector('.cta-card');
      const cryptoBtn = card.querySelector('.cta-crypto');
      if (cardBtn) cardBtn.onclick = () => checkout('stripe', plan.id, cardBtn);
      if (cryptoBtn) cryptoBtn.onclick = () => checkout('coinbase', plan.id, cryptoBtn);
    }
    $('#plans').append(card);
  }
}

// One clear banner when the setup doctor is failing — a misconfigured
// deployment must never quietly accept money. The public endpoint returns
// only { ok }, no configuration detail.
async function checkSetup() {
  try {
    const { ok } = await (await fetch('/api/setup-check')).json();
    if (ok === false) {
      const banner = document.createElement('div');
      banner.className = 'doctor-banner';
      banner.textContent =
        '⚠ This store is misconfigured — payments may be charged without access being granted. ' +
        'Owner: run `npm run doctor` (or GET /api/setup-check with your CRON_SECRET) and fix the failures before selling.';
      document.body.prepend(banner);
    }
  } catch {
    /* the storefront still works if the check itself is unreachable */
  }
}

async function main() {
  checkSetup();
  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') === 'success') {
    const notice = document.createElement('p');
    notice.className = 'notice';
    notice.textContent = 'Payment received — your role lands the moment the provider confirms (crypto can take a few minutes).';
    $('.hero').append(notice);
  }

  const [plansRes, meRes] = await Promise.all([fetch('/api/plans'), fetch('/api/me')]);
  const { plans, capabilities } = await plansRes.json();
  const me = await meRes.json();
  renderAccount(me);
  renderPlans(plans, me, capabilities);
}

main();
