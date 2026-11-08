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

type Plan = Readonly<{
  fps: number;
  shutter: number;
  samples: number;
  renderFps: number;
  blended: number;
}>;
type BlurModule = Readonly<{
  blurPlan: (fps: number, shutter?: number, options?: { samples?: number; peak?: number }) => Plan;
  blendFrames: (frames: Buffer[], out: Buffer) => Buffer;
  SRGB_TO_LINEAR: Uint16Array;
  LINEAR_TO_SRGB: Uint8Array;
  MAX_COPY_GAP_PX: number;
  defaultWorkers: (cores?: number) => number;
  STILL_MARGIN: number;
  MIN_STILL_SECONDS: number;
  planSpans: (
    holds: boolean[] | null,
    fps: number,
    frames: number,
  ) => { start: number; end: number; still: boolean }[];
  assembleSpans: (
    segments: { file: string; still: boolean; frames?: number; skip?: number }[],
    audio: string | null,
    output: string,
    plan: Plan,
    quality: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  blendVideo: (
    input: string,
    output: string,
    plan: Plan,
    quality: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  checkFlashing: (
    file: string,
    signal?: AbortSignal,
  ) => Promise<{
    safe: boolean;
    maxFlashesPerSecond: number;
    failures?: { start: number; end: number }[];
  }>;
}>;

let bin = "";
let blur: BlurModule;
let tmp = "";
beforeAll(async () => {
  const bundle = await findMotionBundle();
  if (!bundle) throw new Error("Missing Motion bundle");
  bin = path.join(bundle.root, "bin");
  // A shipped plain-JS script: its exports are typed here by hand.
  blur = (await import(pathToFileURL(path.join(bin, "motion-blur.mjs")).href)) as BlurModule;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-motion-blur-test-"));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("motion blur plan", () => {
  it.each([
    [30, 270, { samples: 4, renderFps: 120, blended: 3 }],
    [30, 180, { samples: 4, renderFps: 120, blended: 2 }],
    [30, 360, { samples: 4, renderFps: 120, blended: 4 }],
    [60, 270, { samples: 4, renderFps: 240, blended: 3 }],
    [24, 270, { samples: 4, renderFps: 96, blended: 3 }],
  ])("renders %i fps at a %i° shutter from enough sub-frames", (fps, shutter, expected) => {
    expect(blur.blurPlan(fps, shutter)).toEqual({ fps, shutter, ...expected });
  });

  it("defaults to a 270° shutter: three of four sub-frames, a 120 fps render at 30 fps", () => {
    expect(blur.blurPlan(30)).toEqual({
      fps: 30,
      shutter: 270,
      samples: 4,
      renderFps: 120,
      blended: 3,
    });
  });

  it("renders more sub-frames for a faster measured move, up to the render-rate cap", () => {
    // Arrange: peaks in px per output frame, slow to very fast.
    const gap = blur.MAX_COPY_GAP_PX;

    // Act
    const slow = blur.blurPlan(30, 270, { peak: 10 });
    const fast = blur.blurPlan(30, 270, { peak: 6 * gap });
    const faster = blur.blurPlan(30, 270, { peak: 7 * gap });
    const extreme = blur.blurPlan(30, 270, { peak: 1000 });
    const capped60 = blur.blurPlan(60, 270, { peak: 1000 });

    // Assert
    expect(slow).toEqual(blur.blurPlan(30));
    expect(fast).toMatchObject({ samples: 6, renderFps: 180, blended: 5 });
    expect(faster.samples).toBeGreaterThan(fast.samples);
    expect(extreme).toMatchObject({ samples: 8, renderFps: 240, blended: 6 });
    expect(capped60).toMatchObject({ samples: 4, renderFps: 240 });
  });

  it("takes an explicit sample count within the render-rate cap", () => {
    expect(blur.blurPlan(30, 270, { samples: 8 })).toMatchObject({ samples: 8, blended: 6 });
    expect(() => blur.blurPlan(30, 270, { samples: 9 })).toThrow(/at most 8 samples/);
    expect(() => blur.blurPlan(30, 270, { samples: 2 })).toThrow(/too few to blur/);
  });

  it("uses most of the machine's cores for the render, leaving room for the rest", () => {
    expect(blur.defaultWorkers(14)).toBe(10);
    expect(blur.defaultWorkers(4)).toBe(2);
    expect(blur.defaultWorkers(64)).toBe(12);
  });

  it("refuses rates and shutters that leave nothing to average", () => {
    expect(() => blur.blurPlan(120)).toThrow(/too few to blur/);
    expect(() => blur.blurPlan(60, 45)).toThrow(/too few to blur/);
    expect(() => blur.blurPlan(30, 0)).toThrow(/--shutter/);
    expect(() => blur.blurPlan(29.97)).toThrow(/--fps/);
  });
});

describe("motion blur still spans", () => {
  const flags = (pattern: string): boolean[] => [...pattern].map((c) => c === "s");

  it("renders everything as one moving span without a draft", () => {
    expect(blur.planSpans(null, 30, 90)).toEqual([{ start: 0, end: 90, still: false }]);
  });

  it("shrinks each still run by its margin and keeps short runs moving", () => {
    // 30 fps: a 1 s hold (30 frames) at 20..50, and a 0.3 s hold at 70..79.
    const holds = flags(
      `${"m".repeat(20)}${"s".repeat(30)}${"m".repeat(20)}${"s".repeat(9)}${"m".repeat(11)}`,
    );

    const spans = blur.planSpans(holds, 30, holds.length);

    const m = blur.STILL_MARGIN;
    expect(spans).toEqual([
      { start: 0, end: 20 + m, still: false },
      { start: 20 + m, end: 50 - m, still: true },
      { start: 50 - m, end: 90, still: false },
    ]);
    // Spans tile the whole film in order, with no gap or overlap.
    expect(spans[0]?.start).toBe(0);
    expect(spans.at(-1)?.end).toBe(90);
    for (let i = 1; i < spans.length; i++) expect(spans[i]?.start).toBe(spans[i - 1]?.end);
  });

  it("assembles still spans as rendered and moving spans blended, in order", async () => {
    const plan = blur.blurPlan(30);
    const clip = async (
      name: string,
      rate: number,
      frames: number,
      color: string,
    ): Promise<string> => {
      const file = path.join(tmp, `${name}.mp4`);
      await exec("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=${color}:size=320x180:rate=${rate}`,
        "-frames:v",
        String(frames),
        "-c:v",
        "libx264",
        "-crf",
        "0",
        "-pix_fmt",
        "yuv444p",
        file,
      ]);
      return file;
    };
    // 10 moving output frames (red, at the render rate), 15 still (blue, at 30 fps), 5 moving (green).
    const segments = [
      {
        file: await clip("span-a", plan.renderFps, 10 * plan.samples, "red"),
        still: false,
        frames: 10,
      },
      { file: await clip("span-b", 30, 15, "blue"), still: true, frames: 15 },
      {
        file: await clip("span-c", plan.renderFps, 5 * plan.samples, "green"),
        still: false,
        frames: 5,
      },
    ];
    const output = path.join(tmp, "assembled.mp4");

    await blur.assembleSpans(segments, null, output, plan, "looks");

    const { stdout } = await exec(
      "ffmpeg",
      ["-v", "error", "-i", output, "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "-"],
      { encoding: "buffer" },
    );
    const colours = [...Array(stdout.length / 3).keys()].map((i) => {
      const [r = 0, g = 0, b = 0] = stdout.subarray(i * 3, i * 3 + 3);
      return r > 150 ? "r" : b > 150 ? "b" : g > 80 ? "g" : "?";
    });
    expect(colours.join("")).toBe(`${"r".repeat(10)}${"b".repeat(15)}${"g".repeat(5)}`);
  }, 60_000);

  it(
    "brings quiet audio up to feed loudness, about -14 LUFS, without peaking over -1 dBTP",
    async () => {
      const plan = blur.blurPlan(30);
      const video = path.join(tmp, "loud-video.mp4");
      const audio = path.join(tmp, "loud-audio.mp4");
      await exec("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=red:size=160x90:rate=${plan.renderFps}`,
        "-frames:v",
        String(90 * plan.samples),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv444p",
        video,
      ]);
      // A soft tone, far below feed loudness (about -38 LUFS).
      await exec("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=4,volume=0.02",
        "-c:a",
        "aac",
        audio,
      ]);
      const output = path.join(tmp, "loud.mp4");

      await blur.assembleSpans(
        [{ file: video, still: false, frames: 90 }],
        audio,
        output,
        plan,
        "looks",
      );

      const { stderr } = await exec("ffmpeg", [
        "-hide_banner",
        "-i",
        output,
        "-af",
        "ebur128=peak=true",
        "-f",
        "null",
        "-",
      ]);
      const summary = stderr.split("Summary:").at(-1) ?? "";
      const loudness = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
      const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]);
      expect(loudness).toBeGreaterThan(-16);
      expect(loudness).toBeLessThan(-12);
      expect(peak).toBeLessThan(-1);
    },
    MEDIA_TEST_MS,
  );
});

describe("motion blur blend", () => {
  /** A clip at the default plan's render rate: a white 40 px bar on black, moving `speed` px per second. */
  async function source(name: string, speed: number): Promise<string> {
    const file = path.join(tmp, `${name}.mp4`);
    const rate = blur.blurPlan(30).renderFps;
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:size=640x360:rate=${rate}:d=1[ground];color=c=white:size=40x200:rate=${rate}:d=1[bar];` +
        `[ground][bar]overlay=x='40+t*${speed}':y=80:shortest=1`,
      "-c:v",
      "libx264",
      "-crf",
      "12",
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
    return file;
  }
  /** Pixels on one row through the bar that are neither ground nor bar: the blur trail. */
  async function trailWidth(file: string, at: number): Promise<number> {
    const { stdout } = await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        String(at),
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        "crop=640:1:0:180,format=gray",
        "-f",
        "rawvideo",
        "-",
      ],
      { encoding: "buffer" },
    );
    return [...stdout].filter((level) => level > 50 && level < 200).length;
  }

  it(
    "averages each frame's sub-frames, leaves still frames sharp and stamps the output",
    async () => {
      const plan = blur.blurPlan(30);
      const moving = path.join(tmp, "moving-blurred.mp4");
      await blur.blendVideo(await source("moving", 960), moving, plan, "looks");
      const still = path.join(tmp, "still-blurred.mp4");
      await blur.blendVideo(await source("still", 0), still, plan, "looks");

      const { stdout } = await exec("ffprobe", [
        "-v",
        "error",
        "-count_frames",
        "-show_entries",
        "stream=avg_frame_rate,nb_read_frames:format_tags=comment",
        "-of",
        "json",
        moving,
      ]);
      const probe = JSON.parse(stdout) as {
        streams: { avg_frame_rate: string; nb_read_frames: string }[];
        format: { tags: { comment: string } };
      };
      expect(probe.streams[0]).toEqual({ avg_frame_rate: "30/1", nb_read_frames: "30" });
      expect(probe.format.tags.comment).toBe("gg-motion-blur samples=3");

      // 960 px/s over three 120 fps sub-frames smears 16 px; a still bar keeps hard edges.
      expect(await trailWidth(moving, 0.5)).toBeGreaterThanOrEqual(12);
      expect(await trailWidth(still, 0.5)).toBeLessThanOrEqual(4);

      const measured = await exec(process.execPath, [
        path.join(bin, "motion-check.mjs"),
        "--flow",
        moving,
      ]);
      // The blur step stamps the file, so the flow measure reads how it was made.
      const flow = JSON.parse(measured.stdout) as { blur?: unknown };
      expect(flow.blur).toEqual({ samples: 3 });
    },
    MEDIA_TEST_MS,
  );

  /** One output frame of a blended clip as RGB24, decoded with the encoder's BT.601 matrix. */
  async function outputFrame(file: string, frame: number, crop: string): Promise<Buffer> {
    const { stdout } = await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-vf",
        `select=eq(n\\,${frame}),crop=${crop},scale=in_color_matrix=bt601:in_range=limited,format=rgb24`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-",
      ],
      { encoding: "buffer" },
    );
    return stdout;
  }
  const srgb = (linear: number) =>
    255 * (linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055);

  it(
    "never blends across a hard cut that falls between one frame's sub-frames",
    async () => {
      // Arrange: scene A for 42 sub-frames at 120 fps, then scene B. Output frame 10 is
      // sub-frames 40-42, so the cut lands inside its blend.
      const plan = blur.blurPlan(30);
      const cut = path.join(tmp, "cut.mp4");
      await exec("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x2050a0:size=320x180:rate=120:d=0.35[a];" +
          "color=c=0xe0c040:size=320x180:rate=120:d=0.65[b];[a][b]concat=n=2:v=1",
        "-c:v",
        "libx264",
        "-crf",
        "12",
        "-pix_fmt",
        "yuv420p",
        cut,
      ]);
      const blurred = path.join(tmp, "cut-blurred.mp4");

      // Act
      await blur.blendVideo(cut, blurred, plan, "looks");

      // Assert: the mean colour of frames 10 and 11 is pure A and pure B.
      const mean = (pixels: Buffer) =>
        [0, 1, 2].map(
          (channel) =>
            pixels.filter((_, index) => index % 3 === channel).reduce((sum, v) => sum + v, 0) /
            (pixels.length / 3),
        );
      const before = mean(await outputFrame(blurred, 10, "160:90:80:45"));
      const after = mean(await outputFrame(blurred, 11, "160:90:80:45"));
      [0x20, 0x50, 0xa0].forEach((level, channel) =>
        expect(Math.abs(before[channel] - level)).toBeLessThanOrEqual(4),
      );
      [0xe0, 0xc0, 0x40].forEach((level, channel) =>
        expect(Math.abs(after[channel] - level)).toBeLessThanOrEqual(4),
      );
    },
    MEDIA_TEST_MS,
  );

  it(
    "averages in linear light: a white bar's streak over black is brighter than a plain mean",
    async () => {
      // Arrange: 960 px/s is 8 px per 120 fps sub-frame. Output frame 15 blends sub-frames
      // 60-62, bar left edges 520, 528 and 536, so x 520-527 is covered by one of three.
      const plan = blur.blurPlan(30);
      const blurred = path.join(tmp, "linear-blurred.mp4");
      const expected = srgb(1 / 3);

      // Act
      await blur.blendVideo(await source("linear", 960), blurred, plan, "looks");
      const row = await outputFrame(blurred, 15, "640:2:0:180");

      // Assert: the one-third streak (x 522-525) and its mirror (x 570-573).
      for (const x of [522, 523, 524, 525, 570, 571, 572, 573]) {
        expect(Math.abs(row[x * 3 + 1] - expected)).toBeLessThanOrEqual(8);
        expect(Math.abs(row[x * 3 + 1] - 255 / 3)).toBeGreaterThan(50);
      }
    },
    MEDIA_TEST_MS,
  );

  it("rejects a source that was not rendered at the plan's rate", async () => {
    const slow = path.join(tmp, "slow.mp4");
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:size=64x64:rate=30:d=0.5",
      "-pix_fmt",
      "yuv420p",
      slow,
    ]);
    await expect(
      blur.blendVideo(slow, path.join(tmp, "never.mp4"), blur.blurPlan(30), "looks"),
    ).rejects.toThrow(/Expected a 120 fps render/);
  });
});

describe("motion blur linear-light blend", () => {
  it("round-trips every 8-bit sRGB code through linear light unchanged", () => {
    const codes = Array.from({ length: 256 }, (_, code) => code);
    expect(codes.map((code) => blur.LINEAR_TO_SRGB[blur.SRGB_TO_LINEAR[code]])).toEqual(codes);
  });

  it("keeps held sub-frames byte-identical, wholly and pixel by pixel", () => {
    // Arrange: a noisy frame held across four sub-frames, and one with a single change.
    const held = Buffer.from(Array.from({ length: 3000 }, (_, index) => (index * 37) % 256));
    const changed = Buffer.from(held);
    changed[0] = 255 - changed[0];

    // Act
    const whole = blur.blendFrames(
      [held, Buffer.from(held), Buffer.from(held)],
      Buffer.alloc(3000),
    );
    const partial = blur.blendFrames([held, held, changed, held], Buffer.alloc(3000));

    // Assert
    expect(whole.equals(held)).toBe(true);
    expect(partial.subarray(1).equals(held.subarray(1))).toBe(true);
  });
});

describe("motion blur flash screen", () => {
  /** Two seconds of the whole frame swapping black and white `hz` times a second. */
  async function strobe(hz: number): Promise<string> {
    const file = path.join(tmp, `strobe-${hz}.mp4`);
    await exec("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:size=160x90:rate=30:d=2,geq=lum='if(lt(mod(T*${hz * 2}\\,2)\\,1)\\,16\\,235)':cb=128:cr=128`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
    return file;
  }

  it(
    "passes a calm render and names the seconds of a strobing one",
    async () => {
      const calm = await blur.checkFlashing(await strobe(1));
      const strobing = await blur.checkFlashing(await strobe(5));

      expect(calm).toEqual({ safe: true, maxFlashesPerSecond: 1 });
      expect(strobing.safe).toBe(false);
      expect(strobing.maxFlashesPerSecond).toBeGreaterThan(3);
      expect(strobing.failures?.[0]?.start).toBeGreaterThanOrEqual(0);
      expect(strobing.failures?.[0]?.end).toBeGreaterThan(strobing.failures?.[0]?.start ?? 0);
    },
    MEDIA_TEST_MS,
  );
});

describe("motion blur command", () => {
  async function failure(args: string[]): Promise<string> {
    try {
      await exec(process.execPath, [path.join(bin, "motion-blur.mjs"), ...args], { cwd: tmp });
    } catch (error) {
      return String((error as { stderr?: string }).stderr);
    }
    throw new Error("Expected the blur step to fail");
  }

  it("refuses before rendering when it would overwrite, change format or take an owned flag", async () => {
    await fs.writeFile(path.join(tmp, "taken.mp4"), "");
    expect(await failure([".", "taken.mp4"])).toMatch(/already exists/);
    expect(await failure([".", "out.mov"])).toMatch(/MP4 only/);
    expect(await failure([".", "out.mp4", "--format", "webm"])).toMatch(/owns --output/);
    expect(await failure([".", "out.mp4", "--quality", "ultra"])).toMatch(/Unknown --quality/);
    expect(await failure([".", "out.mp4", "--fps", "120"])).toMatch(/too few to blur/);
    expect(await failure([])).toMatch(/usage: motion-blur\.mjs/);
    await expect(fs.access(path.join(tmp, "out.mp4"))).rejects.toThrow();
  });
});
