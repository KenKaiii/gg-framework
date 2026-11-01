/**
 * Lightweight process entry for sub-agent children (`--subagent-worker` and
 * the blocking `subagent` tool's `--json` mode).
 *
 * Spawning `cli.js` for a child loaded the whole CLI graph (Ink, React, every
 * subcommand) before reaching the worker dispatch: ~210 ms of every child's
 * cold start. This entry loads only what a child runs. The desktop bundle has
 * no sibling file and keeps falling back to the sidecar bundle itself (see
 * `resolveSubAgentCliEntry`).
 */
import { PerformanceObserver, performance } from "node:perf_hooks";

// Same guards as cli.ts: abort races must not crash a child on Node 25+, and
// performance entries must not accumulate across a long child run.
process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error) {
    const msg = reason.message.toLowerCase();
    if (reason.name === "AbortError" || msg.includes("abort")) return;
  }
  throw reason;
});
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.entryType === "measure") performance.clearMeasures(entry.name);
    else if (entry.entryType === "mark") performance.clearMarks(entry.name);
    else if (entry.entryType === "resource") performance.clearResourceTimings();
  }
}).observe({
  entryTypes: PerformanceObserver.supportedEntryTypes.filter((t) => t !== "gc" && t !== "function"),
});

async function main(): Promise<void> {
  if (process.argv.includes("--subagent-worker")) {
    const { runSubagentWorkerMode } = await import("./modes/subagent-worker-mode.js");
    await runSubagentWorkerMode();
    return;
  }
  const { runJsonModeIfRequested } = await import("./app-sidecar/json-mode.js");
  if (!(await runJsonModeIfRequested())) {
    process.stderr.write("subagent-entry: expected --subagent-worker or --json\n");
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
