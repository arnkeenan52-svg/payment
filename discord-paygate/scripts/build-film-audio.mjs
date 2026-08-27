// Synthesise the hero film's soundtrack.
//
// WHY SYNTHESISED AND NOT GENERATED. Two reasons, and the second is the real one.
// First, Higgsfield — the generation service on hand — cannot do it: its own tool
// states it produces speech only, and its music and SFX models are reserved for a
// game pipeline. Second and more important, a generated clip cannot be scored to
// a cut. Every accent here lands on a frame the picture actually does something:
// the clicks are the exact frames the cursor presses, and the impacts are the
// junctions the picture was measured to spend its energy on. That alignment is
// the whole difference between a video with music behind it and a video that
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
const DUR = 29.56;
// ── THE RETIME ──────────────────────────────────────────────────────────────
// The identical pause table to hero/film.html: picture-synced cues and chord
// turns remap through newT(); the pulse keeps its 120 BPM on the real clock.
const PAUSES = [
  [0.00, 0.16, 0.36], [1.44, 1.64, 0.44], [2.12, 2.28, 0.40],
  [3.52, 4.16, 1.40], [4.92, 5.52, 1.40], [6.88, 7.12, 0.44],
  [7.48, 7.92, 0.56], [8.08, 8.52, 0.48], [9.40, 9.68, 0.56],
  [10.04, 10.44, 0.48], [10.72, 11.40, 0.80], [12.84, 13.00, 0.36],
  [13.40, 13.56, 0.48], [17.16, 17.48, 0.80], [19.00, 20.00, 0.60],
];
const newT = (o) => {
  let n = o;
  for (const [a, b, add] of PAUSES) {
    if (o >= b) n += add; else if (o > a) n += add * (o - a) / (b - a);
  }
  return n;
};

const N = Math.round(SR * DUR);

// ── deterministic noise ───────────────────────────────────────────────────────
let seed = 0x9e3779b9;
const rnd = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x80000000 - 1; // -1..1
};

// ── the busses, and why there are three ──────────────────────────────────────
//
// The previous mix was ONE buffer with every voice writing a hand-tuned left and
// right value, almost all of them of the form (v, v*0.95). Measured, that came
// out at an L/R correlation of 0.9995 with side energy 33.6dB below mid: a mono
// track in a stereo container. On a laptop's speakers, which is where this film
// is watched, a mono bed has no image at all — it sounds like it is coming out
// of the screen bezel rather than out of a room. Width is not a garnish here, it
// is the single biggest difference between this and something that sounds paid
// for.
//
// So: A is the harmonic bed (pad, bass, arpeggio) and is DUCKED by the kick. B
// is everything transient (drums, clicks, impacts, bells) and is not — ducking a
// click by its own kick is how you make a mix mushy. SEND is a mono feed into
// the room, summed at the end. Every voice states a pan and a send amount rather
// than two magic numbers.
const AL = new Float64Array(N); const AR = new Float64Array(N);
const BL = new Float64Array(N); const BR = new Float64Array(N);
const SEND = new Float64Array(N);
const L = new Float64Array(N);
const R = new Float64Array(N);

// Constant-power panning: -1 hard left, 0 centre, +1 hard right. cos/sin rather
// than a linear crossfade because a linear pan loses 3dB in the middle, which is
// exactly where most of this mix sits.
const panL = (p) => Math.cos(((p + 1) * Math.PI) / 4);
const panR = (p) => Math.sin(((p + 1) * Math.PI) / 4);

const putA = (i, v, p, send) => {
  if (i < 0 || i >= N) return;
  AL[i] += v * panL(p); AR[i] += v * panR(p);
  if (send) SEND[i] += v * send;
};
const putB = (i, v, p, send) => {
  if (i < 0 || i >= N) return;
  BL[i] += v * panL(p); BR[i] += v * panR(p);
  if (send) SEND[i] += v * send;
};
// For voices that are genuinely stereo at source — two decorrelated noise
// generators rather than one signal placed in the field.
const putB2 = (i, l, r, send) => {
  if (i < 0 || i >= N) return;
  BL[i] += l; BR[i] += r;
  if (send) SEND[i] += (l + r) * 0.5 * send;
};

// BAND-LIMITED NOISE, and why every percussive voice here goes through it.
//
// The first version generated noise as `n - prev`, a one-pole difference. That
// is a +6dB/octave high-pass, so almost all of its energy sat at Nyquist — and
// content at Nyquist is exactly what produces inter-sample peaks. Measured: a
// master whose SAMPLE peak was a comfortable -1.2 dBFS came back with a TRUE
// peak of +1.4 dBFS, 2.6dB of overshoot, which meant the limiter was clamping
// continuously and every dB of makeup gain went straight back out again.
//
// A real hat or click is a BAND, not a shelf. One pole up, THREE poles down —
// three because one is not nearly enough: a single pole at 11kHz attenuates
// 24kHz by under 7dB against a source that has already boosted 24kHz by about
// 12dB. Cascading three sections gives 18dB/octave and puts the top of the band
// where the physical object actually stops.
//
// Two instances called alternately draw different samples from the same PRNG
// stream, so a pair of them is a decorrelated stereo source — that is how the
// impacts and the riser get their width without any fake widening.
function band(hp, lp) {
  let prev = 0;
  let base = 0;
  const lo = [0, 0, 0];
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
// Each writes itself into a bus at an absolute time in seconds, so the
// arrangement below reads as a cue sheet rather than as DSP.

// Every kick registers itself, because the sidechain envelope is derived from
// where the kicks actually landed rather than from a second hand-kept list that
// can drift out of agreement with the first.
const KICKS = [];

// The pulse. Pitch drops 150->46Hz in 70ms, which is what makes a sine read as a
// kick rather than as a bass note. Dead centre and dry: a low frequency has no
// usable stereo image, and reverb on a kick is just mud.
function kick(at, gain = 1) {
  KICKS.push([at, gain]);
  const len = Math.round(SR * 0.30);
  const s = Math.round(at * SR);
  let phase = 0;
  for (let i = 0; i < len; i += 1) {
    const u = i / len;
    const f = 46 + 104 * Math.exp(-u * 22);
    phase += (2 * Math.PI * f) / SR;
    const env = Math.exp(-u * 7.5) * gain;
    putB(s + i, Math.sin(phase) * env * 0.70, 0, 0);
  }
}

// Filtered noise, placed in the field. Eighths alternate a little either side of
// centre and sixteenths sit wider, which is what stops a hat pattern reading as
// a metronome: the ear tracks position as well as time.
function hat(at, gain = 1, decay = 0.030, pan = 0) {
  const len = Math.round(SR * decay * 3);
  const s = Math.round(at * SR);
  const nz = band(6000, 11000);
  for (let i = 0; i < len; i += 1) {
    const env = Math.exp(-(i / SR) / decay) * gain * 0.42;
    putB(s + i, nz() * env, pan, 0.10);
  }
}

// A UI click. Two components, because a real one has both: a tiny broadband
// transient (the contact) and a short pitched tick (the mechanism). The pan is
// not a taste decision — see the cue sheet, it is measured off the cursor.
function click(at, gain = 1, pan = 0) {
  const s = Math.round(at * SR);
  const tlen = Math.round(SR * 0.010);
  const nz = band(1800, 9000);
  for (let i = 0; i < tlen; i += 1) {
    const env = Math.exp(-(i / tlen) * 6) * gain * 2.4;
    putB(s + i, nz() * env, pan, 0.16);
  }
  const plen = Math.round(SR * 0.035);
  for (let i = 0; i < plen; i += 1) {
    const u = i / plen;
    const env = Math.exp(-u * 16) * gain * 0.30;
    putB(s + i, Math.sin((2 * Math.PI * 2550 * i) / SR) * env, pan, 0.16);
  }
}

// The big moments. Noise body over a sub boom — the boom is what gives an impact
// weight; the noise alone is just a crash. The noise is genuinely stereo (two
// generators) and the sub is mono, which is how a real impact is built: wide at
// the top, solid underneath.
function impact(at, gain = 1, send = 0.5) {
  const s = Math.round(at * SR);
  const len = Math.round(SR * 1.6);
  const nzL = band(300, 4200);
  const nzR = band(300, 4200);
  let phase = 0;
  for (let i = 0; i < len; i += 1) {
    const u = i / len;
    const nEnv = Math.exp(-u * 12) * gain * 1.5;
    const f = 34 + 46 * Math.exp(-u * 9);
    phase += (2 * Math.PI * f) / SR;
    const bEnv = Math.exp(-u * 4.2) * gain * 0.72;
    const sub = Math.sin(phase) * bEnv * 0.707;
    putB2(s + i, nzL() * nEnv + sub, nzR() * nEnv + sub, send);
  }
}

// Tension into an impact. Rising band of noise plus a rising tone — and the
// stereo image OPENS as it rises, from dead centre to nearly hard, so the
// arrival at the top feels like the room got bigger rather than just louder.
function riser(at, dur, gain = 1) {
  const s = Math.round(at * SR);
  const len = Math.round(SR * dur);
  const nzL = band(700, 7000);
  const nzR = band(700, 7000);
  let phase = 0;
  for (let i = 0; i < len; i += 1) {
    const u = i / len;
    const env = Math.pow(u, 2.2) * gain * 0.70;
    phase += (2 * Math.PI * (220 + 1500 * Math.pow(u, 2.4))) / SR;
    const tone = Math.sin(phase) * env * 0.30 * 0.707;
    const w = 0.15 + 0.85 * u;                       // the opening
    putB2(s + i, (nzL() * env) * w + tone, (nzR() * env) * w + tone, 0.20);
  }
}

// The harmonic bed. Two detuned oscillators per note pushed to opposite sides:
// a few cents apart and hard-panned is the oldest and still the best way to make
// a synth sound like it occupies space rather than a point.
function pad(at, dur, freqs, gain, spread = 0.62) {
  const s = Math.round(at * SR);
  const len = Math.round(SR * dur);
  const atk = Math.min(0.42, dur * 0.30);
  const rel = Math.min(0.55, dur * 0.34);
  freqs.forEach((f, k) => {
    const p = spread * (k % 2 === 0 ? -1 : 1) * (0.55 + 0.45 * ((k * 7) % 3) / 2);
    const det = 1 + (k % 2 === 0 ? -0.0022 : 0.0022);
    let ph1 = 0; let ph2 = Math.PI * 0.37;
    const lvl = (gain / Math.sqrt(freqs.length)) * (k === 0 ? 1 : 0.72);
    for (let i = 0; i < len; i += 1) {
      const t = i / SR;
      const env = Math.min(1, t / atk) * Math.min(1, (dur - t) / rel) * lvl;
      ph1 += (2 * Math.PI * f) / SR;
      ph2 += (2 * Math.PI * f * det) / SR;
      putA(s + i, (Math.sin(ph1) * 0.62 + Math.sin(ph2) * 0.38 + Math.sin(ph1 * 2) * 0.10) * env, p, 0.22);
    }
  });
}

// The backbeat. A clap is what turns a pulse into a beat: three noise bursts
// 11ms apart (that is what makes it read as hands rather than as a snare) over a
// short tail — and the three land in three different places in the field, which
// is what hands in a room actually do.
function clap(at, gain = 1) {
  const s = Math.round(at * SR);
  [[0, -0.38], [0.011, 0.36], [0.022, 0.02]].forEach(([off, p], n) => {
    const st = s + Math.round(off * SR);
    const len = Math.round(SR * 0.030);
    const nz = band(1200, 7500);
    for (let i = 0; i < len; i += 1) {
      const env = Math.exp(-(i / SR) / 0.010) * gain * (n === 2 ? 1.25 : 0.85);
      putB(st + i, nz() * env, p, 0.26);
    }
  });
  const tl = Math.round(SR * 0.20);
  const tL = band(900, 5200);
  const tR = band(900, 5200);
  for (let i = 0; i < tl; i += 1) {
    const env = Math.exp(-(i / SR) / 0.055) * gain * 0.48;
    putB2(s + Math.round(0.022 * SR) + i, tL() * env, tR() * env, 0.30);
  }
}

// A short sub note under each downbeat, so the low end moves rather than just
// thumping. Mono, like the kick, and for the same reason.
function bass(at, freq, dur, gain = 1) {
  const s = Math.round(at * SR);
  const len = Math.round(SR * dur);
  let phase = 0;
  for (let i = 0; i < len; i += 1) {
    const u = i / len;
    phase += (2 * Math.PI * freq) / SR;
    const env = Math.min(1, u * 40) * Math.exp(-u * 2.6) * gain * 0.30;
    putA(s + i, (Math.sin(phase) + Math.sin(phase * 2) * 0.14) * env, 0, 0);
  }
}

// One soft bell per sale alert, panned to the card that is ringing it.
function chime(at, freq, gain = 1, pan = 0.25) {
  const s = Math.round(at * SR);
  const len = Math.round(SR * 1.1);
  for (let i = 0; i < len; i += 1) {
    const u = i / len;
    const env = Math.exp(-u * 6.5) * gain * 0.26;
    const v = (Math.sin((2 * Math.PI * freq * i) / SR)
      + Math.sin((2 * Math.PI * freq * 2.01 * i) / SR) * 0.35) * env;
    putB(s + i, v, pan, 0.55);
  }
}

// THE MOTIF. Karplus-Strong: a burst of noise in a delay line one period long,
// lowpassed a little on every trip round. It is a string, and it is the only
// voice in the film that carries a tune — drums and a drone are a mood, a
// repeated figure is an identity. It states two notes over the title, runs the
// chord through the middle of the film, and comes back to close the endcard, so
// the last thing heard is the first thing heard.
function pluck(at, freq, gain, pan, dur = 0.55) {
  const s = Math.round(at * SR);
  const M = Math.max(2, Math.round(SR / freq));
  const buf = new Float64Array(M);
  for (let i = 0; i < M; i += 1) buf[i] = rnd();
  // Soften the excitation, or the attack is a burst of hiss rather than a pick.
  let p = 0;
  for (let i = 0; i < M; i += 1) { p += 0.38 * (buf[i] - p); buf[i] = p; }
  const len = Math.round(SR * dur);
  let idx = 0;
  for (let i = 0; i < len; i += 1) {
    const cur = buf[idx];
    const nxt = buf[(idx + 1) % M];
    buf[idx] = (cur + nxt) * 0.5 * 0.996;   // one-zero lowpass = string damping
    idx = (idx + 1) % M;
    const env = Math.exp(-(i / SR) / (dur * 0.40)) * gain * 0.34;
    putA(s + i, cur * env, pan, 0.34);
  }
}

// A scene-change edge: a band of noise that sweeps up and ACROSS. Quiet enough
// that it reads as an edit rather than as an effect, and it is the reason every
// cut in the picture now has something under it instead of only two of them.
function whoosh(at, dur, gain, from, to) {
  const s = Math.round(at * SR);
  const len = Math.round(SR * dur);
  const nzL = band(500, 9000);
  const nzR = band(500, 9000);
  for (let i = 0; i < len; i += 1) {
    const u = i / len;
    const env = Math.sin(Math.PI * u) * gain * 0.40;
    const pp = from + (to - from) * u;
    putB2(s + i, nzL() * env * panL(pp), nzR() * env * panR(pp), 0.30);
  }
}

// A sub sweep. Used twice: once at frame zero so the film opens with weight
// instead of fading up, and once into the alerts so the money lands on
// something.
function sweepSub(at, dur, f0, f1, gain) {
  const s = Math.round(at * SR);
  const len = Math.round(SR * dur);
  let phase = 0;
  for (let i = 0; i < len; i += 1) {
    const u = i / len;
    phase += (2 * Math.PI * (f0 + (f1 - f0) * u)) / SR;
    const env = Math.sin(Math.PI * Math.pow(u, 0.72)) * gain * 0.55;
    putB(s + i, Math.sin(phase) * env, 0, 0);
  }
}

// A reversed swell into a cut. Noise whose envelope grows to nothing at the
// moment of the edit — the classic way to make an audience feel a cut arriving
// half a second before it does.
function swell(at, dur, gain) {
  const s = Math.round(at * SR);
  const len = Math.round(SR * dur);
  const nzL = band(600, 6500);
  const nzR = band(600, 6500);
  for (let i = 0; i < len; i += 1) {
    const u = i / len;
    const env = Math.pow(u, 2.6) * gain * 0.42;
    putB2(s + i, nzL() * env, nzR() * env, 0.34);
  }
}

// ── the harmony ───────────────────────────────────────────────────────────────
// The old score was a single 55Hz drone from top to bottom: one chord for twenty
// seconds, which is why it read as a bed under a video rather than as music for
// it. These roots change on the film's OWN cut points — the beat table in
// hero/film.html, not a musical guess — so the harmony turns at the same instant
// the picture does.
//
//   0.00  Am   the title and the first card: home, unresolved
//   3.44  F    the Stripe beat, the room goes dark — a drop to the flat sixth is
//              what a room change feels like
//   6.52  C    the product sheet: the relative major, the film opens up
//   9.00  G    theming, the busiest passage: the dominant, which wants to move
//  12.48  Am   the storefront and the burst: home again, under the riser
//  15.92  C    the sale alerts: major, and a fourth higher than the burst
//  18.16  A    the endcard resolves on a MAJOR tonic against a minor film. It is
//              a picardy third and it is the oldest ending in music, because it
//              is the one that sounds like something finished rather than
//              stopped.
const CHORDS = [
  { at: 0.00,  to: 3.44,  root: 55.00, tri: [220.00, 261.63, 329.63] }, // Am
  { at: 3.44,  to: 6.52,  root: 43.65, tri: [174.61, 220.00, 261.63] }, // F
  { at: 6.52,  to: 9.00,  root: 65.41, tri: [261.63, 329.63, 392.00] }, // C
  { at: 9.00,  to: 12.48, root: 49.00, tri: [196.00, 246.94, 293.66] }, // G
  { at: 12.48, to: 15.92, root: 55.00, tri: [220.00, 261.63, 329.63] }, // Am
  { at: 15.92, to: 18.16, root: 65.41, tri: [261.63, 329.63, 392.00] }, // C
  { at: 18.16, to: 20.00, root: 55.00, tri: [220.00, 277.18, 329.63] }, // A major
];
CHORDS.forEach((c) => { c.at = newT(c.at); c.to = newT(c.to); });
const chordAt = (t) => CHORDS[Math.max(0, CHORDS.findIndex((c) => t < c.to - 1e-6))] || CHORDS[CHORDS.length - 1];

// ── the cue sheet ─────────────────────────────────────────────────────────────
// 120 BPM on the ABSOLUTE grid: a beat every 0.5s counted from zero, a bar every
// 2.0s, and the film's 20.0s is exactly ten bars. The burst at 14.00s is the
// downbeat of bar 8 with no nudging, which is why this tempo and not another.
//
// THE PULSE IS ON THE GRID. Picture cues and musical cues are different things:
// a CLICK belongs on the frame the cursor presses, wherever that falls, and a
// KICK belongs on the beat. Mixing the two rules is what makes a soundtrack feel
// stuck on rather than scored.
const BEAT = 0.5;
const BAR = 2.0;
const on = (from, to, every, fn) => { for (let t = from; t < to - 1e-6; t += every) fn(t); };

// ── the bed ─────────────────────────────────────────────────────────────────
// One pad per chord, overlapping its neighbour by a third of a second so the
// changes bleed into each other instead of switching.
CHORDS.forEach((c, i) => {
  const lead = i === 0 ? 0 : 0.34;
  const tail = i === CHORDS.length - 1 ? 0 : 0.34;
  const gain = c.at >= 18.16 ? 0.30 : (c.at >= 14.0 ? 0.20 : 0.17);
  pad(c.at - lead, (c.to - c.at) + lead + tail, [c.root, ...c.tri], gain);
});

// ── the open ────────────────────────────────────────────────────────────────
// The film used to start on a drone and wait 1.5s for the first kick — a second
// and a half of nothing, over the title, which is the one moment an audience
// decides whether to keep watching. Now: a sub drop on frame zero, the motif
// stating two notes over the title, and a swell that empties into the cut to the
// store card at 1.16.
sweepSub(0.00, 0.95, 88, 38, 0.52);
pluck(newT(0.34), 220.00, 0.85, -0.30, 0.80);
pluck(newT(0.74), 329.63, 0.75, 0.32, 0.70);
swell(0.30, 0.86, 1.0);
impact(newT(1.16), 0.26, 0.62);          // the cut lands, softly — a settle, not a bang

// ── drums ───────────────────────────────────────────────────────────────────
// Built in stages so the arrangement grows with the film rather than running
// flat under it: pulse alone under the first card, backbeat from the Stripe key,
// sixteenth hats from the theming beat, and then a hole.
//
//   1.50 - 3.50   kick only          the store card
//   3.50 - 5.60   + clap on 2 and 4  the key
//   5.60 - 11.85  + bass on the bar  product and theming
//  11.85 - 13.50  full               the storefront
//  13.50 - 14.00  NOTHING but the riser — the pre-drop
//  14.00          impact, and the rhythm stops dead
//  16.00 - 18.00  a bare pulse under the alerts
on(newT(1.50), newT(13.51), BAR / 2, (t) => kick(t, t < newT(3.3) ? 0.78 : 1.0));
on(newT(4.00), newT(13.51), BAR / 2, (t) => kick(t + BEAT * 1.5, 0.40));   // the pickup kick
on(newT(3.50), newT(13.51), BAR, (t) => clap(t + BEAT, t < newT(5.6) ? 0.75 : 1.0));
// Eighths alternate either side of centre; the pattern's own position in the bar
// picks the side, so it is the same every render.
on(newT(3.50), newT(13.51), BEAT / 2, (t) => {
  const n = Math.round(t / (BEAT / 2));
  const downbeat = Math.abs((t / BEAT) % 1) < 0.01;
  hat(t, downbeat ? 0.55 : 0.85, 0.030, (n % 2 ? 0.26 : -0.24));
});
// Sixteenth accents once the theming beat starts, which is where the picture
// gets busiest — the ear follows density. Wider than the eighths, and swung 9ms
// late on the off-sixteenths so the pattern breathes instead of ticking.
on(newT(7.90), newT(11.90), BEAT / 4, (t) => {
  const n = Math.round(t / (BEAT / 4));
  const off = n % 2 ? 0.009 : 0;
  hat(t + off, n % 2 ? 0.30 : 0.38, 0.018, (n % 4 < 2 ? -0.46 : 0.44));
});
on(newT(5.60), newT(13.51), BAR, (t) => bass(t, chordAt(t).root, 1.1, t < newT(11.85) ? 0.9 : 1.0));

// ── the motif ───────────────────────────────────────────────────────────────
// Eighth-note arpeggio on whatever chord is in force, alternating across the
// field. It runs through the two beats where the picture is doing the most —
// the product sheet and the theming — and drops out for the pre-drop so the
// riser has the whole mix.
const FIGURE = [0, 2, 1, 2, 0, 3, 1, 2];
on(newT(6.52), newT(13.50), BEAT / 2, (t) => {
  const c = chordAt(t);
  const step = Math.round((t - 6.52) / (BEAT / 2)) % FIGURE.length;
  const k = FIGURE[step];
  const f = k === 3 ? c.tri[0] * 2 : c.tri[k];
  const lvl = t < 9.0 ? 0.80 : (t < 12.48 ? 1.0 : 0.85);
  pluck(t, f, lvl, step % 2 ? 0.34 : -0.36, 0.52);
});

// ── clicks ──────────────────────────────────────────────────────────────────
// Each is the exact frame the cursor presses in the picture. These do NOT sit on
// the grid and must not: they belong to the hand, not to the tempo. Every time
// below is read straight off the CUR waypoint table in hero/film.html — if a
// click here disagrees with a waypoint there, the picture is right and this is
// wrong.
//
// AND EACH ONE IS PANNED TO WHERE THE HAND IS. The x values are not invented:
// the film was loaded in the render browser, seeked to each of these times, and
// the cursor's own bounding box read out of the DOM, then mapped across the
// 1920px frame as (x/1920 - 0.5) * 2. So the click at 12.02 — the far end of the
// slider drag — is genuinely down the left of the image, because that is where
// the pointer is on that frame. It is the cheapest possible way to tie sound to
// picture and almost nothing does it.
//
//    2.30  store    "Create store"      x= 992  the film's first press
//    4.20  dark     the Stripe pulse    edges   not a press: the tick the wires
//                                               light up on, softer, centred
//    7.96  product  billing confirms    x=1262
//    8.54  product  "Create product"    x= 988
//    9.72  theme    the Blurple preset  x= 737
//   10.46  theme    the Serif segment   x= 610
//   11.42  theme    the corners GRAB    x= 625  softer, a drag is not a click
//   12.62  theme    the RELEASE         x= 366  softer still — down at 2px
//   13.02  cta      "Publish store"     x= 982  the press that becomes the window
//   13.28  live     the Lifetime option x=1146  the buyer choosing
//   13.60  live     "Pay with card"     x= 960  the press the burst is born from
const CLICKS = [
  [2.30, 1.00, 0.033], [4.20, 0.35, 0.0], [7.96, 1.00, 0.314],
  [8.54, 1.00, 0.029], [9.72, 1.00, -0.232], [10.46, 1.00, -0.365],
  [11.42, 0.50, -0.349], [12.62, 0.34, -0.619], [13.02, 1.00, 0.023],
  [13.28, 0.45, 0.194], [13.60, 1.00, 0.0],
];
CLICKS.forEach(([t, g, p]) => click(newT(t), g, p));

// ── scene changes ───────────────────────────────────────────────────────────
// The rebuilt film's junctions: the dark room's exit whip starts at 5.56 and
// the worksheet lands on the 5.92 impact; the worksheet leaves upward at 8.84
// under the theme's rise; the theme whips out at 12.68 handing to the carried
// CTA; the burst washes into the receipts at 15.66. Each sweep runs ACROSS the
// image in the direction the world is actually moving on those frames.
whoosh(newT(5.60), 0.40, 0.66, 0.60, -0.60);
whoosh(newT(8.86), 0.42, 0.68, -0.55, 0.55);
whoosh(newT(12.68), 0.38, 0.58, 0.55, -0.55);
whoosh(newT(15.66), 0.44, 0.72, -0.60, 0.60);

// ── the two big moments ─────────────────────────────────────────────────────
// The room change into the dark Stripe beat, and the burst.
impact(newT(3.30), 0.55, 0.55);          // the keycap drops out of the rising dark
impact(newT(4.56), 0.50, 0.65);          // ignition: the pulse reaches the keycap
impact(newT(5.92), 0.40, 0.45);          // the worksheet lands out of the exit whip
riser(newT(12.90), 1.10, 1.0);
impact(newT(14.00), 1.0, 0.85);
// After the burst the rhythm stops dead and only the room is left ringing. A
// sub swelling out of that silence is what carries 1.9 seconds of held picture
// without putting a beat back under it.
sweepSub(newT(15.10), 0.86, 30, 62, 0.60);

// ── the alerts ──────────────────────────────────────────────────────────────
// One bell per card, a fifth apart, rising — and on an ACCELERATING cadence,
// 0.47s then 0.40s. Money arriving faster and faster is told entirely through
// the interval, with no copy at all.
//
// FOUR CARDS POP, THREE BELLS RING. The first card lands at 15.92, still
// inside the bloom's wash and the sub swell — a bell there would fight the
// wash, so the drumbeat's cadence starts being audible from the second card.
// Bells are picture cues like the clicks; each of these three has a card
// landing under it on the exact frame.
const SALE_AT = [16.20, 16.67, 17.07];
SALE_AT.forEach((t, i) => chime(newT(t), 587.33 * Math.pow(2, i / 12) * (i > 1 ? 1.5 : 1), 1, 0.20 + i * 0.07));
on(newT(16.00), newT(18.01), BAR / 2, (t) => kick(t, 0.62));
bass(newT(16.00), 65.41, 1.6, 0.7);

// ── the endcard ─────────────────────────────────────────────────────────────
// The endcard is a REAL FREEZE — 1.2s of picture with a per-frame delta of
// exactly 0.0000. The score used to stop with it: one impact and then 1.84
// seconds of dead air, which does not read as deliberate stillness, it reads as
// the file running out.
//
// So the picture freezes and the SOUND RESOLVES: the impact throws a long tail
// into the room, the pad lands on A major underneath it, and the motif states
// the tonic triad one last time — the same string that opened over the title,
// closing on the chord the whole film has been avoiding. The last thing that
// happens is a room decaying, which is what an ending sounds like.
impact(newT(18.16), 0.52, 1.0);
pluck(newT(18.16), 220.00, 1.0, -0.34, 1.40);
pluck(newT(18.40), 277.18, 0.86, 0.30, 1.30);
pluck(newT(18.66), 329.63, 0.74, -0.22, 1.20);
pluck(newT(18.98), 440.00, 0.58, 0.26, 1.10);
chime(newT(18.16), 880.00, 0.55, 0.0);
bass(newT(18.16), 55.00, 1.7, 0.85);

// ── the room ──────────────────────────────────────────────────────────────────
// Everything above is dry. A dry synthetic mix is the single loudest tell that
// something was made in a text editor: real sound arrives at a microphone having
// bounced off something first, and a mix with no reflections in it sounds like
// it is happening inside the speaker rather than in front of you.
//
// A feedback delay network, which is the cheap way to get a plausible room
// without an impulse response to convolve: two allpass sections diffuse the
// input so the early reflections are not four discrete echoes, then four delay
// lines of mutually prime length are cross-fed through a Householder matrix.
// Householder because it is unitary — it moves energy between the lines without
// creating or destroying any, so the decay time is set purely by the per-line
// feedback gain and not by an accident of the matrix.
//
// Two details that matter more than the topology. The send is HIGH-PASSED at
// 280Hz: reverb on a kick or a sub is mud, and the low end of this mix is the
// only thing holding it together. And the output taps are DIFFERENCES of pairs
// of lines (0-2 and 1-3) rather than two of the four, which makes the left and
// right returns genuinely decorrelated — a reverb whose two sides are the same
// signal is just a delay, and it will not widen anything.
const RL = new Float64Array(N);
const RR = new Float64Array(N);
{
  const PRE = Math.round(SR * 0.018);
  const apN = [221, 373];
  const apBuf = apN.map((n) => new Float64Array(n));
  const apI = [0, 0];
  const G = 0.62;
  const dN = [1931, 2477, 3079, 3767];      // ~40, 52, 64, 78ms — a small room
  const dBuf = dN.map((n) => new Float64Array(n));
  const dI = [0, 0, 0, 0];
  const lp = [0, 0, 0, 0];
  const DAMP = 0.34;                        // ~3.2kHz per trip: a warm tail
  const RT60 = 1.9;
  const fb = dN.map((n) => Math.pow(10, (-3 * (n / SR)) / RT60));
  const HP = 1 - Math.exp((-2 * Math.PI * 280) / SR);
  let hpState = 0;
  const o = [0, 0, 0, 0];
  for (let i = 0; i < N; i += 1) {
    let x = i >= PRE ? SEND[i - PRE] : 0;
    hpState += HP * (x - hpState);
    x -= hpState;
    for (let k = 0; k < 2; k += 1) {
      const b = apBuf[k]; const j = apI[k];
      const v = b[j];
      const y = -G * x + v;
      b[j] = x + G * y;
      apI[k] = (j + 1) % apN[k];
      x = y;
    }
    for (let k = 0; k < 4; k += 1) o[k] = dBuf[k][dI[k]];
    const half = (o[0] + o[1] + o[2] + o[3]) * 0.5;
    for (let k = 0; k < 4; k += 1) {
      let v = (half - o[k]) * fb[k] + x * 0.5;
      lp[k] += DAMP * (v - lp[k]); v = lp[k];
      dBuf[k][dI[k]] = v;
      dI[k] = (dI[k] + 1) % dN[k];
    }
    RL[i] = (o[0] - o[2]) * 0.60;
    RR[i] = (o[1] - o[3]) * 0.60;
  }
}

// ── the duck ──────────────────────────────────────────────────────────────────
// The pad, the bass and the motif drop 4dB on every kick and climb back over
// about a tenth of a second. This is the one production trick in the file that
// is purely genre — it is what makes the low end of a modern mix feel like it is
// breathing rather than sitting there — and it costs nothing because the kick
// times are taken from the kicks themselves rather than from a second list.
const duck = new Float64Array(N).fill(1);
{
  const TAU = Math.exp(-1 / (SR * 0.105));
  const DEPTH = 0.38;
  const hits = new Float64Array(N);
  KICKS.forEach(([t, amt]) => {
    const i = Math.round(t * SR);
    if (i >= 0 && i < N) hits[i] = Math.max(hits[i], DEPTH * amt);
  });
  let g = 1;
  for (let i = 0; i < N; i += 1) {
    if (hits[i] > 0) g = Math.min(g, 1 - hits[i]);
    duck[i] = g;
    g = 1 + TAU * (g - 1);
  }
}

const WET = Number(process.env.FILM_AUDIO_WET || 0.30);
for (let i = 0; i < N; i += 1) {
  L[i] = AL[i] * duck[i] + BL[i] + RL[i] * WET;
  R[i] = AR[i] * duck[i] + BR[i] + RR[i] * WET;
}

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
//
// MAKEUP is not a taste decision: it is the value that measures the target
// integrated loudness at that true peak, re-derived with ffmpeg's ebur128 every
// time the arrangement changes, and overridable with FILM_AUDIO_MAKEUP so the
// next person can re-derive it rather than trust this comment.
const MAKEUP = Number(process.env.FILM_AUDIO_MAKEUP || 2.15);
const CEIL = 0.72;
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

// Report the width, because it is the thing this mix was rebuilt for and a
// regression to mono would otherwise be silent.
let sm = 0; let mm = 0;
for (let i = 0; i < N; i += 1) {
  const s = (L[i] - R[i]) * 0.5; const m = (L[i] + R[i]) * 0.5;
  sm += s * s; mm += m * m;
}
const width = 20 * Math.log10(Math.sqrt(sm / Math.max(1e-12, mm)) + 1e-12);

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
console.log(`[audio] ${OUT} · ${DUR}s · ${SR}Hz stereo · makeup x${MAKEUP} · wet ${WET} · peak ${peak.toFixed(4)} · S/M ${width.toFixed(1)}dB`);
