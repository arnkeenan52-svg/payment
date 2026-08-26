import React from 'react';
import { PLATE_CSS } from './teardown';

/**
 * THE GROUND, and the single most important thing in the film.
 *
 * It takes NO props that vary with the frame, and that is the point. The
 * reference's plate is pixel-identical across the film's biggest cut; only
 * content moves over it. A camera move applied to the whole frame — including a
 * global push-in on the background — throws away the entire bitrate argument,
 * which is how a 383kbps file ends up looking better than a 1986kbps one.
 */
export const Plate: React.FC = () => (
  <>
    <div style={{ position: 'absolute', inset: 0, background: PLATE_CSS }}>
      {/* Two faint arcs, as the reference overlays on its own plate: something
          for the eye to hold that costs nothing because it never moves. */}
      <div style={arc(-16, -38, 96, 150, -13)} />
      <div style={arc(34, -24, 104, 158, 9)} />
    </div>
    <Dither />
  </>
);

const arc = (l: number, t: number, w: number, h: number, rot: number): React.CSSProperties => ({
  position: 'absolute', left: `${l}%`, top: `${t}%`, width: `${w}%`, height: `${h}%`,
  borderRadius: '50%', border: '1px solid rgba(120,132,240,0.10)',
  transform: `rotate(${rot}deg)`,
});

/**
 * THE DITHER, and it is STATIC — the same tile on every frame.
 *
 * Measured, because the intuitive choice is the expensive one. Temporal grain
 * narrows the widest flat band to 12px but costs 8-17x the bitrate, since noise
 * that differs every frame is noise the encoder must pay for in full:
 *
 *     none      widest band 269px    468 kbps
 *     noise=2   widest band  97px   3773 kbps
 *     noise=4   widest band  12px   7975 kbps
 *
 * One fixed pattern costs a fraction of that and still cuts the widest band
 * from 269px to 183px, and to 46px on the plate as shipped.
 */
const Dither: React.FC = () => (
  <svg
    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
             opacity: 0.055, pointerEvents: 'none', mixBlendMode: 'overlay' }}
  >
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves={3} stitchTiles="stitch" />
      <feColorMatrix type="saturate" values="0" />
    </filter>
    <rect width="100%" height="100%" filter="url(#grain)" />
  </svg>
);
