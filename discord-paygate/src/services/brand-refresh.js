// One-shot brand refresh for everything the bot has ALREADY posted.
//
// The standing community posts (#rules, #guide, #official-links,
// #announcements) carry banner cards rendered at post time — when the brand
// changes, the live messages keep wearing the old design until someone with
// the bot token re-runs scripts/post-message.mjs by hand. This service closes
// that gap from the deployment that already holds the token: the hourly cron
// (and the public /api/brand-refresh trigger) calls it, an app_secrets flag
// short-circuits every run after the first success, and on a brand bump
// (BRAND_VERSION below) it walks each standing post, swaps its card, and
// leaves the text exactly as posted. The bot's own avatar and profile banner
// get the same treatment.
//
// Assets arrive over https from the site's own public/ (cards live at
// /cards/<name>.png) — no filesystem bundling to trust — and the post
// manifest is inlined from content/*.txt's [marker]/[channel] blocks, which
// scripts/post-message.mjs still owns for full re-posts.
import { config } from '../config.js';
import { getAppSecret, setAppSecret } from '../db.js';

// Bump when the shipped cards change — that is what re-arms the refresh.
const BRAND_VERSION = 'sky-158';
const API = (process.env.DISCORD_API_BASE ?? 'https://discord.com/api/v10').replace(/\/$/, '');

// Mirrors [marker] + [channel] in content/<name>.txt.
const POSTS = [
  { name: 'rules', channel: '1541819014643322900', marker: 'Dues · Server Rules' },
  { name: 'guide', channel: '1541859167067971655', marker: 'Dues · How It Works' },
  { name: 'official-links', channel: '1541819865625657384', marker: 'Dues · Official Links' },
  { name: 'announcement', channel: '1541818939711955066', marker: 'Dues · Launch' },
];

const call = async (pathname, init = {}) => {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { authorization: `Bot ${config.discord.botToken}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) {
    const wait = Number((await res.json().catch(() => ({}))).retry_after ?? 1) * 1000;
    await new Promise((r) => setTimeout(r, wait + 250));
    return call(pathname, init);
  }
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
};

const fetchAsset = async (path) => {
  const res = await fetch(`${config.publicBaseUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`asset ${path} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

async function refreshStandingPost(me, { name, channel, marker }) {
  const png = await fetchAsset(`/cards/${name}.png`);
  const messages = await call(`/channels/${channel}/messages?limit=50`);
  const mine = messages.find((m) => m.author?.id === me.id && m.embeds?.some((e) => e.footer?.text === marker));
  if (!mine) return 'not found';
  const old = mine.embeds.find((e) => e.footer?.text === marker);
  // The text stays exactly as posted — only the picture changes. Rebuilt
  // minimal (Discord decorates fetched embeds with proxy fields it would
  // reject back), attachments:[] drops the old card, the multipart part
  // re-adds the new one under the same name.
  const embed = {
    ...(old.title ? { title: old.title } : {}),
    ...(old.description ? { description: old.description } : {}),
    ...(typeof old.color === 'number' ? { color: old.color } : {}),
    footer: { text: marker },
    image: { url: `attachment://${name}.png` },
  };
  const form = new FormData();
  form.set('payload_json', JSON.stringify({ embeds: [embed], attachments: [], allowed_mentions: { parse: [] } }));
  form.set('files[0]', new Blob([png], { type: 'image/png' }), `${name}.png`);
  await call(`/channels/${channel}/messages/${mine.id}`, { method: 'PATCH', body: form });
  return 'updated';
}

// The pinned #welcome post from setup-community.mjs is text-only and has no
// marker — find it by shape (bot-authored pin starting with the welcome
// heading) and give it the brand banner as an embed.
async function refreshWelcomePin(me) {
  if (!config.discord.guildId) return 'skipped';
  const channels = await call(`/guilds/${config.discord.guildId}/channels`);
  const welcome = channels.find((c) => c.type === 0 && c.name === 'welcome');
  if (!welcome) return 'skipped';
  const pins = await call(`/channels/${welcome.id}/pins`);
  const mine = pins.find((m) => m.author?.id === me.id && (m.content ?? '').startsWith('**Welcome to Dues**'));
  if (!mine) return 'not found';
  await call(`/channels/${welcome.id}/messages/${mine.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      embeds: [{ color: 0x5865f2, image: { url: `${config.publicBaseUrl}/dues-banner.png` } }],
      allowed_mentions: { parse: [] },
    }),
  });
  return 'updated';
}

async function refreshBotProfile() {
  const avatar = await fetchAsset('/icon-512.png');
  const banner = await fetchAsset('/dues-banner.png').catch(() => null);
  await call('/users/@me', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      avatar: `data:image/png;base64,${avatar.toString('base64')}`,
      ...(banner ? { banner: `data:image/png;base64,${banner.toString('base64')}` } : {}),
    }),
  });
  return 'updated';
}

export async function refreshBrandAssets() {
  if (!config.discord.botToken) return null;
  // Serverless production only, unless explicitly armed — keeps the e2e mocks
  // and local dev servers from poking at a Discord that is not there.
  if (!process.env.VERCEL && process.env.BRAND_REFRESH !== '1') return null;
  const summary = {};
  try {
    // Both flags settled: the usual case, one cheap read per cron tick.
    const postsDone = (await getAppSecret('brand:posts')) === BRAND_VERSION;
    const profileDone = (await getAppSecret('brand:profile')) === BRAND_VERSION;
    if (postsDone && profileDone) return null;
    // Throttle real attempts: the public trigger must not be able to make
    // the bot hammer Discord while something is failing.
    const now = Math.floor(Date.now() / 1000);
    const last = Number((await getAppSecret('brand:attempt')) ?? 0);
    if (now - last < 120) return { throttled: true };
    await setAppSecret('brand:attempt', String(now));

    const me = await call('/users/@me');
    if (!postsDone) {
      let allOk = true;
      for (const post of POSTS) {
        try {
          summary[post.name] = await refreshStandingPost(me, post);
        } catch (err) {
          allOk = false;
          summary[post.name] = `failed: ${err.message}`;
        }
      }
      try {
        summary.welcome = await refreshWelcomePin(me);
      } catch (err) {
        allOk = false;
        summary.welcome = `failed: ${err.message}`;
      }
      if (allOk) await setAppSecret('brand:posts', BRAND_VERSION);
    }
    if (!profileDone) {
      try {
        summary.profile = await refreshBotProfile();
        await setAppSecret('brand:profile', BRAND_VERSION);
      } catch (err) {
        // Avatar changes are tightly rate-limited by Discord — leave the flag
        // unset so a later run retries.
        summary.profile = `failed: ${err.message}`;
      }
    }
  } catch (err) {
    console.warn(`[brand-refresh] ${err.message}`);
    summary.error = err.message;
  }
  if (Object.keys(summary).length) console.log(`[brand-refresh] ${JSON.stringify(summary)}`);
  return Object.keys(summary).length ? summary : null;
}
