#!/usr/bin/env node
// One-shot builder for the official Ripley community server.
//
//   node scripts/setup-community.mjs <server-id>
//
// Run it anywhere with Node 18+. The bot must already be a member of the
// server with Administrator permission (Server Settings → Members shows it).
// The token is looked up in this order and never leaves the machine:
//   1. DISCORD_BOT_TOKEN environment variable
//   2. /etc/ripley/presence.env (the presence installer's file)
//   3. an interactive prompt with echo turned off
//
// Safe to re-run: existing roles and channels are matched by name and left
// alone, so a crash or rate-limit hiccup just means running it again.

import { readFileSync } from 'node:fs';
import { stdin, stdout, argv, env, exit } from 'node:process';

const API = env.DISCORD_API_BASE ?? 'https://discord.com/api/v10';
let guildId = argv[2];

if (guildId && !/^\d{15,22}$/.test(guildId)) {
  console.error('Usage: node scripts/setup-community.mjs [server-id]');
  console.error('Run without an argument to pick from the servers the bot is in.');
  exit(1);
}

// ── token ─────────────────────────────────────────────────────────────────────

function tokenFromPresenceEnv() {
  try {
    const text = readFileSync('/etc/ripley/presence.env', 'utf8');
    return text.match(/^DISCORD_BOT_TOKEN=(.+)$/m)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

function promptToken() {
  return new Promise((resolve) => {
    stdout.write('Bot token (input hidden): ');
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (ch) => {
      const s = ch.toString('utf8');
      for (const c of s) {
        if (c === '\r' || c === '\n') {
          stdin.off('data', onData);
          if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
          stdin.pause();
          stdout.write('\n');
          return resolve(buf.trim());
        }
        if (c === '\u0003') exit(130); // ctrl-c
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

let token = env.DISCORD_BOT_TOKEN?.trim() || tokenFromPresenceEnv();
if (!token) token = await promptToken();
if (!token) {
  console.error('No token given.');
  exit(1);
}
if (token.split('.').length !== 3) {
  console.error('That does not look like a bot token (expected three dot-separated parts).');
  console.error('Developer Portal → your app → Bot → Reset Token. Not the client secret or application id.');
  exit(1);
}

// ── tiny 429-aware REST client ────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bot ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const wait = Number(data.retry_after ?? res.headers.get('retry-after') ?? 1);
      await sleep(Math.min(Math.max(wait * 1000, 100), 10_000));
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }
  throw new Error(`still rate limited after retries: ${method} ${path}`);
}

// ── the blueprint ─────────────────────────────────────────────────────────────
// Permission bits (BigInt — some are past 32 bits).
const VIEW = 1n << 10n;
const SEND = 1n << 11n;
const THREADS = (1n << 34n) | (1n << 35n) | (1n << 36n) | (1n << 38n); // create public/private, send in threads
const READ_ONLY = SEND | THREADS;

const ROLES = [
  { name: 'Team', color: 0xededed, hoist: true, mentionable: false },
  { name: 'Seller', color: 0x5865f2, hoist: true, mentionable: false },
  { name: 'Updates', color: 0, hoist: false, mentionable: true },
];

// category → channels. lock: 'readonly' (everyone reads, Team writes) or
// 'team' (invisible to everyone, visible to Team).
const LAYOUT = [
  { category: 'START HERE', channels: [
    { name: 'welcome', lock: 'readonly' },
    { name: 'announcements', lock: 'readonly' },
  ] },
  { category: 'SUPPORT', channels: [
    { name: 'get-help' },
    { name: 'bug-reports' },
    { name: 'feature-requests' },
  ] },
  { category: 'COMMUNITY', channels: [
    { name: 'general' },
    { name: 'store-showcase' },
    { name: 'wins' },
  ] },
  { category: 'TEAM', lock: 'team', channels: [
    { name: 'team' },
  ] },
];

const welcomeMessage = (ch) => `**Welcome to Ripley**

Ripley lets Discord server owners sell paid roles and memberships — Stripe checkout straight into your own account, roles delivered in seconds, 0% of sales.

**Start here**
- Website: <https://dues.gg>
- Set up your own store: <https://dues.gg/dashboard>
- Browse stores: <https://dues.gg/discover>

**Where things happen**
- <#${ch['get-help']}> — setup questions. We answer.
- <#${ch['bug-reports']}> — something broke? Tell us exactly what you did.
- <#${ch['feature-requests']}> — what should Ripley do next?
- <#${ch['store-showcase']}> — selling with Ripley? Drop your store link.

**Rules**
1. Be decent. No harassment, no slurs.
2. No spam, no unsolicited DMs, no advertising outside <#${ch['store-showcase']}>.
3. No scams, no "guaranteed profit" claims, no impersonation.
4. Support happens in channels, not in staff DMs.`;

// ── pick a server when none was given ─────────────────────────────────────────

if (!guildId) {
  const guilds = await call('GET', '/users/@me/guilds');
  if (!guilds.length) {
    console.error('The bot is not in any server yet — invite it first, then re-run.');
    exit(1);
  }
  if (guilds.length === 1) {
    guildId = guilds[0].id;
    console.log(`Bot is in one server: ${guilds[0].name}`);
  } else {
    console.log('The bot is in these servers:');
    guilds.forEach((g, i) => console.log(`  ${i + 1}. ${g.name}  (${g.id})`));
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question('Build the community server in which one? [number] ')).trim();
    rl.close();
    const pick = guilds[Number(answer) - 1];
    if (!pick) {
      console.error('Not a number from the list.');
      exit(1);
    }
    guildId = pick.id;
  }
}

// ── build ─────────────────────────────────────────────────────────────────────

console.log(`Checking the bot can see server ${guildId} …`);
let guild;
try {
  guild = await call('GET', `/guilds/${guildId}`);
} catch (err) {
  if (err.status === 403 || err.status === 404) {
    console.error('The bot is not in that server (or the id is wrong).');
    console.error('Invite it first — Server Settings → open your Ripley invite link with Administrator — then re-run.');
    exit(1);
  }
  if (err.status === 401) {
    console.error('Discord rejected the token (401). Reset the bot token in the Developer Portal and try again.');
    exit(1);
  }
  throw err;
}
console.log(`Found: ${guild.name}`);

const created = { roles: 0, categories: 0, channels: 0 };

// roles — match by name, create the missing ones
const existingRoles = await call('GET', `/guilds/${guildId}/roles`);
const roleId = {};
for (const want of ROLES) {
  const have = existingRoles.find((r) => r.name === want.name);
  if (have) {
    roleId[want.name] = have.id;
    console.log(`role @${want.name} — exists`);
  } else {
    const r = await call('POST', `/guilds/${guildId}/roles`, { ...want, permissions: '0' });
    roleId[want.name] = r.id;
    created.roles++;
    console.log(`role @${want.name} — created`);
    await sleep(250);
  }
}

const everyone = guildId; // @everyone's role id is the guild id
const teamId = roleId['Team'];
const overwritesFor = (lock) => {
  if (lock === 'readonly') return [
    { id: everyone, type: 0, allow: '0', deny: String(READ_ONLY) },
    { id: teamId, type: 0, allow: String(SEND), deny: '0' },
  ];
  if (lock === 'team') return [
    { id: everyone, type: 0, allow: '0', deny: String(VIEW) },
    { id: teamId, type: 0, allow: String(VIEW), deny: '0' },
  ];
  return [];
};

// channels — match by (name, parent), create the missing ones
const existingChannels = await call('GET', `/guilds/${guildId}/channels`);
const channelId = {};
const newlyCreated = new Set();
for (const group of LAYOUT) {
  let cat = existingChannels.find((c) => c.type === 4 && c.name.toLowerCase() === group.category.toLowerCase());
  if (cat) {
    console.log(`category ${group.category} — exists`);
  } else {
    cat = await call('POST', `/guilds/${guildId}/channels`, {
      name: group.category, type: 4, permission_overwrites: overwritesFor(group.lock),
    });
    created.categories++;
    console.log(`category ${group.category} — created`);
    await sleep(250);
  }
  for (const want of group.channels) {
    // type 5: a previous run may have upgraded #announcements to an
    // announcement channel — that still counts as "exists"
    const text = (c) => c.type === 0 || c.type === 5;
    let ch = existingChannels.find((c) => text(c) && c.name === want.name && c.parent_id === cat.id)
      ?? existingChannels.find((c) => text(c) && c.name === want.name);
    if (ch) {
      console.log(`  #${want.name} — exists`);
    } else {
      ch = await call('POST', `/guilds/${guildId}/channels`, {
        name: want.name, type: 0, parent_id: cat.id,
        permission_overwrites: overwritesFor(want.lock ?? group.lock),
      });
      created.channels++;
      newlyCreated.add(want.name);
      console.log(`  #${want.name} — created`);
      await sleep(250);
    }
    channelId[want.name] = ch.id;
  }
}

// welcome post — only on first build, so re-runs never double-post
if (newlyCreated.has('welcome')) {
  const msg = await call('POST', `/channels/${channelId['welcome']}/messages`, { content: welcomeMessage(channelId) });
  await call('PUT', `/channels/${channelId['welcome']}/pins/${msg.id}`).catch(() => {});
  console.log('#welcome — posted and pinned the welcome message');
}

// permanent invite — reuse one if a previous run made it
let invite = null;
try {
  const invites = await call('GET', `/channels/${channelId['welcome']}/invites`);
  invite = invites.find((i) => i.max_age === 0 && i.max_uses === 0)
    ?? await call('POST', `/channels/${channelId['welcome']}/invites`, { max_age: 0, max_uses: 0 });
} catch (err) {
  console.warn(`Could not create an invite (${err.message}) — make one by hand on #welcome.`);
}

// Community feature — best effort; Discord is picky about the prerequisites
let community = guild.features?.includes('COMMUNITY') ?? false;
if (!community) {
  try {
    await call('PATCH', `/guilds/${guildId}`, {
      features: [...new Set([...(guild.features ?? []), 'COMMUNITY'])],
      verification_level: Math.max(guild.verification_level ?? 0, 1),
      default_message_notifications: 1,
      explicit_content_filter: 2,
      rules_channel_id: channelId['welcome'],
      public_updates_channel_id: channelId['announcements'],
    });
    community = true;
    console.log('Community features — enabled (#welcome is the rules channel)');
  } catch {
    console.log('Community features — could not enable automatically; flip it on in Server Settings → Enable Community if you want it.');
  }
}
if (community) {
  // announcement channels can only exist once Community is on
  await call('PATCH', `/channels/${channelId['announcements']}`, { type: 5 }).catch(() => {});
}

console.log('');
console.log(`Done. Created ${created.roles} roles, ${created.categories} categories, ${created.channels} channels.`);
if (created.roles + created.categories + created.channels === 0) console.log('(Everything already existed — nothing was touched.)');
if (invite) console.log(`Permanent invite: https://discord.gg/${invite.code}`);
