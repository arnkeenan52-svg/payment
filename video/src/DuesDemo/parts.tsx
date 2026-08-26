import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C, EASE_OUT, HEAD } from "./theme";

/** Length of the tick path below, so it can be drawn on rather than faded in. */
const TICK_LEN = 22.7;

export const CheckMark: React.FC<{
  readonly progress: number;
  readonly size: number;
  readonly color: string;
  readonly stroke?: number;
}> = ({ progress, size, color, stroke = 3 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path
      d="M4 12.5l5 5L20 6.5"
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={TICK_LEN}
      strokeDashoffset={TICK_LEN * (1 - progress)}
    />
  </svg>
);

/** One line of scene copy, rising out of blur. */
export const Caption: React.FC<{
  readonly text: string;
  readonly delay?: number;
}> = ({ text, delay = 0 }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame - delay, [0, 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_OUT,
  });

  return (
    <div
      style={{
        fontFamily: HEAD,
        fontWeight: 700,
        fontSize: 46,
        letterSpacing: "-0.025em",
        color: C.ink,
        opacity: p,
        transform: `translateY(${((1 - p) * 22).toFixed(2)}px)`,
        filter: p < 1 ? `blur(${(7 * (1 - p)).toFixed(2)}px)` : undefined,
      }}
    >
      {text}
    </div>
  );
};

/** A small uppercase label, the site's tag style. */
export const Tag: React.FC<{
  readonly children: React.ReactNode;
  readonly color?: string;
}> = ({ children, color = C.dim }) => (
  <span
    style={{
      fontFamily: HEAD,
      fontWeight: 700,
      fontSize: 17,
      letterSpacing: "0.14em",
      textTransform: "uppercase",
      color,
    }}
  >
    {children}
  </span>
);
