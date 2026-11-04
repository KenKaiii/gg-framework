import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../core/agents.js";
import { getSupportedThinkingLevels } from "../core/thinking-level.js";
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
  it.each([
    ["inherit", agent({ name: "worker", tools: ["read", "bash"], model: "inherit" })],
    ["no model policy", agent({ name: "researcher", tools: ["read", "grep", "web_fetch"] })],
    ["legacy fast", agent({ name: "owl", model: "fast" })],
  ])("keeps a %s agent on the parent model", (_label, definition) => {
    // Regression: `fast` (and, before that, inferred read-only agents) were
    // silently routed to a weaker sibling model (Haiku, Luna, flash-lite).
    expect(selectSubAgent([definition], definition.name, "openai", "gpt-6.1-sol").model).toBe(
      "gpt-6.1-sol",
    );
  });

  it.each([
    ["anthropic", "claude-opus-5-5"],
    ["gemini", "gemini-3.8-flash"],
    ["glm", "glm-5.3"],
    ["deepseek", "deepseek-v4-pro"],
  ] as const)(
    "runs every %s %s sub-agent at the model's lowest thinking level, never off",
    (provider, parentModel) => {
      const lowest = getSupportedThinkingLevels(provider, parentModel)[0];
      const agents = [
        agent({ name: "worker", tools: ["read", "bash"], model: "inherit" }),
        agent({ name: "researcher" }),
      ];

      expect(lowest).toBeDefined();
      for (const name of ["worker", "researcher", undefined]) {
        expect(selectSubAgent(agents, name, provider, parentModel).thinkingLevel, name).toBe(
          lowest,
        );
      }
    },
  );

  it.each(["low", "medium", "high", "xhigh", "max", "ultra", undefined] as const)(
    "inherits OpenAI reasoning %s for named and unnamed agents",
    (thinkingLevel) => {
      const agents = [
        agent({ name: "worker", model: "inherit" }),
        agent({ name: "owl", model: "fast" }),
      ];
      for (const model of ["gpt-6-astra", "gpt-6.1-sol"]) {
        for (const name of ["worker", "owl", undefined]) {
          expect(selectSubAgent(agents, name, "openai", model, thinkingLevel).thinkingLevel).toBe(
            thinkingLevel,
          );
        }
      }
    },
  );

  it("caps inherited Ultra for a pinned OpenAI model without Ultra", () => {
    const pinned = agent({ name: "pinned", model: "gpt-6-luna" });
    expect(selectSubAgent([pinned], "pinned", "openai", "gpt-6.1-sol", "ultra")).toMatchObject({
      model: "gpt-6-luna",
      thinkingLevel: "max",
    });
  });

  it("uses the floor rather than the ceiling when a pinned model does not support low", () => {
    const pinned = agent({ name: "pinned", model: "gpt-5.5" });
    expect(selectSubAgent([pinned], "pinned", "openai", "gpt-6.1-sol", "low").thinkingLevel).toBe(
      "medium",
    );
  });

  it("does not change other providers' child reasoning when the parent uses max", () => {
    expect(selectSubAgent([], undefined, "anthropic", "claude-opus-5-5", "max").thinkingLevel).toBe(
      "low",
    );
  });

  it("gives a sub-agent on a model that cannot reason no thinking level", () => {
    expect(
      selectSubAgent([], undefined, "huggingface", "Qwen/Qwen3-Coder-480B-A35B-Instruct")
        .thinkingLevel,
    ).toBeUndefined();
  });

  it("honours an explicit model id, at that model's lowest thinking level", () => {
    const pinned = agent({ name: "pinned", model: "claude-retired-model" });
    const pinnedLowest = getSupportedThinkingLevels("anthropic", "claude-retired-model")[0];
    // A retired model's ladder differs from Opus's, so this proves the rung follows the
    // model the child runs on, not the parent.
    expect(pinnedLowest).not.toBe(getSupportedThinkingLevels("anthropic", "claude-opus-5-5")[0]);

    expect(selectSubAgent([pinned], "pinned", "anthropic", "claude-opus-5-5")).toMatchObject({
      model: "claude-retired-model",
      thinkingLevel: pinnedLowest,
    });
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
