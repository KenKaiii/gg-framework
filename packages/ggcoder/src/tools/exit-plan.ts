import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { resolvePath } from "./path-utils.js";
import { extractPlanSteps } from "../utils/plan-steps.js";

const ExitPlanParams = z.object({
  plan_path: z.string().describe("Path to the plan markdown file; must be under .gg/plans/"),
});

export function createExitPlanTool(
  cwd: string,
  onExitPlan: (planPath: string) => Promise<string>,
): AgentTool<typeof ExitPlanParams> {
  return {
    name: "exit_plan",
    description:
      "Submit a .gg/plans/ markdown plan for user review and leave the active research phase. " +
      "The user can approve it for implementation, reject it with feedback, or dismiss the review.",
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

      return onExitPlan(resolved);
    },
  };
}
