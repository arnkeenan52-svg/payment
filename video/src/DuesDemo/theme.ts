import { Easing } from "remotion";

/**
 * Brand tokens lifted from discord-paygate/public/styles.css (dark theme) so
 * the demo reads as Dues rather than as a Remotion template.
 */
export const C = {
  bg: "#0a0a0a",
  panel: "#101010",
  raised: "#141414",
  well: "#0c0c0c",
  edge: "#232323",
  hairline: "#1f1f1f",
  ink: "#f5f5f4",
  dim: "#9a9a94",
  faint: "#4a4a4a",
  solid: "#ffffff",
  solidInk: "#0a0a0a",
  blurple: "#5865f2",
  stripe: "#635bff",
} as const;

/**
 * The bundled faces are renamed cuts of Space Grotesk and DM Sans — the OFL
 * requires a modified font to drop the upstream name. See
 * discord-paygate/assets/fonts/README.md.
 */
export const HEAD =
  "'Dues Grotesk', 'Space Grotesk', ui-sans-serif, system-ui, sans-serif";
export const BODY =
  "'Dues Sans', 'DM Sans', ui-sans-serif, system-ui, sans-serif";

/** The site's motion tokens. The built-in easings are too weak for entrances. */
export const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
export const EASE_IN_OUT = Easing.bezier(0.77, 0, 0.175, 1);
