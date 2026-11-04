import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentTool, ToolExecuteResult } from "@kleio/agent";
import { resolvePath } from "./path-utils.js";
import { extractPlanSteps } from "../utils/plan-steps.js";

const ExitPlanParams = z.object({
  plan_path: z.string().describe("Under .gg/plans/"),
});

export function createExitPlanTool(
  cwd: string,
  onExitPlan: (planPath: string) => Promise<ToolExecuteResult>,
): AgentTool<typeof ExitPlanParams> {
  return {
    name: "exit_plan",
    description: "Submit the plan for the user to approve or reject.",
    parameters: ExitPlanParams,
    executionMode: "sequential",
    async execute({ plan_path }) {
      const resolved = resolvePath(cwd, plan_path);
      const plansDir = path.join(cwd, ".gg", "plans");
      const relative = path.relative(plansDir, resolved);

      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return `Error: plan_path must be under .gg/plans/. Got: ${plan_path}`;
      }

      let content: string;
      try {
        content = await fs.readFile(resolved, "utf-8");
      } catch {
        return `Error: Could not read plan file at ${plan_path}. Make sure it exists.`;
      }
      if (!content.trim()) {
        return "Error: Plan file is empty. Write your plan before calling exit_plan.";
      }

      // Fail closed: a plan without extractable steps silently loses the
      // [DONE:n] progress contract after approval — reject with the exact
      // remediation so the model can self-repair in the same run (plan mode
      // allows writing under .gg/plans/).
      if (extractPlanSteps(content).length === 0) {
        return (
          "Plan rejected: no '## Steps' section with numbered steps found. " +
          "Append a literal '## Steps' heading followed by a flat numbered list " +
          "(1., 2., …) of concrete implementation steps, then call exit_plan again."
        );
      }

      const review = await onExitPlan(resolved);
      // Desktop/TUI callbacks open review UI and return immediately. End this
      // run instead of asking the model to respond to "wait for approval".
      // Hosts that approve inline (ACP) explicitly opt into continuation.
      return typeof review === "string"
        ? { content: review, endRun: true }
        : { endRun: true, ...review };
    },
  };
}
