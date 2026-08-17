# Tradeleaks paygate

Sells access to a Discord server. Buyers pay by card (Stripe) or crypto
(Coinbase Commerce); a bot grants and revokes roles automatically — including
pulling buyers who aren't in the server yet straight in with their role
already applied.

Zero npm dependencies: `node:http` for the server, `node:sqlite` for storage,
raw `fetch` against the Stripe / Coinbase Commerce / Discord REST APIs.
Requires Node 22.5+.

```bash
cp .env.example .env     # fill it in (see below)
npm start                # prints a config banner showing what's set and what's missing
npm test                 # end-to-end suite against mock Stripe/Coinbase/Discord servers
```

Products live in `plans.json` — id, name, description, price, interval,
Stripe price id, and the Discord role ids each plan grants. Prices and roles
are editable without touching code. `"lifetime": true` plans are one-time
payments whose access never expires; every other plan needs `durationDays`,
which is the fixed term crypto buyers get and the fallback term if Stripe
ever fails to supply a period end.

## Discord setup

1. **Create the application** at <https://discord.com/developers/applications>.
   Copy the **Application ID** → `DISCORD_CLIENT_ID` and **Client Secret**
   (OAuth2 tab) → `DISCORD_CLIENT_SECRET`.
2. **OAuth2 redirect**: on the OAuth2 tab, add
   `https://<your-domain>/auth/callback` (must equal `PUBLIC_BASE_URL` +
   `/auth/callback`). Login requests the `identify` and `guilds.join` scopes —
   `guilds.join` is what lets the bot add a buyer to the server with their
   role already applied when they aren't a member yet.
3. **Create the bot**: Bot tab → copy the token → `DISCORD_BOT_TOKEN`.
4. **Invite the bot** to your server with the *Manage Roles* permission and
   the *Create Instant Invite* permission (needed by `guilds.join`):

   ```
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=268435457
   ```

5. Copy your server id → `DISCORD_GUILD_ID` (enable Developer Mode in Discord,
   right-click the server, *Copy Server ID*).

> **⚠️ The gotcha that breaks everything silently:** Discord only lets a bot
> manage roles that sit **below the bot's own highest role** in
> Server Settings → Roles. Drag the bot's role **above every role listed in
> `plans.json`**, or every grant will fail with `403 Missing Permissions`
> even though the bot "has" Manage Roles.

## Stripe setup

Set `STRIPE_SECRET_KEY`, create one recurring price per subscription plan and
a one-time price for lifetime plans, and put their ids in `plans.json` as
`stripePriceId`.

Add a webhook endpoint pointing at:

```
POST https://<your-domain>/webhooks/stripe
```

subscribed to exactly these events:

| event | what we do with it |
| --- | --- |
| `checkout.session.completed` | create the subscription record, grant roles |
| `invoice.paid` | renewal: extend the expiry, re-activate after past-due |
| `invoice.payment_failed` | mark past-due, start the grace window, DM the buyer |
| `customer.subscription.updated` | keep the stored period end in sync |
| `customer.subscription.deleted` | cancellation: revoke the plan's roles |

Copy the endpoint's **signing secret** → `STRIPE_WEBHOOK_SECRET`.

Failed renewals do **not** revoke instantly: the buyer keeps access for
`GRACE_PERIOD_HOURS` (default 72) and gets a DM telling them to fix their
payment method. Stripe's own retries then either recover the subscription
(`invoice.paid`) or the grace window lapses and the sweep pulls the role.

## Coinbase Commerce setup

Set `COINBASE_API_KEY`, then add a webhook subscription pointing at:

```
POST https://<your-domain>/webhooks/coinbase
```

Events handled:

| event | what we do with it |
| --- | --- |
| `charge:confirmed` | payment confirmed on-chain → grant roles |
| `charge:resolved` | charge resolved late (over/underpayment sorted out) → grant roles |
| `charge:pending` | **ignored on purpose** — a mempool sighting is not money |

Copy the **shared secret** from the webhook settings page →
`COINBASE_WEBHOOK_SECRET`.

Crypto can't auto-renew, so a crypto purchase grants a **fixed term** of the
plan's `durationDays` (lifetime plans are lifetime regardless of how they
were paid).

## How the hardening works

- **Signatures**: Stripe's `stripe-signature` (`t=…,v1=…`) and Coinbase's
  `x-cc-webhook-signature` are verified with HMAC-SHA256 and
  `crypto.timingSafeEqual`. Anything unsigned or mis-signed gets a 400 and
  touches nothing.
- **Replay defence**: events whose signed timestamp (Stripe's `t=`,
  Coinbase's `created_at`) is more than `WEBHOOK_TOLERANCE_SECONDS`
  (default 300) from now are rejected — a captured delivery is useless later.
- **Ack then process**: verified deliveries are answered `200` immediately
  and processed right after, so a slow Discord call can never time a webhook
  out into a retry storm.
- **Idempotency**: the provider event id is claimed with a PRIMARY KEY
  insert — the first delivery wins at the database constraint, not at a racy
  SELECT-then-INSERT. If processing throws, the claim is **released**, so the
  provider's retry gets a real second attempt instead of being swallowed as a
  duplicate.
- **One reconcile**: all role changes flow through `reconcile(discordId)` —
  desired roles are the union of the member's unexpired plans; it adds what's
  missing and removes **only roles that appear in `plans.json`**. Mod, colour
  and every other hand-granted role is never touched. It runs after every
  webhook, at login, and on a timer (`SWEEP_INTERVAL_SECONDS`) that also
  expires lapsed terms and grace windows. A `NULL` expiry means lifetime and
  nothing else, and lifetime rows are structurally immune to the sweep.

## End-to-end tests

`npm test` boots the real server (`src/server.js`, the same entry as
`npm start`) against in-process mock Stripe, Coinbase and Discord HTTP
servers, then drives signed webhooks at it and asserts on the role calls the
Discord mock actually received: purchase (including joining a buyer who
isn't in the server), renewal, decline + grace + DM, recovery, cancellation,
crypto confirmation (pending ignored, resolved honoured), duplicate delivery,
forged and stale signatures, claim release after a handler crash, 429
`retry_after` honouring, the expiry sweep, lifetime surviving that sweep, and
unmanaged roles staying untouched throughout. Everything is cleaned up on
exit — no stray servers, no leftover state.
