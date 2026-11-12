import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMotionBundle } from "../core/skills.js";
import { missingSystemTools } from "../test-support/system-tools.js";

const run = promisify(execFile);
let tmp = "";
let helper = "";
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-review-"));
  const bundle = await findMotionBundle();
  if (!bundle) throw new Error("Motion bundle missing");
  helper = path.join(bundle.root, "bin", "review-frames.mjs");
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});
async function clip(): Promise<string> {
  const video = path.join(tmp, "clip.mp4");
  await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      video,
    ],
    { timeout: 15_000 },
  );
  return video;
}
async function extract(
  video: string,
  windows: unknown,
  out = "evidence",
  signal?: AbortSignal,
): Promise<string> {
  const config = path.join(tmp, `windows-${out.replace(/\W/g, "")}.json`);
  await fs.writeFile(config, JSON.stringify(windows));
  const result = await run(process.execPath, [helper, video, path.join(tmp, out), config], {
    timeout: 30_000,
    signal,
  });
  return result.stdout;
}
const noMedia = missingSystemTools("motion-review-frames.test.ts", "ffmpeg", "ffprobe");

describe.skipIf(noMedia)("review-frames real media evidence", () => {
  it("extracts the actual early red and late blue pixels at labeled times", async () => {
    const video = path.join(tmp, "colors.mp4");
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=red:size=320x180:rate=24:duration=1",
        "-f",
        "lavfi",
        "-i",
        "color=blue:size=320x180:rate=24:duration=1",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[out]",
        "-map",
        "[out]",
        "-c:v",
        "libx264",
        video,
      ],
      { timeout: 15_000 },
    );
    await extract(video, [
      { label: "red", start: 0, end: 3 / 24 },
      { label: "blue", start: 1, end: 1.5 },
    ]);
    const manifest = JSON.parse(
      await fs.readFile(path.join(tmp, "evidence", "manifest.json"), "utf8"),
    );
    expect(manifest.pages[2].times).toEqual([0, 1 / 24, 2 / 24]);
    for (const [file, channel] of [
      ["02-action.jpg", 0],
      ["03-action.jpg", 2],
    ] as const) {
      const result = await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          path.join(tmp, "evidence", file),
          "-vf",
          "crop=2:2:10:10",
          "-frames:v",
          "1",
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { encoding: "buffer", timeout: 15_000 },
      );
      expect(result.stdout[channel]).toBeGreaterThan(230);
      expect(result.stdout[channel === 0 ? 2 : 0]).toBeLessThan(20);
    }
  }, 30_000);
  it("binds consecutive action, overview and phone images to the rendered video", async () => {
    const video = await clip();
    await extract(video, [{ label: "handoff", start: 0.5, end: 1 }]);
    const manifest = JSON.parse(
      await fs.readFile(path.join(tmp, "evidence", "manifest.json"), "utf8"),
    );
    expect(manifest.version).toBe(1);
    expect(manifest.video.sha256).toBe(
      createHash("sha256")
        .update(await fs.readFile(video))
        .digest("hex"),
    );
    expect(manifest.video.duration).toBeCloseTo(2, 1);
    expect(manifest.pages.map((p: { kind: string }) => p.kind)).toEqual([
      "overview",
      "phone",
      "action",
    ]);
    const action = manifest.pages[2];
    expect(action.times[0]).toBe(0.5);
    expect(action.times[1] - action.times[0]).toBeCloseTo(1 / 24, 5);
    for (const page of manifest.pages) {
      expect(page.width).toBeLessThanOrEqual(1600);
      expect(page.height).toBeLessThanOrEqual(1600);
      expect((await fs.stat(path.join(tmp, "evidence", page.file))).size).toBeGreaterThan(100);
    }
  }, 30_000);
  it("covers every supplied window instead of silently truncating a page", async () => {
    await extract(await clip(), [
      { label: "first", start: 0, end: 0.3 },
      { label: "last", start: 1.5, end: 1.9 },
    ]);
    const manifest = JSON.parse(
      await fs.readFile(path.join(tmp, "evidence", "manifest.json"), "utf8"),
    );
    expect(
      manifest.pages
        .filter((p: { kind: string }) => p.kind === "action")
        .map((p: { label: string }) => p.label),
    ).toEqual(["first", "last"]);
  }, 30_000);
  it("rejects overwrite and output escape", async () => {
    const video = await clip();
    await fs.mkdir(path.join(tmp, "existing"));
    await expect(extract(video, [{ label: "a", start: 0, end: 1 }], "existing")).rejects.toThrow();
    await expect(extract(video, [{ label: "a", start: 0, end: 1 }], "../escape")).rejects.toThrow();
  });
  it.each([
    [],
    [{ label: "bad", start: -1, end: 1 }],
    [{ label: "bad", start: 0, end: 4 }],
    Array.from({ length: 13 }, () => ({ label: "too many", start: 0, end: 1 })),
  ])("rejects invalid or excessive windows (%#)", async (windows) => {
    await expect(extract(await clip(), windows)).rejects.toThrow();
    await expect(fs.stat(path.join(tmp, "evidence"))).rejects.toThrow();
  });
  it("rejects missing and truncated media without leaving evidence", async () => {
    await expect(
      extract(path.join(tmp, "missing.mp4"), [{ label: "a", start: 0, end: 1 }]),
    ).rejects.toThrow();
    await fs.writeFile(path.join(tmp, "bad.mp4"), "truncated");
    await expect(
      extract(path.join(tmp, "bad.mp4"), [{ label: "a", start: 0, end: 1 }]),
    ).rejects.toThrow();
    await expect(fs.stat(path.join(tmp, "evidence"))).rejects.toThrow();
  });
  it("rejects symlink escapes and cleans up cancellation during extraction", async () => {
    const video = await clip();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gg-review-outside-"));
    try {
      await fs.symlink(
        outside,
        path.join(tmp, "link"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(
        extract(video, [{ label: "a", start: 0, end: 1 }], "link/escape"),
      ).rejects.toThrow();
      const script = `
        import { pathToFileURL } from 'node:url';
        import { stat } from 'node:fs/promises';
        const { reviewFrames } = await import(pathToFileURL(process.argv[1]).href);
        const c = new AbortController();
        const timer = setInterval(async () => { if (await stat(process.argv[3]).catch(() => null)) c.abort(); }, 10);
        try { await reviewFrames(process.argv[2], process.argv[3], [{ label: 'a', start: 0, end: 1 }], c.signal); }
        finally { clearInterval(timer); }
      `;
      await expect(
        run(
          process.execPath,
          ["--input-type=module", "-e", script, helper, video, path.join(tmp, "cancelled")],
          { timeout: 15_000 },
        ),
      ).rejects.toThrow();
      await expect(fs.stat(path.join(tmp, "cancelled"))).rejects.toThrow();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
  it("honors cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      extract(await clip(), [{ label: "a", start: 0, end: 1 }], "evidence", controller.signal),
    ).rejects.toThrow();
  });
});
