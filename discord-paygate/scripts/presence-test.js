// Presence keeper verification against a mock Discord gateway.
//
// A real gateway needs a real bot token, so this stands up a minimal RFC6455
// server locally and proves the three behaviours that decide whether the bot
// actually stays online: it identifies with a presence, it heartbeats, it
// RESUMEs the same session after the gateway drops it, and it dies loudly on
// an auth failure instead of hammering Discord forever.
//
//   node scripts/presence-test.js

import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, HELLO: 10, ACK: 11 };

const textFrame = (s) => {
  const payload = Buffer.from(s);
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x81, n]);
  else if (n < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
};
const closeFrame = (code) => {
  const p = Buffer.alloc(2);
  p.writeUInt16BE(code, 0);
  return Buffer.concat([Buffer.from([0x88, 2]), p]);
};
// Client→server frames are always masked; unmask in place.
function readFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b1 = buf[off + 1];
    const opcode = buf[off] & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    let mask = null;
    if (masked) {
      if (buf.length - p < 4) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length - p < len) break;
    const data = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    frames.push({ opcode, payload: data });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

// A gateway that runs whatever script the scenario hands it.
function mockGateway(onConnection) {
  const server = http.createServer((_, res) => res.end('gateway'));
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const conn = {
      socket,
      send: (op, d, extra = {}) => socket.write(textFrame(JSON.stringify({ op, d, ...extra }))),
      close: (code) => socket.write(closeFrame(code)),
      onMessage: () => {},
    };
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = readFrames(buf);
      buf = rest;
      for (const f of frames) {
        if (f.opcode === 0x8) return socket.end();
        if (f.opcode !== 0x1) continue;
        try {
          conn.onMessage(JSON.parse(f.payload.toString()));
        } catch {
          /* ignore */
        }
      }
    });
    socket.on('error', () => {});
    onConnection(conn);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const startClient = (port, env = {}) =>
  spawn(process.execPath, ['scripts/presence.js'], {
    env: {
      ...process.env,
      DISCORD_BOT_TOKEN: 'test-token',
      GATEWAY_URL: `ws://127.0.0.1:${port}/?v=10&encoding=json`,
      PRESENCE_TEXT: 'dues.gg',
      PORT: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const waitFor = (fn, what, ms = 8000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 25);
    };
    tick();
  });

let failures = 0;
const check = (name, fn) =>
  fn().then(
    () => console.log(`  ✓ ${name}`),
    (err) => {
      failures += 1;
      console.error(`  ✗ ${name}\n    ${err.message}`);
    },
  );

console.log('presence keeper:');

// 1 + 2: identify with a presence, heartbeat, then resume the same session
// after the gateway sends op 7.
await check('identifies with presence, heartbeats, and resumes after a drop', async () => {
  const seen = { identify: null, resume: null, heartbeats: 0, connections: 0 };
  const { server, port } = await mockGateway((conn) => {
    seen.connections += 1;
    const first = seen.connections === 1;
    conn.onMessage = (msg) => {
      if (msg.op === OP.IDENTIFY) {
        seen.identify = msg.d;
        conn.send(OP.DISPATCH, { user: { username: 'ripley' }, session_id: 'sess-1', resume_gateway_url: `ws://127.0.0.1:${port}` }, { s: 1, t: 'READY' });
        // Drop the connection the way Discord does during a deploy.
        setTimeout(() => conn.send(OP.RECONNECT, null), 250);
      } else if (msg.op === OP.RESUME) {
        seen.resume = msg.d;
        conn.send(OP.DISPATCH, {}, { s: 2, t: 'RESUMED' });
      } else if (msg.op === OP.HEARTBEAT) {
        seen.heartbeats += 1;
        conn.send(OP.ACK, null);
      }
    };
    conn.send(OP.HELLO, { heartbeat_interval: 120 });
  });
  const child = startClient(port);
  try {
    await waitFor(() => seen.identify, 'IDENTIFY');
    assert.equal(seen.identify.token, 'test-token');
    assert.equal(seen.identify.intents, 0, 'presence-only bots need no intents');
    assert.equal(seen.identify.presence.status, 'online');
    assert.equal(seen.identify.presence.activities[0].name, 'dues.gg');
    await waitFor(() => seen.resume, 'RESUME after the gateway dropped us');
    assert.equal(seen.resume.session_id, 'sess-1', 'resumes the same session');
    assert.ok(seen.resume.seq >= 1, 'resumes from the last sequence number');
    await waitFor(() => seen.heartbeats >= 2, 'repeated heartbeats');
  } finally {
    child.kill();
    server.close();
  }
});

// 3: a bad token must stop the process, not spin forever against Discord.
await check('exits on an auth failure instead of reconnecting forever', async () => {
  let attempts = 0;
  const { server, port } = await mockGateway((conn) => {
    attempts += 1;
    conn.send(OP.HELLO, { heartbeat_interval: 500 });
    conn.onMessage = () => conn.close(4004); // authentication failed
  });
  const child = startClient(port);
  const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
  server.close();
  assert.equal(code, 1, 'exits non-zero so the host surfaces the misconfiguration');
  assert.equal(attempts, 1, 'does not retry a fatal close');
});

// 3: welcome cards — the join card path end to end, against a mock gateway
// AND a mock Discord REST API. Proves the privileged intent is requested only
// when the feature is on, and that a join produces a real PNG upload.
await check('posts a welcome card on join, and only then asks for the members intent', async () => {
  const posted = [];
  const rest = http.createServer((req, res) => {
    if (req.method === 'POST' && /\/channels\/9001\/messages$/.test(req.url)) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        posted.push({ body: Buffer.concat(chunks), type: req.headers['content-type'] ?? '' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: '1' }));
      });
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => rest.listen(0, '127.0.0.1', r));
  const restPort = rest.address().port;

  const seen = { identify: null };
  let live = null;
  const { server, port } = await mockGateway((conn) => {
    live = conn;
    conn.onMessage = (msg) => {
      if (msg.op === OP.IDENTIFY) {
        seen.identify = msg.d;
        conn.send(OP.DISPATCH, { user: { username: 'dues' }, session_id: 'sess-w', resume_gateway_url: `ws://127.0.0.1:${port}` }, { s: 1, t: 'READY' });
      } else if (msg.op === OP.HEARTBEAT) {
        conn.send(OP.ACK, null);
      }
    };
    conn.send(OP.HELLO, { heartbeat_interval: 45000 });
  });

  const child = startClient(port, {
    WELCOME_CHANNEL_ID: '9001',
    WELCOME_GUILD_ID: '4242',
    DISCORD_API_BASE: `http://127.0.0.1:${restPort}`,
  });
  try {
    await waitFor(() => seen.identify, 'IDENTIFY');
    assert.equal(seen.identify.intents, 2, 'welcome mode must request the GUILD_MEMBERS privileged intent');

    // The guild first (that is where the member count comes from), then a join.
    live.send(OP.DISPATCH, { id: '4242', name: 'Dues HQ', member_count: 180 }, { s: 2, t: 'GUILD_CREATE' });
    live.send(
      OP.DISPATCH,
      { guild_id: '4242', user: { id: '515500000000000015', username: 'newbie', global_name: 'Newbie', avatar: null } },
      { s: 3, t: 'GUILD_MEMBER_ADD' },
    );

    await waitFor(() => posted.length, 'the welcome card POST', 30000);
    const sent = posted[0];
    assert.match(sent.type, /multipart\/form-data/, 'the card must be uploaded as a real attachment');
    const text = sent.body.toString('latin1');
    assert.ok(text.includes('welcome.png'), 'the attachment is named welcome.png');
    assert.ok(text.includes('PNG'), 'the attachment body is actually a PNG');
    assert.ok(text.includes('<@515500000000000015>'), 'the message mentions the new member');
    assert.ok(text.includes('Dues HQ'), '{server} resolves to the guild name');
    assert.ok(text.includes('"users":["515500000000000015"]'), 'allowed_mentions is pinned to the joiner');
  } finally {
    child.kill('SIGKILL');
    server.close();
    rest.close();
  }
});

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll presence checks green.');
process.exit(failures ? 1 : 0);
