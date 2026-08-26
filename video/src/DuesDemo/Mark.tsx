import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C, EASE_OUT } from "./theme";

// The three slanted bars of the Dues mark, straight out of
// discord-paygate/public/favicon.svg. Each bar is its own path so it can be
// flown in on its own spring.
const BARS = [
  "M250 121 H396 L359 196 H213 Z",
  "M202 218 H348 L311 294 H165 Z",
  "M153 316 H299 L262 391 H116 Z",
];

export const Mark: React.FC<{
  readonly height: number;
  readonly delay?: number;
}> = ({ height, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <svg
      height={height}
      width={(height * 280) / 270}
      viewBox="116 121 280 270"
      fill="none"
    >
      {BARS.map((d, i) => {
        // Top bar first, each one 4 frames behind the last: the mark builds
        // itself downwards, in the direction the bars already lean.
        const t = frame - delay - i * 4;
        const enter = spring({
          frame: t,
          fps,
          config: { damping: 200, mass: 0.7 },
        });
        const opacity = interpolate(t, [0, 8], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: EASE_OUT,
        });

        return (
          <path
            key={i}
            d={d}
            fill={C.solid}
            opacity={opacity}
            transform={`translate(${((1 - enter) * -70).toFixed(2)} 0)`}
          />
        );
      })}
    </svg>
  );
};
