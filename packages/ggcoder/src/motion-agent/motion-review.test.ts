import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { motionPath, motionSourceHash, readMotionText } from "./motion-review.js";

let tmp = "";
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "motion-state-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});
describe("Motion artifact/source identity", () => {
  it("invalidates source and media edits, additions and deletions while ignoring QA output", async () => {
    await fs.writeFile(path.join(tmp, "index.html"), "first");
    const output = path.join(tmp, "video.mp4");
    const original = await motionSourceHash(tmp, output);
    await fs.mkdir(path.join(tmp, "qa"));
    await fs.writeFile(path.join(tmp, "qa", "report.json"), "report");
    await fs.writeFile(output, "render");
    expect(await motionSourceHash(tmp, output)).toBe(original);
    await fs.writeFile(path.join(tmp, "index.html"), "second");
    const changed = await motionSourceHash(tmp, output);
    expect(changed).not.toBe(original);
    await fs.writeFile(path.join(tmp, "audio.wav"), "audio");
    expect(await motionSourceHash(tmp, output)).not.toBe(changed);
    await fs.unlink(path.join(tmp, "audio.wav"));
    expect(await motionSourceHash(tmp, output)).toBe(changed);
  });
  it("ignores only the files it is told the composition never reads", async () => {
    await fs.writeFile(path.join(tmp, "index.html"), "first");
    await fs.writeFile(path.join(tmp, "holds.json"), "[]");
    const output = path.join(tmp, "video.mp4");
    const holds = path.join(tmp, "holds.json");
    const original = await motionSourceHash(tmp, output, undefined, [holds]);
    await fs.writeFile(holds, '[{"start":9,"end":10}]');
    expect(await motionSourceHash(tmp, output, undefined, [holds])).toBe(original);
    expect(await motionSourceHash(tmp, output)).not.toBe(original);
    await fs.writeFile(path.join(tmp, "index.html"), "second");
    expect(await motionSourceHash(tmp, output, undefined, [holds])).not.toBe(original);
  });
  it("accepts a full path through a linked folder, the way the workspace was named", async () => {
    // macOS /tmp is a link to /private/tmp: a workspace named through a link must accept
    // full paths spelled the same way, not only relative ones.
    const real = path.join(tmp, "real");
    await fs.mkdir(path.join(real, "proj"), { recursive: true });
    await fs.writeFile(path.join(real, "proj", "video.mp4"), "render");
    const linked = path.join(tmp, "linked");
    await fs.symlink(real, linked, process.platform === "win32" ? "junction" : "dir");
    const file = await fs.realpath(path.join(real, "proj", "video.mp4"));

    expect(await motionPath(linked, path.join(linked, "proj", "video.mp4"))).toBe(file);
    expect(await motionPath(linked, "proj/video.mp4")).toBe(file);
    expect(await motionPath(linked, file)).toBe(file);
  });
  it("still rejects a full path outside the workspace, through a link or not", async () => {
    const workspace = path.join(tmp, "workspace");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(tmp, "secret.txt"), "x");
    const linked = path.join(tmp, "linked-workspace");
    await fs.symlink(workspace, linked, process.platform === "win32" ? "junction" : "dir");

    await expect(motionPath(linked, path.join(tmp, "secret.txt"))).rejects.toThrow("escapes");
    await expect(motionPath(linked, path.join(linked, "..", "secret.txt"))).rejects.toThrow(
      "escapes",
    );
  });
  it("rejects path escapes and oversized brief data", async () => {
    await expect(motionPath(tmp, "../")).rejects.toThrow("escapes");
    await fs.writeFile(path.join(tmp, "frame.md"), "x".repeat(100));
    await expect(readMotionText(tmp, "frame.md", 50)).rejects.toThrow("limit");
  });
  it("does not fingerprint symlinked external data", async () => {
    await fs.symlink(
      os.tmpdir(),
      path.join(tmp, "outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(motionSourceHash(tmp, path.join(tmp, "out.mp4"))).rejects.toThrow("symlinks");
  });
  it("cancels source hashing", async () => {
    const c = new AbortController();
    c.abort();
    await expect(motionSourceHash(tmp, path.join(tmp, "out.mp4"), c.signal)).rejects.toThrow();
  });
});
