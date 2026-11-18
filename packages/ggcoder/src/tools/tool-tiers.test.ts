import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { CORE_TOOL_NAMES, DEFERRED_TOOL_NAMES, partitionToolsByTier } from "./tool-tiers.js";
import { TOOL_PROMPT_HINTS, DEFAULT_TOOL_NAMES, BUILTIN_TOOL_NAMES } from "./prompt-hints.js";

const stub = (name: string): AgentTool =>
  ({
    name,
    description: `${name} description`,
    parameters: z.object({}),
    execute: async () => "",
  }) as unknown as AgentTool;

describe("tool tiers", () => {
  it("keeps the core and deferred sets disjoint", () => {
    const overlap = CORE_TOOL_NAMES.filter((n) => DEFERRED_TOOL_NAMES.includes(n));
    expect(overlap).toEqual([]);
  });

  it("has no duplicate names within a tier", () => {
    expect(new Set(CORE_TOOL_NAMES).size).toBe(CORE_TOOL_NAMES.length);
    expect(new Set(DEFERRED_TOOL_NAMES).size).toBe(DEFERRED_TOOL_NAMES.length);
  });

  it("covers every built-in name rendered by default", () => {
    const tiered = new Set([...CORE_TOOL_NAMES, ...DEFERRED_TOOL_NAMES]);
    const builtinDefaults = DEFAULT_TOOL_NAMES.filter((n) => !n.startsWith("mcp__"));
    for (const name of builtinDefaults) expect(tiered.has(name)).toBe(true);
  });

  it("assigns every registrable built-in to a tier", () => {
    const tiered = new Set([...CORE_TOOL_NAMES, ...DEFERRED_TOOL_NAMES]);
    for (const name of BUILTIN_TOOL_NAMES) expect(tiered.has(name)).toBe(true);
  });

  it("gives every deferred tool a prompt hint (its only discoverability)", () => {
    for (const name of DEFERRED_TOOL_NAMES) {
      expect(TOOL_PROMPT_HINTS[name], `missing hint for deferred tool ${name}`).toBeTruthy();
    }
  });

  it("partitions tools by tier, preserving order within each tier", () => {
    const tools = ["read", "source_path", "edit", "browser", "bash"].map(stub);
    const { core, deferred } = partitionToolsByTier(tools);
    expect(core.map((t) => t.name)).toEqual(["read", "edit", "bash"]);
    expect(deferred.map((t) => t.name)).toEqual(["source_path", "browser"]);
  });

  it("treats an unknown tool as core rather than hiding it", () => {
    const { core, deferred } = partitionToolsByTier([stub("mcp__some__tool")]);
    expect(core.map((t) => t.name)).toEqual(["mcp__some__tool"]);
    expect(deferred).toEqual([]);
  });
});
