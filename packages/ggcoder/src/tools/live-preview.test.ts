import { describe, expect, it, vi } from "vitest";
import { createLivePreviewTool } from "./live-preview.js";

const run = (tool: ReturnType<typeof createLivePreviewTool>, args: { url?: string }) =>
  tool.execute(args, {} as never);

describe("live_preview tool", () => {
  it("starts the preview and opens it in the browser", async () => {
    const start = vi.fn(async () => ({
      running: true,
      url: "http://localhost:4100/",
      target: "http://localhost:5173/",
    }));
    const open = vi.fn();
    const tool = createLivePreviewTool(start, open);
    const out = await run(tool, { url: " localhost:5173 " });
    expect(start).toHaveBeenCalledWith("localhost:5173");
    expect(open).toHaveBeenCalledWith("http://localhost:4100/");
    expect(out).toContain("http://localhost:4100/");
  });

  it("says how to recover when no dev server runs, and passes errors on", async () => {
    const open = vi.fn();
    const none = createLivePreviewTool(
      async () => ({ running: false, url: null, target: null, needsUrl: true }),
      open,
    );
    expect(await run(none, {})).toContain("run_in_background");
    const https = createLivePreviewTool(
      async () => ({ running: false, url: null, target: null, error: "https isn't supported" }),
      open,
    );
    expect(await run(https, {})).toBe("Error: https isn't supported");
    expect(open).not.toHaveBeenCalled();
  });
});
