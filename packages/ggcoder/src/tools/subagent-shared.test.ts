import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../core/agents.js";
import {
  resolveAgentDefinition,
  resolveSubAgentCliEntry,
  selectSubAgent,
  subAgentCacheKey,
} from "./subagent-shared.js";

describe("selectSubAgent", () => {
  it("keeps shell-capable agents on the parent model", () => {
    const shellAgent: AgentDefinition = {
      name: "worker",
      description: "Can mutate through shell commands",
      tools: ["read", "bash"],
      systemPrompt: "Work on the task.",
      source: "bundled",
    };

    expect(selectSubAgent([shellAgent], "worker", "openai", "gpt-5.6-sol").model).toBe(
      "gpt-5.6-sol",
    );
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
    expect(subAgentCacheKey("parent", "gpt-5.6-luna", "owl")).toBe(
      "parent:subagent:gpt-5.6-luna:owl",
    );
    expect(subAgentCacheKey("parent", "gpt-5.6-luna", "owl")).toBe(
      subAgentCacheKey("parent", "gpt-5.6-luna", "owl"),
    );
  });

  it("partitions unrelated model and prompt families", () => {
    const owl = subAgentCacheKey("parent", "gpt-5.6-luna", "owl");
    expect(subAgentCacheKey("parent", "gpt-5.6-sol", "owl")).not.toBe(owl);
    expect(subAgentCacheKey("parent", "gpt-5.6-luna", "bee")).not.toBe(owl);
  });

  it("stays unset when the parent has no stable cache identity", () => {
    expect(subAgentCacheKey(undefined, "gpt-5.6-luna", "owl")).toBeUndefined();
  });
});

describe("resolveSubAgentCliEntry", () => {
  it("keeps app subagent workers behind the monitored sidecar entry", () => {
    expect(
      resolveSubAgentCliEntry({ GG_SUBAGENT_WORKER_ENTRY: "/app/error-mom-sidecar.mjs" }),
    ).toBe("/app/error-mom-sidecar.mjs");
  });
});
