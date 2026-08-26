import React from "react";
import {
  AbsoluteFill,
  interpolate,
  Sequence,
  useCurrentFrame,
} from "remotion";
import { EASE_IN_OUT, EASE_OUT } from "./theme";

const IN = 8;
const OUT = 10;

const SceneBody: React.FC<{
  readonly durationInFrames: number;
  readonly holdOut: boolean;
  readonly children: React.ReactNode;
}> = ({ durationInFrames, holdOut, children }) => {
  const frame = useCurrentFrame();

  const enter = interpolate(frame, [0, IN], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_OUT,
  });
  const exit = holdOut
    ? 0
    : interpolate(
        frame,
        [durationInFrames - OUT, durationInFrames],
        [0, 1],
        {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: EASE_IN_OUT,
        },
      );

  // A scene arrives and leaves through blur, the way the site's hero film cuts.
  // Nothing here hard-cuts: neighbouring scenes overlap and cross-dissolve.
  const blur = 14 * (1 - enter) + 10 * exit;
  const scale = 1 + 0.04 * (1 - enter) - 0.02 * exit;

  return (
    <AbsoluteFill
      style={{
        opacity: enter * (1 - exit),
        filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined,
        transform: `scale(${scale.toFixed(4)})`,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

export const Scene: React.FC<{
  readonly from: number;
  readonly durationInFrames: number;
  /** The end card holds to the last frame instead of blurring back out. */
  readonly holdOut?: boolean;
  readonly children: React.ReactNode;
}> = ({ from, durationInFrames, holdOut = false, children }) => (
  <Sequence from={from} durationInFrames={durationInFrames} layout="none">
    <SceneBody durationInFrames={durationInFrames} holdOut={holdOut}>
      {children}
    </SceneBody>
  </Sequence>
);
