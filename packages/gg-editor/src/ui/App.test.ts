import { describe, expect, it } from "vitest";
import { formatAgentError, parseModelSelection } from "./App.js";

describe("parseModelSelection", () => {
  it("parses shared ModelSelector provider:model values", () => {
    expect(parseModelSelection("openai:gpt-5.5")).toEqual({
      provider: "openai",
      model: "gpt-5.5",
    });
  });

  it("keeps bare model ids for backward compatibility", () => {
    expect(parseModelSelection("claude-sonnet-4-6")).toEqual({ model: "claude-sonnet-4-6" });
  });

  it("rejects malformed selector values", () => {
    expect(parseModelSelection("")).toBeUndefined();
    expect(parseModelSelection("openai:")).toBeUndefined();
    expect(parseModelSelection(":gpt-5.5")).toBeUndefined();
  });
});

describe("formatAgentError", () => {
  it("turns run errors into recoverable UI text", () => {
    expect(formatAgentError(new Error("permission_error"))).toContain("Agent request failed");
    expect(formatAgentError(new Error("permission_error"))).toContain("/model");
  });
});
