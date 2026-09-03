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

Under systemd/pm2/Docker so it restarts on reboot. `Dockerfile.presence` is
the image that can also post welcome cards: Debian slim, the brand fonts
installed for fontconfig, and `npm install --omit=dev` for the card renderer.
Bare `node scripts/presence.js` with nothing installed keeps the bot Online
and nothing else — the card path needs `sharp`, so it must stay a production
dependency or the image quietly loses it.

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

Something not posting? `npm run doctor:welcome` answers it in one command —
it checks the token, the privileged intent, the guild, the channel, the bot's
computed permissions in it and a local render, over REST only, and prints the
exact fix for whichever one is false. `npm run doctor:welcome -- --post` also
sends one real test card, so the whole path is proven end to end without
waiting for someone to join. Everything below is what it checks for you.

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
leaving `WELCOME_CHANNEL_ID` unset keeps the zero-dependency path. When cards
ARE on, sharp must be installed: it is a `dependencies` entry precisely
because this image installs with `--omit=dev`.

And the thing that is not a bug: the worker has to be running somewhere that
holds a socket. Vercel cannot hold one, so no amount of configuration on the
web deployment will ever post a card — cards live or die with this worker.

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

## Rebuilding the hero film

The hero is `public/hero-tour.mp4`. It is **not a screen recording** — it is a
designed film that lives in `hero/scenes.html` and is rendered by Chromium.

    node scripts/build-film.mjs            # frames, soundtrack, encode, poster
    node scripts/build-film.mjs --frames   # frames only, to inspect

One command produces everything: the frames, the soundtrack (it shells out to
`build-film-audio.mjs` itself), the muxed mp4 and the poster. Building the audio
by hand afterwards is the one thing not to do — every accent in it is scored to
a frame number, and a separate manual mux is how the two drift a cut apart.

**Why a film and not a recording.** Four earlier hero videos were screen
recordings of the real dashboard, and all four were rejected as soft. The
reason is structural: the master was 1080p and the edit pushes in, so every
push-in was an upscale and was soft before any encoder touched it. Three encode
passes hit that wall and none could move it. This film is vector — CSS shapes,
3D transforms and text — so it has no source resolution to be limited by. It
renders at `deviceScaleFactor: 2` (3840x2160) and downscales 2:1, which is
supersampling: every output pixel is the average of four, on exactly the
hard-edged wedges and small text that alias worst.

**Why it is seek-driven.** Nothing in `scenes.html` uses CSS animation or
`requestAnimationFrame`. Every frame is produced by calling `window.__seek(t)`
with an explicit time. A 4K screenshot takes seconds, far longer than a frame
interval, so anything tied to wall clock would desync and stutter. The result
is a perfect 30fps however slow capture is, and the same `t` always renders the
same pixels — so a re-render months from now is frame-identical and the cut
still lines up. Two rules follow from that and both have been broken at least
once: no `Math.random`, and nothing may leave state behind that makes a frame
depend on which `t` was rendered before it.

**Working on it.** Open `hero/scenes.html?scene=<name>` directly in a browser
for any single beat — `title`, `store`, `stripe`, `product`, `theme`, `shop`,
`burst`, `alerts`, `endcard` — or `?scene=film` for the whole thing. Render a
half-resolution proof first (`FILM_DPR=0.5`); at full 4K a render is around
half an hour.

**Checking a change.** The junctions are measurable, so measure them:

    ffmpeg -i public/hero-tour.mp4 -vf "select='gte(scene,0)',metadata=print" -f null -

Every junction should sit under about 0.15 except the two designed flashes —
the white wash at 5.60 and the burst ignition at 14.00. A junction that climbs
means a carry has stopped aligning its two boxes.

The soundtrack has acceptance numbers too: about -16 LUFS integrated at no more
than -1.0 dBFS true peak. Loudness with `ffmpeg -af ebur128`; true peak needs
oversampling, because this material reconstructs well above its own samples:

    ffmpeg -i tmp-film-audio.wav -af aresample=192000:resampler=soxr -f f32le - | ...

### The old recorder

`scripts/record-hero.mjs` and `scripts/encode-hero.sh` are what shot those four
rejected videos. They are kept because they still do something useful — drive
the real seeded dashboard in Chromium and screenshot it, which is how the
landing page's feature stills are made — but they are no longer the hero
pipeline and nothing on the site is built from them any more.

    DB_PATH=/tmp/hero.sqlite node scripts/seed-demo.mjs      # deterministic data
    node scripts/hero-mock-discord.mjs &                     # :4312
    DISCORD_API_BASE=http://127.0.0.1:4312 node scripts/dev-server.js &
    node scripts/record-hero.mjs --scene overview            # a still, to review

`seed-demo.mjs` is deterministic (a seeded xorshift, never `Math.random`) so
re-shooting months later gives the same chart shape and the same numbers.
`hero-mock-discord.mjs` stands in for Discord so a shoot is not hostage to
someone's account; it serves only what the dashboard reads and 404s loudly on
anything else.

