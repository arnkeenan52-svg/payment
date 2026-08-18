// Static SEO page generator: comparison pages (/vs/*), fee calculators
// (/tools/*) and use-case pages (/use-cases/*), plus sitemap.xml and
// robots.txt. Pages are committed build artifacts — Vercel serves public/
// as-is, so run `node scripts/gen-seo-pages.mjs` after editing and commit
// the output.
//
// Content rules: every competitor number is their PUBLICLY LISTED pricing,
// always asterisked to "check their site"; Ripley claims only what the
// product actually does. No fabricated testimonials, counts or reviews.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const BASE = 'https://www.ripleybot.com';
const V = '29'; // keep in step with the ?v= asset version on index.html

// Ripley plan facts (src/services/billing.js TIERS — keep in sync).
const RIPLEY_TIERS = [
  { name: 'Free', priceUsd: 0, maxMembers: 10 },
  { name: 'Starter', priceUsd: 5.99, maxMembers: 50 },
  { name: 'Growth', priceUsd: 19.99, maxMembers: 500 },
  { name: 'Scale', priceUsd: 49.99, maxMembers: null },
];

// Competitors, with the same publicly-listed numbers the homepage calculator
// uses. `cost(revenue)` = their monthly platform cost at that sales volume.
const COMPETITORS = {
  whop: {
    name: 'Whop',
    feeLine: '3% of sales + payout fees*',
    cost: (rev) => rev * 0.03,
    blurb:
      'Whop is a marketplace: your store lives on whop.com, buyers check out through Whop, and Whop takes a percentage of every sale before paying you out.',
    rows: { fee: '3% of every sale*', monthly: '$0 base', money: 'Held by the platform, paid out to you', store: 'whop.com marketplace page' },
  },
  launchpass: {
    name: 'LaunchPass',
    feeLine: '$29/mo + 3.5% of sales*',
    cost: (rev) => 29 + rev * 0.035,
    blurb:
      'LaunchPass charges a monthly subscription AND a percentage of your sales on its Premium plan, with checkout running through their Stripe integration.',
    rows: { fee: '3.5% of every sale*', monthly: 'From $29/mo*', money: 'Your Stripe account', store: 'launchpass.com page' },
  },
  patreon: {
    name: 'Patreon',
    feeLine: '8–12% of earnings*',
    cost: (rev) => rev * 0.08,
    blurb:
      'Patreon takes 8–12% of everything you earn, owns the relationship with your members, and Discord access is bolted on through its own integration.',
    rows: { fee: '8–12% of earnings*', monthly: '$0 base', money: 'Held by the platform, paid out to you', store: 'patreon.com creator page' },
  },
  'upgrade-chat': {
    name: 'Upgrade.Chat',
    feeLine: '$49/mo paid plan*',
    cost: () => 49,
    blurb:
      'Upgrade.Chat is a Discord payment bot with free and paid plans — going featureful means a monthly platform subscription.',
    rows: { fee: 'Plan-dependent*', monthly: 'Paid plan from $49/mo*', money: 'Your PayPal/Stripe account', store: 'upgrade.chat page' },
  },
  memberful: {
    name: 'Memberful',
    feeLine: '$25/mo + 4.9% transaction fee*',
    cost: (rev) => 25 + rev * 0.049,
    blurb:
      'Memberful is membership software for websites first — Discord comes via an integration, and its listed pricing pairs a monthly plan with a per-transaction percentage.',
    rows: { fee: '4.9% of every sale*', monthly: 'From $25/mo*', money: 'Your Stripe account', store: 'Your website + Memberful checkout' },
  },
  'mighty-networks': {
    name: 'Mighty Networks',
    feeLine: 'from $41/mo*',
    cost: (rev) => 41 + rev * 0.02,
    blurb:
      'Mighty Networks is a whole community platform meant to replace Discord, not power it — you move your community there and pay a monthly platform subscription.',
    rows: { fee: 'Plan-dependent*', monthly: 'From $41/mo*', money: 'Paid out via their processor', store: 'A Mighty Network (not Discord)' },
  },
};

const USE_CASES = {
  trading: {
    name: 'Trading Communities',
    h1: 'Sell Access to Your Trading Discord',
    desc: 'Charge for your trading signals, analysis channels and mentorship with 0% platform fees. Payments go straight to your own Stripe account.',
    intro:
      'Signal groups, futures rooms, options flow, crypto research — if your calls are worth following, they are worth paying for. Ripley puts a checkout in front of your premium channels and delivers the member role the second payment clears.',
    points: [
      ['Premium role, instantly', 'Buyers get the role that unlocks your signals channels within seconds of paying.'],
      ['Monthly or lifetime', 'Sell a monthly membership, a lifetime seat, or both at different prices.'],
      ['Access that heals itself', 'If a subscription lapses, the role comes off automatically — no manual pruning.'],
    ],
    faq: [
      ['Do I need my own Stripe account?', 'Yes — that is the point. Every payment lands directly in your own Stripe account. Ripley never holds your money.'],
      ['What happens when a member cancels?', 'When the subscription ends, Ripley removes the paid role automatically. Members in good standing are re-checked hourly.'],
      ['Can I charge different prices for different channels?', 'Yes. Each product maps to its own Discord role, so you can sell tiered access at different prices.'],
    ],
  },
  'sports-betting': {
    name: 'Sports Picks Communities',
    h1: 'Sell Memberships to Your Sports Picks Discord',
    desc: 'Monetize your sports handicapping community with 0% platform fees, instant role delivery and payments straight to your own Stripe account.',
    intro:
      'Cappers live and die by their record — your revenue should not also die by platform fees. Ripley gates your picks channels behind a clean checkout, keeps 0% of your sales, and removes access automatically when a subscription lapses.',
    points: [
      ['Gate your picks channels', 'Free lobby for the record, paid role for the plays. Buyers unlock instantly.'],
      ['Weekly-equivalent pricing', 'Sell monthly memberships at any price point, or lifetime seats for your core group.'],
      ['Discount codes', 'Run promos with percentage or fixed-amount codes, capped and expiring however you like.'],
    ],
    faq: [
      ['Does Ripley take a cut of sales?', 'No. Ripley charges a flat monthly plan and takes 0% of your sales. Stripe’s standard card fees still apply, as they do everywhere.'],
      ['How fast do buyers get access?', 'The role is delivered the moment Stripe confirms payment — typically within a couple of seconds.'],
      ['Can I remove someone manually?', 'Yes — revoke from the dashboard and the role comes off immediately.'],
    ],
  },
  fitness: {
    name: 'Fitness & Coaching',
    h1: 'Sell Your Coaching Community on Discord',
    desc: 'Turn your fitness coaching Discord into a paid membership with 0% platform fees and automatic role delivery.',
    intro:
      'Programming channels, check-in threads, form review, accountability groups — coaching happens in Discord already. Ripley adds the paywall: members pay on a hosted checkout and get their client role instantly.',
    points: [
      ['Client-only channels', 'Map each membership to a role that unlocks your coaching channels.'],
      ['Subscriptions that renew', 'Monthly billing through Stripe, cancellations handled automatically.'],
      ['A store page that looks like you', 'Your server name, icon and product photos on your own link.'],
    ],
    faq: [
      ['Can I sell one-off programs too?', 'Yes — products can be one-time purchases with lifetime access, or time-boxed memberships.'],
      ['Do buyers need to be in my server first?', 'No. Buyers who are not in the server yet are pulled in automatically with their role attached.'],
      ['What do receipts look like?', 'Every buyer gets a clean membership-confirmation email automatically after checkout.'],
    ],
  },
  reselling: {
    name: 'Reselling & Cook Groups',
    h1: 'Sell Access to Your Cook Group',
    desc: 'Monetize your reselling Discord — monitors, guides and restock alerts — with 0% platform fees and instant role delivery.',
    intro:
      'Monitors, sitelists, restock pings and flip guides are only valuable while they are fast — your checkout should be too. Ripley delivers the member role seconds after payment and takes 0% of your sales.',
    points: [
      ['Limited seats', 'Set a purchase limit on any product and Ripley stops selling when it is full.'],
      ['Renewals enforced', 'Lapsed subscriptions lose the role automatically — no freeloaders in your pings.'],
      ['Restocks on your terms', 'Toggle a product off to close the group; back on to reopen. The link never changes.'],
    ],
    faq: [
      ['Can I cap how many people join?', 'Yes — purchase limits per product. When it sells out, checkout closes on its own.'],
      ['Can I run renewal pricing?', 'Sell monthly subscriptions through Stripe; renewals bill automatically until cancelled.'],
      ['What if I need to reset access?', 'Revoke or re-sync any member from the dashboard in one click.'],
    ],
  },
  ecommerce: {
    name: 'Ecommerce Mentorship',
    h1: 'Sell Your Ecommerce Mentorship on Discord',
    desc: 'Charge for your dropshipping or ecom mentorship community with 0% platform fees and payments straight to your Stripe account.',
    intro:
      'Product research channels, supplier contacts, store teardowns, weekly Q&A — the mentorship already lives in your server. Ripley adds the payment layer without taking a cut of it.',
    points: [
      ['Tiered mentorship', 'Sell basic and inner-circle tiers as separate products with separate roles.'],
      ['Your own Stripe account', 'Revenue lands in your Stripe directly. Ripley never touches your money.'],
      ['Analytics built in', 'Revenue, sales and member growth with previous-period comparisons.'],
    ],
    faq: [
      ['How do tiers work?', 'Each product grants its own role. Stack channels behind roles however you like.'],
      ['Can I offer a founding-member discount?', 'Yes — create a discount code with a use cap and expiry.'],
      ['Is there a free plan?', 'Yes. Ripley is free until your store passes 10 paying members.'],
    ],
  },
  'exclusive-content': {
    name: 'Exclusive Content',
    h1: 'Sell Exclusive Content in Your Discord',
    desc: 'Put your exclusive drops, early access and behind-the-scenes channels behind a paid Discord role — 0% platform fees.',
    intro:
      'Early videos, extended cuts, sample packs, presets, art drops — creators run exclusives through Discord because that is where the community already is. Ripley gates those channels with a role your fans buy in one checkout.',
    points: [
      ['One link to share', 'ripleybot.com/yourname — put it in every bio. It is your store.'],
      ['Lifetime or recurring', 'Sell a one-time supporter pass or a monthly membership.'],
      ['Fans stay yours', 'No marketplace between you and your audience — buyers check out under your name.'],
    ],
    faq: [
      ['Do I need a website?', 'No. Your Ripley store page is hosted for you at your own link with your name and icon.'],
      ['What does Ripley cost?', 'Free for your first 10 paying members, then flat plans from $5.99/mo. Ripley takes 0% of sales.'],
      ['Can fans pay with Apple Pay?', 'Checkout is Stripe-hosted — cards, Apple Pay, Google Pay and Link, per your Stripe settings.'],
    ],
  },
};

// ── shared page chrome ────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const nav = `
  <header class="top xoe-nav">
    <div class="top-left">
      <a href="/"><img class="platform-mark" src="/ripley.png" alt="Ripley" height="18" /></a>
    </div>
    <nav class="top-center" aria-label="Main">
      <a class="nav-link" href="/#features">Features</a>
      <a class="nav-link" href="/#pricing">Pricing</a>
      <a class="nav-link" href="/vs">Compare</a>
      <a class="nav-link" href="/tools">Tools</a>
    </nav>
    <div class="account"><a class="btn-fill" href="/dashboard">Start free</a></div>
  </header>`;

export const footerHtml = `
  <footer class="site-footer cols seo-footer">
    <div class="footer-brand">
      <img class="powered-mark" src="/ripley.png" alt="Ripley" height="16" />
      <span class="footer-copy">© Ripley</span>
    </div>
    <nav class="footer-col"><span class="footer-head">Product</span>
      <a href="/#features">Features</a><a href="/#pricing">Pricing</a><a href="/#faq">FAQ</a>
      <a href="/dashboard">Dashboard</a><a href="/account">Your account</a></nav>
    <nav class="footer-col"><span class="footer-head">Compare</span>
      <a href="/vs/whop">Ripley vs Whop</a><a href="/vs/launchpass">Ripley vs LaunchPass</a>
      <a href="/vs/patreon">Ripley vs Patreon</a><a href="/vs/upgrade-chat">Ripley vs Upgrade.Chat</a>
      <a href="/vs/memberful">Ripley vs Memberful</a><a href="/vs/mighty-networks">Ripley vs Mighty Networks</a></nav>
    <nav class="footer-col"><span class="footer-head">Tools</span>
      <a href="/tools/discord-fee-calculator">Discord fee calculator</a>
      <a href="/tools/whop-fee-calculator">Whop fee calculator</a>
      <a href="/tools/launchpass-fee-calculator">LaunchPass fee calculator</a>
      <a href="/tools/patreon-fee-calculator">Patreon fee calculator</a></nav>
    <nav class="footer-col"><span class="footer-head">Use cases</span>
      <a href="/use-cases/trading">Trading signals</a><a href="/use-cases/sports-betting">Sports picks</a>
      <a href="/use-cases/fitness">Fitness coaching</a><a href="/use-cases/reselling">Cook groups</a>
      <a href="/use-cases/ecommerce">Ecommerce mentorship</a><a href="/use-cases/exclusive-content">Exclusive content</a></nav>
    <nav class="footer-col"><span class="footer-head">Legal</span><a href="/terms">Terms</a><a href="/privacy">Privacy</a></nav>
    <p class="footer-disclaimer">Not affiliated with Discord Inc. or any platform compared here. Competitor pricing as publicly listed — verify on their sites. Payments are processed by Stripe on each store owner’s own account.</p>
  </footer>`;

function page({ urlPath, title, desc, body, jsonld = [], crumbs = [] }) {
  const canonical = `${BASE}${urlPath}`;
  const breadcrumb = crumbs.length
    ? [{
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Ripley', item: `${BASE}/` }].concat(
          crumbs.map(([name, href], i) => ({ '@type': 'ListItem', position: i + 2, name, item: `${BASE}${href}` })),
        ),
      }]
    : [];
  const ld = [...breadcrumb, ...jsonld]
    .map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`)
    .join('\n  ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${canonical}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:image" content="${BASE}/shot-dashboard.png" />
  <meta property="og:url" content="${canonical}" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="stylesheet" href="/styles.css?v=${V}" />
  ${ld}
</head>
<body class="home seo-page">
${nav}
  <main class="landing">
${body}
  </main>
${footerHtml}
</body>
</html>
`;
}

const faqJsonld = (faq) => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
});

const faqHtml = (faq) => `
      <div class="wrap narrow">
        <h2 class="section-title center">Frequently asked</h2>
        <div class="faq">
          ${faq.map(([q, a]) => `<details class="panel faq-item"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n          ')}
        </div>
      </div>`;

const cta = (label = 'Start selling with 0% platform fees') => `
    <section class="xsection">
      <div class="wrap narrow center">
        <h2 class="section-title">${esc(label)}</h2>
        <p class="section-sub">Free for your first 10 paying members — no card required.</p>
        <p><a class="btn-fill btn-hero" href="/dashboard">Start free <span aria-hidden="true">→</span></a></p>
      </div>
    </section>`;

const ripleyRows = {
  fee: '0% — always',
  monthly: 'Free up to 10 paying members, then from $5.99/mo',
  money: 'Your own Stripe account, directly',
  store: 'ripleybot.com/yourname',
};

// ── /vs/<competitor> ──────────────────────────────────────────────────────────

function vsPage(slug, c) {
  const title = `Ripley vs ${c.name} — Discord monetization compared`;
  const desc = `${c.name} charges ${c.feeLine.replace('*', '')} — Ripley takes 0% of your sales and payments land in your own Stripe account. A side-by-side comparison for Discord server owners.`;
  const faq = [
    [`How much does ${c.name} cost compared to Ripley?`, `${c.name}'s publicly listed pricing is ${c.feeLine.replace('*', '')}. Ripley charges a flat plan (free up to 10 paying members, then from $5.99/mo) and takes 0% of your sales.`],
    ['Does Ripley really take 0% of sales?', 'Yes. Ripley charges a flat monthly plan only. Stripe’s standard card-processing fees still apply, as they do on every platform.'],
    ['Where does my money go with Ripley?', 'Straight into your own Stripe account. Ripley never holds, routes, or freezes your funds.'],
    ['Can I switch without losing my members?', 'Your members keep their Discord roles while you set Ripley up, and your Stripe customers stay in your own Stripe account either way.'],
  ];
  const row = (k, label) => `
            <tr><td>${esc(label)}</td><td class="cmp-good">${esc(ripleyRows[k])}</td><td>${esc(c.rows[k])}</td></tr>`;
  const body = `
    <section class="xhero seo-hero">
      <div class="hero-inner">
        <h1>Ripley vs ${esc(c.name)}</h1>
        <p class="hero-sub">${esc(c.blurb)}</p>
        <p class="hero-sub">Ripley is the other model: a flat plan, <strong>0% of your sales</strong>, and payments that land in <strong>your own Stripe account</strong> while roles are delivered automatically.</p>
      </div>
    </section>
    <section class="xsection">
      <div class="wrap narrow">
        <div class="panel cmp-card">
          <div class="table-scroll"><table class="cmp-table">
            <thead><tr><th></th><th>Ripley</th><th>${esc(c.name)}</th></tr></thead>
            <tbody>${row('fee', 'Platform fee on sales')}${row('monthly', 'Monthly cost')}${row('money', 'Where the money goes')}${row('store', 'Your store lives at')}
            <tr><td>Discord roles</td><td class="cmp-good">Delivered in seconds, removed on lapse</td><td>Varies by integration</td></tr>
            </tbody>
          </table></div>
          <p class="calc-note">* ${esc(c.name)} pricing as publicly listed — check their site for current numbers. Stripe’s standard card-processing fees apply on every platform.</p>
        </div>
      </div>
    </section>
    <section class="xsection">
      <div class="wrap narrow">
        <h2 class="section-title center">Why server owners pick Ripley</h2>
        <ul class="tick-list seo-ticks">
          <li><strong>0% platform fees</strong> — a flat plan, whatever you earn. Estimate the difference with the <a href="/tools/${slug === 'memberful' || slug === 'mighty-networks' || slug === 'upgrade-chat' ? 'discord' : slug}-fee-calculator">fee calculator</a>.</li>
          <li><strong>Your own Stripe account</strong> — revenue is never held or routed by a middleman.</li>
          <li><strong>Roles in seconds</strong> — payment clears, the role lands; lapses take it away automatically.</li>
          <li><strong>A real store page</strong> — your name, your icon, your products, at your own link.</li>
          <li><strong>No lock-in</strong> — your Stripe account, your customers, your data. Leave any time.</li>
        </ul>
      </div>
    </section>
    <section class="xsection">${faqHtml(faq)}</section>
${cta(`Switching from ${c.name}?`)}`;
  return page({
    urlPath: `/vs/${slug}`,
    title,
    desc,
    body,
    crumbs: [['Compare', '/vs'], [`Ripley vs ${c.name}`, `/vs/${slug}`]],
    jsonld: [faqJsonld(faq)],
  });
}

function vsIndex() {
  const cards = Object.entries(COMPETITORS)
    .map(
      ([slug, c]) => `
          <a class="panel seo-card" href="/vs/${slug}">
            <strong>Ripley vs ${esc(c.name)}</strong>
            <p>${esc(c.rows.fee)} vs Ripley's 0% — the full side-by-side.</p>
            <span class="seo-card-cta">Compare →</span>
          </a>`,
    )
    .join('');
  const body = `
    <section class="xhero seo-hero">
      <div class="hero-inner">
        <h1>Compare Discord Monetization Platforms</h1>
        <p class="hero-sub">Every platform below is a real way to sell Discord access. The difference is what it costs you and who holds your money. Ripley takes 0% of sales and your revenue lands in your own Stripe account.</p>
      </div>
    </section>
    <section class="xsection">
      <div class="wrap">
        <div class="seo-grid">${cards}
        </div>
      </div>
    </section>
${cta()}`;
  return page({
    urlPath: '/vs',
    title: 'Ripley vs Whop, LaunchPass, Patreon & more — compare Discord monetization',
    desc: 'Side-by-side comparisons of Discord monetization platforms: fees, payouts, role delivery and lock-in. See what 0% platform fees change.',
    body,
    crumbs: [['Compare', '/vs']],
  });
}

// ── /tools/<x>-fee-calculator ─────────────────────────────────────────────────

function calcScript(rowsJs) {
  return `
  <script>
  (function () {
    var subs = document.getElementById('t-subs'), price = document.getElementById('t-price');
    var fmt = function (n) { return '$' + Math.round(n).toLocaleString('en-US'); };
    function ripleyCost(members) {
      if (members <= 10) return 0;
      if (members <= 50) return 5.99;
      if (members <= 500) return 19.99;
      return 49.99;
    }
    function upd() {
      var m = Number(subs.value), p = Number(price.value), rev = m * p;
      document.getElementById('t-subs-out').textContent = m;
      document.getElementById('t-price-out').textContent = '$' + p;
      document.getElementById('t-rev').textContent = fmt(rev) + '/mo';
      var ripley = ripleyCost(m);
      var rows = ${rowsJs};
      var max = ripley; rows.forEach(function (r) { if (r.cost > max) max = r.cost; });
      var worst = 0;
      document.getElementById('t-ripley').textContent = fmt(ripley) + '/mo';
      document.getElementById('t-bar-ripley').style.width = Math.max((ripley / (max || 1)) * 100, 2) + '%';
      rows.forEach(function (r) {
        if (r.cost > worst) worst = r.cost;
        document.getElementById('t-' + r.id).textContent = fmt(r.cost) + '/mo';
        document.getElementById('t-bar-' + r.id).style.width = Math.max((r.cost / (max || 1)) * 100, 2) + '%';
      });
      document.getElementById('t-save').textContent = fmt(Math.max(worst - ripley, 0) * 12) + '/yr';
    }
    subs.addEventListener('input', upd); price.addEventListener('input', upd); upd();
  })();
  </script>`;
}

function calcBars(rows) {
  return `
            <div class="calc-bar-row" id="t-row-ripley">
              <div class="calc-bar-meta"><span class="calc-bar-name">Ripley</span><span class="calc-bar-amt" id="t-ripley">$0</span></div>
              <div class="calc-bar mine"><span id="t-bar-ripley"></span></div>
              <span class="calc-bar-sub">Flat plan · 0% of sales</span>
            </div>${rows
              .map(
                (r) => `
            <div class="calc-bar-row">
              <div class="calc-bar-meta"><span class="calc-bar-name">${esc(r.name)}</span><span class="calc-bar-amt" id="t-${r.id}">$0</span></div>
              <div class="calc-bar"><span id="t-bar-${r.id}"></span></div>
              <span class="calc-bar-sub">${esc(r.feeLine)}</span>
            </div>`,
              )
              .join('')}`;
}

function calculatorPage({ slug, title, desc, h1, intro, rows, rowsJs, faq, crumbName }) {
  const body = `
    <section class="xhero seo-hero">
      <div class="hero-inner">
        <h1>${esc(h1)}</h1>
        <p class="hero-sub">${esc(intro)}</p>
      </div>
    </section>
    <section class="xsection">
      <div class="wrap narrow">
        <div class="panel calc" aria-label="Fee calculator">
          <div class="calc-grid">
            <div class="calc-inputs">
              <label class="calc-field">
                <span class="calc-label">Paying members <output id="t-subs-out">100</output></span>
                <input id="t-subs" type="range" min="5" max="1000" step="5" value="100" />
              </label>
              <label class="calc-field">
                <span class="calc-label">Average monthly price <output id="t-price-out">$50</output></span>
                <input id="t-price" type="range" min="5" max="200" step="5" value="50" />
              </label>
              <div class="calc-result">
                <span class="calc-result-label">Monthly sales volume</span>
                <span class="calc-result-num" id="t-rev">$0</span>
                <span class="calc-result-label" style="margin-top:12px">Estimated annual savings with Ripley</span>
                <span class="calc-result-num" id="t-save">$0</span>
              </div>
            </div>
            <div class="calc-bars">
              <span class="calc-bars-label">Monthly platform cost</span>${calcBars(rows)}
              <p class="calc-note">* Competitor pricing as publicly listed — check their sites for current numbers. Stripe’s standard card-processing fees apply on every platform and are excluded here.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
    <section class="xsection">${faqHtml(faq)}</section>
${cta()}
${calcScript(rowsJs)}`;
  return page({
    urlPath: `/tools/${slug}`,
    title,
    desc,
    body,
    crumbs: [['Tools', '/tools'], [crumbName, `/tools/${slug}`]],
    jsonld: [faqJsonld(faq)],
  });
}

// The same cost formulas as COMPETITORS[key].cost, as inline JS expressions
// for the generated pages' <script> (rev = monthly sales volume).
const COST_EXPR = {
  whop: 'rev * 0.03',
  launchpass: '29 + rev * 0.035',
  patreon: 'rev * 0.08',
  'upgrade-chat': '49',
  memberful: '25 + rev * 0.049',
  'mighty-networks': '41 + rev * 0.02',
};

function competitorCalculator(key) {
  const c = COMPETITORS[key];
  const slug = `${key}-fee-calculator`;
  const rows = [{ id: key, name: c.name, feeLine: c.feeLine }];
  const rowsJs = `[{ id: '${key}', cost: ${COST_EXPR[key]} }]`;
  const faq = [
    [`How much does ${c.name} take from my sales?`, `${c.name}'s publicly listed pricing is ${c.feeLine.replace('*', '')}. Check their site for current numbers.`],
    ['What does Ripley cost?', 'Free up to 10 paying members, then flat plans from $5.99/mo. Ripley takes 0% of your sales.'],
    ['Are Stripe fees included?', 'No — Stripe’s standard card-processing fees apply on every platform, so they cancel out of the comparison.'],
  ];
  return {
    slug,
    html: calculatorPage({
      slug,
      title: `${c.name} fee calculator — what ${c.name} costs your Discord`,
      desc: `Estimate what ${c.name}'s fees (${c.feeLine.replace('*', '')}) cost your Discord community each month, compared with Ripley's flat 0%-fee plans.`,
      h1: `${c.name} Fee Calculator`,
      intro: `${c.name}'s publicly listed pricing is ${c.feeLine.replace('*', '')}. Move the sliders to see what that costs at your size — and what the same store costs on Ripley's flat plans.`,
      rows,
      rowsJs,
      faq,
      crumbName: `${c.name} fee calculator`,
    }),
  };
}

function allInOneCalculator() {
  const keys = ['whop', 'launchpass', 'patreon', 'upgrade-chat'];
  const rows = keys.map((k) => ({ id: k, name: COMPETITORS[k].name, feeLine: COMPETITORS[k].feeLine }));
  const rowsJs = `[
      { id: 'whop', cost: rev * 0.03 },
      { id: 'launchpass', cost: 29 + rev * 0.035 },
      { id: 'patreon', cost: rev * 0.08 },
      { id: 'upgrade-chat', cost: 49 }
    ]`;
  const faq = [
    ['Which Discord monetization platform is cheapest?', 'It depends on your volume: percentage-fee platforms get more expensive as you grow, flat-fee platforms do not. Ripley is a flat plan (free up to 10 paying members, then from $5.99/mo) with 0% of sales.'],
    ['Are these the platforms’ real prices?', 'They are the publicly listed prices at the time this page was written, marked with an asterisk — always check the platform’s own site for current numbers.'],
    ['Does 0% platform fees mean completely free?', 'Ripley’s plans are flat monthly subscriptions and the platform takes 0% of your sales. Stripe’s standard card-processing fees apply everywhere.'],
  ];
  return {
    slug: 'discord-fee-calculator',
    html: calculatorPage({
      slug: 'discord-fee-calculator',
      title: 'Discord monetization fee calculator — Whop vs LaunchPass vs Patreon vs Ripley',
      desc: 'Compare what Whop, LaunchPass, Patreon and Upgrade.Chat cost your Discord community each month against Ripley’s flat 0%-fee plans.',
      h1: 'Discord Monetization Fee Calculator',
      intro: 'Every platform prices differently — percentages, subscriptions, or both. Set your community size and price to compare monthly platform costs side by side.',
      rows,
      rowsJs,
      faq,
      crumbName: 'Discord fee calculator',
    }),
  };
}

function toolsIndex() {
  const tools = [
    ['discord-fee-calculator', 'Discord fee calculator', 'Whop vs LaunchPass vs Patreon vs Upgrade.Chat vs Ripley, at your numbers.'],
    ['whop-fee-calculator', 'Whop fee calculator', "What 3% of sales adds up to at your community's size."],
    ['launchpass-fee-calculator', 'LaunchPass fee calculator', 'What $29/mo + 3.5% of sales costs as you grow.'],
    ['patreon-fee-calculator', 'Patreon fee calculator', 'What 8–12% of earnings means in real dollars.'],
  ];
  const cards = tools
    .map(
      ([slug, name, sub]) => `
          <a class="panel seo-card" href="/tools/${slug}">
            <strong>${esc(name)}</strong>
            <p>${esc(sub)}</p>
            <span class="seo-card-cta">Open calculator →</span>
          </a>`,
    )
    .join('');
  const body = `
    <section class="xhero seo-hero">
      <div class="hero-inner">
        <h1>Free Tools for Discord Server Owners</h1>
        <p class="hero-sub">Work out what platform fees actually cost your community — with each platform's publicly listed pricing, at your numbers.</p>
      </div>
    </section>
    <section class="xsection">
      <div class="wrap">
        <div class="seo-grid">${cards}
        </div>
      </div>
    </section>
${cta()}`;
  return page({
    urlPath: '/tools',
    title: 'Free Discord monetization tools — fee calculators',
    desc: 'Free calculators for Discord server owners: see what Whop, LaunchPass and Patreon fees cost at your size versus a flat 0%-fee plan.',
    body,
    crumbs: [['Tools', '/tools']],
  });
}

// ── /use-cases/<x> ────────────────────────────────────────────────────────────

function useCasePage(slug, u) {
  const steps = [
    ['Connect your server', 'Sign in with Discord, pick your server, and add the Ripley bot.'],
    ['Create your products', 'Name, price, photo, and the role each product unlocks — built in the dashboard, no Stripe dashboard needed.'],
    ['Share your link', 'Your store lives at ripleybot.com/yourname. Buyers pay on Stripe and get their role in seconds.'],
  ];
  const body = `
    <section class="xhero seo-hero">
      <div class="hero-inner">
        <h1>${esc(u.h1)}</h1>
        <p class="hero-sub">${esc(u.intro)}</p>
        <p><a class="btn-fill btn-hero" href="/dashboard">Start free <span aria-hidden="true">→</span></a></p>
      </div>
    </section>
    <section class="xsection">
      <div class="wrap narrow">
        <h2 class="section-title center">How it works</h2>
        <ol class="seo-steps">${steps
          .map(([t, d], i) => `<li class="panel"><span class="seo-step-num">${i + 1}</span><strong>${esc(t)}</strong><p>${esc(d)}</p></li>`)
          .join('')}</ol>
      </div>
    </section>
    <section class="xsection">
      <div class="wrap narrow">
        <h2 class="section-title center">Built for ${esc(u.name.toLowerCase())}</h2>
        <ul class="tick-list seo-ticks">${u.points
          .map(([t, d]) => `<li><strong>${esc(t)}</strong> — ${esc(d)}</li>`)
          .join('')}
          <li><strong>0% platform fees</strong> — Ripley charges a flat plan and never takes a cut of your sales.</li>
        </ul>
      </div>
    </section>
    <section class="xsection">${faqHtml(u.faq)}</section>
${cta()}`;
  return page({
    urlPath: `/use-cases/${slug}`,
    title: `${u.h1} — Ripley`,
    desc: u.desc,
    body,
    crumbs: [['Use cases', '/use-cases'], [u.name, `/use-cases/${slug}`]],
    jsonld: [faqJsonld(u.faq)],
  });
}

function useCasesIndex() {
  const cards = Object.entries(USE_CASES)
    .map(
      ([slug, u]) => `
          <a class="panel seo-card" href="/use-cases/${slug}">
            <strong>${esc(u.name)}</strong>
            <p>${esc(u.desc)}</p>
            <span class="seo-card-cta">See how →</span>
          </a>`,
    )
    .join('');
  const body = `
    <section class="xhero seo-hero">
      <div class="hero-inner">
        <h1>What Communities Sell with Ripley</h1>
        <p class="hero-sub">If your server has something worth paying for, Ripley sells it and delivers the role — with 0% platform fees and payments straight to your own Stripe account.</p>
      </div>
    </section>
    <section class="xsection">
      <div class="wrap">
        <div class="seo-grid">${cards}
        </div>
      </div>
    </section>
${cta()}`;
  return page({
    urlPath: '/use-cases',
    title: 'Discord monetization use cases — trading, coaching, cook groups & more',
    desc: 'How trading groups, sports picks communities, coaches, cook groups and creators sell Discord access with 0% platform fees on Ripley.',
    body,
    crumbs: [['Use cases', '/use-cases']],
  });
}

// ── emit everything ───────────────────────────────────────────────────────────

const out = [];
function emit(rel, html) {
  const file = path.join(PUB, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  out.push(rel);
}

emit('vs/index.html', vsIndex());
for (const [slug, c] of Object.entries(COMPETITORS)) emit(`vs/${slug}.html`, vsPage(slug, c));

emit('tools/index.html', toolsIndex());
emit('tools/discord-fee-calculator.html', allInOneCalculator().html);
for (const key of ['whop', 'launchpass', 'patreon']) {
  const { slug, html } = competitorCalculator(key);
  emit(`tools/${slug}.html`, html);
}

emit('use-cases/index.html', useCasesIndex());
for (const [slug, u] of Object.entries(USE_CASES)) emit(`use-cases/${slug}.html`, useCasePage(slug, u));

// sitemap + robots: the landing page plus every generated page. Store pages
// are user content and terms/privacy/dashboard/account are noindex — none of
// those belong in the sitemap.
const urls = ['/', '/vs', ...Object.keys(COMPETITORS).map((s) => `/vs/${s}`), '/tools',
  '/tools/discord-fee-calculator', '/tools/whop-fee-calculator', '/tools/launchpass-fee-calculator', '/tools/patreon-fee-calculator',
  '/use-cases', ...Object.keys(USE_CASES).map((s) => `/use-cases/${s}`)];
const today = new Date().toISOString().slice(0, 10);
emit(
  'sitemap.xml',
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${BASE}${u}</loc><lastmod>${today}</lastmod></url>`)
    .join('\n')}\n</urlset>\n`,
);
emit(
  'robots.txt',
  `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /dashboard\nDisallow: /account\nDisallow: /receipt\n\nSitemap: ${BASE}/sitemap.xml\n`,
);

console.log(`generated ${out.length} files:\n  ${out.join('\n  ')}`);
