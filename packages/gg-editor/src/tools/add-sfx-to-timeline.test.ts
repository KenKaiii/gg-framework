import { describe, expect, it, vi } from "vitest";
import { createAddSfxToTimelineTool } from "./add-sfx-to-timeline.js";
import type { VideoHost } from "../core/hosts/types.js";

// Mock bundled-sfx so the tool tests don't try to spawn ffmpeg.
vi.mock("../core/bundled-sfx.js", async () => {
  /* eslint-disable @typescript-eslint/consistent-type-imports */
  const actual =
    await vi.importActual<typeof import("../core/bundled-sfx.js")>("../core/bundled-sfx.js");
  /* eslint-enable @typescript-eslint/consistent-type-imports */
  return {
    ...actual,
    resolveSfx: vi.fn(async (name: string) => {
      if (name === "whoosh") {
        return { path: "/cache/whoosh.wav", bundled: true, name: "whoosh" };
      }
      if (name === "/abs/custom.wav") {
        return { path: "/abs/custom.wav", bundled: false };
      }
      throw new Error(`unknown SFX name: '${name}'. Bundled: pop, whoosh`);
    }),
  };
});

const ctx = {
  signal: new AbortController().signal,
  toolCallId: "t1",
} as unknown as Parameters<ReturnType<typeof createAddSfxToTimelineTool>["execute"]>[1];

// Loose mock helpers — we don't import the internal types since some
// (ClipInfo / TimelineState) aren't part of the public type surface.
function mockHost(opts: {
  fps?: number;
  insert?: VideoHost["insertClipOnTrack"];
  getTimelineErr?: Error;
}): VideoHost {
  const defaultInsert: VideoHost["insertClipOnTrack"] = async ({
    recordFrame,
    track,
    mediaKind,
  }) => ({
    id: `clip-${recordFrame}`,
    track: track ?? 3,
    trackKind: (mediaKind ?? "video") as "video" | "audio",
    startFrame: recordFrame,
    endFrame: recordFrame + 9,
    name: "whoosh.wav",
  });
  const insertSpy = opts.insert ?? defaultInsert;
  return {
    name: "resolve",
    capabilities: () =>
      Promise.resolve({
        isAvailable: true,
        canMoveClips: false,
        canScriptColor: true,
        canScriptAudio: false,
        canTriggerAI: false,
        preferredImportFormat: "edl" as const,
      }),
    getTimeline: () => {
      if (opts.getTimelineErr) return Promise.reject(opts.getTimelineErr);
      return Promise.resolve({
        frameRate: opts.fps ?? 30,
        fps: opts.fps ?? 30,
      } as unknown as ReturnType<VideoHost["getTimeline"]> extends Promise<infer T> ? T : never);
    },
    insertClipOnTrack: insertSpy,
  } as unknown as VideoHost;
}

describe("add_sfx_to_timeline", () => {
  it("converts seconds to frames using timeline fps and inserts on the requested audio track", async () => {
    const insert: VideoHost["insertClipOnTrack"] = async ({
      recordFrame,
      track,
      mediaKind,
      mediaPath,
    }) => ({
      id: `c-${recordFrame}`,
      track,
      trackKind: (mediaKind ?? "video") as "video" | "audio",
      startFrame: recordFrame,
      endFrame: recordFrame + 9,
      name: mediaPath.split("/").pop() ?? "x",
    });
    const insertSpy = vi.fn(insert);
    const tool = createAddSfxToTimelineTool(mockHost({ fps: 30, insert: insertSpy }), "/cwd");
    const r = await tool.execute({ sfx: "whoosh", cutPoints: [1, 2, 5.5], track: 3 }, ctx);
    const out = JSON.parse(r as string) as {
      ok: boolean;
      inserted: number;
      track: number;
      fps: number;
      sfx: string;
    };
    expect(out.ok).toBe(true);
    expect(out.inserted).toBe(3);
    expect(out.track).toBe(3);
    expect(out.fps).toBe(30);
    expect(out.sfx).toBe("bundled:whoosh");
    // Verify each insertion went via the audio path with correct frame conversion.
    expect(insertSpy).toHaveBeenCalledTimes(3);
    expect(insertSpy).toHaveBeenNthCalledWith(1, {
      mediaPath: "/cache/whoosh.wav",
      track: 3,
      recordFrame: 30,
      mediaKind: "audio",
    });
    expect(insertSpy).toHaveBeenNthCalledWith(2, {
      mediaPath: "/cache/whoosh.wav",
      track: 3,
      recordFrame: 60,
      mediaKind: "audio",
    });
    expect(insertSpy).toHaveBeenNthCalledWith(3, {
      mediaPath: "/cache/whoosh.wav",
      track: 3,
      recordFrame: 165,
      mediaKind: "audio",
    });
  });

  it("dedupes cuts closer than minSpacingSec", async () => {
    const insert = vi.fn(async () => ({
      id: "c",
      track: 3,
      trackKind: "audio" as const,
      startFrame: 0,
      endFrame: 9,
      name: "w",
    }));
    const tool = createAddSfxToTimelineTool(mockHost({ fps: 30, insert }), "/cwd");
    await tool.execute({ sfx: "whoosh", cutPoints: [1, 1.05, 1.1, 5], minSpacingSec: 0.25 }, ctx);
    expect(insert).toHaveBeenCalledTimes(2); // 1.0 and 5.0 only
  });

  it("uses default track A3 when not specified", async () => {
    const insert = vi.fn(async () => ({
      id: "c",
      track: 3,
      trackKind: "audio" as const,
      startFrame: 0,
      endFrame: 9,
      name: "w",
    }));
    const tool = createAddSfxToTimelineTool(mockHost({ fps: 30, insert }), "/cwd");
    await tool.execute({ sfx: "whoosh", cutPoints: [1] }, ctx);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ track: 3, mediaKind: "audio" }));
  });

  it("fails clean with a host hint when the audio track doesn't exist", async () => {
    const insert: VideoHost["insertClipOnTrack"] = async () => {
      throw new Error("track 7 does not exist on active sequence.");
    };
    const tool = createAddSfxToTimelineTool(mockHost({ fps: 30, insert }), "/cwd");
    const r = await tool.execute({ sfx: "whoosh", cutPoints: [1, 2], track: 7 }, ctx);
    expect(r).toMatch(/^error:/);
    expect(r).toMatch(/add_track\(kind='audio'\)/);
  });

  it("partial-success: some inserts fail, returns ok with failures detail", async () => {
    let n = 0;
    const insert: VideoHost["insertClipOnTrack"] = async ({ recordFrame }) => {
      n++;
      if (n === 2) throw new Error("transient bridge error");
      return {
        id: `c-${recordFrame}`,
        track: 3,
        trackKind: "audio" as const,
        startFrame: recordFrame,
        endFrame: recordFrame + 9,
        name: "w",
      };
    };
    const tool = createAddSfxToTimelineTool(mockHost({ fps: 30, insert }), "/cwd");
    const r = await tool.execute({ sfx: "whoosh", cutPoints: [1, 2, 3] }, ctx);
    const out = JSON.parse(r as string) as { inserted: number; failed?: number };
    expect(out.inserted).toBe(2);
    expect(out.failed).toBe(1);
  });

  it("respects explicit frameRate override", async () => {
    const insert: VideoHost["insertClipOnTrack"] = async ({ recordFrame }) => ({
      id: `c-${recordFrame}`,
      track: 3,
      trackKind: "audio" as const,
      startFrame: recordFrame,
      endFrame: recordFrame + 9,
      name: "w",
    });
    const insertSpy = vi.fn(insert);
    const tool = createAddSfxToTimelineTool(mockHost({ fps: 30, insert: insertSpy }), "/cwd");
    await tool.execute({ sfx: "whoosh", cutPoints: [1], frameRate: 60 }, ctx);
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ recordFrame: 60 }));
  });

  it("propagates unknown SFX name errors with the bundled list in the hint", async () => {
    const tool = createAddSfxToTimelineTool(mockHost({ fps: 30 }), "/cwd");
    const r = await tool.execute({ sfx: "notarealsfx", cutPoints: [1] }, ctx);
    expect(r).toMatch(/error: unknown SFX name/);
    expect(r).toMatch(/Bundled:.*whoosh/);
  });

  it("rejects when the host can't report a frame rate", async () => {
    const tool = createAddSfxToTimelineTool(
      mockHost({ getTimelineErr: new Error("host=none") }),
      "/cwd",
    );
    const r = await tool.execute({ sfx: "whoosh", cutPoints: [1] }, ctx);
    expect(r).toMatch(/cannot read timeline framerate/);
    expect(r).toMatch(/frameRate=/);
  });
});
