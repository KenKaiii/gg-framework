import { z } from "zod";
import type { AgentTool } from "@kleio/agent";
import type { ProcessManager } from "../core/process-manager.js";

const TaskStopParams = z.object({
  id: z.string(),
});

export function createTaskStopTool(
  processManager: ProcessManager,
): AgentTool<typeof TaskStopParams> {
  return {
    name: "task_stop",
    description: "Stop a background process.",
    parameters: TaskStopParams,
    async execute({ id }) {
      return processManager.stop(id);
    },
  };
}
