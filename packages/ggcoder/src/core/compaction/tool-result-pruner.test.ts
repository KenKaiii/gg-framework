import { describe, expect, it } from "vitest";
import type { ContentPart, Message, ToolCall, ToolResult } from "@kenkaiiii/gg-ai";
import {
  pruneStaleToolResults,
  shouldPruneToolResults,
  stablePrefixEnd,
} from "./tool-result-pruner.js";

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

function callOf(messages: Message[], toolCallId: string): ToolCall {
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content as ContentPart[]) {
      if (part.type === "tool_call" && part.id === toolCallId) return part;
    }
  }
  throw new Error(`missing tool call ${toolCallId}`);
}

describe("pruneStaleToolResults", () => {
  it("stubs superseded reads outside the protected tool batches", () => {
    const messages: Message[] = [
      { role: "user", content: "turn 1" },
      ...toolTurn("old-read", "read", { file_path: "src/a.ts" }, "x".repeat(40_000)),
      { role: "assistant", content: "ok" },
      { role: "user", content: "turn 2" },
      ...toolTurn("new-read", "read", { file_path: "src/a.ts" }, "fresh content"),
      { role: "user", content: "turn 3" },
    ];

    const result = pruneStaleToolResults(messages, {
      minimumTokens: 1_000,
      protectToolBatches: 1,
    });

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
      protectToolBatches: 1,
    });

    expect(result.pruned).toBe(true);
    // "recent" fills the 10k protect budget; "oldest" overflows it.
    expect(resultOf(messages, "recent").content).toBe("r".repeat(30_000));
    expect(resultOf(messages, "oldest").content).toContain("old tool output");
    expect(resultOf(messages, "oldest").content).toContain("Re-run the tool");
  });

  it("never touches tool output inside the protected recent batches", () => {
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

  it("caps large completed tool arguments outside the protected batches", () => {
    const oldContent = "old".repeat(40_000);
    const recentContent = "recent".repeat(20_000);
    const messages: Message[] = [
      { role: "user", content: "implement several files" },
      ...toolTurn("old-write", "write", { file_path: "old.ts", content: oldContent }, "ok"),
      ...toolTurn(
        "recent-write",
        "write",
        { file_path: "recent.ts", content: recentContent },
        "ok",
      ),
      ...toolTurn("latest", "grep", { pattern: "done" }, "done"),
    ];

    const first = pruneStaleToolResults(messages, {
      protectTokens: 100_000,
      minimumTokens: 1,
      protectToolBatches: 2,
    });
    const compacted = callOf(messages, "old-write").args.content as string;

    expect(first.pruned).toBe(true);
    expect(first.prunedResults).toBe(0);
    expect(first.compactedToolCalls).toBe(1);
    expect(compacted.length).toBeLessThan(oldContent.length);
    expect(compacted).toContain("more characters truncated");
    expect(callOf(messages, "recent-write").args.content).toBe(recentContent);

    const second = pruneStaleToolResults(messages, {
      protectTokens: 100_000,
      minimumTokens: 1,
      protectToolBatches: 2,
    });
    expect(second.pruned).toBe(false);
    expect(callOf(messages, "old-write").args.content).toBe(compacted);
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
      protectToolBatches: 0,
    });

    expect(result.pruned).toBe(false);
    expect(resultOf(messages, "small").content).toBe("s".repeat(2_000));
  });

  it("bounds tool output during one long autonomous user turn", () => {
    const messages: Message[] = [{ role: "user", content: "research then implement" }];

    for (let batch = 1; batch <= 12; batch++) {
      messages.push(
        ...toolTurn(
          `batch-${batch}`,
          "read",
          { file_path: `repo/${batch}.ts` },
          "x".repeat(100_000),
        ),
      );
      pruneStaleToolResults(messages, {
        protectTokens: 40_000,
        minimumTokens: 20_000,
        protectToolBatches: 2,
      });
    }

    const verbatimResults = Array.from({ length: 12 }, (_, index) =>
      resultOf(messages, `batch-${index + 1}`),
    ).filter((result) => !result.content.toString().startsWith("[Pruned:"));
    // Two protected batches plus one older result fitting inside the 40k-token budget.
    expect(verbatimResults).toHaveLength(3);
    expect(resultOf(messages, "batch-10").content).toBe("x".repeat(100_000));
    expect(resultOf(messages, "batch-11").content).toBe("x".repeat(100_000));
    expect(resultOf(messages, "batch-12").content).toBe("x".repeat(100_000));
    expect(resultOf(messages, "batch-1").content).toContain("old tool output");
  });

  it("treats parallel tool results as one provider batch", () => {
    const messages: Message[] = [
      { role: "user", content: "research in parallel" },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "parallel-a", name: "grep", args: { pattern: "a" } },
          { type: "tool_call", id: "parallel-b", name: "grep", args: { pattern: "b" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "parallel-a", content: "a".repeat(100_000) },
          { type: "tool_result", toolCallId: "parallel-b", content: "b".repeat(100_000) },
        ],
      },
      ...toolTurn("latest", "read", { file_path: "src/latest.ts" }, "latest"),
    ];

    const result = pruneStaleToolResults(messages, {
      protectTokens: 1,
      minimumTokens: 1,
      protectToolBatches: 2,
    });

    expect(result.pruned).toBe(false);
    expect(resultOf(messages, "parallel-a").content).toBe("a".repeat(100_000));
    expect(resultOf(messages, "parallel-b").content).toBe("b".repeat(100_000));
  });

  it("is idempotent: stubs are never re-pruned or re-counted", () => {
    const messages: Message[] = [
      { role: "user", content: "turn 1" },
      ...toolTurn("old", "bash", { command: "ls" }, "x".repeat(120_000)),
      { role: "user", content: "turn 2" },
      { role: "user", content: "turn 3" },
    ];

    const first = pruneStaleToolResults(messages, {
      protectTokens: 100,
      minimumTokens: 1_000,
      protectToolBatches: 0,
    });
    const stub = resultOf(messages, "old").content;
    const second = pruneStaleToolResults(messages, {
      protectTokens: 100,
      minimumTokens: 1,
      protectToolBatches: 0,
    });

    expect(first.pruned).toBe(true);
    expect(second.pruned).toBe(false);
    expect(resultOf(messages, "old").content).toBe(stub);
  });

  it("never prunes skill output, which is instruction rather than reproducible data", () => {
    const messages: Message[] = [
      { role: "user", content: "turn 1" },
      ...toolTurn("skill-load", "skill", { skill: "evidence-led-ui" }, "s".repeat(120_000)),
      { role: "user", content: "turn 2" },
      ...toolTurn("old-bash", "bash", { command: "ls" }, "o".repeat(120_000)),
      { role: "user", content: "turn 3" },
      { role: "user", content: "turn 4" },
    ];

    const result = pruneStaleToolResults(messages, {
      protectTokens: 100,
      minimumTokens: 1_000,
      protectToolBatches: 0,
    });

    expect(result.pruned).toBe(true);
    expect(result.prunedResults).toBe(1);
    expect(resultOf(messages, "skill-load").content).toBe("s".repeat(120_000));
    expect(resultOf(messages, "old-bash").content).toContain("old tool output");
  });

  it("stops scanning at the first stub outside the protected batches", () => {
    const messages: Message[] = [
      { role: "user", content: "turn 1" },
      ...toolTurn("oldest", "bash", { command: "ls" }, "o".repeat(120_000)),
      { role: "user", content: "turn 2" },
      ...toolTurn("middle", "bash", { command: "pwd" }, "m".repeat(120_000)),
      { role: "user", content: "turn 3" },
    ];

    const opts = { protectTokens: 100, minimumTokens: 1_000, protectToolBatches: 0 };
    expect(pruneStaleToolResults(messages, opts).prunedResults).toBe(2);

    // Fresh output arrives; the older half is already stubbed, so the second
    // pass must stop at "middle" rather than re-walking the whole transcript.
    messages.push(...toolTurn("newest", "bash", { command: "env" }, "n".repeat(120_000)));
    const second = pruneStaleToolResults(messages, opts);

    expect(second.pruned).toBe(true);
    expect(second.prunedResults).toBe(1);
    expect(resultOf(messages, "newest").content).toContain("old tool output");
    expect(resultOf(messages, "oldest").content).toContain("old tool output");
  });

  it("does not let a superseded-read stub strand older output behind it", () => {
    // A read dedup stub is written regardless of the token budget, so it can
    // sit in front of results that are still verbatim. Stopping the backwards
    // walk at one would strand them permanently.
    const messages: Message[] = [
      { role: "user", content: "turn 1" },
      ...toolTurn("old-bash", "bash", { command: "ls" }, "o".repeat(400_000)),
      { role: "user", content: "turn 2" },
      ...toolTurn("read-1", "read", { file_path: "/a.ts" }, "a".repeat(1_000)),
      { role: "user", content: "turn 3" },
      ...toolTurn("read-2", "read", { file_path: "/a.ts" }, "a".repeat(1_000)),
      { role: "user", content: "turn 4" },
    ];

    // A protect budget this large spares the bash output, so only the
    // superseded read is stubbed on the first pass.
    const first = pruneStaleToolResults(messages, {
      protectTokens: 500_000,
      minimumTokens: 100,
      protectToolBatches: 0,
    });
    expect(first.prunedResults).toBe(1);
    expect(resultOf(messages, "old-bash").content).toBe("o".repeat(400_000));

    // Now the budget is tight: the older bash output must still be reachable.
    const second = pruneStaleToolResults(messages, {
      protectTokens: 100,
      minimumTokens: 1_000,
      protectToolBatches: 0,
    });
    expect(second.pruned).toBe(true);
    expect(resultOf(messages, "old-bash").content).toContain("old tool output");
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

    pruneStaleToolResults(messages, {
      protectTokens: 100,
      minimumTokens: 1_000,
      protectToolBatches: 0,
    });

    expect(messages[3]).toBe(anchor);
    expect(messages[2]).toBe(toolMsg);
  });
});

describe("stablePrefixEnd", () => {
  const opts = { protectTokens: 40_000, minimumTokens: 20_000, protectToolBatches: 2 };

  it("is undefined until something was pruned for size", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      ...toolTurn("a", "read", { file_path: "a.ts" }, "x".repeat(1_000)),
    ];
    pruneStaleToolResults(messages, opts);
    expect(stablePrefixEnd(messages)).toBeUndefined();
  });

  it("points before the newest size stub, and later prunes never change anything up to it", () => {
    const messages: Message[] = [{ role: "user", content: "long run" }];
    let checked = 0;
    for (let batch = 1; batch <= 30; batch++) {
      // re-reads (superseded stubs) and large write arguments (capped args) included
      const turn =
        batch % 5 === 0
          ? toolTurn(
              `w${batch}`,
              "write",
              { file_path: "out.ts", content: "y".repeat(40_000) },
              "ok",
            )
          : toolTurn(`r${batch}`, "read", { file_path: `f${batch % 4}.ts` }, "z".repeat(60_000));
      messages.push(...turn);
      const end = stablePrefixEnd(messages);
      const frozen = end && JSON.stringify(messages.slice(0, messages.indexOf(end) + 1));
      pruneStaleToolResults(messages, opts);
      if (end && frozen) {
        checked++;
        expect(JSON.stringify(messages.slice(0, messages.indexOf(end) + 1))).toBe(frozen);
      }
    }
    expect(checked).toBeGreaterThan(20);
    const end = stablePrefixEnd(messages);
    const stub = messages.findIndex(
      (m, i) =>
        i > messages.indexOf(end!) &&
        m.role === "tool" &&
        String(m.content[0]?.content).startsWith("[Pruned: old tool output"),
    );
    // the anchor is the user/tool message just before the newest size stub
    expect(
      messages.slice(messages.indexOf(end!) + 1, stub).every((m) => m.role === "assistant"),
    ).toBe(true);
  });
});

describe("shouldPruneToolResults", () => {
  it("prunes only from half of the compaction trigger up", () => {
    // 117k of an 850k trigger (a live 1M-window goal) is not worth a cache rewrite.
    expect(shouldPruneToolResults(117_000, 850_000)).toBe(false);
    expect(shouldPruneToolResults(425_000, 850_000)).toBe(true);
    expect(shouldPruneToolResults(160_000, 170_000)).toBe(true);
  });
});
