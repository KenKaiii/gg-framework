import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { openBrowser } from "../utils/open-browser.js";

/** What the app's live preview reports back (app-sidecar/live-preview/manager.ts). */
export interface LivePreviewResult {
  running: boolean;
  url: string | null;
  target: string | null;
  needsUrl?: boolean;
  error?: string;
}

export type LivePreviewHandler = (url: string | undefined) => Promise<LivePreviewResult>;

const LivePreviewParams = z.object({
  url: z
    .string()
    .optional()
    .describe("Dev server address, e.g. localhost:3000; omit to use the running one"),
});

/**
 * Open the project's running web app in the user's browser with GG Coder's
 * chat on it. Registered only in the desktop app's code windows, where the
 * sidecar can serve the preview.
 */
export function createLivePreviewTool(
  start: LivePreviewHandler,
  open: (url: string) => void = openBrowser,
): AgentTool<typeof LivePreviewParams> {
  return {
    name: "live_preview",
    description:
      "Open the project's running web app in the user's browser with GG Coder's chat on it, so they " +
      "can point at elements and ask for changes. Start the dev server in the background first.",
    parameters: LivePreviewParams,
    executionMode: "sequential",
    async execute({ url }) {
      const status = await start(url?.trim() || undefined);
      if (status.running && status.url) {
        open(status.url);
        return (
          `Live preview is open in the user's browser at ${status.url}, showing ${status.target}. ` +
          "Messages sent from it go to a separate live preview chat, not this one."
        );
      }
      if (status.needsUrl) {
        return (
          "No web app is running for this project (an API alone can't be previewed). Start the " +
          "dev server that serves its UI in a browser with run_in_background, wait until it " +
          "prints its local address, then call live_preview again (or pass `url`)."
        );
      }
      return `Error: ${status.error ?? "the live preview didn't start."}`;
    },
  };
}
