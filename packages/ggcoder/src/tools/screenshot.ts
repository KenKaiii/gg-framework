import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { AgentTool, StructuredToolResult, ToolContext } from "@kenkaiiii/gg-agent";
import { resolvePath } from "./path-utils.js";
import { downscaleForPreview, shrinkToFit } from "../utils/image.js";

/**
 * Hint shown when Playwright (or its browser binary) is not installed. The tool
 * is always registered so the model knows it exists; if the engine is missing
 * it returns this string instead of crashing the turn.
 */
const INSTALL_HINT =
  "Browser engine not installed. Add the optional dependency and download Chromium:\n" +
  "  pnpm add -w playwright && npx playwright install chromium\n" +
  "Then retry the screenshot.";

const ActionInput = z.object({
  type: z.enum(["click", "type", "wait"]).describe("Action to perform on the page"),
  selector: z.string().optional().describe("CSS selector for click/type actions"),
  text: z.string().optional().describe("Text to type for the type action"),
  ms: z.number().int().min(0).optional().describe("Milliseconds to wait for the wait action"),
});

const ScreenshotParams = z.object({
  url: z.string().describe("URL or local dev-server address to open (e.g. http://localhost:3000)"),
  out_path: z
    .string()
    .optional()
    .describe("Output PNG path (defaults to .gg/screenshots/<timestamp>.png)"),
  wait_for: z.string().optional().describe("CSS selector to wait for before capturing"),
  viewport: z
    .object({ width: z.number().int().min(1), height: z.number().int().min(1) })
    .optional()
    .describe("Viewport size in pixels (default 1280×800)"),
  full_page: z.boolean().optional().describe("Capture the full scrollable page (default false)"),
  actions: z
    .array(ActionInput)
    .optional()
    .describe("Optional interactions (click/type/wait) to run before capturing"),
});

type ScreenshotArgs = z.infer<typeof ScreenshotParams>;

/** Minimal structural subset of the Playwright API the tool relies on. */
interface PlaywrightPage {
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  click(selector: string): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts: { fullPage?: boolean }): Promise<Buffer>;
}
interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}
interface PlaywrightChromium {
  launch(opts?: { headless?: boolean }): Promise<PlaywrightBrowser>;
}
interface PlaywrightModule {
  chromium: PlaywrightChromium;
}

let cachedChromium: PlaywrightChromium | null = null;

/**
 * Lazily resolve Playwright's chromium launcher. Mirrors `loadSharp()` in
 * utils/image.ts: a dynamic import gated behind a function so the optional
 * dependency never lands in bundlers that don't need it. Throws if the module
 * is absent so the caller can degrade to the install hint.
 */
async function loadChromium(): Promise<PlaywrightChromium> {
  if (cachedChromium) return cachedChromium;
  // Non-literal specifier so tsc does not statically resolve the optional
  // dependency (it may be absent). The import still works at runtime when
  // playwright is installed.
  const moduleName: string = "playwright";
  const mod = (await import(moduleName)) as unknown as PlaywrightModule;
  if (!mod.chromium) throw new Error("playwright.chromium unavailable");
  cachedChromium = mod.chromium;
  return cachedChromium;
}

function isModuleNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

/**
 * Detect the launch-time failure where the playwright package IS installed but
 * the Chromium binary is not (the common case, since `npx playwright install`
 * is a separate manual step from the npm install). Playwright throws
 * "…Executable doesn't exist at <path>…" here.
 */
function isBrowserBinaryMissing(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /executable doesn't exist|playwright install/i.test(message);
}

function defaultOutPath(cwd: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(cwd, ".gg", "screenshots", `${stamp}.png`);
}

async function runActions(page: PlaywrightPage, actions: ScreenshotArgs["actions"]): Promise<void> {
  for (const action of actions ?? []) {
    if (action.type === "click" && action.selector) {
      await page.click(action.selector);
    } else if (action.type === "type" && action.selector) {
      await page.fill(action.selector, action.text ?? "");
    } else if (action.type === "wait") {
      if (action.selector) await page.waitForSelector(action.selector);
      else await page.waitForTimeout(action.ms ?? 500);
    }
  }
}

export function createScreenshotTool(cwd: string): AgentTool<typeof ScreenshotParams> {
  return {
    name: "screenshot",
    description:
      "Open a URL or local dev server in a headless browser and capture a PNG so you can " +
      "visually verify rendered output. Optionally wait for a selector, run click/type/wait " +
      "actions, set the viewport, or capture the full page. Returns the image so you can see it. " +
      "Requires the optional 'playwright' dependency and 'npx playwright install chromium'.",
    parameters: ScreenshotParams,
    executionMode: "sequential",
    async execute(
      args: ScreenshotArgs,
      context: ToolContext,
    ): Promise<string | StructuredToolResult> {
      if (context.signal.aborted) return "Screenshot aborted before launch.";

      let chromium: PlaywrightChromium;
      try {
        chromium = await loadChromium();
      } catch (err) {
        if (isModuleNotFound(err)) return INSTALL_HINT;
        const reason = err instanceof Error ? err.message : String(err);
        return `${INSTALL_HINT}\n(load error: ${reason})`;
      }

      const viewport = args.viewport ?? { width: 1280, height: 800 };
      const outPath = args.out_path ? resolvePath(cwd, args.out_path) : defaultOutPath(cwd);

      let browser: PlaywrightBrowser | null = null;
      try {
        browser = await chromium.launch({ headless: true });
        // Kill the browser if the turn is interrupted.
        const onAbort = (): void => void browser?.close().catch(() => {});
        context.signal.addEventListener("abort", onAbort, { once: true });

        const page = await browser.newPage();
        await page.setViewportSize(viewport);
        await page.goto(args.url, { waitUntil: "networkidle" });
        if (args.wait_for) await page.waitForSelector(args.wait_for);
        await runActions(page, args.actions);

        const raw = await page.screenshot({ fullPage: args.full_page ?? false });
        context.signal.removeEventListener("abort", onAbort);

        await mkdir(path.dirname(outPath), { recursive: true });
        await writeFile(outPath, raw);

        // Shrink for the model (provider image limits) and a smaller copy for
        // the inline terminal preview.
        const { buffer, mediaType } = await shrinkToFit(raw, "image/png");
        const previewBuffer = await downscaleForPreview(buffer);

        return {
          content: [
            {
              type: "text",
              text: `Captured ${args.url} → ${outPath} [${mediaType}] (${viewport.width}×${viewport.height})`,
            },
            { type: "image", mediaType, data: buffer.toString("base64") },
          ],
          details: {
            outPath,
            imagePreviews: [{ base64: previewBuffer.toString("base64"), mediaType, path: outPath }],
          },
        };
      } catch (err) {
        if (context.signal.aborted) return "Screenshot aborted.";
        // Package present but Chromium not downloaded — surface the actionable
        // install command rather than a raw stack-trace message.
        if (isBrowserBinaryMissing(err)) return INSTALL_HINT;
        const reason = err instanceof Error ? err.message : String(err);
        return `Screenshot failed for ${args.url}: ${reason}`;
      } finally {
        await browser?.close().catch(() => {});
      }
    },
  };
}
