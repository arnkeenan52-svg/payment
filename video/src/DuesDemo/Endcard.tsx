import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Mark } from "./Mark";
import { BODY, C, EASE_OUT, HEAD } from "./theme";

const WORD = "Dues";

/** The wordmark, swept in one glyph at a time out of blur. */
const Wordmark: React.FC<{ readonly delay: number }> = ({ delay }) => {
  const frame = useCurrentFrame();

  return (
    <span
      style={{
        fontFamily: HEAD,
        fontWeight: 700,
        fontSize: 148,
        letterSpacing: "-0.035em",
        color: C.ink,
        lineHeight: 1,
        display: "flex",
      }}
    >
      {WORD.split("").map((glyph, i) => {
        const p = interpolate(frame - delay - i * 2.5, [0, 14], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: EASE_OUT,
        });

        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity: p,
              transform: `translateY(${((1 - p) * 26).toFixed(2)}px)`,
              filter: p < 1 ? `blur(${(9 * (1 - p)).toFixed(2)}px)` : undefined,
            }}
          >
            {glyph}
          </span>
        );
      })}
    </span>
  );
};

export const Endcard: React.FC = () => {
  const frame = useCurrentFrame();

  const line = (delay: number) =>
    interpolate(frame - delay, [0, 16], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: EASE_OUT,
    });

  // A held end card still has to breathe, so the lockup keeps drifting forward.
  const drift = interpolate(frame, [0, 52], [1, 1.015], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 42,
        transform: `scale(${drift.toFixed(4)})`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 34 }}>
        <Mark height={116} delay={2} />
        <Wordmark delay={10} />
      </div>

      <div
        style={{
          fontFamily: HEAD,
          fontWeight: 700,
          fontSize: 44,
          letterSpacing: "-0.025em",
          color: C.ink,
          opacity: line(22),
          transform: `translateY(${((1 - line(22)) * 20).toFixed(2)}px)`,
          filter:
            line(22) < 1
              ? `blur(${(7 * (1 - line(22))).toFixed(2)}px)`
              : undefined,
        }}
      >
        Sell Discord roles. Keep every dollar.
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          opacity: line(30),
        }}
      >
        <span
          style={{
            padding: "12px 26px",
            borderRadius: 999,
            border: `1px solid ${C.edge}`,
            background: C.raised,
            fontFamily: BODY,
            fontWeight: 700,
            fontSize: 25,
            color: C.ink,
          }}
        >
          dues.gg
        </span>
        <span style={{ fontFamily: BODY, fontSize: 25, color: C.dim }}>
          0% platform fees
        </span>
      </div>
    </AbsoluteFill>
  );
};
