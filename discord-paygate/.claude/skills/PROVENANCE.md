# Where these skills came from

These are vendored copies of six public repositories, uploaded by the project
owner and installed here so the agents working in this repo can read them. They
are third-party work, not ours. Every one is MIT or Apache 2.0, which is why
vendoring them is fine; each keeps its own LICENSE file where the upstream repo
shipped one.

| Skills | Upstream | Licence |
|---|---|---|
| `taste-skill`, `taste-skill-v1`, `gpt-tasteskill`, `minimalist-skill`, `soft-skill`, `brutalist-skill`, `stitch-skill`, `redesign-skill`, `output-skill`, `image-to-code-skill`, `imagegen-frontend-web`, `imagegen-frontend-mobile`, `brandkit` | taste-skill | MIT |
| `animate`, `animate-expo`, `animation-vocabulary`, `improve-animations`, `review-animations`, `find-animation-opportunities`, `apple-design`, `emil-design-eng`, `prototype`, `pick-ui-library`, `ask-sonner`, `write-swift` | skills | MIT |
| `21st-ai`, `21st-cli-use`, `21st-design-sync`, `21st-registry` | 21st.dev skill | Apache 2.0 |
| `ui-ux-pro-max`, `design`, `brand`, `design-system`, `ui-styling`, `banner-design`, `slides` | ui-ux-pro-max-skill | MIT |
| `playwright-cli` | playwright-cli | Apache 2.0 |
| `composition-patterns`, `react-best-practices`, `react-native-skills`, `react-view-transitions`, `deploy-to-vercel`, `vercel-cli-with-tokens`, `vercel-optimize`, `web-design-guidelines`, `writing-guidelines` | vercel-labs/agent-skills | MIT |

## What they were used for

The five hero directions explored for dues.gg were designed by five agents, one
per direction, each reading `taste-skill` (brief inference, the three dials, the
anti-slop rules and the pre-flight checklist), `ui-ux-pro-max`, `emil-design-eng`
and the `design` / `brand` / `design-system` trio, plus whichever of
`minimalist-skill` / `soft-skill` / `brutalist-skill` fitted its assignment.

## A library that is not a skill

The same upload included `awesome-design-md`, which is not a skill but a set of
74 real design systems (Linear, Stripe, Vercel, Wise, Revolut, Coinbase, Notion,
Figma and more) recorded as exact colour tokens, type scales and letter-spacing
with the reasoning behind them. It is not vendored here because nothing loads it
automatically; it was staged at `/tmp/heroes/design-md` for the agents to read.
It is MIT and worth re-fetching whenever design work needs real numbers rather
than an impression of them. The link preview card in `hero/og-card.html` takes
its display tracking and surface ladder from the Linear and Vercel entries.

## Weight

About 14MB, most of it `ui-ux-pro-max/data` (an icon catalogue, a Google Fonts
index and its licence file) and a pair of TTFs under `ui-styling/canvas-fonts`.
