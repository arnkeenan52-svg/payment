// Verification for the #rules poster.
//
// The whole point of scripts/post-rules.mjs is that it can be run repeatedly
// without stacking duplicate rules posts in the channel — and that is exactly
// the property you cannot check by eye without first polluting a real Discord
// channel with the thing you were trying to avoid. So it is checked here,
// against a mock Discord REST API, before it is ever pointed at production.
//
//   node scripts/rules-test.js

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'post-rules.mjs');
const BOT_ID = '900000000000000001';

// A mock of the four Discord endpoints the script touches. Messages live in an
// array so a POST in run 1 is visible to the history scan in run 2 — that
// continuity is the thing under test.
function mockDiscord() {
  const state = { messages: [], calls: [], pins: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      state.calls.push({ method: req.method, path: url.pathname, contentType: req.headers['content-type'] ?? '', body });
      const json = (code, v) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (url.pathname === '/users/@me') return json(200, { id: BOT_ID, username: 'Dues' });

      const list = url.pathname.match(/^\/channels\/(\d+)\/messages$/);
      if (list && req.method === 'GET') return json(200, [...state.messages].reverse());
      if (list && req.method === 'POST') {
        // Discord returns the created message; the marker has to survive the
        // round trip or run 2 would never find it.
        const msg = {
          id: String(700000000000000000 + state.messages.length),
          author: { id: BOT_ID },
          timestamp: '2026-01-01T00:00:00.000Z',
          embeds: [{ footer: { text: 'Dues · Server Rules' } }],
        };
        state.messages.push(msg);
        return json(200, msg);
      }

      const one = url.pathname.match(/^\/channels\/(\d+)\/messages\/(\d+)$/);
      if (one && req.method === 'PATCH') {
        const msg = state.messages.find((m) => m.id === one[2]);
        if (!msg) return json(404, { message: 'unknown message' });
        return json(200, msg);
      }

      const pin = url.pathname.match(/^\/channels\/(\d+)\/pins\/(\d+)$/);
      if (pin && req.method === 'PUT') {
        state.pins.push(pin[2]);
        res.writeHead(204).end();
        return;
      }
      json(404, { message: 'not mocked' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

let failures = 0;
const check = (name, fn) =>
  fn().then(
    () => console.log(`  ✓ ${name}`),
    (err) => {
      failures += 1;
      console.error(`  ✗ ${name}\n    ${err.message}`);
    },
  );

console.log('rules poster:');

await check('posts once, then edits that same message on every later run', async () => {
  const { server, state, port } = await mockDiscord();
  const preview = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
  const env = {
    DISCORD_API_BASE: `http://127.0.0.1:${port}`,
    DISCORD_BOT_TOKEN: 'test-token',
    RULES_CHANNEL_ID: '1541819014643322900',
    PREVIEW_DIR: preview,
  };
  try {
    const first = await run(['--confirm'], env);
    assert.equal(first.code, 0, `first run failed: ${first.out}`);
    assert.match(first.out, /posted new message/, 'first run should POST');

    const second = await run(['--confirm'], env);
    assert.equal(second.code, 0, `second run failed: ${second.out}`);
    assert.match(second.out, /edited existing message/, 'second run should PATCH, not POST');

    const third = await run(['--confirm'], env);
    assert.match(third.out, /edited existing message/, 'third run should PATCH too');

    // The real assertion: one message in the channel after three runs.
    assert.equal(state.messages.length, 1, `channel holds ${state.messages.length} rules posts, expected 1`);

    const posts = state.calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.path));
    const patches = state.calls.filter((c) => c.method === 'PATCH');
    assert.equal(posts.length, 1, 'exactly one POST across three runs');
    assert.equal(patches.length, 2, 'the other two runs edit');

    // The card is attached as a real multipart upload, not a bare embed.
    assert.match(posts[0].contentType, /^multipart\/form-data/, 'card must upload as multipart');
    assert.ok(posts[0].body.includes('rules.png'), 'filename present');
    assert.ok(posts[0].body.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'real PNG bytes present');

    // An edit must clear the old attachment, or the banner accumulates.
    const payload = JSON.parse(patches[0].body.toString().match(/\{"embeds".*?\}(?=\r\n)/s)[0]);
    assert.deepEqual(payload.attachments, [], 'edit must reset attachments');
    assert.deepEqual(payload.allowed_mentions, { parse: [] }, 'a rules post must never ping');
    assert.equal(payload.embeds[0].footer.text, 'Dues · Server Rules', 'marker must be stable');

    assert.deepEqual(state.pins, [state.messages[0].id], 'the first post is pinned, and only once');
  } finally {
    server.close();
    fs.rmSync(preview, { recursive: true, force: true });
  }
});

await check('a run without --confirm touches Discord only to look, never to write', async () => {
  const { server, state, port } = await mockDiscord();
  const preview = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
  try {
    const res = await run([], {
      DISCORD_API_BASE: `http://127.0.0.1:${port}`,
      DISCORD_BOT_TOKEN: 'test-token',
      RULES_CHANNEL_ID: '1541819014643322900',
      PREVIEW_DIR: preview,
    });
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /DRY RUN/, 'must announce itself as a dry run');
    assert.match(res.out, /would POST a new message/, 'must report the action it would take');
    assert.equal(state.messages.length, 0, 'a dry run must not create a message');
    assert.ok(
      state.calls.every((c) => c.method === 'GET'),
      `dry run made a write call: ${state.calls.map((c) => c.method).join(',')}`,
    );
    // And it leaves something a human can actually review before signing off.
    assert.ok(fs.statSync(path.join(preview, 'rules.png')).size > 1000, 'preview card written');
    assert.ok(fs.readFileSync(path.join(preview, 'rules.txt'), 'utf8').includes('**12.**'), 'preview text written');
  } finally {
    server.close();
    fs.rmSync(preview, { recursive: true, force: true });
  }
});

await check('refuses to publish an empty or broken rules file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
  try {
    const empty = path.join(dir, 'empty.txt');
    fs.writeFileSync(empty, '[title]\nServer Rules\n\n[rules]\n');
    const a = await run(['--confirm'], { RULES_PATH: empty, RULES_CHANNEL_ID: '1', DISCORD_BOT_TOKEN: 't' });
    assert.notEqual(a.code, 0, 'an empty rules block must not publish a blank official-looking post');
    assert.match(a.out, /no \[rules\] lines/);

    // A typo'd placeholder must fail loudly rather than shipping "{suport}".
    const typo = path.join(dir, 'typo.txt');
    fs.writeFileSync(typo, '[channels]\nrules = 1541819014643322900\n\n[title]\nServer Rules\n\n[rules]\nAsk in {suport}.\n');
    const b = await run(['--confirm'], { RULES_PATH: typo, DISCORD_BOT_TOKEN: 't' });
    assert.notEqual(b.code, 0, 'unknown placeholder must abort');
    assert.match(b.out, /unknown channel placeholder/);

    const missing = await run(['--confirm'], { RULES_PATH: path.join(dir, 'nope.txt'), DISCORD_BOT_TOKEN: 't' });
    assert.notEqual(missing.code, 0, 'a missing file must abort');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll rules checks green.');
process.exit(failures ? 1 : 0);
