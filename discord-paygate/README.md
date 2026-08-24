# Tradeleaks paygate

Sells access to a Discord server. Buyers pay by card (Stripe; one-time
$59.99 lifetime membership) — with optional, currently dormant, crypto
support (Coinbase Commerce). A bot grants and revokes roles automatically,
including pulling buyers who aren't in the server yet straight in with their
role already applied.

Built for **Vercel serverless**: individual functions under `api/`, the
storefront served statically from `public/`, Postgres for storage, and a
Vercel cron for the reconcile sweep. Runs identically on a local Node
process for development and tests. One npm dependency (`pg`); everything
else is `node:` built-ins and raw `fetch`. Requires Node 22.5+.

```bash
cp .env.example .env     # fill it in (see below)
npm start                # local dev server; prints a config banner
npm test                 # e2e suite against mock Stripe/Coinbase/Discord (SQLite)
E2E_DATABASE_URL=postgres://… npm test   # same suite against real Postgres
npm run migrate          # create tables against DATABASE_URL / DB_PATH
npm run doctor           # LIVE-verify the whole setup before taking money
```

Products live in `plans.json` — id, name, description, price, Stripe price
id, and the Discord role ids each plan grants. The live catalog is a single
`lifetime: true` plan: one payment, `NULL` expiry, permanent access.

## How the serverless port works (and why)

- **Storage is Postgres** (`DATABASE_URL`), because Vercel's filesystem is
  ephemeral — a SQLite file would silently lose every membership on
  redeploy. `src/db.js` is a thin adapter (pg in production, `node:sqlite`
  for local dev/tests) with an identical schema. There is no boot step on
  serverless, so the schema is ensured by a guarded lazy init on the first
  query of each cold start; `npm run migrate` does the same thing explicitly
  at deploy time.
- **Webhooks do the work BEFORE responding.** A serverless function is
  frozen the instant it responds — an "ack 200, process later" pattern would
  silently never grant the role. `api/webhooks/stripe.js` verifies, claims,
  processes, and only then answers. A crash releases the idempotency claim
  and answers 500, so Stripe's retry of the same event id is a real second
  attempt. (If you ever want early acks back, wrap the tail in `waitUntil`
  from `@vercel/functions` — but work-first is simpler and well inside the
  60s `maxDuration` configured in `vercel.json`.)
- **Idempotency is a PRIMARY KEY claim**: `INSERT … ON CONFLICT DO NOTHING`
  on `<provider>:<event id>` and check the affected row count. First
  delivery wins at the constraint — no SELECT-then-INSERT race, and no
  double role grants when Stripe delivers twice.
- **The expiry sweep is a cron, not a timer** — `setInterval` needs a
  long-lived process that doesn't exist here. `vercel.json` schedules
  `GET /api/cron/reconcile` hourly; Vercel sends
  `Authorization: Bearer <CRON_SECRET>` automatically when that env var is
  set, and the endpoint compares it with `crypto.timingSafeEqual` (failing
  closed if the secret is unconfigured). The sweep expires lapsed terms and
  grace windows and reconciles every member with a live subscription, so
  drift heals on its own.
- **Raw webhook bodies**: both webhook functions export
  `config = { api: { bodyParser: false } }`. Signatures are HMACs over the
  exact bytes sent; a parsed-and-reserialised body would fail verification.
- **Routing**: `vercel.json` rewrites keep the public URLs stable —
  `/auth/login`, `/auth/callback`, `/auth/logout`, `/webhooks/stripe`,
  `/webhooks/coinbase` map onto the corresponding `api/` functions.
- **Stripe-only capability flag**: crypto is live only when
  `COINBASE_API_KEY` + `COINBASE_WEBHOOK_SECRET` are set. Without them the
  storefront hides the crypto CTA and the coinbase endpoints answer 501 —
  the code is dormant, not deleted.

## Deploying to Vercel

1. **Import the repo** at vercel.com → Add New → Project. Set **Root
   Directory** to `discord-paygate`. Framework preset: **Other** (no build
   step; `public/` is served statically, `api/` becomes functions).
2. **Provision Postgres**: in the project, **Storage → Create Database**
   and pick a Postgres provider (Neon is the default marketplace choice) —
   connecting it injects the connection string automatically. The code reads
   `DATABASE_URL` first and falls back to `POSTGRES_URL`, so whichever name
   the integration injects works with no manual step. Any external Postgres
   works too: paste its **pooled** connection string as `DATABASE_URL`.
3. **Set the environment variables** listed in `.env.example` (all except
   `PORT`/`DB_PATH`, which are local-only). Generate `SESSION_SECRET` and
   `CRON_SECRET` with `openssl rand -hex 32`. Leave the `COINBASE_*` vars
   unset for Stripe-only.
4. **Deploy**, then run `DATABASE_URL=… npm run migrate` locally once (or
   just let the lazy init create tables on first traffic).
5. Point the **Discord redirect URI** and the **Stripe webhook endpoint**
   (below) at the deployed domain, and set `PUBLIC_BASE_URL` to match.
6. The cron in `vercel.json` runs hourly. Note: Hobby-plan crons may be
   scheduled with looser precision (once per day); Pro runs them on
   schedule. The sweep is a safety net — grants and revocations are
   webhook-driven and immediate either way.
7. **Before selling, run the setup doctor** against the deployment:

   ```bash
   curl -s -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/setup-check
   ```

   and fix anything it flags (see below).

## Setup doctor

A wrong value here fails silently at the worst possible moment — a buyer
pays and no role is granted. The doctor verifies the setup **live**, not by
checking that strings are non-empty:

- every required env var present and structurally plausible (`sk_`/`whsec_`
  prefixes, snowflake-shaped Discord ids, `PUBLIC_BASE_URL` https with no
  trailing slash, real-length `SESSION_SECRET`/`CRON_SECRET`);
- the Stripe key actually authenticates, reporting **test vs live mode**;
- each `stripePriceId` in `plans.json` exists, is active, is **one-time
  rather than recurring** for lifetime plans (a Recurring price here would
  bill buyers monthly forever), and its amount matches the catalog;
- the bot token authenticates (reports the bot's username), the bot is a
  member of `DISCORD_GUILD_ID`, holds **Manage Roles**, every `roleId` in
  `plans.json` exists in that guild — and, the critical one, the bot's
  highest role sits **strictly above** every managed role, because at or
  below means Discord 403s every grant *after* the buyer has paid;
- plus a warning when Stripe is in live mode while `PUBLIC_BASE_URL` still
  points at a preview domain.

Run it three ways, all the same module:

- `npm run doctor` — pass/fail table, each failure with the exact fix and
  the dashboard path to click; exits non-zero on any failure; secrets are
  only ever printed as masked prefixes.
- `GET /api/setup-check` with `Authorization: Bearer <CRON_SECRET>` — the
  full report as JSON, for checking a live deployment.
- `GET /api/setup-check` without auth — returns **only** `{ ok }`; the
  storefront polls this and shows a single red banner when the doctor is
  failing, so a misconfigured deployment can't quietly accept money.

Results are cached for `DOCTOR_CACHE_SECONDS` (default 300) per warm
instance.

## Keeping the bot Online (gateway presence)

Discord paints a bot **Online** only while it holds an open gateway
WebSocket. Everything Ripley does — granting roles, reading channels, posting
sale pings — runs over the REST API from Vercel functions, which cannot hold a
socket open. So the bot works perfectly while showing as **Offline** in the
member list.

`scripts/presence.js` is the fix: a tiny always-on process whose only job is to
hold that socket. It handles no events and asks for no privileged intents
(`intents: 0`), heartbeats, resumes its session after a drop, backs off on
failure, and exits loudly on an auth error instead of hammering the gateway.

```bash
DISCORD_BOT_TOKEN=your-bot-token npm run presence
```

Deploy it anywhere that stays up — Railway, Fly.io, a Render **background
worker**, or any VPS. `Dockerfile.presence` builds it standalone. The only
required variable is `DISCORD_BOT_TOKEN` (the same one Vercel uses).

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | — | required |
| `PRESENCE_TEXT` | `dues.gg` | activity text; empty for status only |
| `PRESENCE_TYPE` | `3` (Watching) | 0 Playing · 2 Listening · 3 Watching · 5 Competing |
| `PRESENCE_STATUS` | `online` | `online`, `idle` or `dnd` |
| `PORT` | unset | if set, serves a JSON health snapshot on `GET /` |

Two rules: run **exactly one** instance per bot token (two instances fight over
the session), and remember this process is cosmetic — if it stops, payments,
role delivery and receipts keep working, the bot just greys out.

`npm run test:presence` verifies the client against a mock gateway: it
identifies with the presence payload, heartbeats, resumes the same session
after the gateway drops it, and exits non-zero on a 4004 auth failure.

### Running it free, on a VM that stays up

Measured footprint: ~60 MB RSS, ~195 KB/day of traffic, effectively no CPU.
That fits in the smallest free tier anywhere, but "free" and "always on" rule
out most of them:

- **Google Compute Engine free tier** — one non-preemptible `e2-micro` per
  month in `us-west1`, `us-central1` or `us-east1`, 30 GB disk, 1 GB/month of
  North America egress, no expiry. The worker uses ~6 MB of that GB. This is
  the recommendation.
- **Oracle Cloud Always Free** — bigger box, but Oracle reclaims Always Free
  instances that stay under 20% CPU for seven days. This worker idles at
  ~0%, so it is exactly the workload that policy targets. Avoid.
- **Free tiers that sleep** (Render free web services and similar) — a slept
  process drops the socket and the bot greys out. Setting `PORT` and pinging
  it from outside keeps it awake, but it is a workaround, not a deployment.

`deploy/install-presence.sh` does the whole VM side: installs Node 22 if the
box has something older, creates a `ripley` system user, drops `presence.js`
into `/opt/ripley`, writes the systemd unit, and starts it. Put it and
`scripts/presence.js` in the same directory on the VM, then:

```bash
sudo bash install-presence.sh
```

It prompts for the bot token with echo off, so the token never reaches your
shell history or a file you might commit — only `/etc/ripley/presence.env`,
root-owned at mode 600. Re-running it updates `presence.js` and restarts the
service, and it keeps an existing token rather than asking again.

The unit restarts on crash and starts on boot, but gives up after five
failures in ten minutes: `presence.js` exits 1 on a fatal auth error, and
retrying a revoked token forever would just hammer Discord's gateway. Check on
it with `systemctl status ripley-presence` and
`journalctl -u ripley-presence -f` — a healthy start logs `online as <bot>`.

The VM needs no inbound firewall rule — the gateway connection is outbound
only, and nothing else from this repo has to run there. `presence.js` has no
dependencies, so those two files are the entire payload.

## Buyer self-service

Buyers manage their own membership at `/account`: they see status, renewal
date and role, can re-sync a role Discord dropped, and can **cancel a
recurring membership themselves**. Cancelling sets `cancel_at_period_end` on
the Stripe subscription — the buyer keeps the access they paid for, and the
role lifts on Stripe's own `customer.subscription.deleted` event through the
existing webhook path.

Ownership is decided server-side from the session's own rows, never from the
subscription id in the request, so knowing another buyer's `sub_` id is not
enough to cancel it. One-off and lifetime purchases are not cancellable and
say so.

A store's Stripe key therefore needs **Subscriptions: write**, not just read.
`/api/subscription` answers `502` with a readable message when the key lacks
it, rather than leaving the buyer on a dead button.

## Discord setup

1. **Create the application** at <https://discord.com/developers/applications>.
   Copy the **Application ID** → `DISCORD_CLIENT_ID` and **Client Secret**
   (OAuth2 tab) → `DISCORD_CLIENT_SECRET`.
2. **OAuth2 redirect**: on the OAuth2 tab, add
   `https://<your-domain>/auth/callback` (must equal `PUBLIC_BASE_URL` +
   `/auth/callback`). Login requests the `identify` and `guilds.join`
   scopes — `guilds.join` is what lets the bot add a buyer to the server
   with their role already applied when they aren't a member yet.
3. **Create the bot**: Bot tab → copy the token → `DISCORD_BOT_TOKEN`.
4. **Invite the bot** with *Manage Roles*, *Manage Server*,
   *Create Instant Invite* (needed by `guilds.join`), and
   *View Channels* / *Send Messages* / *Embed Links* (sale notifications):

   ```
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=268454945
   ```

5. Copy your server id → `DISCORD_GUILD_ID` (enable Developer Mode,
   right-click the server, *Copy Server ID*).

> **⚠️ The gotcha that breaks everything silently:** Discord only lets a bot
> manage roles that sit **below the bot's own highest role** in
> Server Settings → Roles. Drag the bot's role **above every role listed in
> `plans.json`**, or every grant will fail with `403 Missing Permissions`
> even though the bot "has" Manage Roles.

## Stripe setup

Set `STRIPE_SECRET_KEY`. Create the product: Product catalog → Add product →
$59.99 USD, **One-off** → copy the `price_…` id into `plans.json` as
`stripePriceId`.

Add a webhook endpoint pointing at:

```
POST https://<your-domain>/webhooks/stripe
```

subscribed to exactly these events:

| event | what we do with it |
| --- | --- |
| `checkout.session.completed` | the one that fires for one-time payments: create the membership, grant roles |
| `invoice.paid` | renewal for recurring plans (dormant with a lifetime-only catalog) |
| `invoice.payment_failed` | past-due + grace window + DM (recurring plans only) |
| `customer.subscription.updated` | keep a stored period end in sync (recurring plans only) |
| `customer.subscription.deleted` | cancellation: revoke the plan's roles (recurring plans only) |

Copy the endpoint's **signing secret** → `STRIPE_WEBHOOK_SECRET`.

## Coinbase Commerce (optional, dormant by default)

Leave `COINBASE_*` unset for Stripe-only. To enable crypto later: set
`COINBASE_API_KEY`, add a webhook subscription pointing at
`POST https://<your-domain>/webhooks/coinbase`
(`charge:confirmed` / `charge:resolved` grant; `charge:pending` is ignored
on purpose — a mempool sighting is not money), and copy the shared secret →
`COINBASE_WEBHOOK_SECRET`. Crypto can't auto-renew, so term plans grant a
fixed `durationDays`; the lifetime plan is lifetime either way.

## Hardening summary

- Stripe's `stripe-signature` and Coinbase's `x-cc-webhook-signature`
  verified with HMAC-SHA256 + `crypto.timingSafeEqual`; events outside
  `WEBHOOK_TOLERANCE_SECONDS` (default 300) are rejected — a captured
  delivery is useless later.
- Idempotency: PRIMARY KEY claim, released on failure (see above).
- One idempotent `reconcile(discordId)` is the only place roles change:
  desired = union of roleIds across unexpired memberships; adds what's
  missing, removes **only roles that appear in `plans.json`** — mod, colour
  and every hand-granted role is never touched. Runs after every webhook,
  at login, and from the cron.
- `NULL` expiry means lifetime and nothing else; term grants that arrive
  without a period end fall back to the plan's `durationDays`; Stripe's
  `current_period_end` is read with the `items.data[0]` fallback for
  post-2025-03-31 API versions; Discord 429s honoured via `retry_after`.

## End-to-end tests

`npm test` boots the local shim (`scripts/dev-server.js`), which mounts the
**same handler functions Vercel runs** from `api/**`, against in-process
mock Stripe, Coinbase and Discord HTTP servers — then drives signed
webhooks at it and asserts on the role calls the Discord mock actually
received. 23 scenarios: purchase completing before the webhook responds,
renewal, decline + grace + DM, recovery, cancellation, crypto
confirm/resolve/pending, duplicate delivery via the `/api` path, forged and
stale signatures, claim release after a handler crash (500 → real retry),
cron-secret rejection, cron-driven expiry sweeps, lifetime surviving the
sweep, unmanaged roles staying untouched, and a second Stripe-only boot
proving the coinbase endpoints are dormant (501) with the crypto CTA
capability off. Set `E2E_DATABASE_URL` to run the identical suite against
real Postgres. Everything is cleaned up on exit — no stray servers, no
leftover state.
