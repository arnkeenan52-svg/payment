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
const V = '95'; // keep in step with the ?v= asset version on index.html

// Ripley plan facts (src/services/billing.js TIERS — keep in sync).
const RIPLEY_TIERS = [
  { name: 'Free', priceUsd: 0, maxMembers: 10 },
  { name: 'Starter', priceUsd: 14.99, maxMembers: 50 },
  { name: 'Growth', priceUsd: 44.99, maxMembers: 500 },
  { name: 'Scale', priceUsd: 134.99, maxMembers: null },
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
    feeLine: 'from $49/mo + from 2.9% of sales*',
    cost: (rev) => 49 + rev * 0.029,
    blurb:
      'Upgrade.Chat is a Discord payment bot with free and paid plans. Its own documentation describes a cut on top of card processing, and that cut applies on the paid plans too — the monthly fee buys a lower rate, not a zero one.',
    rows: { fee: 'A cut of every sale, on every plan*', monthly: 'Paid plan from $49/mo*', money: 'Your PayPal/Stripe account', store: 'upgrade.chat page' },
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
  // Subscord is the closest category neighbor. Its pricing is plan-dependent
  // and changes — every cell stays hedged to "as publicly listed".
  subscord: {
    name: 'Subscord',
    feeLine: 'plan-dependent pricing*',
    cost: null, // no calculator — their pricing is not a single stable formula
    blurb:
      'Subscord is a Discord subscription bot in the same category as Ripley: paid plans gate roles, checkout runs on Stripe. Its pricing and fees are plan-dependent — check subscord.com for current numbers.',
    rows: { fee: 'Plan-dependent*', monthly: 'Plan-dependent*', money: 'Via their Stripe integration*', store: 'Hosted checkout page' },
  },
  gumroad: {
    name: 'Gumroad',
    feeLine: '10% flat fee*',
    cost: (rev) => rev * 0.1,
    blurb:
      'Gumroad is a general digital-products storefront. Selling Discord access means bolting on its Discord integration and giving up a flat 10% of every sale.',
    rows: { fee: '10% of every sale*', monthly: '$0 base', money: 'Held by the platform, paid out to you', store: 'gumroad.com product page' },
  },
  'ko-fi': {
    name: 'Ko-fi',
    feeLine: '5% on memberships (free plan)*',
    cost: (rev) => rev * 0.05,
    blurb:
      'Ko-fi is a tip-jar first. Memberships carry a percentage fee on the free plan, and Discord roles arrive through its integration rather than a store built for servers.',
    rows: { fee: '5% on memberships (free plan)*', monthly: '$0 base (paid plan removes fees)*', money: 'PayPal/Stripe payouts', store: 'ko-fi.com page' },
  },
  buymeacoffee: {
    name: 'Buy Me a Coffee',
    feeLine: '5% of earnings*',
    cost: (rev) => rev * 0.05,
    blurb:
      'Buy Me a Coffee is built for one-off support and simple memberships, with a listed 5% platform fee and Discord access handled through an integration.',
    rows: { fee: '5% of earnings*', monthly: '$0 base', money: 'Paid out to you', store: 'buymeacoffee.com page' },
  },
};

const USE_CASES = {
  trading: {
    name: 'Trading Communities',
    h1: 'Sell Access to Your Trading Discord',
    desc: 'Charge for your trading signals, analysis channels and mentorship with 0% platform fees. Payments go straight to your own Stripe account.',
    intro:
      'Signal groups, futures rooms, options flow, crypto research: if your calls are worth following, they are worth paying for. Ripley puts a checkout in front of your premium channels and delivers the member role the second payment clears.',
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
      'Cappers live and die by their record. Platform fees should not decide your revenue. Ripley gates your picks channels behind a clean checkout, keeps 0% of your sales, and removes access when a subscription lapses.',
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
      'Programming channels, check-in threads, form review, accountability groups: coaching happens in Discord already. Ripley adds the paywall. Members pay on a hosted checkout and get their client role in seconds.',
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
      'Monitors, sitelists, restock pings and flip guides earn while they are fast, so your checkout should be fast too. Ripley delivers the member role seconds after payment and takes 0% of your sales.',
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
      'Product research channels, supplier contacts, store teardowns, weekly Q&A: the mentorship already lives in your server. Ripley adds the payment layer and takes no cut of it.',
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
      'Early videos, extended cuts, sample packs, presets, art drops: creators run exclusives through Discord because the community already lives there. Ripley gates those channels with a role your fans buy in one checkout.',
    points: [
      ['One link to share', 'ripleybot.com/yourname — put it in every bio. It is your store.'],
      ['Lifetime or recurring', 'Sell a one-time supporter pass or a monthly membership.'],
      ['Fans stay yours', 'No marketplace between you and your audience — buyers check out under your name.'],
    ],
    faq: [
      ['Do I need a website?', 'No. Your Ripley store page is hosted for you at your own link with your name and icon.'],
      ['What does Ripley cost?', 'Free for your first 10 paying members, then flat plans from $14.99/mo. Ripley takes 0% of sales.'],
      ['Can fans pay with Apple Pay?', 'Checkout is Stripe-hosted — cards, Apple Pay, Google Pay and Link, per your Stripe settings.'],
    ],
  },
};

// ── shared page chrome ────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const nav = `
  <header class="top xoe-nav">
    <div class="top-left">
      <a href="/"><img class="platform-mark" src="/ripley.png" alt="Ripley" height="20" /></a>
    </div>
    <nav class="top-center" aria-label="Main">
      <a class="nav-link" href="/#features">Features</a>
      <a class="nav-link" href="/#pricing">Pricing</a>
      <a class="nav-link" href="/vs">Compare</a>
      <a class="nav-link" href="/tools">Tools</a>
    </nav>
    <div class="top-right">
      <div class="account"><a class="btn-fill" href="/dashboard">Start free</a></div>
      <button class="theme-btn" data-theme-toggle aria-label="Switch color theme"><svg class="tb-sun" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4L19 19M19 5l-1.6 1.6M6.6 17.4L5 19"/></svg><svg class="tb-moon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>
    </div>
  </header>`;

export const footerHtml = `
  <footer class="site-footer cols seo-footer">
    <div class="footer-brand">
      <img class="powered-mark" src="/ripley.png" alt="Ripley" height="16" />
      <span class="footer-copy">© Ripley</span>
    </div>
    <nav class="footer-col"><span class="footer-head">Product</span>
      <a href="/discover">Discover stores</a><a href="/#features">Features</a><a href="/#pricing">Pricing</a><a href="/#faq">FAQ</a>
      <a href="/help">Help</a><a href="/dashboard">Dashboard</a><a href="/account">Your account</a></nav>
    <nav class="footer-col"><span class="footer-head">Compare</span>
      <a href="/vs/whop">Ripley vs Whop</a><a href="/vs/launchpass">Ripley vs LaunchPass</a>
      <a href="/vs/subscord">Ripley vs Subscord</a><a href="/vs/patreon">Ripley vs Patreon</a>
      <a href="/vs/upgrade-chat">Ripley vs Upgrade.Chat</a><a href="/vs/gumroad">Ripley vs Gumroad</a>
      <a href="/alternatives/whop-alternatives">Whop alternatives</a>
      <a href="/alternatives/subscord-alternatives">Subscord alternatives</a></nav>
    <nav class="footer-col"><span class="footer-head">Guides</span>
      <a href="/guides/how-to-monetize-a-discord-server">Monetize a Discord server</a>
      <a href="/guides/how-to-sell-discord-roles">Sell Discord roles</a>
      <a href="/guides/paid-discord-server">Make a paid server</a>
      <a href="/guides/discord-subscription-bot">Discord subscription bots</a>
      <a href="/guides/discord-monetization-ideas">Monetization ideas</a></nav>
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
  <meta property="og:image" content="${BASE}/og-card.png" />
  <meta property="og:url" content="${canonical}" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="icon" type="image/png" href="/favicon.png?v=95" />
  <link rel="stylesheet" href="/styles.css?v=${V}" />
  ${ld}
  <script src="/theme.js?v=95"></script>
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
  monthly: 'Free up to 10 paying members, then from $14.99/mo',
  money: 'Your own Stripe account, directly',
  store: 'ripleybot.com/yourname',
};

// ── /vs/<competitor> ──────────────────────────────────────────────────────────

function vsPage(slug, c) {
  const title = `Ripley vs ${c.name} — Discord monetization compared`;
  const desc = `${c.name} charges ${c.feeLine.replace('*', '')} — Ripley takes 0% of your sales and payments land in your own Stripe account. A side-by-side comparison for Discord server owners.`;
  const faq = [
    [`How much does ${c.name} cost compared to Ripley?`, `${c.name}'s publicly listed pricing is ${c.feeLine.replace('*', '')}. Ripley charges a flat plan (free up to 10 paying members, then from $14.99/mo) and takes 0% of your sales.`],
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
        <p class="hero-sub">Ripley is the other model: a flat plan, <strong>0% of your sales</strong>, and payments that land in <strong>your own Stripe account</strong> with roles delivered in seconds.</p>
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
          <li><strong>0% platform fees</strong> — a flat plan, whatever you earn. Estimate the difference with the <a href="/tools/${['whop', 'launchpass', 'patreon'].includes(slug) ? slug : 'discord'}-fee-calculator">fee calculator</a>.</li>
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
      if (members <= 50) return 14.99;
      if (members <= 500) return 44.99;
      return 134.99;
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
  'upgrade-chat': '49 + rev * 0.029',
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
    ['What does Ripley cost?', 'Free up to 10 paying members, then flat plans from $14.99/mo. Ripley takes 0% of your sales.'],
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
    ['Which Discord monetization platform is cheapest?', 'It depends on your volume: percentage-fee platforms get more expensive as you grow, flat-fee platforms do not. Ripley is a flat plan (free up to 10 paying members, then from $14.99/mo) with 0% of sales.'],
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

// ── /guides/<slug> — long-form how-tos for the queries owners actually type ──
// Content rules as everywhere: Ripley claims only what the product does,
// platform facts stay hedged, no invented numbers.

const GUIDES = {
  'how-to-monetize-a-discord-server': {
    title: 'How to Monetize a Discord Server (2026 Guide)',
    desc: 'A practical guide to monetizing a Discord server: what to charge for, how to price memberships, how paid roles work, and how to keep access healthy.',
    h1: 'How to Monetize a Discord Server',
    intro: 'You do not need a huge server to earn from it — you need something worth paying for and a clean way to charge for it. This guide covers the whole path: picking what to sell, pricing it, gating it behind roles, and keeping access healthy after launch.',
    sections: [
      ['Decide what is worth paying for', `<p>Paid Discord communities sell access, not content volume. The strongest offers are channels people check daily: trading signals and analysis rooms, sports picks, cook-group monitors, coaching check-ins, early drops, or a private floor where the real conversation happens. Look at your server and ask which two or three channels members would miss most — that is your product.</p><p>Browse real examples by niche: <a href="/use-cases/trading">trading</a>, <a href="/use-cases/sports-betting">sports picks</a>, <a href="/use-cases/fitness">coaching</a>, <a href="/use-cases/reselling">cook groups</a>.</p>`],
      ['Pick a model: monthly, lifetime, or tiers', `<p>Three models cover almost every server:</p><ul><li><strong>Monthly membership</strong> — recurring revenue, the default for signals, picks and coaching.</li><li><strong>Lifetime seat</strong> — one payment, permanent role. Works as a premium tier or a launch offer.</li><li><strong>Tiers</strong> — two or three roles at different prices (say, Signals at $15/mo and Inner Circle at $50/mo). Each tier maps to its own role and channels.</li></ul><p>Start with one product. Add tiers when members ask for more, not before.</p>`],
      ['Choose the payment layer', `<p>This is where most owners lose money without noticing. The options fall into three camps:</p><ul><li><strong>Marketplaces</strong> (Whop and similar) — your store lives on their domain and they take a percentage of every sale.</li><li><strong>Percentage platforms</strong> (LaunchPass, Patreon, Ko-fi and similar) — a cut of your revenue, sometimes on top of a monthly fee.</li><li><strong>Flat-fee platforms</strong> (Ripley) — a fixed monthly plan, 0% of sales, payments straight into your own Stripe account.</li></ul><p>Percentages feel painless at $200/mo and brutal at $5,000/mo. Run your own numbers in the <a href="/tools/discord-fee-calculator">fee calculator</a>, or see the <a href="/vs">side-by-side comparisons</a>.</p>`],
      ['Gate the channels behind a role', `<p>Structure the server so free members can see that the paid area exists: a public lobby, a pinned message describing what is inside, and locked channels visible but unreadable. Create one role per product, put the premium channels behind it, and let the payment layer grant and remove that role automatically.</p><p>One Discord-specific pitfall: the bot delivering roles must sit <em>above</em> the roles it manages in Server Settings → Roles, or Discord will refuse the assignment.</p>`],
      ['Launch without a relaunch', `<p>Announce once, pin the store link, and put it in the server description and your bios. A short launch discount (a code with an expiry and a redemption cap) gives the announcement urgency without training members to wait for sales.</p>`],
      ['Keep access healthy after launch', `<p>The part nobody plans for: cancellations, failed renewals, chargebacks, people leaving and rejoining. Manual role pruning does not survive contact with a growing server. Whatever platform you pick, make sure lapsed subscriptions lose the role automatically, access is re-checked on a schedule, and you can revoke or re-sync one member without spelunking. Buyers should get a receipt they can find later — it cuts support pings dramatically.</p>`],
    ],
    faq: [
      ['How many members do I need to monetize a Discord server?', 'There is no minimum. A server with 200 engaged members in a niche where information has value often out-earns a 20,000-member general server. Conversion depends on how much your paid channels are worth, not raw size.'],
      ['Can I charge for Discord access directly through Discord?', 'Discord’s own Server Subscriptions exist but are limited by region and take a platform share. Most owners use an external checkout layer that grants roles, which keeps pricing and payout terms in their control.'],
      ['What should I charge for a paid Discord?', 'Typical ranges: $10–$30/mo for signals and picks communities, $25–$100/mo for coaching or mentorship, and 3–6× the monthly price for lifetime seats. Price against the value of the information, then adjust from real conversion.'],
      ['Do I need my own Stripe account?', 'On Ripley, yes — that is the design. Payments land directly in your own Stripe account and Ripley never holds your money. On marketplaces, the platform holds funds and pays you out on their schedule.'],
    ],
  },
  'how-to-sell-discord-roles': {
    title: 'How to Sell Discord Roles (Step by Step)',
    desc: 'Sell Discord roles with automatic delivery: create the role, gate your channels, connect Stripe, set a price, and share your store link.',
    h1: 'How to Sell Discord Roles',
    intro: 'A paid role is the cleanest product a Discord server can sell: buyers pay, the role lands, the channels unlock. Here is the whole setup, end to end.',
    sections: [
      ['1. Create the role and gate the channels', `<p>Make a role named after the product (<em>@VIP</em>, <em>@Signals</em>, <em>@Inner Circle</em>) and set your premium channels to be visible only with it. Leave a public lobby so non-members can see what they are missing.</p>`],
      ['2. Connect a checkout that delivers roles', `<p>Invite the payment bot, connect your Stripe account, and map the product to the role. On <a href="/">Ripley</a> that is the whole onboarding: invite → paste your Stripe key → create the product → pick the role. Your store goes live at ripleybot.com/yourname.</p>`],
      ['3. Price it', `<p>Monthly for ongoing value (signals, picks, coaching), lifetime for a one-time unlock, or both at different price points. Each product maps to its own role, so tiers are just more products.</p>`],
      ['4. Share the link', `<p>Pin it, put it in the server description, link it from your socials. Buyers sign in with Discord, pay on Stripe’s checkout, and the role is delivered in seconds — buyers who are not in the server yet get pulled in with the role attached.</p>`],
      ['5. Let lapses handle themselves', `<p>When a subscription ends, the role should come off without you doing anything. Ripley removes it automatically and re-checks access hourly, so the members list and the paying list never drift apart.</p>`],
    ],
    faq: [
      ['Can a bot really remove the role when someone stops paying?', 'Yes — that is the core of a subscription bot. On Ripley, lapsed and canceled subscriptions lose the role automatically, and access is re-verified hourly.'],
      ['What if the buyer is not in my server yet?', 'Ripley pulls buyers into the server with the role already attached when they complete checkout, using the authorization they grant at sign-in.'],
      ['Why is the bot not assigning my role?', 'Almost always role hierarchy: drag the bot’s role above the roles it delivers in Server Settings → Roles.'],
      ['Do buyers need Stripe accounts?', 'No. Buyers pay with a card or wallet on a standard Stripe checkout page. Only the store owner needs a Stripe account, and payments land there directly.'],
    ],
  },
  'paid-discord-server': {
    title: 'How to Make a Paid Discord Server',
    desc: 'Turn a Discord server into a paid community: structure the server, set up checkout with automatic role delivery, and launch a membership people keep.',
    h1: 'How to Make a Paid Discord Server',
    intro: 'A paid Discord server is a normal server with three additions: a locked area worth paying for, a checkout that grants a role, and automation that takes the role away when payment stops. Get those right and the rest is community-building.',
    sections: [
      ['Structure: free lobby, paid floor', `<p>Keep a public area with your rules, announcements and enough genuine activity to prove the server is alive. Put the paid value in clearly named locked categories. Members who can see what exists — but not read it — convert; a fully hidden paid area might as well not exist.</p>`],
      ['The checkout layer', `<p>Buyers should be able to go from your pinned link to unlocked channels in under a minute, without a human involved: sign in with Discord, pay on Stripe, get the role. That flow is exactly what a <a href="/guides/discord-subscription-bot">Discord subscription bot</a> automates. Compare the platforms that do it — and what each costs — on the <a href="/vs">comparisons page</a>.</p>`],
      ['Onboard paying members like you mean it', `<p>Give new members a welcome channel inside the paid area: how the channels work, where to ask questions, what to read first. Members who orient in the first ten minutes stay; confused ones churn at renewal.</p>`],
      ['Retention beats acquisition', `<p>Renewals are won inside the community: consistent posting cadence in the paid channels, visible wins, and fast answers. Watch who stops reading before they stop paying. A monthly member kept for a year is worth more than three one-month members.</p>`],
      ['The metrics that matter', `<p>Track revenue by period, new members per week, and which products carry the revenue — then price and post accordingly. Ripley’s dashboard charts revenue with a previous-period comparison, lists every transaction, and pings a channel on every sale so the team sees momentum.</p>`],
    ],
    faq: [
      ['Is it against Discord’s rules to charge for server access?', 'Selling access to your own community is a normal, widespread use of Discord — creators do it through Server Subscriptions and third-party tools alike. What matters is following Discord’s Terms and your local rules for what you sell.'],
      ['Should the whole server be paid, or free with a paid area?', 'Free-with-paid-area almost always wins: the free floor is your marketing, the paid floor is the product. A fully paid server has to win members sight unseen.'],
      ['How do refunds work?', 'Payments run through your own Stripe account, so refunds are issued there like any Stripe payment. When a refunded subscription lapses, the role comes off automatically.'],
    ],
  },
  'discord-subscription-bot': {
    title: 'Discord Subscription Bot — What It Is and How to Choose One',
    desc: 'What a Discord subscription bot actually does, the checklist for choosing one, and the pricing traps to avoid: percentage fees, held funds, and manual role cleanup.',
    h1: 'What a Discord Subscription Bot Actually Does',
    intro: 'A Discord subscription bot turns roles into products: it runs the checkout, grants the role when payment clears, and — the part people forget — takes the role away when payment stops. Here is what separates a good one from a spreadsheet with extra steps.',
    sections: [
      ['The job description', `<p>Four things, end to end: a store page where buyers pay, verified payment processing (checkout by Stripe or similar), instant role delivery on payment, and automatic role removal on cancellation, failed renewal, or refund. If any of the four is manual, you have bought yourself a part-time job.</p>`],
      ['The checklist for choosing one', `<ul><li><strong>Who holds the money?</strong> Directly-to-your-Stripe beats platform-held funds paid out on their schedule.</li><li><strong>What does it take from each sale?</strong> 0% flat-plan pricing vs percentage fees changes everything at scale — <a href="/tools/discord-fee-calculator">run your numbers</a>.</li><li><strong>Does access heal itself?</strong> Lapse → role removed, automatically, with periodic re-checks.</li><li><strong>Do buyers get receipts?</strong> Emailed confirmations cut support load.</li><li><strong>Is there a real dashboard?</strong> Revenue, members, transactions, refund-safe controls.</li><li><strong>Can you leave?</strong> If your Stripe account and customers are yours, migration is painless. If the platform owns them, that is lock-in.</li></ul>`],
      ['The pricing traps', `<p>Three patterns to read carefully before connecting anything:</p><ul><li><strong>Percentage stacking</strong> — a platform percentage on top of card-processing fees, so your effective rate is far above the headline number.</li><li><strong>Held funds</strong> — revenue that sits with the platform, subject to their payout schedule and their freeze policies.</li><li><strong>Feature-gated basics</strong> — role removal or receipts locked behind higher tiers.</li></ul>`],
      ['Where Ripley sits', `<p>Ripley is the flat-fee shape of this category: free up to 10 paying members, flat plans after that, 0% of sales, checkout by Stripe into your own account, roles delivered in about two seconds and removed automatically on lapse. Compare it directly with <a href="/vs/whop">Whop</a>, <a href="/vs/launchpass">LaunchPass</a>, <a href="/vs/subscord">Subscord</a> or <a href="/vs">the whole field</a>.</p>`],
    ],
    faq: [
      ['What is the best Discord subscription bot?', 'The one whose pricing model fits your volume and whose automation you never think about. Judge candidates on fees, who holds funds, role-lifecycle automation, receipts, and lock-in — the checklist above.'],
      ['Can I run subscriptions without a bot?', 'You can collect payments with generic links and assign roles by hand, but every cancellation and failed renewal becomes manual work, and it scales exactly as badly as it sounds.'],
      ['Do subscription bots work with lifetime products?', 'Ripley sells lifetime seats alongside monthly plans — one payment, permanent role, no renewal to manage.'],
    ],
  },
  'sell-discord-server-access': {
    title: 'How to Sell Access to Your Discord Server',
    desc: 'Sell Discord server access with a store link, Stripe checkout and automatic role delivery — the three pieces, and how to set them up in an afternoon.',
    h1: 'How to Sell Access to Your Discord Server',
    intro: 'Selling server access is three pieces: something worth unlocking, a checkout link you can share anywhere, and delivery that never needs you online. Most owners overbuild the first and underbuild the last.',
    sections: [
      ['The product is a role', `<p>Package access as a role that unlocks channels. One role for a simple membership, several for tiers. If you can describe what the role unlocks in one sentence, buyers will get it too.</p>`],
      ['The checkout is a link', `<p>Your store lives at a link — Ripley gives you <strong>ripleybot.com/yourname</strong>, with your server’s name, icon and products on it, sharable in bios, pinned messages and DMs. Buyers sign in with Discord, pay on Stripe, done. Link previews carry your product photo automatically.</p>`],
      ['Delivery is instant, and so is revocation', `<p>The role lands seconds after payment and comes off automatically when a subscription lapses. Buyers not yet in the server are pulled in with the role attached. That is the entire operational load: zero.</p>`],
      ['What it costs', `<p>Ripley is free up to 10 paying members, then flat plans from $14.99/mo — always 0% of sales, with payments in your own Stripe account. For the full landscape, see <a href="/guides/how-to-monetize-a-discord-server">the monetization guide</a> and the <a href="/vs">comparisons</a>.</p>`],
    ],
    faq: [
      ['Can I sell one-time access instead of subscriptions?', 'Yes — lifetime products are one payment for a permanent role. Sell them alone or next to a monthly plan at a different price.'],
      ['Can I offer discount codes?', 'Yes. Percentage or fixed-amount codes, with optional expiry dates and redemption caps, managed from the dashboard.'],
      ['What do buyers see when I share my link?', 'A checkout page with your server’s name and icon, the product with its photo and price, and a card checkout by Stripe. Link previews in Discord and iMessage show your product photo.'],
    ],
  },
  'discord-monetization-ideas': {
    title: '8 Discord Monetization Ideas That Actually Work',
    desc: 'Eight proven ways servers earn: paid signals, tiered mentorship, cook-group seats, lifetime memberships, early access, VIP AMAs, resource vaults and priority support.',
    h1: '8 Discord Monetization Ideas That Actually Work',
    intro: 'These are the models real servers run — each is a role with a price on it. Mix two or three; do not launch all eight.',
    sections: [
      ['1. Paid signals or picks channel', `<p>The classic. Free lobby carries your record, the paid role unlocks the calls. Monthly pricing, monthly proof. See <a href="/use-cases/trading">trading</a> and <a href="/use-cases/sports-betting">sports picks</a> setups.</p>`],
      ['2. Tiered mentorship', `<p>A base tier for the group channels, a premium tier that adds direct access to you. Two roles, two prices — the premium tier subsidizes everything else.</p>`],
      ['3. Cook-group seats', `<p>Monitors, restock alerts and guides degrade when overcrowded, so sell a capped number of seats. Purchase limits per product handle the cap; see <a href="/use-cases/reselling">cook groups</a>.</p>`],
      ['4. Lifetime membership', `<p>One payment, permanent role, typically 3–6× the monthly price. Strong at launch and for your true believers — and there is no renewal to churn.</p>`],
      ['5. Early access', `<p>Content, drops, or products land in the paid channels first, everywhere else later. The paid role is a time machine; the value is the head start.</p>`],
      ['6. VIP AMA / office hours', `<p>A recurring members-only session with you. Low production cost, high perceived access — works stacked on any other idea.</p>`],
      ['7. Resource vault', `<p>Templates, playbooks, spreadsheets, archives — a locked library channel. Pairs naturally with lifetime pricing.</p>`],
      ['8. Priority support', `<p>For tool/skill servers: a role whose channel you answer first. Businesses pay for response time everywhere else; your server is no different.</p>`],
    ],
    faq: [
      ['Which idea should I start with?', 'The one closest to what your members already ask you for. Package the thing you repeatedly give away, gate it behind one role, price it monthly.'],
      ['Can I run several of these at once?', 'Yes — each is just a product mapped to a role. Two or three complementary offers (signals + lifetime + VIP AMA) is a common shape.'],
      ['How do I take payments for all this?', 'Any subscription layer works mechanically; they differ in fees and who holds your money. Ripley charges a flat plan, takes 0% of sales, and pays straight into your own Stripe account.'],
    ],
  },
};

function guidePage(slug, g) {
  const body = `
    <section class="xhero seo-hero">
      <div class="hero-inner">
        <h1>${esc(g.h1)}</h1>
        <p class="hero-sub">${esc(g.intro)}</p>
      </div>
    </section>
    <section class="xsection">
      <div class="wrap narrow guide-body">
        ${g.sections.map(([h, html]) => `<h2>${esc(h)}</h2>\n        ${html}`).join('\n        ')}
      </div>
    </section>
    <section class="xsection">${faqHtml(g.faq)}</section>
${cta()}`;
  return page({
    urlPath: `/guides/${slug}`,
    title: g.title,
    desc: g.desc,
    body,
    crumbs: [['Guides', '/guides'], [g.h1, `/guides/${slug}`]],
    jsonld: [
      faqJsonld(g.faq),
      {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: g.h1,
        description: g.desc,
        author: { '@type': 'Organization', name: 'Ripley' },
        publisher: { '@type': 'Organization', name: 'Ripley', url: BASE },
        mainEntityOfPage: `${BASE}/guides/${slug}`,
      },
    ],
  });
}

function guidesIndex() {
  const cards = Object.entries(GUIDES)
    .map(
      ([slug, g]) => `
          <a class="panel seo-card" href="/guides/${slug}">
            <strong>${esc(g.h1)}</strong>
            <p>${esc(g.desc)}</p>
            <span class="seo-card-cta">Read →</span>
          </a>`,
    )
    .join('');
  const body = `
    <section class="xhero seo-hero">
      <div class="hero-inner">
        <h1>Guides to Monetizing Discord</h1>
        <p class="hero-sub">Practical, no-fluff guides to selling roles, running paid servers and choosing the payment layer — written by the team behind Ripley.</p>
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
    urlPath: '/guides',
    title: 'Discord monetization guides — sell roles, run paid servers, pick your stack',
    desc: 'Guides to monetizing Discord: selling roles, building paid servers, choosing a subscription bot, and pricing memberships.',
    body,
    crumbs: [['Guides', '/guides']],
  });
}

// ── /alternatives/<slug> — honest listicles for "X alternatives" queries ─────

const ALT_LIST = {
  ripley: {
    name: 'Ripley',
    line: 'Flat plans (free up to 10 paying members, then from $14.99/mo), 0% of sales, payments straight into your own Stripe account, roles delivered in seconds. That is us — the disclosure is the point.',
    href: '/',
  },
  launchpass: { name: 'LaunchPass', line: 'Subscription checkout for Discord, Telegram and Slack. Publicly listed pricing pairs a monthly plan with a percentage of sales*.', href: '/vs/launchpass' },
  'upgrade-chat': { name: 'Upgrade.Chat', line: 'Discord payment bot with free and paid plans; going featureful means a monthly platform subscription*.', href: '/vs/upgrade-chat' },
  memberful: { name: 'Memberful', line: 'Membership software for websites first, with Discord via integration. Listed pricing is a monthly plan plus a transaction percentage*.', href: '/vs/memberful' },
  'ko-fi': { name: 'Ko-fi', line: 'Tip-jar and memberships with a listed percentage fee on the free plan; Discord roles via integration*.', href: '/vs/ko-fi' },
  gumroad: { name: 'Gumroad', line: 'General digital storefront with a listed flat 10% fee; Discord access through its integration*.', href: '/vs/gumroad' },
  subscord: { name: 'Subscord', line: 'Discord subscription bot with Stripe checkout; pricing is plan-dependent — check their site*.', href: '/vs/subscord' },
  whop: { name: 'Whop', line: 'Marketplace model: your store lives on whop.com and the platform takes a listed percentage of every sale before paying out*.', href: '/vs/whop' },
  buymeacoffee: { name: 'Buy Me a Coffee', line: 'Simple memberships with a listed 5% platform fee; Discord via integration*.', href: '/vs/buymeacoffee' },
};

const ALTERNATIVES = {
  'whop-alternatives': {
    target: 'Whop',
    picks: ['ripley', 'launchpass', 'upgrade-chat', 'subscord', 'memberful'],
    why: 'Owners usually look past Whop for two reasons: the percentage taken from every sale, and the storefront living on a marketplace domain rather than their own link. If either bothers you, the field below is the shortlist.',
  },
  'launchpass-alternatives': {
    target: 'LaunchPass',
    picks: ['ripley', 'upgrade-chat', 'subscord', 'whop', 'memberful'],
    why: 'LaunchPass pairs a monthly subscription with a percentage of sales on its listed pricing — a double cost that grows with you. The alternatives below split into flat-fee and percentage camps; know which you are choosing.',
  },
  'subscord-alternatives': {
    target: 'Subscord',
    picks: ['ripley', 'launchpass', 'upgrade-chat', 'whop'],
    why: 'Subscord popularized the subscription-bot shape: Stripe checkout, paid roles, hosted checkout pages. If you are comparing the category, the platforms below do the same job with different pricing models and different answers to who holds your money.',
  },
  'patreon-alternatives-for-discord': {
    target: 'Patreon',
    picks: ['ripley', 'launchpass', 'ko-fi', 'buymeacoffee', 'whop'],
    why: 'Patreon takes a listed 8–12% of earnings and owns the member relationship, with Discord bolted on through an integration. For a community that lives on Discord, purpose-built tools deliver roles faster and cost a different shape of money.',
  },
};

function altPage(slug, a) {
  const picks = a.picks.map((k) => ALT_LIST[k]).filter(Boolean);
  const title = `Best ${a.target} Alternatives for Discord (2026)`;
  const desc = `${a.target} alternatives for monetizing a Discord server, compared honestly: flat-fee vs percentage pricing, who holds your money, and how roles are delivered.`;
  const faq = [
    [`What is the best ${a.target} alternative?`, `It depends on the pricing shape you want. Flat-fee platforms like Ripley cost the same whatever you earn and pay into your own Stripe account; percentage platforms scale their cut with your revenue. The list above marks each model.`],
    ['Are the listed fees current?', 'They are the publicly listed prices at the time of writing, always asterisked — verify on each platform’s own site.'],
    ['Is this list neutral?', 'No, and it does not pretend to be: Ripley is our product and it is listed first. Every factual claim about other platforms is their own published pricing, linked from the full comparison pages.'],
  ];
  const items = picks
    .map(
      (p, i) => `
          <div class="panel seo-card alt-card">
            <strong>${i + 1}. ${esc(p.name)}${i === 0 ? ' <span class="alt-ours">our product</span>' : ''}</strong>
            <p>${esc(p.line)}</p>
            <span class="seo-card-cta"><a href="${p.href}">${p.href === '/' ? 'See how it works' : 'Full comparison'} →</a></span>
          </div>`,
    )
    .join('');
  const body = `
    <section class="xhero seo-hero">
      <div class="hero-inner">
        <h1>${esc(title)}</h1>
        <p class="hero-sub">${esc(a.why)}</p>
      </div>
    </section>
    <section class="xsection">
      <div class="wrap narrow">
        <div class="seo-grid alt-grid">${items}
        </div>
        <p class="calc-note">* Pricing as publicly listed at the time of writing — check each platform’s site. Stripe’s standard card-processing fees apply on every platform.</p>
      </div>
    </section>
    <section class="xsection">${faqHtml(faq)}</section>
${cta(`Try the 0%-fee alternative`)}`;
  return page({
    urlPath: `/alternatives/${slug}`,
    title,
    desc,
    body,
    crumbs: [['Alternatives', '/alternatives'], [title, `/alternatives/${slug}`]],
    jsonld: [
      faqJsonld(faq),
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: title,
        itemListElement: picks.map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: p.name, url: `${BASE}${p.href}` })),
      },
    ],
  });
}

function altIndex() {
  const cards = Object.entries(ALTERNATIVES)
    .map(
      ([slug, a]) => `
          <a class="panel seo-card" href="/alternatives/${slug}">
            <strong>Best ${esc(a.target)} alternatives</strong>
            <p>${esc(a.why.split('.')[0])}.</p>
            <span class="seo-card-cta">See the list →</span>
          </a>`,
    )
    .join('');
  const body = `
    <section class="xhero seo-hero">
      <div class="hero-inner">
        <h1>Discord Monetization Alternatives</h1>
        <p class="hero-sub">Looking past a specific platform? These lists compare the field honestly: pricing model, who holds your money, and how roles get delivered.</p>
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
    urlPath: '/alternatives',
    title: 'Whop, LaunchPass, Subscord & Patreon alternatives for Discord',
    desc: 'Honest alternative lists for Discord monetization platforms: flat-fee vs percentage pricing, payouts, and role delivery compared.',
    body,
    crumbs: [['Alternatives', '/alternatives']],
  });
}

// ── emit everything ───────────────────────────────────────────────────────────

const out = [];
// ── /help — every feature in two minutes, each card linking to the real thing ─

function helpPage() {
  const FEATURES = [
    ['Your store page', 'One link with everything you sell — your name, banner, about section and colors. Buyers browse products and check out without leaving the page.', '/demo', 'See the demo store'],
    ['Product links', 'Every product also has its own URL, like ripleybot.com/your-store/vip — rename the last part in the product editor and share it anywhere.', '/dashboard', 'Dashboard → Products'],
    ['Checkout & payments', 'Buyers pay by card through Stripe, straight into your own Stripe account. Ripley never holds your money and takes 0% of sales.', '/demo/vip-access', 'Try a demo checkout'],
    ['Automatic role delivery', 'The Discord role is granted seconds after payment and removed when a membership ends. Failed renewals get a short grace period before access is pulled.', '/guides/how-to-sell-discord-roles', 'How role selling works'],
    ['Discounts', 'Create percentage codes in the dashboard; buyers apply them at checkout and pay the discounted amount.', '/dashboard', 'Dashboard → Discounts'],
    ['Sale alerts in Discord', 'Pick a channel and every sale is posted there the moment it lands — product, amount and buyer.', '/dashboard', 'Dashboard → Settings'],
    ['Members & transactions', 'Every member and payment in one place: search, CSV export, and manual extend or revoke when you need to step in.', '/dashboard', 'Dashboard → Members'],
    ['Make it yours', 'Theme presets, custom colors, corner radius and typeface — with a live preview of your storefront before anything is saved.', '/dashboard', 'Dashboard → Store → Appearance'],
    ['Discover', 'An optional public directory of Ripley stores. Off by default; list yours from the Store section if you want the traffic.', '/discover', 'Browse Discover'],
    ['Your plan', 'Free for your first 10 paying members. After that, flat monthly plans from $14.99 — always 0% of sales, on every plan.', '/#pricing', 'See pricing'],
    ['For buyers: your account', 'Cancel a renewing membership yourself, see what you own, and re-sync your Discord role if it ever goes missing.', '/account', 'Open your account'],
    ['Receipts', 'Buyers get a confirmation email after every purchase, and each payment has a receipt page they can get back to.', '/terms', 'Delivery & refunds'],
  ];
  const cards = FEATURES.map(
    ([t, d, href, label]) => `
          <a class="panel seo-card" href="${href}">
            <strong>${esc(t)}</strong>
            <p>${esc(d)}</p>
            <span class="seo-card-cta">${esc(label)} →</span>
          </a>`,
  ).join('');
  const faq = [
    ['My Discord role went missing — what do I do?', 'Open your account page and hit "Re-sync my access". It re-checks your purchases and puts the role back. If it still fails, message the server owner on Discord.'],
    ['How do I cancel a membership?', 'From your account page, any time — no asking anyone. You keep access until the end of the period you already paid for.'],
    ['Where does the money go?', 'Directly to the seller’s own Stripe account on every sale. Ripley never sits between you and your payout — Stripe pays out on its normal schedule.'],
    ['Do I need the Stripe dashboard to run my store?', 'No. Connect Stripe once with an API key; after that products, prices, discounts and refund-worthy situations are all handled from the Ripley dashboard.'],
  ];
  const body = `
    <section class="xhero seo-hero">
      <div class="hero-inner">
        <h1>Help</h1>
        <p class="hero-sub">Everything Ripley does, in about two minutes. Every card links to the real thing.</p>
      </div>
    </section>
    <section class="xsection">
      <div class="wrap narrow">
        <section class="panel sub-card legal">
          <h2>Set up in four steps</h2>
          <p>1. Open the <a href="/dashboard">dashboard</a> and sign in with Discord.</p>
          <p>2. Pick your server and invite the Ripley bot.</p>
          <p>3. Connect Stripe with an API key — payments go straight to your Stripe account.</p>
          <p>4. Create a product, attach the role it unlocks, publish. Your store is live at ripleybot.com/your-store.</p>
        </section>
      </div>
    </section>
    <section class="xsection">
      <div class="wrap">
        <h2 class="section-title center">Every feature</h2>
        <div class="seo-grid">${cards}
        </div>
      </div>
    </section>
    <section class="xsection">${faqHtml(faq)}
    </section>
${cta('Set up your store today')}`;
  return page({
    urlPath: '/help',
    title: 'Help — how Ripley works',
    desc: 'A short guide to every Ripley feature: store pages, product links, Stripe checkout, automatic role delivery, discounts, sale alerts, themes and plans.',
    body,
    jsonld: [faqJsonld(faq)],
    crumbs: [['Help', '/help']],
  });
}

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

emit('guides/index.html', guidesIndex());
for (const [slug, g] of Object.entries(GUIDES)) emit(`guides/${slug}.html`, guidePage(slug, g));

emit('alternatives/index.html', altIndex());
emit('help.html', helpPage());
for (const [slug, a] of Object.entries(ALTERNATIVES)) emit(`alternatives/${slug}.html`, altPage(slug, a));

// llms.txt: the emerging convention answer engines read for a site summary.
// Facts only — the same claims the pages make, in plain markdown.
emit(
  'llms.txt',
  `# Ripley

> Ripley (https://www.ripleybot.com) is a Discord monetization platform. Server owners sell paid memberships and roles through a hosted store page (ripleybot.com/yourname); buyers sign in with Discord and pay on Stripe Checkout; the Discord role is delivered automatically in seconds and removed automatically when a subscription lapses. Payments go directly to the store owner's own Stripe account — Ripley never holds funds. Pricing is a flat monthly plan (free up to 10 paying members, then from $14.99/month) and Ripley takes 0% of sales. Stripe's standard card-processing fees apply, as on every platform.

Key product facts:
- 0% platform fees on sales; flat plans: Free (10 paying members), Starter $14.99/mo (50), Growth $44.99/mo (500), Scale $134.99/mo (unlimited)
- Payments settle in the owner's own Stripe account (owner supplies their Stripe key)
- Instant role delivery (~2s) and automatic removal on cancellation/lapse; hourly access re-checks
- Store page at ripleybot.com/<name> with the server's branding and product photos
- Monthly subscriptions, lifetime (one-time) products, tiered roles, discount codes, purchase limits
- Emailed receipts on every sale; optional "New Subscriber" ping in a Discord channel of the owner's choice
- Dashboard: revenue with previous-period comparison, members, transactions, refunds-safe revoke/re-sync

## Compare
- [Ripley vs Whop](${BASE}/vs/whop)
- [Ripley vs LaunchPass](${BASE}/vs/launchpass)
- [Ripley vs Subscord](${BASE}/vs/subscord)
- [Ripley vs Patreon](${BASE}/vs/patreon)
- [All comparisons](${BASE}/vs)

## Guides
- [How to monetize a Discord server](${BASE}/guides/how-to-monetize-a-discord-server)
- [How to sell Discord roles](${BASE}/guides/how-to-sell-discord-roles)
- [How to make a paid Discord server](${BASE}/guides/paid-discord-server)
- [What a Discord subscription bot does](${BASE}/guides/discord-subscription-bot)

## Tools
- [Discord monetization fee calculator](${BASE}/tools/discord-fee-calculator)

Competitor pricing referenced anywhere on this site is the publicly listed pricing at the time of writing and is always marked to be verified on the competitor's own site.
`,
);

// sitemap + robots: the landing page plus every generated page. Store pages
// are user content and terms/privacy/dashboard/account are noindex — none of
// those belong in the sitemap.
const urls = ['/', '/vs', ...Object.keys(COMPETITORS).map((s) => `/vs/${s}`), '/tools',
  '/tools/discord-fee-calculator', '/tools/whop-fee-calculator', '/tools/launchpass-fee-calculator', '/tools/patreon-fee-calculator',
  '/use-cases', ...Object.keys(USE_CASES).map((s) => `/use-cases/${s}`),
  '/guides', ...Object.keys(GUIDES).map((s) => `/guides/${s}`),
  '/alternatives', ...Object.keys(ALTERNATIVES).map((s) => `/alternatives/${s}`),
  '/discover', '/help'];
const today = new Date().toISOString().slice(0, 10);
emit(
  'sitemap.xml',
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${BASE}${u}</loc><lastmod>${today}</lastmod></url>`)
    .join('\n')}\n</urlset>\n`,
);
// AI answer engines are welcome by name — their crawlers check for explicit
// allowances, and these pages are exactly what they should be citing.
const AI_BOTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-Web', 'PerplexityBot', 'Google-Extended', 'CCBot'];
emit(
  'robots.txt',
  `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /dashboard\nDisallow: /account\nDisallow: /receipt\n\n${AI_BOTS.map((b) => `User-agent: ${b}\nAllow: /`).join('\n\n')}\n\nSitemap: ${BASE}/sitemap.xml\n`,
);

// The landing page is hand-written, but its footer is not — it is stamped from
// the same footerHtml the generated pages use. Two hand-maintained copies
// drifted once already: /vs/subscord shipped and was linked everywhere except
// the homepage, which is the one page most visitors ever see.
{
  const landing = path.join(PUB, 'index.html');
  const html = fs.readFileSync(landing, 'utf8');
  const B = '<!-- footer:begin', E = '<!-- footer:end -->';
  const i = html.indexOf(B);
  const j = html.indexOf(E);
  if (i === -1 || j === -1) throw new Error('index.html has lost its footer markers');
  const openTagEnd = html.indexOf('-->', i) + 3;
  fs.writeFileSync(landing, `${html.slice(0, openTagEnd)}\n${footerHtml.trim()}\n  ${html.slice(j)}`);
  out.push('index.html (footer)');
}

console.log(`generated ${out.length} files:\n  ${out.join('\n  ')}`);
