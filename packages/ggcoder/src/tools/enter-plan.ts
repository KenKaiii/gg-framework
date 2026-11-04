import { z } from "zod";
import type { AgentTool } from "@kleio/agent";

const EnterPlanParams = z.object({
  reason: z.string().optional(),
});

export function createEnterPlanTool(
  onEnterPlan: (reason?: string) => void | Promise<void>,
): AgentTool<typeof EnterPlanParams> {
  return {
    name: "enter_plan",
    description:
      "Enter read-only plan mode for complex or risky work (writes only under .gg/plans/).",
    parameters: EnterPlanParams,
    executionMode: "sequential",
    async execute({ reason }) {
      await onEnterPlan(reason);
      return (
        "Plan mode activated. You are now in read-only research mode.\n\n" +
        "Allowed actions:\n" +
        "- Use read, grep, find, ls, source_path, web_fetch/web_search, and code search tools to investigate\n" +
        "- Write the implementation plan to .gg/plans/<name>.md\n\n" +
        "Restricted: bash, edit, write outside .gg/plans/, subagent, and task mutation.\n\n" +
        "When the plan is ready, call exit_plan with the plan file path."
      );
    },
  };
}
