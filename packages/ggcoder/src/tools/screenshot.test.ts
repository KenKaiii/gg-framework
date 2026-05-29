import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { StructuredToolResult, ToolContext } from "@kenkaiiii/gg-agent";

// A real, decodable 1×1 PNG so sharp (shrinkToFit / downscaleForPreview) works.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function ctx(signal?: AbortSignal): ToolContext {
  return { signal: signal ?? new AbortController().signal, toolCallId: "test" };
}

function isStructured(result: string | StructuredToolResult): result is StructuredToolResult {
  return typeof result !== "string";
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "ggcoder-screenshot-"));
});

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("playwright");
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("screenshot tool param schema", () => {
  it("requires url and accepts optional actions/viewport", async () => {
    const { createScreenshotTool } = await import("./screenshot.js");
    const schema = createScreenshotTool(tmpDir).parameters;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ url: "http://localhost:3000" }).success).toBe(true);
    expect(
      schema.safeParse({
        url: "http://localhost:3000",
        viewport: { width: 800, height: 600 },
        full_page: true,
        actions: [
          { type: "click", selector: "#go" },
          { type: "wait", ms: 100 },
        ],
      }).success,
    ).toBe(true);
    // Bad action type is rejected.
    expect(schema.safeParse({ url: "x", actions: [{ type: "scroll" }] }).success).toBe(false);
  });
});

describe("screenshot tool with mocked engine", () => {
  it("returns one text and one image block and closes the browser", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const page = {
      setViewportSize: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(TINY_PNG),
    };
    const browser = { newPage: vi.fn().mockResolvedValue(page), close };
    const launch = vi.fn().mockResolvedValue(browser);
    vi.doMock("playwright", () => ({ chromium: { launch } }));

    const { createScreenshotTool } = await import("./screenshot.js");
    const tool = createScreenshotTool(tmpDir);
    const result = await tool.execute({ url: "http://localhost:3000" }, ctx());

    expect(isStructured(result)).toBe(true);
    if (!isStructured(result)) return;
    const blocks = result.content;
    expect(Array.isArray(blocks)).toBe(true);
    if (!Array.isArray(blocks)) return;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "text" });
    expect((blocks[0] as { text: string }).text).toContain("http://localhost:3000");
    expect(blocks[1]).toMatchObject({ type: "image", mediaType: "image/png" });
    expect(typeof (blocks[1] as { data: string }).data).toBe("string");
    expect(close).toHaveBeenCalled();
    expect(launch).toHaveBeenCalledWith({ headless: true });
  });

  it("runs click/type/wait actions before capturing", async () => {
    const click = vi.fn().mockResolvedValue(undefined);
    const fill = vi.fn().mockResolvedValue(undefined);
    const waitForTimeout = vi.fn().mockResolvedValue(undefined);
    const page = {
      setViewportSize: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      click,
      fill,
      waitForTimeout,
      screenshot: vi.fn().mockResolvedValue(TINY_PNG),
    };
    const browser = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.doMock("playwright", () => ({ chromium: { launch: vi.fn().mockResolvedValue(browser) } }));

    const { createScreenshotTool } = await import("./screenshot.js");
    const tool = createScreenshotTool(tmpDir);
    await tool.execute(
      {
        url: "http://localhost:3000",
        actions: [
          { type: "click", selector: "#open" },
          { type: "type", selector: "#name", text: "hi" },
          { type: "wait", ms: 50 },
        ],
      },
      ctx(),
    );

    expect(click).toHaveBeenCalledWith("#open");
    expect(fill).toHaveBeenCalledWith("#name", "hi");
    expect(waitForTimeout).toHaveBeenCalledWith(50);
  });
});

describe("screenshot tool graceful degradation", () => {
  it("returns the install hint when the engine is missing", async () => {
    vi.doMock("playwright", () => {
      const err = new Error("Cannot find module 'playwright'");
      (err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
      throw err;
    });

    const { createScreenshotTool } = await import("./screenshot.js");
    const tool = createScreenshotTool(tmpDir);
    const result = await tool.execute({ url: "http://localhost:3000" }, ctx());

    expect(typeof result).toBe("string");
    expect(result as string).toContain("playwright install chromium");
  });

  it("returns the install hint when the Chromium binary is missing", async () => {
    const launch = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
        ),
      );
    vi.doMock("playwright", () => ({ chromium: { launch } }));

    const { createScreenshotTool } = await import("./screenshot.js");
    const tool = createScreenshotTool(tmpDir);
    const result = await tool.execute({ url: "http://localhost:3000" }, ctx());

    expect(typeof result).toBe("string");
    expect(result as string).toContain("playwright install chromium");
  });

  it("short-circuits before launch when the signal is already aborted", async () => {
    const launch = vi.fn();
    vi.doMock("playwright", () => ({ chromium: { launch } }));

    const { createScreenshotTool } = await import("./screenshot.js");
    const tool = createScreenshotTool(tmpDir);
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute({ url: "http://localhost:3000" }, ctx(controller.signal));

    expect(typeof result).toBe("string");
    expect(result as string).toContain("aborted");
    expect(launch).not.toHaveBeenCalled();
  });
});
