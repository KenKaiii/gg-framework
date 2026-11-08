import { z } from "zod";
import type { AgentTool } from "@kleio/agent";
import { MAX_PROCESS_WAIT_MS, type ProcessManager } from "../core/process-manager.js";
import { truncateTail, describeCompressed } from "./truncate.js";
import { compressToolOutput } from "./compress.js";
import { writeOverflow } from "./overflow.js";

const TaskOutputParams = z.object({
  id: z.string(),
  from_start: z.boolean().optional(),
  wait_ms: z
    .number()
    .int()
    .min(1000)
    .max(MAX_PROCESS_WAIT_MS)
    .optional()
    .describe(`Block until exit or a wake fires (max ${MAX_PROCESS_WAIT_MS})`),
});

export function createTaskOutputTool(
  processManager: ProcessManager,
): AgentTool<typeof TaskOutputParams> {
  return {
    name: "task_output",
    description: "Read a background process's new output (a wake match is not success).",
    parameters: TaskOutputParams,
    // wait_ms can block past the loop's default per-tool ceiling, so declare the
    // real budget rather than being cancelled mid-wait.
    timeoutMs: MAX_PROCESS_WAIT_MS + 30_000,
    async execute({ id, from_start, wait_ms }, context) {
      let waitNotice = "";
      if (wait_ms !== undefined) {
        const { reason, detail } = await processManager.waitForActivity(
          id,
          wait_ms,
          context?.signal,
        );
        if (reason === "timeout") {
          waitNotice = ` — still running after waiting ${Math.round(wait_ms / 1000)}s`;
        } else if (reason === "pattern") {
          waitNotice = " — wake pattern matched; inspect output before declaring success";
        } else if (reason === "silence") {
          waitNotice = " — silence wake fired; process may be stalled, not necessarily ready";
        } else if (reason === "failure") {
          waitNotice =
            " — stopped waiting: the output shows a failure while it is still running; " +
            "read it and act now rather than waiting for the exit";
        } else if (reason === "other") {
          waitNotice =
            " — stopped waiting early because other background work needs attention" +
            (detail ? `: ${detail}` : "");
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
