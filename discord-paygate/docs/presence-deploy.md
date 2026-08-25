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

## Welcome cards (Dues community server only)

Off by default. Set both of these and the same worker also posts a branded
join card — logo, watermark, the joiner's avatar and "Member #N":

```
WELCOME_CHANNEL_ID=<channel to post in>
WELCOME_GUILD_ID=<the Dues community server id>     # required
WELCOME_THEME=dark            # or light
WELCOME_TEXT=Hey {mention}, welcome to {server}!    # {mention} {server} {user}
```

**Scope is deliberate and enforced.** The Dues bot is multi-tenant — it sits
in every seller's server — so cards fire for exactly one guild:
`WELCOME_GUILD_ID`. Joins anywhere else are ignored, and the worker refuses to
start if `WELCOME_CHANNEL_ID` is set without it, rather than defaulting to
"every server". Sellers never get Dues-branded cards in their communities.

Two requirements:

1. **Privileged intent.** Discord Developer Portal → your app → Bot →
   Privileged Gateway Intents → enable **Server Members Intent** → Save.
   Without it the gateway refuses the connection with close code 4014 (the
   worker says exactly this and exits rather than looping).
2. **Fonts.** Cards render through fontconfig; `Dockerfile.presence` installs
   `assets/fonts/*.ttf` for you. Running bare-metal, copy them to
   `/usr/share/fonts/dues/` and run `fc-cache -f`, or cards fall back to an
   off-brand face (the renderer warns when the families are missing).

Presence-only deployments never load sharp at all — the import is lazy, so
leaving `WELCOME_CHANNEL_ID` unset keeps the zero-dependency path.

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

## Standing community messages

`scripts/post-message.mjs` publishes the Dues server's standing messages —
the rules, the official-links list, the launch announcement — each with the
same brand chrome as the welcome card (`renderBannerCard` in
`src/lib/welcome-card.js`, so every surface moves together).

One-shot scripts, not part of the worker loop, but they ARE in the worker
image: Railway's web console runs inside that container, which is the only
place `DISCORD_BOT_TOKEN` already exists, so the messages can be updated
without anyone handling the credential.

**Each message is one file in `content/`, and that file is the source of
truth** — its text, the channel it belongs in, and the marker that identifies
it on re-runs. Editing a message by hand in Discord is pointless: the next run
overwrites it. Adding a fourth standing message means adding a fourth file,
not editing the script.

    npm run post -- rules                     # dry run — renders, reports, sends nothing
    npm run post -- rules --confirm           # actually post or update
    npm run post -- official-links --confirm
    npm run post -- announcement --confirm

Safety properties, all covered by `npm run test:post`:

  - **Idempotent.** Discord messages carry no custom metadata, so each file's
    `[marker]` is stamped into the embed footer and every run scans the
    channel for a message both authored by this bot and carrying that marker.
    Found → edit it. Not found → post one and pin it. Three runs leave one
    message. A missing marker is refused outright, and the test asserts no two
    message files share one.
  - **Dry by default.** Without `--confirm` it writes the rendered card, the
    resolved text and the exact payload to `tmp-post-preview/`, makes only GET
    requests, and reports whether a real run would post or edit.
  - **Refuses to publish nothing.** An empty body, a missing title, marker or
    channel, an unknown message name or an unknown `{placeholder}` aborts
    before any write.
  - **Cannot ping.** `allowed_mentions: { parse: [] }`.

Channel mentions are written `{support}`, `{official-links}` and resolved to
`<#id>` from each file's `[channels]` block. Always by id: every channel here
carries an emoji prefix, so name-based mentions do not resolve.

The `version` line is a fingerprint of the message file. The image carries the
text, so its copy is only as fresh as the last deploy — check the fingerprint
against `sha256sum content/<name>.txt | cut -c1-8` on main before confirming.

Changing a `[marker]` orphans the message already in that channel; the next
run posts a second one. `Dues · Server Rules` is live and must not change.
