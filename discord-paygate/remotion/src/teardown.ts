/**
 * WHAT THE REFERENCE ACTUALLY DOES, AS NUMBERS.
 *
 * Every constant below was measured off all 600 frames of the reference hero
 * film, not chosen. They are here rather than in comments scattered through the
 * components because five previous cuts drifted away from them one plausible
 * decision at a time, and a number in a shared module is harder to drift from
 * than a number in someone's head.
 *
 * THE HEADLINE. The reference is 640x360 at 383kbps and reads as the better
 * film than our 1080p at 1986kbps. Resolution was never the variable:
 *
 *     reference   mean luma 177.2   mean saturation 0.195
 *     our v5      mean luma  64.0   mean saturation 0.043
 *
 * 23% of our frames sat below luma 40, which is exactly where 8-bit h264 stops
 * being able to hold a gradient. Our background alone measured saturation
 * 0.001 — arithmetically no colour at all.
 */

/** The reference's master is 25fps, conformed 5:6 into a 30fps container. Every
 *  frame where (f mod 6 == 2) carries a mean |diff| of 0.15 against its
 *  predecessor while every other phase carries ~22. Authoring at 30 against a
 *  25fps reference makes our motion read faster and busier at identical
 *  nominal durations, which is part of why five cuts felt cheap. */
export const AUTHOR_FPS = 25;
export const CONTAINER_FPS = 30;
export const DURATION_S = 20;

/** Acceptance thresholds. A render that misses these is not shippable, whatever
 *  it looks like on the machine that made it. */
export const TARGET = {
  meanLuma: 175,        // reference 177.2
  meanSaturation: 0.19, // reference 0.195
  maxDarkFraction: 0.15, // reference: 12% of frames below luma 100
  minFrameLuma: 40,     // the reference never goes near black outside its one dark beat
} as const;

/**
 * THE PLATE. Built the way the reference builds its coral one: ONE CHANNEL HELD
 * NEARLY FIXED while the other two swing. Theirs pins R to 0xEE-0xF5 while G and
 * B travel 0x9F-0xE6 — that is what gives a mesh real chroma without going
 * muddy. Ours pins the blue end, because Dues is a blurple brand.
 *
 * Measured through the real encoder: luma 204.4, saturation 0.217, widest flat
 * band 46px. The ground it replaces measured 23.8 / 0.001 / 590px.
 *
 * IT NEVER MOVES. The reference's plate is pixel-identical across the film's
 * biggest cut (max |diff| 0) and drifts by 4-9 across twenty seconds. Only
 * content moves over it, and that is what buys back the bitrate.
 */
export const PLATE = {
  p1: '#DCDEFB', p2: '#C2C8FA', p3: '#A7B0F7', p4: '#8E99F5', cream: '#EFF1FF',
} as const;

export const PLATE_CSS = [
  `radial-gradient(46% 34% at 86% 5%,  ${PLATE.cream} 0%, rgba(239,241,255,0) 58%)`,
  `radial-gradient(58% 48% at 10% 96%, ${PLATE.p3} 0%, rgba(167,176,247,0) 60%)`,
  `radial-gradient(78% 70% at 4% 46%,  ${PLATE.p4} 0%, rgba(142,153,245,0) 62%)`,
  `radial-gradient(82% 72% at 98% 94%, ${PLATE.p4} 0%, rgba(142,153,245,0) 58%)`,
  `linear-gradient(122deg, ${PLATE.p4} 0%, ${PLATE.p2} 30%, ${PLATE.cream} 50%, ${PLATE.p1} 68%, ${PLATE.p3} 100%)`,
].join(', ');

/**
 * THE ONE DARK BEAT. The reference goes dark exactly once, for about two
 * seconds, and when it does the CHROMA GOES UP, not down: saturation 0.42, a
 * deep navy. Our previous cuts dropped luma and chroma together, which is the
 * whole defect in one sentence.
 *
 * It is a FLAT FILL, never a gradient. The reference does not solve
 * dark-gradient banding — it refuses to have a dark gradient. A single row of
 * its navy carries exactly one unique luma value across all 640px.
 */
export const DARK = {
  fill: '#131A3D',   // saturation 0.69
  ink: '#EEF0FF',
  dim: '#8E96C8',
  rule: '#3A4270',
} as const;

/** Brand. The climax must introduce no new colour: the burst is blurple, cream
 *  and near-black, all three of which the film already owns by then. */
export const BRAND = {
  blurple: '#5865f2',
  blurpleLo: '#8B96F8',
  blurpleHi: '#4752C4',
  stripe: '#635bff',
  gold: '#F2B03C',
  ink: '#14162E',
  dim: '#6B6A80',
  card: '#FFFFFF',
  cursorOutline: '#F5EFE4',
} as const;

/**
 * THE SHIPPED THEME PRESETS, lifted from public/dashboard.js. The film may not
 * invent a theme Dues does not have. The sequence deliberately opens on
 * Midnight — the achromatic 'before' the beat exists to destroy — and lands on
 * Blurple, so the burst inherits its palette rather than introducing one.
 */
export const THEMES = [
  { key: 'midnight', name: 'Midnight', bg: '#0a0a0a', panel: '#101010', text: '#f5f5f4', accent: '#ededed' },
  { key: 'ivory', name: 'Ivory', bg: '#faf9f7', panel: '#ffffff', text: '#161616', accent: '#161616' },
  { key: 'blurple', name: 'Blurple', bg: '#0b0d1f', panel: '#131735', text: '#eceefc', accent: '#8b96f8' },
  { key: 'emerald', name: 'Emerald', bg: '#071209', panel: '#0d2012', text: '#e9f6ec', accent: '#22c55e' },
  { key: 'crimson', name: 'Crimson', bg: '#150a0d', panel: '#231016', text: '#f8ecee', accent: '#ef4466' },
  { key: 'gold', name: 'Gold', bg: '#131008', panel: '#211b0e', text: '#f8f3e6', accent: '#f2b03c' },
] as const;

/**
 * CRAFT RULES. Each of these is a thing the reference does that our cuts did
 * not, found by measurement rather than by looking.
 */
export const RULES = [
  'SHADOWS ARE SOLID OFFSET SLABS, NEVER BLURS. Nothing in the reference uses a blurred drop shadow. Slabs compress; blurred shadows over a gradient are exactly where 8-bit banding lives.',
  'SETTLES ARE CRITICALLY DAMPED EXPONENTIALS WITH NO OVERSHOOT. The reference\'s hero mock fits 1-e^(-0.478n) to within a pixel at every sample. The premium feel is the TIGHTNESS of the settle, never springiness. Budget exactly one overshoot in the whole film.',
  'ONE TEXT MOTIF, REUSED. Two text treatments in twenty seconds, not six. The primary is a left-to-right reveal with a soft blurred zone behind the front, at a constant rate.',
  'NOTHING SHARES A START FRAME. The reference\'s dark-beat payoff has five separate start frames inside 0.27s. That asymmetry is what stops it reading as a CSS transition.',
  'CUT ON THE ACCELERATION, NEVER ON THE DECELERATION. The whip\'s per-frame displacement is still GROWING on the frame before the transition lands. That is what hides the cut.',
  'THE UI ANSWERS ON THE FIRST PRESS-DOWN FRAME, except the film\'s very first click, which holds 0.20s with nothing changing. That dwell is what makes the first click read as intentional.',
  'RECOLOUR BY STRAIGHT RGB LERP, NOT HUE ROTATION. The reference\'s recolour passes through magenta; a hue rotation would swing through the wrong half of the wheel and look cheap.',
  'STACK ARRIVALS ON AN ACCELERATING CADENCE. The reference\'s toasts land at intervals of 0.467s, 0.400s, 0.333s. Money arriving faster and faster is told entirely through the interval.',
  'END ON A REAL FREEZE. The reference settles then holds 1.2s at a per-frame delta of exactly 0.0000.',
] as const;

/**
 * THE CURSOR DOCTRINE, and both halves of it were got wrong before.
 *
 * IT IS ONE OBJECT WITH ONE CONTINUOUS TRAJECTORY. It is not always on screen —
 * the reference's own pointer is visible for 53% of its runtime, in three spans
 * — but every entrance is continuous with the previous exit, it is already
 * moving when it appears, and it never fades in on the spot.
 *
 * ITS TARGETS ARE MEASURED, NEVER TYPED. Hand-typed waypoints put six of nine
 * of our presses outside the element they were pressing, by up to 185px. The
 * button responded anyway every time, which is why five review passes missed it.
 *
 * IT NEVER STOPS DEAD BETWEEN ACTIONS. Per-leg easing decelerated it to a full
 * stop at every waypoint — a stutter every 0.4s. One spline with C1 continuity
 * across every junction; it slows only onto a press and through a drag.
 *
 * AT THE CLIMAX IT DOES NOT EXIT. Least-squares fit of the reference's ray
 * convergence lands at (316.5, 250.1) — exactly where its pointer was resting.
 * The cursor becomes the burst.
 */
export const CURSOR = {
  onScreenFraction: 0.535,
  maxAccelSpike: 2600, // px/s^2, frame to frame
} as const;
