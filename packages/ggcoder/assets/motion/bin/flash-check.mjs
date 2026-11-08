#!/usr/bin/env node
// Photosensitivity screen on decoded pixels against the WCAG 2.3.1 general and red flash
// thresholds. As in EA's open-source IRIS tool, an area's mean change only counts on frames
// where at least a quarter of the area changes, so moving content mostly cancels out rather
// than reading as flashing. IRIS applies this to the whole screen; here it applies to every
// WCAG 10° field (a third of the frame each way), so a flash filling part of the frame is
// caught too. A transition is a move of 0.1 relative luminance (or 20 red units) away from the
// last peak or valley, as WCAG defines it; more than six in any second fails. Renders above
// 60 fps are sampled at 60. A screen, not a certification.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ffmpegBinary } from "./media-binaries.mjs";

/** Cells per side of the analysis grid; every aspect ratio maps onto it. */
export const GRID = 48;
/** Frames per analysed second; slower renders are repeated, so one second is always 60 frames. */
export const ANALYSIS_FPS = 60;
/** WCAG approximates the 10° field as 341×256 px of a 1024×768 screen: a third each way. */
const FIELD = GRID / 3;
const FIELD_CELLS = FIELD * FIELD;
/** A field's change counts once a quarter of it changes. */
const AREA = 0.25 * FIELD_CELLS;
const WINDOWS_PER_SIDE = GRID - FIELD + 1;
const WINDOWS = WINDOWS_PER_SIDE * WINDOWS_PER_SIDE;
/** More than three flashes (six opposing transitions) within any one second fails. */
const MAX_TRANSITIONS = 6;
/** Transitions per field within the trailing second never exceed one per analysed frame. */
const RING = 64;
const CELLS = GRID * GRID;
const FRAME_BYTES = CELLS * 3;
const CHANNELS = {
  // Relative luminance 0–1: a 0.1 swing, unless even the darker state is 0.8 or brighter.
  // A cell has changed once it moves by more than encoding noise (about 1/255 linear).
  general: { threshold: 0.1, darkLimit: 0.8, noise: 0.004 },
  // WCAG's red measure: (R − G − B) × 320 where R / (R + G + B) ≥ 0.8, else 0.
  red: { threshold: 20, darkLimit: Infinity, noise: 1 },
};
/** sRGB to linear light, applied before averaging so mixed cells keep their real brightness. */
const LINEAR = "if(lte(val,10.31475),val/12.92,255*pow((val/255+0.055)/1.055,2.4))";

function createChannel({ threshold, darkLimit, noise }) {
  const side = GRID + 1;
  const changed = new Float64Array(side * side);
  const change = new Float64Array(side * side);
  const level = new Float64Array(side * side);
  // Per field: the accumulated counted change, its last peak and valley, and the field's
  // mean at each, for WCAG's "darker image" rule.
  const signal = new Float64Array(WINDOWS);
  const peakValue = new Float64Array(WINDOWS);
  const peakLevel = new Float64Array(WINDOWS);
  const valleyValue = new Float64Array(WINDOWS);
  const valleyLevel = new Float64Array(WINDOWS);
  /** 1 after a rise, -1 after a fall, 0 before the first transition. */
  const direction = new Int8Array(WINDOWS);
  const ring = new Int32Array(WINDOWS * RING);
  const head = new Int32Array(WINDOWS);
  const tail = new Int32Array(WINDOWS);
  const failures = [];
  let peak = 0;

  return {
    update(frame, previous, current) {
      // Summed-area tables, so each field's totals cost four lookups.
      for (let y = 0; y < GRID; y++) {
        let rowChanged = 0;
        let rowChange = 0;
        let rowLevel = 0;
        for (let x = 0; x < GRID; x++) {
          const cell = y * GRID + x;
          const delta = current[cell] - previous[cell];
          if (Math.abs(delta) > noise) rowChanged++;
          rowChange += delta;
          rowLevel += current[cell];
          const at = (y + 1) * side + x + 1;
          changed[at] = changed[at - side] + rowChanged;
          change[at] = change[at - side] + rowChange;
          level[at] = level[at - side] + rowLevel;
        }
      }
      let most = 0;
      for (let wy = 0; wy < WINDOWS_PER_SIDE; wy++) {
        for (let wx = 0; wx < WINDOWS_PER_SIDE; wx++) {
          const window = wy * WINDOWS_PER_SIDE + wx;
          const a = wy * side + wx;
          const b = a + FIELD;
          const c = a + FIELD * side;
          const d = c + FIELD;
          const area = changed[d] - changed[b] - changed[c] + changed[a];
          const step = (change[d] - change[b] - change[c] + change[a]) / FIELD_CELLS;
          const mean = (level[d] - level[b] - level[c] + level[a]) / FIELD_CELLS;
          if (frame === 1) {
            peakLevel[window] = mean - step;
            valleyLevel[window] = mean - step;
          }
          const value = signal[window] + (area >= AREA ? step : 0);
          signal[window] = value;
          let transition = false;
          if (direction[window] >= 0) {
            if (value > peakValue[window]) {
              peakValue[window] = value;
              peakLevel[window] = mean;
            } else if (peakValue[window] - value >= threshold) {
              transition = Math.min(mean, peakLevel[window]) < darkLimit;
              direction[window] = -1;
              valleyValue[window] = value;
              valleyLevel[window] = mean;
            }
          }
          if (direction[window] <= 0) {
            if (value < valleyValue[window]) {
              valleyValue[window] = value;
              valleyLevel[window] = mean;
            } else if (value - valleyValue[window] >= threshold) {
              transition = Math.min(mean, valleyLevel[window]) < darkLimit;
              direction[window] = 1;
              peakValue[window] = value;
              peakLevel[window] = mean;
            }
          }
          const base = window * RING;
          while (
            tail[window] < head[window] &&
            frame - ring[base + (tail[window] % RING)] >= ANALYSIS_FPS
          )
            tail[window]++;
          if (transition) {
            ring[base + (head[window] % RING)] = frame;
            head[window]++;
          }
          const count = head[window] - tail[window];
          if (count > most) most = count;
        }
      }
      peak = Math.max(peak, most);
      if (most > MAX_TRANSITIONS) {
        const start = Math.max(0, frame + 1 - ANALYSIS_FPS) / ANALYSIS_FPS;
        const end = (frame + 1) / ANALYSIS_FPS;
        const last = failures.at(-1);
        if (last && start <= last.end) last.end = end;
        else failures.push({ start, end });
      }
    },
    summary() {
      return {
        maxFlashesPerSecond: peak / 2,
        failures: failures.slice(0, 20).map(({ start, end }) => ({
          start: Math.round(start * 100) / 100,
          end: Math.round(end * 100) / 100,
        })),
      };
    },
  };
}

/** Pure analysis over linear-light RGB frames of GRID × GRID cells (3 bytes per cell). */
export function createFlashAnalyzer() {
  const general = createChannel(CHANNELS.general);
  const red = createChannel(CHANNELS.red);
  let luminance = new Float64Array(CELLS);
  let redness = new Float64Array(CELLS);
  let previousLuminance = new Float64Array(CELLS);
  let previousRedness = new Float64Array(CELLS);
  let frames = 0;
  return {
    push(frame) {
      if (!(frame instanceof Uint8Array) || frame.length !== FRAME_BYTES)
        throw new Error(`Expected ${FRAME_BYTES}-byte analysis frames`);
      for (let cell = 0; cell < CELLS; cell++) {
        const r = frame[cell * 3] / 255;
        const g = frame[cell * 3 + 1] / 255;
        const b = frame[cell * 3 + 2] / 255;
        luminance[cell] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const total = r + g + b;
        redness[cell] = total > 0 && r / total >= 0.8 ? Math.max(0, (r - g - b) * 320) : 0;
      }
      if (frames > 0) {
        general.update(frames, previousLuminance, luminance);
        red.update(frames, previousRedness, redness);
      }
      [previousLuminance, luminance] = [luminance, previousLuminance];
      [previousRedness, redness] = [redness, previousRedness];
      frames++;
    },
    result() {
      const generalSummary = general.summary();
      const redSummary = red.summary();
      return {
        ok: frames >= 2 && !generalSummary.failures.length && !redSummary.failures.length,
        method: "rendered-pixels",
        standard: "WCAG 2.3.1 general and red flash thresholds",
        analysisFps: ANALYSIS_FPS,
        frames,
        duration: frames / ANALYSIS_FPS,
        general: generalSummary,
        red: redSummary,
      };
    },
  };
}

/** Decode a video into linear-light analysis frames and return the flash report. */
export async function analyzeFlashes(file, signal) {
  const binary = await ffmpegBinary();
  const child = spawn(
    binary,
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-xerror",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-an",
      "-vf",
      [
        // Linearise before any averaging: shrinking sRGB values first darkens fine detail
        // by up to half the flash threshold.
        "format=gbrp",
        `lutrgb=r='${LINEAR}':g='${LINEAR}':b='${LINEAR}'`,
        `scale=${GRID}:${GRID}:flags=area`,
        `fps=${ANALYSIS_FPS}`,
        "format=rgb24",
      ].join(","),
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => {
    if (stderr.length < 16_000) stderr += text;
  });
  const closed = once(child, "close");
  closed.catch(() => {});
  const analyzer = createFlashAnalyzer();
  const frame = new Uint8Array(FRAME_BYTES);
  let filled = 0;
  for await (const chunk of child.stdout) {
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(FRAME_BYTES - filled, chunk.length - offset);
      frame.set(chunk.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === FRAME_BYTES) {
        analyzer.push(frame);
        filled = 0;
      }
    }
  }
  const [code] = await closed;
  if (code !== 0)
    throw new Error(`FFmpeg could not decode the video: ${stderr.trim().slice(-2000)}`);
  if (filled !== 0) throw new Error("Decoded video ended mid-frame; flashing is unverified");
  const result = analyzer.result();
  if (result.frames < 2) throw new Error("Too few decoded frames; flashing is unverified");
  return result;
}

async function videoHash(file, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const [video, ...extra] = process.argv.slice(2);
  if (!video || extra.length) throw new Error("usage: flash-check.mjs <rendered-video>");
  const file = resolve(video);
  if (!(await stat(file)).isFile()) throw new Error("Expected a local rendered video file");
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const started = performance.now();
  try {
    const videoSha256 = await videoHash(file, controller.signal);
    const result = await analyzeFlashes(file, controller.signal);
    if ((await videoHash(file, controller.signal)) !== videoSha256)
      throw new Error("Video changed during analysis; flashing is unverified");
    process.stdout.write(
      `${JSON.stringify({ ...result, file, videoSha256, elapsedMs: Math.round(performance.now() - started) })}\n`,
    );
    if (!result.ok) process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `Flash verification failed: ${error instanceof Error ? error.message : "invalid input"}\n`,
    );
    process.exitCode = 1;
  }
}
