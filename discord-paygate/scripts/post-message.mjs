// Post (or update) one of the Dues community's standing messages.
//
// IDEMPOTENT BY DESIGN. Running this twice must never leave two rules posts in
// the channel. Discord gives messages no custom metadata, so the marker has to
// be something visible: this script stamps MARKER into the embed footer and,
// on every run, scans the channel's recent history for a message that is both
// authored by this bot and carries that footer. Found -> PATCH it. Not found
// -> POST a new one. A human editing the text by hand is therefore pointless
// (the next run overwrites it); content/rules.txt is the source of truth.
//
// SAFE BY DEFAULT. With no flags this renders everything and writes it to disk
// without talking to Discord at all. --confirm is the only thing that posts.
//
//   node scripts/post-message.mjs rules                   # dry run + preview
//   node scripts/post-message.mjs rules --confirm         # actually post/update
//   node scripts/post-message.mjs official-links --confirm
//   node scripts/post-message.mjs announcement --confirm
//
// Each message is one file in content/, and that file owns everything about
// it: the text, the channel it belongs in, and the marker that identifies it
// on re-runs. Adding a fourth standing message means adding a fourth file,
// not editing this script.
//
// Env:
//   DISCORD_BOT_TOKEN  required for --confirm (and for the dry run's channel
//                      probe, which is skipped when absent)
//   POST_CHANNEL_ID    overrides the [channel] id in the text file
//   POST_PATH          overrides content/<name>.txt
//   POST_THEME         dark | light   (default dark)
//   PREVIEW_DIR        where the dry run writes    (default ./tmp-rules-preview)

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = (process.env.DISCORD_API_BASE ?? 'https://discord.com/api/v10').replace(/\/$/, '');
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? '';
const THEME = process.env.POST_THEME === 'light' ? 'light' : 'dark';
const CONFIRM = process.argv.includes('--confirm');
const PREVIEW_DIR = process.env.PREVIEW_DIR ?? path.join(ROOT, 'tmp-post-preview');

// The stable identity of each post now lives in its own file, under [marker].
// Changing a marker orphans the message already in that channel: the next run
// will not recognise it and will post a second one. Do not change one casually.
// How far back to look. The rules post is pinned and near-static, so it will
// normally be old — but a rules channel gets almost no traffic, so 100
// messages is years of history there. If it ever scrolls past this, delete the
// stale post by hand rather than raising the number.
const SCAN_LIMIT = 100;

// Link labels are author-written, but markdown metacharacters in one would
// break the embed layout rather than escape into it.
const esc = (s) => String(s ?? '').replace(/([*_`~|\\])/g, '\\$1');

const die = (msg) => {
  console.error(`[post] ${msg}`);
  process.exit(1);
};

// ── the text file ─────────────────────────────────────────────────────────────
// A deliberately boring format: [block] headers, # comments, everything else
// verbatim. The alternative was JSON, which would mean escaping every
// apostrophe in twelve rules written by a human.
function parseRules(text) {
  const blocks = {};
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*#/.test(line)) continue;
    const header = line.match(/^\[([a-z-]+)\]\s*$/i);
    if (header) {
      current = header[1].toLowerCase();
      blocks[current] = [];
      continue;
    }
    if (current) blocks[current].push(line);
  }
  // Prose blocks are hard-wrapped in the file so the file stays readable, but
  // Discord honours every newline literally — shipped as-is, the intro would
  // break mid-sentence at whatever column the author happened to stop. Single
  // newlines collapse to spaces; a blank line still starts a new paragraph.
  const joined = (k) =>
    (blocks[k] ?? [])
      .join('\n')
      .trim()
      .split(/\n\s*\n/)
      .map((para) => para.replace(/\s*\n\s*/g, ' ').trim())
      .filter(Boolean)
      .join('\n\n');
  const channels = {};
  for (const line of blocks.channels ?? []) {
    const m = line.match(/^\s*([a-z0-9-]+)\s*=\s*(\d{5,25})\s*$/i);
    if (m) channels[m[1].toLowerCase()] = m[2];
  }
  const rules = (blocks.rules ?? []).map((l) => l.trim()).filter(Boolean);
  // [links] is "Label | https://..." per line — a named list rather than a
  // numbered one, because #official-links is a list of destinations and
  // numbering them implies an order that does not exist.
  const links = (blocks.links ?? [])
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [label, ...rest] = l.split('|');
      return { label: label.trim(), url: rest.join('|').trim() };
    })
    .filter((l) => l.label && /^https:\/\//.test(l.url));
  return {
    channels,
    rules,
    links,
    marker: joined('marker'),
    channel: joined('channel'),
    title: joined('title'),
    subtitle: joined('subtitle'),
    intro: joined('intro'),
    outro: joined('outro'),
  };
}

// {support} -> <#1541...>. An unknown placeholder is a typo in the text file,
// not something to paper over: a literal "{suport}" shipped to a rules channel
// looks broken, so fail before posting instead.
function mentions(text, channels) {
  return text.replace(/\{([a-z0-9-]+)\}/gi, (_, name) => {
    const id = channels[name.toLowerCase()];
    if (!id) die(`unknown channel placeholder {${name}} — add it to [channels] in the rules file`);
    return `<#${id}>`;
  });
}

// ── discord rest ──────────────────────────────────────────────────────────────
async function api(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { authorization: `Bot ${TOKEN}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429) {
    const wait = Number((await res.json().catch(() => ({}))).retry_after ?? 1) * 1000;
    console.warn(`[post] rate limited, retrying in ${Math.round(wait)}ms`);
    await new Promise((r) => setTimeout(r, wait + 250));
    return api(pathname, init);
  }
  if (!res.ok) die(`${init.method ?? 'GET'} ${pathname} -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

// ── build ─────────────────────────────────────────────────────────────────────
// The message to post is named on the command line; everything else about it
// comes out of its file.
const NAME = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '';
if (!NAME) die('name the message to post, e.g. `npm run post -- rules`');
if (!/^[a-z0-9-]+$/.test(NAME)) die(`"${NAME}" is not a message name (lowercase, digits and dashes)`);

const file = process.env.POST_PATH ?? path.join(ROOT, 'content', `${NAME}.txt`);
if (!fs.existsSync(file)) {
  const known = fs.existsSync(path.join(ROOT, 'content'))
    ? fs.readdirSync(path.join(ROOT, 'content')).filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, ''))
    : [];
  die(`no message called "${NAME}" (${file})${known.length ? `\n        known messages: ${known.join(', ')}` : ''}`);
}
const source = fs.readFileSync(file, 'utf8');
const doc = parseRules(source);

// Baked into the worker image so these can be posted from Railway's web
// console — which means the copy running there is only as fresh as the last
// deploy. Printing a fingerprint makes a stale image visible BEFORE it
// overwrites the live message with old text: compare it against
// `sha256sum content/<name>.txt | cut -c1-8` on main.
const fingerprint = crypto.createHash('sha256').update(source).digest('hex').slice(0, 8);

// The refusals that matter: an empty body would otherwise publish a branded,
// official-looking, completely blank message.
if (!doc.rules.length && !doc.links.length && !doc.intro) die(`${file} has no [rules], [links] or [intro] — nothing to post`);
if (!doc.title) die(`${file} has no [title]`);
// Without a stable marker a re-run cannot recognise its own message, and every
// run would stack another copy in the channel. That is the one failure this
// whole script exists to prevent, so it is not defaultable.
if (!doc.marker) die(`${file} has no [marker] — without one, re-running would post a duplicate instead of editing`);

const MARKER = doc.marker;
const CHANNEL = process.env.POST_CHANNEL_ID || doc.channel;
if (!CHANNEL) die(`${file} has no [channel] id — set POST_CHANNEL_ID or add one`);

const numbered = doc.rules.map((r, i) => `**${i + 1}.** ${mentions(r, doc.channels)}`).join('\n\n');
const linkList = doc.links.map((l) => `**${esc(l.label)}**\n${l.url}`).join('\n\n');
const description = [
  doc.intro && mentions(doc.intro, doc.channels),
  numbered,
  linkList,
  doc.outro && mentions(doc.outro, doc.channels),
]
  .filter(Boolean)
  .join('\n\n');

if (description.length > 4096) die(`the rules run to ${description.length} chars; Discord caps an embed description at 4096`);

const { renderBannerCard } = await import('../src/lib/welcome-card.js');
const png = await renderBannerCard({ title: doc.title, subtitle: doc.subtitle, theme: THEME });

// The embed's accent stripe is the one part of this post Discord paints
// against the VIEWER's theme, not ours — so it cannot follow RULES_THEME. A
// near-white stripe scores 12.6:1 on Discord dark and 1.02:1 on Discord light,
// i.e. invisible for every light-theme member; near-black is the same failure
// mirrored. This mid tone (already the brand's muted text colour) clears 3:1
// against both Discord embed grounds: 3.97:1 on #2b2d31, 3.13:1 on #f2f3f5.
const EMBED_STRIPE = 0x8a8a84;

const embed = {
  description,
  color: EMBED_STRIPE,
  image: { url: `attachment://${NAME}.png` },
  footer: { text: MARKER },
};
// No mention may ping from a rules post: the body is full of <#channel>
// references, and a stray @everyone in the text file must not be able to
// notify the whole server.
const payload = { embeds: [embed], allowed_mentions: { parse: [] } };

// ── dry run ───────────────────────────────────────────────────────────────────
if (!CONFIRM) {
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  fs.writeFileSync(path.join(PREVIEW_DIR, `${NAME}.png`), png);
  fs.writeFileSync(path.join(PREVIEW_DIR, `${NAME}.json`), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(PREVIEW_DIR, `${NAME}.txt`), description);
  let existing = 'not checked (no DISCORD_BOT_TOKEN)';
  if (TOKEN) {
    const found = await findExisting();
    existing = found ? `would EDIT message ${found.id} (posted ${found.timestamp})` : 'would POST a new message';
  }
  console.log(
    [
      `[post] DRY RUN — nothing was sent to Discord.`,
      `        message  ${NAME}`,
      `        channel  ${CHANNEL}`,
      `        body     ${doc.rules.length} rules, ${doc.links.length} links  (${file})`,
      `        version  ${fingerprint}`,
      `        chars    ${description.length} / 4096`,
      `        action   ${existing}`,
      `        preview  ${PREVIEW_DIR}`,
      '',
      '        Re-run with --confirm to publish.',
    ].join('\n'),
  );
  process.exit(0);
}

// ── publish ───────────────────────────────────────────────────────────────────
if (!TOKEN) die('DISCORD_BOT_TOKEN is required to post');

// Which message is ours: authored by this bot AND stamped with MARKER. The
// author check is not optional — without it the script would try to PATCH
// another bot's message, which Discord refuses, and a copied-and-pasted rules
// post from a human would be mistaken for ours forever.
async function findExisting() {
  const me = await api('/users/@me');
  const messages = await api(`/channels/${CHANNEL}/messages?limit=${SCAN_LIMIT}`);
  return messages.find((m) => m.author?.id === me.id && m.embeds?.some((e) => e.footer?.text === MARKER)) ?? null;
}

function body(payloadJson) {
  const form = new FormData();
  form.set('payload_json', JSON.stringify(payloadJson));
  form.set('files[0]', new Blob([png], { type: 'image/png' }), `${NAME}.png`);
  return form;
}

const existing = await findExisting();
if (existing) {
  // attachments: [] drops the old image; the multipart part re-adds it. Without
  // this the edit appends a second copy of the banner to the same message.
  await api(`/channels/${CHANNEL}/messages/${existing.id}`, { method: 'PATCH', body: body({ ...payload, attachments: [] }) });
  console.log(`[post] edited existing message ${existing.id} in ${CHANNEL} (rules ${fingerprint})`);
} else {
  const posted = await api(`/channels/${CHANNEL}/messages`, { method: 'POST', body: body(payload) });
  console.log(`[post] posted new message ${posted.id} in ${CHANNEL} (rules ${fingerprint})`);
  // Pinning is best-effort: it needs MANAGE_MESSAGES, and a missing permission
  // should not read as "the rules failed to post".
  await fetch(`${API}/channels/${CHANNEL}/pins/${posted.id}`, { method: 'PUT', headers: { authorization: `Bot ${TOKEN}` } })
    .then((r) => console.log(r.ok ? '[post] pinned' : `[post] not pinned (${r.status}) — pin it by hand`))
    .catch(() => console.log('[post] not pinned — pin it by hand'));
}
