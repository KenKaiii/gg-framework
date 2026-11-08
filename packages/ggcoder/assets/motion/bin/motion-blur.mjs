#!/usr/bin/env node
// GG Motion's motion-blur render step. Renders the composition several times per output
// frame with the bundled HyperFrames CLI, then averages each frame's sub-frame samples in
// linear light (never across a hard cut) and encodes with the bundled FFmpeg. A still frame
// averages to itself, so only moving frames blur. `--draft` measures a plain render's
// fastest move and renders more sub-frames when it is too fast for the default count, and
// finds its still spans: those render once at the output rate (`--frames` range renders)
// instead of at the sub-frame rate, and their frames are copied, not blended; the audio then
// comes from the draft, a render of the same composition. `--no-skip-still` renders
// everything at the sub-frame rate as without a draft; a composition HyperFrames cannot
// range-render (HDR, shader transitions) falls back to that automatically.
//
// Usage: node motion-blur.mjs <project-dir> <output.mp4> [--fps <n>] [--shutter <degrees>]
//          [--quality draft|looks|standard|delivery|high] [--composition <file>]
//          [--resolution <preset>] [--workers <n|auto>] [--samples <n> | --draft <video>]
//          [--no-skip-still]
// Prints one JSON line: { ok, output, fps, samples, renderFps, shutter, elapsedMs, ... },
// with `spans`, `renders` and `audio` when still spans were skipped and `note` when not.
//
// The output is stamped (comment tag "gg-motion-blur samples=<n>") so the flow measure
// knows it was made with this step. It never overwrites an existing file.
//
// The finished file is then screened for harmful flashing (flash-check.mjs, under a second):
// the line carries `flashing`, and when it fails, `ok` is false, the exit code is 1 and the
// file is kept so the next version can be compared.
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { analyzeFlashes } from "./flash-check.mjs";
import { mediaBinaries } from "./media-binaries.mjs";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

/** HyperFrames renders at most this many frames per second; it bounds the sub-frame samples. */
export const MAX_RENDER_FPS = 240;
/**
 * Sub-frames rendered per output frame when nothing calls for more. 4 at 30 fps renders
 * 120 fps, about 1.5× a plain render, and is smooth for GG's usual moves.
 */
export const DEFAULT_SAMPLES = 4;
/**
 * Largest gap, in pixels, between neighbouring copies of the fastest move inside one blurred
 * frame. Rendered edges are anti-aliased over 1-2 px and the H.264 encode softens another
 * couple, so copies up to about 8 px apart still read as one continuous streak; wider
 * spacing shows as separate stepped ghosts. 8 px keeps the default 4 samples for moves up
 * to 32 px per frame (a 1080p screen width in two seconds) and only renders more, slower,
 * when a move is faster than that.
 */
export const MAX_COPY_GAP_PX = 8;
/** 270° averages 3 of the 4 sub-frames: a smooth streak, a little shorter than a full frame. */
export const DEFAULT_SHUTTER = 270;
/** Render workers when the caller names none: HyperFrames' own default leaves most cores idle. */
export function defaultWorkers(cores = availableParallelism()) {
  return Math.max(2, Math.min(12, cores - 4));
}
/** Encoder settings per HyperFrames quality name; the blend is the final encode. */
const QUALITY = {
  draft: { crf: "23", preset: "veryfast" },
  looks: { crf: "16", preset: "medium" },
  standard: { crf: "16", preset: "medium" },
  delivery: { crf: "12", preset: "slow" },
  high: { crf: "12", preset: "slow" },
};
const PASSTHROUGH = ["--composition", "--resolution", "--workers"];

/**
 * How many sub-frames to render per output frame and how many of them to average. The
 * shutter is the share of each frame interval the averaged samples span: 180° (the film
 * default) averages the first half, 270° three quarters, 360° all of it.
 *
 * `options.samples` names the sub-frame count outright. Otherwise `options.peak` (the
 * fastest move in pixels per output frame, e.g. from a draft) raises the count from
 * DEFAULT_SAMPLES until neighbouring copies sit at most MAX_COPY_GAP_PX apart, capped by
 * the render rate (MAX_RENDER_FPS / fps).
 *
 * @param {number} fps
 * @param {number} [shutter]
 * @param {{ samples?: number, peak?: number }} [options]
 */
export function blurPlan(fps, shutter = DEFAULT_SHUTTER, options = {}) {
  if (!Number.isInteger(fps) || fps < 1 || fps > MAX_RENDER_FPS)
    throw new Error("--fps must be a whole number of frames per second");
  if (!Number.isFinite(shutter) || shutter <= 0 || shutter > 360)
    throw new Error("--shutter must be more than 0 and at most 360 degrees");
  const cap = Math.floor(MAX_RENDER_FPS / fps);
  let samples;
  if (options.samples !== undefined) {
    if (!Number.isInteger(options.samples) || options.samples < 1)
      throw new Error("--samples must be a whole number");
    if (options.samples > cap)
      throw new Error(
        `At ${fps} fps at most ${cap} samples fit the ${MAX_RENDER_FPS} fps render limit`,
      );
    samples = options.samples;
  } else {
    let wanted = DEFAULT_SAMPLES;
    if (options.peak !== undefined) {
      if (!Number.isFinite(options.peak) || options.peak < 0)
        throw new Error("The measured peak must be a speed of at least 0 px per frame");
      // Copies of a move of `peak` px per frame sit peak/samples apart.
      wanted = Math.max(DEFAULT_SAMPLES, Math.ceil(options.peak / MAX_COPY_GAP_PX));
    }
    samples = Math.min(wanted, cap);
  }
  const blended = Math.min(samples, Math.round((samples * shutter) / 360));
  // Fewer than three sub-frames per frame (above 80 fps) ghosts instead of blurring.
  if (samples < 3 || blended < 2)
    throw new Error(
      `At ${fps} fps there is room for ${samples} sample${samples === 1 ? "" : "s"} per frame, ` +
        "too few to blur; lower the frame rate or widen --shutter.",
    );
  return { fps, shutter, samples, renderFps: fps * samples, blended };
}

/** 8-bit sRGB code → linear light in 0..65535 (exact sRGB transfer function). */
export const SRGB_TO_LINEAR = (() => {
  const table = new Uint16Array(256);
  for (let code = 0; code < 256; code++) {
    const value = code / 255;
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    table[code] = Math.round(linear * 65535);
  }
  return table;
})();
/** Linear light in 0..65535 → nearest 8-bit sRGB code. */
export const LINEAR_TO_SRGB = (() => {
  const table = new Uint8Array(65536);
  for (let level = 0; level < 65536; level++) {
    const linear = level / 65535;
    const value = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
    table[level] = Math.min(255, Math.max(0, Math.round(value * 255)));
  }
  return table;
})();

/** Sampling stride (pixels each way) of the small luma picture the cut test compares. */
const CUT_STRIDE = 8;
/** A pixel "changed" across a step when its luma moves more than this many levels. */
const CUT_LEVEL = 24;
/** A cut changes at least this share of the frame in one step... */
const CUT_CHANGE = 0.3;
/** ...by several times the largest mean difference of the group's other steps. */
const CUT_SPIKE = 3;
/** Other steps count as at least this mean difference (levels), so noise is no baseline. */
const CUT_QUIET = 1;

/** Small luma picture of an RGB24 frame for the cut test (every CUT_STRIDE-th pixel). */
export function thumbnail(frame, width, height) {
  const columns = Math.ceil(width / CUT_STRIDE);
  const rows = Math.ceil(height / CUT_STRIDE);
  const thumb = new Uint8Array(columns * rows);
  let index = 0;
  for (let y = 0; y < height; y += CUT_STRIDE) {
    let offset = y * width * 3;
    for (let x = 0; x < width; x += CUT_STRIDE, offset += CUT_STRIDE * 3)
      thumb[index++] = (frame[offset] + 2 * frame[offset + 1] + frame[offset + 2] + 2) >> 2;
  }
  return thumb;
}

function stepDifference(a, b) {
  let total = 0;
  let changed = 0;
  for (let index = 0; index < a.length; index++) {
    const difference = Math.abs(a[index] - b[index]);
    total += difference;
    if (difference > CUT_LEVEL) changed++;
  }
  return { mean: total / a.length, changed: changed / a.length };
}

/**
 * How many of a group's first `blended` sub-frames to average: all of them, unless a hard cut
 * falls between two of them, in which case only those before the cut (the side holding the
 * output frame's own time, the first sub-frame). `thumbs` are the whole group's thumbnails;
 * `before` is the previous group's last thumbnail, or null.
 */
export function framesBeforeCut(thumbs, blended, before = null) {
  const steps = [];
  if (before) steps.push(stepDifference(before, thumbs[0]));
  const first = steps.length;
  for (let index = 1; index < thumbs.length; index++)
    steps.push(stepDifference(thumbs[index - 1], thumbs[index]));
  for (let index = 1; index < blended; index++) {
    const step = steps[first + index - 1];
    let others = CUT_QUIET;
    for (let other = 0; other < steps.length; other++)
      if (other !== first + index - 1) others = Math.max(others, steps[other].mean);
    if (step.changed >= CUT_CHANGE && step.mean >= CUT_SPIKE * others) return index;
  }
  return blended;
}

/**
 * Averages RGB24 sub-frames in linear light into `out`. Runs of identical sub-frames are
 * found by byte comparison; when every frame is the same, `out` is a byte copy.
 */
export function blendFrames(frames, out) {
  const count = frames.length;
  const first = frames[0];
  if (count === 1 || frames.every((frame) => frame === first || first.equals(frame))) {
    first.copy(out);
    return out;
  }
  const half = count >> 1;
  const toLinear = SRGB_TO_LINEAR;
  const toSrgb = LINEAR_TO_SRGB;
  if (count === 2) {
    const [a, b] = frames;
    for (let i = 0; i < out.length; i++) {
      const x = a[i];
      const y = b[i];
      out[i] = x === y ? x : toSrgb[(toLinear[x] + toLinear[y] + 1) >> 1];
    }
    return out;
  }
  if (count === 3) {
    const [a, b, c] = frames;
    for (let i = 0; i < out.length; i++) {
      const x = a[i];
      const y = b[i];
      const z = c[i];
      out[i] =
        x === y && y === z ? x : toSrgb[((toLinear[x] + toLinear[y] + toLinear[z] + 1) / 3) | 0];
    }
    return out;
  }
  for (let i = 0; i < out.length; i++) {
    const x = first[i];
    let same = true;
    let sum = toLinear[x];
    for (let f = 1; f < count; f++) {
      const y = frames[f][i];
      if (y !== x) same = false;
      sum += toLinear[y];
    }
    out[i] = same ? x : toSrgb[((sum + half) / count) | 0];
  }
  return out;
}

/** FFmpeg colour matrix and range names matching the source's tags, for RGB round trips. */
function colorConversion(color) {
  const matrix =
    {
      bt709: "bt709",
      smpte170m: "bt601",
      bt470bg: "bt601",
      fcc: "fcc",
      smpte240m: "smpte240m",
      bt2020nc: "bt2020",
      bt2020c: "bt2020",
    }[color.color_space] ?? "bt601";
  const range = color.color_range === "pc" ? "full" : "limited";
  return { matrix, range };
}

/**
 * Feed loudness (EBU R128 integrated -14 LUFS) where Reels, TikTok and Shorts play, then a
 * 4x-oversampled limiter at -2 dBFS: loudnorm alone let a scored mix reach +2 dB true peak.
 * Encoded at 320k: FFmpeg's AAC at 192k overshot the limited peaks by 2 dB.
 */
export const LOUDNESS =
  "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=192000," +
  "alimiter=limit=0.79:level=false:attack=1:release=50,aresample=48000";

/**
 * FFmpeg arguments that encode piped RGB24 blended frames, with the audio of `input` (none
 * when `input` is null) brought to feed loudness, and the source's colour tags.
 */
export function encodeArgs(input, output, plan, size, quality = "looks", color = {}) {
  const encode = QUALITY[quality];
  if (!encode) throw new Error(`Unknown --quality ${quality}`);
  const { matrix, range } = colorConversion(color);
  const tags = [
    ["-colorspace", color.color_space],
    ["-color_primaries", color.color_primaries],
    ["-color_trc", color.color_transfer],
    ["-color_range", color.color_range],
  ].flatMap(([flag, value]) =>
    typeof value === "string" && /^[a-z0-9-]+$/.test(value) && value !== "unknown"
      ? [flag, value]
      : [],
  );
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-protocol_whitelist",
    "file,pipe",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-s",
    `${size.width}x${size.height}`,
    "-r",
    String(plan.fps),
    "-i",
    "pipe:0",
    ...(input ? ["-i", input] : []),
    "-map",
    "0:v:0",
    ...(input ? ["-map", "1:a?"] : []),
    "-vf",
    `scale=out_color_matrix=${matrix}:out_range=${range}:flags=accurate_rnd,format=yuv420p`,
    "-c:v",
    "libx264",
    "-crf",
    encode.crf,
    "-preset",
    encode.preset,
    "-pix_fmt",
    "yuv420p",
    ...tags,
    "-af",
    LOUDNESS,
    "-c:a",
    "aac",
    "-b:a",
    "320k",
    "-ar",
    "48000",
    "-shortest",
    "-movflags",
    "+faststart",
    "-metadata",
    `comment=gg-motion-blur samples=${plan.blended}`,
    "-y",
    output,
  ];
}

function spawnTool(binary, args, signal, stdin) {
  const child = spawn(binary, args, {
    stdio: [stdin ? "pipe" : "ignore", stdin ? "ignore" : "pipe", "pipe"],
    windowsHide: true,
    signal,
  });
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors = (errors + chunk).slice(-4000);
  });
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit({ code, errors: () => errors.trim() }));
  });
  return { child, exited };
}

/** Frame size, rate and colour tags of a video's first video stream. */
async function probeVideo(file, signal) {
  const { ffprobe } = await mediaBinaries();
  const { stdout } = await run(
    ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate,color_space,color_primaries,color_transfer,color_range",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true, signal },
  );
  const stream = JSON.parse(stdout)?.streams?.[0] ?? {};
  const [num, den] = String(stream.avg_frame_rate ?? "")
    .split("/")
    .map(Number);
  return { ...stream, rate: num / den };
}

/**
 * Averages a high-rate render into the blurred output (written fresh; the caller places it).
 * Decodes to RGB24, blends each output frame's first `blended` sub-frames in linear light,
 * never across a hard cut, and encodes the result with the render's audio.
 */
export async function blendVideo(input, output, plan, quality, signal) {
  return assembleSpans([{ file: input, still: false }], input, output, plan, quality, signal);
}

/**
 * Encodes the blurred output from renders of its spans, in order. A moving segment is a
 * render at `plan.renderFps` whose sub-frames are blended per output frame as in
 * blendVideo; a still segment is a render at `plan.fps` whose frames are copied as they
 * are (a still frame blends to itself). `frames` is the segment's output-frame count (checked
 * when given); `skip` drops that many leading output frames of the file first. `audio` is the
 * file whose audio is muxed in, or null for none.
 *
 * @param {{ file: string, still: boolean, frames?: number, skip?: number }[]} segments
 */
export async function assembleSpans(segments, audio, output, plan, quality, signal) {
  const { ffmpeg } = await mediaBinaries();
  if (!QUALITY[quality ?? "looks"]) throw new Error(`Unknown --quality ${quality}`);
  if (!segments.length) throw new Error("Nothing to assemble");
  const streams = [];
  for (const segment of segments) {
    const stream = await probeVideo(segment.file, signal);
    const expected = segment.still ? plan.fps : plan.renderFps;
    if (Math.abs(stream.rate - expected) > 0.01)
      throw new Error(`Expected a ${expected} fps render, got ${stream.avg_frame_rate}`);
    if (!Number.isInteger(stream.width) || !Number.isInteger(stream.height))
      throw new Error("The render has no readable frame size");
    if (
      streams.length &&
      (stream.width !== streams[0].width || stream.height !== streams[0].height)
    )
      throw new Error("The span renders differ in frame size");
    streams.push(stream);
  }
  const { width, height } = streams[0];
  const frameBytes = width * height * 3;
  const encode = spawnTool(
    ffmpeg,
    encodeArgs(audio, output, plan, { width, height }, quality ?? "looks", streams[0]),
    signal,
    true,
  );
  const sink = encode.child.stdin;
  // A failed encoder closes its input; the exit code reports why.
  sink.on("error", () => {});
  const write = (buffer) =>
    new Promise((resolveWrite, reject) => {
      if (sink.write(buffer)) return resolveWrite();
      const onDrain = () => {
        cleanup();
        resolveWrite();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("The encoder stopped early"));
      };
      const cleanup = () => {
        sink.off("drain", onDrain);
        sink.off("close", onClose);
      };
      sink.on("drain", onDrain);
      sink.on("close", onClose);
    });
  const { samples, blended } = plan;
  // The previous output frame's last (sub-)frame thumbnail, for the cut test across groups.
  let before = null;
  try {
    for (const [index, segment] of segments.entries()) {
      const { matrix, range } = colorConversion(streams[index]);
      const per = segment.still ? 1 : samples;
      const filters = [];
      if (segment.skip || segment.frames !== undefined) {
        const start = (segment.skip ?? 0) * per;
        filters.push(
          `trim=start_frame=${start}` +
            (segment.frames === undefined ? "" : `:end_frame=${start + segment.frames * per}`),
        );
      }
      filters.push(`scale=in_color_matrix=${matrix}:in_range=${range}:flags=accurate_rnd`);
      filters.push("format=rgb24");
      const decode = spawnTool(
        ffmpeg,
        [
          "-hide_banner",
          "-nostdin",
          "-loglevel",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          segment.file,
          "-map",
          "0:v:0",
          "-an",
          "-vf",
          filters.join(","),
          "-f",
          "rawvideo",
          "-",
        ],
        signal,
        false,
      );
      const group = Array.from({ length: per }, () => Buffer.allocUnsafe(frameBytes));
      const thumbs = [];
      let filled = 0;
      let offset = 0;
      let written = 0;
      const flush = async (count) => {
        if (segment.still) {
          await write(Buffer.from(group[0]));
          before = thumbnail(group[0], width, height);
          written++;
          return;
        }
        if (count < blended) return;
        const used = framesBeforeCut(thumbs.slice(0, count), blended, before);
        await write(blendFrames(group.slice(0, used), Buffer.allocUnsafe(frameBytes)));
        before = thumbs[count - 1];
        thumbs.length = 0;
        written++;
      };
      for await (const chunk of decode.child.stdout) {
        let read = 0;
        while (read < chunk.length) {
          const take = Math.min(frameBytes - offset, chunk.length - read);
          chunk.copy(group[filled], offset, read, read + take);
          read += take;
          offset += take;
          if (offset === frameBytes) {
            if (!segment.still) thumbs.push(thumbnail(group[filled], width, height));
            offset = 0;
            filled++;
            if (filled === per) {
              await flush(filled);
              filled = 0;
            }
          }
        }
      }
      const decoded = await decode.exited;
      if (decoded.code !== 0 || offset !== 0)
        throw new Error(
          `Decoding the render failed: ${decoded.errors() || `exit ${decoded.code}`}`,
        );
      if (filled) await flush(filled);
      thumbs.length = 0;
      if (segment.frames !== undefined && written !== segment.frames)
        throw new Error(`Expected ${segment.frames} frames from ${segment.file}, got ${written}`);
    }
  } finally {
    sink.end();
  }
  const encoded = await encode.exited;
  if (encoded.code !== 0)
    throw new Error(`Encoding the blur failed: ${encoded.errors() || `exit ${encoded.code}`}`);
}

/** A still run must keep this many output frames from each end of the hold it sits in. */
export const STILL_MARGIN = 2;
/** Still runs shorter than this (after the margins) render with the moving frames. */
export const MIN_STILL_SECONDS = 0.5;

/**
 * Ordered output-frame spans `{ start, end, still }` (end exclusive) covering `frames`
 * output frames. `holds[i]` is true when output frame i is unchanged through frame i + 1,
 * so its blur (sub-frames between i and i + 1) is the frame itself. A run of holds becomes a
 * still span shrunk by STILL_MARGIN at both ends, kept only when at least MIN_STILL_SECONDS
 * long; everything else is moving. Without holds, one moving span covers everything.
 *
 * @param {ArrayLike<boolean | number> | null | undefined} holds
 * @param {number} fps
 * @param {number} frames
 */
export function planSpans(holds, fps, frames) {
  if (!Number.isInteger(frames) || frames < 1) throw new Error("Spans need a frame count");
  if (!holds) return [{ start: 0, end: frames, still: false }];
  const minimum = Math.ceil(MIN_STILL_SECONDS * fps);
  const spans = [];
  const add = (start, end, still) => {
    if (end <= start) return;
    const last = spans[spans.length - 1];
    if (last && last.still === still && last.end === start) last.end = end;
    else spans.push({ start, end, still });
  };
  let cursor = 0;
  let index = 0;
  while (index < frames) {
    if (!holds[index]) {
      index++;
      continue;
    }
    let runEnd = index;
    while (runEnd < frames && holds[runEnd]) runEnd++;
    const start = index + STILL_MARGIN;
    const end = runEnd - STILL_MARGIN;
    if (end - start >= minimum) {
      add(cursor, start, false);
      add(start, end, true);
      cursor = end;
    }
    index = runEnd;
  }
  add(cursor, frames, false);
  return spans;
}

/**
 * What a draft video says about the blur: `peak`, its fastest move in pixels per output frame
 * at the draft's size, from motion-check's flow meter (0 when nothing moves fast enough to
 * report); `holds`, per draft frame, whether it is unchanged through the next frame (by the
 * flow meter's still-step test, at its small grey grid); its frame count, rate and whether it
 * carries audio.
 */
export async function measureDraft(draft, fps, signal) {
  const { measureFlow, STILL_LEVEL, STILL_STEP_SHARE } = await import("./motion-check.mjs");
  const { ffprobe } = await mediaBinaries();
  const { stdout } = await run(
    ffprobe,
    ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", draft],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true, signal },
  );
  const streams = JSON.parse(stdout)?.streams ?? [];
  const stream = streams.find((entry) => entry.codec_type === "video") ?? {};
  const side = Math.max(stream.width ?? 0, stream.height ?? 0);
  if (!side) throw new Error("The --draft video has no readable frame size");
  const holds = [];
  let previous = null;
  const flow = await measureFlow(draft, signal, (frame) => {
    if (previous) {
      let visible = 0;
      for (let index = 0; index < frame.length; index++)
        if (Math.abs(frame[index] - previous[index]) > STILL_LEVEL) visible++;
      holds.push(visible / frame.length <= STILL_STEP_SHARE);
    }
    previous = Uint8Array.from(frame);
  });
  // The last frame has no next frame to hold through.
  if (previous) holds.push(false);
  // `peak` is a share of the long side per draft frame.
  const peak = Math.max(0, ...flow.fast.map((span) => span.peak));
  return {
    peak: (peak * side * flow.fps) / fps,
    holds,
    frames: holds.length,
    fps: flow.fps,
    hasAudio: streams.some((entry) => entry.codec_type === "audio"),
  };
}

/** The fastest move in a draft video, in pixels per output frame (see measureDraft). */
export async function draftPeak(draft, fps, signal) {
  return (await measureDraft(draft, fps, signal)).peak;
}

/** The composition's own frame rate when it declares one, else HyperFrames' default 30. */
async function compositionFps(project, composition) {
  try {
    const html = await readFile(join(project, composition ?? "index.html"), "utf8");
    const declared = /\bdata-fps\s*=\s*["']?(\d{1,3})\b/.exec(html);
    if (declared) return Number(declared[1]);
  } catch {
    // An unreadable composition fails in the render itself, with HyperFrames' own message.
  }
  return 30;
}

function parseArgs(argv) {
  const [project, output, ...rest] = argv;
  if (!project || !output || project.startsWith("--") || output.startsWith("--"))
    throw new Error(
      "usage: motion-blur.mjs <project-dir> <output.mp4> [--fps <n>] [--shutter <degrees>] " +
        "[--quality <name>] [--composition <file>] [--resolution <preset>] [--workers <n|auto>] " +
        "[--samples <n> | --draft <video>] [--no-skip-still]",
    );
  const options = { project: resolve(project), output: resolve(output), passthrough: [] };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (flag === "--no-skip-still") {
      options.noSkipStill = true;
      index--;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (flag === "--fps") options.fps = Number(value);
    else if (flag === "--shutter") options.shutter = Number(value);
    else if (flag === "--samples") options.samples = Number(value);
    else if (flag === "--draft") options.draft = resolve(value);
    else if (flag === "--quality") {
      if (!QUALITY[value]) throw new Error(`Unknown --quality ${value}`);
      options.quality = value;
    } else if (PASSTHROUGH.includes(flag)) {
      if (flag === "--composition") options.composition = value;
      options.passthrough.push(flag, value);
    } else throw new Error(`Unsupported option ${flag}; the blur step owns --output and --format`);
  }
  if (options.samples !== undefined && options.draft)
    throw new Error("Give --samples or --draft, not both");
  if (extname(options.output).toLowerCase() !== ".mp4")
    throw new Error("The blur step writes MP4 only");
  return options;
}

/**
 * Fixed cost, in seconds, of one HyperFrames render call before it captures a frame (browser
 * start, page load, encoder): a 2-frame range of a 1080×1920 composition took about 2.5 s.
 */
export const RENDER_CALL_SECONDS = 2.5;

/** HyperFrames refused a `--frames` range render (HDR/shader capture path, past the end...). */
class FramesRefused extends Error {}
const FRAMES_REFUSED =
  /--frames|Render artifact is truncated|Unsupported frames|Invalid frames|frameRange/;

/** One HyperFrames render of the project to `output` at `fps`, optionally of a frame range. */
async function renderComposition(options, quality, fps, output, frames, signal) {
  const started = performance.now();
  const render = spawn(
    process.execPath,
    [
      join(here, "hyperframes.mjs"),
      "render",
      "--fps",
      String(fps),
      ...(frames ? ["--frames", `${frames[0]}-${frames[1]}`] : []),
      "--format",
      "mp4",
      "--quality",
      quality,
      "--quiet",
      "--output",
      output,
      ...(options.passthrough.includes("--workers") ? [] : ["--workers", String(defaultWorkers())]),
      ...options.passthrough,
    ],
    {
      cwd: options.project,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      signal,
    },
  );
  let errors = "";
  render.stderr.on("data", (chunk) => {
    errors = (errors + chunk).slice(-4000);
  });
  const code = await new Promise((resolveExit, reject) => {
    render.once("error", reject);
    render.once("close", resolveExit);
  });
  if (code !== 0) {
    const message = `Render failed: ${errors.trim() || `exit ${code}`}`;
    const refusal = errors.split("\n").find((line) => FRAMES_REFUSED.test(line));
    if (frames && refusal) throw new FramesRefused(refusal.trim());
    throw new Error(message);
  }
  return (performance.now() - started) / 1000;
}

/**
 * Renders only what each span needs: moving spans at the sub-frame rate, still spans at the
 * output rate (one range render per still span, or one whole render at the output rate when
 * that is estimated cheaper). Returns the assembly segments and a timing log.
 */
async function renderSpans(options, quality, plan, spans, work, signal) {
  const segments = [];
  const renders = [];
  let captureSeconds = 0;
  let captured = 0;
  for (const [index, span] of spans.entries()) {
    if (span.still) continue;
    const file = join(work, `span-${index}.mp4`);
    const range = [span.start * plan.samples, span.end * plan.samples];
    const seconds = await renderComposition(options, quality, plan.renderFps, file, range, signal);
    renders.push({ fps: plan.renderFps, frames: range, seconds: Math.round(seconds * 10) / 10 });
    captureSeconds += Math.max(0, seconds - RENDER_CALL_SECONDS);
    captured += range[1] - range[0];
    segments[index] = { file, still: false, frames: span.end - span.start };
  }
  const still = spans.map((span, index) => ({ span, index })).filter(({ span }) => span.still);
  const stillFrames = still.reduce((sum, { span }) => sum + span.end - span.start, 0);
  const total = spans[spans.length - 1].end;
  // Seconds per captured frame, from the moving renders (one sub-frame costs about as much
  // as one output frame).
  const perFrame = captured ? captureSeconds / captured : 0.02;
  const separate = still.length * RENDER_CALL_SECONDS + stillFrames * perFrame;
  const whole = RENDER_CALL_SECONDS + total * perFrame;
  const strategy = separate <= whole ? "ranges" : "whole";
  if (strategy === "whole") {
    const file = join(work, "still.mp4");
    const seconds = await renderComposition(options, quality, plan.fps, file, null, signal);
    renders.push({ fps: plan.fps, frames: [0, total], seconds: Math.round(seconds * 10) / 10 });
    for (const { span, index } of still)
      segments[index] = { file, still: true, skip: span.start, frames: span.end - span.start };
  } else {
    for (const { span, index } of still) {
      const file = join(work, `span-${index}.mp4`);
      const seconds = await renderComposition(
        options,
        quality,
        plan.fps,
        file,
        [span.start, span.end],
        signal,
      );
      renders.push({
        fps: plan.fps,
        frames: [span.start, span.end],
        seconds: Math.round(seconds * 10) / 10,
      });
      segments[index] = { file, still: true, frames: span.end - span.start };
    }
  }
  return { segments, renders, stillStrategy: strategy };
}

/**
 * Screen a finished video for harmful flashing (WCAG 2.3.1 general and red thresholds: no
 * more than three flashes in any second). `safe` is false with the seconds that flash too much.
 */
export async function checkFlashing(file, signal) {
  const result = await analyzeFlashes(file, signal);
  const failures = [...result.general.failures, ...result.red.failures]
    .sort((a, b) => a.start - b.start)
    .slice(0, 10);
  return {
    safe: result.ok,
    maxFlashesPerSecond: Math.max(
      result.general.maxFlashesPerSecond,
      result.red.maxFlashesPerSecond,
    ),
    ...(failures.length ? { failures } : {}),
  };
}

async function main() {
  const started = performance.now();
  const options = parseArgs(process.argv.slice(2));
  if (!(await stat(options.project)).isDirectory()) throw new Error("Expected a project folder");
  if (await stat(options.output).catch(() => null))
    throw new Error(`${options.output} already exists; render a new version instead`);
  const fps = options.fps ?? (await compositionFps(options.project, options.composition));
  const shutter = options.shutter ?? DEFAULT_SHUTTER;
  // Refuse impossible rates and shutters before measuring a draft.
  blurPlan(fps, shutter, options.samples === undefined ? {} : { samples: options.samples });
  const quality = options.quality ?? "looks";
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const draft = options.draft
    ? await measureDraft(options.draft, fps, controller.signal)
    : undefined;
  const peak = draft?.peak;
  const plan = blurPlan(fps, shutter, { samples: options.samples, peak });
  // Still spans come from the draft's frames, so it must be at the output rate.
  let note;
  let spans = null;
  if (draft && options.noSkipStill)
    note = "--no-skip-still: rendered everything at the sub-frame rate";
  else if (draft && Math.abs(draft.fps - fps) > 0.01)
    note = `The draft is ${draft.fps} fps, not ${fps}; rendered everything at the sub-frame rate`;
  else if (draft) {
    spans = planSpans(draft.holds, fps, draft.frames);
    if (!spans.some((span) => span.still)) {
      note = "No still span long enough to skip";
      spans = null;
    }
  }
  const work = await mkdtemp(join(tmpdir(), "gg-motion-blur-"));
  try {
    const renderStarted = performance.now();
    const blended = join(work, "blurred.mp4");
    let spanned = null;
    if (spans) {
      try {
        spanned = await renderSpans(options, quality, plan, spans, work, controller.signal);
      } catch (error) {
        if (!(error instanceof FramesRefused)) throw error;
        note = `HyperFrames refused --frames, rendered everything instead: ${error.message.slice(0, 300)}`;
        spans = null;
      }
    }
    let renderSeconds;
    let blendStarted;
    if (spanned) {
      renderSeconds = (performance.now() - renderStarted) / 1000;
      blendStarted = performance.now();
      // Range renders carry no audio; the draft is a render of the same composition, so its
      // audio track is the composition's.
      await assembleSpans(
        spanned.segments,
        draft.hasAudio ? options.draft : null,
        blended,
        plan,
        quality,
        controller.signal,
      );
    } else {
      const source = join(work, "samples.mp4");
      await renderComposition(options, quality, plan.renderFps, source, null, controller.signal);
      renderSeconds = (performance.now() - renderStarted) / 1000;
      blendStarted = performance.now();
      await blendVideo(source, blended, plan, quality, controller.signal);
    }
    // Exclusive copy: never replaces an export that appeared meanwhile.
    await copyFile(blended, options.output, constants.COPYFILE_EXCL);
    const flashing = await checkFlashing(options.output, controller.signal);
    if (!flashing.safe) {
      process.exitCode = 1;
      const when = (flashing.failures ?? []).map((f) => `${f.start}–${f.end}s`).join(", ");
      process.stderr.write(
        `Harmful flashing: up to ${flashing.maxFlashesPerSecond} flashes a second (at most 3 are safe) at ${when}. Slow or soften those moments and render a new version; do not deliver this one.\n`,
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: flashing.safe,
        output: options.output,
        flashing,
        ...plan,
        ...(peak === undefined ? {} : { draftPeakPx: Math.round(peak * 10) / 10 }),
        quality,
        ...(spanned
          ? {
              spans,
              stillFrames: spans
                .filter((span) => span.still)
                .reduce((sum, span) => sum + span.end - span.start, 0),
              stillStrategy: spanned.stillStrategy,
              renders: spanned.renders,
              audio: draft.hasAudio ? "draft" : "none",
            }
          : {}),
        ...(note ? { note } : {}),
        renderSeconds: Math.round(renderSeconds * 10) / 10,
        blendSeconds: Math.round((performance.now() - blendStarted) / 100) / 10,
        elapsedMs: Math.round(performance.now() - started),
      })}\n`,
    );
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `Motion blur failed: ${error instanceof Error ? error.message : "invalid input"}\n`,
    );
    process.exitCode = 1;
  }
}
