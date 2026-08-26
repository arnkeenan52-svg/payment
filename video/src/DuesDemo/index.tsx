import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Checkout } from "./Checkout";
import { Endcard } from "./Endcard";
import { RoleDrop } from "./RoleDrop";
import { Scene } from "./Scene";
import { C } from "./theme";

/**
 * Five seconds of Dues: someone pays, the role lands, the mark. The scenes
 * overlap on purpose — each one blurs out underneath the next.
 */
export const DuesDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  // One slow light source crossing the frame, so the flat black never sits
  // completely still behind the cards.
  const glowX = interpolate(frame, [0, durationInFrames], [38, 62]);
  const glowY = interpolate(frame, [0, durationInFrames], [30, 58]);

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at ${glowX.toFixed(
            2,
          )}% ${glowY.toFixed(2)}%, #1b1b1b 0%, ${C.bg} 55%)`,
        }}
      />

      <Scene from={0} durationInFrames={58}>
        <Checkout />
      </Scene>
      <Scene from={52} durationInFrames={52}>
        <RoleDrop />
      </Scene>
      <Scene from={98} durationInFrames={52} holdOut>
        <Endcard />
      </Scene>

      {/* A hairline that fills over the full five seconds. */}
      <AbsoluteFill style={{ justifyContent: "flex-end" }}>
        <div
          style={{
            height: 3,
            width: `${((frame / (durationInFrames - 1)) * 100).toFixed(3)}%`,
            background: C.ink,
            opacity: 0.32,
          }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
