import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";

const EnterPlanParams = z.object({
  reason: z.string().optional(),
});

export function createEnterPlanTool(
  onEnterPlan: (reason?: string) => void | Promise<void>,
): AgentTool<typeof EnterPlanParams> {
  return {
    name: "enter_plan",
    description:
      "Enter read-only plan mode: research, then write a plan for the user to approve before changing code.",
    parameters: EnterPlanParams,
    executionMode: "sequential",
    async execute({ reason }) {
      await onEnterPlan(reason);
      return (
        "Plan mode is on. Research read-only (read-only bash is allowed), write the plan to " +
        ".gg/plans/<name>.md ending in a numbered '## Steps' list, then call exit_plan with its path. " +
        "Edits outside .gg/plans/, mutating bash and helper agents that can edit are blocked until the plan is approved."
      );
    },
  };
}
