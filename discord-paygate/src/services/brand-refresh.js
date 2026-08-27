// One-shot brand refresh for everything the bot has ALREADY posted.
//
// The standing community posts (#rules, #guide, #official-links,
// #announcements) carry banner cards rendered at post time — when the brand
// changes, the live messages keep wearing the old design until someone with
// the bot token re-runs scripts/post-message.mjs by hand. This service closes
// that gap from the deployment that already holds the token: the hourly cron
// calls it, an app_secrets flag short-circuits every run after the first
// success, and on a brand bump (BRAND_VERSION below) it walks each standing
// post, swaps its card for the pre-rendered PNG in assets/cards/, and leaves
// the text exactly as posted. The bot's own avatar and profile banner get the
// same treatment.
//
// Cards are PRE-RENDERED into the repo (the sky needs brand fonts that the
// serverless image cannot guarantee) — this module only reads files and talks
// to Discord. Everything is best-effort: a failure logs, skips the flag, and
// the next cron run tries again.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getAppSecret, setAppSecret } from '../db.js';

// Bump when the shipped cards change — that is what re-arms the refresh.
const BRAND_VERSION = 'sky-151';
const API = (process.env.DISCORD_API_BASE ?? 'https://discord.com/api/v10').replace(/\/$/, '');
const POSTS = ['rules', 'guide', 'official-links', 'announcement'];

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

// [name] blocks from a content/*.txt file — just the two single-line fields
// this service needs; scripts/post-message.mjs owns the full format.
const section = (src, name) => {
  const m = src.match(new RegExp(`^\\[${name}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[|$)`, 'm'));
  return m
    ? m[1].split('\n').filter((l) => l.trim() && !/^\s*#/.test(l)).map((l) => l.trim()).join(' ').trim()
    : '';
};

const readIf = (p) => {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
};

async function refreshStandingPost(me, name) {
  const src = readIf(path.join(config.root, 'content', `${name}.txt`));
  const png = readIf(path.join(config.root, 'assets', 'cards', `${name}.png`));
  if (!src || !png) return 'skipped';
  const marker = section(String(src), 'marker');
  const channel = section(String(src), 'channel');
  if (!marker || !/^\d{5,25}$/.test(channel)) return 'skipped';
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
  const avatar = readIf(path.join(config.root, 'public', 'icon-512.png'));
  const banner = readIf(path.join(config.root, 'public', 'dues-banner.png'));
  if (!avatar) return 'skipped';
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
    if ((await getAppSecret('brand:posts')) !== BRAND_VERSION) {
      const me = await call('/users/@me');
      let allOk = true;
      for (const name of POSTS) {
        try {
          summary[name] = await refreshStandingPost(me, name);
        } catch (err) {
          allOk = false;
          summary[name] = `failed: ${err.message}`;
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
    if ((await getAppSecret('brand:profile')) !== BRAND_VERSION) {
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
