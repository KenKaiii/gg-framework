#!/usr/bin/env node
// GG Motion music fit: cut a supplied music track to the picture's length out
// of whole bars of the original, so it starts, lands and ends on the beat.
//
// Usage: node music-fit.mjs <track.(mp3|wav|m4a)> --duration <s>
//                           [--land <trackTime>@<filmTime>] [--out <dir>]
// Writes: <out>/music.wav (48 kHz stereo, exactly --duration long) and
//         <out>/music-fit.json (bpm, the fitted track's downbeats in film
//         time and the edit list: which source range plays where).
// Prints a one-line JSON summary; errors print { ok: false, error } and exit 1.
//
// Method (deterministic, constant tempo assumed — produced music):
//  1. Decode to 48 kHz stereo with ffmpeg; analyse a mono mix at 24 kHz.
//  2. Onset strength: log-magnitude spectral flux (1024-sample Hann frames,
//     hop 256 ≈ 10.7 ms), minus its 0.5 s moving average, half-wave
//     rectified. A second envelope uses only bins below 200 Hz (the kick).
//  3. Tempo: autocorrelation of the envelope over lags for 60–200 bpm, with a
//     log-normal preference around 120 bpm against octave errors; then a fine
//     search (±2 % in 0.01 bpm steps, quarter-frame phases) for the period and
//     phase whose beat comb collects the most onset strength over the whole
//     track, so the grid does not drift over minutes.
//  4. Downbeats: of the four beat phases, the one whose beats carry the most
//     onset strength (low band weighted double, since the kick marks "one").
//  5. Plan: film downbeats sit at land + k·bar. Before the land the track
//     plays into it (a pickup from the source before a downbeat, repeating
//     bars only when the intro is too short); after it whole bars play on,
//     jumping (by whole phrases of 4 bars when possible) to the track's own
//     ending so the last downbeat lands 0.25 s–1 bar before the end and its
//     ring-out fades. Every cut sits on a downbeat of both source and film,
//     joined by a 40 ms equal-power crossfade centred on it.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ffmpegBinary } from "./media-binaries.mjs";

const SR = 48000;
const ASR = 24000;
const FRAME = 1024;
const HOP = 256;
const LAG = (FRAME * 3) / 4;
const XFADE = 0.04;
const MIN_TAIL = 0.25;
const END_FADE = 0.6;

class FitError extends Error {}

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = { track: "", duration: NaN, land: null, out: "." };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--duration") opts.duration = Number(argv[++i]);
    else if (a === "--out") opts.out = argv[++i] ?? "";
    else if (a === "--land") {
      const m = /^(\d+(?:\.\d+)?)@(\d+(?:\.\d+)?)$/.exec(argv[++i] ?? "");
      if (!m) throw new FitError("--land must be <trackTime>@<filmTime> in seconds, e.g. 12.5@4");
      opts.land = { track: Number(m[1]), film: Number(m[2]) };
    } else if (a.startsWith("--")) throw new FitError(`unknown option ${a}`);
    else if (!opts.track) opts.track = a;
    else throw new FitError(`unexpected argument ${a}`);
  }
  if (!opts.track)
    throw new FitError(
      "usage: music-fit.mjs <track.(mp3|wav|m4a)> --duration <s> [--land <trackTime>@<filmTime>] [--out <dir>]",
    );
  if (!/\.(mp3|wav|m4a)$/i.test(opts.track)) throw new FitError("track must be .mp3, .wav or .m4a");
  if (!(opts.duration > 0 && opts.duration <= 900))
    throw new FitError("--duration must be between 0 and 900 seconds");
  if (!opts.out) throw new FitError("--out needs a directory");
  if (opts.land && !(opts.land.film < opts.duration))
    throw new FitError("--land film time must be inside --duration");
  return opts;
}

/** Decode any track to 48 kHz interleaved stereo float PCM. */
async function decode(path) {
  const ffmpeg = await ffmpegBinary();
  const args = ["-v", "error", "-i", path, "-ac", "2", "-ar", String(SR), "-f", "f32le", "pipe:1"];
  const bytes = await new Promise((done, failed) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let err = "";
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", failed);
    child.on("close", (code) =>
      code === 0
        ? done(Buffer.concat(chunks))
        : failed(new FitError(`could not decode ${path}: ${err.trim() || `ffmpeg exit ${code}`}`)),
    );
  });
  const n = Math.floor(bytes.length / 8);
  if (n < SR) throw new FitError("track is shorter than one second or not audio");
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = bytes.readFloatLE(i * 8);
    r[i] = bytes.readFloatLE(i * 8 + 4);
  }
  return { l, r, n };
}

/** In-place radix-2 FFT. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
  }
}

/** Normalised onset-strength envelopes (full band and below 200 Hz), one value per hop. */
function onsetEnvelopes(audio) {
  const m = Math.floor(audio.n / 2);
  const mono = new Float32Array(m);
  for (let i = 0; i < m; i++)
    mono[i] = (audio.l[2 * i] + audio.r[2 * i] + audio.l[2 * i + 1] + audio.r[2 * i + 1]) / 4;
  const frames = Math.max(1, Math.floor((m - FRAME) / HOP) + 1);
  const win = Float32Array.from(
    { length: FRAME },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME),
  );
  const bins = FRAME / 2;
  const lowBins = Math.round((200 * FRAME) / ASR);
  let prev = new Float32Array(bins);
  const full = new Float64Array(frames);
  const low = new Float64Array(frames);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < FRAME; i++) {
      re[i] = (mono[f * HOP + i] ?? 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      mag[k] = Math.log1p(1000 * Math.hypot(re[k], im[k]));
      const d = mag[k] - prev[k];
      if (f > 0 && d > 0) {
        full[f] += d;
        if (k <= lowBins) low[f] += d;
      }
    }
    prev = mag;
  }
  return { full: normalise(full), low: normalise(low), frames };
}

/** Subtract a 0.5 s moving average, half-wave rectify, scale to unit mean. */
function normalise(env) {
  const half = Math.round((0.25 * ASR) / HOP);
  const out = new Float64Array(env.length);
  const pre = new Float64Array(env.length + 1);
  for (let i = 0; i < env.length; i++) pre[i + 1] = pre[i] + env[i];
  let sum = 0;
  for (let i = 0; i < env.length; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(env.length, i + half + 1);
    out[i] = Math.max(0, env[i] - (pre[b] - pre[a]) / (b - a));
    sum += out[i];
  }
  const mean = sum / env.length || 1;
  for (let i = 0; i < out.length; i++) out[i] /= mean;
  return out;
}

const at = (env, x) => {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= env.length) return 0;
  return env[i] + (env[i + 1] - env[i]) * (x - i);
};

/** Tempo, beat phase and downbeat phase from the onset envelopes. */
function beatGrid({ full, low, frames }) {
  const fps = ASR / HOP;
  // Coarse: autocorrelation with a log-normal tempo preference around 120 bpm.
  let best = { score: -Infinity, lag: 0 };
  const minLag = Math.floor((60 / 200) * fps);
  const maxLag = Math.ceil((60 / 60) * fps);
  // Smooth for the coarse search so a fractional-frame period still correlates.
  const soft = full.map(
    (_, i) =>
      [-2, -1, 0, 1, 2].reduce((s, d, k) => s + (full[i + d] ?? 0) * [1, 2, 3, 2, 1][k], 0) / 9,
  );
  const ac = (lag) => {
    let s = 0;
    for (let i = 0; i + lag < frames; i++) s += soft[i] * soft[i + lag];
    return s / (frames - lag);
  };
  for (let lag = minLag; lag <= maxLag; lag++) {
    const s = ac(lag);
    const bpm = (60 * fps) / lag;
    const score = s * Math.exp(-0.5 * (Math.log2(bpm / 120) / 1) ** 2);
    if (score > best.score) best = { score, lag };
  }
  // Between a tempo and its double, the prior alone cannot tell; when beats at
  // half the lag correlate nearly as well, every half-beat is a beat.
  const near = (lag) => Math.max(ac(lag - 1), ac(lag), ac(lag + 1));
  const half = Math.round(best.lag / 2);
  if (half >= minLag && near(half) >= 0.8 * near(best.lag)) best = { score: 0, lag: best.lag / 2 };
  const coarse = (60 * fps) / best.lag;
  // Fine: the period and phase whose comb collects the most onset strength.
  let fine = { score: -Infinity, bpm: coarse, phase: 0 };
  for (let bpm = coarse * 0.98; bpm <= coarse * 1.02; bpm += 0.01) {
    const period = (60 * fps) / bpm;
    for (let phase = 0; phase < period; phase += 0.25) {
      let s = 0;
      let k = 0;
      for (let x = phase; x < frames - 1; x += period, k++) s += at(full, x);
      s /= k || 1;
      if (s > fine.score) fine = { score: s, bpm, phase };
    }
  }
  const beatSec = 60 / fine.bpm;
  // Log flux rises as soon as an onset enters frame f's window; calibrated on
  // click tracks, frame f marks the onset three quarters into its window.
  const offset = (fine.phase * HOP + LAG) / ASR;
  const first = offset - Math.floor(offset / beatSec) * beatSec;
  const beats = [];
  for (let t = first; t < frames / fps; t += beatSec) beats.push(t);
  const strength = [0, 0, 0, 0];
  beats.forEach((t, i) => {
    const x = (t * ASR - LAG) / HOP;
    strength[i % 4] += at(full, x) + 2 * at(low, x);
  });
  const down = strength.indexOf(Math.max(...strength));
  return { bpm: fine.bpm, beatSec, firstBeat: first, firstDownbeat: first + down * beatSec };
}

/**
 * Plan the fitted track: a list of { src, film, len } segments (seconds),
 * every boundary on a downbeat of both source and film.
 */
function plan({ duration, trackDur, bar, d0, land }) {
  const downs = [];
  for (let t = d0; t <= trackDur + 1e-9; t += bar) downs.push(t);
  if (downs.length < 2) throw new FitError("track is too short to hold one whole bar");
  let j = 0;
  if (land) {
    let bestD = Infinity;
    downs.forEach((d, i) => {
      if (i < downs.length - 1 && Math.abs(d - land.track) < bestD)
        [bestD, j] = [Math.abs(d - land.track), i];
    });
  }
  const L = land ? land.film : Math.min(downs[0], duration);
  const remaining = duration - L;
  const M = remaining < MIN_TAIL ? 0 : Math.max(0, Math.floor((remaining - MIN_TAIL) / bar));
  const tail = remaining - M * bar;
  // Ending downbeat e: one the tail can ring from inside the track, a whole number
  // of phrases away from the plain continuation when possible.
  const fits = downs.map((_, i) => i).filter((i) => i > 0 && downs[i] + tail <= trackDur + 1e-9);
  const late = (fits.length ? fits : [downs.length - 1]).slice(-4).reverse();
  const e = M === 0 ? j : (late.find((i) => (((i - j - M) % 4) + 4) % 4 === 0) ?? late[0]);
  /** @type {number[]} source bar index per film bar after the land */
  const after = [];
  let p = j;
  const outro = Math.min(M, 8);
  for (let t = 0; t < M; t++) {
    const r = M - t;
    if (t > 0 && p + r !== e) {
      if (p + r < e && r <= outro)
        p = e - r; // skip ahead into the ending
      else if (p + r > e && p >= e) p = e - r >= 0 ? e - r : p % 4; // loop back
    }
    after.push(p++);
  }
  const segs = [];
  const push = (src, film, len) => {
    const last = segs.at(-1);
    if (
      last &&
      Math.abs(last.src + last.len - src) < 1e-9 &&
      Math.abs(last.film + last.len - film) < 1e-9
    )
      last.len += len;
    else segs.push({ src, film, len });
  };
  // Before the land: play into it, contiguous when the intro is long enough.
  if (L > 0) {
    if (downs[j] - L >= 0) push(downs[j] - L, 0, L);
    else {
      const K = Math.floor(L / bar);
      const x = L - K * bar;
      const pre = [];
      for (let i = 1; i <= K; i++) {
        let q = j - i;
        while (q < 0) q += 4;
        if (q >= downs.length - 1) q = Math.max(0, downs.length - 2);
        pre.unshift(q);
      }
      if (x > 1e-9) {
        let q = pre[0] ?? j;
        while (downs[q] - x < 0 && q + 4 < downs.length - 1) q += 4;
        if (downs[q] - x < 0) q = 1;
        push(Math.max(0, downs[q] - x), 0, x);
      }
      pre.forEach((q, i) => push(downs[q], x + i * bar, bar));
    }
  }
  after.forEach((q, i) => push(downs[q], L + i * bar, bar));
  push(downs[e], L + M * bar, tail);
  const filmDowns = [];
  for (let k = -Math.floor(L / bar); L + k * bar <= duration - MIN_TAIL + 1e-9; k++)
    filmDowns.push(L + k * bar);
  return { segs, landIndex: j, filmDowns, landDown: downs[j] };
}

/** Render the segments with equal-power crossfades at each cut and a fade at the end. */
function renderFit(audio, segs, duration) {
  const n = Math.round(duration * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const h = XFADE / 2;
  segs.forEach((s, idx) => {
    const first = idx === 0;
    const last = idx === segs.length - 1;
    const from = first ? s.film : s.film - h;
    const to = last ? s.film + s.len : s.film + s.len + h;
    const i0 = Math.max(0, Math.ceil(from * SR - 1e-6));
    const i1 = Math.min(n, Math.ceil(to * SR - 1e-6));
    for (let i = i0; i < i1; i++) {
      const tf = i / SR;
      let g = 1;
      if (!first && tf < s.film + h) g *= Math.sin(((tf - (s.film - h)) / XFADE) * (Math.PI / 2));
      if (!last && tf > s.film + s.len - h)
        g *= Math.cos(((tf - (s.film + s.len - h)) / XFADE) * (Math.PI / 2));
      if (last) {
        const fade = Math.min(END_FADE, s.len);
        const left = duration - tf;
        if (left < fade) g *= Math.sin((Math.max(0, left) / fade) * (Math.PI / 2));
      }
      const x = (s.src + (tf - s.film)) * SR;
      const k = Math.floor(x);
      if (k < 0 || k + 1 >= audio.n) continue;
      const fr = x - k;
      l[i] += (audio.l[k] + (audio.l[k + 1] - audio.l[k]) * fr) * g;
      r[i] += (audio.r[k] + (audio.r[k + 1] - audio.r[k]) * fr) * g;
    }
  });
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
  const q = (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(q(l[i]), 44 + i * 4);
    out.writeInt16LE(q(r[i]), 46 + i * 4);
  }
  return out;
}

const r4 = (v) => Math.round(v * 10000) / 10000;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const audio = await decode(resolve(opts.track));
  const trackDur = audio.n / SR;
  const grid = beatGrid(onsetEnvelopes(audio));
  const bar = grid.beatSec * 4;
  const d0 = grid.firstDownbeat - Math.floor(grid.firstDownbeat / bar) * bar;
  if (opts.land && !(opts.land.track >= 0 && opts.land.track < trackDur))
    throw new FitError(`--land track time must be inside the track (0-${trackDur.toFixed(2)} s)`);
  const fit = plan({ duration: opts.duration, trackDur, bar, d0, land: opts.land });
  const outDir = resolve(opts.out);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "music.wav"), renderFit(audio, fit.segs, opts.duration));
  const report = {
    source: resolve(opts.track),
    duration: opts.duration,
    sourceDuration: r4(trackDur),
    bpm: Math.round(grid.bpm * 100) / 100,
    beatSec: r4(grid.beatSec),
    barSec: r4(bar),
    sourceFirstBeat: r4(grid.firstBeat),
    sourceFirstDownbeat: r4(d0),
    ...(opts.land
      ? {
          land: {
            requested: opts.land.track,
            sourceDownbeat: r4(fit.landDown),
            film: opts.land.film,
          },
        }
      : {}),
    downbeats: fit.filmDowns.map(r4),
    edits: fit.segs.map((s) => ({
      source: [r4(s.src), r4(s.src + s.len)],
      film: [r4(s.film), r4(s.film + s.len)],
    })),
    crossfade: XFADE,
  };
  await writeFile(join(outDir, "music-fit.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ ok: true, outDir, files: ["music.wav", "music-fit.json"], bpm: report.bpm, duration: opts.duration, edits: report.edits.length, cuts: report.edits.length - 1 })}\n`,
  );
}

main().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exit(1);
});
