import { describe, expect, it } from "vitest";
import type { Message, ToolResult } from "@kenkaiiii/gg-ai";
import { pruneStaleToolResults } from "./tool-result-pruner.js";

function toolTurn(
  id: string,
  name: string,
  args: Record<string, unknown>,
  output: string,
): Message[] {
  return [
    { role: "assistant", content: [{ type: "tool_call", id, name, args }] },
    { role: "tool", content: [{ type: "tool_result", toolCallId: id, content: output }] },
  ];
}

function resultOf(messages: Message[], toolCallId: string): ToolResult {
  for (const msg of messages) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "tool_result" && part.toolCallId === toolCallId) return part;
    }
  }
  throw new Error(`missing tool result ${toolCallId}`);
}

describe("pruneStaleToolResults", () => {
  it("stubs superseded reads outside the protect turns", () => {
    const messages: Message[] = [
      { role: "user", content: "turn 1" },
      ...toolTurn("old-read", "read", { file_path: "src/a.ts" }, "x".repeat(40_000)),
      { role: "assistant", content: "ok" },
      { role: "user", content: "turn 2" },
      ...toolTurn("new-read", "read", { file_path: "src/a.ts" }, "fresh content"),
      { role: "user", content: "turn 3" },
    ];

    const result = pruneStaleToolResults(messages, { minimumTokens: 1_000 });

    expect(result.pruned).toBe(true);
    expect(result.prunedResults).toBe(1);
    expect(resultOf(messages, "old-read").content).toContain("superseded by a newer read");
    expect(resultOf(messages, "old-read").content).toContain("src/a.ts");
    expect(resultOf(messages, "new-read").content).toBe("fresh content");
  });

  it("does not treat different read ranges of the same file as superseded", () => {
    const messages: Message[] = [
      { role: "user", content: "turn 1" },
      ...toolTurn(
        "head",
        "read",
        { file_path: "src/a.ts", offset: 1, limit: 100 },
        "h".repeat(30_000),
      ),
      { role: "user", content: "turn 2" },
      ...toolTurn(
        "tail",
        "read",
        { file_path: "src/a.ts", offset: 500, limit: 100 },
        "t".repeat(200),
      ),
      { role: "user", content: "turn 3" },
      { role: "user", content: "turn 4" },
    ];

    const result = pruneStaleToolResults(messages, {
      protectTokens: 100_000,
      minimumTokens: 1_000,
    });

    // Different ranges: nothing is superseded, and the protect budget covers both.
    expect(result.pruned).toBe(false);
    expect(resultOf(messages, "head").content).toBe("h".repeat(30_000));
  });

  it("stubs old tool output beyond the protect budget, keeping recent output verbatim", () => {
    const messages: Message[] = [
      { role: "user", content: "turn 1" },
      ...toolTurn("oldest", "bash", { command: "ls" }, "o".repeat(50_000)),
      { role: "user", content: "turn 2" },
      ...toolTurn("recent", "bash", { command: "pwd" }, "r".repeat(30_000)),
      { role: "user", content: "turn 3" },
      { role: "user", content: "turn 4" },
    ];

    const result = pruneStaleToolResults(messages, {
      protectTokens: 10_000,
      minimumTokens: 1_000,
    });

    expect(result.pruned).toBe(true);
    // "recent" fills the 10k protect budget; "oldest" overflows it.
    expect(resultOf(messages, "recent").content).toBe("r".repeat(30_000));
    expect(resultOf(messages, "oldest").content).toContain("old tool output");
    expect(resultOf(messages, "oldest").content).toContain("Re-run the tool");
  });

  it("never touches tool output inside the protected recent turns", () => {
    const messages: Message[] = [
      { role: "user", content: "turn 1" },
      ...toolTurn("latest", "bash", { command: "ls" }, "z".repeat(200_000)),
    ];

    const result = pruneStaleToolResults(messages, {
      protectTokens: 1,
      minimumTokens: 1,
    });

    expect(result.pruned).toBe(false);
    expect(resultOf(messages, "latest").content).toBe("z".repeat(200_000));
  });

  it("holds the batch until the minimum freed-token threshold is met", () => {
    const messages: Message[] = [
      { role: "user", content: "turn 1" },
      ...toolTurn("small", "bash", { command: "ls" }, "s".repeat(2_000)),
      { role: "user", content: "turn 2" },
      { role: "user", content: "turn 3" },
    ];

    const result = pruneStaleToolResults(messages, {
      protectTokens: 100,
      minimumTokens: 20_000,
    });

    expect(result.pruned).toBe(false);
    expect(resultOf(messages, "small").content).toBe("s".repeat(2_000));
  });

  it("is idempotent: stubs are never re-pruned or re-counted", () => {
    const messages: Message[] = [
      { role: "user", content: "turn 1" },
      ...toolTurn("old", "bash", { command: "ls" }, "x".repeat(120_000)),
      { role: "user", content: "turn 2" },
      { role: "user", content: "turn 3" },
    ];

    const first = pruneStaleToolResults(messages, { protectTokens: 100, minimumTokens: 1_000 });
    const stub = resultOf(messages, "old").content;
    const second = pruneStaleToolResults(messages, { protectTokens: 100, minimumTokens: 1 });

    expect(first.pruned).toBe(true);
    expect(second.pruned).toBe(false);
    expect(resultOf(messages, "old").content).toBe(stub);
  });

  it("skips structured (non-string) tool results", () => {
    const messages: Message[] = [
      { role: "user", content: "turn 1" },
      { role: "assistant", content: [{ type: "tool_call", id: "img", name: "read", args: {} }] },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "img",
            content: [{ type: "text", text: "t".repeat(100_000) }],
          },
        ],
      },
      { role: "user", content: "turn 2" },
      { role: "user", content: "turn 3" },
    ];

    const result = pruneStaleToolResults(messages, { protectTokens: 1, minimumTokens: 1 });

    expect(result.pruned).toBe(false);
  });

  it("preserves message and array identity (anchors stay valid)", () => {
    const messages: Message[] = [
      { role: "user", content: "turn 1" },
      ...toolTurn("old", "bash", { command: "ls" }, "x".repeat(120_000)),
      { role: "assistant", content: "anchor" },
      { role: "user", content: "turn 2" },
      { role: "user", content: "turn 3" },
    ];
    const anchor = messages[3];
    const toolMsg = messages[2];

    pruneStaleToolResults(messages, { protectTokens: 100, minimumTokens: 1_000 });

    expect(messages[3]).toBe(anchor);
    expect(messages[2]).toBe(toolMsg);
  });
});
