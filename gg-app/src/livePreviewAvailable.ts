/** Code windows only: a goal or chat has no web app of its own to preview. One rule for the key,
 *  the panel and the hook, so the key never opens a panel that isn't there. */
export function livePreviewAvailable(
  mode: string,
  needsProject: boolean,
  state: { goal?: unknown } | null,
): boolean {
  return mode === "code" && !needsProject && state !== null && !state.goal;
}

/** What "Start dev server" asks the window's GG to do. */
export const START_DEV_SERVER_PROMPT =
  "Start the dev server that serves this project's UI in a browser, in the background with " +
  "run_in_background, wait until it prints its local address, then open the live preview with " +
  "the live_preview tool. An API server alone isn't enough. If the project has no UI a browser " +
  "can show (a desktop-only app, say), tell me that instead of starting anything.";
