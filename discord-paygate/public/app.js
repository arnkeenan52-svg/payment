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
  const active = me.subscriptions.length
    ? `<span class="badge">${me.subscriptions.map((s) => s.planName).join(' · ')}</span>`
    : '';
  el.innerHTML = `${active}<span>@${me.username ?? me.discordId}</span><button class="btn-ghost" id="logout">Sign out</button>`;
  $('#logout').onclick = () => (window.location.href = '/auth/logout');
}

function renderPlans(plans, me) {
  const owned = new Map((me.subscriptions ?? []).map((s) => [s.planId, s]));
  $('#plans').innerHTML = '';
  for (const plan of plans) {
    const sub = owned.get(plan.id);
    const card = document.createElement('article');
    card.className = 'plan';
    const status = sub
      ? `<p class="owned">${
          sub.lifetime
            ? 'Yours — lifetime'
            : sub.status === 'past_due'
              ? `Payment issue — access until ${fmtDate(sub.graceUntil)}`
              : `Active until ${fmtDate(sub.currentPeriodEnd)}`
        }</p>`
      : '';
    card.innerHTML = `
      <h2>${plan.name}</h2>
      <p class="desc">${plan.description}</p>
      <p class="price">$${plan.priceUsd}<small>${plan.lifetime ? 'once' : `/ ${plan.interval}`}</small></p>
      ${status}
      <div class="ctas">
        <button class="cta-card">Pay with card</button>
        <button class="cta-crypto">Pay with crypto</button>
      </div>`;
    const [cardBtn, cryptoBtn] = card.querySelectorAll('button');
    cardBtn.onclick = () => checkout('stripe', plan.id, cardBtn);
    cryptoBtn.onclick = () => checkout('coinbase', plan.id, cryptoBtn);
    $('#plans').append(card);
  }
}

async function main() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') === 'success') {
    const notice = document.createElement('p');
    notice.className = 'notice';
    notice.textContent = 'Payment received — your role lands the moment the provider confirms (crypto can take a few minutes).';
    $('.hero').append(notice);
  }

  const [plansRes, meRes] = await Promise.all([fetch('/api/plans'), fetch('/api/me')]);
  const { plans } = await plansRes.json();
  const me = await meRes.json();
  renderAccount(me);
  renderPlans(plans, me);
}

main();
