import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findMotionBundle } from "../core/skills.js";
import { MotionReviewSession } from "./motion-review-session.js";
import type { CompletionReviewRequest } from "../core/completion-review.js";

const exec = promisify(execFile);
// Media tests spawn real FFmpeg, ffprobe and Node processes. On the Windows CI runner a
// cold start has stretched a ~7 s test to 27.5 s, so give real headroom.
const MEDIA_TEST_MS = 60_000;
let tmp = "";
let session: MotionReviewSession;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-motion-review-session-"));
  const bundle = await findMotionBundle();
  if (!bundle) throw new Error("Missing bundle");
  // Only the HyperFrames check boundary is substituted. Extraction, hashes,
  // full pixel decode, audio detection and image attachments use real files.
  const launcher = path.join(tmp, "check.cjs");
  await fs.writeFile(
    launcher,
    `process.stdout.write(JSON.stringify(${JSON.stringify({ ok: true, lint: { filesScanned: 1, errorCount: 0 }, runtime: { errorCount: 0 }, layout: { samples: [0, 1], errorCount: 0 }, contrast: { enabled: true, samples: [0, 1], errorCount: 0 } })}))`,
  );
  session = new MotionReviewSession(tmp, { ...bundle, launcher });
  session.begin("Explain an orbit");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});
async function prepare(
  range?: { start: number; end: number },
  slideshow?: "declared" | "undeclared",
  options: { withoutPath?: boolean; audio?: boolean } = {},
): Promise<string> {
  await fs.writeFile(
    path.join(tmp, "frame.md"),
    "A dot travels around a ring, then hands attention to the centre. Intentionally silent.",
  );
  await fs.writeFile(path.join(tmp, "index.html"), "<canvas></canvas>");
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    slideshow
      ? "color=red:size=320x180:rate=24:duration=2"
      : "testsrc2=size=320x180:rate=24:duration=2",
    ...(options.audio
      ? [
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000:duration=2",
          "-af",
          "loudnorm=I=-14:TP=-1:LRA=11",
        ]
      : []),
    "-c:v",
    "libx264",
    path.join(tmp, "video.mp4"),
  ]);
  if (options.withoutPath) {
    const located = await exec(process.platform === "win32" ? "where.exe" : "which", ["ffmpeg"]);
    const binary = located.stdout.trim().split(/\r?\n/)[0];
    if (!binary || !path.isAbsolute(binary)) throw new Error("Expected an installed FFmpeg path");
    vi.stubEnv("HYPERFRAMES_FFMPEG_PATH", binary);
    vi.stubEnv("PATH", "");
  }
  const result = await session.tool().execute(
    {
      action: "prepare",
      production: {
        project: ".",
        output: "video.mp4",
        depth: range ? "production" : "standard",
        range,
        ...(slideshow === "declared" ? { slideshowRequested: true } : {}),
        references: [],
        windows: [{ label: "orbit", start: 0.5, end: 1 }],
      },
    },
    { signal: new AbortController().signal, toolCallId: "prepare" },
  );
  return String(result);
}
const response = {
  text: '{"status":"ready","findings":[]}',
  model: "test-active",
  provider: "test",
  thinking: undefined,
};
describe("Motion review session", { timeout: MEDIA_TEST_MS }, () => {
  it.each([false, true])(
    "uses the configured FFmpeg and sibling ffprobe without PATH (audio=%s)",
    async (audio) => {
      expect(await prepare(undefined, undefined, { withoutPath: true, audio })).toContain(
        '"technical":true',
      );
      expect(await session.followUp(async () => response)).toBeNull();
      expect(session.gate.status).toBe("ready");
    },
  );
  it.each(["declared", "undeclared"] as const)(
    "preserves the existing explicit slideshow exception (%s)",
    async (mode) => {
      expect(JSON.parse(await prepare(undefined, mode)).technical).toBe(mode === "declared");
    },
  );
  it("catches unregistered writes and shell work but leaves discussion and video reads alone", async () => {
    const reviewer = vi.fn(async () => response);
    await session.track({
      type: "tool_call_start",
      name: "read",
      toolCallId: "read",
      args: { file_path: "old.mp4" },
    });
    expect(await session.followUp(reviewer)).toBeNull();
    await session.track({
      type: "tool_call_start",
      name: "write",
      toolCallId: "write",
      args: { file_path: "index.html" },
    });
    expect(session.armed).toBe(true);
    expect(await session.followUp(reviewer)).toContain("motion_review");
    session.begin("shell-only build");
    await session.track({
      type: "tool_call_start",
      name: "bash",
      toolCallId: "bash",
      args: { command: "node make-video.mjs" },
    });
    expect(await session.followUp(reviewer)).toContain("no_delivery");
    expect(reviewer).not.toHaveBeenCalled();
  });
  it("counts a multi-file edit as work when any target is a work file", async () => {
    await session.track({
      type: "tool_call_start",
      name: "edit",
      toolCallId: "multi-edit",
      args: {
        files: [
          { file_path: "qa/notes.md", edits: [] },
          { file_path: "index.html", edits: [] },
        ],
      },
    });
    expect(session.armed).toBe(true);
  });
  it("attaches actual rendered images, reviews once, stores provenance and invalidates edits", async () => {
    expect(await prepare()).toContain('"technical":true');
    const reviewer = vi.fn(async (request: CompletionReviewRequest) => {
      expect(request.images).toHaveLength(3);
      for (const image of request.images)
        expect(Buffer.from(image.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
      expect(request.context).toContain("A dot travels");
      return response;
    });
    expect(await session.followUp(reviewer)).toBeNull();
    expect(session.gate.status).toBe("ready");
    expect(await session.followUp(reviewer)).toBeNull();
    expect(reviewer).toHaveBeenCalledTimes(1);
    const qa = path.join(tmp, "qa");
    const dir = (await fs.readdir(qa)).find((name) => name.startsWith("review-"));
    expect(dir).toBeDefined();
    const reports = await fs.readdir(path.join(qa, dir ?? ""));
    const report = reports.find((name) => name.startsWith("review-") && name.endsWith(".json"));
    expect(await fs.readFile(path.join(qa, dir ?? "", report ?? ""), "utf8")).toContain(
      "test-active",
    );
    await fs.writeFile(path.join(tmp, "index.html"), "changed");
    expect(await session.followUp(reviewer)).toContain("changed");
    expect(session.gate.status).toBe("unverified");
  });
  it("does not mistake a final shell check for changed source after explicit submission", async () => {
    await prepare();
    await session.track({
      type: "tool_call_start",
      toolCallId: "probe",
      name: "bash",
      args: { command: "ffprobe video.mp4 && test -f video.mp4" },
    });
    await session
      .tool()
      .execute(
        { action: "submit" },
        { signal: new AbortController().signal, toolCallId: "submit" },
      );
    const reviewer = vi.fn(async () => response);
    expect(await session.followUp(reviewer)).toBeNull();
    expect(session.gate.status).toBe("ready");
    expect(reviewer).toHaveBeenCalledTimes(1);
    await session.track({
      type: "tool_call_start",
      toolCallId: "mutate",
      name: "bash",
      args: { command: "node change-source.mjs" },
    });
    await fs.writeFile(path.join(tmp, "index.html"), "changed by shell");
    await session
      .tool()
      .execute(
        { action: "submit" },
        { signal: new AbortController().signal, toolCallId: "submit-again" },
      );
    expect(await session.followUp(reviewer)).toContain("changed");
    expect(session.gate.status).not.toBe("ready");
    expect(reviewer).toHaveBeenCalledTimes(1);
  });
  it("cannot approve unmeasured technical checks even with a ready creative verdict", async () => {
    await fs.writeFile(path.join(tmp, "check.cjs"), 'process.stdout.write("{}")');
    expect(await prepare()).toContain('"technical":false');
    expect(await session.followUp(async () => response)).toContain("unverified");
    expect(session.gate.status).toBe("unverified");
  });
  it("does not approve malformed output or repeatedly review unchanged failed evidence", async () => {
    await prepare();
    const reviewer = vi.fn(async () => ({ ...response, text: "10/10 excellent" }));
    expect(await session.followUp(reviewer)).toContain("unverified");
    await session.followUp(reviewer);
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(session.gate.status).toBe("unverified");
  });
  it("requires real evidence for every chapter of the same artifact", async () => {
    expect(await prepare({ start: 0, end: 1 })).toContain('"technical":true');
    const reviewer = vi.fn(async () => response);
    expect(await session.followUp(reviewer)).toContain("whole 2s artifact is NOT ready");
    expect(session.gate.status).not.toBe("ready");
    await session.tool().execute(
      {
        action: "prepare",
        production: {
          project: ".",
          output: "video.mp4",
          depth: "production",
          references: [],
          range: { start: 1, end: 2 },
          windows: [{ label: "resolve", start: 1, end: 1.5 }],
        },
      },
      { signal: new AbortController().signal, toolCallId: "second" },
    );
    expect(await session.followUp(reviewer)).toBeNull();
    expect(session.gate.status).toBe("ready");
    expect(reviewer).toHaveBeenCalledTimes(2);
  });
  it("rejects evidence changed after preparation", async () => {
    const result = JSON.parse(await prepare());
    const manifest = path.join(result.directory, "manifest.json");
    const data = JSON.parse(await fs.readFile(manifest, "utf8"));
    data.pages[0].label = "tampered";
    await fs.writeFile(manifest, JSON.stringify(data));
    const reviewer = vi.fn(async () => response);
    expect(await session.followUp(reviewer)).toContain("manifest changed");
    expect(reviewer).not.toHaveBeenCalled();
    expect(session.gate.status).not.toBe("ready");
  });
  it("passes cancellation to the fresh review and never records approval", async () => {
    await prepare();
    const controller = new AbortController();
    await session.followUp(async (_request, signal) => {
      controller.abort();
      expect(signal.aborted).toBe(true);
      signal.throwIfAborted();
      return response;
    }, controller.signal);
    expect(session.gate.status).not.toBe("ready");
  });
  it("restores only validated registration, never a disk-authored approval", async () => {
    await prepare();
    const saved = session.snapshot();
    session.restore(saved);
    session.begin("continue");
    expect(session.gate.status).toBe("unverified");
    expect(await session.followUp(async () => response)).toBeNull();
    session.restore({ version: 1, registration: {}, ready: true });
    expect(session.snapshot()).toEqual({ version: 1, registration: null });
  });
});
