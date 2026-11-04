import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTools } from "./index.js";
import { buildSystemPrompt } from "../system-prompt.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "gg-plan-mode-"));
}

function toolContext(): { signal: AbortSignal; toolCallId: string } {
  return { signal: new AbortController().signal, toolCallId: "test-tool-call" };
}

describe("plan mode", () => {
  it("registers plan transition tools when callbacks are supplied", async () => {
    const { tools, processManager } = await createTools(os.tmpdir(), {
      onEnterPlan: () => {},
      onExitPlan: async () => "ok",
    });

    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toContain("enter_plan");
    expect(toolNames).toContain("exit_plan");
    processManager.shutdownAll();
  });

  it("renders active plan instructions with plan guidance in the tool schemas", async () => {
    const { tools, processManager } = await createTools(os.tmpdir(), {
      onEnterPlan: () => {},
      onExitPlan: async () => "ok",
    });
    try {
      const prompt = await buildSystemPrompt(
        os.tmpdir(),
        [],
        true,
        undefined,
        tools.map((tool) => tool.name),
      );

      expect(prompt).toContain("## Plan Mode (ACTIVE)");
      expect(prompt).toContain("Write the plan to `.gg/plans/<name>.md`");
      expect(prompt).toContain("Then call `exit_plan` with that path and stop.");
      expect(prompt).not.toContain("1. Explore");
      // Live-tool guidance moved out of the prompt, not out of the model's tool catalog.
      expect(tools.find((tool) => tool.name === "enter_plan")?.description).toContain(
        "Enter read-only plan mode for complex or risky work (writes only under .gg/plans/).",
      );
      expect(tools.find((tool) => tool.name === "exit_plan")?.description).toContain(
        "Submit the plan for the user to approve or reject.",
      );
      expect(prompt).not.toContain("**enter_plan**");
      expect(prompt).not.toContain("**exit_plan**");
    } finally {
      processManager.shutdownAll();
    }
  });

  it("allows write only under .gg/plans while plan mode is active", async () => {
    const cwd = await makeTempDir();
    const planModeRef = { current: true };
    const { tools, processManager } = await createTools(cwd, { planModeRef });
    const writeTool = tools.find((tool) => tool.name === "write");
    expect(writeTool).toBeDefined();

    const denied = await writeTool!.execute(
      { file_path: "src/index.ts", content: "export {};\n" },
      toolContext(),
    );
    expect(String(denied)).toContain("write is restricted in plan mode");

    const allowed = await writeTool!.execute(
      { file_path: ".gg/plans/example.md", content: "# Plan\n" },
      toolContext(),
    );
    expect(String(allowed)).toContain("Wrote");
    await expect(fs.readFile(path.join(cwd, ".gg/plans/example.md"), "utf-8")).resolves.toBe(
      "# Plan\n",
    );

    processManager.shutdownAll();
  });

  it("blocks bash/edit/subagent while plan mode is active", async () => {
    const cwd = await makeTempDir();
    const planModeRef = { current: true };
    const { tools, processManager } = await createTools(cwd, {
      planModeRef,
      agents: [
        {
          name: "worker",
          description: "test",
          systemPrompt: "test",
          tools: [],
          source: "project",
        },
      ],
      provider: "anthropic",
      model: "claude-sonnet-5",
    });

    const context = toolContext();
    const bashTool = tools.find((tool) => tool.name === "bash");
    const editTool = tools.find((tool) => tool.name === "edit");
    const subagentTool = tools.find((tool) => tool.name === "subagent");

    expect(String(await bashTool!.execute({ command: "echo hi > f" }, context))).toContain(
      "bash is restricted in plan mode",
    );
    expect(String(await editTool!.execute({ file_path: "x", edits: [] }, context))).toContain(
      "edit is restricted in plan mode",
    );
    expect(String(await subagentTool!.execute({ task: "x" }, context))).toContain(
      "subagent is restricted in plan mode",
    );

    processManager.shutdownAll();
  });

  it("allows read-only bash while plan mode is active", async () => {
    const cwd = await makeTempDir();
    const planModeRef = { current: true };
    const { tools, processManager } = await createTools(cwd, { planModeRef });
    const bashTool = tools.find((tool) => tool.name === "bash");
    expect(bashTool).toBeDefined();

    const result = String(await bashTool!.execute({ command: "echo hi" }, toolContext()));
    expect(result).not.toContain("bash is restricted in plan mode");
    expect(result).toContain("Exit code: 0");
    expect(result).toContain("hi");

    processManager.shutdownAll();
  });
});
