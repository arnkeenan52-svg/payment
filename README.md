# payment

Monorepo for the Tradeleaks payment stack.

- [`discord-paygate/`](discord-paygate/) — the Tradeleaks Discord paygate:
  Stripe + Coinbase Commerce checkout, hardened webhooks, and idempotent
  Discord role reconciliation. See its README for setup and architecture.
- [`video/`](video/) — Remotion project (`npx create-video@latest`, hello-world
  template) for rendering video assets. `cd video && npm i && npm run dev`.
