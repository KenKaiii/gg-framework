#!/usr/bin/env node
// Check decoded video pixels, not DOM geometry: works for HTML, canvas and WebGL.
// A freeze detector is not a creative-quality score. Review choreography too.
import { execFile, spawn } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ffmpegBinary, mediaBinaries } from "./media-binaries.mjs";

const run = promisify(execFile);

/** Parse only completed FFmpeg progress + freezedetect metadata; never infer a pass from silence. */
export function parseMotionOutput(text, slideshowRequested = false, holds = []) {
  const invalid = () => ({
    ok: false,
    error: "Incomplete or malformed pixel analysis; motion is unverified",
  });
  if (typeof text !== "string" || typeof slideshowRequested !== "boolean") return invalid();
  let samples = 0;
  let duration = 0;
  let complete = false;
  let start = null;
  const freezes = [];
  for (const line of text.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (key === "progress") {
      complete = value === "end";
      continue;
    }
    if (
      ![
        "frame",
        "out_time_us",
        "lavfi.freezedetect.freeze_start",
        "lavfi.freezedetect.freeze_end",
        "lavfi.freezedetect.freeze_duration",
      ].includes(key)
    )
      continue;
    const number = Number(value);
    if (!value || !Number.isFinite(number) || number < 0) return invalid();
    if (key === "frame") {
      if (!Number.isInteger(number) || number < samples) return invalid();
      samples = number;
    } else if (key === "out_time_us") {
      if (number / 1e6 < duration) return invalid();
      duration = number / 1e6;
    } else if (key === "lavfi.freezedetect.freeze_start") {
      if (start !== null) return invalid();
      start = number;
    } else if (key === "lavfi.freezedetect.freeze_duration") {
      if (start === null || number < 1) return invalid();
    } else if (key === "lavfi.freezedetect.freeze_end") {
      if (start === null || number < start) return invalid();
      freezes.push({ start, end: number, duration: number - start });
      start = null;
    }
  }
  if (!complete || samples < 2 || duration <= 0 || Math.abs(samples / 8 - duration) > 0.25)
    return invalid();
  if (start !== null) freezes.push({ start, end: duration, duration: duration - start });
  if (freezes.some((freeze) => freeze.duration < 1 || freeze.end > duration + 0.125))
    return invalid();
  // Hold declarations are narrow exceptions, never a substitute for decoding.
  // One sample of tolerance accounts for the fixed 8fps analysis grid.
  const tolerance = 1 / 8;
  let previousEnd = 0;
  let heldDuration = 0;
  if (!Array.isArray(holds) || holds.length > 128 || (slideshowRequested && holds.length))
    return { ok: false, error: "Invalid hold declarations" };
  for (const hold of holds) {
    if (
      !hold ||
      typeof hold !== "object" ||
      Array.isArray(hold) ||
      Object.keys(hold).some((key) => !["start", "end", "reason"].includes(key)) ||
      !Number.isFinite(hold.start) ||
      !Number.isFinite(hold.end) ||
      hold.start < previousEnd ||
      hold.end <= hold.start ||
      hold.end > duration ||
      typeof hold.reason !== "string" ||
      !hold.reason.trim() ||
      hold.reason.length > 500
    )
      return {
        ok: false,
        error: "Holds need ordered, non-overlapping in-range times and a reason",
      };
    previousEnd = hold.end;
    heldDuration += hold.end - hold.start;
  }
  if (heldDuration >= duration - tolerance)
    return {
      ok: false,
      error:
        "Holds cannot exempt the entire video; explicitly requested slideshows use their own mode",
    };
  const staleHolds = holds.filter(
    (hold) => !freezes.some((freeze) => freeze.end > hold.start && freeze.start < hold.end),
  );
  // Name the stale holds and where pixels actually freeze, so the plan is fixed in one
  // step instead of guessed again against another full check.
  if (staleHolds.length)
    return {
      ok: false,
      error: "Stale hold declaration: no detected freeze overlaps its window",
      staleHolds,
      freezes,
    };
  const unexpectedFreezes = freezes.filter(
    (freeze) =>
      !holds.some(
        (hold) => freeze.start >= hold.start - tolerance && freeze.end <= hold.end + tolerance,
      ),
  );
  return {
    ok: slideshowRequested || unexpectedFreezes.length === 0,
    method: "rendered-pixels",
    samples,
    duration,
    freezes,
    holds,
    unexpectedFreezes,
    slideshowRequested,
    visualReviewRequired: true,
  };
}

// Flow measurement: hard cuts and fast motion, read from every rendered frame on a small
// grey grid. Used by reference-study and the blur step's draft measure, never part of the
// pixel pass/fail.
/** Long side of the analysis grid: one cell is 12 px of a 1920-wide frame. */
export const FLOW_SIDE = 160;
const TILE = 10;
const SEARCH = 8;
/** Grey levels per sampled pixel charged for each cell of shift when matching a tile. */
const SHIFT_COST = 0.5;
/** A pixel "changed" when its grey level moves by more than this between frames. */
const CHANGED_LEVEL = 24;
/** A cut changes at least this share of the frame in one step... */
const CUT_CHANGE = 0.12;
/** ...by several times the mean difference of the frame steps either side of it... */
const CUT_SPIKE = 2;
/** ...and the change lasts: the picture this long after still differs this much (as a share
 * of the step) from the one before. Glitches and flashes return to the old picture. */
const CUT_PERSISTS = 0.5;
const CUT_LASTS_SECONDS = 0.15;
/** Tiles moving at least this share of the long side per frame count as fast. */
export const FAST_PER_FRAME = 0.02;
/** Fast motion needs this many tiles agreeing and this many frames in a row. */
const FAST_TILES = 2;
const FAST_FRAMES = 3;
/** Stillness: a grid pixel moved visibly when its grey level changes by more than this
 * (encoder noise on a held frame stays within a few levels)... */
export const STILL_LEVEL = 8;
/** ...and a frame step is dead still when at most this share of the grid moved visibly.
 * Counting pixels, not averaging them, keeps a slow push or a small moving thing from
 * reading as still. The same figures as reference-study.mjs, so the two agree. */
export const STILL_STEP_SHARE = 0.0002;

function tileSad(a, b, width, x, y, dx, dy, step, limit) {
  let sum = 0;
  for (let row = 0; row < TILE; row += step) {
    const from = (y + row) * width + x;
    const to = (y + row + dy) * width + x + dx;
    for (let col = 0; col < TILE; col += step) {
      sum += Math.abs(a[from + col] - b[to + col]);
      if (sum > limit) return sum;
    }
  }
  return sum;
}

/** Displacement of one tile from frame `a` to frame `b` in grid cells, or null when unmatched. */
function tileMotion(a, b, width, height, x, y) {
  let mean = 0;
  for (let row = 0; row < TILE; row++)
    for (let col = 0; col < TILE; col++) mean += a[(y + row) * width + x + col];
  mean /= TILE * TILE;
  let variance = 0;
  for (let row = 0; row < TILE; row++)
    for (let col = 0; col < TILE; col++) variance += (a[(y + row) * width + x + col] - mean) ** 2;
  // Flat tiles carry no position, and unchanged tiles did not move.
  if (variance / (TILE * TILE) < 36) return null;
  const still = tileSad(a, b, width, x, y, 0, 0, 1, Infinity) / (TILE * TILE);
  if (still < 3) return null;
  const inside = (dx, dy) =>
    x + dx >= 0 && y + dy >= 0 && x + dx + TILE <= width && y + dy + TILE <= height;
  // Stripes, rules and text lines match equally well at many shifts along their length.
  // A small cost per cell of shift makes ties resolve to the shortest move, never the
  // first one searched.
  const search = (candidates, step) => {
    const samples = (TILE / step) ** 2;
    let best = { dx: 0, dy: 0, sad: Infinity, cost: Infinity };
    for (const [dx, dy] of candidates) {
      if (!inside(dx, dy)) continue;
      const penalty = SHIFT_COST * samples * (Math.abs(dx) + Math.abs(dy));
      const sad = tileSad(a, b, width, x, y, dx, dy, step, best.cost - penalty);
      if (sad + penalty < best.cost) best = { dx, dy, sad, cost: sad + penalty };
    }
    return best;
  };
  const around = (cx, cy, reach, stride) => {
    const list = [];
    for (let dy = cy - reach; dy <= cy + reach; dy += stride)
      for (let dx = cx - reach; dx <= cx + reach; dx += stride) list.push([dx, dy]);
    return list;
  };
  // Coarse search on every other cell and pixel, then refine around the best.
  const centre = search(around(0, 0, SEARCH, 2), 2);
  const best = search(around(centre.dx, centre.dy, 1, 1), 1);
  const matched = best.sad / (TILE * TILE);
  // Fades, reveals and new content change pixels without moving them: no match.
  if (matched > 12 || matched > 0.4 * still) return null;
  return best;
}

/** Streams grey frames (width × height bytes each) and reports hard cuts and fast motion. */
export function createFlowMeter(width, height, fps) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < TILE || height < TILE)
    throw new Error("Flow grid must be at least one tile");
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("Flow meter needs a frame rate");
  const side = Math.max(width, height);
  // Per step i (frame i-1 → i): changed share and mean difference; `lasting[i]` compares
  // frame i-1 with the frame `ahead` steps later, to tell a cut from a transient glitch.
  const ahead = Math.max(2, Math.round(CUT_LASTS_SECONDS * fps));
  const change = [0];
  const mean = [0];
  const lasting = [];
  const fastTiles = [0];
  const fastest = [0];
  const recent = [];
  let stillSteps = 0;
  let stillRun = 0;
  let longestRun = 0;
  let previous = null;
  const changedShare = (a, b) => {
    let changed = 0;
    for (let index = 0; index < a.length; index++)
      if (Math.abs(a[index] - b[index]) > CHANGED_LEVEL) changed++;
    return changed / a.length;
  };
  return {
    push(frame) {
      if (frame.length !== width * height) throw new Error("Flow frame has the wrong size");
      if (previous) {
        let total = 0;
        for (let index = 0; index < frame.length; index++)
          total += Math.abs(frame[index] - previous[index]);
        mean.push(total / frame.length / 255);
        let visible = 0;
        for (let index = 0; index < frame.length; index++)
          if (Math.abs(frame[index] - previous[index]) > STILL_LEVEL) visible++;
        if (visible / frame.length <= STILL_STEP_SHARE) {
          stillSteps++;
          stillRun++;
          longestRun = Math.max(longestRun, stillRun);
        } else stillRun = 0;
        change.push(changedShare(previous, frame));
        const columns = Math.floor(width / TILE);
        const rows = Math.floor(height / TILE);
        const vectors = [];
        for (let row = 0; row < rows; row++)
          for (let column = 0; column < columns; column++)
            vectors.push(tileMotion(previous, frame, width, height, column * TILE, row * TILE));
        // Something moving spans neighbouring tiles that move together; a fade or flicker
        // gives isolated, disagreeing matches. Only fast tiles a neighbour agrees with count.
        const agrees = (a, b) => b !== null && Math.hypot(a.dx - b.dx, a.dy - b.dy) <= 1.5;
        let count = 0;
        let peak = 0;
        for (let row = 0; row < rows; row++)
          for (let column = 0; column < columns; column++) {
            const moved = vectors[row * columns + column];
            if (!moved) continue;
            const speed = Math.hypot(moved.dx, moved.dy) / side;
            if (speed < FAST_PER_FRAME) continue;
            const near = [
              column > 0 ? vectors[row * columns + column - 1] : null,
              column + 1 < columns ? vectors[row * columns + column + 1] : null,
              row > 0 ? vectors[(row - 1) * columns + column] : null,
              row + 1 < rows ? vectors[(row + 1) * columns + column] : null,
            ];
            if (!near.some((other) => agrees(moved, other))) continue;
            count++;
            peak = Math.max(peak, speed);
          }
        fastTiles.push(count);
        fastest.push(peak);
      }
      previous = Uint8Array.from(frame);
      // recent[0] is frame (count - ahead - 1): the frame before step (count - ahead).
      recent.push(previous);
      if (recent.length > ahead + 1) recent.shift();
      const step = change.length - ahead;
      if (recent.length === ahead + 1 && step >= 1)
        lasting[step] = changedShare(recent[0], previous);
    },
    finish() {
      const frames = change.length;
      const round = (value) => Math.round(value * 1000) / 1000;
      const cutFrames = new Set();
      for (let index = 1; index < frames; index++) {
        const around = Math.max(mean[index - 1] ?? 0, mean[index + 1] ?? 0, 0.004);
        // Steps too close to the end to look ahead keep the change as lasting.
        const lasts = (lasting[index] ?? Infinity) >= CUT_PERSISTS * change[index];
        if (change[index] >= CUT_CHANGE && mean[index] >= CUT_SPIKE * around && lasts)
          cutFrames.add(index);
      }
      const fast = [];
      let run = null;
      const close = () => {
        if (run && run.end - run.start + 1 >= FAST_FRAMES)
          fast.push({
            start: round(run.start / fps),
            end: round((run.end + 1) / fps),
            peak: round(run.peak),
          });
        run = null;
      };
      for (let index = 1; index < frames; index++) {
        const isFast = !cutFrames.has(index) && fastTiles[index] >= FAST_TILES;
        if (isFast) {
          // A single quiet frame inside a move does not split it.
          if (run && index - run.end <= 2) {
            run.end = index;
            run.peak = Math.max(run.peak, fastest[index]);
          } else {
            close();
            run = { start: index, end: index, peak: fastest[index] };
          }
        }
      }
      close();
      return {
        frames,
        fps,
        cuts: [...cutFrames].map((index) => round(index / fps)),
        fast,
        // Share of frame steps with no visible change, and the longest run of them.
        stillShare: frames > 1 ? round(stillSteps / (frames - 1)) : 0,
        longestStill: round(longestRun / fps),
      };
    },
  };
}

async function videoHash(file, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

async function readHoldPlan(file, signal) {
  // Bound reads even if a local file grows between stat and read.
  const handle = await open(file, "r");
  try {
    signal.throwIfAborted();
    if (!(await handle.stat()).isFile()) throw new Error("Expected a local hold-plan file");
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let size = 0;
    while (size < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size === bytes.length) throw new Error("Hold plan exceeds 64 KiB");
    const plan = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    if (
      !plan ||
      typeof plan !== "object" ||
      Array.isArray(plan) ||
      plan.version !== 1 ||
      Object.keys(plan).some((key) => !["version", "videoSha256", "holds"].includes(key)) ||
      typeof plan.videoSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(plan.videoSha256) ||
      !Array.isArray(plan.holds) ||
      !plan.holds.length
    )
      throw new Error("Expected hold plan version 1 with videoSha256 and nonempty holds");
    return plan;
  } finally {
    await handle.close();
  }
}

/** The motion-blur render step stamps its output's comment tag with this marker. */
export const BLUR_STAMP = /^gg-motion-blur samples=(\d+)$/;

/** Grid of at most FLOW_SIDE on the long side that keeps the export's aspect ratio. */
export function flowGrid(width, height) {
  const scale = FLOW_SIDE / Math.max(width, height);
  return {
    width: Math.max(TILE, Math.round(width * scale)),
    height: Math.max(TILE, Math.round(height * scale)),
  };
}

/**
 * Hard cuts and fast motion of a video, from every frame. `onFrame(frame, grid)`, when given,
 * also sees each grey frame (grid.width × grid.height bytes) so a caller can measure more in
 * the same decode; the frame buffer is reused, so copy what you keep.
 */
export async function measureFlow(file, signal, onFrame) {
  const { ffmpeg, ffprobe } = await mediaBinaries();
  const { stdout } = await run(
    ffprobe,
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate:format=duration:format_tags=comment",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true, signal },
  );
  const probe = JSON.parse(stdout);
  const stream = probe?.streams?.[0];
  const [num, den] = String(stream?.avg_frame_rate ?? "")
    .split("/")
    .map(Number);
  const fps = num / den;
  const duration = Number(probe?.format?.duration);
  if (
    !Number.isInteger(stream?.width) ||
    !Number.isInteger(stream?.height) ||
    !(fps >= 1 && fps <= 120) ||
    !(duration > 0 && duration <= 3600)
  )
    throw new Error("Unsupported video metadata for flow analysis");
  const stamp = BLUR_STAMP.exec(String(probe?.format?.tags?.comment ?? ""));
  const grid = flowGrid(stream.width, stream.height);
  const meter = createFlowMeter(grid.width, grid.height, fps);
  const size = grid.width * grid.height;
  const child = spawn(
    ffmpeg,
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
      `scale=${grid.width}:${grid.height}:flags=area,format=gray`,
      "-f",
      "rawvideo",
      "-",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => {
    if (errors.length < 4000) errors += chunk;
  });
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code));
  });
  let pending = Buffer.alloc(0);
  for await (const chunk of child.stdout) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let offset = 0;
    while (pending.length - offset >= size) {
      const frame = pending.subarray(offset, offset + size);
      meter.push(frame);
      onFrame?.(frame, grid);
      offset += size;
    }
    pending = pending.subarray(offset);
  }
  const code = await exited;
  if (code !== 0 || pending.length) throw new Error(`Flow decode failed: ${errors.trim()}`);
  const measured = meter.finish();
  if (measured.frames < 2) throw new Error("Flow analysis decoded too few frames");
  return {
    ...measured,
    duration: Math.round(duration * 1000) / 1000,
    blur: stamp ? { samples: Number(stamp[1]) } : null,
  };
}

async function flowMain(video, extra) {
  if (!video || extra.length) throw new Error("usage: motion-check.mjs --flow <rendered-video>");
  const file = resolve(video);
  if (!(await stat(file)).isFile()) throw new Error("Expected a local rendered video file");
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const started = performance.now();
  try {
    const videoSha256 = await videoHash(file, controller.signal);
    const flow = await measureFlow(file, controller.signal);
    if ((await videoHash(file, controller.signal)) !== videoSha256)
      throw new Error("Video changed during analysis; flow is unmeasured");
    process.stdout.write(
      `${JSON.stringify({ ok: true, ...flow, file, videoSha256, elapsedMs: Math.round(performance.now() - started) })}\n`,
    );
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

async function main() {
  if (process.argv[2] === "--flow") return flowMain(process.argv[3], process.argv.slice(4));
  const [video, option, holdFile, ...extra] = process.argv.slice(2);
  if (
    !video ||
    extra.length ||
    (option === "--holds" ? !holdFile : holdFile || (option && option !== "--slideshow-requested"))
  ) {
    throw new Error(
      "usage: motion-check.mjs <rendered-video> [--holds <holds.json> | --slideshow-requested]\n" +
        "       motion-check.mjs --flow <rendered-video>",
    );
  }
  const file = resolve(video);
  if (!(await stat(file)).isFile()) throw new Error("Expected a local rendered video file");
  const binary = await ffmpegBinary();
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const started = performance.now();
  try {
    const plan = holdFile ? await readHoldPlan(resolve(holdFile), controller.signal) : null;
    const videoSha256 = await videoHash(file, controller.signal);
    if (plan && plan.videoSha256 !== videoSha256)
      throw new Error(
        "Hold plan belongs to a different render; review this file before updating it",
      );
    const { stdout } = await run(
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
        "fps=8,scale=320:180,freezedetect=n=0.001:d=1,metadata=mode=print:file=-",
        "-progress",
        "pipe:1",
        "-nostats",
        "-f",
        "null",
        "-",
      ],
      {
        encoding: "utf8",
        timeout: 180_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        signal: controller.signal,
      },
    );
    if ((await videoHash(file, controller.signal)) !== videoSha256)
      throw new Error("Video changed during analysis; motion is unverified");
    const result = parseMotionOutput(stdout, option === "--slideshow-requested", plan?.holds ?? []);
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
      `Motion verification failed: ${error instanceof Error ? error.message : "invalid input"}\n`,
    );
    process.exitCode = 1;
  }
}
