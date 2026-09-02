// Static SEO page generator: comparison pages (/vs/*), fee calculators
// (/tools/*) and use-case pages (/use-cases/*), plus sitemap.xml and
// robots.txt. Pages are committed build artifacts — Vercel serves public/
// as-is, so run `node scripts/gen-seo-pages.mjs` after editing and commit
// the output.
//
// Content rules: every competitor number is their PUBLICLY LISTED pricing,
// always asterisked to "check their site"; Dues claims only what the
// product actually does. No fabricated testimonials, counts or reviews.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The community invite comes from the same config field the site hop
// (/api/community) and the receipt email read, so re-issuing it is one edit
// plus a regenerate rather than a search-and-replace across every page here.
import { config } from '../src/config.js';
// The settlement ordering the crypto checkout actually sorts its coin picker
// by. Imported rather than retyped: /crypto explains this table to sellers,
// and a hand-written second copy is a page that silently stops being true.
import { CHAIN_RANK } from '../src/lib/nowpayments.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const BASE = 'https://dues.gg';
const V = '207'; // keep in step with the ?v= asset version on index.html
// Describes the shared link-preview card (public/og-card.jpg), which is a
// render of the homepage hero — see scripts/build-og-card.mjs.
const OG_ALT =
  "The Dues homepage: a bright daytime sky with the headline 'Monetize your community.' and a field for claiming a store link";

// Dues plan facts (src/services/billing.js TIERS — keep in sync).
const RIPLEY_TIERS = [
  { name: 'Free', priceUsd: 0, maxMembers: 10 },
  { name: 'Pro', priceUsd: 14.99, maxMembers: 50 },
  { name: 'Max', priceUsd: 44.99, maxMembers: 500 },
  { name: 'Unlimited', priceUsd: 134.99, maxMembers: null },
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
      'Subscord is a Discord subscription bot in the same category as Dues: paid plans gate roles, checkout runs on Stripe. Its pricing and fees are plan-dependent — check subscord.com for current numbers.',
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
  // Discord-native competitor. Publicly listed pricing pairs a free plan
  // carrying a percentage with a paid plan that lowers it — the headline
  // number here is the free-plan rate, asterisked as always.
  doorfee: {
    name: 'DoorFee',
    feeLine: '10% on the free plan, or a monthly plan + a lower cut*',
    cost: (rev) => rev * 0.1,
    blurb:
      'DoorFee is a Discord monetization tool with a page builder and marketing add-ons. Its listed pricing charges a percentage of every sale — higher on the free plan, lower on a paid monthly plan.',
    rows: { fee: '10% free plan / lower on paid*', monthly: '$0 free plan, paid plan available*', money: 'Your own payment account*', store: 'Hosted checkout page' },
  },
  // Discord-native, crypto-forward. Card sales are listed at 0% with a
  // percentage on crypto and an optional paid tier — so this page compares
  // on model (flat, card-native, your own Stripe), never on a fake fee.
  xoe: {
    name: 'XOE',
    feeLine: 'card sales at 0%, a cut on crypto, optional paid tier*',
    cost: null,
    blurb:
      'XOE is a Discord payment and security bot that leans on crypto: its listed pricing takes a percentage on crypto payments, keeps card sales at 0%, and offers an optional paid tier. Dues is the card-native, flat-plan shape of the same job.',
    rows: { fee: '0% on cards, a cut on crypto*', monthly: 'Free, optional paid tier*', money: 'Cards to Stripe / crypto to a wallet*', store: 'Hosted checkout page' },
  },
};

const USE_CASES = {
  trading: {
    name: 'Trading Communities',
    h1: 'Sell Access to Your Trading Discord',
    desc: 'Charge for your trading signals, analysis channels and mentorship with 0% platform fees. Payments go straight to your own Stripe account.',
    intro:
      'Signal groups, futures rooms, options flow, crypto research: if your calls are worth following, they are worth paying for. Dues puts a checkout in front of your premium channels and delivers the member role the second payment clears.',
    points: [
      ['Premium role, instantly', 'Buyers get the role that unlocks your signals channels within seconds of paying.'],
      ['Monthly or lifetime', 'Sell a monthly membership, a lifetime seat, or both at different prices.'],
      ['Access that heals itself', 'If a subscription lapses, the role comes off automatically — no manual pruning.'],
    ],
    faq: [
      ['Do I need my own Stripe account?', 'Yes — that is the point. Every payment lands directly in your own Stripe account. Dues never holds your money.'],
      ['What happens when a member cancels?', 'When the subscription ends, Dues removes the paid role automatically. Members in good standing are re-checked hourly.'],
      ['Can I charge different prices for different channels?', 'Yes. Each product maps to its own Discord role, so you can sell tiered access at different prices.'],
    ],
  },
  'sports-betting': {
    name: 'Sports Picks Communities',
    h1: 'Sell Memberships to Your Sports Picks Discord',
    desc: 'Monetize your sports handicapping community with 0% platform fees, instant role delivery and payments straight to your own Stripe account.',
    intro:
      'Cappers live and die by their record. Platform fees should not decide your revenue. Dues gates your picks channels behind a clean checkout, keeps 0% of your sales, and removes access when a subscription lapses.',
    points: [
      ['Gate your picks channels', 'Free lobby for the record, paid role for the plays. Buyers unlock instantly.'],
      ['Weekly-equivalent pricing', 'Sell monthly memberships at any price point, or lifetime seats for your core group.'],
      ['Discount codes', 'Run promos with percentage or fixed-amount codes, capped and expiring however you like.'],
    ],
    faq: [
      ['Does Dues take a cut of sales?', 'No. Dues charges a flat monthly plan and takes 0% of your sales. Stripe’s standard card fees still apply, as they do everywhere.'],
      ['How fast do buyers get access?', 'The role is delivered the moment Stripe confirms payment — typically within a couple of seconds.'],
      ['Can I remove someone manually?', 'Yes — revoke from the dashboard and the role comes off immediately.'],
    ],
  },
  fitness: {
    name: 'Fitness & Coaching',
    h1: 'Sell Your Coaching Community on Discord',
    desc: 'Turn your fitness coaching Discord into a paid membership with 0% platform fees and automatic role delivery.',
    intro:
      'Programming channels, check-in threads, form review, accountability groups: coaching happens in Discord already. Dues adds the paywall. Members pay on a hosted checkout and get their client role in seconds.',
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
      'Monitors, sitelists, restock pings and flip guides earn while they are fast, so your checkout should be fast too. Dues delivers the member role seconds after payment and takes 0% of your sales.',
    points: [
      ['Limited seats', 'Set a purchase limit on any product and Dues stops selling when it is full.'],
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
      'Product research channels, supplier contacts, store teardowns, weekly Q&A: the mentorship already lives in your server. Dues adds the payment layer and takes no cut of it.',
    points: [
      ['Tiered mentorship', 'Sell basic and inner-circle tiers as separate products with separate roles.'],
      ['Your own Stripe account', 'Revenue lands in your Stripe directly. Dues never touches your money.'],
      ['Analytics built in', 'Revenue, sales and member growth with previous-period comparisons.'],
    ],
    faq: [
      ['How do tiers work?', 'Each product grants its own role. Stack channels behind roles however you like.'],
      ['Can I offer a founding-member discount?', 'Yes — create a discount code with a use cap and expiry.'],
      ['Is there a free plan?', 'Yes. Dues is free until your store passes 10 paying members.'],
    ],
  },
  'exclusive-content': {
    name: 'Exclusive Content',
    h1: 'Sell Exclusive Content in Your Discord',
    desc: 'Put your exclusive drops, early access and behind-the-scenes channels behind a paid Discord role — 0% platform fees.',
    intro:
      'Early videos, extended cuts, sample packs, presets, art drops: creators run exclusives through Discord because the community already lives there. Dues gates those channels with a role your fans buy in one checkout.',
    points: [
      ['One link to share', 'dues.gg/yourname — put it in every bio. It is your store.'],
      ['Lifetime or recurring', 'Sell a one-time supporter pass or a monthly membership.'],
      ['Fans stay yours', 'No marketplace between you and your audience — buyers check out under your name.'],
    ],
    faq: [
      ['Do I need a website?', 'No. Your Dues store page is hosted for you at your own link with your name and icon.'],
      ['What does Dues cost?', 'Free for your first 10 paying members, then flat plans from $14.99/mo. Dues takes 0% of sales.'],
      ['Can fans pay with Apple Pay?', 'Checkout is Stripe-hosted — cards, Apple Pay, Google Pay and Link, per your Stripe settings.'],
    ],
  },
};

// ── shared page chrome ────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Day-sky retheme (the landing page's light look, statically): these pages are
// DAY-ONLY — the tokens below override styles.css in every data-theme state,
// so the ground is always the sky gradient, panels are frosted white glass,
// and the one action color is blurple. Colors/surfaces only; markup untouched.
const DAY_CSS = `
/* day-sky theme — overrides the monochrome tokens in styles.css (all states) */
:root, :root[data-theme='light'], :root[data-theme='dark'] {
  color-scheme: light;
  --bg: #f4f8fd;
  /* iOS paints the strips behind its own bars by sampling a fixed element at
     each viewport edge — .ui-tint and .ui-tint-b in styles.css. This page is
     SKY at the top and PAPER below, so the two edges are different colours,
     and the single value they used to share is what put a band of sky blue
     under a near-white footer at the bottom of all 48 of these pages. */
  --ui-tint: #70a3e6;
  --ui-tint-b: #f4f8fd;
  --panel: rgba(255,255,255,.62);
  --panel-hover: rgba(255,255,255,.86);
  --edge: rgba(255,255,255,.75);
  --edge-selected: rgba(15,22,38,.32);
  --ink: #0f1626;
  --dim: #43506a;
  --accent: #5865f2;
  --accent-hot: #4752e8;
  --accent-ink: #ffffff;
  --well: rgba(255,255,255,.5);
  --raised: rgba(255,255,255,.72);
  --hairline: rgba(15,22,38,.08);
  --hairline-2: rgba(15,22,38,.12);
  --edge-hot: rgba(15,22,38,.28);
  --active-fill: rgba(255,255,255,.92);
  --faint: #8fa0bd;
  --solid: #5865f2;
  --solid-ink: #ffffff;
  --blurple: #5865f2;
  --blurple-text: #424cbd;
  --good: #15803d;
  --bad: #c43c3c;
  --money: #15803d;
  --amber: #9a6207;
}
/* the Discord-native landing block re-declares the dark surface tokens under
   html:not([data-theme='light']) body.home — out-specify it back to day */
body.home,
html:not([data-theme='light']) body.home,
html[data-theme='light'] body.home {
  --bg: #f4f8fd;
  --panel: rgba(255,255,255,.62);
  --panel-hover: rgba(255,255,255,.86);
  --well: rgba(255,255,255,.5);
  --raised: rgba(255,255,255,.72);
  --edge: rgba(255,255,255,.75);
  --edge-hot: rgba(15,22,38,.28);
  --hairline: rgba(15,22,38,.08);
  --hairline-2: rgba(15,22,38,.12);
  --active-fill: rgba(255,255,255,.92);
  --ink: #0f1626;
  --dim: #43506a;
  --faint: #8fa0bd;
  --brand-text: #4a54d6;
}
/* static day ground: sky at the top, paper below; html stays sky so iOS
   chrome and overscroll blend */
html, html[data-theme='light'], html[data-theme='dark'] { background: #70a3e6; }
/* styles.css carries html[data-theme='light'] body at (0,1,2), which
   out-specifies a bare body selector however late this sheet comes. The sky
   here was flattened to a solid --bg the moment a visitor had ever tapped
   the toggle on the landing. Match that specificity and the ground stays.
   No backticks in this comment: the generator emits it from inside a
   template literal, where one would end the string. */
body, body.home, html[data-theme='light'] body {
  background: linear-gradient(180deg, #70a3e6 0%, #adceed 420px, #f4f8fd 820px, #f4f8fd 100%);
  color: var(--ink);
}
/* frosted white glass panels */
.panel, body.home .panel {
  background: rgba(255,255,255,.62);
  border: 1px solid rgba(255,255,255,.75);
  border-radius: 18px;
  box-shadow: 0 18px 40px -18px rgba(40,60,120,.25);
}
/* nav: white glass over the sky (also when a scroll listener adds .scrolled) */
.top, body.home .top,
html:not([data-theme='light']) body.home .top.scrolled,
html[data-theme='light'] body.home .top.scrolled {
  background: rgba(255,255,255,.55);
  border-bottom: 1px solid rgba(255,255,255,.65);
}
/* the wordmark ships as a white PNG — always invert it on the day ground */
.platform-mark, .powered-mark { filter: invert(1); }
/* these pages are day-only: no theme toggle */
.theme-btn { display: none; }
/* blurple pill buttons */
.btn-fill, .btn-blurple { background: #5865f2; color: #ffffff; border-radius: 999px; }
.btn-fill:hover, .btn-blurple:hover { filter: none; background: #4752e8; }
.btn-pill, .btn-secondary { border-radius: 999px; }
/* big headings sit a touch lighter on the sky */
h1, .xhero h1, .section-title { font-weight: 600; }
/* hero copy sits on the deepest sky — needs near-ink, not 60% ink */
.xhero .hero-sub, .seo-hero .hero-sub, .disc-hero .hero-sub { color: rgba(15,22,38,.82); }
body.home .disc-hero .kicker { color: rgba(15,22,38,.72); }
/* hairlines that only existed as white-on-dark need real ink now */
.cmp-table th { border-bottom-color: rgba(15,22,38,.2); }
.disc-meta { border-top-color: rgba(15,22,38,.12); }
/* footnotes need real muted ink, not a transparent mix */
.calc-note, .footer-disclaimer { color: #66748f; }
.calc-bar-sub { color: rgba(15,22,38,.55); }
/* links read blurple everywhere — the TEXT blurple. #5865f2 is 4.3:1 on the
   paper and ~3.1:1 where the sky still tints the ground. --blurple-text is
   the darkest shade that still reads as blurple: #424cbd measures 6.6:1 on
   the paper and 5.0:1 on the bluest band a prose link sits on (the top of
   /guides/discord-monetization-ideas, ground #c4dcf3 — where #4753c9 was
   4.4). Same for every other blurple-on-paper text: card CTAs, the "Dues"
   table column and the calculator readouts, which styles.css paints with
   --accent. */
.guide-body a { color: var(--blurple-text); }
.alt-card .seo-card-cta a { color: var(--blurple-text); }
.seo-card-cta, .cmp-table th:nth-child(2), .calc-label output { color: var(--blurple-text); }
/* …and the four styles.css rules that paint TEXT with --accent, which on
   these pages IS the button blurple: the prose links inside a legal/help
   card and an FAQ answer, the tick-list links, and the step numerals on the
   use-case pages. They were missed because the sweep above listed the
   selectors this generator writes, not the ones styles.css already applies:
   measured on the served pages, /help's "dashboard" link, /terms' "account
   page", /vs/*'s "fee calculator" and /use-cases/*'s 1-2-3 numerals were all
   still #5865f2, 4.3:1 on the paper. */
.legal a, .faq-item a, .seo-ticks a, .seo-step-num { color: var(--blurple-text); }
/* "our product" chip on the alternatives lists */
.alt-ours { background: #5865f2; color: #ffffff; }
/* search box as glass (discover) */
.search-box { background: rgba(255,255,255,.62); border-color: rgba(255,255,255,.75); }
`;

const nav = `
  <header class="top xoe-nav">
    <div class="top-left">
      <a href="/"><img class="platform-mark" src="/dues.png?v=207" alt="Dues" height="20" /></a>
    </div>
    <nav class="top-center" aria-label="Main">
      <a class="nav-link" href="/discover">Discover</a>
      <a class="nav-link" href="/pricing">Pricing</a>
      <a class="nav-link" href="/vs">Compare</a>
      <a class="nav-link" href="/tools">Tools</a>
    </nav>
    <div class="top-right">
      <div class="account"><a class="btn-fill" href="/dashboard">Start free</a></div>
      <button class="theme-btn" data-theme-toggle aria-label="Switch color theme"><svg class="tb-sun" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4L19 19M19 5l-1.6 1.6M6.6 17.4L5 19"/></svg><svg class="tb-moon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>
    </div>
  </header>`;

// Index links are the bare form — /vs, never /vs/. The canonical, the sitemap,
// every breadcrumb and every vercel.json rewrite all name the bare URL; a
// trailing slash here linked a second URL for the same page from 46 pages,
// held together only by rel=canonical (or a redirect hop, depending on the
// host). And each column links its own index, so /guides and /use-cases are
// reachable from somewhere other than the homepage.
export const footerHtml = `
  <footer class="site-footer cols seo-footer">
    <div class="footer-brand">
      <img class="powered-mark" src="/dues.png?v=207" alt="Dues" height="16" />
      <span class="footer-copy">© Dues</span>
    </div>
    <nav class="footer-col"><span class="footer-head">Product</span>
      <a href="/discover">Discover stores</a><a href="/pricing">Plans</a><a href="/pricing">Pricing</a><a href="/help">FAQ</a>
      <a href="/help">Help</a><a href="/crypto">Crypto payments</a><a href="/dashboard">Dashboard</a><a href="/account">Your account</a>
      <a href="${config.communityInvite}" rel="noopener">Community Discord</a><a href="mailto:contact@dues.gg">contact@dues.gg</a></nav>
    <nav class="footer-col"><span class="footer-head">Compare</span>
      <a href="/vs/whop">Dues vs Whop</a><a href="/vs/launchpass">Dues vs LaunchPass</a>
      <a href="/vs/subscord">Dues vs Subscord</a><a href="/vs/doorfee">Dues vs DoorFee</a>
      <a href="/vs/xoe">Dues vs XOE</a><a href="/vs/patreon">Dues vs Patreon</a>
      <a href="/vs/memberful">Dues vs Memberful</a><a href="/vs/gumroad">Dues vs Gumroad</a>
      <a href="/vs/ko-fi">Dues vs Ko-fi</a><a href="/vs/buymeacoffee">Dues vs Buy Me a Coffee</a>
      <a href="/vs/upgrade-chat">Dues vs Upgrade.Chat</a><a href="/vs/mighty-networks">Dues vs Mighty Networks</a>
      <a href="/vs">All comparisons</a>
      <a href="/alternatives/best-discord-monetization-platforms">Best platforms</a>
      <a href="/alternatives/whop-alternatives">Whop alternatives</a>
      <a href="/alternatives">All alternatives</a></nav>
    <nav class="footer-col"><span class="footer-head">Guides</span>
      <a href="/guides/best-discord-monetization-platform">Best platform to use</a>
      <a href="/guides/how-to-monetize-a-discord-server">Monetize a Discord server</a>
      <a href="/guides/how-to-sell-discord-roles">Sell Discord roles</a>
      <a href="/guides/discord-paywall">Paywall a Discord</a>
      <a href="/guides/discord-membership-bot">Discord membership bots</a>
      <a href="/guides">All guides</a></nav>
    <nav class="footer-col"><span class="footer-head">Tools</span>
      <a href="/tools/discord-fee-calculator">Discord fee calculator</a>
      <a href="/tools/whop-fee-calculator">Whop fee calculator</a>
      <a href="/tools/launchpass-fee-calculator">LaunchPass fee calculator</a>
      <a href="/tools/patreon-fee-calculator">Patreon fee calculator</a>
      <a href="/tools">All calculators</a></nav>
    <nav class="footer-col"><span class="footer-head">Use cases</span>
      <a href="/use-cases/trading">Trading signals</a><a href="/use-cases/sports-betting">Sports picks</a>
      <a href="/use-cases/fitness">Fitness coaching</a><a href="/use-cases/reselling">Cook groups</a>
      <a href="/use-cases/ecommerce">Ecommerce mentorship</a><a href="/use-cases/exclusive-content">Exclusive content</a>
      <a href="/use-cases">All use cases</a></nav>
    <nav class="footer-col"><span class="footer-head">Legal</span><a href="/terms">Terms</a><a href="/privacy">Privacy</a></nav>
    <p class="footer-disclaimer">Not affiliated with Discord Inc. or any platform compared here. Competitor pricing as publicly listed — verify on their sites. Payments are processed by Stripe on each store owner’s own account.</p>
  </footer>`;

function page({ urlPath, title, desc, body, jsonld = [], crumbs = [] }) {
  const canonical = `${BASE}${urlPath}`;
  const breadcrumb = crumbs.length
    ? [{
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Dues', item: `${BASE}/` }].concat(
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
  <meta name="theme-color" content="#70a3e6" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${canonical}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:image" content="${BASE}/og-card.jpg?v=${V}" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${esc(OG_ALT)}" />
  <!-- site_name draws the brand pill X lays over a large-image card and the
       line Discord prints above the title; without it every one of these pages
       unfurls as a bare screenshot from an unnamed domain. -->
  <meta property="og:site_name" content="Dues" />
  <meta property="og:locale" content="en_US" />
  <meta property="og:url" content="${canonical}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@duesdiscord" />
  <meta name="twitter:creator" content="@duesdiscord" />
  <meta name="twitter:image" content="${BASE}/og-card.jpg?v=${V}" />
  <meta name="twitter:image:alt" content="${esc(OG_ALT)}" />
  <!-- Icons, all four at STABLE urls with no ?v= on them: Google caches the
       search-result favicon by URL and re-crawls it rarely, so a version query
       that moves on every ship hands it a URL it has never seen instead of the
       one it already holds. Sizes are what favicon.ico IS — 48 and 96, built
       by scripts/gen-favicon-ico.mjs, which reads its output back and carries
       the rule as Google states it: square, at least 8x8, larger than 48x48
       recommended. -->
  <link rel="icon" href="/favicon.ico" sizes="48x48 96x96" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="icon" type="image/png" sizes="96x96" href="/favicon-96x96.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <link rel="stylesheet" href="/styles.css?v=${V}" />
  <style>${DAY_CSS}</style>
  ${ld}
  <script src="/theme.js?v=207"></script>
</head>
<body class="home seo-page">
<i class="ui-tint" aria-hidden="true"></i>
<i class="ui-tint-b" aria-hidden="true"></i>
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

const duesRows = {
  fee: '0% — always',
  monthly: 'Free up to 10 paying members, then from $14.99/mo',
  money: 'Your own Stripe account, directly',
  store: 'dues.gg/yourname',
};

// ── /vs/<competitor> ──────────────────────────────────────────────────────────

function vsPage(slug, c) {
  const title = `Dues vs ${c.name} — Discord monetization compared`;
  const desc = `${c.name} charges ${c.feeLine.replace('*', '')} — Dues takes 0% of your sales and payments land in your own Stripe account. A side-by-side comparison for Discord server owners.`;
  const faq = [
    [`How much does ${c.name} cost compared to Dues?`, `${c.name}'s publicly listed pricing is ${c.feeLine.replace('*', '')}. Dues charges a flat plan (free up to 10 paying members, then from $14.99/mo) and takes 0% of your sales.`],
    ['Does Dues really take 0% of sales?', 'Yes. Dues charges a flat monthly plan only. Stripe’s standard card-processing fees still apply, as they do on every platform.'],
    ['Where does my money go with Dues?', 'Straight into your own Stripe account. Dues never holds, routes, or freezes your funds.'],
    ['Can I switch without losing my members?', 'Your members keep their Discord roles while you set Dues up, and your Stripe customers stay in your own Stripe account either way.'],
  ];
  const row = (k, label) => `
            <tr><td>${esc(label)}</td><td class="cmp-good">${esc(duesRows[k])}</td><td>${esc(c.rows[k])}</td></tr>`;
  const body = `
    <section class="xhero seo-hero">
      <div class="hero-inner">
        <h1>Dues vs ${esc(c.name)}</h1>
        <p class="hero-sub">${esc(c.blurb)}</p>
        <p class="hero-sub">Dues is the other model: a flat plan, <strong>0% of your sales</strong>, and payments that land in <strong>your own Stripe account</strong> with roles delivered in seconds.</p>
      </div>
    </section>
    <section class="xsection">
      <div class="wrap narrow">
        <div class="panel cmp-card">
          <div class="table-scroll"><table class="cmp-table">
            <thead><tr><th></th><th>Dues</th><th>${esc(c.name)}</th></tr></thead>
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
        <h2 class="section-title center">Why server owners pick Dues</h2>
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
    crumbs: [['Compare', '/vs'], [`Dues vs ${c.name}`, `/vs/${slug}`]],
    jsonld: [faqJsonld(faq)],
  });
}

function vsIndex() {
  const cards = Object.entries(COMPETITORS)
    .map(
      ([slug, c]) => `
          <a class="panel seo-card" href="/vs/${slug}">
            <strong>Dues vs ${esc(c.name)}</strong>
            <p>${esc(c.rows.fee)} vs Dues's 0% — the full side-by-side.</p>
            <span class="seo-card-cta">Compare →</span>
          </a>`,
    )
    .join('');
  const body = `
    <section class="xhero seo-hero">
      <div class="hero-inner">
        <h1>Compare Discord Monetization Platforms</h1>
        <p class="hero-sub">Every platform below is a real way to sell Discord access. The difference is what it costs you and who holds your money. Dues takes 0% of sales and your revenue lands in your own Stripe account.</p>
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
    title: 'Dues vs Whop, LaunchPass & Patreon — Discord monetization',
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
    function duesCost(members) {
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
      var dues = duesCost(m);
      var rows = ${rowsJs};
      var max = dues; rows.forEach(function (r) { if (r.cost > max) max = r.cost; });
      var worst = 0;
      document.getElementById('t-dues').textContent = fmt(dues) + '/mo';
      document.getElementById('t-bar-dues').style.width = Math.max((dues / (max || 1)) * 100, 2) + '%';
      rows.forEach(function (r) {
        if (r.cost > worst) worst = r.cost;
        document.getElementById('t-' + r.id).textContent = fmt(r.cost) + '/mo';
        document.getElementById('t-bar-' + r.id).style.width = Math.max((r.cost / (max || 1)) * 100, 2) + '%';
      });
      document.getElementById('t-save').textContent = fmt(Math.max(worst - dues, 0) * 12) + '/yr';
    }
    subs.addEventListener('input', upd); price.addEventListener('input', upd); upd();
  })();
  </script>`;
}

function calcBars(rows) {
  return `
            <div class="calc-bar-row" id="t-row-dues">
              <div class="calc-bar-meta"><span class="calc-bar-name">Dues</span><span class="calc-bar-amt" id="t-dues">$0</span></div>
              <div class="calc-bar mine"><span id="t-bar-dues"></span></div>
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
                <span class="calc-result-label" style="margin-top:12px">Estimated annual savings with Dues</span>
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
  doorfee: 'rev * 0.10',
};

function competitorCalculator(key) {
  const c = COMPETITORS[key];
  const slug = `${key}-fee-calculator`;
  const rows = [{ id: key, name: c.name, feeLine: c.feeLine }];
  const rowsJs = `[{ id: '${key}', cost: ${COST_EXPR[key]} }]`;
  const faq = [
    [`How much does ${c.name} take from my sales?`, `${c.name}'s publicly listed pricing is ${c.feeLine.replace('*', '')}. Check their site for current numbers.`],
    ['What does Dues cost?', 'Free up to 10 paying members, then flat plans from $14.99/mo. Dues takes 0% of your sales.'],
    ['Are Stripe fees included?', 'No — Stripe’s standard card-processing fees apply on every platform, so they cancel out of the comparison.'],
  ];
  return {
    slug,
    html: calculatorPage({
      slug,
      title: `${c.name} fee calculator — what it costs your Discord`,
      desc: `Estimate what ${c.name}'s fees (${c.feeLine.replace('*', '')}) cost your Discord community each month, compared with Dues's flat 0%-fee plans.`,
      h1: `${c.name} Fee Calculator`,
      intro: `${c.name}'s publicly listed pricing is ${c.feeLine.replace('*', '')}. Move the sliders to see what that costs at your size — and what the same store costs on Dues's flat plans.`,
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
    ['Which Discord monetization platform is cheapest?', 'It depends on your volume: percentage-fee platforms get more expensive as you grow, flat-fee platforms do not. Dues is a flat plan (free up to 10 paying members, then from $14.99/mo) with 0% of sales.'],
    ['Are these the platforms’ real prices?', 'They are the publicly listed prices at the time this page was written, marked with an asterisk — always check the platform’s own site for current numbers.'],
    ['Does 0% platform fees mean completely free?', 'Dues’s plans are flat monthly subscriptions and the platform takes 0% of your sales. Stripe’s standard card-processing fees apply everywhere.'],
  ];
  return {
    slug: 'discord-fee-calculator',
    html: calculatorPage({
      slug: 'discord-fee-calculator',
      title: 'Discord fee calculator — Whop vs LaunchPass vs Dues',
      desc: 'Compare what Whop, LaunchPass, Patreon and Upgrade.Chat cost your Discord community each month against Dues’s flat 0%-fee plans.',
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
    ['discord-fee-calculator', 'Discord fee calculator', 'Whop vs LaunchPass vs Patreon vs Upgrade.Chat vs Dues, at your numbers.'],
    ['whop-fee-calculator', 'Whop fee calculator', "What 3% of sales adds up to at your community's size."],
    ['launchpass-fee-calculator', 'LaunchPass fee calculator', 'What $29/mo + 3.5% of sales costs as you grow.'],
    ['patreon-fee-calculator', 'Patreon fee calculator', 'What 8–12% of earnings means in real dollars.'],
    ['doorfee-fee-calculator', 'DoorFee fee calculator', "What DoorFee's percentage costs your Discord as you grow."],
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
    ['Connect your server', 'Sign in with Discord, pick your server, and add the Dues bot.'],
    ['Create your products', 'Name, price, photo, and the role each product unlocks — built in the dashboard, no Stripe dashboard needed.'],
    ['Share your link', 'Your store lives at dues.gg/yourname. Buyers pay on Stripe and get their role in seconds.'],
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
          <li><strong>0% platform fees</strong> — Dues charges a flat plan and never takes a cut of your sales.</li>
        </ul>
      </div>
    </section>
    <section class="xsection">${faqHtml(u.faq)}</section>
${cta()}`;
  return page({
    urlPath: `/use-cases/${slug}`,
    title: `${u.h1} — Dues`,
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
        <h1>What Communities Sell with Dues</h1>
        <p class="hero-sub">If your server has something worth paying for, Dues sells it and delivers the role — with 0% platform fees and payments straight to your own Stripe account.</p>
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
    title: 'Discord monetization use cases — trading, coaching & more',
    desc: 'How trading groups, sports picks communities, coaches, cook groups and creators sell Discord access with 0% platform fees on Dues.',
    body,
    crumbs: [['Use cases', '/use-cases']],
  });
}

// ── /guides/<slug> — long-form how-tos for the queries owners actually type ──
// Content rules as everywhere: Dues claims only what the product does,
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
      ['Choose the payment layer', `<p>This is where most owners lose money without noticing. The options fall into three camps:</p><ul><li><strong>Marketplaces</strong> (Whop and similar) — your store lives on their domain and they take a percentage of every sale.</li><li><strong>Percentage platforms</strong> (LaunchPass, Patreon, Ko-fi and similar) — a cut of your revenue, sometimes on top of a monthly fee.</li><li><strong>Flat-fee platforms</strong> (Dues) — a fixed monthly plan, 0% of sales, payments straight into your own Stripe account.</li></ul><p>Percentages feel painless at $200/mo and brutal at $5,000/mo. Run your own numbers in the <a href="/tools/discord-fee-calculator">fee calculator</a>, or see the <a href="/vs">side-by-side comparisons</a>.</p>`],
      ['Gate the channels behind a role', `<p>Structure the server so free members can see that the paid area exists: a public lobby, a pinned message describing what is inside, and locked channels visible but unreadable. Create one role per product, put the premium channels behind it, and let the payment layer grant and remove that role automatically.</p><p>One Discord-specific pitfall: the bot delivering roles must sit <em>above</em> the roles it manages in Server Settings → Roles, or Discord will refuse the assignment.</p>`],
      ['Launch without a relaunch', `<p>Announce once, pin the store link, and put it in the server description and your bios. A short launch discount (a code with an expiry and a redemption cap) gives the announcement urgency without training members to wait for sales.</p>`],
      ['Keep access healthy after launch', `<p>The part nobody plans for: cancellations, failed renewals, chargebacks, people leaving and rejoining. Manual role pruning does not survive contact with a growing server. Whatever platform you pick, make sure lapsed subscriptions lose the role automatically, access is re-checked on a schedule, and you can revoke or re-sync one member without spelunking. Buyers should get a receipt they can find later — it cuts support pings dramatically.</p>`],
    ],
    faq: [
      ['How many members do I need to monetize a Discord server?', 'There is no minimum. A server with 200 engaged members in a niche where information has value often out-earns a 20,000-member general server. Conversion depends on how much your paid channels are worth, not raw size.'],
      ['Can I charge for Discord access directly through Discord?', 'Discord’s own Server Subscriptions exist but are limited by region and take a platform share. Most owners use an external checkout layer that grants roles, which keeps pricing and payout terms in their control.'],
      ['What should I charge for a paid Discord?', 'Typical ranges: $10–$30/mo for signals and picks communities, $25–$100/mo for coaching or mentorship, and 3–6× the monthly price for lifetime seats. Price against the value of the information, then adjust from real conversion.'],
      ['Do I need my own Stripe account?', 'On Dues, yes — that is the design. Payments land directly in your own Stripe account and Dues never holds your money. On marketplaces, the platform holds funds and pays you out on their schedule.'],
    ],
  },
  'how-to-sell-discord-roles': {
    title: 'How to Sell Discord Roles (Step by Step)',
    desc: 'Sell Discord roles with automatic delivery: create the role, gate your channels, connect Stripe, set a price, and share your store link.',
    h1: 'How to Sell Discord Roles',
    intro: 'A paid role is the cleanest product a Discord server can sell: buyers pay, the role lands, the channels unlock. Here is the whole setup, end to end.',
    sections: [
      ['1. Create the role and gate the channels', `<p>Make a role named after the product (<em>@VIP</em>, <em>@Signals</em>, <em>@Inner Circle</em>) and set your premium channels to be visible only with it. Leave a public lobby so non-members can see what they are missing.</p>`],
      ['2. Connect a checkout that delivers roles', `<p>Invite the payment bot, connect your Stripe account, and map the product to the role. On <a href="/">Dues</a> that is the whole onboarding: invite → paste your Stripe key → create the product → pick the role. Your store goes live at dues.gg/yourname.</p>`],
      ['3. Price it', `<p>Monthly for ongoing value (signals, picks, coaching), lifetime for a one-time unlock, or both at different price points. Each product maps to its own role, so tiers are just more products.</p>`],
      ['4. Share the link', `<p>Pin it, put it in the server description, link it from your socials. Buyers sign in with Discord, pay on Stripe’s checkout, and the role is delivered in seconds — buyers who are not in the server yet get pulled in with the role attached.</p>`],
      ['5. Let lapses handle themselves', `<p>When a subscription ends, the role should come off without you doing anything. Dues removes it automatically and re-checks access hourly, so the members list and the paying list never drift apart.</p>`],
    ],
    faq: [
      ['Can a bot really remove the role when someone stops paying?', 'Yes — that is the core of a subscription bot. On Dues, lapsed and canceled subscriptions lose the role automatically, and access is re-verified hourly.'],
      ['What if the buyer is not in my server yet?', 'Dues pulls buyers into the server with the role already attached when they complete checkout, using the authorization they grant at sign-in.'],
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
      ['The metrics that matter', `<p>Track revenue by period, new members per week, and which products carry the revenue — then price and post accordingly. Dues’s dashboard charts revenue with a previous-period comparison, lists every transaction, and pings a channel on every sale so the team sees momentum.</p>`],
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
      ['Where Dues sits', `<p>Dues is the flat-fee shape of this category: free up to 10 paying members, flat plans after that, 0% of sales, checkout by Stripe into your own account, roles delivered in about two seconds and removed automatically on lapse. Compare it directly with <a href="/vs/whop">Whop</a>, <a href="/vs/launchpass">LaunchPass</a>, <a href="/vs/subscord">Subscord</a> or <a href="/vs">the whole field</a>.</p>`],
    ],
    faq: [
      ['What is the best Discord subscription bot?', 'The one whose pricing model fits your volume and whose automation you never think about. Judge candidates on fees, who holds funds, role-lifecycle automation, receipts, and lock-in — the checklist above.'],
      ['Can I run subscriptions without a bot?', 'You can collect payments with generic links and assign roles by hand, but every cancellation and failed renewal becomes manual work, and it scales exactly as badly as it sounds.'],
      ['Do subscription bots work with lifetime products?', 'Dues sells lifetime seats alongside monthly plans — one payment, permanent role, no renewal to manage.'],
    ],
  },
  'sell-discord-server-access': {
    title: 'How to Sell Access to Your Discord Server',
    desc: 'Sell Discord server access with a store link, Stripe checkout and automatic role delivery — the three pieces, and how to set them up in an afternoon.',
    h1: 'How to Sell Access to Your Discord Server',
    intro: 'Selling server access is three pieces: something worth unlocking, a checkout link you can share anywhere, and delivery that never needs you online. Most owners overbuild the first and underbuild the last.',
    sections: [
      ['The product is a role', `<p>Package access as a role that unlocks channels. One role for a simple membership, several for tiers. If you can describe what the role unlocks in one sentence, buyers will get it too.</p>`],
      ['The checkout is a link', `<p>Your store lives at a link — Dues gives you <strong>dues.gg/yourname</strong>, with your server’s name, icon and products on it, sharable in bios, pinned messages and DMs. Buyers sign in with Discord, pay on Stripe, done. Link previews carry your product photo automatically.</p>`],
      ['Delivery is instant, and so is revocation', `<p>The role lands seconds after payment and comes off automatically when a subscription lapses. Buyers not yet in the server are pulled in with the role attached. That is the entire operational load: zero.</p>`],
      ['What it costs', `<p>Dues is free up to 10 paying members, then flat plans from $14.99/mo — always 0% of sales, with payments in your own Stripe account. For the full landscape, see <a href="/guides/how-to-monetize-a-discord-server">the monetization guide</a> and the <a href="/vs">comparisons</a>.</p>`],
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
      ['How do I take payments for all this?', 'Any subscription layer works mechanically; they differ in fees and who holds your money. Dues charges a flat plan, takes 0% of sales, and pays straight into your own Stripe account.'],
    ],
  },
  'best-discord-monetization-platform': {
    title: 'Best Discord Monetization Platform (2026): How to Choose',
    desc: 'How to choose a Discord monetization platform in 2026: the fee models compared, who holds your money, role automation, and the shortlist of tools that sell Discord access.',
    h1: 'The Best Discord Monetization Platform Is the One That Fits Your Volume',
    intro: 'There is no single best platform — there is the pricing shape that fits how you plan to grow, and the automation you never want to think about again. This is the honest way to choose, with the whole field laid out.',
    sections: [
      ['The three pricing models', `<p>Every Discord monetization tool falls into one of three camps, and the camp matters more than the brand:</p><ul><li><strong>Marketplace</strong> — your store lives on the platform's domain and it takes a percentage of every sale (Whop). Discovery in exchange for a cut and a storefront you do not own.</li><li><strong>Percentage / hybrid</strong> — a cut of revenue, sometimes on top of a monthly fee (LaunchPass, Patreon, DoorFee, Ko-fi). Painless small, expensive at scale.</li><li><strong>Flat-fee</strong> — a fixed monthly plan and 0% of sales, money into your own account (Dues). Costs the same at $200/mo and $20,000/mo.</li></ul><p>See exactly what each costs at your size in the <a href="/tools/discord-fee-calculator">fee calculator</a>.</p>`],
      ['The six questions that actually decide it', `<ul><li><strong>What does it take per sale?</strong> A percentage compounds as you grow; a flat plan does not. <a href="/tools/discord-fee-calculator">Run your numbers</a>.</li><li><strong>Who holds the money?</strong> Straight into your own Stripe beats platform-held funds paid out on someone else's schedule.</li><li><strong>Does access heal itself?</strong> Lapse → role removed, automatically, with periodic re-checks — or you prune by hand forever.</li><li><strong>Do buyers get receipts?</strong> Emailed confirmations cut support pings sharply.</li><li><strong>Is there a real dashboard?</strong> Revenue, members, transactions, refund-safe controls.</li><li><strong>Can you leave?</strong> Your Stripe account and customer list being yours is the difference between a tool and a trap.</li></ul>`],
      ['The field, honestly', `<p>Card-native flat-fee: <a href="/vs/whop">Dues vs Whop</a>, <a href="/vs/launchpass">vs LaunchPass</a>. Crypto-forward: <a href="/vs/xoe">XOE</a>. Percentage Discord-native: <a href="/vs/doorfee">DoorFee</a>, <a href="/vs/subscord">Subscord</a>. Creator platforms with Discord bolted on: <a href="/vs/patreon">Patreon</a>, <a href="/vs/gumroad">Gumroad</a>. The full grid is on the <a href="/vs">comparisons page</a>, and the shortlists live under <a href="/alternatives">alternatives</a>.</p>`],
      ['Where Dues fits', `<p>Dues is the flat-fee, card-native shape: free up to 10 paying members, flat plans after that, 0% of sales, checkout by Stripe into your own account, roles delivered in about two seconds and removed automatically on lapse. If your plan is to grow, a flat fee is the model that does not punish you for it.</p>`],
    ],
    faq: [
      ['What is the best platform to monetize a Discord server?', 'The one whose pricing model fits your volume and whose role automation is invisible. Percentage platforms are cheapest at low volume; flat-fee platforms like Dues win as you scale because the cost does not move with your revenue.'],
      ['Which Discord monetization platform has the lowest fees?', 'Flat-fee platforms take 0% of sales and charge a fixed plan instead, so their effective rate falls as you grow. Percentage platforms stay proportional. Compare at your own numbers with the fee calculator rather than trusting a headline rate.'],
      ['Do any of them let me keep my own Stripe account?', 'Yes — Dues, LaunchPass and others run checkout on your own Stripe account so payouts are direct. Marketplaces typically hold funds and pay you out on their schedule; that is the trade for their discovery.'],
      ['Can I switch platforms without losing members?', 'Your Discord members keep their roles while you set up a new checkout, and if your payments already run on your own Stripe account your customers move with you. Marketplace-held customer relationships are the hard ones to migrate.'],
    ],
  },
  'discord-paywall': {
    title: 'How to Put a Paywall on Your Discord (2026)',
    desc: 'Add a paywall to a Discord server: structure a free lobby and locked channels, gate them behind a paid role, and connect a checkout that grants and removes access automatically.',
    h1: 'How to Paywall a Discord Server',
    intro: 'A Discord paywall is not a wall in front of the server — it is a locked floor inside it. Free members see that the paid area exists; paying members get the role that opens it. Here is how to build one that runs itself.',
    sections: [
      ['Structure: what is free, what is paid', `<p>Keep a public lobby with rules, announcements and enough real activity to prove the server is alive. Put the value in clearly named locked categories that non-members can see but not read. A paywall nobody can see through does not convert — visible-but-locked is the whole trick.</p>`],
      ['The paywall is a role', `<p>Create one role per paid tier and set your premium channels to require it. That role is your paywall: grant it and the channels open, remove it and they close. Everything below automates granting and removing it.</p>`],
      ['Connect the checkout', `<p>Invite a payment bot, connect your Stripe account, map the product to the role. On <a href="/">Dues</a> the whole setup is invite → paste Stripe key → create product → pick role, and your paywall goes live at dues.gg/yourname. Buyers pay on Stripe and the role lands in seconds; those not yet in the server are pulled in with it attached.</p>`],
      ['Make the paywall self-healing', `<p>The point of automating it is that lapses handle themselves: when a subscription ends, the role comes off and the channels re-lock without you touching anything, with access re-checked hourly. A manual paywall leaks the moment your server grows. One Discord gotcha: the bot's role must sit above the roles it manages in Server Settings → Roles.</p>`],
      ['What a paywall costs to run', `<p>The tool's fee is the recurring cost, so pick the model deliberately: percentage platforms take a cut of everything the paywall earns, flat-fee platforms charge a fixed plan and 0% of sales. Compare both on the <a href="/vs">comparisons page</a> or estimate with the <a href="/tools/discord-fee-calculator">fee calculator</a>.</p>`],
    ],
    faq: [
      ['Can you put a paywall on a Discord server?', 'Yes. You gate channels behind a role and use a checkout that grants the role on payment and removes it when payment stops. Discord itself supports this through roles; the checkout and automation come from a payment bot.'],
      ['Is it allowed to paywall a Discord?', 'Selling access to your own community is a normal, widespread use of Discord. Follow Discord’s Terms for what you sell and your local rules, and you are on solid ground.'],
      ['What is the cheapest way to paywall a Discord?', 'At low volume, a percentage tool with no monthly fee can be cheapest; as you grow, a flat-fee plan that takes 0% of sales wins because the cost stops scaling with your revenue. Compare at your numbers before committing.'],
      ['How do members get past the paywall after paying?', 'The role is delivered automatically the moment payment clears — usually within a couple of seconds — and the locked channels open for them. No manual approval step.'],
    ],
  },
  'discord-membership-bot': {
    title: 'Discord Membership Bot: What It Does and How to Pick One',
    desc: 'What a Discord membership bot does, how paid memberships and role delivery work, and the checklist for choosing one without percentage fees or held funds.',
    h1: 'What a Discord Membership Bot Actually Does',
    intro: 'A membership bot turns your server into a paid community: it sells the membership, grants the role that unlocks it, renews it, and pulls access when a member stops paying. Here is the whole job and how to judge one.',
    sections: [
      ['Membership bot vs subscription bot', `<p>They are the same category from two angles. A <a href="/guides/discord-subscription-bot">subscription bot</a> emphasizes the recurring billing; a membership bot emphasizes the member relationship — tiers, renewals, and the roster of who is in good standing. Any good tool does both: recurring checkout and automatic role lifecycle.</p>`],
      ['The four jobs', `<p>End to end: a store page where members join, verified payment processing (checkout by Stripe or similar), instant role delivery when payment clears, and automatic role removal on cancellation, failed renewal, or refund. If any of the four is manual, the bot is not really doing the job.</p>`],
      ['Tiers and lifetime memberships', `<p>A membership is a role with a price. Two or three roles at different prices give you tiers; a one-time lifetime seat is the same mechanism without a renewal. On Dues each product maps to its own role, so tiers and lifetime seats are just more products — no extra setup.</p>`],
      ['The checklist for choosing one', `<ul><li><strong>Fees:</strong> 0% flat-plan pricing vs a percentage of every membership — <a href="/tools/discord-fee-calculator">run your numbers</a>.</li><li><strong>Payouts:</strong> straight to your own Stripe, or held and paid out on the platform's schedule.</li><li><strong>Lifecycle:</strong> automatic grant, renew, and revoke, with periodic re-checks.</li><li><strong>Receipts and dashboard:</strong> emailed confirmations, revenue, members, transactions.</li><li><strong>Lock-in:</strong> your Stripe account and member list should be yours to leave with.</li></ul><p>See how the tools stack up on the <a href="/alternatives/best-discord-monetization-platforms">platform shortlist</a>.</p>`],
      ['Where Dues sits', `<p>Dues is a membership bot with a flat plan: free up to 10 paying members, then from $14.99/mo, 0% of sales, checkout by Stripe into your own account, roles delivered in seconds and removed automatically on lapse. Compare it directly with <a href="/vs/subscord">Subscord</a>, <a href="/vs/launchpass">LaunchPass</a> or <a href="/vs">the whole field</a>.</p>`],
    ],
    faq: [
      ['What is a Discord membership bot?', 'A bot that sells access to your server as a paid membership: it runs checkout, grants the member role automatically on payment, handles renewals, and removes the role when a membership lapses or is cancelled.'],
      ['Can a membership bot handle tiers?', 'Yes. Each tier is a product mapped to its own role, so you can sell, say, a base membership and an inner-circle tier at different prices, each unlocking different channels.'],
      ['Does a membership bot take a cut of my revenue?', 'It depends on the tool. Percentage bots take a share of every membership; flat-fee bots like Dues charge a fixed monthly plan and take 0% of sales, with Stripe’s standard processing applying either way.'],
      ['What happens when a member cancels?', 'A good membership bot removes the role automatically at the end of the paid period and re-checks access on a schedule, so your member list and your paying list never drift apart.'],
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
        author: { '@type': 'Organization', name: 'Dues' },
        publisher: { '@type': 'Organization', name: 'Dues', url: BASE },
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
        <p class="hero-sub">Practical, no-fluff guides to selling roles, running paid servers and choosing the payment layer — written by the team behind Dues.</p>
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
    title: 'Discord monetization guides — sell roles, paid servers',
    desc: 'Guides to monetizing Discord: selling roles, building paid servers, choosing a subscription bot, and pricing memberships.',
    body,
    crumbs: [['Guides', '/guides']],
  });
}

// ── /alternatives/<slug> — honest listicles for "X alternatives" queries ─────

const ALT_LIST = {
  dues: {
    name: 'Dues',
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
  doorfee: { name: 'DoorFee', line: 'Discord-native, with a page builder and marketing add-ons. Listed pricing takes a percentage of every sale — higher on the free plan, lower on a paid plan*.', href: '/vs/doorfee' },
  xoe: { name: 'XOE', line: 'Discord payment and security bot. Listed pricing keeps card sales at 0%, takes a cut on crypto, and offers an optional paid tier — crypto-forward where Dues is card-native and flat*.', href: '/vs/xoe' },
  sublyna: { name: 'Sublyna', line: 'Discord subscription tool positioned as a Subscord alternative; pricing is plan-dependent — check their site*.', href: null },
  paybot: { name: 'PayBot', line: 'Card-only Discord payment bot with a simple setup and a listed 0% platform fee; a narrower toolset than a full store platform*.', href: null },
};

const ALTERNATIVES = {
  'whop-alternatives': {
    target: 'Whop',
    picks: ['dues', 'launchpass', 'upgrade-chat', 'subscord', 'memberful'],
    why: 'Owners usually look past Whop for two reasons: the percentage taken from every sale, and the storefront living on a marketplace domain rather than their own link. If either bothers you, the field below is the shortlist.',
  },
  'launchpass-alternatives': {
    target: 'LaunchPass',
    picks: ['dues', 'upgrade-chat', 'subscord', 'whop', 'memberful'],
    why: 'LaunchPass pairs a monthly subscription with a percentage of sales on its listed pricing — a double cost that grows with you. The alternatives below split into flat-fee and percentage camps; know which you are choosing.',
  },
  'subscord-alternatives': {
    target: 'Subscord',
    picks: ['dues', 'launchpass', 'upgrade-chat', 'whop'],
    why: 'Subscord popularized the subscription-bot shape: Stripe checkout, paid roles, hosted checkout pages. If you are comparing the category, the platforms below do the same job with different pricing models and different answers to who holds your money.',
  },
  'patreon-alternatives-for-discord': {
    target: 'Patreon',
    picks: ['dues', 'launchpass', 'ko-fi', 'buymeacoffee', 'whop'],
    why: 'Patreon takes a listed 8–12% of earnings and owns the member relationship, with Discord bolted on through an integration. For a community that lives on Discord, purpose-built tools deliver roles faster and cost a different shape of money.',
  },
  'xoe-alternatives': {
    target: 'XOE',
    picks: ['dues', 'subscord', 'doorfee', 'launchpass', 'paybot'],
    why: 'XOE leans crypto-forward: its listed pricing takes a cut on crypto payments and keeps cards at 0%, with an optional paid tier. If you would rather sell in cards on a flat, predictable plan with money landing in your own Stripe account, the tools below are the shortlist.',
  },
  'doorfee-alternatives': {
    target: 'DoorFee',
    picks: ['dues', 'subscord', 'launchpass', 'whop', 'paybot'],
    why: 'DoorFee charges a percentage of every sale — higher on its free plan, lower on a paid plan. If the percentage is what you want to escape, the flat-fee options below cost the same whatever you earn.',
  },
  'best-discord-monetization-platforms': {
    target: 'Discord monetization platform',
    // Not an "X alternatives" page, so the template's copy does not fit: it
    // read "Best Discord monetization platform Alternatives for Discord" on
    // the one page aimed at the site's highest-intent query. Hand-written.
    title: 'Best Discord Monetization Platforms (2026)',
    desc: 'The Discord monetization platforms compared honestly: flat-fee vs percentage pricing, who holds your money, and how roles are delivered.',
    faqQ: 'What is the best Discord monetization platform?',
    card: 'Best Discord monetization platforms',
    picks: ['dues', 'whop', 'launchpass', 'subscord', 'doorfee', 'xoe', 'patreon'],
    why: 'Every tool here sells Discord access; they differ in what they take from each sale and who holds your money. The list splits into flat-fee (a fixed plan, 0% of sales) and percentage or marketplace models — pick the shape that matches how you plan to grow.',
  },
};

function altPage(slug, a) {
  const picks = a.picks.map((k) => ALT_LIST[k]).filter(Boolean);
  const title = a.title ?? `Best ${a.target} Alternatives for Discord (2026)`;
  const desc = a.desc ?? `${a.target} alternatives for monetizing a Discord server, compared honestly: flat-fee vs percentage pricing, who holds your money, and how roles are delivered.`;
  const faq = [
    [a.faqQ ?? `What is the best ${a.target} alternative?`, `It depends on the pricing shape you want. Flat-fee platforms like Dues cost the same whatever you earn and pay into your own Stripe account; percentage platforms scale their cut with your revenue. The list above marks each model.`],
    ['Are the listed fees current?', 'They are the publicly listed prices at the time of writing, always asterisked — verify on each platform’s own site.'],
    ['Is this list neutral?', 'No, and it does not pretend to be: Dues is our product and it is listed first. Every factual claim about other platforms is their own published pricing, linked from the full comparison pages.'],
  ];
  const items = picks
    .map(
      (p, i) => `
          <div class="panel seo-card alt-card">
            <strong>${i + 1}. ${esc(p.name)}${i === 0 ? ' <span class="alt-ours">our product</span>' : ''}</strong>
            <p>${esc(p.line)}</p>
            ${p.href ? `<span class="seo-card-cta"><a href="${p.href}">${p.href === '/' ? 'See how it works' : 'Full comparison'} →</a></span>` : ''}
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
        itemListElement: picks.map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: p.name, ...(p.href ? { url: `${BASE}${p.href}` } : {}) })),
      },
    ],
  });
}

function altIndex() {
  const cards = Object.entries(ALTERNATIVES)
    .map(
      ([slug, a]) => `
          <a class="panel seo-card" href="/alternatives/${slug}">
            <strong>${esc(a.card ?? `Best ${a.target} alternatives`)}</strong>
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
    title: 'Whop, LaunchPass & Patreon alternatives for Discord',
    desc: 'Honest alternative lists for Discord monetization platforms: flat-fee vs percentage pricing, payouts, and role delivery compared.',
    body,
    crumbs: [['Alternatives', '/alternatives']],
  });
}

// ── emit everything ───────────────────────────────────────────────────────────

const out = [];
// ── /help — every feature in two minutes, each card linking to the real thing ─

// ── /crypto ──────────────────────────────────────────────────────────────────
//
// The page the payment strip's "See the full list" leads to: every coin and
// chain a Dues checkout can settle in, each with its own mark, as one list.
//
// Everything factual here is read from the code that does the thing. The set
// of assets is CHAIN_RANK, imported and flattened — the checkout's own table,
// not a second list retyped here that could drift out of step with it. What
// this page does NOT do is repeat that table's ORDER as if it were a ranking
// a seller should read something into: the order is a settlement detail, and
// on the page it would only read as "these coins are better than those". So
// the list is alphabetical, and the ordering stays where it belongs, in the
// picker. A ticker added to CHAIN_RANK with no name or mark here fails the
// build rather than shipping as a bare string.
const COIN_NAME = {
  sol: 'Solana', trx: 'Tron', matic: 'Polygon', base: 'Base', bnb: 'BNB Chain',
  ltc: 'Litecoin', doge: 'Dogecoin', xrp: 'XRP', ada: 'Cardano', algo: 'Algorand',
  btc: 'Bitcoin', eth: 'Ethereum', dai: 'Dai',
  usdtsol: 'USDT on Solana', usdcsol: 'USDC on Solana',
  usdttrc20: 'USDT on Tron', usdtmatic: 'USDT on Polygon', usdcmatic: 'USDC on Polygon',
  usdcbase: 'USDC on Base', usdtbsc: 'USDT on BNB Chain', usdcbsc: 'USDC on BNB Chain',
  usdterc20: 'USDT on Ethereum', usdcerc20: 'USDC on Ethereum',
};
// A stablecoin exists on several chains under several tickers and wears ONE
// mark — Tether's is Tether's whether it settles on Solana or on Ethereum, and
// the chain is what the name says. So marks are keyed by the asset, and the
// ticker maps onto one.
const COIN_ART = (t) => (t.startsWith('usdt') ? 'usdt' : t.startsWith('usdc') ? 'usdc' : t);

// Cardano's mark is a constellation of dots rather than a glyph, so it is
// placed rather than drawn: three rings around a centre, the way the brand
// draws it. Written as a loop so the geometry is legible instead of forty
// hand-typed circles.
const adaDots = () => {
  const ring = (n, radius, r, phase = 0) => Array.from({ length: n }, (_, i) => {
    const a = phase + (i * 2 * Math.PI) / n;
    return `<circle cx="${(16 + radius * Math.cos(a)).toFixed(2)}" cy="${(16 + radius * Math.sin(a)).toFixed(2)}" r="${r}"/>`;
  }).join('');
  return `<circle cx="16" cy="16" r="1.7"/>${ring(6, 4.6, 1.15)}${ring(6, 7.4, 1, Math.PI / 6)}${ring(12, 10.2, .78, Math.PI / 12)}`;
};

// The marks themselves. Each is the brand's disc in the brand's colour with
// the brand's own glyph on it, at 32x32, inline so a storefront page never
// waits on a sprite sheet and never leaks a request to someone else's CDN.
// The seven card marks on the homepage are drawn the same way for the same
// reasons — see the .pay strip in public/index.html.
const COIN_MARK = {
  btc: '<circle cx="16" cy="16" r="16" fill="#F7931A"/><path fill="#fff" d="M23.19 14.02c.31-2.09-1.28-3.21-3.46-3.96l.71-2.84-1.73-.43-.69 2.76c-.45-.11-.92-.22-1.39-.32l.7-2.78-1.73-.43-.71 2.84c-.38-.09-.75-.17-1.11-.26v-.01l-2.38-.6-.46 1.85s1.28.29 1.25.31c.7.17.83.64.81 1.01l-.81 3.24c.05.01.11.03.18.06l-.18-.05-1.13 4.54c-.09.21-.3.53-.79.41.02.03-1.25-.31-1.25-.31l-.86 1.98 2.25.56c.42.1.83.21 1.23.31l-.72 2.87 1.73.43.71-2.84c.47.13.93.25 1.38.36l-.71 2.83 1.73.43.72-2.87c2.95.56 5.17.33 6.11-2.34.75-2.15-.04-3.39-1.59-4.2 1.13-.26 1.98-1 2.21-2.54zm-3.95 5.55c-.53 2.15-4.16.99-5.34.7l.95-3.81c1.18.3 4.95.88 4.39 3.11zm.54-5.58c-.49 1.96-3.51.96-4.49.72l.86-3.45c.98.25 4.14.7 3.63 2.73z"/>',
  eth: '<circle cx="16" cy="16" r="16" fill="#627EEA"/><g fill="#fff"><path fill-opacity=".6" d="M16.5 4v8.87l7.5 3.35z"/><path d="M16.5 4 9 16.22l7.5-3.35z"/><path fill-opacity=".6" d="M16.5 21.97V28L24 17.62z"/><path d="M16.5 28v-6.03L9 17.62z"/><path fill-opacity=".2" d="m16.5 20.57 7.5-4.35-7.5-3.35z"/><path fill-opacity=".6" d="M9 16.22l7.5 4.35v-7.7z"/></g>',
  usdt: '<circle cx="16" cy="16" r="16" fill="#26A17B"/><path fill="#fff" d="M17.92 17.38v-.01c-.11.01-.68.04-1.95.04-1.01 0-1.73-.03-1.98-.04v.01c-3.9-.17-6.81-.85-6.81-1.66s2.91-1.49 6.81-1.66v2.64c.25.02.98.06 1.99.06 1.21 0 1.82-.05 1.93-.06v-2.64c3.89.17 6.79.85 6.79 1.66s-2.9 1.49-6.79 1.66zm0-3.59v-2.36h5.4V7.83H8.68v3.6h5.4v2.36c-4.39.2-7.69 1.07-7.69 2.11s3.3 1.91 7.69 2.11v7.57h3.84v-7.57c4.38-.2 7.67-1.07 7.67-2.11s-3.29-1.9-7.67-2.11z"/>',
  usdc: '<circle cx="16" cy="16" r="16" fill="#2775CA"/><path fill="#fff" d="M20.5 18.53c0-2.38-1.43-3.2-4.28-3.54-2.04-.27-2.45-.82-2.45-1.77s.68-1.56 2.04-1.56c1.23 0 1.91.41 2.25 1.43.07.2.27.34.48.34h1.09c.27 0 .48-.2.48-.48v-.07a3.42 3.42 0 0 0-3.07-2.79V8.63c0-.27-.2-.48-.55-.55h-1.02c-.27 0-.48.2-.55.55v1.43c-2.04.27-3.34 1.63-3.34 3.34 0 2.25 1.36 3.13 4.22 3.47 1.91.34 2.52.75 2.52 1.84s-.95 1.84-2.25 1.84c-1.77 0-2.38-.75-2.59-1.77-.07-.27-.27-.41-.48-.41h-1.16c-.27 0-.48.2-.48.48v.07c.27 1.7 1.36 2.93 3.61 3.27v1.43c0 .27.2.48.55.55h1.02c.27 0 .48-.2.55-.55v-1.43c2.04-.34 3.41-1.77 3.41-3.61z"/><path fill="#fff" d="M13.1 25.5c-5.31-1.91-8.04-7.84-6.06-13.08a10.1 10.1 0 0 1 6.06-6.06c.27-.14.41-.34.41-.68v-.95c0-.27-.14-.48-.41-.55-.07 0-.2 0-.27.07a12.28 12.28 0 0 0-8.04 15.46 12.2 12.2 0 0 0 8.04 8.04c.27.14.55 0 .61-.27.07-.07.07-.14.07-.27v-.95c0-.2-.2-.48-.41-.61zm6.06-21.18c-.27-.14-.55 0-.61.27-.07.07-.07.14-.07.27v.95c0 .27.2.55.41.68 5.31 1.91 8.04 7.84 6.06 13.08a10.1 10.1 0 0 1-6.06 6.06c-.27.14-.41.34-.41.68v.95c0 .27.14.48.41.55.07 0 .2 0 .27-.07a12.28 12.28 0 0 0 8.04-15.46 12.2 12.2 0 0 0-8.04-8.04z"/>',
  sol: '<circle cx="16" cy="16" r="16" fill="#0B0B12"/><defs><linearGradient id="cnSol" x1="8" y1="22" x2="24" y2="10" gradientUnits="userSpaceOnUse"><stop stop-color="#9945FF"/><stop offset="1" stop-color="#14F195"/></linearGradient></defs><g fill="url(#cnSol)"><path d="M10.33 19.7a.6.6 0 0 1 .43-.18h13.5c.27 0 .4.33.21.52l-2.66 2.67a.6.6 0 0 1-.43.18H7.88a.3.3 0 0 1-.21-.52z"/><path d="M10.33 9.29a.6.6 0 0 1 .43-.18h13.5c.27 0 .4.33.21.52l-2.66 2.67a.6.6 0 0 1-.43.18H7.88a.3.3 0 0 1-.21-.52z"/><path d="M21.67 14.46a.6.6 0 0 0-.43-.18H7.74a.3.3 0 0 0-.21.52l2.66 2.67c.11.11.27.18.43.18h13.5a.3.3 0 0 0 .21-.52z"/></g>',
  ltc: '<circle cx="16" cy="16" r="16" fill="#345D9D"/><path fill="#fff" d="m10.43 20.42 1.1-4.15-1.73.65.4-1.5 1.73-.65 2.18-8.2h4.24l-1.62 6.1 1.7-.64-.4 1.5-1.7.63-1.28 4.8h6.9l-.73 2.74H10.6z"/>',
  doge: '<circle cx="16" cy="16" r="16" fill="#C2A633"/><path fill="#fff" d="M13.15 14.9h3.02v2.24h-3.02v3.9h1.86c.73 0 1.34-.09 1.83-.28.49-.19.87-.46 1.16-.83.29-.37.49-.83.6-1.4.11-.56.17-1.22.17-1.98s-.06-1.42-.17-1.98c-.11-.56-.31-1.03-.6-1.4-.29-.37-.67-.64-1.16-.83-.49-.19-1.1-.28-1.83-.28h-1.86zM10.1 17.14H8.6V14.9h1.5V8.9h5.13c1.2 0 2.24.16 3.13.49.89.33 1.63.8 2.21 1.4.58.6 1.01 1.33 1.3 2.18.29.85.43 1.8.43 2.85s-.14 2-.43 2.85c-.29.85-.72 1.58-1.3 2.18-.58.6-1.32 1.07-2.21 1.4-.89.33-1.93.49-3.13.49H10.1z"/>',
  xrp: '<circle cx="16" cy="16" r="16" fill="#23292F"/><path fill="#fff" d="M21.9 8.5h2.86l-5.95 5.9a3.98 3.98 0 0 1-5.6 0L7.25 8.5h2.87l4.52 4.48c.75.74 1.97.74 2.72 0zM10.08 23.5H7.22l5.99-5.94a3.98 3.98 0 0 1 5.6 0l5.99 5.94h-2.86l-4.56-4.52a1.93 1.93 0 0 0-2.72 0z"/>',
  trx: '<circle cx="16" cy="16" r="16" fill="#FF060A"/><path fill="#fff" transform="translate(16 16) scale(.16) translate(-100.8 -96.32)" d="M157.045 79.1207c-5.517-4.9042-13.18-12.3755-19.387-17.6628l-.383-.2299c-.613-.4598-1.303-.8429-2.031-1.1111-15.019-2.682-84.9038-15.2108-86.2448-15.0575-.3831.0383-.7663.1916-1.0728.3831l-.3448.2682c-.4214.4215-.7663.9196-.9578 1.4943l-.0767.2299v1.2643.1916c7.8544 20.9962 38.9272 89.7322 45.0575 105.9002.3831 1.111 1.0728 3.18 2.3755 3.295h.3065c.6896 0 3.6782-3.793 3.6782-3.793s53.3712-61.9922 58.7742-68.5823c.689-.8046 1.302-1.6858 1.839-2.6053.153-.728.076-1.456-.192-2.1456-.268-.6897-.766-1.341-1.341-1.8391zM111.605 86.3621l22.758-18.0843 13.372 11.8008-36.13 6.2835zM102.754 85.1743L63.5586 54.3697l63.4484 11.2261-24.253 19.5785zM106.279 93.2203l40.115-6.2069-45.862 52.9886 5.747-46.7817zM58.233 57.4732l41.2643 33.5249-5.977 49.0419-35.2873-82.5668z"/>',
  matic: '<circle cx="16" cy="16" r="16" fill="#8247E5"/><path fill="#fff" d="M21.092 12.693c-.369-.215-.848-.215-1.254 0l-2.879 1.654-1.955 1.078-2.879 1.653c-.369.216-.848.216-1.254 0L8.605 15.77c-.369-.215-.627-.61-.627-1.042v-2.582c0-.431.221-.826.627-1.042l2.244-1.258c.369-.216.848-.216 1.254 0l2.244 1.258c.369.215.627.61.627 1.042v1.654l1.955-1.115v-1.653c0-.431-.221-.826-.627-1.042l-4.163-2.372c-.369-.215-.848-.215-1.254 0L6.694 10.03c-.406.216-.627.61-.627 1.042v4.786c0 .431.221.826.627 1.042l4.19 2.372c.37.216.849.216 1.255 0l2.879-1.618 1.955-1.114 2.879-1.617c.369-.216.848-.216 1.254 0l2.244 1.258c.369.215.627.61.627 1.042v2.582c0 .431-.221.826-.627 1.042l-2.244 1.294c-.369.216-.848.216-1.254 0l-2.244-1.258c-.369-.215-.627-.61-.627-1.042V19.19l-1.955 1.115v1.653c0 .431.221.826.627 1.042l4.19 2.372c.37.216.849.216 1.255 0l4.19-2.372c.369-.215.627-.61.627-1.042v-4.822c0-.431-.221-.826-.627-1.042l-4.227-2.401z"/>',
  base: '<circle cx="16" cy="16" r="16" fill="#0052FF"/><path fill="#fff" d="M9.62 9.65a9 9 0 1 1 0 12.7z"/>',
  bnb: '<circle cx="16" cy="16" r="16" fill="#F3BA2F"/><path fill="#fff" transform="translate(0 1)" d="M12.116 13.404 16 9.52l3.886 3.886 2.26-2.26L16 5l-6.144 6.144zM6 15l2.26-2.26L10.52 15l-2.26 2.26zm6.116 1.596L16 20.48l3.886-3.886 2.261 2.259L16 25l-6.144-6.144-.003-.003zM21.48 15l2.26-2.26L26 15l-2.26 2.26zm-3.188-.002V15L16 17.294l-2.291-2.29-.004-.004.004-.003.401-.402.195-.195L16 12.706z"/>',
  ada: `<circle cx="16" cy="16" r="16" fill="#0033AD"/><g fill="#fff">${adaDots()}</g>`,
  algo: '<circle cx="16" cy="16" r="16" fill="#000"/><path fill="#fff" transform="translate(.5 1)" d="m10.331859 23 7.221238-12.601771.99115 3.256638L13.022125 23h2.83186l3.539822-6.088495L20.951328 23H23.5l-2.40708-9.061945 1.699118-2.973453h-2.548674L19.252216 7h-2.407083L7.5 23Z"/>',
  dai: '<circle cx="16" cy="16" r="16" fill="#F5AC37"/><g fill="#fff"><path fill-rule="evenodd" d="M11 9h6a7 7 0 0 1 0 14h-6zm2.4 2.4v9.2H17a4.6 4.6 0 0 0 0-9.2z"/><rect x="7.4" y="14.25" width="17.2" height="1.5" rx=".2"/><rect x="7.4" y="17.15" width="17.2" height="1.5" rx=".2"/></g>',
};

function cryptoPage() {
  // One flat list, alphabetical, built from the checkout's own table.
  const coins = CHAIN_RANK.flat().map((t) => {
    const name = COIN_NAME[t];
    if (!name) throw new Error(`/crypto: CHAIN_RANK has "${t}" with no name in COIN_NAME — add it`);
    const mark = COIN_MARK[COIN_ART(t)];
    if (!mark) throw new Error(`/crypto: "${t}" has no mark in COIN_MARK — draw it, do not ship a bare ticker`);
    return { ticker: t.toUpperCase(), name, mark };
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'));

  const list = coins.map((c) => `
            <li class="cx-coin">
              <span class="cx-mark" aria-hidden="true"><svg viewBox="0 0 32 32">${c.mark}</svg></span>
              <span class="cx-name">${esc(c.name)}</span>
              <span class="cx-tick">${esc(c.ticker)}</span>
            </li>`).join('');
  const total = coins.length;

  const faq = [
    [
      'Which cryptocurrencies can I accept?',
      `The ${total} listed on this page. What a buyer is actually offered is read from the crypto rail live at checkout — anything the rail offers beyond this list is still offered, and anything it has switched off does not appear. That is why no page here prints a fixed number of "supported currencies".`,
    ],
    [
      'Which chain should I take payouts on?',
      'Whichever one you actually hold. A payout is an on-chain transfer and its fee is flat, so on an expensive chain it can cost more than a small membership is worth — that is worth knowing when you pick, and the current cost of a transfer on any chain is the chain’s business, not ours to quote.',
    ],
    [
      'Where does the crypto go?',
      'To the wallet you nominate, on the chain you nominate. Every payment is created with your payout address on it, and a store with no wallet saved cannot start a crypto checkout at all — Dues refuses rather than take money it would have to hold.',
    ],
    [
      'Do I have to take crypto?',
      'No. Card checkout runs on your own Stripe account and needs nothing else. Crypto is opt-in per store: it appears only once you have saved a payout wallet and chain.',
    ],
  ];

  const body = `
    <section class="xhero seo-hero">
      <div class="hero-inner">
        <h1>Crypto a Dues store can take</h1>
        <p class="hero-sub">Every coin and chain a Dues checkout can settle in.</p>
      </div>
    </section>
    <section class="xsection">
      <div class="wrap">
        <ul class="cx-list">${list}
        </ul>
      </div>
      <div class="wrap narrow guide-body">
        <p class="crypto-note"><strong>Your buyer&rsquo;s picker is built live.</strong> The coins offered at a checkout are read from the crypto rail at that moment, so a coin the rail has switched off does not appear and cannot be paid to &mdash; and anything the rail offers beyond this list is still offered rather than hidden. That is why no page here prints a round number of &ldquo;supported currencies&rdquo;: the true answer is whatever the rail says when your buyer arrives.</p>
        <p>A coin that is not enabled on the rail is refused before a payment is ever created, so a buyer cannot be sent to an address for something that would bounce. If the rail cannot be reached at all, the checkout says so rather than showing an empty picker. A store with no payout wallet saved does not offer the option in the first place.</p>
      </div>
    </section>
    <section class="xsection">
      <div class="wrap narrow guide-body">
        <h2>Where the money goes</h2>
        <p>The same place all your money goes on Dues: an account you own. You save a payout wallet and its chain in the dashboard, and every payment is created carrying that address, so settlement is a transfer out to you rather than a balance sitting somewhere with your name on it.</p>
        <ul>
          <li><strong>No wallet, no sale.</strong> If a store has crypto switched on but no payout address saved, checkout refuses and says so. Money Dues would have to hold is money Dues will not take.</li>
          <li><strong>You pick the chain.</strong> The wallet is checked against the real rules of that chain before it saves, and typed a second time to confirm — an on-chain transfer cannot be undone.</li>
          <li><strong>The role lands on a finished payment.</strong> Not on a pending one, and not on a short one: an underpayment stays open and the seller is told, rather than access being handed out for money that did not fully arrive.</li>
        </ul>
        <p>Crypto is opt-in per store, and it is still being rolled out. Until it reaches your store, card checkout is what your buyers see &mdash; on your own Stripe account, at <a href="/pricing">0% platform fee</a>, as always.</p>

        <h2>The rail&rsquo;s own current list</h2>
        <p>Dues&rsquo; crypto rail is <a href="https://nowpayments.io" rel="noopener">NOWPayments</a>. They publish a per-coin page showing what is available for payments and withdrawals right now, along with each coin&rsquo;s minimum payment amount &mdash; that page, not this one, is the live answer to &ldquo;can I pay in X today?&rdquo;:</p>
        <ul>
          <li><a href="https://nowpayments.io/status-page" rel="noopener">nowpayments.io/status-page</a> &mdash; per-coin availability and minimums, updated by the provider.</li>
        </ul>
        <p>Minimums matter more than the list does. Every coin has a floor below which a payment cannot be made, it differs per pair, and Dues quotes it from the rail at checkout for the exact pair the buyer is on rather than guessing.</p>
      </div>
    </section>
    <section class="xsection">${faqHtml(faq)}</section>
${cta('Start selling — cards today, coins when you want them')}`;

  return page({
    urlPath: '/crypto',
    title: 'Crypto a Dues store can take',
    desc: 'Every coin and chain a Dues store can settle in, with how the buyer’s picker is built live at checkout and where the payout lands.',
    body,
    jsonld: [faqJsonld(faq)],
    crumbs: [['Crypto payments', '/crypto']],
  });
}

function helpPage() {
  const FEATURES = [
    ['Your store page', 'One link with everything you sell — your name, banner, about section and colors. Buyers browse products and check out without leaving the page.', '/demo', 'See the demo store'],
    ['Product links', 'Every product also has its own URL, like dues.gg/your-store/vip — rename the last part in the product editor and share it anywhere.', '/dashboard', 'Dashboard → Products'],
    ['Checkout & payments', 'Buyers pay by card through Stripe, straight into your own Stripe account. Dues never holds your money and takes 0% of sales.', '/demo/vip-access', 'Try a demo checkout'],
    ['Automatic role delivery', 'The Discord role is granted seconds after payment and removed when a membership ends. Failed renewals get a short grace period before access is pulled.', '/guides/how-to-sell-discord-roles', 'How role selling works'],
    ['Discounts', 'Create percentage codes in the dashboard; buyers apply them at checkout and pay the discounted amount.', '/dashboard', 'Dashboard → Discounts'],
    ['Sale alerts in Discord', 'Pick a channel and every sale is posted there the moment it lands — product, amount and buyer.', '/dashboard', 'Dashboard → Settings'],
    ['Members & transactions', 'Every member and payment in one place: search, CSV export, and manual extend or revoke when you need to step in.', '/dashboard', 'Dashboard → Members'],
    ['Make it yours', 'Theme presets, custom colors, corner radius and typeface — with a live preview of your storefront before anything is saved.', '/dashboard', 'Dashboard → Store → Appearance'],
    ['Discover', 'An optional public directory of Dues stores. Off by default; list yours from the Store section if you want the traffic.', '/discover', 'Browse Discover'],
    ['Your plan', 'Free for your first 10 paying members. After that, flat monthly plans from $14.99 — always 0% of sales, on every plan.', '/pricing', 'See pricing'],
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
    ['Where does the money go?', 'Directly to the seller’s own Stripe account on every sale. Dues never sits between you and your payout — Stripe pays out on its normal schedule.'],
    ['Do I need the Stripe dashboard to run my store?', 'No. Connect Stripe once with an API key; after that products, prices, discounts and refund-worthy situations are all handled from the Dues dashboard.'],
  ];
  const body = `
    <section class="xhero seo-hero">
      <div class="hero-inner">
        <h1>Help</h1>
        <p class="hero-sub">Everything Dues does, in about two minutes. Every card links to the real thing.</p>
      </div>
    </section>
    <section class="xsection">
      <div class="wrap narrow">
        <section class="panel sub-card legal">
          <h2>Set up in four steps</h2>
          <p>1. Open the <a href="/dashboard">dashboard</a> and sign in with Discord.</p>
          <p>2. Pick your server and invite the Dues bot.</p>
          <p>3. Connect Stripe with an API key — payments go straight to your Stripe account.</p>
          <p>4. Create a product, attach the role it unlocks, publish. Your store is live at dues.gg/your-store.</p>
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
    title: 'Help — how Dues works',
    desc: 'A short guide to every Dues feature: store pages, product links, Stripe checkout, automatic role delivery, discounts, sale alerts, themes and plans.',
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
for (const key of ['whop', 'launchpass', 'patreon', 'doorfee']) {
  const { slug, html } = competitorCalculator(key);
  emit(`tools/${slug}.html`, html);
}

emit('use-cases/index.html', useCasesIndex());
for (const [slug, u] of Object.entries(USE_CASES)) emit(`use-cases/${slug}.html`, useCasePage(slug, u));

emit('guides/index.html', guidesIndex());
for (const [slug, g] of Object.entries(GUIDES)) emit(`guides/${slug}.html`, guidePage(slug, g));

emit('alternatives/index.html', altIndex());
emit('help.html', helpPage());
emit('crypto.html', cryptoPage());
for (const [slug, a] of Object.entries(ALTERNATIVES)) emit(`alternatives/${slug}.html`, altPage(slug, a));

// llms.txt: the emerging convention answer engines read for a site summary.
// Facts only — the same claims the pages make, in plain markdown.
emit(
  'llms.txt',
  `# Dues

> Dues (https://dues.gg) is a Discord monetization platform. Server owners sell paid memberships and roles through a hosted store page (dues.gg/yourname); buyers sign in with Discord and pay on Stripe Checkout; the Discord role is delivered automatically in seconds and removed automatically when a subscription lapses. Payments go directly to the store owner's own Stripe account — Dues never holds funds. Pricing is a flat monthly plan (free up to 10 paying members, then from $14.99/month) and Dues takes 0% of sales. Stripe's standard card-processing fees apply, as on every platform.

Key product facts:
- 0% platform fees on sales; flat plans: Free (10 paying members), Pro $14.99/mo (50), Max $44.99/mo (500), Unlimited $134.99/mo (unlimited)
- Payments settle in the owner's own Stripe account (owner supplies their Stripe key)
- Instant role delivery (~2s) and automatic removal on cancellation/lapse; hourly access re-checks
- Store page at dues.gg/<name> with the server's branding and product photos
- Monthly subscriptions, lifetime (one-time) products, tiered roles, discount codes, purchase limits
- Emailed receipts on every sale; optional "New Subscriber" ping in a Discord channel of the owner's choice
- The bot never asks for Discord Administrator permission
- Dashboard: revenue with previous-period comparison, members, transactions, refunds-safe revoke/re-sync

## Alternatives
- [Whop alternatives](${BASE}/alternatives/whop-alternatives)
- [LaunchPass alternatives](${BASE}/alternatives/launchpass-alternatives)
- [Subscord alternatives](${BASE}/alternatives/subscord-alternatives)
- [DoorFee alternatives](${BASE}/alternatives/doorfee-alternatives)
- [XOE alternatives](${BASE}/alternatives/xoe-alternatives)
- [Best Discord monetization platforms](${BASE}/alternatives/best-discord-monetization-platforms)

## Compare
- [Dues vs Whop](${BASE}/vs/whop)
- [Dues vs LaunchPass](${BASE}/vs/launchpass)
- [Dues vs Subscord](${BASE}/vs/subscord)
- [Dues vs DoorFee](${BASE}/vs/doorfee)
- [Dues vs XOE](${BASE}/vs/xoe)
- [Dues vs Patreon](${BASE}/vs/patreon)
- [All comparisons](${BASE}/vs)

## Guides
- [Best Discord monetization platform](${BASE}/guides/best-discord-monetization-platform)
- [How to monetize a Discord server](${BASE}/guides/how-to-monetize-a-discord-server)
- [How to sell Discord roles](${BASE}/guides/how-to-sell-discord-roles)
- [How to make a paid Discord server](${BASE}/guides/paid-discord-server)
- [How to paywall a Discord](${BASE}/guides/discord-paywall)
- [Discord subscription bot](${BASE}/guides/discord-subscription-bot)
- [Discord membership bot](${BASE}/guides/discord-membership-bot)

## Help
- [Every feature explained](${BASE}/help)
- [Crypto payments: which coins, which chains, where payouts land](${BASE}/crypto)

## Tools
- [Discord monetization fee calculator](${BASE}/tools/discord-fee-calculator)

Competitor pricing referenced anywhere on this site is the publicly listed pricing at the time of writing and is always marked to be verified on the competitor's own site.
`,
);

// sitemap + robots: the landing page plus every generated page. Store pages
// are user content and terms/privacy/dashboard/account are noindex — none of
// those belong in the sitemap. /demo is the exception among store URLs: it is
// the platform's own hosted demo (api/store-page.js, DEMO_SLUG) with a
// hand-written head, indexable and linked from the homepage and /help.
const urls = ['/', '/pricing', '/vs', ...Object.keys(COMPETITORS).map((s) => `/vs/${s}`), '/tools',
  '/tools/discord-fee-calculator', '/tools/whop-fee-calculator', '/tools/launchpass-fee-calculator', '/tools/patreon-fee-calculator', '/tools/doorfee-fee-calculator',
  '/use-cases', ...Object.keys(USE_CASES).map((s) => `/use-cases/${s}`),
  '/guides', ...Object.keys(GUIDES).map((s) => `/guides/${s}`),
  '/alternatives', ...Object.keys(ALTERNATIVES).map((s) => `/alternatives/${s}`),
  '/discover', '/help', '/crypto', '/demo'];
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
  // Anchored, because a bare prefix is a glob. "Disallow: /account" also hid
// /accounting, /account-managers and any other seller slug that starts with
// those letters — slugs the reserved list deliberately allows. `$` pins the
// exact path, the trailing-slash form covers anything beneath it, and `?`
// covers the receipt's query string.
// /api/plans, /api/img and /api/discover are what a storefront and the
// /discover grid render FROM — public, read-only, and the only way a crawler
// sees a store's products, its banner, or a link to it. RFC 9309 gives the
// longest matching rule the win, so these three escape the /api/ block and
// nothing else under it does.
`User-agent: *\nAllow: /\nAllow: /api/plans\nAllow: /api/img\nAllow: /api/discover\nDisallow: /api/\nDisallow: /dashboard$\nDisallow: /dashboard/\nDisallow: /dashboard?\nDisallow: /account$\nDisallow: /account/\nDisallow: /account?\nDisallow: /receipt$\nDisallow: /receipt/\nDisallow: /receipt?\n\n${AI_BOTS.map((b) => `User-agent: ${b}\nAllow: /`).join('\n\n')}\n\nSitemap: ${BASE}/sitemap.xml\n`,
);

// The landing page is hand-written, but its footer is not — it is stamped from
// the same footerHtml the generated pages use. Two hand-maintained copies
// drifted once already: /vs/subscord shipped and was linked everywhere except
// the homepage, which is the one page most visitors ever see.
{
  // The redesigned landing page owns its footer markup outright, so the sync
  // is now a PARITY CHECK rather than an overwrite: every comparison page the
  // generator knows about must be linked somewhere on the homepage. That is
  // the guarantee the old marker-replacement existed for (the /vs/subscord
  // drift), kept without forcing the generated markup into the new design.
  const landing = path.join(PUB, 'index.html');
  const html = fs.readFileSync(landing, 'utf8');
  const vsLinks = [...footerHtml.matchAll(/href="(\/vs\/[a-z-]+)"/g)].map((m) => m[1]);
  const missing = vsLinks.filter((href) => !html.includes(`href="${href}"`));
  if (missing.length) throw new Error(`index.html footer is missing comparison links: ${missing.join(', ')}`);
  out.push(`index.html (footer parity: ${vsLinks.length} links verified)`);
}

console.log(`generated ${out.length} files:\n  ${out.join('\n  ')}`);
