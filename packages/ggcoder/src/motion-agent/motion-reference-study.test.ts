import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findMotionBundle } from "../core/skills.js";

const exec = promisify(execFile);
// Real FFmpeg encodes; the Windows CI runner can be slow to start processes.
const MEDIA_TEST_MS = 60_000;

type Flow = {
  duration: number;
  fps: number;
  cuts: number[];
  fast: { start: number; end: number; peak: number }[];
};
type Study = {
  duration: number;
  stillShare: number;
  rests: { start: number; end: number }[];
  longestRest: number;
  cuts: number[];
  cutsPerMinute: number;
  bursts: { start: number; end: number; cuts: number }[];
  shots: {
    count: number;
    lengths: number[];
    median: number;
    shortest: number;
    longest: number;
    spread: number;
  };
  motion: { fastShare: number; fastMoves: number; peak: number; typical: number; busy: number };
};
/** The shipped plain-JS study's exports, typed here by hand. */
type StudyModule = Readonly<{
  studyFlow: (flow: Flow, steps: { energy: number[]; changed: number[] }) => Study;
  studyMarkdown: (study: Study, name: string) => string;
  STILL_SHARE: number;
}>;

let bin = "";
let study: StudyModule;
let tmp = "";
beforeAll(async () => {
  const bundle = await findMotionBundle();
  if (!bundle) throw new Error("Missing Motion bundle");
  bin = path.join(bundle.root, "bin");
  study = (await import(pathToFileURL(path.join(bin, "reference-study.mjs")).href)) as StudyModule;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-motion-reference-test-"));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Per-step figures for `seconds` at 10 fps, still where `isStill(t)` holds. */
function steps(seconds: number, isStill: (t: number) => boolean) {
  const energy = [0];
  const changed = [0];
  for (let i = 1; i <= seconds * 10; i++) {
    const still = isStill(i / 10);
    energy.push(still ? 0 : 0.01);
    changed.push(still ? 0 : 0.05);
  }
  return { energy, changed };
}

describe("reference study figures", () => {
  it("reads an even slideshow as metronomic, with no bursts", () => {
    const result = study.studyFlow(
      { duration: 8, fps: 10, cuts: [2, 4, 6], fast: [] },
      steps(8, () => false),
    );

    expect(result.shots).toMatchObject({ count: 4, lengths: [2, 2, 2, 2], spread: 0 });
    expect(result.cutsPerMinute).toBe(22.5);
    expect(result.bursts).toEqual([]);
    expect(result.stillShare).toBe(0);
    expect(result.rests).toEqual([]);
  });

  it("groups close cuts into a burst and finds rests and fast moves", () => {
    const result = study.studyFlow(
      {
        duration: 10,
        fps: 10,
        cuts: [1, 6, 6.3, 6.6, 6.8, 9],
        fast: [{ start: 2, end: 3, peak: 0.05 }],
      },
      // Still for the first two seconds and from 7.5 to 8.7 s.
      steps(10, (t) => t <= 2 || (t > 7.5 && t <= 8.7)),
    );

    expect(result.bursts).toEqual([{ start: 6, end: 6.8, cuts: 4 }]);
    expect(result.rests).toEqual([
      { start: 0, end: 2 },
      { start: 7.5, end: 8.7 },
    ]);
    expect(result.longestRest).toBe(2);
    expect(result.stillShare).toBeCloseTo(0.32, 2);
    expect(result.shots.shortest).toBe(0.2);
    expect(result.shots.longest).toBe(5);
    expect(result.shots.spread).toBeGreaterThan(0.5);
    expect(result.motion).toMatchObject({ fastShare: 0.1, fastMoves: 1, peak: 0.05 });
  });

  it("does not call a small visible change still, however little it moves the average", () => {
    const result = study.studyFlow(
      { duration: 2, fps: 10, cuts: [], fast: [] },
      // A cursor-sized change: almost nothing on average, but visibly there.
      {
        energy: Array.from({ length: 21 }, () => 0.0001),
        changed: Array.from({ length: 21 }, () => study.STILL_SHARE * 4),
      },
    );
    expect(result.stillShare).toBe(0);
  });

  it("writes a plain report with every figure", () => {
    const result = study.studyFlow(
      { duration: 10, fps: 10, cuts: [1, 6, 6.3, 6.6, 6.8, 9], fast: [] },
      steps(10, (t) => t <= 2),
    );
    const text = study.studyMarkdown(result, "example.mp4");

    expect(text).toContain("# Reference study: example.mp4");
    expect(text).toContain("| Hard cuts | 6 (36 a minute) |");
    expect(text).toContain("4 cuts 6.00 s–6.80 s");
    expect(text).toContain("- 0.00 s–2.00 s");
    expect(text).not.toMatch(/NaN|undefined/);
  });

  it("rejects figures that don't fit the measurement", () => {
    expect(() =>
      study.studyFlow(
        { duration: 1, fps: 10, cuts: [], fast: [] },
        { energy: [0, 0], changed: [0] },
      ),
    ).toThrow("every step");
    expect(() =>
      study.studyFlow(
        { duration: 0, fps: 10, cuts: [], fast: [] },
        steps(0, () => true),
      ),
    ).toThrow("duration");
  });
});

describe("reference study on a rendered fixture", () => {
  it(
    "measures a real video and writes the report, sheets and frames",
    async () => {
      const size = "size=320x180:rate=24";
      const video = path.join(tmp, "reference.mp4");
      // A 1.5 s still card, a slow move, a burst of 0.25 s shots, then a still ending.
      await exec("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-filter_complex",
        `smptehdbars=${size}:d=1.5[a];` +
          `color=c=gray:${size}:d=1[g];smptebars=size=64x64:rate=24:d=1[card];` +
          `[g][card]overlay=x='8+t*40':y=58:shortest=1[b];` +
          `pal75bars=${size}:d=0.25[c];color=c=white:${size}:d=0.25[d];` +
          `rgbtestsrc=${size}:d=0.25[e];smptebars=${size}:d=1[f];` +
          `[a][b][c][d][e][f]concat=n=6:v=1:a=0`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        video,
      ]);
      const out = path.join(tmp, "study");

      const { stdout } = await exec(process.execPath, [
        path.join(bin, "reference-study.mjs"),
        video,
        "--out",
        out,
      ]);

      expect(JSON.parse(stdout)).toMatchObject({ ok: true, cuts: 5, bursts: 1 });
      const report = JSON.parse(
        await fs.readFile(path.join(out, "report.json"), "utf8"),
      ) as Study & {
        version: number;
        video: string;
      };
      expect(report).toMatchObject({ version: 1, video: "reference.mp4" });
      expect(report.cuts).toEqual([1.5, 2.5, 2.75, 3, 3.25]);
      expect(report.bursts).toEqual([{ start: 2.5, end: 3.25, cuts: 4 }]);
      expect(report.rests[0]?.start).toBe(0);
      expect(report.rests[0]?.end).toBeGreaterThan(1.3);
      // Still: the opening card, the three static burst cards and the ending, about 3.25 of
      // 4.25 s. The card's move is not still, and no rest falls inside it.
      expect(report.stillShare).toBeGreaterThan(0.7);
      expect(report.stillShare).toBeLessThan(0.82);
      expect(report.rests.some((rest) => rest.end > 1.7 && rest.start < 2.3)).toBe(false);
      for (const file of ["report.md", "sheet-shots.jpg", "sheet-timeline.jpg"]) {
        expect((await fs.stat(path.join(out, file))).size, file).toBeGreaterThan(0);
      }
      expect(await fs.readdir(path.join(out, "frames", "shots"))).toHaveLength(6);
      expect(await fs.readdir(path.join(out, "frames", "timeline"))).toHaveLength(16);
    },
    MEDIA_TEST_MS,
  );

  it("refuses a missing video with a plain message", async () => {
    await expect(
      exec(process.execPath, [path.join(bin, "reference-study.mjs"), path.join(tmp, "nope.mp4")]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Expected a local video file") });
  });
});
