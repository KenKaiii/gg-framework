import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import type { StructuredToolResult, ToolContext } from "@kenkaiiii/gg-agent";
import type { GenerateImageAuth } from "./generate-image.js";
import { extractToolImagePaths } from "../core/session-history.js";

// A real, decodable 1×1 PNG so sharp (shrinkToFit / downscaleForPreview) works.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const TINY_PNG_B64 = TINY_PNG.toString("base64");

function ctx(signal?: AbortSignal): ToolContext {
  return { signal: signal ?? new AbortController().signal, toolCallId: "test" };
}

function isStructured(result: string | StructuredToolResult): result is StructuredToolResult {
  return typeof result !== "string";
}

/** A fake auth that always resolves the OpenAI token successfully. */
function fakeAuth(): GenerateImageAuth & { hasProviderAuth(p: string): Promise<boolean> } {
  return {
    async resolveCredentials() {
      return { accessToken: "test-token", accountId: "acct-123" };
    },
    async hasProviderAuth() {
      return true;
    },
  };
}

/** A fake auth that throws (OpenAI not connected). */
function noAuth(): GenerateImageAuth & { hasProviderAuth(p: string): Promise<boolean> } {
  return {
    async resolveCredentials() {
      throw new Error("Not logged in to openai");
    },
    async hasProviderAuth() {
      return false;
    },
  };
}

/** A Codex image endpoint reply (`codex/images/generations` or `/edits`). */
function makeImageResponse(b64Images: string[], status = 200, size?: string): Response {
  return new Response(
    JSON.stringify({
      created: 1,
      ...(size ? { size } : {}),
      data: b64Images.map((b64_json) => ({ b64_json })),
      output_format: "png",
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/** An unsigned JWT-shaped token whose auth claim carries `plan`. */
function tokenForPlan(plan: string): string {
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ "https://api.openai.com/auth": { chatgpt_plan_type: plan } })}.sig`;
}

let tmpDir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "ggcoder-genimg-"));
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("generate_image param schema", () => {
  it("requires prompt and accepts optional params", async () => {
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const schema = tool.parameters;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ prompt: "a cat" }).success).toBe(true);
    expect(
      schema.safeParse({
        prompt: "a cat",
        size: "1024x1024",
        quality: "high",
        n: 2,
        output_format: "webp",
        background: "opaque",
        out_path: "out.png",
      }).success,
    ).toBe(true);
    // Codex sends only opaque or transparent; transparency is supported.
    expect(schema.safeParse({ prompt: "x", background: "transparent" }).success).toBe(true);
    expect(schema.safeParse({ prompt: "x", background: "auto" }).success).toBe(false);
    // No model choice: Codex pins the image model, so the schema offers none.
    expect("model" in schema.shape).toBe(false);
    // Codex's MAX_EDIT_IMAGES.
    expect(schema.safeParse({ prompt: "x", images: ["a.png"] }).success).toBe(true);
    expect(schema.safeParse({ prompt: "x", images: Array(6).fill("a.png") }).success).toBe(false);
    // Invalid quality rejected.
    expect(schema.safeParse({ prompt: "x", quality: "ultra" }).success).toBe(false);
    // n out of range.
    expect(schema.safeParse({ prompt: "x", n: 5 }).success).toBe(false);
    // GIF output, within Codex's GifOptions bounds.
    expect(schema.safeParse({ prompt: "x", gif: {} }).success).toBe(true);
    expect(
      schema.safeParse({ prompt: "x", gif: { frame_count: 16, frame_duration_ms: 20 } }).success,
    ).toBe(true);
    expect(schema.safeParse({ prompt: "x", gif: { frame_count: 1 } }).success).toBe(false);
    expect(schema.safeParse({ prompt: "x", gif: { frame_count: 17 } }).success).toBe(false);
    expect(schema.safeParse({ prompt: "x", gif: { frame_duration_ms: 2001 } }).success).toBe(false);
  });
});

describe("generate_image — generation (no image input)", () => {
  it("calls Codex's image endpoint directly and returns structured image result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeImageResponse([TINY_PNG_B64]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "a cat sitting on a desk" }, ctx());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    // Regression: this went through `codex/responses` with a retired chat
    // model (gpt-5.5) driving a hosted tool, which the backend rejected.
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token");
    expect(headers["chatgpt-account-id"]).toBe("acct-123");
    // The same Codex client identity chat sends; the backend gates on it.
    const { CODEX_CLIENT_VERSION } = await import("@kenkaiiii/gg-ai");
    expect(CODEX_CLIENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(headers["originator"]).toBe("codex_cli_rs");
    expect(headers["version"]).toBe(CODEX_CLIENT_VERSION);
    expect(headers["User-Agent"]).toMatch(new RegExp(`^codex_cli_rs/${CODEX_CLIENT_VERSION} `));

    // One id per tool call, as Codex sends per turn.
    expect(headers["x-codex-image-turn-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // Exactly the body openai/codex asserts in app-server/tests/suite/v2/
    // imagegen_extension.rs: no chat model, no stream, no hosted tool.
    expect(JSON.parse(init?.body as string)).toEqual({
      prompt: "a cat sitting on a desk",
      background: "opaque",
      model: "gpt-image-2",
      quality: "auto",
      size: "auto",
    });

    expect(isStructured(result)).toBe(true);
    if (!isStructured(result)) return;
    const blocks = Array.isArray(result.content) ? result.content : [];
    const texts = blocks.filter((c) => c.type === "text");
    const images = blocks.filter((c) => c.type === "image");
    // The path summary, then the size report.
    expect(texts.length).toBe(2);
    expect(images.length).toBe(1);
    // Should have imagePreviews in details.
    const details = result.details as { imagePreviews?: unknown[] };
    expect(Array.isArray(details?.imagePreviews)).toBe(true);
    expect(details!.imagePreviews!.length).toBe(1);
  });

  it("forwards a transparent background with the size and quality asked for", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeImageResponse([TINY_PNG_B64]));
    globalThis.fetch = fetchMock;
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute(
      { prompt: "a logo", background: "transparent", size: "1536x1024", quality: "high" },
      ctx(),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      prompt: "a logo",
      background: "transparent",
      model: "gpt-image-2",
      quality: "high",
      size: "1536x1024",
    });
    expect(isStructured(result)).toBe(true);
  });

  it("generates multiple images with one request each, never sending n", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => makeImageResponse([TINY_PNG_B64]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "two icons", n: 2 }, ctx());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(init?.body as string);
      expect(body.n).toBeUndefined();
      expect(body.model).toBe("gpt-image-2");
    }
    // Both images belong to the same tool call.
    const turnIds = fetchMock.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>)["x-codex-image-turn-id"],
    );
    expect(turnIds[0]).toBeTruthy();
    expect(turnIds[1]).toBe(turnIds[0]);
    expect(isStructured(result)).toBe(true);
    if (!isStructured(result)) return;
    const details = result.details as { imagePreviews?: unknown[] };
    expect(details.imagePreviews).toHaveLength(2);
  });

  it("saves the image to out_path when provided", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(makeImageResponse([TINY_PNG_B64])) as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const outPath = path.join(tmpDir, "custom.png");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    await tool.execute({ prompt: "a logo", out_path: outPath }, ctx());

    const saved = await readFile(outPath);
    expect(saved.length).toBe(TINY_PNG.length);
  });

  it("re-encodes the endpoint's PNG when another format is asked for", async () => {
    // TINY_PNG only has to survive the best-effort preview helpers; conversion
    // decodes for real, so this needs a PNG libvips can read.
    const { default: sharp } = await import("sharp");
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        makeImageResponse([png.toString("base64")]),
      ) as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const outPath = path.join(tmpDir, "custom.webp");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    await tool.execute({ prompt: "a logo", out_path: outPath, output_format: "webp" }, ctx());

    const saved = await readFile(outPath);
    // RIFF....WEBP, not the PNG bytes saved under a .webp name.
    expect(saved.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(saved.subarray(8, 12).toString("ascii")).toBe("WEBP");
  });
});

/** A real PNG of the given size with an alpha channel at 253 (as a user saw live). */
async function transparentPng(width: number, height: number): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 20;
    pixels[i + 1] = 120;
    pixels[i + 2] = 220;
    pixels[i + 3] = 253;
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

function textBlocks(result: string | StructuredToolResult): string[] {
  if (!isStructured(result) || !Array.isArray(result.content)) return [];
  return result.content.flatMap((c) => (c.type === "text" ? [c.text] : []));
}

describe("generate_image — delivered size", () => {
  it("reports a smaller size than requested, saving the native file with no resize or retry", async () => {
    // Live report: 2048x2048 asked for on a transparent edit, 1254x1254 saved,
    // and the tool said nothing.
    const png = await transparentPng(1254, 1254);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeImageResponse([png.toString("base64")], 200, "1254x1254"));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const refPath = path.join(tmpDir, "turntable.png");
    await writeFile(refPath, png);
    const outPath = path.join(tmpDir, "edited.png");

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute(
      {
        prompt: "cut out the turntable",
        image: refPath,
        size: "2048x2048",
        background: "transparent",
        out_path: outPath,
      },
      ctx(),
    );

    // One request: a mismatch never triggers another chargeable render.
    expect(fetchMock).toHaveBeenCalledOnce();
    const [summary, size] = textBlocks(result);
    // The path line is untouched, so restored history still finds the file.
    expect(summary).toBe(`Generated image → ${outPath}`);
    expect(extractToolImagePaths(summary ?? "")).toEqual([outPath]);
    expect(size).toContain("Size mismatch: requested 2048x2048, but OpenAI returned 1254x1254.");
    expect(size).toContain("no resizing");

    // The master file is OpenAI's PNG byte for byte: native size, alpha intact.
    const saved = await readFile(outPath);
    expect(saved.equals(png)).toBe(true);
    const { default: sharp } = await import("sharp");
    const meta = await sharp(saved).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([1254, 1254, true]);

    // Only the preview is downscaled, never the saved file.
    if (!isStructured(result)) return;
    const preview = (result.details as { imagePreviews: Array<{ base64: string }> })
      .imagePreviews[0];
    const previewMeta = await sharp(Buffer.from(preview?.base64 ?? "", "base64")).metadata();
    expect(previewMeta.width).toBeLessThan(1254);
    expect(previewMeta.hasAlpha).toBe(true);
  });

  it("confirms the size when the request was honoured", async () => {
    const png = await transparentPng(1024, 1024);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        makeImageResponse([png.toString("base64")]),
      ) as unknown as typeof globalThis.fetch;
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "an icon", size: "1024x1024" }, ctx());
    expect(textBlocks(result)[1]).toBe("Size: 1024x1024, as requested.");
  });

  it("reports the size OpenAI chose when none was requested", async () => {
    const png = await transparentPng(1536, 1024);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        makeImageResponse([png.toString("base64")]),
      ) as unknown as typeof globalThis.fetch;
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "a banner" }, ctx());
    expect(textBlocks(result)[1]).toBe("Size: 1536x1024 (size auto, chosen by OpenAI).");
  });
});

describe("generate_image — retries (Codex's policy)", () => {
  /** Retry seams with no real waiting: records each wait, jitter factor exactly 1. */
  function instantRetry(now = 0) {
    const waits: number[] = [];
    return {
      waits,
      deps: {
        sleep: async (ms: number) => {
          waits.push(ms);
        },
        random: () => 0.5,
        now: () => now,
      },
    };
  }

  const serverError = (status: number, headers?: Record<string, string>): Response =>
    new Response(JSON.stringify({ detail: "upstream hiccup" }), { status, headers });

  it("retries a 5xx with Codex's backoff, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(serverError(502))
      .mockResolvedValueOnce(serverError(503))
      .mockResolvedValueOnce(makeImageResponse([TINY_PNG_B64]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const { waits, deps } = instantRetry();
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth(), deps);

    const result = await tool.execute({ prompt: "a cat" }, ctx());
    expect(isStructured(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([200, 400]);
    // Every attempt is the same request.
    const bodies = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).body);
    expect(new Set(bodies).size).toBe(1);
  });

  it("gives up after 4 retries (5 attempts) and says so", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => serverError(500));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const { waits, deps } = instantRetry();
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth(), deps);

    const result = await tool.execute({ prompt: "a cat" }, ctx());
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(waits).toEqual([200, 400, 800, 1600]);
    expect(result).toContain("OpenAI Image API (500) after 5 attempts: upstream hiccup");
  });

  it("retries a dropped connection", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(makeImageResponse([TINY_PNG_B64]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const { waits, deps } = instantRetry();
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth(), deps);

    expect(isStructured(await tool.execute({ prompt: "a cat" }, ctx()))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([200]);
  });

  it.each([400, 403, 429])("never retries a %d", async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ detail: "no" }), { status }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const { waits, deps } = instantRetry();
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth(), deps);

    await tool.execute({ prompt: "a cat" }, ctx());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(waits).toEqual([]);
  });

  it("waits as long as Retry-After says, in seconds or as an HTTP date", async () => {
    const now = Date.parse("2026-10-17T00:00:00Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(serverError(503, { "retry-after": "3" }))
      .mockResolvedValueOnce(serverError(503, { "retry-after": "Sat, 17 Oct 2026 00:00:07 GMT" }))
      .mockResolvedValueOnce(makeImageResponse([TINY_PNG_B64]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const { waits, deps } = instantRetry(now);
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth(), deps);

    await tool.execute({ prompt: "a cat" }, ctx());
    expect(waits).toEqual([3000, 7000]);
  });

  it("stops without another request when the run is cancelled mid-wait", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => serverError(502));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const controller = new AbortController();
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth(), {
      sleep: async (_ms, signal) => {
        controller.abort();
        throw signal.reason;
      },
    });

    const result = await tool.execute({ prompt: "a cat" }, ctx(controller.signal));
    expect(result).toBe("Image generation aborted.");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("jitters the backoff by at most 10% either way", async () => {
    const { retryDelayMs } = await import("./generate-image.js");
    const at = (random: number): number =>
      retryDelayMs(3, null, { random: () => random, now: () => 0 });
    expect(at(0)).toBe(720);
    expect(at(0.999999)).toBe(879);
  });
});

describe("sizeReport", () => {
  it("names each image when a batch came back at different sizes", async () => {
    const { sizeReport } = await import("./generate-image.js");
    const text = sizeReport(
      "2048x2048",
      ["a.png", "b.png"],
      [
        { width: 2048, height: 2048 },
        { width: 1254, height: 1254 },
      ],
      [undefined, undefined],
    );
    expect(text).toContain(
      "requested 2048x2048, but OpenAI returned a.png: 2048x2048, b.png: 1254x1254",
    );
  });

  it("adds the response's own size claim when it disagrees with the pixels", async () => {
    const { sizeReport } = await import("./generate-image.js");
    expect(
      sizeReport("2048x2048", ["a.png"], [{ width: 1254, height: 1254 }], ["2048x2048"]),
    ).toContain("OpenAI's response reported 2048x2048.");
  });

  it("says so when the saved image cannot be measured", async () => {
    const { sizeReport } = await import("./generate-image.js");
    expect(sizeReport("2048x2048", ["a.png"], [null], [undefined])).toBe(
      "Requested 2048x2048, but the saved image could not be measured to confirm its size.",
    );
  });
});

describe("generate_image — edit (with image input)", () => {
  it("sends the reference image to the edits endpoint as a data URL", async () => {
    const refPath = path.join(tmpDir, "input.png");
    await mkdir(path.dirname(refPath), { recursive: true });
    await writeFile(refPath, TINY_PNG);

    const fetchMock = vi.fn().mockResolvedValue(makeImageResponse([TINY_PNG_B64]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute(
      { prompt: "make the background darker", image: refPath },
      ctx(),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      images: [{ image_url: `data:image/png;base64,${TINY_PNG_B64}` }],
      prompt: "make the background darker",
      background: "opaque",
      model: "gpt-image-2",
      quality: "auto",
      size: "auto",
    });
    expect(isStructured(result)).toBe(true);
  });

  it("sends several references in order, each with its own media type", async () => {
    const subject = path.join(tmpDir, "subject.png");
    const style = path.join(tmpDir, "style.jpg");
    await writeFile(subject, TINY_PNG);
    await writeFile(style, TINY_PNG);
    const fetchMock = vi.fn().mockResolvedValue(makeImageResponse([TINY_PNG_B64]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    await tool.execute(
      { prompt: "paint the subject in this style", images: [subject, style] },
      ctx(),
    );

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.images.map((i: { image_url: string }) => i.image_url.split(";")[0])).toEqual([
      "data:image/png",
      "data:image/jpeg",
    ]);
  });

  it("refuses image and images together, and unsupported reference types, without a request", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());

    expect(await tool.execute({ prompt: "x", image: "a.png", images: ["b.png"] }, ctx())).toContain(
      "not both",
    );
    expect(await tool.execute({ prompt: "x", image: "notes.txt" }, ctx())).toContain(
      "only PNG, JPEG, GIF, WebP and BMP",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a helpful error when the image path does not exist", async () => {
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute(
      { prompt: "edit this", image: path.join(tmpDir, "nonexistent.png") },
      ctx(),
    );
    expect(typeof result).toBe("string");
    expect(result).toContain("Could not read");
  });
});

describe("generate_image — error handling", () => {
  it("refuses a transparent JPEG before spending any quota", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const auth = fakeAuth();
    const credentials = vi.spyOn(auth, "resolveCredentials");
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, auth);
    const result = await tool.execute(
      { prompt: "a logo", background: "transparent", output_format: "jpeg" },
      ctx(),
    );
    expect(result).toContain("JPEG cannot store transparency");
    expect(result).toContain("No request was sent");
    expect(credentials).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains a used-up image quota with its reset time and stops the batch", async () => {
    // The 429 shape openai/codex's usage-limit test replays.
    const resetAt = 1_786_150_800;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            type: "usage_limit_reached",
            message: "image limit reached",
            resets_at: resetAt,
            plan_type: "plus",
          },
        }),
        { status: 429 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "a cat", n: 3 }, ctx());
    expect(result).toContain("reached its image generation limit");
    expect(result).toContain(new Date(resetAt * 1000).toISOString());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns a user-facing message when OpenAI is not connected", async () => {
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, noAuth());
    const result = await tool.execute({ prompt: "a cat" }, ctx());
    expect(typeof result).toBe("string");
    expect(result).toContain("not connected");
  });

  it("returns a user-facing message on API error (non-200)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ detail: "content moderation blocked" }), { status: 400 }),
      ) as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "blocked content" }, ctx());
    expect(typeof result).toBe("string");
    expect(result).toContain("failed");
    expect(result).toContain("moderation");
  });

  it.each([
    ["free", "not included with a free ChatGPT plan"],
    ["plus", "does not appear to include image generation"],
  ])("explains a 403 on a %s plan instead of echoing Forbidden", async (plan, expected) => {
    // A free ChatGPT login gets a bare `{"detail":"Forbidden"}` for every image
    // request (seen live, 2026-10-17).
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ detail: "Forbidden" }), { status: 403 }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const auth: GenerateImageAuth = {
      async resolveCredentials() {
        return { accessToken: tokenForPlan(plan), accountId: "acct-123" };
      },
    };

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, auth);
    const result = await tool.execute({ prompt: "a cat", n: 3 }, ctx());
    expect(result).toContain(expected);
    expect(result).toContain("will not help");
    // A refused account stops at the first request rather than burning n.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns empty-results message when API succeeds but returns no image data", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(makeImageResponse([])) as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "something" }, ctx());
    expect(typeof result).toBe("string");
    expect(result).toContain("no results");
  });

  it("respects abort signal before making the API call", async () => {
    const ac = new AbortController();
    ac.abort();
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "a cat" }, ctx(ac.signal));
    expect(typeof result).toBe("string");
    expect(result).toContain("aborted");
  });
});

/** A real two-frame animated GIF, wide enough that its preview gets shrunk. */
async function makeAnimatedGif(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const frames = await Promise.all(
    [255, 0].map((r) =>
      sharp({ create: { width: 640, height: 320, channels: 3, background: { r, g: 0, b: 0 } } })
        .png()
        .toBuffer(),
    ),
  );
  return sharp(frames, { join: { animated: true } })
    .gif({ delay: [200, 200], loop: 0 })
    .toBuffer();
}

describe("generate_image — animated GIF", () => {
  it("asks for a GIF the way Codex does and saves it untouched, previewing the animation", async () => {
    const gif = await makeAnimatedGif();
    const fetchMock = vi.fn().mockResolvedValue(makeImageResponse([gif.toString("base64")]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const sharp = (await import("sharp")).default;
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute(
      { prompt: "a blinking lantern", gif: { frame_count: 2, frame_duration_ms: 200 } },
      ctx(),
    );

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({ output_format: "gif", frame_count: 2, frame_duration_ms: 200 });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations",
    );

    expect(isStructured(result)).toBe(true);
    if (!isStructured(result)) return;
    const summary = (result.content[0] as { text: string }).text;
    const savedPath = summary.replace("Generated image → ", "");
    expect(savedPath.endsWith(".gif")).toBe(true);
    expect((await readFile(savedPath)).equals(gif)).toBe(true);
    expect(extractToolImagePaths(summary)).toEqual([savedPath]);

    // The model sees the first frame as a still, like Codex's preview.
    const blocks = Array.isArray(result.content) ? result.content : [];
    const modelImage = blocks.find((c) => c.type === "image") as {
      mediaType: string;
      data: string;
    };
    expect(modelImage.mediaType).toBe("image/png");
    const stillMeta = await sharp(Buffer.from(modelImage.data, "base64")).metadata();
    expect([stillMeta.width, stillMeta.height]).toEqual([640, 320]);

    // The chat preview keeps every frame.
    const preview = (
      result.details as { imagePreviews: Array<{ base64: string; mediaType: string }> }
    ).imagePreviews[0]!;
    expect(preview.mediaType).toBe("image/gif");
    const previewMeta = await sharp(Buffer.from(preview.base64, "base64"), {
      animated: true,
    }).metadata();
    expect(previewMeta.pages).toBe(2);
    expect(previewMeta.width).toBe(480);

    // The size report names the frame size, not the stacked frames.
    expect((result.content[1] as { text: string }).text).toContain("640x320");
  });

  it("sends gif: {} with no frame controls, leaving OpenAI's defaults", async () => {
    const gif = await makeAnimatedGif();
    const fetchMock = vi.fn().mockResolvedValue(makeImageResponse([gif.toString("base64")]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    await tool.execute({ prompt: "a wave", gif: {} }, ctx());

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.output_format).toBe("gif");
    expect("frame_count" in body).toBe(false);
    expect("frame_duration_ms" in body).toBe(false);
  });

  it("refuses gif with an output_format before spending any quota", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "x", gif: {}, output_format: "webp" }, ctx());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toContain("leave `output_format` unset");
  });

  it("draws a sprite sheet and stitches the GIF locally when OpenAI refuses native GIF", async () => {
    const sharp = (await import("sharp")).default;
    // A 2x2 sheet whose cells are red, green, blue and white, in reading order.
    const colours = [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
      { r: 255, g: 255, b: 255 },
    ];
    const sheet = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite(
        await Promise.all(
          colours.map(async (background, i) => ({
            input: await sharp({ create: { width: 200, height: 200, channels: 3, background } })
              .png()
              .toBuffer(),
            left: (i % 2) * 200,
            top: Math.floor(i / 2) * 200,
          })),
        ),
      )
      .png()
      .toBuffer();
    const refusal = () =>
      new Response(JSON.stringify({ detail: "GIF output is not enabled for this request." }), {
        status: 400,
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(refusal())
      .mockImplementation(async () => makeImageResponse([sheet.toString("base64")]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute(
      { prompt: "a colour cycle", gif: { frame_count: 4, frame_duration_ms: 100 }, n: 2 },
      ctx(),
    );

    // One refused native try, then one sheet per GIF without asking natively again.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sheetBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(sheetBody).not.toHaveProperty("output_format");
    expect(sheetBody).not.toHaveProperty("frame_count");
    expect(sheetBody.size).toBe("1536x1536");
    expect(sheetBody.prompt).toContain("4 frames in a 2x2 grid");
    expect(sheetBody.prompt).toContain("Animation: a colour cycle");

    expect(isStructured(result)).toBe(true);
    if (!isStructured(result)) return;
    const summary = (result.content[0] as { text: string }).text;
    const [first] = extractToolImagePaths(summary);
    expect(first?.endsWith("_0.gif")).toBe(true);
    const gif = await readFile(first!);
    const meta = await sharp(gif, { animated: true }).metadata();
    expect(meta.format).toBe("gif");
    expect(meta.pages).toBe(4);
    expect(meta.delay).toEqual([100, 100, 100, 100]);
    for (const [page, colour] of colours.entries()) {
      const { data } = await sharp(gif, { page }).raw().toBuffer({ resolveWithObject: true });
      expect([data[0], data[1], data[2]]).toEqual([colour.r, colour.g, colour.b]);
    }
    expect((result.content[1] as { text: string }).text).toContain("2x2 sprite sheet");
  });

  it("keeps a still when the sheet is not a usable grid, without claiming a GIF", async () => {
    const sharp = (await import("sharp")).default;
    const refusal = () =>
      new Response(JSON.stringify({ detail: "GIF output is not enabled for this request." }), {
        status: 400,
      });
    const { gifFromSpriteSheet, spriteGrid } = await import("./generate-image.js");
    const grid = spriteGrid(4, undefined);
    // One flat picture: every cell is the same, so nothing moves.
    const flat = await sharp({
      create: { width: 1536, height: 1536, channels: 3, background: { r: 40, g: 90, b: 160 } },
    })
      .png()
      .toBuffer();
    expect(await gifFromSpriteSheet(flat, grid, 200)).toBeNull();
    // The wrong shape for the grid that was asked for.
    const wide = await sharp({
      create: { width: 1536, height: 512, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    expect(await gifFromSpriteSheet(wide, grid, 200)).toBeNull();

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(refusal())
      .mockImplementation(async () =>
        makeImageResponse([flat.toString("base64")]),
      ) as unknown as typeof globalThis.fetch;
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "x", gif: { frame_count: 4 } }, ctx());
    expect(isStructured(result)).toBe(true);
    if (!isStructured(result)) return;
    const [saved] = extractToolImagePaths((result.content[0] as { text: string }).text);
    expect(saved?.endsWith(".png")).toBe(true);
    const blocks = Array.isArray(result.content) ? result.content : [];
    const texts = blocks.flatMap((c) => (c.type === "text" ? [c.text] : []));
    expect(texts.some((t) => t.includes("did not line up into an animation"))).toBe(true);
    expect(texts.some((t) => t.includes("sprite sheet"))).toBe(false);
  });

  it("shows a GIF 400 that is not a refusal as it is, with no second generation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "frame_count for GIF must be at least 2." }), {
        status: 400,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "x", gif: {} }, ctx());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(result)).toContain("frame_count for GIF must be at least 2.");
  });

  it("fits the sprite sheet to the frame shape and the backend's 3:1 limit", async () => {
    const { spriteGrid } = await import("./generate-image.js");
    expect(spriteGrid(9, undefined)).toEqual({ frames: 9, cols: 3, rows: 3, size: "1536x1536" });
    expect(spriteGrid(2, undefined).size).toBe("1536x768");
    expect(spriteGrid(4, "1536x1024").size).toBe("1536x1024");
    expect(spriteGrid(3, "1536x512").size).toBe("1536x512");
    expect(spriteGrid(5, undefined)).toMatchObject({ cols: 3, rows: 2 });
  });

  it("saves a still returned for a GIF request as .png and says so", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(makeImageResponse([TINY_PNG_B64])) as unknown as typeof globalThis.fetch;

    const { createGenerateImageTool } = await import("./generate-image.js");
    const tool = createGenerateImageTool(tmpDir, fakeAuth());
    const result = await tool.execute({ prompt: "x", gif: {}, out_path: "anim.gif" }, ctx());

    expect(isStructured(result)).toBe(true);
    if (!isStructured(result)) return;
    expect((result.content[0] as { text: string }).text).toBe(
      `Generated image → ${path.join(tmpDir, "anim.png")}`,
    );
    expect((await readFile(path.join(tmpDir, "anim.png"))).equals(TINY_PNG)).toBe(true);
    const blocks = Array.isArray(result.content) ? result.content : [];
    const texts = blocks.flatMap((c) => (c.type === "text" ? [c.text] : []));
    expect(texts.some((t) => t.includes("still PNG instead of an animated GIF"))).toBe(true);
  });
});
