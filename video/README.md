# Remotion video

<p align="center">
  <a href="https://github.com/remotion-dev/logo">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/remotion-dev/logo/raw/main/animated-logo-banner-dark.apng">
      <img alt="Animated Remotion Logo" src="https://github.com/remotion-dev/logo/raw/main/animated-logo-banner-light.gif">
    </picture>
  </a>
</p>

Welcome to your Remotion project!

## Compositions

| id | what it is |
|---|---|
| `DuesDemo` | The Dues demo: 5s, 1920x1080, 30fps. Someone checks out, the Discord role lands, the mark. Source in [`src/DuesDemo/`](src/DuesDemo/). |
| `HelloWorld`, `OnlyLogo` | The stock Remotion starter, left in place as a reference. |

Render the demo:

```console
npx remotion render DuesDemo out/dues-demo.mp4
```

Brand tokens live in `src/DuesDemo/theme.ts` (mirrored from
`discord-paygate/public/styles.css`), the mark geometry in `src/DuesDemo/Mark.tsx`
(from `discord-paygate/public/favicon.svg`), and the fonts in `public/fonts/`
(copied from `discord-paygate/assets/fonts/` — renamed OFL cuts, see the README
there). Change any of those in one place and both the site and the video follow.

## Commands

**Install Dependencies**

```console
npm i
```

**Start Preview**

```console
npm run dev
```

**Render video**

```console
npx remotion render
```

**Upgrade Remotion**

```console
npx remotion upgrade
```

## Docs

Get started with Remotion by reading the [fundamentals page](https://www.remotion.dev/docs/the-fundamentals).

## Help

We provide help on our [Discord server](https://discord.gg/6VzzNDwUwV).

## Issues

Found an issue with Remotion? [File an issue here](https://github.com/remotion-dev/remotion/issues/new).

## License

Note that for some entities a company license is needed. [Read the terms here](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md).
