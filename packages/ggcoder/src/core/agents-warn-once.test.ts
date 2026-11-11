import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as LoggerModule from "./logger.js";

const logMock = vi.hoisted(() => vi.fn());

vi.mock("./logger.js", async () => {
  const actual = await vi.importActual<typeof LoggerModule>("./logger.js");
  return { ...actual, log: logMock };
});

const { validateAgentTools } = await import("./agents.js");

const agent = (tools: string[]) =>
  ({ name: "verifier", description: "d", systemPrompt: "x", source: "project", tools }) as const;

describe("validateAgentTools warning", () => {
  beforeEach(() => logMock.mockClear());

  it("warns once per agent file, however often agents are re-discovered", () => {
    // Regression: every new session re-read .gg/agents and repeated the same WARN.
    for (let i = 0; i < 3; i++) {
      expect(
        validateAgentTools(agent(["read", "code_search"]), "/p/.gg/agents/verifier.md"),
      ).toEqual(["code_search"]);
    }
    expect(logMock).toHaveBeenCalledTimes(1);
    expect(logMock).toHaveBeenCalledWith(
      "WARN",
      "agents",
      "Agent lists unknown tools; they will be ignored",
      { agent: "verifier", origin: "/p/.gg/agents/verifier.md", unknown: ["code_search"] },
    );
  });

  it("still warns for another file, and again when a file's unknown tools change", () => {
    validateAgentTools(agent(["code_nav"]), "/p/.gg/agents/one.md");
    validateAgentTools(agent(["code_nav"]), "/p/.gg/agents/two.md");
    validateAgentTools(agent(["code_nav", "webfetch"]), "/p/.gg/agents/one.md");
    expect(logMock).toHaveBeenCalledTimes(3);
  });
});
