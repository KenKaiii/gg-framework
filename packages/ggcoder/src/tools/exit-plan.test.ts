import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExitPlanTool } from "./exit-plan.js";

const context = () => ({ signal: new AbortController().signal, toolCallId: "exit-plan-test" });

function asText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result) {
    const c = (result as { content: unknown }).content;
    if (typeof c === "string") return c;
  }
  return String(result);
}

describe("createExitPlanTool", () => {
  let cwd: string;
  let plansDir: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "exit-plan-test-"));
    plansDir = path.join(cwd, ".gg", "plans");
    await fs.mkdir(plansDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("passes a valid plan with a ## Steps section through to onExitPlan", async () => {
    const planPath = path.join(plansDir, "plan.md");
    await fs.writeFile(
      planPath,
      "# My Plan\n\nContext here.\n\n## Steps\n\n1. Implement the feature in src/a.ts\n2. Add tests for the feature\n",
    );
    const onExitPlan = vi.fn().mockResolvedValue("Plan submitted.");
    const tool = createExitPlanTool(cwd, onExitPlan);

    const result = await tool.execute({ plan_path: ".gg/plans/plan.md" }, context());

    expect(asText(result)).toBe("Plan submitted.");
    expect(onExitPlan).toHaveBeenCalledWith(planPath);
  });

  it("rejects a step-less plan with the remediation message and never calls onExitPlan", async () => {
    await fs.writeFile(
      path.join(plansDir, "plan.md"),
      "# My Plan\n\nJust prose describing the approach with no step section.\n",
    );
    const onExitPlan = vi.fn();
    const tool = createExitPlanTool(cwd, onExitPlan);

    const result = await tool.execute({ plan_path: ".gg/plans/plan.md" }, context());

    expect(asText(result)).toContain("Plan rejected: no '## Steps' section");
    expect(asText(result)).toContain("call exit_plan again");
    expect(onExitPlan).not.toHaveBeenCalled();
  });

  it("rejects a plan whose ## Steps section has only prose bullets", async () => {
    await fs.writeFile(
      path.join(plansDir, "plan.md"),
      "# My Plan\n\n## Steps\n\n- do the first thing\n- do the second thing\n",
    );
    const onExitPlan = vi.fn();
    const tool = createExitPlanTool(cwd, onExitPlan);

    const result = await tool.execute({ plan_path: ".gg/plans/plan.md" }, context());

    expect(asText(result)).toContain("Plan rejected");
    expect(onExitPlan).not.toHaveBeenCalled();
  });

  it("rejects an empty plan file", async () => {
    await fs.writeFile(path.join(plansDir, "plan.md"), "   \n");
    const onExitPlan = vi.fn();
    const tool = createExitPlanTool(cwd, onExitPlan);

    const result = await tool.execute({ plan_path: ".gg/plans/plan.md" }, context());

    expect(asText(result)).toContain("Plan file is empty");
    expect(onExitPlan).not.toHaveBeenCalled();
  });

  it("still rejects paths outside .gg/plans/", async () => {
    const onExitPlan = vi.fn();
    const tool = createExitPlanTool(cwd, onExitPlan);

    for (const bad of ["plan.md", "../plan.md", ".gg/plans/../../etc/passwd"]) {
      const result = await tool.execute({ plan_path: bad }, context());
      expect(asText(result)).toContain("must be under .gg/plans/");
    }
    expect(onExitPlan).not.toHaveBeenCalled();
  });
});
