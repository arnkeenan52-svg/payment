// Discord gateway presence keeper.
//
// WHY THIS EXISTS: Ripley's product runs on Vercel functions — REST calls for
// role grants, webhooks for payments. That is enough to *work*, but Discord
// only paints a bot "Online" while it holds an open gateway WebSocket, and a
// serverless function cannot hold one. This tiny always-on process does
// nothing but keep that socket alive so the bot reads Online in every server.
//
// It handles no events and needs no privileged intents (identify sends
// intents: 0). Run it anywhere that stays up: Railway, Fly.io, Render
// background worker, a VPS, a Raspberry Pi. One instance only — a second
// instance on the same token fights the first for the session.
//
//   DISCORD_BOT_TOKEN=...  node scripts/presence.js
//
// Optional env:
//   PRESENCE_TEXT    activity text            (default "dues.gg")
//   PRESENCE_TYPE    0 playing 2 listening 3 watching 5 competing (default 3)
//   PRESENCE_STATUS  online | idle | dnd      (default "online")
//   PORT             if set, serves GET / with a JSON health snapshot
//   GATEWAY_URL      override (tests point this at a mock gateway)

const TOKEN = process.env.DISCORD_BOT_TOKEN ?? '';
const TEXT = process.env.PRESENCE_TEXT ?? 'dues.gg';
const TYPE = Number(process.env.PRESENCE_TYPE ?? 3);
const STATUS = process.env.PRESENCE_STATUS ?? 'online';
const API = (process.env.DISCORD_API_BASE ?? 'https://discord.com/api/v10').replace(/\/$/, '');

// ── optional: welcome cards ───────────────────────────────────────────────────
// Set WELCOME_CHANNEL_ID to post a branded join card when someone joins.
// This is what turns the process from "presence only" into a real (tiny) bot:
// it needs the GUILD_MEMBERS *privileged* intent, which must be switched on at
// Discord Developer Portal -> your app -> Bot -> Privileged Gateway Intents.
// Without it Discord refuses the connection outright with close code 4014.
// Leave WELCOME_CHANNEL_ID unset and none of this runs — intents stay 0.
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID ?? '';
// REQUIRED when cards are on. The Dues bot is multi-tenant — it sits in every
// seller's server — and welcome cards are a Dues-community thing, not a
// product feature every tenant gets. Pinning the guild means a join in a
// seller's server can never trigger a Dues-branded card.
const WELCOME_GUILD_ID = process.env.WELCOME_GUILD_ID ?? '';
const WELCOME_THEME = process.env.WELCOME_THEME === 'light' ? 'light' : 'dark';
const WELCOME_TEXT = process.env.WELCOME_TEXT ?? 'Hey {mention}, welcome to {server}!';
const WELCOME = Boolean(WELCOME_CHANNEL_ID);
const INTENT_GUILD_MEMBERS = 1 << 1;

if (!TOKEN) {
  console.error('[presence] DISCORD_BOT_TOKEN is required');
  process.exit(1);
}

// Refusing to start beats silently posting cards for every server the bot is
// in: this bot is in other people's servers, and their joins are not ours to
// announce.
if (WELCOME_CHANNEL_ID && !WELCOME_GUILD_ID) {
  console.error(
    '[presence] WELCOME_CHANNEL_ID is set but WELCOME_GUILD_ID is not. Welcome cards are ' +
      'scoped to ONE server (the Dues community); set WELCOME_GUILD_ID to that server id, ' +
      'or unset WELCOME_CHANNEL_ID to run presence only.',
  );
  process.exit(1);
}

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, PRESENCE: 3, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, ACK: 11 };
// Close codes Discord will never accept a retry for: fix the config instead of
// hammering the gateway.
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

const state = {
  since: Date.now(),
  connectedAt: null,
  ready: false,
  user: null,
  sessionId: null,
  resumeUrl: null,
  seq: null,
  attempts: 0,
  reconnects: 0,
  lastError: null,
  // guildId -> {name, count}. Seeded from GUILD_CREATE, incremented on each
  // join so the card can say "Member #N" without an extra REST call.
  guilds: new Map(),
  cardsPosted: 0,
};

const log = (...a) => console.log(`[presence] ${new Date().toISOString()}`, ...a);
const presencePayload = () => ({
  since: null,
  activities: TEXT ? [{ name: TEXT, type: TYPE }] : [],
  status: STATUS,
  afk: false,
});

// Ask the API where to connect; fall back to the documented default so a
// blip in that one endpoint never keeps us offline.
async function gatewayUrl() {
  if (process.env.GATEWAY_URL) return process.env.GATEWAY_URL;
  try {
    const res = await fetch(`${API}/gateway/bot`, { headers: { authorization: `Bot ${TOKEN}` } });
    if (res.ok) {
      const body = await res.json();
      if (body?.url) return `${body.url}/?v=10&encoding=json`;
    }
    log(`gateway lookup failed (${res.status}), using default host`);
  } catch (err) {
    log('gateway lookup threw, using default host:', err.message);
  }
  return 'wss://gateway.discord.gg/?v=10&encoding=json';
}

// Full jitter backoff, capped — a long outage must not turn into a hot loop.
const backoffMs = (attempt) => Math.round(Math.random() * Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));

// ── welcome cards ─────────────────────────────────────────────────────────────
// Renders the join card and posts it as a real attachment. Imported lazily so
// the presence-only path keeps its zero-dependency promise: a deployment that
// never sets WELCOME_CHANNEL_ID never loads sharp.
async function postWelcome(member, guild) {
  const user = member?.user;
  if (!user?.id) return;
  if (user.bot) return; // other bots joining is not a moment worth announcing

  const { renderWelcomeCard } = await import('../src/lib/welcome-card.js');

  // Discord's CDN serves the avatar; a user with none gets the default set,
  // picked by the modern (id >> 22) % 6 rule rather than the legacy
  // discriminator, which is "0" for every migrated account.
  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256`
    : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`;

  let avatarPng = null;
  try {
    const res = await fetch(avatarUrl, { signal: AbortSignal.timeout(8000) });
    if (res.ok) avatarPng = Buffer.from(await res.arrayBuffer());
  } catch {
    // A missing avatar is not a reason to skip the card — it renders without.
  }

  const png = await renderWelcomeCard({
    username: user.global_name || user.username,
    avatarPng,
    memberNumber: guild?.count || null,
    theme: WELCOME_THEME,
  });

  const content = WELCOME_TEXT.replace('{mention}', `<@${user.id}>`)
    .replace('{server}', guild?.name ?? 'the server')
    .replace('{user}', user.global_name || user.username)
    .slice(0, 1800);

  const form = new FormData();
  form.append(
    'payload_json',
    JSON.stringify({
      content,
      allowed_mentions: { users: [user.id] }, // never let {server} smuggle an @everyone
      attachments: [{ id: 0, filename: 'welcome.png' }],
    }),
  );
  form.append('files[0]', new Blob([png], { type: 'image/png' }), 'welcome.png');

  const res = await fetch(`${API}/channels/${WELCOME_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: { authorization: `Bot ${TOKEN}` },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`POST message ${res.status} ${detail.slice(0, 200)}`);
  }
  state.cardsPosted += 1;
  log(`welcome card posted for ${user.username}${guild?.count ? ` (#${guild.count})` : ''}`);
}

function connect() {
  let ws;
  let hbTimer = null;
  let acked = true;
  let closed = false;

  const cleanup = () => {
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = null;
  };

  const bail = (why, { fatal = false, resumable = true } = {}) => {
    if (closed) return;
    closed = true;
    cleanup();
    state.ready = false;
    state.lastError = why;
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
    if (fatal) {
      console.error(`[presence] fatal: ${why}`);
      process.exit(1);
    }
    if (!resumable) {
      state.sessionId = null;
      state.resumeUrl = null;
      state.seq = null;
    }
    const wait = backoffMs(state.attempts++);
    state.reconnects += 1;
    log(`${why} — reconnecting in ${wait}ms`);
    setTimeout(() => connect().catch((err) => log('reconnect failed:', err.message)), wait);
  };

  const send = (op, d) => {
    try {
      ws.send(JSON.stringify({ op, d }));
    } catch (err) {
      bail(`send failed: ${err.message}`);
    }
  };

  return (async () => {
    // Resume against the URL Discord handed us with READY; otherwise ask.
    const url = state.sessionId && state.resumeUrl ? `${state.resumeUrl}/?v=10&encoding=json` : await gatewayUrl();
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      state.connectedAt = Date.now();
      log(`socket open (${state.sessionId ? 'resuming' : 'new session'})`);
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return; // a frame we cannot parse is a frame we ignore
      }
      if (msg.s !== null && msg.s !== undefined) state.seq = msg.s;

      switch (msg.op) {
        case OP.HELLO: {
          const interval = msg.d?.heartbeat_interval ?? 41_250;
          acked = true;
          // First beat is jittered per the docs so shards do not sync up.
          setTimeout(() => {
            if (closed) return;
            send(OP.HEARTBEAT, state.seq);
            hbTimer = setInterval(() => {
              if (!acked) {
                // Zombie connection: the socket looks open but Discord stopped
                // answering. Drop it and resume rather than sit there "online"
                // to nobody.
                bail('heartbeat not acknowledged (zombie connection)');
                return;
              }
              acked = false;
              send(OP.HEARTBEAT, state.seq);
            }, interval);
          }, Math.floor(Math.random() * interval));

          if (state.sessionId) {
            send(OP.RESUME, { token: TOKEN, session_id: state.sessionId, seq: state.seq });
          } else {
            send(OP.IDENTIFY, {
              token: TOKEN,
              intents: WELCOME ? INTENT_GUILD_MEMBERS : 0,
              properties: { os: process.platform, browser: 'ripley-presence', device: 'ripley-presence' },
              presence: presencePayload(),
            });
          }
          return;
        }
        case OP.ACK:
          acked = true;
          return;
        case OP.HEARTBEAT:
          send(OP.HEARTBEAT, state.seq);
          return;
        case OP.RECONNECT:
          bail('gateway asked us to reconnect');
          return;
        case OP.INVALID_SESSION:
          // d === true means the session can still be resumed.
          bail('session invalidated', { resumable: msg.d === true });
          return;
        case OP.DISPATCH:
          if (msg.t === 'READY') {
            state.ready = true;
            state.attempts = 0;
            state.user = msg.d?.user?.username ? `${msg.d.user.username}` : null;
            state.sessionId = msg.d?.session_id ?? null;
            state.resumeUrl = msg.d?.resume_gateway_url ?? null;
            log(`online as ${state.user ?? 'bot'} — ${STATUS}${TEXT ? `, "${TEXT}"` : ''}`);
          } else if (msg.t === 'RESUMED') {
            state.ready = true;
            state.attempts = 0;
            log('session resumed');
          } else if (msg.t === 'GUILD_CREATE' && WELCOME) {
            // Sent for every guild on connect, and again if the bot is added.
            state.guilds.set(msg.d.id, { name: msg.d.name, count: Number(msg.d.member_count ?? 0) });
          } else if (msg.t === 'GUILD_MEMBER_ADD' && WELCOME) {
            const g = msg.d?.guild_id;
            if (g === WELCOME_GUILD_ID) {
              const entry = state.guilds.get(g);
              if (entry) entry.count += 1;
              // Never await inside the socket handler: a slow render or a
              // rate-limited POST must not stall heartbeats.
              postWelcome(msg.d, entry).catch((err) => log('welcome card failed:', err.message));
            }
          }
          return;
        default:
          return;
      }
    });

    ws.addEventListener('error', (ev) => {
      log('socket error:', ev?.message ?? 'unknown');
    });

    ws.addEventListener('close', (ev) => {
      const code = ev?.code ?? 0;
      if (FATAL.has(code)) {
        const why =
          code === 4014
            ? 'gateway closed with 4014 — WELCOME_CHANNEL_ID is set, so this bot needs the ' +
              'SERVER MEMBERS INTENT: Discord Developer Portal -> your app -> Bot -> ' +
              'Privileged Gateway Intents -> enable "Server Members Intent" -> Save.'
            : `gateway closed with ${code} — check DISCORD_BOT_TOKEN and its intents`;
        bail(why, { fatal: true });
        return;
      }
      // 4007/4009 mean the resume was refused: start clean.
      bail(`socket closed (${code})`, { resumable: code !== 4007 && code !== 4009 });
    });
  })();
}

// Optional health endpoint: hosts like Render want a port to bind, and it is
// a cheap way to see whether presence is actually up.
if (process.env.PORT) {
  const http = await import('node:http');
  http
    .createServer((req, res) => {
      const body = {
        ok: state.ready,
        status: state.ready ? STATUS : 'connecting',
        bot: state.user,
        uptimeSeconds: Math.round((Date.now() - state.since) / 1000),
        connectedSeconds: state.connectedAt ? Math.round((Date.now() - state.connectedAt) / 1000) : 0,
        reconnects: state.reconnects,
        welcomeCards: WELCOME ? state.cardsPosted : 'disabled',
        lastError: state.lastError,
      };
      res.writeHead(state.ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body, null, 1));
    })
    .listen(Number(process.env.PORT), () => log(`health endpoint on :${process.env.PORT}`));
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig} — going offline`);
    process.exit(0);
  });
}

log('starting…');
connect().catch((err) => {
  console.error('[presence] could not start:', err.message);
  process.exit(1);
});
