# Keeping the Dues bot "Online"

## Why this is a separate thing

Everything Dues *does* — granting roles, taking payments, sweeping expiries —
runs on Vercel functions and works whether or not the bot looks online.
Discord only paints a bot **Online** while it holds an open gateway
WebSocket, and a serverless function cannot hold one open. So the bot works
perfectly while showing as offline in the member list.

`scripts/presence.js` fixes only the appearance: it opens that socket, holds
it, heartbeats, resumes after drops, and does nothing else. No intents, no
event handling, no database, no Stripe. If it dies, payments and roles are
completely unaffected — the bot just greys out again.

Run exactly ONE instance. Two instances on the same token fight over the
gateway session and flap the bot between online and offline.

## Option A — Railway (easiest, no CLI)

1. railway.app → **New Project** → **Deploy from GitHub repo** → pick
   `arnkeenan52-svg/hyperthrophy`.
2. Settings → **Start Command**: `node scripts/presence.js`
   (or leave it — the `Procfile` already declares the `worker` process.)
3. Variables → add `DISCORD_BOT_TOKEN` = your bot token.
   Optional: `PRESENCE_TEXT=dues.gg`, `PRESENCE_TYPE=3`, `PRESENCE_STATUS=online`.
4. Deploy. Watch the logs for `ready as <bot>#0000 — presence online`.

Do **not** add a domain or expose a port; this is a worker, not a website.

## Option B — Fly.io (cheapest, needs the CLI once)

```sh
fly launch --no-deploy --copy-config     # uses the committed fly.toml
fly secrets set DISCORD_BOT_TOKEN=...    # never commit the token
fly deploy
fly logs                                 # expect "presence online"
fly scale count 1                        # exactly one machine, always
```

`fly.toml` deliberately has no `[http_service]` block, so Fly treats it as a
worker and never auto-stops it.

## Option C — any box you already run

```sh
DISCORD_BOT_TOKEN=... npm run presence
```

Under systemd/pm2/Docker so it restarts on reboot. `Dockerfile.presence`
builds a ~150MB Node-Alpine image with no install step (presence.js imports
only node: builtins).

## Checking it

- Discord member list: the bot shows Online with "Watching dues.gg".
- Set `PORT=8080` and `GET /` returns a JSON health snapshot:
  `{ ok, status, bot, uptimeSeconds, connectedSeconds, reconnects, lastError }`
  — 200 when the socket is up, 503 while connecting. Useful as a host health
  check or an uptime-monitor target.
- `npm run test:presence` exercises identify/heartbeat/resume and the
  fatal-auth path against a mock gateway.

## When it exits

Fatal close codes (4004 bad token, 4010–4014 bad shard/intents) exit non-zero
immediately rather than retrying — the host surfaces the misconfiguration
instead of silently looping. Everything else reconnects with jittered
backoff and resumes the existing session where Discord allows it.
