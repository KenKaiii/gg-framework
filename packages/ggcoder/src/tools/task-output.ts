import { z } from "zod";
import type { AgentTool } from "@kleio/agent";
import { MAX_PROCESS_WAIT_MS, type ProcessManager } from "../core/process-manager.js";
import { truncateTail, describeCompressed } from "./truncate.js";
import { compressToolOutput } from "./compress.js";
import { writeOverflow } from "./overflow.js";

const TaskOutputParams = z.object({
  id: z.string().describe("The background process ID"),
  from_start: z
    .boolean()
    .optional()
    .describe("If true, read output from the beginning instead of incrementally"),
  wait_ms: z
    .number()
    .int()
    .min(1000)
    .max(MAX_PROCESS_WAIT_MS)
    .optional()
    .describe(
      `Block until the process exits or a declared wake condition fires, up to this many ms (max ${MAX_PROCESS_WAIT_MS}), then read. ` +
        "For dev servers, declare a readiness wake.pattern when starting, then check HTTP once it matches. " +
        "Omit wait_ms to read immediately; never wait for a ready server to exit.",
    ),
});

export function createTaskOutputTool(
  processManager: ProcessManager,
): AgentTool<typeof TaskOutputParams> {
  return {
    name: "task_output",
    description:
      "Read output from a background process. Returns new output since last read by default. " +
      "Use from_start=true to read from the beginning. Progress and exit status arrive " +
      "automatically for background processes \u2014 call this when you need the full output, " +
      "not merely to check whether something finished. Set wait_ms to block until the " +
      "process exits OR its declared wake condition fires (wait_agent is for child agents). " +
      "A wake match is not an exit or proof of success: inspect the output. " +
      "For dev servers, check HTTP readiness, then finish while leaving the server running.",
    parameters: TaskOutputParams,
    // wait_ms can block past the loop's default per-tool ceiling, so declare the
    // real budget rather than being cancelled mid-wait.
    timeoutMs: MAX_PROCESS_WAIT_MS + 30_000,
    async execute({ id, from_start, wait_ms }, context) {
      let waitNotice = "";
      if (wait_ms !== undefined) {
        const reason = await processManager.waitForExitOrWake(id, wait_ms, context?.signal);
        if (reason === "timeout") {
          waitNotice = ` — still running after waiting ${Math.round(wait_ms / 1000)}s`;
        } else if (reason === "pattern") {
          waitNotice = " — wake pattern matched; inspect output before declaring success";
        } else if (reason === "silence") {
          waitNotice = " — silence wake fired; process may be stalled, not necessarily ready";
        }
      }
      const result = await processManager.readOutput(id, from_start);

      const status =
        (result.isRunning ? "running" : `exited (code ${result.exitCode})`) + waitNotice;

      let output = result.output;
      if (output) {
        const truncated = truncateTail(output);
        if (truncated.truncated) {
          // Over-limit: compress (keeps errors + head/tail) rather than a blind
          // tail slice; overflow file preserves the full original.
          const overflowPath = await writeOverflow(output, "task-output").catch(() => null);
          const overflowNotice = overflowPath ? ` Full output: ${overflowPath}` : "";
          const c = compressToolOutput(output);
          const what = describeCompressed(output, c.content);
          output = `[${c.notice}${what ? ` ${what}` : ""}${overflowNotice}]\n${c.content}`;
        } else {
          output = truncated.content;
        }
      } else {
        output = "(no new output)";
      }

      return `Process ${id}: ${status}\n${output}`;
    },
  };
}
