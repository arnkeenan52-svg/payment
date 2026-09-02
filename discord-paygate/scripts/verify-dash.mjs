// Dashboard verification harness.
//
// `npm test` is scripts/e2e-test.js plus one slug script: no lint, no CSS
// check, no headless step, and no assertion at any viewport width. It will
// stay green through every layout regression a restyle can cause. This is the
// gate that will not.
//
// It serves public/ with the dashboard's API surface stubbed — the dashboard
// renders entirely on the client, so fixtures are enough to measure layout —
// then walks every section at nine widths in all three faces and records the
// numbers a reskin can silently break: horizontal overflow, the phone nav
// strip's scroll state and active-tab position, whether the hidden-by-default
// forms are still hidden, overlapping text, and the computed value of every
// colour token.
//
//   npm run baseline:dash                      # measure, write baseline
//   npm run test:dash                          # measure, diff against baseline
//   node scripts/verify-dash.mjs --shots       # also write screenshots
//
// Exit code is non-zero when --check finds a difference, so it can gate a ship.
//
// THE BASELINE IS LOCAL, ON PURPOSE. Every number below is a pixel measurement
// out of one Chromium on one machine's fonts, so a baseline recorded here is
// only comparable to a run made here — checked in, it would report a "change"
// to anyone whose text renders a pixel wider. The workflow is before/after on
// the same box: record the baseline on the tree you started from, make the
// change, then --check. A missing baseline is a hard stop (exit 2), never a
// silent pass. The file is gitignored under its own name so it survives a
// clean-up of scratch probes but never rides along in a commit.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const BASELINE = path.join(ROOT, 'scripts', 'verify-dash.baseline.json');
// scratch/ is gitignored, so screenshots land beside the other throwaways.
const SHOT_DIR = process.env.DASH_SHOTS ?? path.join(ROOT, 'scratch', 'dash');
// Which widths --shots writes, and whether it captures the whole scrolled
// section or just the fold. Both are debug knobs: neither is measured, so
// neither can move the baseline.
const SHOT_WIDTHS = new Set((process.env.DASH_SHOT_WIDTHS ?? '390,1440').split(',').map(Number));
const SHOT_FULL = process.env.DASH_SHOT_FULL === '1';

const CHECK = process.argv.includes('--check');
const SHOTS = process.argv.includes('--shots');

// The store sections, in sidebar order. Settings and Store are called out in
// the plan as the two needing the largest scrollLeft to bring the active tab
// into view, so they are the ones that catch a broken nav strip first.
// 'admin' is not a store section — it is the platform view at #/admin, and it
// was the single worst screen in the owner's phone screenshots: owner, status,
// plan, id and date all painted into one line of the Stores table. It went
// unmeasured here for exactly as long as it was broken, so it is measured now.
const SECTIONS = ['overview', 'products', 'members', 'payments', 'discounts', 'store', 'customize', 'billing', 'settings', 'admin'];
const WIDTHS = [320, 360, 390, 430, 768, 861, 1024, 1280, 1440];
// Three faces, not two. 'black' is the dark ground with data-dark set — a
// third of the dashboard's surface area was previously unmeasured, and a
// theme nobody measures is a theme whose overflow and clipping nobody knows
// about.
const FACES = ['light', 'dark', 'black'];

// ── fixtures ────────────────────────────────────────────────────────────────
// Shapes copied from the real handlers. Enough rows that tables, the chart and
// the stat grid all render at their real density — a one-row table measures
// nothing useful.
const DAY = 86400;
const nowS = 1756339200; // fixed, so the baseline does not drift with the clock

const payment = (i) => ({
  createdAt: nowS - i * DAY * 2,
  discordId: `100000000000000${String(i).padStart(3, '0')}`,
  username: ['ari', 'noor', 'sam', 'kit', 'juno', 'ремy', 'tao'][i % 7] + i,
  storeSlug: 'vip-signals',
  storeName: 'VIP Signals',
  planId: i % 3 === 0 ? 'mentorship' : 'vip-access',
  planName: i % 3 === 0 ? 'Mentorship Programme' : 'VIP Access',
  amountUsd: i % 3 === 0 ? 500 : 25,
  currency: 'usd',
  provider: 'stripe',
  status: i % 9 === 0 ? 'past_due' : 'active',
  entitled: i % 9 !== 0,
  lifetime: i % 3 === 0,
  durationDays: i % 3 === 0 ? null : 31,
  renews: i % 3 !== 0,
});
const payments = Array.from({ length: 34 }, (_, i) => payment(i));

const checkout = (i) => ({
  createdAt: nowS - i * DAY,
  completedAt: i % 3 === 0 ? nowS - i * DAY + 400 : null,
  discordId: `200000000000000${String(i).padStart(3, '0')}`,
  username: `buyer${i}`,
  storeSlug: 'vip-signals',
  storeName: 'VIP Signals',
  planId: 'vip-access',
  planName: 'VIP Access',
  amountUsd: 25,
  currency: 'usd',
  discountCode: i % 4 === 0 ? 'LAUNCH20' : null,
  status: i % 3 === 0 ? 'completed' : 'started',
  sessionId: `cs_test_${i}`,
});
const checkouts = Array.from({ length: 18 }, (_, i) => checkout(i));

const store = {
  id: 7, slug: 'vip-signals', name: 'VIP Signals', status: 'live',
  guildId: '900000000000000002', isDefault: false, hasStripeKey: true,
  notifyChannelId: '123', theme: null, discoverable: true, category: 'trading',
  description: 'Signals, calls and a desk that answers.',
  bannerUrl: null, bannerImageUrl: null, bannerKind: null, hasBannerUpload: false,
  about: 'We have run this desk since 2019.', links: null, showMembers: true,
  dashboardPrefs: null, followers: 412, reviewsOn: true,
  creatorName: 'Ari', team: null, teamHeading: null, currency: 'usd',
  // A store that already takes crypto: the settings card renders its saved
  // wallet, which is the state where the fields are longest.
  cryptoWallet: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', cryptoChain: 'sol',
  reviews: { count: 23, average: 4.7 },
};

const products = [
  { planKey: 'vip-access', name: 'VIP Access', description: 'The room, the calls, the alerts.', priceUsd: 25, currency: 'usd', lifetime: false, durationDays: 31, active: true, roleNames: ['@VIP'], roleIds: ['1'], purchaseLimit: null, successUrl: null, linkSlug: null, variantOf: null, expiresAt: null, requiredRoleName: null, hasImageData: false, mediaKind: null, imageUrl: null, createdAt: nowS - 90 * DAY },
  { planKey: 'mentorship', name: 'Mentorship Programme', description: 'Six weeks, one on one.', priceUsd: 500, currency: 'usd', lifetime: true, durationDays: null, active: true, roleNames: ['@Mentee'], roleIds: ['2'], purchaseLimit: 10, successUrl: null, linkSlug: 'mentor', variantOf: null, expiresAt: nowS + 20 * DAY, requiredRoleName: '@VIP', hasImageData: false, mediaKind: null, imageUrl: null, createdAt: nowS - 40 * DAY },
  { planKey: 'mentorship-monthly', name: 'Monthly', description: null, priceUsd: 90, currency: 'usd', lifetime: false, durationDays: 31, active: false, roleNames: [], roleIds: [], purchaseLimit: null, successUrl: null, linkSlug: null, variantOf: 'mentorship', expiresAt: null, requiredRoleName: null, hasImageData: false, mediaKind: null, imageUrl: null, createdAt: nowS - 30 * DAY },
];

const ROUTES = {
  '/api/me': { loggedIn: true, user: { id: '514400000000000007', username: 'vip_owner' }, subscriptions: [] },
  '/api/my/guilds': { guilds: [{ id: '900000000000000002', name: 'VIP Signals', icon: null, owner: true, hasBot: true }], botInvite: 'https://discord.com/invite' },
  // Shaped like api/billing.js GET actually answers (current/usage/exempt,
  // maxMembers) — the old fixture threw inside renderBillingPanel and blessed
  // a permanent "Loading your plan…" as the baseline for 27 states.
  '/api/billing': {
    tiers: [
      { id: 'free', name: 'Free', priceUsd: 0, yearlyUsd: 0, maxMembers: 10 },
      { id: 'starter', name: 'Pro', priceUsd: 14.99, yearlyUsd: 149.9, maxMembers: 50 },
      { id: 'growth', name: 'Max', priceUsd: 44.99, yearlyUsd: 449.9, maxMembers: 500 },
      { id: 'scale', name: 'Unlimited', priceUsd: 134.99, yearlyUsd: 1349.9, maxMembers: null },
    ],
    current: { tier: 'growth', name: 'Max', maxMembers: 500, status: 'active', periodEnd: nowS + 12 * DAY },
    usage: { members: 412, limit: 500 },
    exempt: false,
  },
  // The platform view. Long owner handles, a 19-digit Discord id and a full
  // date in the same row is the shape that collided.
  '/api/admin/platform': {
    totals: {
      users: 41, storesLive: 3, storesDraft: 1, activeMembers: 30, allTimeUsd: 3275,
      checkoutsStarted: 18, checkoutsCompleted: 6, mrrUsd: 59.98, payingOwners: 2, sellers: 3,
    },
    stores: [
      { slug: 'vip-signals', name: 'VIP Signals', ownerUsername: 'vip_owner', ownerDiscordId: '514400000000000007', status: 'live', ownerTier: 'Max', members: 22, revenueUsd: 2750, createdAt: nowS - 120 * DAY },
      { slug: 'apex-garage', name: 'Apex Garage', ownerUsername: 'apex_workshop_owner', ownerDiscordId: '164000000000000411', status: 'live', ownerTier: 'Free', members: 8, revenueUsd: 525, createdAt: nowS - 40 * DAY },
      { slug: 'ringside', name: 'Ringside Picks', ownerUsername: 'ringside', ownerDiscordId: '148900000000000682', status: 'draft', ownerTier: 'Free', members: 0, revenueUsd: 0, createdAt: nowS - 3 * DAY },
    ],
    users: Array.from({ length: 12 }, (_, i) => ({
      discordId: `300000000000000${String(i).padStart(3, '0')}`,
      username: ['factbinger', 'shrij', 'nenmarken', 'jeronimo', 'xaurel', 'varun'][i % 6] + (i || ''),
      seller: i % 5 === 0,
      entitled: i % 3 !== 0,
      memberships: i % 4 === 0 ? 0 : (i % 3) + 1,
      spentUsd: i % 4 === 0 ? 0 : 44.99 * ((i % 3) + 1),
      joinedAt: nowS - (i + 2) * DAY,
      lastSeenAt: nowS - i * 3600,
    })),
  },
  '/api/admin/payments': {
    canCustomise: true,
    stores: [store],
    totals: { byCurrency: { usd: 3275 }, allTimeUsd: 3275, currency: 'usd', payments: payments.length, activeMembers: 30, lifetimeMembers: 11 },
    payments,
    checkouts,
    checkoutTotals: { started: checkouts.length, completed: 6, abandoned: 12, conversionPct: 33.3 },
  },
  '/api/plans': {
    store: { name: 'VIP Signals', slug: 'vip-signals' },
    server: { name: 'VIP Signals', guildId: '900000000000000002', iconUrl: null },
    currency: 'usd',
    capabilities: { stripe: true, crypto: false },
    plans: products.filter((p) => p.active).map((p) => ({ id: p.planKey, name: p.name, description: p.description, priceUsd: p.priceUsd, currency: p.currency, interval: p.lifetime ? 'lifetime' : 'month', lifetime: p.lifetime, imageUrl: null, mediaKind: null, roleNames: p.roleNames, descriptionHighlight: null, linkSlug: p.linkSlug, variantOf: p.variantOf, expiresAt: p.expiresAt, requiredRoleName: p.requiredRoleName })),
  },
};

// POST bodies are routed on their `step`/`action` field, the same way the real
// handlers are.
const POST_ROUTES = {
  products: { products },
  roles: { roles: [{ id: '1', name: 'VIP', usable: true }, { id: '2', name: 'Mentee', usable: true }, { id: '3', name: 'Admin', usable: false }] },
  channels: { channels: [{ id: '123', name: 'sales' }, { id: '124', name: 'general' }] },
  'crypto-coins': { enabled: true, coins: ['sol', 'usdtsol', 'usdttrc20', 'trx', 'usdcbase', 'btc', 'eth', 'usdterc20'] },
  'crypto-check': { ok: true, verified: true, family: 'sol', error: null, chainKnown: true },
  list: {
    discounts: [
      { code: 'LAUNCH20', kind: 'percent', amount: 20, planKey: null, maxUses: 100, uses: 34, expiresAt: nowS + 30 * DAY },
      { code: 'FIVEOFF', kind: 'fixed', amount: 5, planKey: 'vip-access', maxUses: null, uses: 8, expiresAt: null },
      { code: 'EXPIRED', kind: 'percent', amount: 50, planKey: null, maxUses: 10, uses: 10, expiresAt: nowS - DAY },
    ],
  },
};

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/json', '.woff2': 'font/woff2', '.json': 'application/json' };

function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* empty */ }
        const key = parsed.step ?? parsed.action;
        return send(200, POST_ROUTES[key] ?? { ok: true });
      }
      const hit = ROUTES[url.pathname];
      if (hit) return send(200, hit);
      return send(404, { error: 'no stub' });
    }
    // Static. Any unknown path serves the dashboard shell, which is what the
    // real rewrite does.
    let file = url.pathname === '/' ? '/dashboard.html' : url.pathname;
    let full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      full = path.join(PUBLIC, 'dashboard.html');
    }
    try {
      const buf = await readFile(full);
      res.writeHead(200, { 'content-type': MIME[path.extname(full)] ?? 'application/octet-stream' });
      res.end(buf);
    } catch {
      res.writeHead(404).end('nope');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ── the measurements ────────────────────────────────────────────────────────
// Every number here is one a restyle can silently change. Colour tokens are
// included because the whole isolation argument rests on the new stylesheet
// not being able to reintroduce the blue day-sky palette from styles.css.
const probe = () => {
  const css = (el, prop) => (el ? getComputedStyle(el).getPropertyValue(prop).trim() : null);
  const root = document.documentElement;
  const sb = document.querySelector('.sidebar');
  const active = document.querySelector('.side-item.active');
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const disp = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).display : 'absent';
  };
  return {
    overflow: root.scrollWidth - root.clientWidth,
    tokens: {
      bg: css(root, '--bg'), panel: css(root, '--panel'), well: css(root, '--well'),
      edge: css(root, '--edge'), ink: css(root, '--ink'), dim: css(root, '--dim'),
      accent: css(root, '--accent'), uiTint: css(root, '--ui-tint'),
    },
    bodyBg: getComputedStyle(document.body).backgroundColor,
    header: box(document.querySelector('.top')),
    sidebar: sb ? { h: Math.round(sb.getBoundingClientRect().height), scrollW: sb.scrollWidth, clientW: sb.clientWidth, scrolls: sb.scrollWidth > sb.clientWidth } : null,
    activeTab: box(active),
    activeInView: active && sb ? (active.getBoundingClientRect().left >= sb.getBoundingClientRect().left - 1 && active.getBoundingClientRect().right <= sb.getBoundingClientRect().right + 1) : null,
    // Measured from the geometry, not the class. The class is toggled by a
    // scroll/resize handler that can still be a frame behind when the probe
    // runs, and a check that reads it races that handler: the same unchanged
    // tree reported scroll-more flipping at 1440px between two back-to-back
    // runs. The geometry is what the handler derives the class from, so this
    // is the same fact without the race.
    scrollMore: sb ? sb.scrollWidth - sb.clientWidth - sb.scrollLeft > 8 : false,
    // The three that MUST stay hidden until the seller opens them. A rule that
    // shadows [hidden] turns the dashboard into every form open at once — and
    // that is not hypothetical: `.field` did it once and `.btn-secondary` did
    // it again, which is why both now carry an explicit [hidden] re-assertion.
    hidden: {
      prodForm: disp('#prod-form'), addMember: disp('#add-member'), discForm: disp('#disc-form'),
    },
    // The store preview is a PAIR, and which half shows is width-dependent by
    // design: below 900px the button shows and the iframe does not exist,
    // because mounting it eagerly on a phone was killing Safari; above 900px
    // the iframe mounts and the button hides itself. Recorded rather than
    // asserted, so the diff still catches a change without the leak line above
    // crying wolf on every Store state.
    preview: { button: disp('#th-preview-open'), frame: disp('#th-preview') },
    statGrid: box(document.querySelector('.stat-grid')),
    statCols: (() => { const g = document.querySelector('.stat-grid'); return g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : null; })(),
    tableScrolls: [...document.querySelectorAll('.table-scroll')].map((t) => ({ scrollW: t.scrollWidth, clientW: t.clientWidth, tabindex: t.getAttribute('tabindex') })),
    // The chart's tick text is declared in USER UNITS inside a scaled viewBox,
    // so its rendered size is the declared size times (rendered width / 920).
    // getComputedStyle reports the declared value and lies about what the eye
    // sees, so measure the scale and multiply. This is the number the whole
    // chart-label repair exists to move.
    tick: (() => {
      // An SVG <text> inside a viewBox is scaled by (rendered / viewBox) and
      // its computed font-size lies about what the eye sees. An HTML label is
      // not scaled and its computed size is the truth. Which one is present
      // is exactly the difference this repair makes, so measure accordingly
      // rather than applying the scale to both and reporting a fiction.
      const svgText = document.querySelector('.rev-chart .tick');
      const htmlText = document.querySelector('.rev-y span, .rev-x span');
      const t = svgText ?? htmlText;
      if (!t) return null;
      const declared = parseFloat(getComputedStyle(t).fontSize);
      if (!svgText) return { declared, rendered: +declared.toFixed(2), inSvg: false };
      const svg = document.querySelector('.rev-chart');
      const scale = svg?.viewBox?.baseVal?.width ? svg.getBoundingClientRect().width / svg.viewBox.baseVal.width : 1;
      return { declared, rendered: +(declared * scale).toFixed(2), inSvg: true };
    })(),
    panelRadius: css(document.querySelector('.panel'), 'border-radius'),
    panelBorder: css(document.querySelector('.panel'), 'border-top-width'),
    // CLIPPED CONTENT. The page-level overflow number above says nothing about
    // whether a card is cutting its own text off, which is a different bug and
    // the one that actually reaches a seller: a heading sliced mid-word by the
    // edge of the panel it sits in. Any element that hides its overflow and
    // holds more than it shows is reported with the text it is eating.
    clipped: (() => {
      const out = [];
      for (const el of document.querySelectorAll('body.app *')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        // A form control scrolls its own value by design — a long slug in a
        // text field is not a clipped heading. So is a thumbnail that crops a
        // wallpaper on purpose. Neither is the defect being hunted here.
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') continue;
        if (el.querySelector('img, video, svg, canvas')) continue;
        if (cs.backgroundImage && cs.backgroundImage !== 'none') continue;
        // Deliberate crops: a round colour swatch clips an oversized <input>
        // to make the circle, and a wallpaper thumbnail clips oversized blobs
        // to make the preview. Both hide overflow ON PURPOSE and neither is
        // eating a word. The tell is that they contain no text of their own.
        if (!(el.textContent || '').trim()) continue;
        const hidesX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
        const hidesY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
        const overX = el.scrollWidth - el.clientWidth > 1;
        const overY = el.scrollHeight - el.clientHeight > 1;
        if (!((hidesX && overX) || (hidesY && overY))) continue;
        // A deliberate ellipsis is not a defect — it is the designed answer to
        // long content, and it is announced by text-overflow.
        if (hidesX && overX && cs.textOverflow === 'ellipsis') continue;
        const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        out.push({
          sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''),
          byX: overX && hidesX ? el.scrollWidth - el.clientWidth : 0,
          byY: overY && hidesY ? el.scrollHeight - el.clientHeight : 0,
          text: t,
        });
      }
      return out;
    })(),
    // OVERLAPPING TEXT. `clipped` above catches a box eating its own content.
    // It says nothing about two different boxes painting into the same pixels,
    // and that is the defect that actually reached the owner: at 390px the
    // Products table rendered "$25.00" on top of "+ Option", "Link" and the
    // active toggle, while this harness reported "clipped content: none"
    // through all of it. A layout check that measures only overflow will bless
    // a collision every time.
    //
    // Measured on TEXT RANGES, not element boxes. An element's box is often
    // legitimately larger than its glyphs — a flex row, a padded cell, a
    // wrapper — so element-box intersection reports dozens of harmless
    // containments. Range.getClientRects() returns the boxes the glyphs are
    // actually painted into, one per line, which is the thing an eye sees.
    //
    // Pairs where one node's parent contains the other's are skipped: that is
    // ordinary inline flow (a <strong> inside a <td>), not a collision. Two or
    // fewer pixels in either axis is ignored — antialiasing, a descender
    // brushing a following line, and the odd sub-pixel rounding all live there.
    overlaps: (() => {
      const root = document.querySelector('body.app');
      if (!root) return [];
      const selOf = (el) =>
        el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
        (el.className && typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\s+/).join('.')
          : '');
      // Range rects are UNCLIPPED: a cell scrolled out of sight inside
      // .table-scroll, or a name cut short by an ellipsis, still reports the
      // geometry it would have had with room. Left alone that invents
      // collisions between panels that never touch — the Recent Transactions
      // table "overlapping" Recent Sales two columns away. So every rect is
      // intersected with the boxes of the ancestors that actually clip it.
      const clipOf = (el) => {
        let x1 = -Infinity, y1 = -Infinity, x2 = Infinity, y2 = Infinity;
        for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
          const cs = getComputedStyle(p);
          const cx = cs.overflowX !== 'visible';
          const cy = cs.overflowY !== 'visible';
          if (!cx && !cy) continue;
          const b = p.getBoundingClientRect();
          if (cx) { x1 = Math.max(x1, b.left); x2 = Math.min(x2, b.right); }
          if (cy) { y1 = Math.max(y1, b.top); y2 = Math.min(y2, b.bottom); }
        }
        return { x1, y1, x2, y2 };
      };
      const items = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const el = n.parentElement;
        if (!el) continue;
        // <option> text is painted by the OS popup, not the page.
        if (['OPTION', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TITLE'].includes(el.tagName)) continue;
        if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) continue;
        const clip = clipOf(el);
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (r.width < 2 || r.height < 2) continue;
          const x1 = Math.max(r.left, clip.x1); const x2 = Math.min(r.right, clip.x2);
          const y1 = Math.max(r.top, clip.y1); const y2 = Math.min(r.bottom, clip.y2);
          if (x2 - x1 < 2 || y2 - y1 < 2) continue;
          items.push({ el, text: text.slice(0, 32), sel: selOf(el), x1, y1, x2, y2 });
        }
      }
      // Sorted by top edge, so the inner loop can stop as soon as a candidate
      // starts below the current box: nothing further down can reach back up.
      items.sort((a, b) => a.y1 - b.y1);
      const out = [];
      const seen = new Set();
      for (let i = 0; i < items.length; i += 1) {
        const a = items[i];
        for (let j = i + 1; j < items.length; j += 1) {
          const b = items[j];
          if (b.y1 >= a.y2 - 2) break;
          if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
          const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
          const oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
          if (ox <= 2 || oy <= 2) continue;
          const key = `${a.sel}|${a.text}|${b.sel}|${b.text}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ a: a.text, aSel: a.sel, b: b.text, bSel: b.sel, byX: Math.round(ox), byY: Math.round(oy) });
          if (out.length >= 40) return out;
        }
      }
      return out;
    })(),
  };
};

const server = await startServer();
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});

if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });

const out = {};
// A harness that measures a page which threw is measuring a fiction.
const pageErrs = [];
for (const face of FACES) {
  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => pageErrs.push(`${face}|${width}: ${e.message}`));
    // Set the face before the first paint so nothing is measured mid-transition.
    await page.addInitScript((f) => {
      const theme = f === 'black' ? 'dark' : f;
      try { localStorage.setItem('dues-theme', theme); } catch { /* private mode */ }
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.dataset.theme = theme;
        if (f === 'black') document.documentElement.dataset.dark = 'black';
      });
    }, face);
    for (const section of SECTIONS) {
      const hash = section === 'admin' ? '#/admin' : `#/store/vip-signals/${section}`;
      await page.goto(`${base}/dashboard.html${hash}`, { waitUntil: 'networkidle' });
      await page.evaluate((f) => {
        document.documentElement.dataset.theme = f === 'black' ? 'dark' : f;
        // Re-asserted after each navigation: the dashboard re-derives this
        // attribute from the STORED preference on every render, so a fixture
        // without darkStyle saved would wipe it between sections.
        if (f === 'black') document.documentElement.dataset.dark = 'black';
        else delete document.documentElement.dataset.dark;
      }, face);
      // The dashboard renders sections asynchronously; wait for the nav to
      // exist and then let the section's own fetches settle.
      // The platform view has no section rail — waiting for one there would
      // burn the full timeout on every one of its states.
      await page.waitForSelector(section === 'admin' ? '.admin-wrap' : '.side-item', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(450);
      out[`${face}|${width}|${section}`] = await page.evaluate(probe);
      if (SHOTS && SHOT_WIDTHS.has(width)) {
        await page.screenshot({ path: `${SHOT_DIR}/${face}-${width}-${section}.png`, fullPage: SHOT_FULL });
      }
    }
    await page.close();
  }
}

await browser.close();
server.close();

// ── report ──────────────────────────────────────────────────────────────────
const overflows = Object.entries(out).filter(([, v]) => v.overflow > 0);
const badHidden = Object.entries(out).filter(([, v]) =>
  Object.values(v.hidden).some((d) => d !== 'none' && d !== 'absent'));
// Above 900px the button hides itself by mounting the iframe eagerly. If it is
// still visible on a desktop width, the mount threw before reaching that line.
const previewStuck = Object.entries(out).filter(([k, v]) =>
  v.preview?.button && v.preview.button !== 'none' && v.preview.button !== 'absent' && Number(k.split('|')[1]) > 900);
// The mirror of it: below 900px the iframe must NOT be mounted, or the phone
// is loading a whole storefront it was never asked to.
const frameEager = Object.entries(out).filter(([k, v]) =>
  v.preview?.frame && v.preview.frame !== 'absent' && Number(k.split('|')[1]) <= 900);

console.log(`measured ${Object.keys(out).length} states (${FACES.length} faces x ${WIDTHS.length} widths x ${SECTIONS.length} sections)`);
console.log(`horizontal overflow: ${overflows.length === 0 ? 'none' : overflows.map(([k, v]) => `${k}=${v.overflow}px`).join(', ')}`);
const clips = Object.entries(out).flatMap(([k, v]) => (v.clipped ?? []).map((c) => ({ state: k, ...c })));
if (clips.length) {
  // Group by selector: one broken rule shows up in dozens of states and the
  // list is unreadable if every state prints its own line.
  const bySel = new Map();
  for (const c of clips) {
    const e = bySel.get(c.sel) ?? { n: 0, worstX: 0, worstY: 0, text: c.text, states: [] };
    e.n += 1; e.worstX = Math.max(e.worstX, c.byX); e.worstY = Math.max(e.worstY, c.byY);
    if (e.states.length < 3) e.states.push(c.state);
    bySel.set(c.sel, e);
  }
  console.log(`CLIPPED CONTENT: ${bySel.size} selector(s) cutting text off`);
  for (const [sel, e] of [...bySel].sort((a, b) => Math.max(b[1].worstX, b[1].worstY) - Math.max(a[1].worstX, a[1].worstY))) {
    console.log(`  ${sel}  +${e.worstX}x/+${e.worstY}y in ${e.n} state(s)  "${e.text}"  e.g. ${e.states[0]}`);
  }
} else {
  console.log('clipped content: none');
}
// Overlap is a FAILURE, not a recorded number. Everything else here is
// diffed against a baseline because it is a judgement call — a padding, a
// scroll position, a colour. Two pieces of text in the same pixels is not a
// judgement call, so it fails the run outright rather than waiting to be
// noticed in a diff.
const laps = Object.entries(out).flatMap(([k, v]) => (v.overlaps ?? []).map((o) => ({ state: k, ...o })));
if (laps.length) {
  const byPair = new Map();
  for (const o of laps) {
    const key = `${o.aSel} × ${o.bSel}`;
    const e = byPair.get(key) ?? { n: 0, worstX: 0, worstY: 0, a: o.a, b: o.b, states: [] };
    e.n += 1; e.worstX = Math.max(e.worstX, o.byX); e.worstY = Math.max(e.worstY, o.byY);
    if (e.states.length < 3) e.states.push(o.state);
    byPair.set(key, e);
  }
  console.error(`FAIL: OVERLAPPING TEXT — ${byPair.size} pair(s) painting into the same pixels`);
  for (const [pair, e] of [...byPair].sort((x, y) => y[1].worstX * y[1].worstY - x[1].worstX * x[1].worstY)) {
    console.error(`  ${pair}`);
    console.error(`    "${e.a}" over "${e.b}"  ${e.worstX}x${e.worstY}px in ${e.n} state(s)  e.g. ${e.states[0]}`);
  }
  process.exitCode = 1;
} else {
  console.log('overlapping text: none');
}
console.log(`hidden-by-default leaks: ${badHidden.length === 0 ? 'none' : badHidden.map(([k]) => k).join(', ')}`);
if (pageErrs.length) {
  console.error(`FAIL: ${pageErrs.length} page error(s):\n  ${[...new Set(pageErrs)].join('\n  ')}`);
  process.exitCode = 1;
}
const lightBg = out['light|1440|overview']?.tokens?.bg;
const darkBg = out['dark|1440|overview']?.tokens?.bg;
// .tokens.bg, not .bg — the first version of this line read the wrong path,
// so blackBg was the string '?', which is never equal to navy and made the
// distinctness assertion below pass without testing anything. A check that
// cannot fail is worse than no check: it reports confidence it never earned.
const blackBg = out['black|1440|overview']?.tokens?.bg;
console.log(`--bg light=${lightBg} dark=${darkBg} black=${blackBg}`);
// A face that renders identically to another is a face that did not apply.
// This is exactly how the storefront's "black theme" could have shipped as a
// second copy of navy without anyone noticing.
if (!blackBg || !darkBg || !lightBg) {
  console.error('FAIL: a face reported no --bg at all, so the comparison below would be meaningless');
  process.exitCode = 1;
} else if (darkBg === blackBg) {
  console.error('FAIL: the black face renders the same ground as navy — data-dark did not apply');
  process.exitCode = 1;
}
console.log(`preview button stuck open above 900px: ${previewStuck.length === 0 ? 'no' : previewStuck.map(([k]) => k).join(', ')}`);
console.log(`preview iframe mounted at or below 900px: ${frameEager.length === 0 ? 'no' : frameEager.map(([k]) => k).join(', ')}`);
for (const w of [360, 1440]) {
  const t = out[`light|${w}|overview`]?.tick;
  if (t) console.log(`chart tick at ${w}: declared ${t.declared}px, actually renders at ${t.rendered}px`);
}

if (CHECK) {
  if (!fs.existsSync(BASELINE)) {
    console.error('no baseline to check against — run without --check first');
    process.exit(2);
  }
  const before = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const diffs = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(out)])) {
    const a = JSON.stringify(before[key] ?? null);
    const b = JSON.stringify(out[key] ?? null);
    if (a !== b) diffs.push(key);
  }
  if (diffs.length) {
    console.error(`\n${diffs.length} state(s) changed vs baseline:`);
    for (const d of diffs.slice(0, 40)) {
      console.error(`  ${d}`);
      const a = before[d] ?? {}; const b = out[d] ?? {};
      for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const av = JSON.stringify(a[f]); const bv = JSON.stringify(b[f]);
        if (av !== bv) console.error(`     ${f}: ${av} -> ${bv}`);
      }
    }
    process.exit(1);
  }
  console.log('\nno change vs baseline.');
} else {
  fs.writeFileSync(BASELINE, JSON.stringify(out, null, 1));
  console.log(`\nbaseline written: ${path.relative(ROOT, BASELINE)}`);
}
