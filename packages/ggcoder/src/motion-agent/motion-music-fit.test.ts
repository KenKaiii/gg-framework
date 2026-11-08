import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMotionBundle } from "../core/skills.js";

const run = promisify(execFile);
const SR = 48000;

async function binPath(script: string): Promise<string> {
  const bundle = await findMotionBundle();
  if (!bundle) throw new Error("motion bundle missing");
  return path.join(bundle.root, "bin", script);
}

/** Run music-fit with the current Node; resolves with exit code and output. */
async function musicFit(args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await run(process.execPath, [await binPath("music-fit.mjs"), ...args]);
    return { code: 0, stdout };
  } catch (error) {
    const e = error as { code?: number; stdout?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "" };
  }
}

interface FitReport {
  duration: number;
  bpm: number;
  barSec: number;
  sourceFirstDownbeat: number;
  land?: { requested: number; sourceDownbeat: number; film: number };
  downbeats: number[];
  edits: { source: [number, number]; film: [number, number] }[];
}

async function readReport(dir: string): Promise<FitReport> {
  return JSON.parse(await fs.readFile(path.join(dir, "music-fit.json"), "utf8")) as FitReport;
}

/** Read a 16-bit PCM wav (as written by music-fit) into a mono float array. */
async function readWav(
  file: string,
): Promise<{ sampleRate: number; frames: number; mono: Float32Array }> {
  const buf = await fs.readFile(file);
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const dataBytes = buf.readUInt32LE(40);
  const frames = dataBytes / (2 * channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += buf.readInt16LE(44 + (i * channels + c) * 2);
    mono[i] = s / channels / 32768;
  }
  return { sampleRate, frames, mono };
}

/** Write a mono 16-bit click track: louder, bass-heavy clicks on every 4th beat. */
async function writeClickTrack(
  file: string,
  bpm: number,
  first: number,
  seconds: number,
): Promise<void> {
  const n = Math.round(seconds * SR);
  const pcm = new Float32Array(n);
  const beat = 60 / bpm;
  for (let k = 0; first + k * beat < seconds - 0.1; k++) {
    const down = k % 4 === 0;
    const start = Math.round((first + k * beat) * SR);
    const len = Math.round(0.06 * SR);
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / SR;
      const env = Math.exp(-t / 0.012);
      const click =
        Math.sin(2 * Math.PI * 2000 * t) * 0.4 +
        Math.sin(2 * Math.PI * 80 * t) * (down ? 0.5 : 0.1);
      pcm[start + i] += click * env * (down ? 1 : 0.45);
    }
  }
  const out = Buffer.alloc(44 + n * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + n * 2, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(SR, 24);
  out.writeUInt32LE(SR * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
  await fs.writeFile(file, out);
}

/** Distance (s) from t to the nearest downbeat of a grid. */
function offGrid(t: number, d0: number, bar: number): number {
  const k = Math.round((t - d0) / bar);
  return Math.abs(t - (d0 + k * bar));
}

const BPM = 110;
const FIRST = 0.3;
const BAR = (60 / BPM) * 4;

let tmp = "";
let clicks = "";
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-motion-music-fit-"));
  clicks = path.join(tmp, "clicks.wav");
  await writeClickTrack(clicks, BPM, FIRST, 24);
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("music-fit", () => {
  it("detects the tempo and downbeat phase of a click track", async () => {
    // Arrange
    const out = path.join(tmp, "out");

    // Act
    const result = await musicFit([clicks, "--duration", "10", "--out", out]);

    // Assert
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
    const report = await readReport(out);
    expect(Math.abs(report.bpm - BPM)).toBeLessThan(1);
    expect(offGrid(report.sourceFirstDownbeat, FIRST, BAR)).toBeLessThan(0.02);
    expect(Math.abs(report.sourceFirstDownbeat - FIRST)).toBeLessThan(0.02);
  });

  it("writes music.wav exactly --duration long", async () => {
    // Arrange
    const out = path.join(tmp, "out");
    const duration = 7.3;

    // Act
    const result = await musicFit([clicks, "--duration", String(duration), "--out", out]);

    // Assert
    expect(result.code).toBe(0);
    const wav = await readWav(path.join(out, "music.wav"));
    expect(wav.sampleRate).toBe(SR);
    expect(Math.abs(wav.frames - duration * SR)).toBeLessThanOrEqual(1);
  });

  it("lands the nearest downbeat on the requested film time", async () => {
    // Arrange: downbeats at 0.3 + k·2.1818; 9.2 snaps to 9.027 (k = 4)
    const out = path.join(tmp, "out");
    const expectedDown = FIRST + 4 * BAR;
    const film = 3;

    // Act
    const result = await musicFit([
      clicks,
      "--duration",
      "12",
      "--land",
      `9.2@${film}`,
      "--out",
      out,
    ]);

    // Assert
    expect(result.code).toBe(0);
    const report = await readReport(out);
    expect(report.land?.film).toBe(film);
    expect(Math.abs((report.land?.sourceDownbeat ?? NaN) - expectedDown)).toBeLessThan(0.02);
    expect(report.downbeats.some((d) => Math.abs(d - film) < 1e-3)).toBe(true);
    const wav = await readWav(path.join(out, "music.wav"));
    const from = Math.round((film - 0.15) * SR);
    const to = Math.round((film + 0.15) * SR);
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(wav.mono[i]));
    let onset = -1;
    for (let i = from; i < to && onset < 0; i++) if (Math.abs(wav.mono[i]) > 0.3 * peak) onset = i;
    expect(peak).toBeGreaterThan(0.2);
    expect(Math.abs(onset / SR - film)).toBeLessThan(0.02);
  });

  it("cuts only on downbeats of the source", async () => {
    // Arrange: long enough to force jumps inside the 24 s track
    const out = path.join(tmp, "out");

    // Act
    const result = await musicFit([clicks, "--duration", "40", "--land", "5@6", "--out", out]);

    // Assert
    expect(result.code).toBe(0);
    const report = await readReport(out);
    expect(report.edits.length).toBeGreaterThan(1);
    const d0 = report.sourceFirstDownbeat;
    for (let i = 0; i < report.edits.length; i++) {
      const e = report.edits[i];
      if (i > 0) {
        expect(offGrid(e.source[0], d0, report.barSec)).toBeLessThan(1e-3);
        expect(offGrid(e.film[0], report.land!.film, report.barSec)).toBeLessThan(1e-3);
      }
      if (i < report.edits.length - 1)
        expect(offGrid(e.source[1], d0, report.barSec)).toBeLessThan(1e-3);
    }
  });

  it("matches the tempo of a bundled track's cue beats", async () => {
    // Arrange
    const bundle = await findMotionBundle();
    const stem = "happy-beats-business-moves-vol-10-by-ende-dot-app";
    const track = path.join(bundle!.root, "assets", "music", `${stem}.mp3`);
    const cues = JSON.parse(
      await fs.readFile(
        path.join(bundle!.root, "assets", "music", "cues", `${stem}.music-cues.json`),
        "utf8",
      ),
    ) as { beats: { time: number }[] };
    const times = cues.beats.map((b) => b.time);
    const xs = times.map((_, i) => i);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = times.reduce((a, b) => a + b, 0) / times.length;
    const slope =
      xs.reduce((s, x, i) => s + (x - mx) * (times[i] - my), 0) /
      xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    const cueBpm = 60 / slope;
    const out = path.join(tmp, "out");

    // Act
    const result = await musicFit([track, "--duration", "4", "--out", out]);

    // Assert
    expect(result.code).toBe(0);
    const report = await readReport(out);
    expect(Math.abs(report.bpm - cueBpm)).toBeLessThan(1);
  }, 20000);

  it.each([
    ["missing file", () => [path.join(tmp, "nope.wav"), "--duration", "5"]],
    ["non-audio file", () => [path.join(tmp, "junk.mp3"), "--duration", "5"]],
    ["missing --duration", () => [clicks]],
    ["--land outside the track", () => [clicks, "--duration", "5", "--land", "99@1"]],
  ])("rejects %s with {ok:false,error}", async (_name, args) => {
    // Arrange
    await fs.writeFile(path.join(tmp, "junk.mp3"), "this is not audio at all\n".repeat(100));

    // Act
    const result = await musicFit([...args(), "--out", path.join(tmp, "out")]);

    // Assert
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.length).toBeGreaterThan(0);
  });

  it("is deterministic", async () => {
    // Arrange
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");

    // Act
    await musicFit([clicks, "--duration", "9", "--land", "7@2", "--out", a]);
    await musicFit([clicks, "--duration", "9", "--land", "7@2", "--out", b]);

    // Assert
    const wa = await fs.readFile(path.join(a, "music.wav"));
    const wb = await fs.readFile(path.join(b, "music.wav"));
    expect(wa.length).toBeGreaterThan(44);
    expect(wa.equals(wb)).toBe(true);
  });
});
