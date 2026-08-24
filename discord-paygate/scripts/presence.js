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

if (!TOKEN) {
  console.error('[presence] DISCORD_BOT_TOKEN is required');
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
              intents: 0, // presence only: no events, no privileged intents
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
        bail(`gateway closed with ${code} — check DISCORD_BOT_TOKEN and its intents`, { fatal: true });
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
