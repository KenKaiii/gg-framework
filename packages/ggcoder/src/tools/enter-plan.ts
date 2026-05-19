import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";

const EnterPlanParams = z.object({
  reason: z
    .string()
    .optional()
    .describe("Why you are entering plan mode (e.g. complex multi-file task)"),
});

export function createEnterPlanTool(
  onEnterPlan: (reason?: string) => void,
): AgentTool<typeof EnterPlanParams> {
  return {
    name: "enter_plan",
    description:
      "Enter plan mode for safe, read-only exploration before making changes. " +
      "Use this when facing complex, multi-file tasks that benefit from research and planning " +
      "before implementation. In plan mode, destructive tools (bash, edit, write, subagent) are " +
      "restricted — only read-only tools and writing to .gg/plans/ are allowed.",
    parameters: EnterPlanParams,
    executionMode: "sequential",
    async execute({ reason }) {
      onEnterPlan(reason);
      return (
        "Plan mode activated. You are now in read-only research mode.\n\n" +
        "Allowed actions:\n" +
        "- Use read, grep, find, ls to explore the codebase\n" +
        "- Use web_fetch for documentation and references\n" +
        "- Write your plan to .gg/plans/<name>.md\n\n" +
        "Restricted: bash, edit, write (except .gg/plans/), subagent\n\n" +
        "When your plan is ready, call exit_plan with the plan file path."
      );
    },
  };
}
