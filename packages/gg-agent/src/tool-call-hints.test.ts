import { describe, expect, it } from "vitest";
import { z } from "zod";
import { argumentHints, closestName, unknownToolMessage } from "./tool-call-hints.js";
import type { AgentTool } from "./types.js";

const TOOLS = ["bash", "read", "write", "edit", "grep", "find", "web_fetch", "tool_search"];

function makeTool(parameters: z.ZodType): AgentTool {
  return {
    name: "read",
    description: "Read a file",
    parameters,
    execute: async () => "",
  };
}

describe("closestName", () => {
  it.each([
    ["Bash", "bash"],
    ["READ", "read"],
    ["webFetch", "web_fetch"],
    ["web-fetch", "web_fetch"],
    ["grepp", "grep"],
    ["wirte", "write"],
  ])("maps %s to %s", (input, expected) => {
    expect(closestName(input, TOOLS)).toBe(expected);
  });

  it("returns undefined when nothing is close", () => {
    expect(closestName("deploy_to_production", TOOLS)).toBeUndefined();
    expect(closestName("", TOOLS)).toBeUndefined();
  });

  it("does not match a short name to an unrelated short name", () => {
    expect(closestName("ls", TOOLS)).toBeUndefined();
  });
});

describe("unknownToolMessage", () => {
  it("suggests the close match", () => {
    expect(unknownToolMessage("Bash", TOOLS)).toBe("Unknown tool: Bash. Did you mean `bash`?");
  });

  it("lists available tools and points at tool_search when nothing matches", () => {
    const message = unknownToolMessage("screenshot", TOOLS);
    expect(message).toContain("Unknown tool: screenshot. Available tools: bash, edit,");
    expect(message).toContain("call `tool_search`");
  });

  it("omits the tool_search pointer when that tool is not registered", () => {
    expect(unknownToolMessage("screenshot", ["bash"])).toBe(
      "Unknown tool: screenshot. Available tools: bash.",
    );
  });
});

describe("argumentHints", () => {
  const schema = z.object({
    file_path: z.string(),
    limit: z.number().optional(),
    mode: z.enum(["text", "hex"]).optional(),
    tags: z.array(z.string()).optional(),
  });

  it("describes the expected shape with optional markers", () => {
    expect(argumentHints(makeTool(schema), { file_path: "a" })).toBe(
      'Expected arguments: { file_path: string, limit?: number, mode?: "text" | "hex", tags?: string[] }',
    );
  });

  it("names the field an unknown key most likely meant", () => {
    const hints = argumentHints(makeTool(schema), { filePath: "a", bogus_key: 1 });
    expect(hints).toContain("Unknown field `filePath` — did you mean `file_path`?");
    expect(hints).toContain("Unknown field `bogus_key` is not a parameter of this tool.");
  });

  it("uses the raw JSON schema of MCP tools", () => {
    const tool: AgentTool = {
      ...makeTool(z.any()),
      rawInputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    };
    expect(argumentHints(tool, { q: "x" })).toContain("Expected arguments: { query: string }");
  });

  it("reports a no-argument tool", () => {
    expect(argumentHints(makeTool(z.object({})), {})).toBe("Expected arguments: none.");
  });
});
