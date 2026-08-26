// Synthesise the hero film's soundtrack.
//
// WHY SYNTHESISED AND NOT GENERATED. Two reasons, and the second is the real one.
// First, Higgsfield — the generation service on hand — cannot do it: its own tool
// states it produces speech only, and its music and SFX models are reserved for a
// game pipeline. Second and more important, a generated clip cannot be scored to
// a cut. Every accent here lands on a frame the picture actually does something:
// the clicks are the exact frames the cursor presses, and the two impacts are the
// two junctions the picture was measured to spend its energy on. That alignment
// is the whole difference between a video with music behind it and a video that
// feels scored.
//
// Deterministic by construction: a seeded PRNG for every noise source, so the
// same commit always renders the same waveform and the mix can be re-cut without
// drifting out of sync with the film.
//
//   node scripts/build-film-audio.mjs        # writes tmp-film-audio.wav
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.FILM_AUDIO || path.join(ROOT, 'tmp-film-audio.wav');
const SR = 48000;
const DUR = 20.0;
const N = Math.round(SR * DUR);

// ── deterministic noise ───────────────────────────────────────────────────────
let seed = 0x9e3779b9;
const rnd = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x80000000 - 1; // -1..1
};

const L = new Float64Array(N);
const R = new Float64Array(N);
const add = (i, l, r) => { if (i >= 0 && i < N) { L[i] += l; R[i] += r; } };

// BAND-LIMITED NOISE, and why every percussive voice here now goes through it.
//
// The first version generated noise as `n - prev`, a one-pole difference. That
// is a +6dB/octave high-pass, so almost all of its energy sat at Nyquist — and
// content at Nyquist is exactly what produces inter-sample peaks. Measured: a
// master whose SAMPLE peak was a comfortable -1.2 dBFS came back with a TRUE
// peak of +1.4 dBFS, 2.6dB of overshoot, which meant the limiter was clamping
// continuously and every dB of makeup gain went straight back out again. Loudness
// would not move: 1.6x and 3.2x of makeup measured 0.8 LU apart.
//
// A real hat or click is a BAND, not a shelf. One pole up, THREE poles down.
//
// Three and not one because one is not nearly enough: a single pole at 11kHz
// attenuates 24kHz by under 7dB, and the source is a sample difference, which
// has already boosted 24kHz by about 12dB relative to flat. The result still
// alternated sample to sample at close to full scale, which is precisely the
// signal that reconstructs to an inter-sample peak far above its own samples —
// measured at +2.8 dBFS true peak from a master whose samples topped out at
// -1.2. Cascading three sections gives 18dB/octave and puts the top of the band
// where the physical object actually stops.
function band(hp, lp) {
  let prev = 0;
  let base = 0;
  const p1 = 0; const p2 = 0; const p3 = 0;
  const lo = [p1, p2, p3];
  const a = 1 - Math.exp((-2 * Math.PI * lp) / SR);
  const b = 1 - Math.exp((-2 * Math.PI * hp) / SR);
  // Three cascaded one-poles each lose gain in band; 1.55 puts the passband
  // back where a single section had it, so every voice's authored level still
  // means what it meant.
  const trim = 1.55;
  return () => {
    const n = rnd();
    const d = n - prev; prev = n;      // high-pass: the difference
    base += b * (d - base);            // ...minus its own low end
    let v = d - base;
    for (let k = 0; k < 3; k += 1) { lo[k] += a * (v - lo[k]); v = lo[k]; }
    return v * trim;
  };
}

// ── voices ────────────────────────────────────────────────────────────────────
// Each writes itself into the buffer at an absolute time in seconds, so the
// arrangement below reads as a cue sheet rather than as DSP.

// The pulse. Pitch drops 150->46Hz in 70ms, which is what makes a sine read as a
// kick rather than as a bass note.
function kick(at, gain = 1) {
  const len = Math.round(SR * 0.30);
  const s = Math.round(at * SR);
  let phase = 0;
  for (let i = 0; i < len; i += 1) {
    const u = i / len;
    const f = 46 + 104 * Math.exp(-u * 22);
    phase += (2 * Math.PI * f) / SR;
    const env = Math.exp(-u * 7.5) * gain;
    const v = Math.sin(phase) * env * 0.70;
    add(s + i, v, v);
  }
}

// Filtered noise. The one-pole difference is a cheap high-pass — enough to keep
// a hat out of the kick's way without a real filter design.
function hat(at, gain = 1, decay = 0.030) {
  const len = Math.round(SR * decay * 3);
  const s = Math.round(at * SR);
  const nz = band(6000, 11000);
  for (let i = 0; i < len; i += 1) {
    const v = nz();
    const env = Math.exp(-(i / SR) / decay) * gain * 0.42;
    add(s + i, v * env, v * env * 0.92);
  }
}

// A UI click. Two components, because a real one has both: a tiny broadband
// transient (the contact) and a short pitched tick (the mechanism).
function click(at, gain = 1) {
  const s = Math.round(at * SR);
  const tlen = Math.round(SR * 0.010);
  const nz = band(1800, 9000);
  for (let i = 0; i < tlen; i += 1) {
    const env = Math.exp(-(i / tlen) * 6) * gain * 2.4;
    const v = nz() * env;
    add(s + i, v, v * 0.86);
  }
  const plen = Math.round(SR * 0.035);
  for (let i = 0; i < plen; i += 1) {
    const u = i / plen;
    const env = Math.exp(-u * 16) * gain * 0.30;
    const v = Math.sin((2 * Math.PI * 2550 * i) / SR) * env;
    add(s + i, v * 0.9, v);
  }
}

// The two big moments. Noise body over a sub boom — the boom is what gives an
// impact weight; the noise alone is just a crash.
function impact(at, gain = 1) {
  const s = Math.round(at * SR);
  const len = Math.round(SR * 1.6);
  const nz = band(300, 4200);
  let phase = 0;
  for (let i = 0; i < len; i += 1) {
    const u = i / len;
    const hp = nz();
    const nEnv = Math.exp(-u * 12) * gain * 1.5;
    const f = 34 + 46 * Math.exp(-u * 9);
    phase += (2 * Math.PI * f) / SR;
    const bEnv = Math.exp(-u * 4.2) * gain * 0.72;
    const v = hp * nEnv + Math.sin(phase) * bEnv;
    add(s + i, v, v * 0.97);
  }
}

// Tension into an impact. Rising band of noise plus a rising tone.
function riser(at, dur, gain = 1) {
  const s = Math.round(at * SR);
  const len = Math.round(SR * dur);
  const nz = band(700, 7000);
  let phase = 0;
  for (let i = 0; i < len; i += 1) {
    const u = i / len;
    const hp = nz();
    const env = Math.pow(u, 2.2) * gain * 0.70;
    phase += (2 * Math.PI * (220 + 1500 * Math.pow(u, 2.4))) / SR;
    const v = hp * env + Math.sin(phase) * env * 0.30;
    add(s + i, v, v * 0.95);
  }
}

// A held low tone under the whole film, so silence is never actually silent.
function pad(at, dur, freq, gain) {
  const s = Math.round(at * SR);
  const len = Math.round(SR * dur);
  for (let i = 0; i < len; i += 1) {
    const u = i / len;
    const env = Math.min(1, u * 8) * Math.min(1, (1 - u) * 6) * gain;
    const v = (Math.sin((2 * Math.PI * freq * i) / SR) * 0.6
      + Math.sin((2 * Math.PI * freq * 1.5 * i) / SR) * 0.2) * env;
    add(s + i, v, v * 0.94);
  }
}

// The backbeat. A clap is what turns a pulse into a beat: three noise bursts
// 11ms apart (that is what makes it read as hands rather than as a snare) over
// a short tail.
function clap(at, gain = 1) {
  const s = Math.round(at * SR);
  [0, 0.011, 0.022].forEach((off, n) => {
    const st = s + Math.round(off * SR);
    const len = Math.round(SR * 0.030);
    const nz = band(1200, 7500);
    for (let i = 0; i < len; i += 1) {
      const env = Math.exp(-(i / SR) / 0.010) * gain * (n === 2 ? 1.25 : 0.85);
      const v = nz() * env;
      add(st + i, v, v * 1.06);
    }
  });
  const tl = Math.round(SR * 0.20);
  const tail = band(900, 5200);
  for (let i = 0; i < tl; i += 1) {
    const env = Math.exp(-(i / SR) / 0.055) * gain * 0.48;
    const v = tail() * env;
    add(s + Math.round(0.022 * SR) + i, v, v * 1.05);
  }
}

// A short sub note under each downbeat, so the low end moves rather than just
// thumping. Two octaves below the pad.
function bass(at, freq, dur, gain = 1) {
  const s = Math.round(at * SR);
  const len = Math.round(SR * dur);
  let phase = 0;
  for (let i = 0; i < len; i += 1) {
    const u = i / len;
    phase += (2 * Math.PI * freq) / SR;
    const env = Math.min(1, u * 40) * Math.exp(-u * 2.6) * gain * 0.30;
    const v = (Math.sin(phase) + Math.sin(phase * 2) * 0.14) * env;
    add(s + i, v, v);
  }
}

// One soft bell per sale alert.
function chime(at, freq, gain = 1) {
  const s = Math.round(at * SR);
  const len = Math.round(SR * 0.9);
  for (let i = 0; i < len; i += 1) {
    const u = i / len;
    const env = Math.exp(-u * 6.5) * gain * 0.26;
    const v = (Math.sin((2 * Math.PI * freq * i) / SR)
      + Math.sin((2 * Math.PI * freq * 2.01 * i) / SR) * 0.35) * env;
    add(s + i, v * 0.95, v);
  }
}

// ── the cue sheet ─────────────────────────────────────────────────────────────
// 120 BPM on the ABSOLUTE grid: a beat every 0.5s counted from zero, a bar every
// 2.0s, and the film's 20.0s is exactly ten bars. The burst at 14.00s is the
// downbeat of bar 8 with no nudging, which is why this tempo and not another.
//
// THE PULSE IS ON THE GRID, and it was not. It used to start at 1.15 — the frame
// the store card lands — and march in 1.0s steps from there, which put every
// kick 0.15s off the very grid the tempo was chosen for and left the burst
// impact 0.85s after the last kick instead of one clean beat after it. Picture
// cues and musical cues are different things: a CLICK belongs on the frame the
// cursor presses, wherever that falls, and a KICK belongs on the beat. Mixing
// the two rules is what makes a soundtrack feel stuck on rather than scored.
const BEAT = 0.5;
const BAR = 2.0;
const on = (from, to, every, fn) => { for (let t = from; t < to - 1e-6; t += every) fn(t); };

// The bed. Never actually silent, so the two moments of real silence read.
pad(0.0, 6.2, 55, 0.11);
pad(5.4, 9.4, 55, 0.13);
pad(15.6, 4.4, 73.4, 0.10);

// ── drums ───────────────────────────────────────────────────────────────────
// Built in four stages so the arrangement grows with the film rather than
// running flat under it: pulse alone under the first card, backbeat from the
// Stripe key, sixteenth hats from the theming beat, and then a hole.
//
//   1.50 - 3.50   kick only          the store card
//   3.50 - 5.60   + clap on 2 and 4  the key
//   5.60 - 11.85  + bass on the bar  product and theming
//  11.85 - 13.50  full               the storefront
//  13.50 - 14.00  NOTHING but the riser — the pre-drop
//  14.00          impact, and the rhythm stops dead
//  16.00 - 18.00  a bare pulse under the alerts
on(1.50, 13.51, BAR / 2, (t) => kick(t, t < 3.5 ? 0.78 : 1.0));
on(4.00, 13.51, BAR / 2, (t) => kick(t + BEAT * 1.5, 0.40));   // the pickup kick
on(3.50, 13.51, BAR, (t) => clap(t + BEAT, t < 5.6 ? 0.75 : 1.0));
on(3.50, 13.51, BEAT / 2, (t) => hat(t, Math.abs((t / BEAT) % 1) < 0.01 ? 0.55 : 0.85));
// Sixteenth accents once the theming beat starts, which is where the picture
// gets busiest — the ear follows density.
on(7.90, 11.90, BEAT / 4, (t) => hat(t, 0.34, 0.018));
on(5.60, 13.51, BAR, (t) => bass(t, 55, 1.1, t < 11.85 ? 0.9 : 1.0));

// ── clicks ──────────────────────────────────────────────────────────────────
// Each is the exact frame the cursor presses in the picture. These do NOT sit on
// the grid and must not: they belong to the hand, not to the tempo.
//    2.45  store   "Create store"
//    4.82  stripe  the key slab
//    8.95  theme   Midnight tile   (0.10s before the colour moves — cause, effect)
//   10.10  theme   Ivory tile
//   10.75  theme   the radius slider GRAB, softer because a drag is not a click
//   11.30  theme   the RELEASE at the end of the drag, softer still
//   13.57  shop    "Pay with card", the press that ignites the burst
[2.45, 4.82, 8.95, 10.10, 13.57].forEach((t) => click(t));
click(10.75, 0.5);
click(11.30, 0.34);

// ── the two big moments ─────────────────────────────────────────────────────
// The white wash at 5.60 and the burst at 14.00 — the two junctions the picture
// was measured to spend its energy on.
impact(5.60, 0.62);
riser(12.85, 1.15, 1.0);
impact(14.00, 1.0);

// ── the alerts ──────────────────────────────────────────────────────────────
// One bell per card, a fifth apart, rising. Bells are picture cues like the
// clicks, so they land on the cards and not on the beat; the kick underneath
// them is back on the grid.
[16.30, 16.90, 17.50, 18.10].forEach((t, i) => chime(t, 587.33 * Math.pow(2, i / 12) * (i > 1 ? 1.5 : 1), 1));
on(16.00, 18.51, BAR / 2, (t) => kick(t, 0.62));
bass(16.00, 73.4, 1.6, 0.7);

impact(18.85, 0.48);

// ── master ────────────────────────────────────────────────────────────────────
// The mix before this stage measured -21.2 LUFS integrated with a true peak
// already at -0.2 dBFS: quiet AND out of headroom at the same time, which is
// what a very high crest factor looks like. Two impacts and a fistful of clicks
// own all the peak room, so simply turning it up clips them and turning it down
// buries everything else.
//
// So: compress the bus gently first, THEN normalise. 2.5:1 above -18 dBFS with a
// 12ms attack — slow enough that a click's first millisecond gets through
// untouched, which is the whole point of having clicks — and a 180ms release so
// the pulse breathes rather than pumping.
const THRESH = Math.pow(10, -18 / 20);
const RATIO = 2.5;
const ATK = Math.exp(-1 / (SR * 0.012));
const REL = Math.exp(-1 / (SR * 0.180));
let env = 0;
for (let i = 0; i < N; i += 1) {
  const x = Math.max(Math.abs(L[i]), Math.abs(R[i]));
  env = x > env ? ATK * env + (1 - ATK) * x : REL * env + (1 - REL) * x;
  if (env > THRESH) {
    const g = (THRESH + (env - THRESH) / RATIO) / env;
    L[i] *= g; R[i] *= g;
  }
}

// MAKEUP, then a real look-ahead limiter. Not a tanh curve across the whole
// mix: tanh is a soft clipper, and driving a mix into one to make it louder
// distorts everything in proportion to how loud it already was — which in this
// mix means the clicks, the one thing the whole soundtrack exists to place.
//
// A limiter instead: 6ms of look-ahead, gain taken from the loudest sample in
// the window AHEAD so the reduction is already in place before the transient
// arrives, and a 90ms release. Anything under the ceiling is not touched at all.
//
// The ceiling is -2.5 dBFS, not 0 and not -1. Two reasons, both measured. The
// AAC encoder downstream is lossy and its reconstruction can overshoot the
// samples it was handed. And even after the noise is properly band-limited this
// material still reconstructs about 1.5dB above its own samples — checked by
// resampling the master to 192kHz and taking the peak of that — so -2.5 dBFS of
// sample ceiling is what actually lands under -1.0 dBFS true peak.
// 2.0 is not a taste decision: it is the value that measures -15.8 LUFS
// integrated at -1.0 dBFS true peak, which is where web video sits. Verified
// with ffmpeg's ebur128 and by resampling the master to 192kHz for the peak,
// and it is overridable with FILM_AUDIO_MAKEUP so the next person can re-derive
// it rather than trust this comment.
const MAKEUP = Number(process.env.FILM_AUDIO_MAKEUP || 2.0);
const CEIL = 0.75;
const LA = Math.round(SR * 0.006);
const LREL = Math.exp(-1 / (SR * 0.090));

for (let i = 0; i < N; i += 1) { L[i] *= MAKEUP; R[i] *= MAKEUP; }

// The gain each sample would need on its own...
const req = new Float64Array(N);
for (let i = 0; i < N; i += 1) {
  const x = Math.max(Math.abs(L[i]), Math.abs(R[i]));
  req[i] = x > CEIL ? CEIL / x : 1;
}

// ...and the minimum of that over the look-ahead WINDOW. The window matters:
// the first version took a running minimum all the way to the end of the file,
// which meant every sample was scaled by the quietest gain the whole track ever
// needed. That is not a limiter, it is normalisation to the single loudest
// transient — and it is why makeup gain did nothing at all, 1.6x and 3.2x
// measuring 0.8 LU apart.
//
// van Herk: per-block running minima forward and backward, then one min of two
// lookups per sample. O(N) whatever the window size.
const need = new Float64Array(N);
{
  const W = LA;
  const pre = new Float64Array(N);
  const suf = new Float64Array(N);
  for (let i = 0; i < N; i += 1) pre[i] = i % W === 0 ? req[i] : Math.min(pre[i - 1], req[i]);
  for (let i = N - 1; i >= 0; i -= 1) {
    suf[i] = (i + 1) % W === 0 || i === N - 1 ? req[i] : Math.min(suf[i + 1], req[i]);
  }
  for (let i = 0; i < N; i += 1) need[i] = Math.min(suf[i], pre[Math.min(N - 1, i + W - 1)]);
}

// Attack is instantaneous because the look-ahead has already seen the transient;
// release is the only smoothing, so nothing pumps on the way in.
let g = 1;
for (let i = 0; i < N; i += 1) {
  const target = need[i];
  g = target < g ? target : Math.min(1, LREL * g + (1 - LREL) * target);
  L[i] *= g; R[i] *= g;
}

let peak = 0;
for (let i = 0; i < N; i += 1) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));

const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);

// A short fade at each end so the loop point cannot click.
const FADE = Math.round(SR * 0.035);
for (let i = 0; i < N; i += 1) {
  const edge = Math.min(1, i / FADE, (N - 1 - i) / FADE);
  const l = L[i] * edge;
  const r = R[i] * edge;
  buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(l * 32767))), 44 + i * 4);
  buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(r * 32767))), 46 + i * 4);
}
fs.writeFileSync(OUT, buf);
console.log(`[audio] ${OUT} · ${DUR}s · ${SR}Hz stereo · makeup x${MAKEUP} · limited, peak ${peak.toFixed(4)}`);
