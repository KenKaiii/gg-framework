#!/usr/bin/env node
// GG Motion score synth: render a beat-locked music bed and sound effects from
// a small JSON score, fully offline and deterministic (same score + seed =>
// identical audio). No samples, no API keys, no licensing questions.
//
// Usage: node score-synth.mjs <score.json> <out-dir>
// Writes: <out>/music.wav, <out>/sfx.wav (48 kHz stereo PCM) and
//         <out>/tempo-map.json (beat/bar/section/hit times in seconds) so the
//         animation is timed from exactly the grid the audio was built on.
//
// Score shape (all times in seconds unless noted):
// {
//   "bpm": 120, "duration": 20, "seed": 7,
//   "key": "A", "scale": "minor",              // used when chords are omitted
//   "chords": ["Am", "F", "C", "G"],           // one per bar, cycled
//   "style": "pulse",                          // pulse | cinematic | minimal | lofi
//   "sections": [{ "name": "intro", "from": 0, "energy": 0.3 }, ...],
//   "hits": [{ "t": 1.5, "sfx": "whoosh" }, { "beat": 16, "sfx": "impact" }, { "bar": 8, "sfx": "riser" }],
//   "beatTimes": [0.51, 1.02, ...],            // optional: measured beats of a supplied song
//   "music": true,                             // false => sfx.wav only (e.g. over a supplied song)
//   "cues": "cues.json",                       // optional: hits exported from the composition by cues.mjs
//   "room": "room",                            // none | booth | room | hall: one shared space for every sound
//   "duck": 0.55,                              // music level under the heaviest hit (1 = no ducking)
//   "ending": "resolve",                       // resolve (home chord, fade) | cut
//   "air": true                                // camera air from the cues file's camera curve
// }
//
// Every effect is built from a material (wood, glass, air, felt, paper,
// plastic): a few damped partials plus a short noise burst, never a bare
// sine. Each sound has its own distance (how much reaches the room); a hit
// may set "send" 0..1. Hits closer than 50 ms keep only the stronger one.
// tempo-map.json reports which hits the music buries and a music volume
// that keeps them audible.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const SR = 48000;
const STYLES = ["pulse", "cinematic", "minimal", "lofi"];
const SFX_NAMES = [
  "whoosh",
  "whoosh-short",
  "riser",
  "impact",
  "sub-drop",
  "pop",
  "click",
  "tick",
  "glitch",
  "shimmer",
  "sting",
  "typing",
  "swell",
  "snap",
  "tap",
  "press",
  "knock",
  "chime",
  "breath",
  "thud",
  "plip",
  "paper",
];
// How far away each sound sits: the share of it that reaches the room. Close,
// small contacts stay dry; air and long tones fill the space.
const DEFAULT_SEND = {
  tap: 0.12,
  press: 0.12,
  click: 0.12,
  typing: 0.1,
  tick: 0.3,
  snap: 0.22,
  knock: 0.28,
  plip: 0.3,
  pop: 0.3,
  paper: 0.35,
  chime: 0.45,
  glitch: 0.18,
  thud: 0.38,
  impact: 0.4,
  "sub-drop": 0.32,
  sting: 0.5,
  breath: 0.6,
  whoosh: 0.6,
  "whoosh-short": 0.5,
  riser: 0.55,
  swell: 0.6,
  shimmer: 0.6,
};
// Long sounds that lead into or ring under an event; never merged away.
const LONG_SOUNDS = new Set(["riser", "swell", "typing", "sting", "shimmer"]);
const MERGE_WINDOW = 0.05;
// Low sounds are judged against the music in the low band, the rest in the
// presence band where ears pick out detail.
const LOW_SOUNDS = new Set(["thud", "impact", "sub-drop", "sting"]);
const BURIED_DB = -6;
// Where each sound is loudest, relative to its time (default: the first 120 ms).
// Risers and swells arrive at their time, so they are heard just before it.
const HEARD_AT = {
  riser: [-0.25, 0],
  swell: [-0.25, 0],
  breath: [0.2, 0.55],
  whoosh: [0.2, 0.55],
  "whoosh-short": [0.06, 0.26],
  paper: [0.06, 0.3],
  typing: [0, 1],
  shimmer: [0, 0.4],
};

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// ---------- validation ----------
function validate(raw) {
  if (!raw || typeof raw !== "object") fail("score must be a JSON object");
  const bpm = Number(raw.bpm ?? 120);
  const duration = Number(raw.duration);
  if (!(bpm >= 40 && bpm <= 220)) fail("bpm must be between 40 and 220");
  if (!(duration > 0 && duration <= 900)) fail("duration must be between 0 and 900 seconds");
  const style = raw.style ?? "pulse";
  if (!STYLES.includes(style)) fail(`unknown style: ${style}. Use one of: ${STYLES.join(", ")}`);
  const sections =
    Array.isArray(raw.sections) && raw.sections.length
      ? raw.sections
          .map((s, i) => {
            const from = Number(s.from);
            const energy = Number(s.energy);
            if (!(from >= 0) || !(energy >= 0 && energy <= 1))
              fail(`section ${i}: needs from >= 0 and energy 0..1`);
            return { name: String(s.name ?? `section-${i + 1}`), from, energy };
          })
          .sort((a, b) => a.from - b.from)
      : [{ name: "main", from: 0, energy: 0.7 }];
  const hits = (Array.isArray(raw.hits) ? raw.hits : []).map((h, i) => {
    if (!SFX_NAMES.includes(h.sfx))
      fail(`hit ${i}: unknown sfx "${h.sfx}". Use one of: ${SFX_NAMES.join(", ")}`);
    if (h.t === undefined && h.beat === undefined && h.bar === undefined)
      fail(`hit ${i}: needs t, beat or bar`);
    const gain = h.gain === undefined ? 1 : Number(h.gain);
    if (!(gain >= 0 && gain <= 2)) fail(`hit ${i}: gain must be 0..2`);
    if (h.send !== undefined && !(Number(h.send) >= 0 && Number(h.send) <= 1))
      fail(`hit ${i}: send must be 0..1`);
    return { ...h, gain, ...(h.send === undefined ? {} : { send: Number(h.send) }) };
  });
  const beatTimes = Array.isArray(raw.beatTimes)
    ? raw.beatTimes
        .map(Number)
        .filter((n) => n >= 0)
        .sort((a, b) => a - b)
    : null;
  const room = raw.room ?? "room";
  if (!Object.hasOwn(ROOMS, room))
    fail(`unknown room: ${room}. Use one of: ${Object.keys(ROOMS).join(", ")}`);
  const duck = raw.duck === undefined ? 0.55 : Number(raw.duck);
  if (!(duck >= 0 && duck <= 1))
    fail("duck must be 0..1 (the music level under a hit; 1 = no ducking)");
  if (raw.cues !== undefined && (typeof raw.cues !== "string" || !raw.cues))
    fail("cues must be the path of a cues.json file");
  const ending = raw.ending ?? "resolve";
  if (!["resolve", "cut"].includes(ending)) fail(`unknown ending: ${ending}. Use resolve or cut`);
  return {
    bpm,
    duration,
    style,
    sections,
    hits,
    beatTimes,
    room,
    duck,
    ending,
    air: raw.air !== false,
    cues: raw.cues,
    seed: Number.isInteger(raw.seed) ? raw.seed : 1,
    key: String(raw.key ?? "A"),
    scale: raw.scale === "major" ? "major" : "minor",
    chords: Array.isArray(raw.chords) && raw.chords.length ? raw.chords.map(String) : null,
    music: raw.music !== false,
  };
}

/**
 * Hits from a cues.json written by cues.mjs: the composition's own event
 * times, so a retimed animation moves its sounds with it.
 */
async function loadCues(path, duration) {
  let file;
  try {
    file = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`Could not read cues ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (file?.version !== 1 || !Array.isArray(file.cues))
    fail(`${path}: expected a cues file (version 1) from cues.mjs`);
  let air = null;
  if (file.air !== undefined) {
    const { rate, start, values } = file.air ?? {};
    if (
      !(rate >= 10 && rate <= 240) ||
      !(start >= 0) ||
      !Array.isArray(values) ||
      !values.every((v) => Number.isFinite(v) && v >= 0)
    )
      fail(`${path}: the camera curve (air) is malformed; export the cues again`);
    air = { rate, start, values };
  }
  const hits = file.cues.map((c, i) => {
    const label = `cue ${i}${c?.name ? ` (${c.name})` : ""}`;
    if (!SFX_NAMES.includes(c?.sfx))
      fail(`${label}: unknown sfx "${c?.sfx}". Use one of: ${SFX_NAMES.join(", ")}`);
    const t = Number(c.t);
    if (!(t >= 0 && t < duration))
      fail(`${label}: t ${c.t} is outside the score's 0..${duration} s`);
    const gain = c.gain === undefined ? 1 : Number(c.gain);
    if (!(gain >= 0 && gain <= 2)) fail(`${label}: gain must be 0..2`);
    const pan = c.pan === undefined ? undefined : Number(c.pan);
    if (pan !== undefined && !(pan >= -1 && pan <= 1)) fail(`${label}: pan must be -1..1`);
    const send = c.send === undefined ? undefined : Number(c.send);
    if (send !== undefined && !(send >= 0 && send <= 1)) fail(`${label}: send must be 0..1`);
    return {
      t,
      sfx: c.sfx,
      gain,
      ...(pan === undefined ? {} : { pan }),
      ...(send === undefined ? {} : { send }),
      source: "cue",
      ...(c.name ? { name: String(c.name).slice(0, 60) } : {}),
    };
  });
  return { hits, air };
}

// ---------- music theory ----------
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function parseRoot(name) {
  const m = /^([A-G])([#b]?)/.exec(name);
  if (!m) fail(`bad chord or key: ${name}`);
  return (NOTE[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12) % 12;
}
function chordNotes(name) {
  const root = parseRoot(name);
  const rest = name.replace(/^[A-G][#b]?/, "");
  const minor = /^m(?!aj)/.test(rest);
  const tones = [0, minor ? 3 : 4, 7];
  if (/7/.test(rest)) tones.push(/maj7/.test(rest) ? 11 : 10);
  return { root, tones };
}
function defaultChords(key, scale) {
  const r = parseRoot(key);
  const name = (semi, minor) =>
    `${Object.keys(NOTE).find((k) => NOTE[k] === (r + semi) % 12) ?? "C"}${minor ? "m" : ""}`;
  // i-VI-III-VII (minor) or I-V-vi-IV (major); fall back to the root when a degree is sharp.
  return scale === "minor"
    ? [name(0, true), name(8, false), name(3, false), name(10, false)]
    : [name(0, false), name(7, false), name(9, true), name(5, false)];
}
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

// ---------- deterministic noise ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- DSP helpers ----------
function biquad(type, freq, q) {
  let b0,
    b1,
    b2,
    a1,
    a2,
    x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  const set = (f) => {
    const w = (2 * Math.PI * Math.min(Math.max(f, 20), SR * 0.45)) / SR;
    const alpha = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    const a0 = 1 + alpha;
    if (type === "lp") {
      b0 = (1 - c) / 2;
      b1 = 1 - c;
      b2 = (1 - c) / 2;
    } else if (type === "hp") {
      b0 = (1 + c) / 2;
      b1 = -(1 + c);
      b2 = (1 + c) / 2;
    } else {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }
    b0 /= a0;
    b1 /= a0;
    b2 /= a0;
    a1 = (-2 * c) / a0;
    a2 = (1 - alpha) / a0;
  };
  set(freq);
  const run = (x) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
  run.set = set;
  return run;
}

class Bus {
  constructor(seconds) {
    this.n = Math.ceil(seconds * SR);
    this.l = new Float32Array(this.n);
    this.r = new Float32Array(this.n);
  }
  add(start, samples, gain = 1, pan = 0) {
    const s0 = Math.round(start * SR);
    const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < samples.length; i++) {
      const j = s0 + i;
      if (j < 0 || j >= this.n) continue;
      const v = samples[i];
      this.l[j] += v * gl * Math.SQRT2;
      this.r[j] += v * gr * Math.SQRT2;
    }
  }
  addStereo(start, left, right, gain = 1) {
    const s0 = Math.round(start * SR);
    for (let i = 0; i < left.length; i++) {
      const j = s0 + i;
      if (j < 0 || j >= this.n) continue;
      this.l[j] += left[i] * gain;
      this.r[j] += right[i] * gain;
    }
  }
}

const buf = (sec) => new Float32Array(Math.max(1, Math.round(sec * SR)));

// ---------- one shared room ----------
// Every sound goes through the same small space, so the effects and the music
// read as one place instead of a pile of separate recordings. A plain
// feedback-comb + allpass reverb: `size` scales the delay lines, `decay` is the
// comb feedback, `damp` darkens each echo, `mix` is the wet level.
const ROOMS = {
  none: null,
  booth: { size: 0.45, decay: 0.68, damp: 0.45, mix: 0.12, predelay: 0.004 },
  room: { size: 0.75, decay: 0.76, damp: 0.38, mix: 0.16, predelay: 0.008 },
  hall: { size: 1.25, decay: 0.84, damp: 0.3, mix: 0.2, predelay: 0.018 },
};
// Mutually prime delay lengths (samples at 48 kHz, before `size`), so echoes don't stack.
const COMB_DELAYS = [1433, 1601, 1867, 2053, 2251, 2399];
const ALLPASS_DELAYS = [337, 557, 829];
const STEREO_SPREAD = 31;

function reverbChannel(input, room, spread) {
  const out = new Float32Array(input.length);
  const pre = Math.round(room.predelay * SR);
  for (const base of COMB_DELAYS) {
    const len = Math.max(1, Math.round(base * room.size) + spread);
    const line = new Float32Array(len);
    let pos = 0,
      low = 0;
    for (let i = 0; i < input.length; i++) {
      const echo = line[pos];
      low = echo * (1 - room.damp) + low * room.damp;
      const x = i >= pre ? input[i - pre] : 0;
      line[pos] = x + low * room.decay;
      out[i] += echo / COMB_DELAYS.length;
      pos = pos + 1 === len ? 0 : pos + 1;
    }
  }
  for (const base of ALLPASS_DELAYS) {
    const len = Math.max(1, Math.round(base * room.size) + spread);
    const line = new Float32Array(len);
    let pos = 0;
    for (let i = 0; i < out.length; i++) {
      const delayed = line[pos];
      const x = out[i];
      line[pos] = x + delayed * 0.5;
      out[i] = delayed - x * 0.5;
      pos = pos + 1 === len ? 0 : pos + 1;
    }
  }
  return out;
}

/** Add the room's echo of `source` (default: `bus` itself) to `bus`; `send` scales how much enters. */
function applyRoom(bus, room, send, source = bus) {
  if (!room || send <= 0) return;
  const mono = new Float32Array(bus.n);
  for (let i = 0; i < bus.n; i++) mono[i] = (source.l[i] + source.r[i]) * 0.5 * send;
  const wetL = reverbChannel(mono, room, 0);
  const wetR = reverbChannel(mono, room, STEREO_SPREAD);
  for (let i = 0; i < bus.n; i++) {
    bus.l[i] += wetL[i] * room.mix * 4;
    bus.r[i] += wetR[i] * room.mix * 4;
  }
}

// ---------- ducking ----------
// How hard each sound pushes the music down, and how long it holds there.
const DUCK_WEIGHT = {
  impact: 1,
  sting: 1,
  "sub-drop": 1,
  riser: 0.7,
  whoosh: 0.6,
  "whoosh-short": 0.5,
  swell: 0.5,
  shimmer: 0.4,
  glitch: 0.5,
  snap: 0.4,
  pop: 0.3,
  click: 0.15,
  tick: 0.15,
  typing: 0.2,
};
const DUCK_ATTACK = 0.015;
const DUCK_RELEASE = 0.35;

/** Music gain over time: dips under each hit, deepest for the heavy ones. */
function duckCurve(n, hits, duck) {
  const curve = new Float32Array(n).fill(1);
  if (duck >= 1) return curve;
  for (const hit of hits) {
    const weight = (DUCK_WEIGHT[hit.sfx] ?? 0.3) * Math.min(1, hit.gain);
    const floor = 1 - (1 - duck) * weight;
    const hold = 0.08 + 0.25 * weight;
    const from = Math.round((hit.t - DUCK_ATTACK) * SR);
    const to = Math.round((hit.t + hold + DUCK_RELEASE) * SR);
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) {
      const t = i / SR - hit.t;
      const depth = t < 0 ? 1 + t / DUCK_ATTACK : t < hold ? 1 : 1 - (t - hold) / DUCK_RELEASE;
      curve[i] = Math.min(curve[i], 1 - (1 - floor) * Math.max(0, Math.min(1, depth)));
    }
  }
  return curve;
}
const env = (t, attack, decay) => (t < attack ? t / attack : Math.exp(-(t - attack) / decay));

// ---------- instruments (each returns mono samples) ----------
function kick(punch = 1) {
  const out = buf(0.45);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const f = 45 + 110 * Math.exp(-t / 0.035);
    phase += (2 * Math.PI * f) / SR;
    out[i] =
      Math.tanh(Math.sin(phase) * 1.6 * punch) * Math.exp(-t / 0.22) +
      (t < 0.004 ? (1 - t / 0.004) * 0.3 : 0);
  }
  return out;
}
function clap(rand) {
  const out = buf(0.3);
  const bp = biquad("bp", 1300, 1.2);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const burst = t < 0.03 ? Math.exp(-((t % 0.01) / 0.003)) : Math.exp(-(t - 0.03) / 0.09);
    out[i] = bp(rand() * 2 - 1) * burst * 2.2;
  }
  return out;
}
function hat(rand, open = false) {
  const out = buf(open ? 0.25 : 0.06);
  const hp = biquad("hp", 7500, 0.8);
  for (let i = 0; i < out.length; i++)
    out[i] = hp(rand() * 2 - 1) * Math.exp(-(i / SR) / (open ? 0.09 : 0.018));
  return out;
}
function saw(freq, seconds, cutoff, attack, decay, detune = 0) {
  const out = buf(seconds);
  const lp = biquad("lp", cutoff, 0.9);
  let p1 = 0,
    p2 = 0.37;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    p1 = (p1 + (freq * (1 + detune)) / SR) % 1;
    p2 = (p2 + (freq * (1 - detune)) / SR) % 1;
    out[i] = lp((p1 * 2 - 1 + (p2 * 2 - 1)) * 0.5) * env(t, attack, decay);
  }
  return out;
}
// ---------- lo-fi ----------
// A dusty electric piano, a round bass, a soft boom-bap kit on swung eighths,
// vinyl under everything and a slow tape wobble over the whole bed.

/** Electric piano: a sine body, a struck tine that fades first and a slow tremolo. */
function keyNote(rand, freq, seconds, velocity) {
  const out = buf(seconds);
  const release = Math.min(0.12, seconds / 3);
  let body = rand();
  let tine = rand();
  let bell = rand();
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    body += freq / SR;
    tine += (freq * 2) / SR;
    bell += (freq * 6.95) / SR;
    const tail = Math.min(1, (seconds - t) / release);
    const amp = Math.min(1, t / 0.004) * Math.exp(-t / 1.4) * Math.max(0, tail);
    const trem = 1 + 0.12 * Math.sin(2 * Math.PI * 4.3 * t);
    out[i] =
      Math.tanh(
        (Math.sin(2 * Math.PI * body) * 0.8 +
          Math.sin(2 * Math.PI * tine) * 0.32 * Math.exp(-t / 0.15) +
          Math.sin(2 * Math.PI * bell) * 0.07 * Math.exp(-t / 0.045)) *
          1.3,
      ) *
      amp *
      trem *
      velocity;
  }
  return out;
}

/** A round, warm bass: a sine with a little second harmonic and a soft attack. */
function roundBass(freq, seconds) {
  const out = buf(seconds);
  const release = Math.min(0.08, seconds / 3);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    phase += freq / SR;
    const amp =
      Math.min(1, t / 0.012) *
      Math.exp(-t / 0.9) *
      Math.max(0, Math.min(1, (seconds - t) / release));
    out[i] =
      Math.tanh((Math.sin(2 * Math.PI * phase) + 0.22 * Math.sin(4 * Math.PI * phase)) * 1.4) * amp;
  }
  return out;
}

/** A soft, dark snare: a short body tone under band-passed noise. */
function softSnare(rand) {
  const out = buf(0.28);
  const bp = biquad("bp", 1700, 0.7);
  const lp = biquad("lp", 4800, 0.7);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const noise = bp(rand() * 2 - 1) * Math.exp(-t / 0.075) * 2.4;
    const body = Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t / 0.045) * 0.6;
    out[i] = lp(noise + body);
  }
  return out;
}

/** Record-surface hiss and crackle for the whole bed. */
function vinyl(rand, seconds) {
  const left = buf(seconds);
  const right = buf(seconds);
  const hissL = biquad("bp", 3200, 0.5);
  const hissR = biquad("bp", 3200, 0.5);
  for (let i = 0; i < left.length; i++) {
    left[i] = hissL(rand() * 2 - 1) * 0.018;
    right[i] = hissR(rand() * 2 - 1) * 0.018;
  }
  // Crackle: short clicks at random times, a few louder pops.
  const clicks = Math.round(seconds * 9);
  for (let k = 0; k < clicks; k++) {
    const at = Math.floor(rand() * left.length);
    const loud = rand() < 0.12 ? 0.32 : 0.09;
    const len = 12 + Math.floor(rand() * 30);
    const pan = rand();
    for (let j = 0; j < len && at + j < left.length; j++) {
      const v = (rand() * 2 - 1) * loud * (1 - j / len);
      left[at + j] += v * (1 - pan);
      right[at + j] += v * pan;
    }
  }
  return { left, right };
}

/** Tape wobble: a slowly varying delay bends the pitch of the whole bed, then darkens it. */
function tapeWobble(bus) {
  for (const channel of [bus.l, bus.r]) {
    const source = Float32Array.from(channel);
    const lp = biquad("lp", 6200, 0.7);
    for (let i = 0; i < channel.length; i++) {
      const t = i / SR;
      const delay =
        (0.006 +
          0.0022 * Math.sin(2 * Math.PI * 0.55 * t) +
          0.0006 * Math.sin(2 * Math.PI * 3.1 * t)) *
        SR;
      const pos = i - delay;
      const j = Math.floor(pos);
      const frac = pos - j;
      const a = j >= 0 && j < source.length ? source[j] : 0;
      const b = j + 1 >= 0 && j + 1 < source.length ? source[j + 1] : 0;
      channel[i] = lp(a + (b - a) * frac);
    }
  }
}

/**
 * Adds the key's own 7th to a triad, the colour a lo-fi chord is built on: a
 * major 7th where the key has it, else a minor 7th.
 */
function withSeventh(chord, keyNotes) {
  if (chord.tones.length > 3) return chord;
  return { ...chord, tones: [...chord.tones, keyNotes.has((chord.root + 11) % 12) ? 11 : 10] };
}
const SCALE_STEPS = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };

/**
 * The lo-fi bed on swung eighths. The off-beat eighth lands `SWING` of the way
 * through each beat, so everything leans back. Energy brings the kit in:
 * keys and vinyl alone below 0.25, kick and snare from 0.25, hats from 0.4,
 * the full kit from 0.5.
 */
const SWING = 0.6;
function lofiBed(
  music,
  { rand, beatsIn, beatSec, chordAt, sectionAt, duration, pumpCurve, keyNotes },
) {
  const kickSamples = kick(0.7);
  const drums = new Bus(duration + 2.5);
  const keys = new Bus(duration + 2.5);
  const bass = new Bus(duration + 2.5);
  const off = beatSec * SWING;
  beatsIn.forEach((t, i) => {
    const e = sectionAt(t).energy;
    const inBar = i % 4;
    const chord = withSeventh(chordAt(t), keyNotes);
    if (e >= 0.25) {
      if (inBar === 0) drums.add(t, kickSamples, 0.8);
      if (e >= 0.5 && (inBar === 1 || inBar === 2)) drums.add(t + off, kickSamples, 0.55);
      if (inBar === 1 || inBar === 3) drums.add(t + 0.012, softSnare(rand), 0.42, 0.04);
      if (inBar === 0 || (e >= 0.5 && inBar === 2)) {
        const s0 = Math.round(t * SR);
        for (let k = 0; k < 0.22 * SR && s0 + k < pumpCurve.length; k++)
          pumpCurve[s0 + k] = Math.min(pumpCurve[s0 + k], 0.72 + 0.28 * (k / (0.22 * SR)) ** 0.6);
      }
    }
    if (e >= 0.4) {
      drums.add(t, hat(rand), 0.06 + rand() * 0.03, 0.25);
      drums.add(t + off, hat(rand), 0.035 + rand() * 0.025, 0.25);
    }
    // Keys: a chord on the bar, answered on the swung "and" of two.
    if (inBar === 0 || inBar === 1) {
      const at = inBar === 0 ? t : t + off;
      const length = inBar === 0 ? beatSec * 1.55 : beatSec * 2.35;
      chord.tones.forEach((tone, idx) => {
        const note = keyNote(rand, hz(chord.root + tone + 60), length, 0.85 - idx * 0.08);
        keys.add(at + idx * 0.011, note, 0.16 * (0.6 + 0.4 * e), idx % 2 ? 0.3 : -0.3);
      });
    }
    // Bass: the root on the bar and on the swung "and" of three.
    if (e >= 0.15 && (inBar === 0 || inBar === 2)) {
      const at = inBar === 0 ? t : t + off;
      bass.add(at, roundBass(hz(chord.root + 36), beatSec * (inBar === 0 ? 1.5 : 0.9)), 0.42);
    }
  });
  // Keep the keys out of the bass's range so the low end stays round, not muddy.
  const keyHighPassL = biquad("hp", 170, 0.7);
  const keyHighPassR = biquad("hp", 170, 0.7);
  for (let i = 0; i < music.n; i++) {
    const p = pumpCurve[i];
    music.l[i] += drums.l[i] + (keyHighPassL(keys.l[i]) + bass.l[i]) * p;
    music.r[i] += drums.r[i] + (keyHighPassR(keys.r[i]) + bass.r[i]) * p;
  }
  const { left, right } = vinyl(rand, duration + 0.5);
  music.addStereo(0, left, right, 1);
  tapeWobble(music);
}

function noiseSweep(rand, seconds, fFrom, fTo, shape) {
  const out = buf(seconds);
  const bp = biquad("bp", fFrom, 1.4);
  for (let i = 0; i < out.length; i++) {
    const k = i / out.length;
    if (i % 64 === 0) bp.set(fFrom * (fTo / fFrom) ** k);
    out[i] = bp(rand() * 2 - 1) * shape(k) * 2.4;
  }
  return out;
}

// ---------- materials ----------
// A real object rings at several partials at once and starts with a short
// burst of noise; a bare sine reads as a toy. Each material below is a few
// damped partials ([ratio, decay s, level]) plus its own attack.
function partials(rand, f0, list, seconds, drop = 0) {
  const out = buf(seconds);
  const ramp = 0.0006 * SR;
  const tail = Math.min(out.length, 0.02 * SR);
  for (const [ratio, decay, level] of list) {
    let phase = rand() * Math.PI * 2;
    for (let i = 0; i < out.length; i++) {
      const t = i / SR;
      phase += (2 * Math.PI * f0 * ratio * (1 + drop * Math.exp(-t / 0.03))) / SR;
      // Fade in over 0.6 ms and out over the last 20 ms, so no edge clicks.
      const edge = Math.min(1, i / ramp, (out.length - i) / tail);
      out[i] += Math.sin(phase) * level * Math.exp(-t / decay) * edge;
    }
  }
  return out;
}
/** Add a filtered noise burst (the contact itself) to the start of `out`. */
function attack(rand, out, freq, q, seconds, level) {
  const bp = biquad("bp", freq, q);
  const n = Math.min(out.length, Math.max(1, Math.round(seconds * SR)));
  for (let i = 0; i < n; i++) out[i] += bp(rand() * 2 - 1) * level * 3 * (1 - i / n) ** 2;
  return out;
}
const soften = (out, drive) => out.map((v) => Math.tanh(v * drive) / Math.tanh(drive));

/** Wood: a short hollow body that drops slightly in pitch, and a dry snap. */
function wood(rand, f = 190, bright = 1) {
  const out = partials(
    rand,
    f,
    [
      [1, 0.075, 1],
      [2.63, 0.034, 0.45],
      [4.9, 0.017, 0.2],
    ],
    0.3,
    0.07,
  );
  return soften(attack(rand, out, 2100 * bright, 1.3, 0.006, 0.7), 1.2);
}
/** Glass: a clear tone with bright, inharmonic overtones that die first. */
function glass(rand, f = 1320, length = 1) {
  const out = partials(
    rand,
    f,
    [
      [1, 0.5 * length, 1],
      [2.32, 0.24 * length, 0.38],
      [4.18, 0.12 * length, 0.2],
      [6.71, 0.06 * length, 0.1],
    ],
    0.2 + 0.9 * length,
  );
  return attack(rand, out, 3500, 2, 0.002, 0.35);
}
/** Plastic: a key or a button, tiny and close. */
function plastic(rand, f = 1150) {
  const out = partials(
    rand,
    f * (0.92 + rand() * 0.16),
    [
      [1, 0.022, 1],
      [2.08, 0.011, 0.4],
    ],
    0.06,
  );
  return attack(rand, out, 3800, 1.1, 0.003, 0.8);
}
/** Felt: a soft landing, mostly weight, with the thump of contact. */
function felt(rand, f = 66, length = 1) {
  const out = partials(
    rand,
    f,
    [
      [1, 0.3 * length, 1],
      [1.48, 0.11 * length, 0.25],
      [2.9, 0.04, 0.08],
    ],
    0.25 + 0.9 * length,
    0.9,
  );
  return soften(attack(rand, out, 380, 0.7, 0.012, 0.6), 1.5);
}
/** Air: breath through two moving resonances, swelling then falling away. */
function breath(rand, seconds, from, to, peakAt = 0.6) {
  const out = buf(seconds);
  const a = biquad("bp", from, 2.2);
  const b = biquad("bp", from * 1.5, 3);
  const lp = biquad("lp", 6000, 0.7);
  for (let i = 0; i < out.length; i++) {
    const k = i / out.length;
    if (i % 64 === 0) {
      const f = from * (to / from) ** k;
      a.set(f);
      b.set(f * 1.5);
    }
    const shape = k < peakAt ? (k / peakAt) ** 1.6 : ((1 - k) / (1 - peakAt)) ** 1.2;
    const x = rand() * 2 - 1;
    out[i] = lp(a(x) * 2.6 + b(x) * 1.4) * shape;
  }
  return out;
}
/** A drop of water: a resonance that rises as it closes. */
function droplet(rand, f = 520) {
  const out = buf(0.11);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    phase += (2 * Math.PI * f * (1 + 0.9 * (1 - Math.exp(-t / 0.02)))) / SR;
    out[i] = Math.sin(phase) * Math.exp(-t / 0.045) * Math.min(1, t / 0.0008);
  }
  return attack(rand, out, 2600, 1.5, 0.002, 0.12);
}
/** Paper: a dry, grainy slide with a little body under it. */
function paper(rand, seconds = 0.35) {
  const out = buf(seconds);
  const hiss = biquad("bp", 2200, 0.9);
  const body = biquad("bp", 700, 0.7);
  const lp = biquad("lp", 6500, 0.7);
  let grain = 0;
  let next = 0;
  for (let i = 0; i < out.length; i++) {
    if (i >= next) {
      grain = 0.4 + rand() * 0.6;
      next = i + Math.round((0.008 + rand() * 0.012) * SR);
    }
    grain *= 0.9995;
    const x = rand() * 2 - 1;
    out[i] =
      lp(hiss(x) * 2.2 + body(x) * 0.8) * grain * Math.sin(Math.PI * (i / out.length)) ** 1.2;
  }
  return out;
}
/** Two short pieces end to end, `gap` seconds apart (press then release). */
function pair(first, second, gap, secondLevel) {
  const off = Math.round(gap * SR);
  const out = buf((off + second.length) / SR);
  for (let i = 0; i < first.length && i < out.length; i++) out[i] += first[i];
  for (let i = 0; i < second.length && off + i < out.length; i++)
    out[off + i] += second[i] * secondLevel;
  return out;
}
function mix(base, extra, level) {
  const out = buf(Math.max(base.length, extra.length) / SR);
  for (let i = 0; i < base.length; i++) out[i] += base[i];
  for (let i = 0; i < extra.length; i++) out[i] += extra[i] * level;
  return out;
}

// ---------- sound effects ----------
function sfx(name, rand, beatSec, chord) {
  switch (name) {
    case "tap":
      return plastic(rand);
    case "press":
      return pair(plastic(rand, 980), plastic(rand, 1320), 0.07, 0.55);
    case "knock":
      return wood(rand);
    case "chime":
      return glass(rand, hz(chord.root + chord.tones[0] + 84));
    case "breath":
    case "whoosh":
      return breath(rand, 0.7, 280, 3600);
    case "whoosh-short":
      return breath(rand, 0.32, 600, 5200, 0.5);
    case "thud":
      return felt(rand);
    case "plip":
    case "pop":
      return droplet(rand, name === "pop" ? 600 : 520);
    case "paper":
      return paper(rand);
    case "riser": {
      const len = beatSec * 4;
      const n = noiseSweep(rand, len, 200, 9000, (k) => k ** 2.2);
      const tone = saw(hz(chord.root + 48), len, 1400, len * 0.9, 99, 0.004);
      for (let i = 0; i < n.length; i++) n[i] = n[i] * 0.8 + tone[i] * 0.3 * (i / n.length) ** 2;
      return n;
    }
    case "impact":
      return mix(felt(rand, 60, 1.2), wood(rand, 140, 0.8), 0.5);
    case "sub-drop":
      return felt(rand, 46, 1.4);
    case "click":
      return plastic(rand, 1500);
    case "tick":
      return glass(rand, 2400, 0.12);
    case "snap":
      return wood(rand, 420, 1.5);
    case "glitch": {
      const out = buf(0.3);
      let hold = 0,
        v = 0;
      for (let i = 0; i < out.length; i++) {
        if (hold-- <= 0) {
          hold = Math.floor(rand() * 900) + 60;
          v = (rand() * 2 - 1) * (rand() < 0.3 ? 0 : 1);
        }
        out[i] = (Math.round(v * 6) / 6) * 0.7;
      }
      return out;
    }
    case "shimmer": {
      const out = buf(1.4);
      chord.tones.forEach((tone, idx) => {
        const note = glass(rand, hz(chord.root + tone + 84), 0.9);
        const off = Math.round(idx * 0.08 * SR);
        for (let i = 0; i < note.length && i + off < out.length; i++) out[i + off] += note[i] * 0.3;
      });
      return out;
    }
    case "sting": {
      const len = 2.2;
      const out = buf(len);
      for (const tone of chord.tones) {
        const s = saw(hz(chord.root + tone + 48), len, 2600, 0.005, 0.7, 0.004);
        for (let i = 0; i < s.length; i++) out[i] += s[i] * 0.35;
      }
      const body = sfx("impact", rand, beatSec, chord);
      for (let i = 0; i < body.length; i++) out[i] += body[i] * 0.8;
      return out;
    }
    case "swell": {
      const len = beatSec * 2;
      const out = buf(len);
      for (const tone of chord.tones) {
        const s = saw(hz(chord.root + tone + 60), len, 1800, len * 0.95, 0.05, 0.006);
        for (let i = 0; i < s.length; i++) out[i] += s[i] * 0.3;
      }
      return out;
    }
    case "typing": {
      const out = buf(1.2);
      let t = 0;
      while (t < 1.1) {
        const c = plastic(rand, 1050);
        const off = Math.round(t * SR);
        for (let i = 0; i < c.length && off + i < out.length; i++)
          out[off + i] += c[i] * (0.5 + rand() * 0.5);
        t += 0.06 + rand() * 0.07;
      }
      return out;
    }
    default:
      return fail(`unknown sfx ${name}`);
  }
}

// ---------- arrangement ----------
function render(score) {
  const rand = rng(score.seed);
  const beatSec = 60 / score.bpm;
  const barSec = beatSec * 4;
  const beats =
    score.beatTimes ??
    Array.from({ length: Math.ceil(score.duration / beatSec) + 1 }, (_, i) => i * beatSec);
  const within = (t) => t >= 0 && t < score.duration;
  const beatsIn = beats.filter(within);
  const bars = beatsIn.filter((_, i) => i % 4 === 0);
  const chordNames = score.chords ?? defaultChords(score.key, score.scale);
  const chords = chordNames.map(chordNotes);
  // A resolving ending comes home: the last bar (or the last two, when the
  // final one is short) plays the first chord of the progression.
  const homeFrom =
    score.ending === "resolve" && bars.length > 1
      ? (bars.filter((b) => b <= score.duration - barSec * 0.75).at(-1) ?? Infinity)
      : Infinity;
  const chordAt = (t) =>
    t >= homeFrom - 1e-6
      ? chords[0]
      : chords[Math.max(0, bars.filter((b) => b <= t + 1e-6).length - 1) % chords.length];
  const sectionAt = (t) =>
    score.sections.filter((s) => s.from <= t + 1e-6).at(-1) ?? score.sections[0];
  const beatTime = (b) =>
    b < beats.length ? beats[b] : beats.at(-1) + (b - beats.length + 1) * beatSec;

  const music = new Bus(score.duration + 2.5);
  const effects = new Bus(score.duration + 2.5);
  // What each effect sends to the room, so near sounds stay dry and far ones bloom.
  const roomSend = new Bus(score.duration + 2.5);
  const place = (start, samples, gain, pan, sound, send) => {
    effects.add(start, samples, gain, pan);
    roomSend.add(start, samples, gain * (send ?? DEFAULT_SEND[sound] ?? 0.3), pan);
  };
  const pumpCurve = new Float32Array(music.n).fill(1);

  if (score.music && score.style === "lofi") {
    lofiBed(music, {
      rand,
      beatsIn,
      beatSec,
      chordAt,
      sectionAt,
      duration: score.duration,
      pumpCurve,
      keyNotes: new Set(SCALE_STEPS[score.scale].map((step) => (parseRoot(score.key) + step) % 12)),
    });
  } else if (score.music) {
    const kickSamples = kick();
    const cinematic = score.style === "cinematic";
    const minimal = score.style === "minimal";
    beatsIn.forEach((t, i) => {
      const e = sectionAt(t).energy;
      const onBar = i % 4 === 0;
      const kickOn = cinematic ? onBar && e >= 0.3 : e >= 0.5 || (e >= 0.2 && i % 2 === 0);
      if (kickOn && !minimal) {
        music.add(t, kickSamples, cinematic ? 0.9 : 0.75);
        const s0 = Math.round(t * SR);
        for (let k = 0; k < 0.25 * SR && s0 + k < pumpCurve.length; k++) {
          pumpCurve[s0 + k] = Math.min(pumpCurve[s0 + k], 0.45 + 0.55 * (k / (0.25 * SR)) ** 0.6);
        }
      }
      if (!cinematic && !minimal && e >= 0.6 && i % 2 === 1) music.add(t, clap(rand), 0.32, 0.05);
      if (!cinematic && e >= 0.4) {
        music.add(t + beatSec / 2, hat(rand), 0.12, 0.3);
        if (e >= 0.85) {
          music.add(t + beatSec / 4, hat(rand), 0.06, -0.3);
          music.add(t + (3 * beatSec) / 4, hat(rand), 0.06, -0.3);
        }
      }
      if (minimal && e > 0)
        music.add(t, sfx("tick", rand, beatSec, chordAt(t)), 0.05 + 0.08 * e, i % 2 ? 0.4 : -0.4);
    });

    // Bass on eighths (pulse) or held roots (cinematic), following the bar's chord.
    const bassBus = new Bus(score.duration + 2.5);
    for (const t of beatsIn) {
      const e = sectionAt(t).energy;
      if (e < 0.35 || minimal) continue;
      const c = chordAt(t);
      const f = hz(c.root + 36);
      if (cinematic) {
        if (bars.includes(t)) bassBus.add(t, saw(f, barSec, 380, 0.02, barSec * 0.6), 0.5);
      } else {
        for (const off of [0, beatSec / 2])
          bassBus.add(t + off, saw(f, beatSec / 2, 300 + 900 * e, 0.004, 0.12), 0.42);
      }
    }
    // Pads: one chord per bar, slow attack; brighter with energy.
    for (const t of bars) {
      const e = sectionAt(t).energy;
      if (e <= 0) continue;
      const c = chordAt(t);
      const len = barSec * 1.05;
      const left = new Float32Array(Math.round(len * SR));
      const right = new Float32Array(left.length);
      c.tones.forEach((tone, idx) => {
        const note = saw(
          hz(c.root + tone + 60),
          len,
          700 + 2200 * e,
          barSec * 0.35,
          barSec * 0.9,
          0.006 + idx * 0.002,
        );
        for (let i = 0; i < note.length && i < left.length; i++) {
          left[i] += note[i] * (idx % 2 ? 0.7 : 1);
          right[i] += note[i] * (idx % 2 ? 1 : 0.7);
        }
      });
      music.addStereo(t, left, right, (minimal ? 0.16 : 0.11) * (0.5 + e));
    }
    // Sidechain pump on bass + pads gives the bed its "breathing" motion.
    for (let i = 0; i < music.n; i++) {
      const p = pumpCurve[i];
      music.l[i] = music.l[i] * (0.35 + 0.65 * p) + bassBus.l[i] * p;
      music.r[i] = music.r[i] * (0.35 + 0.65 * p) + bassBus.r[i] * p;
    }

    // Automatic transitions: a riser into, and an impact on, every big energy jump.
    score.sections.forEach((s, i) => {
      if (i === 0) return;
      const prev = score.sections[i - 1];
      if (s.energy - prev.energy >= 0.35 && s.from >= barSec) {
        const riser = sfx("riser", rand, beatSec, chordAt(s.from));
        place(s.from - riser.length / SR, riser, 0.35, 0, "riser");
        place(s.from, sfx("impact", rand, beatSec, chordAt(s.from)), 0.55, 0, "impact");
      }
    });
  }

  // Explicit hits, resolved to seconds on the same grid, then thinned: two
  // short sounds closer than MERGE_WINDOW read as one, so keep the stronger.
  const timed = score.hits
    .map((h, i) => {
      const t =
        h.t !== undefined
          ? Number(h.t)
          : h.beat !== undefined
            ? beatTime(Number(h.beat))
            : beatTime(Number(h.bar) * 4);
      if (!(t >= 0)) fail(`hit ${i}: resolved to an invalid time`);
      return { ...h, t, order: i };
    })
    .sort((a, b) => a.t - b.t || a.order - b.order);
  const strength = (h) => (DUCK_WEIGHT[h.sfx] ?? 0.3) * h.gain;
  const kept = [];
  const merged = [];
  for (const h of timed) {
    const near = LONG_SOUNDS.has(h.sfx)
      ? undefined
      : kept.findLast((k) => !LONG_SOUNDS.has(k.sfx) && h.t - k.t < MERGE_WINDOW);
    if (!near) kept.push(h);
    else if (strength(h) > strength(near)) {
      kept[kept.indexOf(near)] = h;
      merged.push({ t: Number(near.t.toFixed(4)), sfx: near.sfx, into: h.sfx });
    } else merged.push({ t: Number(h.t.toFixed(4)), sfx: h.sfx, into: near.sfx });
  }
  const resolvedHits = kept.map((h, i) => {
    const t = h.t;
    const samples = sfx(h.sfx, rand, beatSec, chordAt(t));
    // A riser/swell placed at t should *arrive* at t.
    const start = h.sfx === "riser" || h.sfx === "swell" ? t - samples.length / SR : t;
    const pan =
      typeof h.pan === "number"
        ? Math.max(-1, Math.min(1, h.pan))
        : /^(whoosh|breath)/.test(h.sfx)
          ? i % 2
            ? 0.35
            : -0.35
          : 0;
    const base =
      {
        impact: 0.6,
        sting: 0.6,
        "sub-drop": 0.6,
        thud: 0.6,
        riser: 0.4,
        whoosh: 0.4,
        breath: 0.4,
        "whoosh-short": 0.35,
        glitch: 0.3,
        shimmer: 0.3,
        swell: 0.35,
      }[h.sfx] ?? 0.4;
    place(start, samples, base * h.gain, pan, h.sfx, h.send);
    return {
      t: Number(t.toFixed(4)),
      sfx: h.sfx,
      gain: h.gain,
      ...(h.source ? { source: h.source } : {}),
      ...(h.name ? { name: h.name } : {}),
    };
  });

  // Camera air: the operated camera's own motion, heard as air moving past.
  // Silent while the camera is still, brighter and louder as it travels.
  let airPeak = 0;
  if (score.air && score.airCurve) {
    const { rate, start, values } = score.airCurve;
    const left = new Float32Array(effects.n);
    const right = new Float32Array(effects.n);
    const filters = [0, 1].map(() => ({
      a: biquad("bp", 300, 1.1),
      b: biquad("bp", 660, 1.6),
      lp: biquad("lp", 7000, 0.7),
    }));
    let level = 0;
    for (let i = 0; i < effects.n; i++) {
      const k = (i / SR - start) * rate;
      const j = Math.floor(k);
      const v =
        j < 0 || j >= values.length
          ? 0
          : values[j] + ((values[j + 1] ?? values[j]) - values[j]) * (k - j);
      const target = Math.min(1, v / 4000) ** 1.3;
      level += (target - level) * 0.0015; // ~14 ms smoothing
      if (i % 64 === 0)
        for (const f of filters) {
          f.a.set(220 + 2600 * level);
          f.b.set((220 + 2600 * level) * 2.2);
        }
      if (level < 0.02) continue;
      airPeak = Math.max(airPeak, level);
      const [fl, fr] = filters;
      const xl = rand() * 2 - 1;
      const xr = rand() * 2 - 1;
      left[i] = fl.lp(fl.a(xl) * 2 + fl.b(xl)) * 0.12 * level;
      right[i] = fr.lp(fr.a(xr) * 2 + fr.b(xr)) * 0.12 * level;
    }
    effects.addStereo(0, left, right);
    roomSend.addStereo(0, left, right, 0.5);
  }

  // Duck the music under the hits, then put everything in the same room.
  if (score.music) {
    const curve = duckCurve(music.n, resolvedHits, score.duck);
    for (let i = 0; i < music.n; i++) {
      music.l[i] *= curve[i];
      music.r[i] *= curve[i];
    }
  }
  const room = ROOMS[score.room];
  applyRoom(effects, room, 1, roomSend);
  // The bed gets a lighter send of the same room so the two sit together.
  if (score.music) applyRoom(music, room, 0.35);
  // Resolve: let the home chord breathe out over the last stretch instead of stopping.
  if (score.music && score.ending === "resolve") {
    const fade = Math.min(score.duration * 0.25, Math.max(barSec, 1.5));
    const from = Math.round((score.duration - fade) * SR);
    const to = Math.round(score.duration * SR);
    for (let i = Math.max(0, from); i < music.n; i++) {
      const k = i >= to ? 1 : (i - from) / (to - from);
      const g = i >= to ? 0 : Math.cos((k * Math.PI) / 2) ** 1.5;
      music.l[i] *= g;
      music.r[i] *= g;
    }
  }

  return {
    music,
    effects,
    map: {
      bpm: score.bpm,
      beatSec: Number(beatSec.toFixed(5)),
      barSec: Number(barSec.toFixed(5)),
      duration: score.duration,
      beats: beatsIn.map((t) => Number(t.toFixed(4))),
      bars: bars.map((t) => Number(t.toFixed(4))),
      sections: score.sections.map((s, i) => ({
        ...s,
        to: score.sections[i + 1]?.from ?? score.duration,
      })),
      chords: chordNames,
      room: score.room,
      duck: score.duck,
      ending: score.music ? score.ending : null,
      hits: resolvedHits.map(({ gain, ...hit }) => hit).sort((a, b) => a.t - b.t),
      ...(merged.length ? { merged } : {}),
      ...(score.airCurve ? { air: score.air ? { peak: Number(airPeak.toFixed(3)) } : "off" } : {}),
    },
  };
}

// ---------- balance ----------
// The picture's sounds must be heard over the music. For each hit, compare
// the effects and the music in the hit's own window and band, at the levels
// they are written at and played back at equal volume.
function bandRms(bus, gain, from, to, band) {
  const pre = Math.round(0.05 * SR);
  const s0 = Math.max(0, Math.round(from * SR) - pre);
  const s1 = Math.min(bus.n, Math.round(to * SR));
  const [lo, hi] = band;
  const hp = biquad("hp", lo, 0.7);
  const lp = biquad("lp", hi, 0.7);
  let sum = 0;
  let count = 0;
  for (let i = s0; i < s1; i++) {
    const y = lp(hp((bus.l[i] + bus.r[i]) * 0.5 * gain));
    if (i >= s0 + pre) {
      sum += y * y;
      count++;
    }
  }
  return count ? Math.sqrt(sum / count) : 0;
}
function balance(music, musicGain, effects, effectsGain, hits) {
  const rows = hits.map((h) => {
    const band = LOW_SOUNDS.has(h.sfx) ? [60, 400] : [1000, 5000];
    const [a, b] = HEARD_AT[h.sfx] ?? [0, 0.12];
    const [from, to] = [h.t + a, h.t + b];
    const fx = bandRms(effects, effectsGain, from, to, band);
    const bed = bandRms(music, musicGain, from, to, band);
    const db = fx > 0 && bed > 0 ? 20 * Math.log10(fx / bed) : fx > 0 ? 99 : -99;
    return {
      t: h.t,
      sfx: h.sfx,
      ...(h.name ? { name: h.name } : {}),
      db: Math.max(-99, Math.min(99, Math.round(db * 10) / 10)),
    };
  });
  const worst = rows.reduce((m, r) => Math.min(m, r.db), Infinity);
  // Turn the music down until the most buried hit sits at BURIED_DB.
  const musicVolume =
    rows.length && worst < BURIED_DB
      ? Math.max(0.2, Math.floor(10 ** ((worst - BURIED_DB) / 20) * 20) / 20)
      : 1;
  return {
    buried: rows.filter((r) => r.db < BURIED_DB),
    musicVolume,
    effectsVolume: 1,
    threshold: BURIED_DB,
  };
}

// ---------- mud ----------
// Piled-up note tails collect in the low mids (~100-300 Hz) and turn a mix
// muddy. Measure each half-second window of the mix as played (music at the
// balance report's suggested volume plus effects): the share of its energy in
// that band, and which bus puts more there.
const MUD_BAND = [100, 300];
const MUD_WINDOW = 0.5;
// The share is spectral, so a louder mix is not a muddier one. Measured on
// GG's own scores (4 styles x 6 keys/seeds x 70/100/128 bpm, 16 s with four
// sections and ten typical hits; 72 renders, 2304 windows): window share
// median 0.079, p95 0.203, p99 0.308, max 0.401 (lofi in B minor); by style
// max pulse 0.305, cinematic 0.368, minimal 0.332, lofi 0.401; whole-mix
// share 0.03-0.154. The darkest normal bed found (lofi in B at 40 bpm) peaks
// at 0.434. A deliberately muddy score (wooden knocks piled every 60 ms, their
// 190 Hz bodies overlapping) measures 0.45-0.53 in the piled windows.
const MUD_THRESHOLD = 0.45;
/** Energy per window: [total, low-mid band] for one bus at one gain. */
function windowEnergy(bus, gain, n, windows) {
  const per = Math.round(MUD_WINDOW * SR);
  const total = new Float64Array(windows);
  const band = new Float64Array(windows);
  if (!gain) return { total, band };
  const hp1 = biquad("hp", MUD_BAND[0], 0.7);
  const hp2 = biquad("hp", MUD_BAND[0], 0.7);
  const lp1 = biquad("lp", MUD_BAND[1], 0.7);
  const lp2 = biquad("lp", MUD_BAND[1], 0.7);
  for (let i = 0; i < n; i++) {
    const x = (bus.l[i] + bus.r[i]) * 0.5 * gain;
    const y = lp2(lp1(hp2(hp1(x))));
    const w = Math.min(windows - 1, Math.floor(i / per));
    total[w] += x * x;
    band[w] += y * y;
  }
  return { total, band };
}
/**
 * @param {Bus} music @param {number} musicGain @param {Bus} effects
 * @param {number} effectsGain @param {number} duration
 */
function mud(music, musicGain, effects, effectsGain, duration) {
  const n = Math.min(music.n, Math.round(duration * SR));
  const windows = Math.max(1, Math.ceil(n / Math.round(MUD_WINDOW * SR)));
  const m = windowEnergy(music, musicGain, n, windows);
  const e = windowEnergy(effects, effectsGain, n, windows);
  const round = (v) => Math.round(v * 1000) / 1000;
  const rows = [];
  let sumTotal = 0;
  let sumBand = 0;
  for (let w = 0; w < windows; w++) {
    // Buses are summed as energies (uncorrelated sources).
    const total = m.total[w] + e.total[w];
    const band = m.band[w] + e.band[w];
    sumTotal += total;
    sumBand += band;
    // Ignore near-silence: a share of nothing is not mud.
    if (total / (Math.round(MUD_WINDOW * SR) || 1) < 1e-6) continue;
    const share = band / total;
    if (share > MUD_THRESHOLD)
      rows.push({
        from: round(w * MUD_WINDOW),
        to: round(Math.min(duration, (w + 1) * MUD_WINDOW)),
        share: round(share),
        bus: m.band[w] >= e.band[w] ? "music" : "effects",
      });
  }
  return {
    windows: rows,
    share: round(sumTotal > 0 ? sumBand / sumTotal : 0),
    threshold: MUD_THRESHOLD,
    band: MUD_BAND,
    window: MUD_WINDOW,
  };
}

// ---------- mastering + WAV ----------
function master(bus, duration, targetPeak) {
  const n = Math.round(duration * SR);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    bus.l[i] = Math.tanh(bus.l[i] * 1.1);
    bus.r[i] = Math.tanh(bus.r[i] * 1.1);
    peak = Math.max(peak, Math.abs(bus.l[i]), Math.abs(bus.r[i]));
  }
  const g = peak > 0 ? targetPeak / peak : 0;
  bus.gain = g;
  const fade = Math.min(n, Math.round(0.03 * SR));
  const out = Buffer.alloc(44 + n * 4);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + n * 4, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(2, 22);
  out.writeUInt32LE(SR, 24);
  out.writeUInt32LE(SR * 4, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const f = i >= n - fade ? (n - i) / fade : 1;
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, bus.l[i] * g * f)) * 32767), 44 + i * 4);
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, bus.r[i] * g * f)) * 32767), 46 + i * 4);
  }
  return { wav: out, peakDb: peak > 0 ? 20 * Math.log10(targetPeak) : null };
}

const [scoreArg, outArg] = process.argv.slice(2);
if (!scoreArg || !outArg) fail("usage: score-synth.mjs <score.json> <out-dir>");
let raw;
try {
  raw = JSON.parse(await readFile(resolve(scoreArg), "utf8"));
} catch (error) {
  fail(
    `Could not read score ${scoreArg}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
const score = validate(raw);
if (score.cues) {
  const loaded = await loadCues(resolve(dirname(resolve(scoreArg)), score.cues), score.duration);
  score.hits.push(...loaded.hits);
  score.airCurve = loaded.air;
}
const outDir = resolve(outArg);
await mkdir(outDir, { recursive: true });
const { music, effects, map } = render(score);
const written = [];
if (score.music) {
  await writeFile(join(outDir, "music.wav"), master(music, score.duration, 0.79).wav); // ≈ -2 dBFS peak
  written.push("music.wav");
}
if (map.hits.length || score.music || map.air?.peak) {
  await writeFile(join(outDir, "sfx.wav"), master(effects, score.duration, 0.71).wav); // ≈ -3 dBFS peak
  written.push("sfx.wav");
}
if (score.music && map.hits.length)
  map.balance = balance(music, music.gain, effects, effects.gain, map.hits);
if (written.length)
  map.mud = mud(
    music,
    score.music ? (music.gain ?? 0) * (map.balance?.musicVolume ?? 1) : 0,
    effects,
    effects.gain ?? 0,
    score.duration,
  );
await writeFile(join(outDir, "tempo-map.json"), `${JSON.stringify(map, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    outDir,
    files: [...written, "tempo-map.json"],
    bpm: map.bpm,
    beats: map.beats.length,
    hits: map.hits.length,
    cueHits: map.hits.filter((h) => h.source === "cue").length,
    room: score.room,
    ...(map.merged ? { merged: map.merged.length } : {}),
    ...(map.air && map.air !== "off" ? { cameraAir: map.air.peak } : {}),
    ...(map.balance
      ? { buried: map.balance.buried.length, musicVolume: map.balance.musicVolume }
      : {}),
    ...(map.mud ? { muddy: map.mud.windows.length } : {}),
  })}\n`,
);
