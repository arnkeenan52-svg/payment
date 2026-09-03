// Publish each standing Discord post's RENDERED body to public/posts/<name>.json.
//
// Why this exists: content/*.txt is the source of truth for what those messages
// say, but it is only ever read when a human runs post-message.mjs with the bot
// token. A wording fix could sit correct in the repo and wrong in Discord
// indefinitely — which is exactly what happened with a dead Threads link.
//
// The deployment DOES hold the token and already refreshes those posts hourly
// (src/services/brand-refresh.js), but it had no way to know what they should
// say. It fetches its card art over https from public/; now it fetches the text
// the same way, and the two stay in step with no manual step at all.
//
// The bodies are produced by running post-message.mjs's own dry run, so this
// cannot drift from what a real post would produce: it IS that code path.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'posts');
const PREVIEW = path.join(ROOT, 'tmp-post-preview');

const names = fs
  .readdirSync(path.join(ROOT, 'content'))
  .filter((f) => f.endsWith('.txt'))
  .map((f) => f.replace(/\.txt$/, ''));

fs.mkdirSync(OUT, { recursive: true });
const written = [];
for (const name of names) {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'post-message.mjs'), name], {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, DISCORD_BOT_TOKEN: '' }, // dry run only; never posts
  });
  const payload = JSON.parse(fs.readFileSync(path.join(PREVIEW, `${name}.json`), 'utf8'));
  const description = payload.embeds?.[0]?.description ?? '';
  if (!description) throw new Error(`${name}: rendered an empty body`);
  fs.writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify({ description }, null, 2)}\n`);
  written.push(`${name} (${description.length} chars)`);
}
fs.rmSync(PREVIEW, { recursive: true, force: true });
console.log(`  post bodies: ${written.join(', ')}`);
