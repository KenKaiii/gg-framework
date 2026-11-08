#!/usr/bin/env node
// GG Motion reference study: measure a video the user likes so a new video can
// take its rules (pace, stillness, how scenes change), never its scenes.
//
// Usage: node reference-study.mjs <reference-video> [--out <folder>]
// Default out: ./reference-study. Writes report.json, report.md, two contact
// sheets (one frame per shot, and an even timeline) and the frames behind them.
// Prints a one-line JSON summary.
//
// Every frame is decoded once on motion-check's small grey flow grid, so a
// reference and a GG render are measured the same way.
import { execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { mediaBinaries } from "./media-binaries.mjs";
import { measureFlow } from "./motion-check.mjs";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

/** A grid pixel changed visibly when its grey level moves by more than this... */
export const VISIBLE_LEVEL = 8;
/** ...and a frame step is still when at most this share of the grid changed visibly.
 * Counting pixels, not averaging them, keeps a small moving thing (a cursor, a talking
 * head in a corner) from reading as still. */
export const STILL_SHARE = 0.0002;
/** A still stretch at least this long is a rest. */
export const REST_SECONDS = 0.5;
/** Cuts this close together (seconds) belong to one burst... */
export const BURST_GAP = 0.6;
/** ...of at least this many cuts. */
export const BURST_CUTS = 3;
const MAX_SHOT_FRAMES = 24;
const TIMELINE_FRAMES = 16;

const round = (value, places = 3) => Math.round(value * 10 ** places) / 10 ** places;

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

/**
 * The study's figures from a flow measurement and two figures per frame step
 * (index i is frame i-1 → i; index 0 is unused): `energy`, the mean grey change
 * (0..1), and `changed`, the share of the grid that changed visibly.
 * @param {{ duration: number; fps: number; cuts: number[]; fast: { start: number; end: number; peak: number }[] }} flow
 * @param {{ energy: ArrayLike<number>; changed: ArrayLike<number> }} steps
 */
export function studyFlow(flow, { energy, changed }) {
  const { duration, fps } = flow;
  if (!(duration > 0) || !(fps > 0)) throw new Error("Study needs a duration and frame rate");
  const cuts = [...flow.cuts].filter((t) => t > 0 && t < duration).sort((a, b) => a - b);
  if (energy.length !== changed.length) throw new Error("Study needs both figures for every step");
  const steps = Math.max(0, energy.length - 1);

  // Stillness, and the rests: still stretches long enough to read as a pause.
  let still = 0;
  const rests = [];
  let runStart = -1;
  const closeRun = (end) => {
    if (runStart >= 0 && (end - runStart) / fps >= REST_SECONDS)
      rests.push({ start: round((runStart - 1) / fps, 2), end: round((end - 1) / fps, 2) });
    runStart = -1;
  };
  const moving = [];
  for (let i = 1; i <= steps; i++) {
    if (changed[i] <= STILL_SHARE) {
      still++;
      if (runStart < 0) runStart = i;
    } else {
      closeRun(i);
      moving.push(energy[i]);
    }
  }
  closeRun(steps + 1);

  // Shots between hard cuts, and how even their lengths are.
  const bounds = [0, ...cuts, duration];
  const shots = [];
  for (let i = 1; i < bounds.length; i++) shots.push(round(bounds[i] - bounds[i - 1], 2));
  const sortedShots = [...shots].sort((a, b) => a - b);
  const mean = shots.reduce((sum, s) => sum + s, 0) / shots.length;
  const sd = Math.sqrt(shots.reduce((sum, s) => sum + (s - mean) ** 2, 0) / shots.length);

  // Bursts: runs of cuts close together.
  const bursts = [];
  let group = [];
  const closeGroup = () => {
    if (group.length >= BURST_CUTS)
      bursts.push({ start: group[0], end: group.at(-1), cuts: group.length });
    group = [];
  };
  for (const cut of cuts) {
    if (group.length && cut - group.at(-1) > BURST_GAP) closeGroup();
    group.push(cut);
  }
  closeGroup();

  const fastSeconds = flow.fast.reduce((sum, run) => sum + (run.end - run.start), 0);
  moving.sort((a, b) => a - b);
  return {
    duration: round(duration, 2),
    fps: round(fps, 2),
    stillShare: steps ? round(still / steps) : 0,
    rests,
    longestRest: rests.reduce((best, r) => Math.max(best, round(r.end - r.start, 2)), 0),
    cuts: cuts.map((t) => round(t, 2)),
    cutsPerMinute: round((cuts.length / duration) * 60, 1),
    bursts: bursts.map((b) => ({ start: round(b.start, 2), end: round(b.end, 2), cuts: b.cuts })),
    shots: {
      count: shots.length,
      lengths: shots,
      mean: round(mean, 2),
      median: round(quantile(sortedShots, 0.5), 2),
      shortest: sortedShots[0],
      longest: sortedShots.at(-1),
      // Standard deviation over mean: near 0 is metronomic, above ~0.5 is varied.
      spread: mean > 0 ? round(sd / mean, 2) : 0,
    },
    motion: {
      // Share of the length with something moving faster than 2% of the frame per frame.
      fastShare: round(Math.min(1, fastSeconds / duration)),
      fastMoves: flow.fast.length,
      // Fastest move, as a share of the frame's long side per frame.
      peak: flow.fast.reduce((best, run) => Math.max(best, run.peak), 0),
      // Typical and busy picture change while moving (mean grey change per frame, %).
      typical: round(quantile(moving, 0.5) * 100, 2),
      busy: round(quantile(moving, 0.9) * 100, 2),
    },
  };
}

const seconds = (t) => `${t.toFixed(2)} s`;

/** A short, factual reading of the figures, for report.md. */
export function studyMarkdown(study, name) {
  const lines = [
    `# Reference study: ${name}`,
    "",
    "Rules to take, never scenes. Figures are measured on every frame.",
    "",
    "| Figure | Value |",
    "|---|---|",
    `| Length | ${seconds(study.duration)} at ${study.fps} fps |`,
    `| Still | ${Math.round(study.stillShare * 100)}% of frames; ${study.rests.length} rest${study.rests.length === 1 ? "" : "s"} of ${REST_SECONDS} s or more, longest ${seconds(study.longestRest)} |`,
    `| Hard cuts | ${study.cuts.length} (${study.cutsPerMinute} a minute) |`,
    `| Bursts | ${study.bursts.length ? study.bursts.map((b) => `${b.cuts} cuts ${seconds(b.start)}–${seconds(b.end)}`).join("; ") : "none"} |`,
    `| Shots | ${study.shots.count}; median ${seconds(study.shots.median)}, ${seconds(study.shots.shortest)}–${seconds(study.shots.longest)}, spread ${study.shots.spread} |`,
    `| Fast motion | ${Math.round(study.motion.fastShare * 100)}% of the length in ${study.motion.fastMoves} move${study.motion.fastMoves === 1 ? "" : "s"}; peak ${Math.round(study.motion.peak * 100)}% of the frame a frame |`,
    `| Picture change while moving | typical ${study.motion.typical}%, busy ${study.motion.busy}% a frame |`,
    "",
    "How to read it:",
    "",
    "- Spread near 0 means even shot lengths; above about 0.5 means a varied rhythm.",
    "- Few cuts with motion most of the time means the video carries its scenes",
    "  instead of cutting; take the carry, not the cuts.",
    "- Bursts are where the video speeds up on purpose; note where they fall in",
    "  the length, not what they show.",
    "",
  ];
  if (study.rests.length)
    lines.push(
      "Rests:",
      "",
      ...study.rests.map((r) => `- ${seconds(r.start)}–${seconds(r.end)}`),
      "",
    );
  if (study.cuts.length) lines.push("Cuts:", "", study.cuts.map((t) => seconds(t)).join(", "), "");
  lines.push(
    "Sheets: `sheet-shots.jpg` (one frame from the middle of each shot) and",
    "`sheet-timeline.jpg` (evenly spaced). The frames behind them are in `frames/`.",
    "",
  );
  return lines.join("\n");
}

/** Up to `count` evenly spread items of a list. */
function spread(list, count) {
  if (list.length <= count) return list;
  return Array.from(
    { length: count },
    (_, i) => list[Math.round((i * (list.length - 1)) / (count - 1))],
  );
}

async function grabFrames(ffmpeg, file, times, folder, signal) {
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  for (const t of times) {
    await run(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-ss",
        t.toFixed(3),
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        "scale=640:-2",
        "-q:v",
        "3",
        join(folder, `${t.toFixed(2)}s.jpg`),
      ],
      { timeout: 60_000, windowsHide: true, signal },
    );
  }
}

async function sheet(frames, out, signal) {
  await run(process.execPath, [join(here, "contact-sheet.mjs"), frames, out, "--cols", "4"], {
    timeout: 120_000,
    windowsHide: true,
    signal,
  });
}

function parseArgs(argv) {
  const [video, ...rest] = argv;
  if (!video || video.startsWith("--"))
    throw new Error("usage: reference-study.mjs <reference-video> [--out <folder>]");
  const options = { video: resolve(video), out: resolve("reference-study") };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (flag === "--out") options.out = resolve(value);
    else throw new Error(`Unsupported option ${flag}`);
  }
  return options;
}

async function main() {
  const started = performance.now();
  const options = parseArgs(process.argv.slice(2));
  if (!(await stat(options.video).catch(() => null))?.isFile())
    throw new Error("Expected a local video file (download a linked video first)");
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    // Per frame step, measured in the same decode as cuts and fast moves.
    const energy = [0];
    const changed = [0];
    let previous = null;
    const flow = await measureFlow(options.video, controller.signal, (frame) => {
      if (previous) {
        let total = 0;
        let visible = 0;
        for (let i = 0; i < frame.length; i++) {
          const difference = Math.abs(frame[i] - previous[i]);
          total += difference;
          if (difference > VISIBLE_LEVEL) visible++;
        }
        energy.push(total / frame.length / 255);
        changed.push(visible / frame.length);
      }
      previous = Uint8Array.from(frame);
    });
    const study = studyFlow(flow, { energy, changed });
    const name = basename(options.video);
    await mkdir(options.out, { recursive: true });

    const { ffmpeg } = await mediaBinaries();
    // Frames sit a little inside each shot and the length, away from cuts and fades.
    const end = Math.max(0, study.duration - 0.05);
    const bounds = [0, ...study.cuts, study.duration];
    const shotTimes = spread(
      bounds.slice(1).map((b, i) => Math.min(end, (bounds[i] + b) / 2)),
      MAX_SHOT_FRAMES,
    );
    const timeline = Array.from({ length: TIMELINE_FRAMES }, (_, i) =>
      Math.min(end, ((i + 0.5) * study.duration) / TIMELINE_FRAMES),
    );
    await grabFrames(
      ffmpeg,
      options.video,
      shotTimes,
      join(options.out, "frames", "shots"),
      controller.signal,
    );
    await grabFrames(
      ffmpeg,
      options.video,
      timeline,
      join(options.out, "frames", "timeline"),
      controller.signal,
    );
    await sheet(
      join(options.out, "frames", "shots"),
      join(options.out, "sheet-shots.jpg"),
      controller.signal,
    );
    await sheet(
      join(options.out, "frames", "timeline"),
      join(options.out, "sheet-timeline.jpg"),
      controller.signal,
    );

    await writeFile(
      join(options.out, "report.json"),
      `${JSON.stringify({ version: 1, video: name, ...study }, null, 2)}\n`,
    );
    await writeFile(join(options.out, "report.md"), studyMarkdown(study, name));
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        out: options.out,
        duration: study.duration,
        stillShare: study.stillShare,
        cuts: study.cuts.length,
        bursts: study.bursts.length,
        shotSpread: study.shots.spread,
        fastShare: study.motion.fastShare,
        elapsedMs: Math.round(performance.now() - started),
      })}\n`,
    );
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
      `Reference study failed: ${error instanceof Error ? error.message : "invalid input"}\n`,
    );
    process.exitCode = 1;
  }
}
