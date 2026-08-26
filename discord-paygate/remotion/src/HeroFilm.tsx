import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { Plate } from './Plate';
import { AUTHOR_FPS, BRAND } from './teardown';

/**
 * THE FILM.
 *
 * Time is quantised to the 25fps authoring grid before anything reads it — see
 * teardown.ts. Every component below takes AUTHORED SECONDS, never a frame
 * number, so the container's fps can change without moving a single cue.
 */
export const HeroFilm: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // The 5:6 pulldown, applied once at the top. Everything downstream is on the
  // 40ms grid whatever the container is doing.
  const t = Math.round((frame / fps) * AUTHOR_FPS) / AUTHOR_FPS;

  return (
    <AbsoluteFill style={{ background: '#fff', fontFamily: "'Dues Sans', 'DM Sans', system-ui, sans-serif", color: BRAND.ink }}>
      <Plate />
      <Title t={t} />
    </AbsoluteFill>
  );
};

/**
 * The opening title. ONE TEXT MOTIF, REUSED — a left-to-right reveal with a
 * soft blurred zone behind the front, at a constant rate. The reference uses
 * exactly two text treatments in twenty seconds; this is the primary one and it
 * is the same gesture the card headings use.
 */
const Title: React.FC<{ t: number }> = ({ t }) => {
  const text = 'Sell access to your Discord';
  const chars = [...text];
  // THE ACCELERATING DRIFT. There is no separate exit animation anywhere in
  // this film: the scene's own slow drift keeps accelerating until the
  // composition leaves, and the cut lands while it is still speeding up.
  const drift = Math.pow(clamp01((t - 0.30) / 0.86), 3.1);

  return (
    <div
      style={{
        position: 'absolute', inset: 0,
        transform: `translateY(${(-300 * drift).toFixed(1)}px) scale(${(1 + 0.05 * drift).toFixed(4)})`,
        filter: drift > 0.45 ? `blur(${((drift - 0.45) * 46).toFixed(1)}px)` : 'none',
        opacity: t < 1.16 ? 1 : 0,
      }}
    >
      <h1 style={{
        position: 'absolute', left: 0, right: 0, top: 402, margin: 0, textAlign: 'center',
        fontFamily: "'Dues Grotesk', 'Space Grotesk', system-ui, sans-serif",
        fontWeight: 600, fontSize: 108, letterSpacing: '-0.025em',
      }}>
        {chars.map((c, i) => {
          const p = clamp01((t - 0.12 - i * 0.028) / 0.10);
          return (
            <span key={i} style={{
              display: 'inline-block', whiteSpace: 'pre',
              opacity: p,
              filter: p < 1 ? `blur(${(9 * (1 - p)).toFixed(2)}px)` : 'none',
              transform: `translateX(${(-14 * (1 - outCubic(p))).toFixed(2)}px)`,
            }}>{c === ' ' ? ' ' : c}</span>
          );
        })}
      </h1>
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 556, textAlign: 'center',
        fontSize: 32, color: BRAND.dim, opacity: clamp01((t - 0.46) / 0.24),
      }}>
        Your Stripe account. Your members. Zero platform fee.
      </div>
    </div>
  );
};

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x: number) => 1 - Math.pow(1 - x, 3);
