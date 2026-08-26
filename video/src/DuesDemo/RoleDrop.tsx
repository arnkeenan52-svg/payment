import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Caption, CheckMark } from "./parts";
import { BODY, C, EASE_OUT, HEAD } from "./theme";

const STEPS = [
  { label: "payment verified", at: 8 },
  { label: "signature verified", at: 14 },
  { label: "role granted", at: 20 },
];

export const RoleDrop: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const panel = spring({
    frame: frame - 2,
    fps,
    config: { damping: 200, mass: 0.8 },
  });

  // The chip is the payoff of the whole video, so it gets the only springy
  // config in the piece — everything else is critically damped.
  const chip = spring({
    frame: frame - 22,
    fps,
    config: { damping: 11, mass: 0.7, stiffness: 120 },
  });
  const ring = interpolate(frame, [22, 42], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_OUT,
  });

  const seconds = interpolate(frame, [4, 30], [0, 2.1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_OUT,
  });

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 54,
      }}
    >
      <Caption text="The role lands in seconds." delay={2} />

      <div
        style={{
          width: 860,
          padding: 40,
          borderRadius: 26,
          background: C.panel,
          border: `1px solid ${C.edge}`,
          boxShadow: "0 40px 90px rgba(0,0,0,0.55)",
          opacity: panel,
          transform: `translateY(${((1 - panel) * 60).toFixed(2)}px)`,
        }}
      >
        {/* the member, as Discord shows them */}
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 62,
              height: 62,
              borderRadius: "50%",
              background: C.blurple,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: HEAD,
              fontWeight: 700,
              fontSize: 27,
              color: C.solid,
            }}
          >
            J
          </div>
          <span
            style={{
              fontFamily: BODY,
              fontWeight: 700,
              fontSize: 30,
              color: C.ink,
            }}
          >
            @jordan
          </span>

          <div style={{ marginLeft: "auto", position: "relative" }}>
            {/* one soft ring, expanding out of the chip as it lands */}
            <div
              style={{
                position: "absolute",
                inset: -6,
                borderRadius: 18,
                border: `2px solid ${C.solid}`,
                opacity: frame < 22 ? 0 : 0.4 * (1 - ring),
                transform: `scale(${(1 + ring * 0.5).toFixed(3)})`,
              }}
            />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "13px 22px",
                borderRadius: 13,
                background: C.raised,
                border: `1px solid ${C.edge}`,
                opacity: interpolate(frame, [22, 28], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
                transform: `scale(${(0.55 + chip * 0.45).toFixed(4)})`,
              }}
            >
              <span
                style={{
                  fontFamily: BODY,
                  fontWeight: 700,
                  fontSize: 27,
                  color: C.ink,
                }}
              >
                @Premium
              </span>
              <CheckMark
                progress={interpolate(frame, [26, 34], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                })}
                size={22}
                color={C.ink}
                stroke={3.4}
              />
            </div>
          </div>
        </div>

        <div style={{ height: 1, background: C.hairline, margin: "30px 0" }} />

        {/* the webhook doing its work, and how long it took */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 30,
          }}
        >
          {STEPS.map((step) => {
            const p = interpolate(frame - step.at, [0, 9], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: EASE_OUT,
            });

            return (
              <span
                key={step.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  fontFamily: BODY,
                  fontSize: 21,
                  color: C.dim,
                  opacity: p,
                }}
              >
                <CheckMark progress={p} size={19} color={C.ink} stroke={3.4} />
                {step.label}
              </span>
            );
          })}

          <span
            style={{
              marginLeft: "auto",
              fontFamily: HEAD,
              fontWeight: 700,
              fontSize: 30,
              color: C.ink,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {seconds.toFixed(1)}s
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
