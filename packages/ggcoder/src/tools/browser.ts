import { z } from "zod";
import type { AgentTool, StructuredToolResult, ToolContext } from "@kenkaiiii/gg-agent";
import { downscaleForPreview, shrinkToFit } from "../utils/image.js";
import { BROWSER_API_NAMES, createBrowserApi, type Screenshot } from "./browser-api.js";
import { runBrowserScript } from "./browser-sandbox.js";
import { BrowserUnavailableError, type BrowserManager } from "./browser-session.js";

export { BrowserManager } from "./browser-session.js";

export const BROWSER_SCRIPT_TIMEOUT_MS = 120_000;
export const MAX_BROWSER_OUTPUT = 10_000;
// Each attached image costs the model ~1-2k tokens; later ones stay on disk.
export const MAX_BROWSER_IMAGES = 4;

// Wording and API tuned in bench/browser-tools: one script per flow took about
// half the turns of one tool call per step (Opus and Haiku).
const DESCRIPTION = `Test a web page in a real browser by running a short async JavaScript script that does several steps in one call. Return a value or log() what you want to see. New console errors and failed or slow requests are reported automatically; screenshots are attached. The page stays open between calls. Scripts run in a sandbox with only these functions, plus fetch (runs in the page).
API (target = a ref like "e12", visible text, or {role, name} | {label} | {selector}, optional nth):
  open(url) → controls with refs
  snapshot({interactiveOnly}) → page tree with refs
  click(target, {double}) → what changed on the page
  fill({Label: value, ...} or [{...target, value, type: "checkbox"|"radio"|"combobox"}], {submit}) → what changed
  check({text | texts | url | page_title | ...target, state, value, count, timeout_ms}) → {pass, detail}; retries until timeout_ms (default 3000)
  resize(width, height) → elements that appeared or disappeared
  screenshot({full_page, element}) → saved path; image attached
  evaluate(fnOrExpression, arg) → value from the page
  problems() → every console error and failed request so far
Output over ${MAX_BROWSER_OUTPUT.toLocaleString("en")} characters is cut: return only what you need.`;

const BrowserParams = z.object({
  code: z.string().min(1).describe("Async function body; use await and return"),
});

const pretty = (v: unknown): string => {
  try {
    return typeof v === "string" ? v : (JSON.stringify(v, null, 2) ?? String(v));
  } catch {
    return String(v);
  }
};

export function createBrowserTool(
  cwd: string,
  manager: BrowserManager,
): AgentTool<typeof BrowserParams> {
  return {
    name: "browser",
    description: DESCRIPTION,
    parameters: BrowserParams,
    executionMode: "sequential",
    timeoutMs: BROWSER_SCRIPT_TIMEOUT_MS + 30_000,
    async execute(
      args: z.infer<typeof BrowserParams>,
      context: ToolContext,
    ): Promise<string | StructuredToolResult> {
      if (context.signal.aborted) return "Browser script aborted before it started.";
      try {
        await manager.page();
      } catch (err) {
        if (err instanceof BrowserUnavailableError) return err.message;
        return `Browser failed to start: ${err instanceof Error ? err.message : String(err)}`;
      }
      manager.touch();

      const shots: Screenshot[] = [];
      const outcome = await runBrowserScript(
        args.code,
        BROWSER_API_NAMES,
        createBrowserApi(manager, cwd, shots),
        { timeoutMs: BROWSER_SCRIPT_TIMEOUT_MS, signal: context.signal },
      );
      manager.touch();

      // Logs survive a failed script, so the model sees how far it got.
      const sections: string[] = [];
      if (outcome.logs.length) sections.push(`Log:\n${outcome.logs.join("\n")}`);
      if (outcome.error) sections.push(`Script failed: ${outcome.error}`);
      else if (outcome.result) sections.push(`Result: ${pretty(outcome.result.value)}`);
      let text = sections.join("\n\n") || "Done (no return value or logs).";
      // The point of a script is filtering in it; a page or bundle dump would flood the context.
      if (text.length > MAX_BROWSER_OUTPUT)
        text =
          `${text.slice(0, MAX_BROWSER_OUTPUT)}\n… output cut to ${MAX_BROWSER_OUTPUT.toLocaleString("en")} of ` +
          `${text.length.toLocaleString("en")} characters. Filter inside the script and return only what you need.`;

      const { problems, events } = manager.newSince(manager.reported);
      manager.reported = manager.mark();
      if (problems.length) text += `\n\nNew problems:\n${problems.join("\n")}`;
      if (events.length) text += `\n\nEvents:\n${events.join("\n")}`;

      if (!shots.length) return text;
      const attached = shots.slice(0, MAX_BROWSER_IMAGES);
      if (shots.length > attached.length)
        text += `\n\n${shots.length - attached.length} more screenshot(s) saved but not attached: ${shots
          .slice(attached.length)
          .map((s) => s.path)
          .join(", ")}`;
      const images: { type: "image"; mediaType: string; data: string }[] = [];
      const imagePreviews: { base64: string; mediaType: string; path: string }[] = [];
      for (const shot of attached) {
        const { buffer, mediaType } = await shrinkToFit(shot.data, "image/png");
        images.push({ type: "image", mediaType, data: buffer.toString("base64") });
        const preview = await downscaleForPreview(buffer);
        imagePreviews.push({ base64: preview.toString("base64"), mediaType, path: shot.path });
      }
      return {
        // First line names the files so a resumed session can link each image.
        content: [
          { type: "text", text: `Screenshots → ${attached.map((s) => s.path).join(", ")}` },
          { type: "text", text },
          ...images,
        ],
        details: { imagePreviews },
      };
    },
  };
}
