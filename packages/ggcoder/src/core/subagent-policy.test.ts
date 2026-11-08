import { describe, expect, it } from "vitest";
import { applyAsyncSubagentPolicy, OPENAI_SKILL_MARKER } from "./subagent-policy.js";

const TOOLS = ["bash", "skill", "spawn_agent"];

describe("OpenAI skill-loading guidance", () => {
  it("is added for OpenAI models that have the skill tool", () => {
    const prompt = applyAsyncSubagentPolicy("base", "openai", "gpt-6-luna", "medium", TOOLS);
    expect(prompt.startsWith("base")).toBe(true);
    expect(prompt).toContain(OPENAI_SKILL_MARKER);
    expect(prompt).toContain("ordinary features, bug fixes, refactors and renames need none");
    expect(prompt).toContain("one broad search");
  });

  it("leaves Anthropic and skill-less sessions unchanged", () => {
    expect(applyAsyncSubagentPolicy("base", "anthropic", "claude-haiku-5-5", "high", TOOLS)).toBe(
      "base",
    );
    expect(applyAsyncSubagentPolicy("base", "openai", "gpt-6-luna", "medium", ["bash"])).toBe(
      "base",
    );
  });

  it("sits before orchestration guidance and never stacks across switches", () => {
    let prompt = applyAsyncSubagentPolicy("base", "openai", "gpt-6.1-sol", "high", TOOLS);
    prompt = applyAsyncSubagentPolicy(prompt, "openai", "gpt-6.1-sol", "ultra", TOOLS);
    prompt = applyAsyncSubagentPolicy(prompt, "openai", "gpt-6.1-sol", "high", TOOLS);
    expect(prompt.split(OPENAI_SKILL_MARKER)).toHaveLength(2);
    expect(prompt.match(/## Async subagent orchestration/g)).toHaveLength(1);
    expect(prompt.indexOf(OPENAI_SKILL_MARKER)).toBeLessThan(
      prompt.indexOf("## Async subagent orchestration"),
    );
  });

  it("is removed when switching from OpenAI to Anthropic", () => {
    const openai = applyAsyncSubagentPolicy("base", "openai", "gpt-6-luna", "medium", TOOLS);
    expect(applyAsyncSubagentPolicy(openai, "anthropic", "claude-haiku-5-5", "high", TOOLS)).toBe(
      "base",
    );
  });
});
