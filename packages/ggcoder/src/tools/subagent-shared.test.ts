import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../core/agents.js";
import {
  renderAgentRoster,
  resolveAgentDefinition,
  selectSubAgent,
  spawnedTasks,
  subAgentCacheKey,
} from "./subagent-shared.js";

function agent(overrides: Partial<AgentDefinition> & { name: string }): AgentDefinition {
  return {
    description: `${overrides.name} agent`,
    tools: ["read"],
    systemPrompt: "Do the task.",
    source: "bundled",
    ...overrides,
  };
}

describe("spawnedTasks", () => {
  it.each([
    [
      "a batch call",
      {
        tasks: [
          { task_name: "a", task: "one" },
          { task_name: "b", task: "two", agent: "owl" },
        ],
      },
      [
        { task_name: "a", task: "one" },
        { task_name: "b", task: "two", agent: "owl" },
      ],
    ],
    [
      "a call saved before batch launch",
      { task_name: "scan", task: "inspect", agent: "owl" },
      [{ task_name: "scan", task: "inspect", agent: "owl" }],
    ],
    ["malformed args", null, [{}]],
    ["an empty task list", { tasks: [] }, [{}]],
    ["non-string fields", { tasks: [{ task_name: 7, task: "x" }, "junk"] }, [{ task: "x" }]],
  ])("reads %s", (_label, args, expected) => {
    expect(spawnedTasks(args)).toEqual(expected);
  });
});

describe("selectSubAgent", () => {
  it("keeps shell-capable agents on the parent model", () => {
    const shellAgent = agent({ name: "worker", tools: ["read", "bash"], model: "inherit" });

    expect(selectSubAgent([shellAgent], "worker", "openai", "gpt-6.1-sol").model).toBe(
      "gpt-6.1-sol",
    );
  });

  it("keeps a read-only agent on the parent model unless it asks for fast", () => {
    // Regression: read-only agents were inferred to be cheap and silently
    // routed to the provider's low tier, with no way to override it.
    const readOnly = agent({ name: "researcher", tools: ["read", "grep", "web_fetch"] });

    expect(selectSubAgent([readOnly], "researcher", "openai", "gpt-6.1-sol").model).toBe(
      "gpt-6.1-sol",
    );
  });

  it("downgrades only when the agent declares model: fast", () => {
    const fast = agent({ name: "owl", model: "fast" });

    expect(selectSubAgent([fast], "owl", "openai", "gpt-6.1-sol").model).not.toBe("gpt-6.1-sol");
  });

  it("honours an explicit model id", () => {
    const pinned = agent({ name: "pinned", model: "claude-haiku-4-5" });

    expect(selectSubAgent([pinned], "pinned", "anthropic", "claude-opus-5-5").model).toBe(
      "claude-haiku-4-5",
    );
  });

  it("falls back to the parent model for an unnamed agent", () => {
    expect(selectSubAgent([], undefined, "openai", "gpt-6.1-sol").model).toBe("gpt-6.1-sol");
  });
});

describe("renderAgentRoster", () => {
  it("lists every agent with its routing description", () => {
    const roster = renderAgentRoster([
      agent({ name: "owl", description: "Traces call chains" }),
      agent({ name: "bee", description: "Implements a scoped change" }),
    ]);

    expect(roster).toContain("Available named agents:");
    expect(roster).toContain("- owl: Traces call chains");
    expect(roster).toContain("- bee: Implements a scoped change");
  });

  it("says so when there is nothing to route to", () => {
    expect(renderAgentRoster([])).toContain("No named agents configured.");
  });
});

describe("resolveAgentDefinition", () => {
  it("stays case-insensitive (regression)", () => {
    const agent: AgentDefinition = {
      name: "Scout",
      description: "Recon",
      tools: ["read"],
      systemPrompt: "Scout it.",
      source: "bundled",
    };

    expect(resolveAgentDefinition([agent], "scout")).toBe(agent);
    expect(resolveAgentDefinition([agent], "SCOUT")).toBe(agent);
    expect(resolveAgentDefinition([agent], "Scout")).toBe(agent);
    expect(resolveAgentDefinition([agent], "missing")).toBeUndefined();
  });
});

describe("subAgentCacheKey", () => {
  it("shares routing within one model and named-agent family", () => {
    expect(subAgentCacheKey("parent", "gpt-6-luna", "owl")).toBe("parent:subagent:gpt-6-luna:owl");
    expect(subAgentCacheKey("parent", "gpt-6-luna", "owl")).toBe(
      subAgentCacheKey("parent", "gpt-6-luna", "owl"),
    );
  });

  it("partitions unrelated model and prompt families", () => {
    const owl = subAgentCacheKey("parent", "gpt-6-luna", "owl");
    expect(subAgentCacheKey("parent", "gpt-6.1-sol", "owl")).not.toBe(owl);
    expect(subAgentCacheKey("parent", "gpt-6-luna", "bee")).not.toBe(owl);
  });

  it("stays unset when the parent has no stable cache identity", () => {
    expect(subAgentCacheKey(undefined, "gpt-6-luna", "owl")).toBeUndefined();
  });
});
