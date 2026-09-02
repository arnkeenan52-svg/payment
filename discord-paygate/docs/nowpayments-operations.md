# NOWPayments — the operational unknowns

Companion to `docs/nowpayments-release-checklist.md`. That file is what to
click. This one is what to expect once it is running: whether the path can be
rehearsed without real money, what the provider does under load, what it does
when it is broken, and where our code and its documentation disagree.

Sources are NOWPayments' own: the production API reference
(<https://documenter.getpostman.com/view/7907941/2s93JusNJt>), the sandbox
reference (<https://documenter.getpostman.com/view/7907941/T1LSCRHC>), the help
centre (nowpayments.zendesk.com), their integration guide, and — where marked
**measured** — direct probes of the live API made while writing this on
2 Sep 2026.

---

## 1. There is a sandbox, and the code already points at it

**Yes. It exists, it is live today, and `src/config.js` needs no change.**

```
NOWPAYMENTS_API_BASE=https://api-sandbox.nowpayments.io/v1
NOWPAYMENTS_API_KEY=<key from account-sandbox.nowpayments.io>
NOWPAYMENTS_IPN_SECRET=<IPN secret from the same sandbox account>
NOWPAYMENTS_RELEASED=1        # sandbox deploy ONLY — never production
```

`config.nowpayments.apiBase` already reads `NOWPAYMENTS_API_BASE` and defaults
to `https://api.nowpayments.io/v1`, so pointing the whole rail at the sandbox is
one environment variable. Every call in `src/lib/nowpayments.js` and the doctor
goes through it.

**Measured:** `GET https://api-sandbox.nowpayments.io/v1/status` → `200
{"message":"OK"}`; `account-sandbox.nowpayments.io` and `sandbox.nowpayments.io`
both serve. It is a separate account with separate credentials — a production
key will not work against it and vice versa.

**How the test flow works.** The sandbox does not want money. `POST /payment`
takes an extra `case` parameter and emulates the whole status arc for you:

| `case` | what it plays out |
| --- | --- |
| `success` (default) | a payment that reaches `finished` |
| `common` | an ordinary payment |
| `failed` | a payment that ends `failed` |
| `partially_paid` | an underpayment |

You create the payment with a `case`, then either poll `GET /payment/{id}` or
wait for the IPNs — the sandbox fires the real callbacks to your
`ipn_callback_url`, signed with your sandbox IPN secret. That exercises the
entire path end to end: `createPayment` → pay screen → HMAC verification in
`api/webhooks/nowpayments.js` → re-read → `processNowPayment` → Discord grant →
receipt email → sale ping, plus `backfillMissedCryptoSales` for the
IPN-never-arrived case.

`createPayment` does not send `case`, so a sandbox run gets the default
(`success`). To exercise `partially_paid` and `failed`, either add a temporary
`case` field behind an env flag in a scratch branch, or drive `POST /payment`
directly with `curl` against the sandbox using the same body shape and then
replay the resulting IPN at our webhook.

**The one caveat, and it is theirs, at the top of their own sandbox docs:**

> Since 2025, the Sandbox environment is no longer actively maintained or kept
> in sync with Production. As a result, API methods, responses, status
> transitions, and other behavior in Sandbox may differ from the current
> Production environment. **Production should be considered the source of truth
> for the current API behavior.**

So the sandbox proves our plumbing — signatures, idempotency, status mapping,
grant, backfill, the pay screen — and does **not** prove settlement behaviour.
It notably will not tell you whether `payout_address` forwarding is subject to
wallet whitelisting, because the sandbox settles nothing. That question needs
one small real payment on a cheap chain, or an email to
partners@nowpayments.io.

**What the sandbox is worth testing for specifically, before release:**

1. That a real signed IPN from their servers passes `verifyIpnSignature`. Our
   `sortedJson` recursively sorts nested keys because their documented
   one-liner (`JSON.stringify(params, Object.keys(params).sort())`) only sorts
   the top level — and their payloads contain a nested `fee` object. This is
   the single highest-risk piece of code in the rail and the sandbox is the
   only way to prove it against real bytes.
2. Whether `POST /payout/validate-address` answers from an un-whitelisted IP
   (checklist item 10). Call it from the deployed function, not from a laptop.
3. Whether a wrong-asset or repeated deposit arrives carrying our `order_id`
   or a null one, and what `parent_payment_id` it names (see §6, item 3). The
   handler is built for the documented shape — null order, parent set — and
   alerts rather than delivering; the sandbox is what turns that from
   documented into observed.
4. That a real fixed-rate payment carries `valid_until`, that it is about ten
   minutes out, and that the pay screen's countdown matches it (see §6, item 1).

---

## 2. Rate limits, and what a breach looks like

**Documented** (help centre, *IPN and how to setup* → Rate limits):

- **7 RPS** for `GET /estimate`
- **3 RPS** for `POST /payment`

No published limit for `/min-amount`, `/merchant/coins`, `GET /payment/{id}` or
`/payout/validate-address`. Their integration guide's only other word on the
subject is "If you anticipate high volume or are currently being rate-limited,
contact our support team" — the limits are raisable per account, by asking.

**Measured — what a breach actually returns.** Fifteen concurrent
`GET /v1/estimate` calls against production produced a mix of `403` and `429`.
The 429 is **not** their JSON envelope; it is a raw nginx error page:

```
HTTP/2 429
content-type: text/html
server: cloudflare

<html><head><title>429 Too Many Requests</title></head>
<body><center><h1>429 Too Many Requests</h1></center><hr><center>nginx</center></body></html>
```

Three things follow.

- **No `Retry-After` header.** There is nothing to back off against but a
  fixed delay.
- **The limiter runs before authentication.** The probe used a deliberately
  invalid API key and still got 429s, so the bucket is per source IP, not per
  account. On serverless the egress IP is shared with whatever else is on that
  host and is not ours to reason about.
- **`npFetch` does not retry.** A 429 becomes
  `Error: nowpayments: GET /min-amount failed with 429: <html>…`, and the
  buyer sees "Crypto checkout is unavailable right now — try again shortly."
  That is the right thing to show, but the HTML lands in the logs, and a
  single retry after ~400 ms would turn most of these into successful
  checkouts. Worth doing before a busy launch; not worth doing blind.

**What our own load actually is.** A crypto checkout makes at most three serial
provider calls:

| call | when | cached? |
| --- | --- | --- |
| `GET /merchant/coins` | coin picker, and again on POST to validate the coin | yes, 5 min process-wide |
| `POST /payment` | once per checkout | no |
| `GET /min-amount` | only on the error path, when create fails with "minimum" | no |

So the steady-state cost is **one `POST /payment` per checkout**, against a
documented 3 RPS. Three crypto checkouts per second across the whole platform
is far beyond anything Dues will see soon. The buyer's pay screen then polls
`GET /payment/{id}`; that endpoint has no published limit, and the poll
interval in `public/` is what governs it — many buyers on the pay screen at
once is the more realistic way to hit a wall than checkouts are.

The 5-minute coin cache is per process. On serverless each cold function is its
own cache, so `/merchant/coins` traffic scales with instances, not with users.

**Error envelope for everything else.** Their normal errors are JSON:

```json
{"status":false,"statusCode":403,"code":"INVALID_API_KEY","message":"Invalid api key"}
```

`403 INVALID_API_KEY` is what a missing, wrong or sandbox-vs-production
mismatched key returns — not 401. `npm run doctor` treats 401 and 403 alike, so
it reports this correctly.

**For the pay screen specifically:** `GET /payment/{id}` carries a warning of
its own — "You should make the get payment status request with the same API key
that you used in the create payment request." Rotating `NOWPAYMENTS_API_KEY`
orphans every in-flight payment created with the old one: the poll and the
webhook re-read both stop working, and `backfillMissedCryptoSales` fails for the
whole 7-day window. Rotate only when nothing is open, or keep the old key
readable.

---

## 3. Status page and incident history

**There is no service status page and no published incident history.**

- `status.nowpayments.io` does not resolve (**measured**: DNS failure).
- `nowpayments.io/status-page` exists but is a **per-coin** page — whether an
  individual asset is available for payments or withdrawals right now, and its
  minimum payment amount. It carries no uptime, no incidents, no history.
- The only programmatic health check is `GET /v1/status` → `{"message":"OK"}`,
  which is unauthenticated and answers in one hop (**measured**: 200 from
  both production and sandbox). Nothing in this repository calls it;
  `src/services/doctor.js` uses `GET /merchant/coins` instead, which is
  strictly better because it also proves the key and the coin list.
- No RSS, no changelog of incidents, no third-party monitor with real history.
  Their blog's "Updates" category is product announcements, not incidents.

**Practical consequence:** when crypto checkout starts failing there is nowhere
to look to find out whether it is them or us. The doctor's
`nowpayments:key`/`nowpayments:coins` checks are the closest thing to an
answer — a `warn` there with a network error is the provider; a `fail` is us.
If the rail becomes load-bearing, a cheap independent monitor on
`GET /v1/status` plus `GET /merchant/coins` is the gap-filler, and there is no
vendor page to defer to.

---

## 4. In-flight payments during an outage

Their documentation never uses the word "outage", so this is assembled from how
the pieces are documented to behave.

**Money already sent is not at risk from an API outage.** The deposit address is
on-chain and independent of their API. Their processing is described as a
queue — a deposit that is detected moves `waiting → confirming → confirmed →
sending → finished` on its own; the settlement to the payout address happens on
their side without us asking.

**What breaks during an outage is the telling, not the paying.**

- **IPNs.** Their retry policy is recurrent notifications on error, count and
  timeout configurable under Settings → Payments → Instant payment
  notifications; their example is 3 notifications at 1-minute intervals. Our
  webhook answers 500 (or 503 when the re-read has not caught up) precisely so
  they retry, and their own guide confirms "If you return a 500 error, we will
  assume it failed and keep retrying." But three retries a minute apart is a
  three-minute window. **A provider outage longer than that loses the IPN
  permanently** — and their production docs add the sharper edge:

  > Please note that no callbacks are sent after a payment expires. Deposits
  > can still be received, but they will not trigger any further IPN callbacks.

  So a payment paid after expiry never announces itself at all.

- **The backstop that covers exactly this** is
  `backfillMissedCryptoSales()` in `src/services/backfill.js`: hourly, it
  re-reads open crypto attempts with `GET /payment/{id}` for a 7-day window and
  grants anything that reads `finished`. That is not an optimisation, it is the
  only thing standing between a provider hiccup and a buyer who paid and got
  nothing. It is bounded at 20 attempts and 15 seconds per run, so a large
  backlog drains over several hours — the run logs a warning when the batch
  fills.

- **Checkout during the outage** fails closed and correctly: the coin list
  answers 502, `POST` answers 502, no row is left holding a seat (the attempt
  is released when create throws). Nobody can start a payment that cannot be
  tracked.

- **The pay screen during the outage** answers 502 on the poll, but a buyer
  whose order was already marked completed by the webhook is answered from our
  own row without asking the provider at all.

**Stuck payments** are a real and separate category. NOWPayments have a
dashboard **push button** — Payments → filter Action = Continue → confirm —
that manually advances a payment "halted during processing", and they process
it within 5–10 minutes. Wrong-asset and repeated deposits are the common cases.
Nothing in Dues surfaces that a payment is in this state; it is a dashboard
errand.

---

## 5. Published volume, invoice and callback limits

**There are no published caps on payment volume, invoice count or callback
rate.** Searching their reference, help centre and integration guide turns up
none. What does exist, and what a busy store can actually hit:

| limit | value | source |
| --- | --- | --- |
| Create-payment rate | 3 RPS | help centre, Rate limits |
| Estimate rate | 7 RPS | help centre, Rate limits |
| Price cap on certain assets | **~$2000** for KISHU, NWC, FTT, CHR, XYM, SRK, KLV, SUPER, OM, XCUR, NOW, SHIB, SAND, **MATIC**, CTSI, MANA, FRONT, FTM, DAO, LGCY | API reference, `POST /payment` |
| Payment lifetime | 7 days, then the system stops tracking it | help centre, *Invoices and payments* |
| Fixed-rate quote | **10 minutes** | API reference and fee article |
| Minimum per pair | dynamic, per pair, higher for fixed-rate | `GET /min-amount` |
| `GET /payment/` page size | 1–500 per page | API reference |
| IPN response deadline | 3000 ms | help centre, IPN setup |
| Invoices | "timeless… no expiration date", cannot be deleted | help centre |

Two of these are the ones a real store meets first.

- **The minimum, not the maximum.** A buyer who sends below the pair's minimum
  gets a `failed` payment, and NOWPayments say plainly: "in most cases, such
  transactions cannot be refunded… Refunds for amounts less than the minimum
  required are typically not possible." That is a buyer's money gone. It is why
  `minimumFor()` now asks with the same flow flags the payment uses (§6).
- **The $2000 asset cap**, because `matic`, `usdtmatic` and `usdcmatic` are in
  our top coin tier and a lifetime plan can easily exceed $2000.

**Account limits** are risk-based rather than published. Their KYC/AML material
describes verification triggered by suspicious activity or by volume rather
than applied universally, and fiat on/off-ramp requires KYB. A crypto-only
merchant is normally unverified; a busy one should expect to be asked at some
point, and that request is not something the code can absorb.

**Fees, for the record** — with `is_fixed_rate` and `is_fee_paid_by_user` both
true, as `createPayment` sends, the service fee is **1%** (not the 0.5%
mono-currency rate), paid by the buyer. The seller still absorbs the on-chain
payout fee, because the account is set to "withdrawal fee paid by Receiver".

---

## 6. Contradictions found in our own code

Everything here is our documentation disagreeing with theirs. None of it is a
custody or fund-safety break.

### 1. The 10-minute fixed-rate window vs. the 7-day hold — **resolved: they are two different windows**

They were never one number, and reading them as one is what cost buyers the
product. The API reference, on `is_fixed_rate` and on `is_fee_paid_by_user` —
the two flags every payment here carries — both say:

> the rate of exchange will be frozen for 10 minutes. If there are no incoming
> payments during this period, **the payment status changes to "expired"**.

while the help centre's *Payment statuses* says expired also covers "no deposit
at all within 7 days after payment creation", and that a payment "lives for 7
days - after that, our system will stop tracking it".

Both are true of different things:

| window | what it bounds | where it is read |
| --- | --- | --- |
| `valid_until` (~10 min here) | how long **this invoice can be paid** | `paymentExpiryAt()` → the seat hold, the discount hold, the buyer's countdown |
| 7 days from creation | how long the provider keeps **watching the address** | `TRACKING_WINDOW_SECONDS` → how long `backfillMissedCryptoSales()` keeps asking |

`expiration_estimate_date` is neither: their own wording is "expiration date of
this estimate". We read `valid_until` and fall back to the estimate only when
it is absent.

What the old single number did: `api/checkout/crypto.js` held the seat and the
discount use for `7 * 86400`, so an invoice that lapsed at minute ten went on
holding both for a week; the pay screen said "start the payment again", each
restart minted another week-long hold, and the third hit `MAX_OPEN_INVOICES`
— a buyer locked out of a product they never bought, with a seat nobody else
could buy either. Meanwhile the hourly cron closed the order on `expired`,
which is the one status where the money is not finished with us: **no callbacks
are sent after expiry, and deposits can still be received.** A late deposit
therefore produced no IPN, no grant, no alert, and a sweep that had stopped
asking.

Now: the hold ends when the provider's own window does, and an `expired` order
stays open and keeps being polled until the seven days are spent (then it is
closed). If the seat was taken by someone else in the meantime, the settlement
re-check answers it the way it answers every late crypto settlement — nothing
delivered, seller alerted to refund. That trade is deliberate: a certain
week-long lockout for every other buyer is worse than a rare late one.

**Still worth watching in the sandbox:** that a real fixed-rate payment carries
`valid_until` at all, and that a deposit made after expiry really does move the
payment to `finished` on a later `GET /payment/{id}` (the whole backstop rests
on it).

### 2. `minimumFor()` asked about the wrong flow — **fixed on this branch**

`GET /min-amount` accepts `is_fixed_rate` and `is_fee_paid_by_user`, and
NOWPayments are explicit that they change the answer: the flags "allow you to
see current minimum amounts for corresponding flows (**it may differ from the
standard flow!**)", and "the minimum amounts you see on the status page are
calculated for standard rate payments only! **Fixed-rate minimum amounts are
usually higher.**" Their own worked example: USDTTRC20 → USDTTRC20 is ~9 at the
standard rate and ~**20** fixed — better than 2× apart.

`minimumFor()` sent neither flag while `createPayment` sends both, so the
"network minimum of about X" quoted to a refused buyer was the *standard*
minimum: a floor the payment would still refuse, and — worse — a number a buyer
could act on and send below the real minimum, which produces a `failed` payment
the provider says usually cannot be refunded. Now sends both flags; pinned in
`scripts/e2e-test.js`.

### 3. Wrong-asset and repeated deposits arrive as a *different payment* — **fixed**

The header of `src/lib/nowpayments.js` used to say a buyer who sends the wrong
coin "has it converted at the current rate and credited anyway" — credited to
the payment the invoice created. Their documentation describes something else.
Both wrong-asset deposits (with auto-processing on) and repeated deposits to
the same address produce a **new payment with a new `payment_id`**, linked to
the original by `parent_payment_id` — "Repeated deposits to the same addresses
will automatically create a new payment with another id" — carrying
`"order_id": null` in their own example webhook body, and their integration
advice is to track `parent_payment_id` and *not* to grant automatically on one.

`processNowPayment()` resolved everything through our own `order_id`, so that
IPN logged `payment without order_id, ignoring` and answered 200 while the
coins were already on their way to the seller: money in, buyer silent, nobody
told. What it does now:

| the deposit | what happens |
| --- | --- |
| its parent order is **already delivered** | nothing granted; the seller is alerted once — "Extra crypto payment — not a new sale", with the child payment id and the coin, so they can refund it or place it by hand |
| its parent order is **still open** (the top-up, and the wrong-coin case) | nothing granted and the order is **left open**; the seller is alerted — the money arrived, the order did not complete, finishing it is their call in the NOWPayments dashboard or from Members |
| it resolves to **no order of ours** | the platform's own notification channel is alerted with the payment id: only the dashboard holds the deposit address that says whose it was |

Never delivered automatically, in any of the three: the provider says "We do
not recommend configuring your system to automatically provide services or ship
goods based on any repeated-deposit status", and a child payment carries no
price of its own from which anything here could work out whether the order is
now covered. The parent is re-read from the API for the walk — the IPN body is
trusted for the parent id and nothing else. Pinned in `scripts/e2e-test.js`
("a second deposit on a delivered order", "a wrong-coin deposit is a CHILD
payment", "resolves to no order of ours"), whose mock now mints child payments
the way the provider documents them.

**Still worth a sandbox run before release:** create a payment, trigger a
re-deposit, and record what `order_id` and `parent_payment_id` the follow-up
IPN really carries. This is written to the documentation, not to an
observation.

### 4. `listPayments()` is dead code that would not work — **cosmetic**

The comment above it reads "Recon reads PAYMENTS, never the balance: this is
the list of what was forwarded". No caller exists — recon is
`backfillMissedCryptoSales()`, which reads `GET /payment/{id}` per open
attempt. And it would fail if called: `GET /payment/` is one of exactly two
endpoints their reference marks as needing a **JWT bearer token** from
`POST /v1/auth` (email + password, expires in 5 minutes) *in addition to*
`x-api-key`. `npFetch` sends only the key, so this would return 403. `estimate()`
is likewise exported and uncalled.

Neither is a bug today. Both are traps for whoever calls them next, and the
comment overstates what the code does.

### 5. Their "best practices" page says SHA-256 — **their error, we are right**

<https://nowpayments.io/blog/best-integration-practices-at-nowpayments> says to
"Verify the HMAC signature header using SHA256". The API reference, the IPN
help-centre article and all three of their own code samples use **SHA-512**.
`verifyIpnSignature` uses sha512. Do not "fix" it.

---

## 7. The money-safety audit: does anything read the balance?

**The claim holds.** `src/lib/nowpayments.js` asserts:

> NOTHING here reads the account balance. No `/balance`, no payout-from-balance,
> no "do we have funds" check… That is what makes switching custody off later a
> no-op for this code.

Every NOWPayments endpoint this repository touches, found by grepping every
`npFetch(` call, every literal fetch against `config.nowpayments.apiBase`, and
every `api()` template in the tree:

| endpoint | where | reads a balance? |
| --- | --- | --- |
| `GET /merchant/coins` | `merchantCoins()`; `src/services/doctor.js:439` | no — the enabled-coin list |
| `POST /payout/validate-address` | `validatePayoutAddress()`, from `api/admin/store.js` | no — address syntax/support for a pair |
| `GET /min-amount` | `minimumFor()`, from `api/checkout/crypto.js` | no — per-pair floor |
| `GET /estimate` | `estimate()` — exported, **no callers** | no |
| `POST /payment` | `createPayment()` | no |
| `GET /payment/{id}` | `getPayment()` — pay-screen poll, webhook re-read, backfill | no |
| `GET /payment/` | `listPayments()` — exported, **no callers** | no |

`GET /v1/balance` exists in their API. It appears **nowhere** in this
repository. Neither do `POST /payout`, `POST /conversion`, `GET
/payout-withdrawal/min-amount`, `GET /payout/fee`, or anything under
`/sub-partner` (their custodial user-balance product). Grepping for `balance`
across `src/`, `api/`, `public/` and `scripts/` returns only prose in comments,
one CSS `text-wrap: balance`, and a line of dashboard copy — no call, no
conditional, no arithmetic.

The behavioural half of the claim holds too: no code path branches on funds
being available. The only precondition `createPayment` enforces is that the
seller has a payout address **and** a chain, and it enforces it by throwing.
`api/checkout/crypto.js` refuses the same pair with a 409 before the provider is
asked at all, and the coin picker reports `ready: false` so the storefront never
offers a button that can only fail. Switching custody off is a dashboard
action with no code consequence.

**Two footnotes that do not break the claim but qualify it.**

1. `POST /payout/validate-address` is the one endpoint we call from their
   Mass Payouts family. It reads no balance, but it may be subject to the IP
   whitelisting that family carries by default (checklist item 10). It is
   already treated as advisory — a non-400 answer throws and the caller lets
   the save through — so a hard failure degrades the address check rather than
   blocking a seller.
2. The custody guarantee currently rests on `payout_address` being present on
   every payment, not on custody being off. That is one guard, in one function,
   with a second in the HTTP handler and a third in the coin picker. It is
   sound — and it is still worth doing checklist items 1 and 2, so that the
   guarantee survives a future code path that forgets.
