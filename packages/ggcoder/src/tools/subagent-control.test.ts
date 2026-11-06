import { describe, expect, it, vi } from "vitest";
import type { SubAgentManager } from "../core/subagent-manager.js";
import { createSubAgentControlTools } from "./subagent-control.js";
import { DEFAULT_WAIT_MS, MAX_WAIT_MS } from "../core/subagent-manager.js";

const ROSTER = [
  {
    name: "owl",
    description: "Traces symbols and call chains in this repo",
    tools: ["read"],
    systemPrompt: "Explore.",
    source: "bundled" as const,
  },
];

function fakeManager(agents: unknown[] = ROSTER, defaultAgent?: string): SubAgentManager {
  return {
    agents,
    defaultAgent,
    spawn: vi.fn(async (taskName: string) => ({
      agent_id: "12345678",
      task_name: taskName,
      state: "running",
    })),
    sendMessage: vi.fn(async () => 1),
    followup: vi.fn(async () => ({ agent_id: "12345678", state: "running" })),
    wait: vi.fn(async () => ({ timed_out: false, agents: [] })),
    list: vi.fn(() => []),
    interrupt: vi.fn(async () => ({ agent_id: "12345678", state: "interrupted" })),
  } as unknown as SubAgentManager;
}

const context = { signal: new AbortController().signal, toolCallId: "test" };

describe("async subagent control tools", () => {
  it("registers the six concise control surfaces", () => {
    expect(createSubAgentControlTools(fakeManager()).map((tool) => tool.name)).toEqual([
      "spawn_agent",
      "send_message",
      "followup_task",
      "wait_agent",
      "list_agents",
      "interrupt_agent",
    ]);
  });

  it("puts the agent roster in spawn_agent's description so routing is not blind", () => {
    const spawn = createSubAgentControlTools(fakeManager()).find(
      (tool) => tool.name === "spawn_agent",
    )!;

    expect(spawn.description).toContain("Available named agents:");
    expect(spawn.description).toContain("- owl: Traces symbols and call chains in this repo");
  });

  it("rejects an invented agent name at the schema instead of at spawn time", () => {
    const spawn = createSubAgentControlTools(fakeManager()).find(
      (tool) => tool.name === "spawn_agent",
    )!;
    const params = spawn.parameters as unknown as {
      safeParse(value: unknown): { success: boolean };
    };

    expect(params.safeParse({ tasks: [{ task_name: "a", task: "b", agent: "owl" }] }).success).toBe(
      true,
    );
    expect(
      params.safeParse({ tasks: [{ task_name: "a", task: "b", agent: "hawk" }] }).success,
    ).toBe(false);
    expect(params.safeParse({ tasks: [{ task_name: "a", task: "b" }] }).success).toBe(true);
  });

  it("takes 1 to 8 tasks per call, matching the running-agent limit", () => {
    const spawn = createSubAgentControlTools(fakeManager()).find(
      (tool) => tool.name === "spawn_agent",
    )!;
    const params = spawn.parameters as unknown as {
      safeParse(value: unknown): { success: boolean };
    };
    const tasks = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ task_name: `t${i}`, task: "x" }));

    expect(params.safeParse({ tasks: tasks(0) }).success).toBe(false);
    expect(params.safeParse({ tasks: tasks(8) }).success).toBe(true);
    expect(params.safeParse({ tasks: tasks(9) }).success).toBe(false);
    // The pre-batch single-task shape is rejected so the model corrects it.
    expect(params.safeParse({ task_name: "a", task: "b" }).success).toBe(false);
  });

  it("requires every task to name its agent when the team has a default (GG Goals)", () => {
    // Live runs: GG Goals left `agent` out and every task went to the default
    // builder, research included, so researchers never got web search.
    const spawn = createSubAgentControlTools(fakeManager(ROSTER, "owl")).find(
      (tool) => tool.name === "spawn_agent",
    )!;
    const params = spawn.parameters as unknown as {
      safeParse(value: unknown): { success: boolean };
    };
    expect(params.safeParse({ tasks: [{ task_name: "a", task: "b" }] }).success).toBe(false);
    expect(params.safeParse({ tasks: [{ task_name: "a", task: "b", agent: "owl" }] }).success).toBe(
      true,
    );
  });

  it("accepts any name when no agents are configured", () => {
    const spawn = createSubAgentControlTools(fakeManager([])).find(
      (tool) => tool.name === "spawn_agent",
    )!;
    const params = spawn.parameters as unknown as {
      safeParse(value: unknown): { success: boolean };
    };

    expect(
      params.safeParse({ tasks: [{ task_name: "a", task: "b", agent: "hawk" }] }).success,
    ).toBe(true);
  });

  it("starts every task in one call and returns one result per task, in order", async () => {
    const manager = fakeManager();
    const spawn = createSubAgentControlTools(manager).find((tool) => tool.name === "spawn_agent")!;

    const out = (await spawn.execute(
      {
        tasks: [
          { task_name: "a", task: "one" },
          { task_name: "b", task: "two", agent: "owl" },
        ],
      },
      context,
    )) as { content: string };

    expect(manager.spawn).toHaveBeenNthCalledWith(1, "a", "one", undefined);
    expect(manager.spawn).toHaveBeenNthCalledWith(2, "b", "two", "owl");
    expect(JSON.parse(out.content).map((r: { task_name: string }) => r.task_name)).toEqual([
      "a",
      "b",
    ]);
  });

  it("forwards a task's acceptance checks to the manager", async () => {
    const manager = fakeManager();
    const spawn = createSubAgentControlTools(manager).find((tool) => tool.name === "spawn_agent")!;
    const checks = [{ type: "command_passed" as const, target: "pnpm test" }];

    await spawn.execute({ tasks: [{ task_name: "a", task: "one", checks }] }, context);

    expect(manager.spawn).toHaveBeenCalledWith("a", "one", undefined, { checks });
  });

  it("forwards the files a task needs, so the child starts with their contents", async () => {
    const manager = fakeManager();
    const spawn = createSubAgentControlTools(manager).find((tool) => tool.name === "spawn_agent")!;
    await spawn.execute(
      { tasks: [{ task_name: "a", task: "one", context_files: ["/p/a.js"] }] },
      context,
    );
    expect(manager.spawn).toHaveBeenCalledWith("a", "one", undefined, {
      contextFiles: ["/p/a.js"],
    });
  });

  it("reports a failed start in place and still starts the others", async () => {
    const manager = fakeManager();
    vi.mocked(manager.spawn).mockImplementation(async (taskName: string) => {
      if (taskName === "bad") throw new Error("At most 8 agents may run at once");
      return { agent_id: "12345678", task_name: taskName, state: "running" } as never;
    });
    const spawn = createSubAgentControlTools(manager).find((tool) => tool.name === "spawn_agent")!;

    const out = (await spawn.execute(
      {
        tasks: [
          { task_name: "ok", task: "x" },
          { task_name: "bad", task: "y" },
        ],
      },
      context,
    )) as { content: string };

    expect(JSON.parse(out.content)).toEqual([
      { agent_id: "12345678", task_name: "ok", state: "running" },
      { task_name: "bad", error: "At most 8 agents may run at once" },
    ]);
  });

  it("fails the call when no task starts, like a single failed spawn", async () => {
    const manager = fakeManager();
    vi.mocked(manager.spawn).mockRejectedValue(new Error('Unknown agent: "hawk"'));
    const spawn = createSubAgentControlTools(manager).find((tool) => tool.name === "spawn_agent")!;

    await expect(
      spawn.execute({ tasks: [{ task_name: "a", task: "x" }] }, context),
    ).rejects.toThrow(/No agent started.*Unknown agent/);
  });

  it("states wait_agent's real budgets in its schema", () => {
    const wait = createSubAgentControlTools(fakeManager()).find(
      (tool) => tool.name === "wait_agent",
    )!;
    const shape = (
      wait.parameters as unknown as { shape: Record<string, { description?: string }> }
    ).shape;

    expect(shape.timeout_ms.description).toBe(`Default ${DEFAULT_WAIT_MS}; max ${MAX_WAIT_MS}`);
  });

  it("launches through the manager and blocks mutating lifecycle calls in plan mode", async () => {
    const manager = fakeManager();
    const planModeRef = { current: false };
    const tools = createSubAgentControlTools(manager, planModeRef);
    const spawn = tools.find((tool) => tool.name === "spawn_agent")!;
    await expect(
      spawn.execute({ tasks: [{ task_name: "scan", task: "inspect" }] }, context),
    ).resolves.toMatchObject({ content: expect.stringContaining("12345678") });
    expect(manager.spawn).toHaveBeenCalledWith("scan", "inspect", undefined);

    planModeRef.current = true;
    await expect(
      spawn.execute({ tasks: [{ task_name: "blocked", task: "write" }] }, context),
    ).resolves.toContain("plan mode");
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("lets read-only agents research in plan mode but blocks ones that can edit", async () => {
    const roster = [
      ...ROSTER,
      {
        name: "bee",
        description: "Edits",
        tools: ["read", "edit"],
        systemPrompt: "Edit.",
        source: "bundled" as const,
      },
    ];
    const manager = fakeManager(roster);
    const tools = createSubAgentControlTools(manager, { current: true });
    const spawn = tools.find((tool) => tool.name === "spawn_agent")!;

    await expect(
      spawn.execute({ tasks: [{ task_name: "scan", task: "inspect", agent: "owl" }] }, context),
    ).resolves.toMatchObject({ content: expect.stringContaining("12345678") });
    const refused = await spawn.execute(
      { tasks: [{ task_name: "fix", task: "edit", agent: "bee" }] },
      context,
    );
    expect(refused).toContain("restricted in plan mode");
    expect(refused).toContain("Only read-only agents can run in plan mode: owl.");
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("subagent control results stay lean for the parent model", () => {
  const full = {
    agent_id: "12345678",
    task_name: "review",
    state: "completed",
    started_at: 1,
    updated_at: 2,
    elapsed_ms: 1,
    turn_count: 1,
    tool_use_count: 2,
    token_usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6 },
    output: "CLEAR",
    receipt: "Receipt (0 calls): no tool calls",
    acceptance: "1/1 passed",
    agent_name: "owl",
    provider: "anthropic",
    model: "m",
    child_session_id: "sid",
    child_session_path: "/t.jsonl",
    collected: true,
  };

  it("wait_agent keeps output, receipt, acceptance and the transcript path once", async () => {
    const manager = fakeManager();
    (manager.wait as ReturnType<typeof vi.fn>).mockResolvedValue({
      timed_out: false,
      agents: [full],
    });
    const wait = createSubAgentControlTools(manager).find((t) => t.name === "wait_agent")!;
    const result = (await wait.execute({}, context)) as { content: string };
    const agent = JSON.parse(result.content).agents[0];
    expect(agent).toMatchObject({
      output: "CLEAR",
      receipt: full.receipt,
      acceptance: "1/1 passed",
      transcript: "/t.jsonl",
      state: "completed",
    });
    for (const key of ["started_at", "child_session_id", "child_session_path", "collected"]) {
      expect(agent).not.toHaveProperty(key);
    }
  });

  it("spawn_agent returns only identity and state", async () => {
    const manager = fakeManager();
    (manager.spawn as ReturnType<typeof vi.fn>).mockResolvedValue(full);
    const spawn = createSubAgentControlTools(manager).find((t) => t.name === "spawn_agent")!;
    const result = (await spawn.execute(
      { tasks: [{ task_name: "review", task: "t", agent: "owl" }] },
      context,
    )) as { content: string };
    expect(JSON.parse(result.content)).toEqual([
      {
        agent_id: "12345678",
        task_name: "review",
        state: "completed",
        agent_name: "owl",
        model: "m",
      },
    ]);
  });
});
