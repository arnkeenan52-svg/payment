#!/usr/bin/env node
// Set the Dues bot's avatar (and banner, where the bot has one) to the current
// brand tile. Run wherever DISCORD_BOT_TOKEN lives:
//   node scripts/set-bot-avatar.mjs
// Reads public/icon-512.png and public/dues-banner.png from the repo.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) { console.error('DISCORD_BOT_TOKEN is not set'); process.exit(1); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataUri = async (rel) =>
  `data:image/png;base64,${(await readFile(path.join(root, rel))).toString('base64')}`;

const res = await fetch('https://discord.com/api/v10/users/@me', {
  method: 'PATCH',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    avatar: await dataUri('public/icon-512.png'),
    banner: await dataUri('public/dues-banner.png'),
  }),
});
if (!res.ok) { console.error(`PATCH /users/@me → ${res.status}: ${await res.text()}`); process.exit(1); }
const me = await res.json();
console.log(`avatar + banner updated for ${me.username}#${me.discriminator}`);
