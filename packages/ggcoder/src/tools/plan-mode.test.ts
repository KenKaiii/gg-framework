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
  it("registers plan transition tools when callbacks are supplied", () => {
    const { tools, processManager } = createTools(os.tmpdir(), {
      onEnterPlan: () => {},
      onExitPlan: async () => "ok",
    });

    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toContain("enter_plan");
    expect(toolNames).toContain("exit_plan");
    processManager.shutdownAll();
  });

  it("renders active plan instructions and plan tools", async () => {
    const prompt = await buildSystemPrompt(os.tmpdir(), [], true, undefined, [
      "read",
      "write",
      "edit",
      "bash",
      "enter_plan",
      "exit_plan",
    ]);

    expect(prompt).toContain("## Plan Mode (ACTIVE)");
    expect(prompt).toContain("draft a structured markdown plan at `.gg/plans/<name>.md`");
    expect(prompt).not.toContain("1. Explore");
    expect(prompt).toContain("**enter_plan**");
    expect(prompt).toContain("**exit_plan**");
  });

  it("allows write only under .gg/plans while plan mode is active", async () => {
    const cwd = await makeTempDir();
    const planModeRef = { current: true };
    const { tools, processManager } = createTools(cwd, { planModeRef });
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
    const { tools, processManager } = createTools(cwd, {
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
      model: "claude-sonnet-4-6",
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
    const { tools, processManager } = createTools(cwd, { planModeRef });
    const bashTool = tools.find((tool) => tool.name === "bash");
    expect(bashTool).toBeDefined();

    const result = String(await bashTool!.execute({ command: "echo hi" }, toolContext()));
    expect(result).not.toContain("bash is restricted in plan mode");
    expect(result).toContain("Exit code: 0");
    expect(result).toContain("hi");

    processManager.shutdownAll();
  });
});
