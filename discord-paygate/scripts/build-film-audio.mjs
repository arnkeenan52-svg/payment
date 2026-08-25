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
  let prev = 0;
  for (let i = 0; i < len; i += 1) {
    const n = rnd();
    const hp = n - prev; prev = n;
    const env = Math.exp(-(i / SR) / decay) * gain * 0.10;
    add(s + i, hp * env, hp * env * 0.92);
  }
}

// A UI click. Two components, because a real one has both: a tiny broadband
// transient (the contact) and a short pitched tick (the mechanism).
function click(at, gain = 1) {
  const s = Math.round(at * SR);
  const tlen = Math.round(SR * 0.010);
  let prev = 0;
  for (let i = 0; i < tlen; i += 1) {
    const n = rnd();
    const hp = n - prev; prev = n;
    const env = Math.exp(-(i / tlen) * 6) * gain * 0.62;
    add(s + i, hp * env, hp * env * 0.86);
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
  let prev = 0;
  let phase = 0;
  for (let i = 0; i < len; i += 1) {
    const u = i / len;
    const n = rnd();
    const hp = n - prev; prev = n;
    const nEnv = Math.exp(-u * 12) * gain * 0.30;
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
  let prev = 0;
  let phase = 0;
  for (let i = 0; i < len; i += 1) {
    const u = i / len;
    const n = rnd();
    const hp = n - prev; prev = n;
    const env = Math.pow(u, 2.2) * gain * 0.16;
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
// 120 BPM: a beat every 0.5s, a bar every 2.0s, and the film's 20.0s is exactly
// ten bars. The burst at 14.00s lands on the downbeat of bar 8 with no nudging,
// which is why this tempo and not another.
const BEAT = 0.5;

pad(0.0, 6.0, 55, 0.11);
pad(5.4, 9.2, 55, 0.13);
pad(15.6, 4.4, 73.4, 0.10);

// The pulse enters with the first card and stops dead at the burst: the loudest
// moment in the film is a hole in the rhythm, not more of it.
for (let t = 1.15; t < 13.98; t += BEAT * 2) {
  kick(t, t < 3.4 ? 0.75 : 1.0);
  if (t >= 3.4) kick(t + BEAT * 1.5, 0.42);
}
for (let t = 3.40; t < 13.98; t += BEAT / 2) {
  hat(t, Math.abs((t / BEAT) % 2) < 0.01 ? 0.55 : 0.85);
}

// CLICKS. Each is the exact frame the cursor presses in the picture:
//   2.45  store   "Create store"
//   4.82  stripe  the key slab
//   8.95  theme   Midnight tile   (0.10s before the colour moves — cause, effect)
//  10.10  theme   Ivory tile
//  10.75  theme   the radius slider grab, softer because a drag is not a click
//  13.57  shop    "Pay with card", the press that ignites the burst
[2.45, 4.82, 8.95, 10.10, 13.57].forEach((t) => click(t));
click(10.75, 0.5);

// The white wash at 5.60 and the burst at 14.00 — the two junctions the picture
// was measured to spend its energy on.
impact(5.60, 0.62);
riser(12.85, 1.15, 1.0);
impact(14.00, 1.0);

// The alerts land one per card, a fifth apart, rising.
[16.30, 16.90, 17.50, 18.10].forEach((t, i) => chime(t, 587.33 * Math.pow(2, i / 12) * (i > 1 ? 1.5 : 1), 1));
for (let t = 15.85; t < 18.80; t += BEAT * 2) kick(t, 0.62);

impact(18.85, 0.48);

// ── master ────────────────────────────────────────────────────────────────────
// Soft-clip rather than hard-limit: a tanh knee keeps transients intact where a
// brickwall would flatten exactly the clicks this mix exists for.
let peak = 0;
for (let i = 0; i < N; i += 1) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const norm = peak > 0 ? 0.92 / peak : 1;

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
  const l = Math.tanh(L[i] * norm * 1.15) * edge;
  const r = Math.tanh(R[i] * norm * 1.15) * edge;
  buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(l * 32767))), 44 + i * 4);
  buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(r * 32767))), 46 + i * 4);
}
fs.writeFileSync(OUT, buf);
console.log(`[audio] ${OUT} · ${DUR}s · ${SR}Hz stereo · peak ${peak.toFixed(3)} -> normalised`);
