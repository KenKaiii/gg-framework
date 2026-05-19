import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { resolvePath } from "./path-utils.js";

const ExitPlanParams = z.object({
  plan_path: z.string().describe("Path to the plan markdown file (must be under .gg/plans/)"),
});

export function createExitPlanTool(
  cwd: string,
  onExitPlan: (planPath: string) => Promise<string>,
): AgentTool<typeof ExitPlanParams> {
  return {
    name: "exit_plan",
    description:
      "Submit your plan for user review and exit plan mode. " +
      "The plan file must be under .gg/plans/. The user will approve, reject with feedback, or cancel.",
    parameters: ExitPlanParams,
    executionMode: "sequential",
    async execute({ plan_path }) {
      const resolved = resolvePath(cwd, plan_path);
      const plansDir = path.join(cwd, ".gg", "plans");

      if (!resolved.startsWith(plansDir)) {
        return "Error: plan_path must be under .gg/plans/. Got: " + plan_path;
      }

      // Validate the plan file exists and has content
      try {
        const content = await fs.readFile(resolved, "utf-8");
        if (!content.trim()) {
          return "Error: Plan file is empty. Write your plan before calling exit_plan.";
        }
      } catch {
        return "Error: Could not read plan file at " + plan_path + ". Make sure the file exists.";
      }

      const result = await onExitPlan(resolved);
      return result;
    },
  };
}
