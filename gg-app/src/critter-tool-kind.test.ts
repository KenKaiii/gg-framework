import { describe, expect, it } from "vitest";
import { toolKindOf, type ToolKind } from "./critter-tool-kind";

describe("toolKindOf", () => {
  const cases: readonly (readonly [string | undefined, ToolKind | null])[] = [
    // Humanized (formatToolActivity)
    ["Reading src/app.ts", "read"],
    ["Writing src/new.ts", "edit"],
    ["Editing src/app.ts", "edit"],
    ['Searching for "createCritterFloor"', "search"],
    ['Finding "**/*.ts"', "search"],
    ["Listing src", "read"],
    ["Running pnpm test", "run"],
    ["Fetching https://example.com", "web"],
    ["Resolving source for zod", "search"],
    ["Reading task output abc123", null],
    ["Stopping task abc123", null],
    ["Searching web for vitest fake timers", "web"],
    ["Loading skill release", "read"],
    ["mcp__thing: detail", null],
    ["custom_tool", null],
    // Raw (subagent-manager activity())
    ["read: /a/b.ts", "read"],
    ["ls: /a", "read"],
    ["bash: pnpm test", "run"],
    ["grep: foo", "search"],
    ["find: **/*.md", "search"],
    ["edit: /a/b.ts", "edit"],
    ["write: /a/b.ts", "edit"],
    ["web_fetch: https://example.com", "web"],
    ["web_search: query", "web"],
    ["task_output: abc", null],
    ["bash", "run"],
    ["read", "read"],
    ["unknown_tool: x", null],
    // Edge cases
    [undefined, null],
    ["", null],
    ["   ", null],
    ["Readingish", null],
    ["toString", null],
  ];

  it.each(cases)("%j → %j", (activity, kind) => {
    expect(toolKindOf(activity)).toBe(kind);
  });
});
