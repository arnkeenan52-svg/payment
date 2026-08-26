import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Caption, CheckMark, Tag } from "./parts";
import { BODY, C, EASE_OUT, HEAD } from "./theme";

const PRICE = 59.99;
const PAD = 44;
const CARD_W = 760;

/** The pointer that presses the button, drawn rather than imported. */
const Cursor: React.FC<{ readonly opacity: number }> = ({ opacity }) => (
  <svg
    width={34}
    height={34}
    viewBox="0 0 24 24"
    style={{ opacity, filter: "drop-shadow(0 2px 7px rgba(0,0,0,0.65))" }}
  >
    <path
      d="M5 2.5l13.5 8.2-6 1.1 3 6.4-2.6 1.2-3-6.4-4.9 3.6z"
      fill={C.solid}
      stroke={C.bg}
      strokeWidth={1.8}
      strokeLinejoin="round"
    />
  </svg>
);

export const Checkout: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const card = spring({
    frame: frame - 2,
    fps,
    config: { damping: 200, mass: 0.8 },
  });

  // The price is interpolated, not typed out: one number, counted up the way
  // the dashboard counts revenue.
  const price = interpolate(frame, [12, 36], [0, PRICE], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_OUT,
  });

  const button = spring({
    frame: frame - 16,
    fps,
    config: { damping: 200, mass: 0.6 },
  });

  // Cursor flies in, lands on the button at frame 34, presses, and the label
  // flips to the paid state.
  const travel = interpolate(frame, [22, 34], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_OUT,
  });
  const press = interpolate(frame, [34, 37, 40], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const labelOut = interpolate(frame, [37, 41], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_OUT,
  });
  const paid = interpolate(frame, [41, 47], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_OUT,
  });

  const rowIn = (delay: number) =>
    interpolate(frame - delay, [0, 12], [0, 1], {
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
      <Caption text="They pay on your store page." delay={4} />

      <div
        style={{
          width: CARD_W,
          padding: PAD,
          borderRadius: 26,
          background: C.panel,
          border: `1px solid ${C.edge}`,
          boxShadow: "0 40px 90px rgba(0,0,0,0.55)",
          opacity: card,
          transform: `translateY(${((1 - card) * 60).toFixed(2)}px)`,
        }}
      >
        {/* store header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            opacity: rowIn(6),
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 11,
              background: C.raised,
              border: `1px solid ${C.edge}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: HEAD,
              fontWeight: 700,
              fontSize: 19,
              color: C.ink,
            }}
          >
            T
          </div>
          <span
            style={{
              fontFamily: BODY,
              fontWeight: 700,
              fontSize: 22,
              color: C.ink,
            }}
          >
            tradeleaks
          </span>
          <span
            style={{
              fontFamily: BODY,
              fontSize: 19,
              color: C.faint,
              marginLeft: "auto",
            }}
          >
            dues.gg/tradeleaks
          </span>
        </div>

        <div
          style={{
            height: 1,
            background: C.hairline,
            margin: "30px 0",
            opacity: rowIn(8),
          }}
        />

        {/* product + price */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            opacity: rowIn(10),
            transform: `translateY(${((1 - rowIn(10)) * 14).toFixed(2)}px)`,
          }}
        >
          <div>
            <div
              style={{
                fontFamily: HEAD,
                fontWeight: 700,
                fontSize: 46,
                letterSpacing: "-0.02em",
                color: C.ink,
              }}
            >
              Premium
            </div>
            <div
              style={{
                fontFamily: BODY,
                fontSize: 23,
                color: C.dim,
                marginTop: 6,
              }}
            >
              All courses lifetime
            </div>
          </div>
          <div
            style={{
              fontFamily: HEAD,
              fontWeight: 700,
              fontSize: 74,
              letterSpacing: "-0.03em",
              color: C.ink,
              fontVariantNumeric: "tabular-nums",
              lineHeight: 1,
            }}
          >
            ${price.toFixed(2)}
          </div>
        </div>

        {/* pay button, with the cursor that presses it */}
        <div style={{ position: "relative", marginTop: 34 }}>
          <div
            style={{
              height: 76,
              borderRadius: 15,
              background: C.solid,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              opacity: button,
              transform: `translateY(${((1 - button) * 14).toFixed(2)}px) scale(${(
                0.98 +
                button * 0.02 -
                press * 0.015
              ).toFixed(4)})`,
            }}
          >
            <span
              style={{
                position: "absolute",
                fontFamily: HEAD,
                fontWeight: 700,
                fontSize: 27,
                color: C.solidInk,
                opacity: 1 - labelOut,
                transform: `translateY(${(labelOut * -16).toFixed(2)}px)`,
              }}
            >
              Pay ${price.toFixed(2)}
            </span>
            <span
              style={{
                position: "absolute",
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontFamily: HEAD,
                fontWeight: 700,
                fontSize: 27,
                color: C.solidInk,
                opacity: paid,
                transform: `translateY(${((1 - paid) * 16).toFixed(2)}px)`,
              }}
            >
              <CheckMark progress={paid} size={26} color={C.solidInk} />
              Paid
            </span>
          </div>

          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              transform: `translate(${(118 + travel * 250).toFixed(1)}px, ${(
                12 +
                travel * 190
              ).toFixed(1)}px)`,
            }}
          >
            <Cursor
              opacity={interpolate(frame, [20, 26, 46, 52], [0, 1, 1, 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              })}
            />
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 26,
            opacity: rowIn(18),
          }}
        >
          <span style={{ fontFamily: BODY, fontSize: 19, color: C.faint }}>
            Card, Apple Pay, Google Pay
          </span>
          <Tag color={C.stripe}>Powered by Stripe</Tag>
        </div>
      </div>
    </AbsoluteFill>
  );
};
