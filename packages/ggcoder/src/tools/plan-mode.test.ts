import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createEnterPlanTool } from "./enter-plan.js";
import { createExitPlanTool } from "./exit-plan.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { createBashTool } from "./bash.js";
import { ProcessManager } from "../core/process-manager.js";
import { buildSystemPrompt } from "../system-prompt.js";

function resultToString(result: string | { content: string }): string {
  return typeof result === "string" ? result : result.content;
}

const mockContext = {
  signal: new AbortController().signal,
  toolCallId: "test-1",
};

// ── enter_plan tool ──────────────────────────────────────

describe("createEnterPlanTool", () => {
  it("calls onEnterPlan callback and returns instructions", async () => {
    let calledWith: string | undefined;
    const tool = createEnterPlanTool((reason) => {
      calledWith = reason;
    });

    const result = resultToString(await tool.execute({ reason: "complex task" }, mockContext));

    expect(calledWith).toBe("complex task");
    expect(result).toContain("Plan mode activated");
    expect(result).toContain(".gg/plans/");
    expect(result).toContain("exit_plan");
  });

  it("works without a reason", async () => {
    let called = false;
    const tool = createEnterPlanTool(() => {
      called = true;
    });

    await tool.execute({}, mockContext);
    expect(called).toBe(true);
  });
});

// ── exit_plan tool ───────────────────────────────────────

describe("createExitPlanTool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exit-plan-test-"));
    await fs.mkdir(path.join(tmpDir, ".gg", "plans"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects paths outside .gg/plans/", async () => {
    const tool = createExitPlanTool(tmpDir, async () => "ok");

    const result = resultToString(await tool.execute({ plan_path: "src/hack.ts" }, mockContext));

    expect(result).toContain("Error");
    expect(result).toContain(".gg/plans/");
  });

  it("rejects empty plan files", async () => {
    const planPath = path.join(tmpDir, ".gg", "plans", "empty.md");
    await fs.writeFile(planPath, "   \n  \n");

    const tool = createExitPlanTool(tmpDir, async () => "should not reach");

    const result = resultToString(
      await tool.execute({ plan_path: ".gg/plans/empty.md" }, mockContext),
    );

    expect(result).toContain("Error");
    expect(result).toContain("empty");
  });

  it("rejects non-existent plan files", async () => {
    const tool = createExitPlanTool(tmpDir, async () => "should not reach");

    const result = resultToString(
      await tool.execute({ plan_path: ".gg/plans/ghost.md" }, mockContext),
    );

    expect(result).toContain("Error");
    expect(result).toContain("Could not read");
  });

  it("calls onExitPlan for valid plans and returns the result", async () => {
    const planPath = path.join(tmpDir, ".gg", "plans", "my-plan.md");
    await fs.writeFile(planPath, "# Plan\n\n1. Step one\n2. Step two\n");

    let receivedPath = "";
    const tool = createExitPlanTool(tmpDir, async (p) => {
      receivedPath = p;
      return "Plan submitted.";
    });

    const result = resultToString(
      await tool.execute({ plan_path: ".gg/plans/my-plan.md" }, mockContext),
    );

    expect(receivedPath).toBe(planPath);
    expect(result).toBe("Plan submitted.");
  });
});

// ── Tool restrictions in plan mode ───────────────────────

describe("plan mode tool restrictions", () => {
  let tmpDir: string;
  const planModeRef = { current: false };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-restrict-test-"));
    planModeRef.current = false;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("bash", () => {
    it("allows execution when plan mode is off", async () => {
      const pm = new ProcessManager();
      const tool = createBashTool(tmpDir, pm, undefined, planModeRef);

      const result = resultToString(await tool.execute({ command: "echo hello" }, mockContext));

      expect(result).toContain("Exit code: 0");
      expect(result).toContain("hello");
      pm.shutdownAll();
    });

    it("blocks execution when plan mode is on", async () => {
      planModeRef.current = true;
      const pm = new ProcessManager();
      const tool = createBashTool(tmpDir, pm, undefined, planModeRef);

      const result = resultToString(await tool.execute({ command: "echo hello" }, mockContext));

      expect(result).toContain("Error");
      expect(result).toContain("restricted in plan mode");
      pm.shutdownAll();
    });
  });

  describe("edit", () => {
    it("blocks execution when plan mode is on", async () => {
      planModeRef.current = true;
      const readFiles = new Set<string>();
      const tool = createEditTool(tmpDir, readFiles, undefined, planModeRef);

      const result = resultToString(
        await tool.execute(
          { file_path: "test.ts", edits: [{ old_text: "foo", new_text: "bar" }] },
          mockContext,
        ),
      );

      expect(result).toContain("Error");
      expect(result).toContain("restricted in plan mode");
    });
  });

  describe("write", () => {
    it("blocks writing to non-plan paths when plan mode is on", async () => {
      planModeRef.current = true;
      const tool = createWriteTool(tmpDir, undefined, undefined, planModeRef);

      const result = resultToString(
        await tool.execute({ file_path: "src/hack.ts", content: "malicious" }, mockContext),
      );

      expect(result).toContain("Error");
      expect(result).toContain("restricted in plan mode");
      expect(result).toContain(".gg/plans/");
    });

    it("allows writing to .gg/plans/ when plan mode is on", async () => {
      planModeRef.current = true;
      const tool = createWriteTool(tmpDir, undefined, undefined, planModeRef);

      const result = resultToString(
        await tool.execute(
          { file_path: ".gg/plans/my-plan.md", content: "# Plan\n\nDo stuff." },
          mockContext,
        ),
      );

      expect(result).toContain("Wrote");
      expect(result).toContain("lines");

      // Verify file was actually created
      const written = await fs.readFile(path.join(tmpDir, ".gg", "plans", "my-plan.md"), "utf-8");
      expect(written).toBe("# Plan\n\nDo stuff.");
    });

    it("creates .gg/plans/ directory if it doesn't exist", async () => {
      planModeRef.current = true;
      const tool = createWriteTool(tmpDir, undefined, undefined, planModeRef);

      await tool.execute(
        { file_path: ".gg/plans/auto-created.md", content: "# Plan" },
        mockContext,
      );

      const stat = await fs.stat(path.join(tmpDir, ".gg", "plans"));
      expect(stat.isDirectory()).toBe(true);
    });

    it("allows writing anywhere when plan mode is off", async () => {
      planModeRef.current = false;
      const tool = createWriteTool(tmpDir, undefined, undefined, planModeRef);

      const result = resultToString(
        await tool.execute(
          { file_path: "src/normal.ts", content: "export const x = 1;" },
          mockContext,
        ),
      );

      expect(result).toContain("Wrote");
    });
  });
});

// ── System prompt generation ─────────────────────────────

describe("buildSystemPrompt with plan mode", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("includes plan mode section when planMode is true", async () => {
    const prompt = await buildSystemPrompt(tmpDir, [], true);

    expect(prompt).toContain("Plan Mode (ACTIVE)");
    expect(prompt).toContain("exit_plan");
    expect(prompt).toContain(".gg/plans/");
  });

  it("does not include plan mode section when planMode is false", async () => {
    const prompt = await buildSystemPrompt(tmpDir, [], false);

    expect(prompt).not.toContain("Plan Mode (ACTIVE)");
  });

  it("includes enter_plan (not exit_plan) when not in plan mode", async () => {
    const prompt = await buildSystemPrompt(tmpDir, [], false);

    expect(prompt).toContain("enter_plan");
    expect(prompt).not.toContain("- **exit_plan**");
  });

  it("includes exit_plan (not enter_plan) when in plan mode", async () => {
    const prompt = await buildSystemPrompt(tmpDir, [], true);

    expect(prompt).toContain("exit_plan");
    expect(prompt).not.toContain("- **enter_plan**");
  });

  it("includes approved plan when approvedPlanPath is set", async () => {
    const plansDir = path.join(tmpDir, ".gg", "plans");
    await fs.mkdir(plansDir, { recursive: true });
    const planPath = path.join(plansDir, "approved.md");
    await fs.writeFile(planPath, "# My Plan\n\n1. Do this\n2. Do that\n");

    const prompt = await buildSystemPrompt(tmpDir, [], false, planPath);

    expect(prompt).toContain("Approved Plan");
    expect(prompt).toContain("approved.md");
    expect(prompt).toContain("# My Plan");
    expect(prompt).toContain("Do this");
    expect(prompt).toContain("Follow step order");
  });

  it("does not include approved plan section when no path is set", async () => {
    const prompt = await buildSystemPrompt(tmpDir, [], false);

    expect(prompt).not.toContain("Approved Plan");
    expect(prompt).not.toContain("<approved_plan>");
  });

  it("does not include approved plan when in plan mode (even if path is set)", async () => {
    const planPath = path.join(tmpDir, "fake-plan.md");
    const prompt = await buildSystemPrompt(tmpDir, [], true, planPath);

    // Plan mode section should be present, but not the approved plan
    expect(prompt).toContain("Plan Mode (ACTIVE)");
    expect(prompt).not.toContain("Approved Plan");
  });

  it("gracefully handles missing approved plan file", async () => {
    const prompt = await buildSystemPrompt(tmpDir, [], false, "/nonexistent/plan.md");

    // Should not crash, and should not include the section
    expect(prompt).not.toContain("Approved Plan");
    expect(prompt).not.toContain("<approved_plan>");
  });
});
