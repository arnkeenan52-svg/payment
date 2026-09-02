# NOWPayments account checklist — walk this before NOWPAYMENTS_RELEASED=1

`src/lib/nowpayments.js` opens by asserting a set of account settings as though
they were already true. Some of them are not true on a fresh NOWPayments
account, and two of them are the opposite of the default. This is the list to
walk in the dashboard, in order, before the crypto rail is switched on for real
money.

Everything below is from NOWPayments' own material: the API reference
(<https://documenter.getpostman.com/view/7907941/2s93JusNJt>), the help centre
(nowpayments.zendesk.com), and their integration guide. Where a default is
stated, it is the default they document for a new account — **not** what our
code assumes.

The dashboard paths are the ones NOWPayments uses in its own guide. Settings
live at <https://account.nowpayments.io/store-settings>; the two anchors that
matter most are `#wallets` (Payout wallets) and `#details` (Payment details).

---

## 1. Add a payout wallet — **Settings → Payments → Payout wallets**

**Set:** at least one payout wallet, in a cheap coin (TRX, LTC, BNBBSC and
USDTTRC20 are the ones NOWPayments names as lowest-fee).

**Default on a new account:** none. NOWPayments moved to "custody-first
onboarding": the account is activated and an API key issued straight after
email confirmation, "without any need to add a payout wallet."

**If it is wrong:** two things break at once.

- Custody cannot be switched off (item 2) — the toggle is gated on a wallet
  existing.
- It is the fallback destination for anything that arrives without a
  per-payment `payout_address`. NOWPayments' rule: "If you do not have a wallet
  for the coin in which a user pays — the coin is converted and will be sent to
  the first wallet in the list." A payment we ever create without
  `payout_address` therefore lands in **Dues'** wallet, not the seller's.
  `createPayment` throws rather than build such a request, so this is a
  backstop, not the primary guard — but with no wallet at all the backstop is
  "it sits in the platform balance" instead.

Only one wallet per coin is allowed, and the last wallet cannot be removed
(add a second one first).

## 2. Switch custody off — **Settings → Payments → Payment details → Custodial processing**

**Set:** disabled.

**Default on a new account:** **enabled.** NOWPayments is a custodial processor
by default: "Accept payments in a wide range of cryptos and get them instantly
converted into a coin of your choice and sent to your Custody balance."

**Order of operations (this is the part that bites):** the toggle refuses
unless (a) a payout wallet exists — item 1 — and (b) "custody balances must be
empty or nearly empty before custody can be disabled." So it cannot be done
last, after a pile of test payments have settled into the balance. Do item 1,
then this, then test.

**If it is wrong:** any payment created without a `payout_address` settles into
the Dues account and stays there — Dues is holding sellers' money, which is the
single outcome the whole architecture exists to prevent. Our code refuses to
create such a payment (`createPayment` throws; `api/checkout/crypto.js` answers
409 before it even asks), so with the code as written this is a defence in
depth rather than the only defence. It is still the setting the file header
claims is already off, and today it is not.

**Note that the whole flow works either way.** Nothing in this repository reads
`/balance` (see `docs/nowpayments-operations.md`, "Money-safety audit"), so
flipping this after launch changes nothing about the code.

## 3. Turn on wrong-asset auto-processing — **Settings → Payments → Payment details → Deposits → Extra deposits auto processing**

**Set:** enabled.

**Default on a new account:** **off.** NOWPayments: wrong-asset deposits "by
default, will require manual intervention to resolve." Only with the option on
do they get "processed automatically at the current exchange rate at the time
they are received."

**If it is wrong:** a buyer who sends USDT to an address that was quoted in ETH
gets a payment parked at "Wrong asset confirmed". Nothing is granted, no IPN
advances it, and it stays stuck until someone opens the dashboard, finds the
payment and clicks its **push button** (Payments → filter Action = Continue).
On a self-serve product where nobody is watching the dashboard, that is a buyer
who paid and got nothing, indefinitely.

**Read the caveat before switching it on.** NOWPayments' own recommendation is
the opposite of ours for e-commerce: they advise checking `parent_payment_id`
and *not* auto-granting, because a wrong-asset or repeated deposit "may differ
from the expected payment amount." Their auto-processing creates a **new
payment with a new `payment_id`**, linked to the original by
`parent_payment_id`. Our webhook keys entirely on our own `order_id`, so
whether we ever see that follow-up payment is unverified — see the operations
note, "Contradictions found in our own code", item 3. Turn this on, and treat
the sandbox test there as a release blocker.

## 4. Set the short-payment default — **Settings → Payments → Deposits → Default payment status**

**Set:** `Partially paid`.

**Default:** NOWPayments does not publish which way a new account starts; the
alternative is "finished", which "automatically assigns a 'Finished' status to
all deposits, regardless of the amount received, even if it differs from the
expected sum."

**If it is wrong:** an underpayment of any size — a dollar, or ninety percent —
arrives as `finished`, and `GRANTS_ACCESS` grants the role. NOWPayments' own
guidance: "for e-commerce, travel or others where the exact payment amount
matter, we recommend assigning underpaid payments a partially_paid status by
default." Selling memberships is that case.

## 5. Set payment covering — **Settings → Payments → Payment details → Payment covering**

**Set:** a small non-zero percentage. The file header records 2%.

**What it is:** "the percent of the deposit (from 0 to 10) you are ready to
lose and still consider the payment as finished instead of partially paid — for
example, if a piece of the payment was lost on the network fee."

**If it is 0:** every buyer whose wallet shaves a network fee off the send
amount lands at `partially_paid`, gets no role, and has to be rescued by hand.
NOWPayments notes that partially-paid is judged on "the final fiat equivalent,
even if the expected amount was sent", so exact sends can still land short.

**If it is too high:** it is a discount anyone can take by underpaying. 10% off
every membership, silently.

`COVERING_TOLERANCE` in `src/lib/nowpayments.js` mirrors this number for
wording only and never decides whether something is paid — so changing it in
the dashboard does not require a deploy, but the two should be kept in step.

## 6. Set the withdrawal fee payer — **Settings → Payments → Withdrawal fee paid by**

**Set:** `Receiver`.

**What it does:** "If set to Sender, network fees will be deducted from the
Custody balance. If set to Receiver, network fees will be deducted from the
payout amount."

**If it is Sender:** the fee is taken from a custody balance that — after item
2 — is empty. NOWPayments' own FAQ names this as the cause of "Insufficient
balance error / withdrawal was rejected without reason … an attempt to withdraw
the full amount while fees are set to 'sender'". With custody off there is
nothing to deduct from.

This is also why `CHAIN_RANK` in `src/lib/nowpayments.js` puts cheap chains
first: with Receiver, the on-chain fee comes out of what the seller nets, and a
flat gas cost on an expensive chain can exceed a small membership.

## 7. Enable the coins you actually want — **Settings → Coins**

**Set:** the coins you are willing to be paid in. Prefer the cheap chains that
`CHAIN_RANK` ranks first.

**If it is wrong:** `merchantCoins()` reads this list live, so nothing needs a
deploy — but with every coin disabled the picker is empty and
`GET /api/checkout/crypto?coins=1` answers `{ ready: false }`. `npm run doctor`
fails `nowpayments:coins` on this.

Two specific traps:

- Coins that need a memo/destination tag (XRP, XLM, TON, EOS, BNB mainnet…):
  NOWPayments warns "payments made without payin_extra_id cannot be detected
  automatically." Our pay screen renders `payin_extra_id` and deliberately
  suppresses the QR on those chains — but a buyer who ignores it loses the
  money.
- A price cap. NOWPayments: "Some of the assets (KISHU, NWC, FTT, CHR, XYM,
  SRK, KLV, SUPER, OM, XCUR, NOW, SHIB, SAND, **MATIC**, CTSI, MANA, FRONT,
  FTM, DAO, LGCY) have a maximum price amount of ~$2000." `matic`, `usdtmatic`
  and `usdcmatic` sit in our top tier. A plan priced above ~$2000 paid in MATIC
  will be refused by the provider at create time, and the buyer sees the
  generic "Payment could not be started."

## 8. Generate the IPN secret — **Settings → Payments → Instant payment notifications**

**Set:** generate it, and copy it immediately into `NOWPAYMENTS_IPN_SECRET`.

**Default:** not generated.

**If it is missing:** NOWPayments do not merely send unsigned callbacks — "If
IPN secret key is missing, webhooks will not be sent due to technological
features of the service." No IPN at all. Every sale would then depend on the
hourly `backfillMissedCryptoSales` cron, up to an hour late.

**It is shown once.** "IPN secret key may be shown fully only upon creation.
Make sure to save it after generation." `npm run doctor` fails
`nowpayments:partial` if only one of key/secret is set, because a key without a
secret means real payments no delivery can be verified against.

There is **no IPN URL field** in the dashboard for the payments API — the
callback rides on every `POST /payment` as `ipn_callback_url`, which
`ipnCallbackUrl()` builds from `PUBLIC_BASE_URL`. Getting `PUBLIC_BASE_URL`
wrong means every payment completes and nothing is ever told about it.

## 9. Let their IPN servers through — firewall / Cloudflare

**Set:** allow POST from NOWPayments' notification servers:

```
51.89.194.21
51.75.77.69
138.201.172.58
65.21.158.36
```

**If it is wrong:** NOWPayments call out Cloudflare by name — it "has a
peculiarity not only to completely block POST requests from us, but also to
partially cut them off." A partially delivered body fails the HMAC and our
handler answers 400. Also required: the endpoint takes no authentication, and
must respond **within 3000 ms** — `api/webhooks/nowpayments.js` does its work
before replying, so a slow Discord grant could exceed that and cause a retry.
Retries are safe (the work is claimed once per payment), but budget for it.

## 10. Whitelisting and 2FA — know which of these you have hit

**Default:** three safety features are **on** for a new account, and all three
are documented as applying to **payouts** (the Mass Payouts API, `POST
/payout`), which this codebase never calls:

- IP address whitelisting — Settings → Payments → IP addresses.
- Wallet address whitelisting — Mass Payouts → Whitelist my addresses. "If a
  payout address is not whitelisted, you simply can't request a payout", and
  whitelisting takes 24–48 hours.
- 2FA on payouts — a code per withdrawal, auto-rejected after an hour.

**Why it is on this list anyway:** we call one endpoint from that family.
`validatePayoutAddress()` (`POST /payout/validate-address`) runs whenever a
seller saves a wallet in `api/admin/store.js`. If IP whitelisting gates that
endpoint, it will fail with NOWPayments' "Access denied | Invalid IP" from
serverless functions, whose egress IP is not fixed and cannot be whitelisted.
The code treats a non-400 as "could not ask" and lets the save through, so it
degrades rather than breaks — but the seller loses the address check. **Verify
this in the sandbox before release** (see `docs/nowpayments-operations.md`).

The same question applies to per-payment `payout_address`: NOWPayments'
documentation only ever ties whitelisting to payout *requests*, and forwarding
on a payment is not one. If it turned out otherwise, every seller wallet would
need a 24–48h manual whitelist and the product would not work. That is the
single highest-value thing to confirm in the sandbox.

## 11. Base currency — **Settings → Payments → Payment details → Base currency**

**Set:** to match what stores price in (USD unless a seller says otherwise).

**If it is wrong:** it is the fiat currency prices are displayed in for
dashboard-created invoices. We always send `price_currency` explicitly on
`POST /payment`, so the payment itself is unaffected — but the dashboard's own
figures will read in a different currency than the books.

## 12. Payment markup — **Settings → Payments → Payment details → Payment markup**

**Set:** 0%.

**If it is wrong:** it silently adds up to 10% to every payment. The buyer is
quoted one price on the storefront and asked for a larger one on the pay
screen, and `price_amount` — the number the sale ping, the member row and the
seller's books all use — no longer matches what was charged.

---

## Before you flip the switch

1. Walk items 1–12 in the dashboard.
2. Run `npm run doctor` — it checks the key, the coin list, the IPN URL and
   which stores have payout wallets. It cannot see any of the settings above;
   no API exposes them. That is why this file exists.
3. Do a real end-to-end on the cheapest chain you enabled, with a real (small)
   payment, and confirm the coins land in the **seller's** wallet, not in
   Custody.
4. Only then set `NOWPAYMENTS_RELEASED=1`. It is the deliberate act of release
   and it belongs to nothing else — never to the presence of credentials, which
   are already set in production.
