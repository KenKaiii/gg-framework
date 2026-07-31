import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";

const TaskStopParams = z.object({
  id: z.string().describe("The background process ID to stop"),
});

export function createTaskStopTool(
  processManager: ProcessManager,
): AgentTool<typeof TaskStopParams> {
  return {
    name: "task_stop",
    description:
      "Stop a managed background process by closing stdin (EOF) first, waiting up to two seconds " +
      "for a clean exit, then escalating through configured process-tree cleanup if needed. " +
      "Returns the final state and unread output.",
    parameters: TaskStopParams,
    executionMode: "sequential",
    async execute({ id }) {
      return processManager.stop(id);
    },
  };
}
