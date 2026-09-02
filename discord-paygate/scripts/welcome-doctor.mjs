#!/usr/bin/env node
// Why the welcome card is not posting.
//
//   npm run doctor:welcome            # check every precondition, print a verdict
//   npm run doctor:welcome -- --post  # ...and post one real test card
//
// The worker that posts welcome cards holds a gateway WebSocket, and when it
// fails it fails somewhere you cannot see: the socket is refused, or the POST
// is refused, and the only evidence is a line in a log on Railway. This script
// checks the same preconditions over plain REST — no socket, no intents, no
// deploy — and says which one is false and exactly how to fix it.
//
// It needs three things in the environment, the same three the worker needs:
//
//   DISCORD_BOT_TOKEN    the bot token (also read from /etc/ripley/presence.env,
//                        or prompted for with echo off — never printed, ever)
//   WELCOME_GUILD_ID     the one server cards are allowed to fire in
//   WELCOME_CHANNEL_ID   the channel in it to post them to
//
// Exits non-zero if anything is wrong, so it can gate a deploy.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stdin, stdout, argv, env, exit } from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const API = (env.DISCORD_API_BASE ?? 'https://discord.com/api/v10').replace(/\/$/, '');

// ── the arithmetic, kept pure so the suite can hold it ─────────────────────────

// Permission bits are past 32, so all of this is BigInt.
export const ADMINISTRATOR = 1n << 3n;
export const NEEDED = {
  'View Channel': 1n << 10n,
  'Send Messages': 1n << 11n,
  'Embed Links': 1n << 14n,
  'Attach Files': 1n << 15n,
};

// Discord's documented order, and it matters: @everyone's channel overwrite is
// applied before role overwrites, all role allows are unioned before any of
// them is subtracted, and the member-specific overwrite wins over everything.
// Getting this wrong is how a doctor tells you a channel is fine when the bot
// cannot type in it.
export function computePermissions({ guildId, botId, ownerId, roles, memberRoleIds, overwrites = [] }) {
  if (ownerId && botId === ownerId) return ~0n; // the owner is never denied anything
  const byId = new Map(roles.map((r) => [r.id, BigInt(r.permissions ?? 0)]));
  let perms = byId.get(guildId) ?? 0n; // @everyone's role id IS the guild id
  for (const id of memberRoleIds) perms |= byId.get(id) ?? 0n;
  if (perms & ADMINISTRATOR) return ~0n; // Administrator ignores every overwrite

  const everyone = overwrites.find((o) => o.id === guildId);
  if (everyone) {
    perms &= ~BigInt(everyone.deny ?? 0);
    perms |= BigInt(everyone.allow ?? 0);
  }
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.id === guildId || !memberRoleIds.includes(o.id)) continue;
    allow |= BigInt(o.allow ?? 0);
    deny |= BigInt(o.deny ?? 0);
  }
  perms &= ~deny;
  perms |= allow;

  const mine = overwrites.find((o) => o.id === botId && String(o.type) === '1');
  if (mine) {
    perms &= ~BigInt(mine.deny ?? 0);
    perms |= BigInt(mine.allow ?? 0);
  }
  return perms;
}

// A channel the bot cannot see is a channel it cannot post in, whatever the
// other bits say, so View Channel leads the list.
export function missingPermissions(perms) {
  return Object.entries(NEEDED)
    .filter(([, bit]) => (perms & bit) === 0n)
    .map(([name]) => name);
}

// Application flags. GATEWAY_GUILD_MEMBERS is the bit an app gets once it is
// verified and approved for the intent; GATEWAY_GUILD_MEMBERS_LIMITED is the
// same toggle on an app still under 100 servers. Either one means the switch
// in the portal is ON, and neither means the gateway will close the worker
// with 4014 the moment welcome cards are enabled.
export const GATEWAY_GUILD_MEMBERS = 1n << 14n;
export const GATEWAY_GUILD_MEMBERS_LIMITED = 1n << 15n;
export function membersIntentEnabled(flags) {
  const f = BigInt(flags ?? 0);
  return Boolean(f & (GATEWAY_GUILD_MEMBERS | GATEWAY_GUILD_MEMBERS_LIMITED));
}

// Text and announcement channels take a message with an attachment. Anything
// else is somebody having copied the wrong id out of Discord.
export const CHANNEL_KIND = {
  0: 'a text channel',
  1: 'a DM',
  2: 'a voice channel',
  3: 'a group DM',
  4: 'a category',
  5: 'an announcement channel',
  10: 'a thread',
  11: 'a thread',
  12: 'a private thread',
  13: 'a stage channel',
  14: 'a directory',
  15: 'a forum',
  16: 'a media channel',
};
export const POSTABLE_CHANNEL_TYPES = [0, 5];

// One verdict line plus its fix, indented under it. Pure, so the suite can
// assert that a failure always carries an instruction and never the token.
export function verdictLines({ n, status, title, detail, fix }) {
  const out = [`${String(n).padStart(2)}. ${status.padEnd(4)}  ${title}${detail ? ` — ${detail}` : ''}`];
  if (fix) for (const line of String(fix).split('\n')) out.push(`         ${line}`);
  return out;
}

// ── the checks ────────────────────────────────────────────────────────────────

const POST = argv.includes('--post');
const results = [];
let printed = 0;
function record(status, title, detail, fix) {
  results.push({ status, title });
  for (const line of verdictLines({ n: ++printed, status, title, detail, fix })) console.log(line);
}
const pass = (title, detail) => record('ok', title, detail, null);
const fail = (title, detail, fix) => record('FAIL', title, detail, fix);
const skip = (title, detail) => record('skip', title, detail, null);

function tokenFromPresenceEnv() {
  try {
    const text = readFileSync('/etc/ripley/presence.env', 'utf8');
    return text.match(/^DISCORD_BOT_TOKEN=(.+)$/m)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

// Same hidden prompt as setup-community.mjs: the token never reaches the
// terminal, the shell history, or this script's output.
function promptToken() {
  return new Promise((resolve) => {
    stdout.write('Bot token (input hidden): ');
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (ch) => {
      for (const c of ch.toString('utf8')) {
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

async function main() {
  console.log('Dues welcome-card doctor — REST only, no gateway socket, nothing is changed.');
  console.log('');

  let token = env.DISCORD_BOT_TOKEN?.trim() || tokenFromPresenceEnv();
  if (!token && stdin.isTTY) token = await promptToken();

  const call = async (path) => {
    const res = await fetch(`${API}${path}`, {
      headers: { authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body, text: text.slice(0, 300) };
  };

  const guildId = (env.WELCOME_GUILD_ID ?? '').trim();
  const channelId = (env.WELCOME_CHANNEL_ID ?? '').trim();

  // 1 ── the two ids
  const idsOk = /^\d{15,22}$/.test(guildId) && /^\d{15,22}$/.test(channelId);
  if (idsOk) {
    pass('The two ids are set', `guild ${guildId}, channel ${channelId}`);
  } else {
    fail(
      'The two ids are set',
      `WELCOME_GUILD_ID=${guildId || '(unset)'} WELCOME_CHANNEL_ID=${channelId || '(unset)'}`,
      'fix  In Discord: User Settings → Advanced → Developer Mode ON. Right-click the server\n' +
        '     → Copy Server ID, right-click the welcome channel → Copy Channel ID. Set both on\n' +
        '     the worker (Railway → Variables, Fly → fly secrets set) and redeploy.\n' +
        '     With WELCOME_CHANNEL_ID unset the worker deliberately posts nothing at all.',
    );
  }

  // 2 ── the token
  let bot = null;
  if (!token) {
    fail(
      'Bot token is valid',
      'no token in DISCORD_BOT_TOKEN, /etc/ripley/presence.env, or the prompt',
      'fix  DISCORD_BOT_TOKEN=... npm run doctor:welcome  (Developer Portal → Bot → Reset Token)',
    );
  } else if (token.split('.').length !== 3) {
    fail(
      'Bot token is valid',
      'that is not the shape of a bot token (expected three dot-separated parts)',
      'fix  You have pasted the client secret or the application id. The bot token is under\n' +
        '     Developer Portal → your app → Bot → Reset Token.',
    );
  } else {
    const me = await call('/users/@me');
    if (me.status === 200) {
      bot = me.body;
      pass('Bot token is valid', `authenticated as ${bot.username} (id ${bot.id})`);
    } else {
      fail(
        'Bot token is valid',
        `GET /users/@me returned ${me.status}`,
        'fix  The token is wrong or has been reset. Developer Portal → your app → Bot →\n' +
          '     Reset Token, then set DISCORD_BOT_TOKEN on the worker AND on Vercel — role\n' +
          '     delivery uses the same token.',
      );
    }
  }

  // 3 ── the privileged intent. This is the one that kills the worker silently.
  const INTENT_FIX =
    'fix  Discord Developer Portal → Applications → your app → Bot → Privileged Gateway\n' +
    '     Intents → turn ON "SERVER MEMBERS INTENT" → Save Changes → restart the worker.\n' +
    '     Without it Discord closes the gateway connection with code 4014 the instant the\n' +
    '     worker asks for member events, so the bot never even gets to see a join. It is\n' +
    '     the single most common reason welcome cards go quiet. (PRESENCE INTENT and\n' +
    '     MESSAGE CONTENT INTENT are not needed and should stay off.)';
  if (!bot) {
    skip('Server Members intent is enabled', 'not checked — no valid token');
  } else {
    const app = await call('/applications/@me');
    if (app.status !== 200) {
      fail('Server Members intent is enabled', `GET /applications/@me returned ${app.status}`, INTENT_FIX);
    } else if (membersIntentEnabled(app.body?.flags)) {
      pass('Server Members intent is enabled', `application "${app.body?.name ?? bot.username}" has the intent bit set`);
    } else {
      fail('Server Members intent is enabled', 'the intent is OFF for this application', INTENT_FIX);
    }
  }

  // 4 ── the bot is actually in that server
  let guild = null;
  if (!bot || !idsOk) {
    skip('Bot is a member of WELCOME_GUILD_ID', 'not checked');
  } else {
    const g = await call(`/guilds/${guildId}?with_counts=true`);
    if (g.status === 200) {
      guild = g.body;
      pass('Bot is a member of WELCOME_GUILD_ID', `"${guild.name}", ${guild.approximate_member_count ?? '?'} members`);
    } else if (g.status === 403 || g.status === 404) {
      fail(
        'Bot is a member of WELCOME_GUILD_ID',
        `the bot cannot see guild ${guildId} (${g.status})`,
        'fix  Either the id is wrong, or the bot was never invited to that server (or was\n' +
          '     kicked). Invite it from Developer Portal → OAuth2 → URL Generator → scopes\n' +
          '     "bot" → permissions View Channels, Send Messages, Embed Links, Attach Files.',
      );
    } else {
      fail('Bot is a member of WELCOME_GUILD_ID', `GET /guilds/${guildId} returned ${g.status}`, `fix  ${g.text}`);
    }
  }

  // 5 ── the channel exists, is postable, and is in that server
  let channel = null;
  if (!guild) {
    skip('WELCOME_CHANNEL_ID is a text channel in that server', 'not checked');
  } else {
    const c = await call(`/channels/${channelId}`);
    if (c.status !== 200) {
      fail(
        'WELCOME_CHANNEL_ID is a text channel in that server',
        `the bot cannot see channel ${channelId} (${c.status})`,
        'fix  The channel was deleted, the id is wrong, or the bot has no View Channel there\n' +
          '     (a private channel it is not permitted into looks identical to a deleted one).\n' +
          '     Right-click the channel → Copy Channel ID and compare.',
      );
    } else if (c.body.guild_id !== guildId) {
      fail(
        'WELCOME_CHANNEL_ID is a text channel in that server',
        `#${c.body.name} lives in guild ${c.body.guild_id}, not ${guildId}`,
        'fix  The two ids must belong together: WELCOME_GUILD_ID is the server, and\n' +
          '     WELCOME_CHANNEL_ID a channel inside it. A join in the pinned server is the\n' +
          '     only thing that triggers a card, so a channel elsewhere is never written to.',
      );
    } else if (!POSTABLE_CHANNEL_TYPES.includes(c.body.type)) {
      fail(
        'WELCOME_CHANNEL_ID is a text channel in that server',
        `${channelId} is ${CHANNEL_KIND[c.body.type] ?? `type ${c.body.type}`}, not a text channel`,
        'fix  Right-clicking a category or a voice channel copies its id just as happily as\n' +
          '     a text channel\'s. Copy the id of the text channel the card should appear in.',
      );
    } else {
      channel = c.body;
      pass('WELCOME_CHANNEL_ID is a text channel in that server', `#${channel.name}`);
    }
  }

  // 6 ── computed permissions in that channel, from the overwrites and roles
  let canPost = false;
  if (!channel) {
    skip('Bot can post a card in that channel', 'not checked');
  } else {
    const [roles, member] = await Promise.all([
      call(`/guilds/${guildId}/roles`),
      call(`/guilds/${guildId}/members/${bot.id}`),
    ]);
    if (roles.status !== 200 || member.status !== 200) {
      fail(
        'Bot can post a card in that channel',
        `could not read roles (${roles.status}) or the bot's membership (${member.status})`,
        'fix  Re-invite the bot with the "bot" scope so it has a member record in the server.',
      );
    } else {
      const perms = computePermissions({
        guildId,
        botId: bot.id,
        ownerId: guild.owner_id,
        roles: roles.body,
        memberRoleIds: member.body.roles ?? [],
        overwrites: channel.permission_overwrites ?? [],
      });
      const missing = missingPermissions(perms);
      if (missing.length === 0) {
        canPost = true;
        pass('Bot can post a card in that channel', 'View Channel, Send Messages, Embed Links and Attach Files all granted');
      } else {
        fail(
          'Bot can post a card in that channel',
          `missing in #${channel.name}: ${missing.join(', ')}`,
          `fix  Server Settings → Channels → #${channel.name} → Permissions → add the bot (or a\n` +
            '     role it holds) and allow the missing ones. Attach Files is the one people\n' +
            '     forget: without it the card is refused with 403 and only the text would post,\n' +
            '     which is why the worker sends nothing at all rather than half a welcome.',
        );
      }
    }
  }

  // 7 ── the card renders here. Catches the other silent killer: a worker image
  //      built without sharp, where every join throws before it reaches Discord.
  let png = null;
  try {
    const { renderWelcomeCard } = await import('../src/lib/welcome-card.js');
    png = await renderWelcomeCard({
      username: bot?.username ?? 'Dues',
      memberNumber: guild?.approximate_member_count ?? null,
      theme: env.WELCOME_THEME === 'light' ? 'light' : 'dark',
    });
    const fonts = await brandFonts();
    pass(
      'The card renders here',
      `${Math.round(png.length / 1024)} KB PNG${fonts ? '' : ' — but the brand fonts are NOT installed, so it is in a fallback face'}`,
    );
    if (!fonts) {
      console.log('         note  copy assets/fonts/*.ttf into /usr/share/fonts/dues/ and run fc-cache -f');
      console.log('               (Dockerfile.presence already does this; a bare VM does not)');
    }
  } catch (err) {
    fail(
      'The card renders here',
      err.message,
      'fix  The renderer needs sharp. If this says "Cannot find package \'sharp\'", the worker\n' +
        '     image was built without it — sharp must stay in "dependencies" in package.json,\n' +
        '     because Dockerfile.presence installs with --omit=dev. Rebuild and redeploy the\n' +
        '     worker after that. Locally: npm install.',
    );
  }

  // 8 ── the real thing, end to end
  if (!POST) {
    if (results.every((r) => r.status === 'ok')) {
      console.log('');
      console.log('     (add --post to send one real test card to that channel and see it land)');
    }
  } else if (!png || !canPost) {
    skip('Test card posted', 'not attempted — fix the failures above first');
  } else {
    const form = new FormData();
    form.append(
      'payload_json',
      JSON.stringify({
        content: 'Welcome-card test from `npm run doctor:welcome` — this is what a join looks like.',
        allowed_mentions: { parse: [] },
        attachments: [{ id: 0, filename: 'welcome.png' }],
      }),
    );
    form.append('files[0]', new Blob([png], { type: 'image/png' }), 'welcome.png');
    const res = await fetch(`${API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bot ${token}` },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const msg = await res.json().catch(() => ({}));
      pass('Test card posted', `message ${msg.id ?? ''} in #${channel.name} — go and look at it`);
    } else {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      fail(
        'Test card posted',
        `POST returned ${res.status} ${detail}`,
        'fix  A 403 here with everything above green means a channel overwrite this script\n' +
          '     could not see (a member-level deny on the bot itself). Open the channel\'s\n' +
          '     permissions and look at the bot directly.',
      );
    }
  }

  const bad = results.filter((r) => r.status !== 'ok');
  console.log('');
  if (bad.length === 0) {
    console.log(`All ${results.length} checks pass. If cards still do not appear, the worker is not running:`);
    console.log('a welcome card needs a process holding a gateway socket, which Vercel cannot do.');
    console.log('Check the Railway/Fly logs for "online as" and for "welcome card failed".');
  } else {
    console.log(`${bad.length} of ${results.length} checks did not pass: ${bad.map((r) => r.title).join('; ')}.`);
  }
  exit(bad.length ? 1 : 0);
}

async function brandFonts() {
  try {
    const { stdout: out } = await promisify(execFile)('fc-list', [':', 'family']);
    return out.includes('Dues Grotesk') && out.includes('Dues Sans');
  } catch {
    return false;
  }
}

// Importable for the suite: the pure helpers above are the interesting part,
// and running the whole doctor to test them would need a live Discord.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  await main().catch((err) => {
    console.error(`doctor failed: ${err.message}`);
    exit(1);
  });
}
