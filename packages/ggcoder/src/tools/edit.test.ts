import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createEditTool } from "./edit.js";
import { recordRead, type ReadTracker } from "./read-tracker.js";

function resultToString(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "details" in result) {
    const details = (result as { details?: { diff?: string } }).details;
    return details?.diff ?? "";
  }
  return "";
}

async function markRead(tracker: ReadTracker, filePath: string): Promise<void> {
  const stat = await fs.stat(filePath);
  const content = await fs.readFile(filePath, "utf-8");
  recordRead(tracker, filePath, content, stat.mtimeMs);
}

describe("createEditTool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("opts into sequential agent-loop execution", () => {
    const tool = createEditTool(tmpDir);

    expect(tool.executionMode).toBe("sequential");
  });

  it("replaces exact text and returns a diff", async () => {
    const filePath = path.join(tmpDir, "hello.txt");
    await fs.writeFile(filePath, "hello world\n");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      { file_path: "hello.txt", edits: [{ old_text: "hello", new_text: "goodbye" }] },
      { signal: new AbortController().signal, toolCallId: "test-1" },
    );

    const diff = resultToString(result);
    expect(diff).toContain("-hello world");
    expect(diff).toContain("+goodbye world");

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("goodbye world\n");
  });

  it("applies multiple edits sequentially", async () => {
    const filePath = path.join(tmpDir, "multi.txt");
    await fs.writeFile(filePath, "alpha\nbeta\ngamma\n");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        file_path: "multi.txt",
        edits: [
          { old_text: "alpha", new_text: "ALPHA" },
          { old_text: "gamma", new_text: "GAMMA" },
        ],
      },
      { signal: new AbortController().signal, toolCallId: "test-multi" },
    );

    const summary = typeof result === "string" ? result : (result as { content: string }).content;
    expect(summary).toContain("2 edits");

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("ALPHA\nbeta\nGAMMA\n");
  });

  it("supports chained edits where later edits depend on earlier ones", async () => {
    const filePath = path.join(tmpDir, "chain.txt");
    await fs.writeFile(filePath, "foo\n");

    const tool = createEditTool(tmpDir);
    await tool.execute(
      {
        file_path: "chain.txt",
        edits: [
          { old_text: "foo", new_text: "bar" },
          { old_text: "bar", new_text: "baz" },
        ],
      },
      { signal: new AbortController().signal, toolCallId: "test-chain" },
    );

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("baz\n");
  });

  it("reports edit index on failure within a multi-edit batch (atomic mode)", async () => {
    const filePath = path.join(tmpDir, "batch.txt");
    await fs.writeFile(filePath, "one two three\n");

    const tool = createEditTool(tmpDir);
    await expect(
      tool.execute(
        {
          file_path: "batch.txt",
          edits: [
            { old_text: "one", new_text: "1" },
            { old_text: "missing", new_text: "x" },
          ],
          atomic: true,
        },
        { signal: new AbortController().signal, toolCallId: "test-batch" },
      ),
    ).rejects.toThrow(/edit 2\/2/);

    // Nothing should have been written — atomic
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("one two three\n");
  });

  it("returns error string in plan mode", async () => {
    const filePath = path.join(tmpDir, "plan.txt");
    await fs.writeFile(filePath, "original\n");

    const planModeRef = { current: true };
    const tool = createEditTool(tmpDir, undefined, undefined, planModeRef);
    const result = await tool.execute(
      { file_path: "plan.txt", edits: [{ old_text: "original", new_text: "modified" }] },
      { signal: new AbortController().signal, toolCallId: "test-2" },
    );

    expect(result).toContain("Error: edit is restricted in plan mode");

    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("original\n");
  });

  it("throws when file hasn't been read with readFiles tracking", async () => {
    const filePath = path.join(tmpDir, "unread.txt");
    await fs.writeFile(filePath, "content\n");

    const readFiles: ReadTracker = new Map();
    const tool = createEditTool(tmpDir, readFiles);

    await expect(
      tool.execute(
        { file_path: "unread.txt", edits: [{ old_text: "content", new_text: "new" }] },
        { signal: new AbortController().signal, toolCallId: "test-3" },
      ),
    ).rejects.toThrow("File must be read first");
  });

  it("allows edit when file is in readFiles tracker", async () => {
    const filePath = path.join(tmpDir, "tracked.txt");
    await fs.writeFile(filePath, "alpha beta\n");

    const readFiles: ReadTracker = new Map();
    await markRead(readFiles, filePath);

    const tool = createEditTool(tmpDir, readFiles);
    const result = await tool.execute(
      { file_path: "tracked.txt", edits: [{ old_text: "alpha", new_text: "gamma" }] },
      { signal: new AbortController().signal, toolCallId: "test-4" },
    );

    const diff = resultToString(result);
    expect(diff).toContain("-alpha beta");
    expect(diff).toContain("+gamma beta");

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("gamma beta\n");
  });

  it("rejects edit when the file changed since it was read", async () => {
    const filePath = path.join(tmpDir, "stale.txt");
    await fs.writeFile(filePath, "alpha\n");

    const readFiles: ReadTracker = new Map();
    await markRead(readFiles, filePath);

    // Simulate an external formatter rewriting the file (different bytes,
    // forced bumped mtime so the fast-path mtime check trips).
    await fs.writeFile(filePath, "ALPHA\n");
    const future = new Date(Date.now() + 5_000);
    await fs.utimes(filePath, future, future);

    const tool = createEditTool(tmpDir, readFiles);
    await expect(
      tool.execute(
        { file_path: "stale.txt", edits: [{ old_text: "ALPHA", new_text: "beta" }] },
        { signal: new AbortController().signal, toolCallId: "test-stale" },
      ),
    ).rejects.toThrow(/modified since/);
  });

  it("allows consecutive edits without re-reading (recordWrite refreshes)", async () => {
    const filePath = path.join(tmpDir, "consec.txt");
    await fs.writeFile(filePath, "one\ntwo\n");

    const readFiles: ReadTracker = new Map();
    await markRead(readFiles, filePath);

    const tool = createEditTool(tmpDir, readFiles);
    await tool.execute(
      { file_path: "consec.txt", edits: [{ old_text: "one", new_text: "ONE" }] },
      { signal: new AbortController().signal, toolCallId: "test-consec-1" },
    );
    // Second edit must succeed without an explicit re-read.
    await tool.execute(
      { file_path: "consec.txt", edits: [{ old_text: "two", new_text: "TWO" }] },
      { signal: new AbortController().signal, toolCallId: "test-consec-2" },
    );

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("ONE\nTWO\n");
  });

  it("appends a 'Closest match' snippet when old_text is not found", async () => {
    const filePath = path.join(tmpDir, "snippet.txt");
    await fs.writeFile(
      filePath,
      "import { useState } from 'react';\n\nexport function Counter() {\n  const [count, setCount] = useState(0);\n  return <div>{count}</div>;\n}\n",
    );

    const tool = createEditTool(tmpDir);
    await expect(
      tool.execute(
        {
          file_path: "snippet.txt",
          edits: [
            {
              old_text: "const [count, setCount] = useState(1);",
              new_text: "const [count, setCount] = useState(2);",
            },
          ],
        },
        { signal: new AbortController().signal, toolCallId: "test-snippet" },
      ),
    ).rejects.toThrow(/Closest match in file:[\s\S]*useState\(0\)/);
  });

  it("suggests a bounded re-read around the closest match when not_found", async () => {
    const filePath = path.join(tmpDir, "rehint.txt");
    await fs.writeFile(
      filePath,
      "import { useState } from 'react';\n\nexport function Counter() {\n  const [count, setCount] = useState(0);\n  return <div>{count}</div>;\n}\n",
    );

    const tool = createEditTool(tmpDir);
    // The closest match is on line 4. With ±25 lines, offset clamps to 1 and
    // limit stays at 50. The hint uses the same file_path the model passed.
    await expect(
      tool.execute(
        {
          file_path: "rehint.txt",
          edits: [
            {
              old_text: "const [count, setCount] = useState(1);",
              new_text: "const [count, setCount] = useState(2);",
            },
          ],
        },
        { signal: new AbortController().signal, toolCallId: "rehint-1" },
      ),
    ).rejects.toThrow(/Suggested re-read: `read file_path="rehint\.txt" offset=1 limit=50`/);
  });

  it("aggregates multiple edit failures into one error (atomic mode)", async () => {
    const filePath = path.join(tmpDir, "agg.txt");
    await fs.writeFile(filePath, "alpha\nbeta\ngamma\n");

    const tool = createEditTool(tmpDir);
    await expect(
      tool.execute(
        {
          file_path: "agg.txt",
          edits: [
            { old_text: "alpha", new_text: "ALPHA" },
            { old_text: "MISSING", new_text: "X" },
            { old_text: "ALSO_MISSING", new_text: "Y" },
          ],
          atomic: true,
        },
        { signal: new AbortController().signal, toolCallId: "test-agg" },
      ),
    ).rejects.toThrow(/2 of 3 edits failed[\s\S]*edit 2\/3[\s\S]*edit 3\/3/);

    // Atomic — nothing written.
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("alpha\nbeta\ngamma\n");
  });

  it("partial-apply (default): keeps successful edits and reports failures for retry", async () => {
    const filePath = path.join(tmpDir, "partial.txt");
    await fs.writeFile(filePath, "alpha\nbeta\ngamma\n");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        file_path: "partial.txt",
        edits: [
          { old_text: "alpha", new_text: "ALPHA" },
          { old_text: "MISSING", new_text: "X" },
          { old_text: "gamma", new_text: "GAMMA" },
        ],
      },
      { signal: new AbortController().signal, toolCallId: "test-partial" },
    );

    const summary = typeof result === "string" ? result : (result as { content: string }).content;
    expect(summary).toMatch(/Applied 2 of 3 edits/);
    expect(summary).toMatch(/re-issue ONLY these/);
    expect(summary).toMatch(/edit 2\/3/);
    expect(summary).not.toMatch(/edit 1\/3/);
    expect(summary).not.toMatch(/edit 3\/3/);

    // Successful edits landed; failed one didn't.
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("ALPHA\nbeta\nGAMMA\n");
  });

  it("partial-apply on a 19-edit batch with 2 failures lands the other 17", async () => {
    const filePath = path.join(tmpDir, "big.css");
    const lines = Array.from({ length: 19 }, (_, i) => `.cls${i} { color: red; }`);
    await fs.writeFile(filePath, lines.join("\n") + "\n");

    const edits = lines.map((line, i) => ({
      old_text: line,
      // Two of them deliberately drift so the batch sees real failures.
      new_text:
        i === 7 || i === 13
          ? line.replace("color: red", "color: blue")
          : line.replace("red", "green"),
    }));
    // Corrupt edits 8 (index 7) and 14 (index 13) by paraphrasing old_text.
    edits[7] = { old_text: ".cls7 { colour: red; }", new_text: ".cls7 { color: blue; }" };
    edits[13] = { old_text: ".cls13 { colur: red; }", new_text: ".cls13 { color: blue; }" };

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      { file_path: "big.css", edits },
      { signal: new AbortController().signal, toolCallId: "test-19" },
    );

    const summary = typeof result === "string" ? result : (result as { content: string }).content;
    expect(summary).toMatch(/Applied 17 of 19 edits/);
    expect(summary).toMatch(/edit 8\/19/);
    expect(summary).toMatch(/edit 14\/19/);

    const written = await fs.readFile(filePath, "utf-8");
    // 17 lines should have green, the two failed ones still red.
    expect((written.match(/color: green/g) ?? []).length).toBe(17);
    expect(written).toContain(".cls7 { color: red; }");
    expect(written).toContain(".cls13 { color: red; }");
  });

  it("throws when every edit fails even in partial-apply mode", async () => {
    const filePath = path.join(tmpDir, "all-fail.txt");
    await fs.writeFile(filePath, "untouched\n");

    const tool = createEditTool(tmpDir);
    await expect(
      tool.execute(
        {
          file_path: "all-fail.txt",
          edits: [
            { old_text: "MISSING1", new_text: "X" },
            { old_text: "MISSING2", new_text: "Y" },
          ],
        },
        { signal: new AbortController().signal, toolCallId: "test-all-fail" },
      ),
    ).rejects.toThrow(/2 of 2 edits failed/);

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("untouched\n");
  });

  it("suppresses Closest-match snippet in partial-apply when other edits succeeded", async () => {
    // Mirrors the StartingYourAgency.tsx scenario: token-heavy lines where
    // findClosestSnippet returns noisy top-of-file regions. When 17 of 19
    // edits succeed, those diffs already give the model context — the
    // snippet would just be noise.
    const filePath = path.join(tmpDir, "noisy.tsx");
    const lines = Array.from(
      { length: 6 },
      (_, i) => `      <div className="card-${i}">Section ${i}</div>`,
    );
    await fs.writeFile(filePath, lines.join("\n") + "\n");

    const edits = lines.map((line) => ({
      old_text: line,
      new_text: line.replace("card-", "glass-card-"),
    }));
    // Drift edit 4 — paraphrase the case so it doesn't match.
    edits[3] = {
      old_text: `      <div className="Card-3">Section 3</div>`,
      new_text: `      <div className="glass-card-3">Section 3</div>`,
    };

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      { file_path: "noisy.tsx", edits },
      { signal: new AbortController().signal, toolCallId: "test-suppress" },
    );

    const summary = typeof result === "string" ? result : (result as { content: string }).content;
    expect(summary).toMatch(/Applied 5 of 6/);
    expect(summary).toMatch(/edit 4\/6/);
    // The snippet would be ~3-7 lines starting with "Closest match in file:".
    // In partial-apply with successes, we suppress it.
    expect(summary).not.toMatch(/Closest match in file:/);
  });

  it("keeps Closest-match snippet when no other edit succeeded", async () => {
    // Single-edit call — no surrounding context for the model, so the snippet
    // is genuinely useful and must remain. Use overlapping tokens so the
    // closest-snippet heuristic actually fires.
    const filePath = path.join(tmpDir, "lonely.tsx");
    await fs.writeFile(
      filePath,
      "function Counter() {\n  const [count, setCount] = useState(0);\n  return count;\n}\n",
    );

    const tool = createEditTool(tmpDir);
    await expect(
      tool.execute(
        {
          file_path: "lonely.tsx",
          edits: [
            {
              old_text: "const [count, setCount] = useState(1);",
              new_text: "const [count, setCount] = useState(2);",
            },
          ],
        },
        { signal: new AbortController().signal, toolCallId: "test-keep" },
      ),
    ).rejects.toThrow(/Closest match in file:[\s\S]*useState\(0\)/);
  });

  it("atomic mode keeps Closest-match snippet (model retries against unchanged file)", async () => {
    const filePath = path.join(tmpDir, "atomic-snippet.tsx");
    const lines = Array.from(
      { length: 4 },
      (_, i) => `      <div className="card-${i}">Section ${i}</div>`,
    );
    await fs.writeFile(filePath, lines.join("\n") + "\n");

    const edits = lines.map((line) => ({
      old_text: line,
      new_text: line.replace("card-", "glass-card-"),
    }));
    edits[2] = {
      old_text: `      <div className="Card-2">Section 2</div>`,
      new_text: `      <div className="glass-card-2">Section 2</div>`,
    };

    const tool = createEditTool(tmpDir);
    await expect(
      tool.execute(
        { file_path: "atomic-snippet.tsx", edits, atomic: true },
        { signal: new AbortController().signal, toolCallId: "test-atomic-snippet" },
      ),
    ).rejects.toThrow(/Closest match in file:/);
  });

  it("indent-flex: model omits indentation entirely; file has 4-space prefix — applies it", async () => {
    const filePath = path.join(tmpDir, "indent.ts");
    await fs.writeFile(filePath, "    const x = 1;\n    const y = 2;\n    const z = 3;\n");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        file_path: "indent.ts",
        edits: [
          {
            old_text: "const x = 1;\nconst y = 2;\nconst z = 3;",
            new_text: "const x = 10;\nconst y = 20;\nconst z = 30;",
          },
        ],
      },
      { signal: new AbortController().signal, toolCallId: "test-indent-flex" },
    );

    const summary = typeof result === "string" ? result : (result as { content: string }).content;
    expect(summary).toMatch(/Successfully/);

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("    const x = 10;\n    const y = 20;\n    const z = 30;\n");
  });

  it("indent-flex: model used 2-space but file uses 4 — outdents both, re-indents new", async () => {
    const filePath = path.join(tmpDir, "mixed-indent.ts");
    await fs.writeFile(filePath, "    if (x) {\n      return y;\n    }\n");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        file_path: "mixed-indent.ts",
        edits: [
          {
            old_text: "  if (x) {\n    return y;\n  }",
            new_text: "  if (x) {\n    return z;\n  }",
          },
        ],
      },
      { signal: new AbortController().signal, toolCallId: "test-mixed-indent" },
    );

    const summary = typeof result === "string" ? result : (result as { content: string }).content;
    expect(summary).toMatch(/Successfully/);

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("    if (x) {\n      return z;\n    }\n");
  });

  it("dotdotdots: model elides middle with `...`, edit lands and middle preserved", async () => {
    const filePath = path.join(tmpDir, "elide.ts");
    await fs.writeFile(
      filePath,
      [
        "function pomodoro() {",
        "  const timer = startTimer();",
        "  trackPomodoro(timer);",
        "  scheduleBreak();",
        "  return timer;",
        "}",
      ].join("\n") + "\n",
    );

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        file_path: "elide.ts",
        edits: [
          {
            old_text: "function pomodoro() {\n  ...\n  return timer;\n}",
            new_text: "function pomodoro(): Timer {\n  ...\n  return timer;\n}",
          },
        ],
      },
      { signal: new AbortController().signal, toolCallId: "test-elide" },
    );

    const summary = typeof result === "string" ? result : (result as { content: string }).content;
    expect(summary).toMatch(/Successfully/);

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toContain("function pomodoro(): Timer {");
    // Middle preserved verbatim.
    expect(written).toContain("trackPomodoro(timer);");
    expect(written).toContain("scheduleBreak();");
  });

  it("dotdotdots: failed elision falls through to standard not_found error", async () => {
    const filePath = path.join(tmpDir, "elide-fail.ts");
    await fs.writeFile(filePath, "function actuallyExists() { return 1; }\n");

    const tool = createEditTool(tmpDir);
    await expect(
      tool.execute(
        {
          file_path: "elide-fail.ts",
          edits: [
            {
              // Bookends don't exist in the file.
              old_text: "function nonexistent() {\n  ...\n  return x;\n}",
              new_text: "function nonexistent() {\n  ...\n  return y;\n}",
            },
          ],
        },
        { signal: new AbortController().signal, toolCallId: "test-elide-fail" },
      ),
    ).rejects.toThrow(/old_text not found/);
  });

  it("rejects no-op edits where old_text equals new_text", async () => {
    const filePath = path.join(tmpDir, "noop.txt");
    await fs.writeFile(filePath, "hello world\n");

    const tool = createEditTool(tmpDir);
    await expect(
      tool.execute(
        {
          file_path: "noop.txt",
          edits: [{ old_text: "hello", new_text: "hello" }],
        },
        { signal: new AbortController().signal, toolCallId: "test-noop" },
      ),
    ).rejects.toThrow(/identical[\s\S]*no-op/);

    // File untouched — confirms we didn't write a no-op.
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("hello world\n");
  });

  it("no-op edit in a partial-apply batch still lets the other edits land", async () => {
    const filePath = path.join(tmpDir, "noop-batch.txt");
    await fs.writeFile(filePath, "alpha\nbeta\n");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        file_path: "noop-batch.txt",
        edits: [
          { old_text: "alpha", new_text: "ALPHA" },
          { old_text: "beta", new_text: "beta" }, // no-op
        ],
      },
      { signal: new AbortController().signal, toolCallId: "test-noop-batch" },
    );

    const summary = typeof result === "string" ? result : (result as { content: string }).content;
    expect(summary).toMatch(/Applied 1 of 2/);
    expect(summary).toMatch(/identical[\s\S]*no-op/);

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("ALPHA\nbeta\n");
  });

  it("strips a spurious leading blank line in old_text and still matches", async () => {
    const filePath = path.join(tmpDir, "blank.ts");
    await fs.writeFile(filePath, "function foo() {\n  return 42;\n}\n");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        file_path: "blank.ts",
        edits: [
          {
            // Note the leading blank line — the model often pastes one in.
            old_text: "\n  return 42;",
            new_text: "\n  return 100;",
          },
        ],
      },
      { signal: new AbortController().signal, toolCallId: "test-blank" },
    );

    const summary = typeof result === "string" ? result : (result as { content: string }).content;
    expect(summary).toMatch(/Successfully/);

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("function foo() {\n  return 100;\n}\n");
  });

  it("throws when old_text is not found", async () => {
    const filePath = path.join(tmpDir, "missing.txt");
    await fs.writeFile(filePath, "some content here\n");

    const tool = createEditTool(tmpDir);

    await expect(
      tool.execute(
        {
          file_path: "missing.txt",
          edits: [{ old_text: "nonexistent text", new_text: "replacement" }],
        },
        { signal: new AbortController().signal, toolCallId: "test-5" },
      ),
    ).rejects.toThrow("old_text not found");
  });

  it("invalidates the read tracker after a not_found failure to force a re-read", async () => {
    const filePath = path.join(tmpDir, "guardrail.txt");
    await fs.writeFile(filePath, "the actual content\n");

    const tracker: ReadTracker = new Map();
    await markRead(tracker, filePath);

    const tool = createEditTool(tmpDir, tracker);

    // First edit fails with not_found — tracker entry should be invalidated.
    await expect(
      tool.execute(
        {
          file_path: "guardrail.txt",
          edits: [{ old_text: "the wrong content", new_text: "anything" }],
        },
        { signal: new AbortController().signal, toolCallId: "guardrail-1" },
      ),
    ).rejects.toThrow(/old_text not found/);

    expect(tracker.has(filePath)).toBe(false);

    // Second edit on the same file — even with valid old_text — must fail
    // because the tracker was cleared. Model is forced to call `read` first.
    await expect(
      tool.execute(
        {
          file_path: "guardrail.txt",
          edits: [{ old_text: "the actual content", new_text: "replaced" }],
        },
        { signal: new AbortController().signal, toolCallId: "guardrail-2" },
      ),
    ).rejects.toThrow(/File must be read first/);
  });

  it("invalidates the read tracker on partial-apply when any not_found occurs", async () => {
    const filePath = path.join(tmpDir, "partial.txt");
    await fs.writeFile(filePath, "alpha\nbeta\ngamma\n");

    const tracker: ReadTracker = new Map();
    await markRead(tracker, filePath);

    const tool = createEditTool(tmpDir, tracker);

    // One edit succeeds (alpha → ALPHA), one fails with not_found (missing).
    // File gets written with the success — but tracker must still be cleared.
    await tool.execute(
      {
        file_path: "partial.txt",
        edits: [
          { old_text: "alpha", new_text: "ALPHA" },
          { old_text: "missing", new_text: "replacement" },
        ],
      },
      { signal: new AbortController().signal, toolCallId: "partial-1" },
    );

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("ALPHA\nbeta\ngamma\n");
    expect(tracker.has(filePath)).toBe(false);
  });

  it("throws when old_text matches multiple times", async () => {
    const filePath = path.join(tmpDir, "dupes.txt");
    await fs.writeFile(filePath, "foo bar foo baz foo\n");

    const tool = createEditTool(tmpDir);

    await expect(
      tool.execute(
        { file_path: "dupes.txt", edits: [{ old_text: "foo", new_text: "qux" }] },
        { signal: new AbortController().signal, toolCallId: "test-6" },
      ),
    ).rejects.toThrow(/found 3 times/);
  });

  it("includes line numbers of every duplicate match in the error", async () => {
    const filePath = path.join(tmpDir, "pomodoro.css");
    await fs.writeFile(
      filePath,
      [
        ".timer { color: white; }",
        ".button { color: black; }",
        ".label { color: white; }",
        ".footer { color: white; }",
        "",
      ].join("\n"),
    );

    const tool = createEditTool(tmpDir);
    await expect(
      tool.execute(
        {
          file_path: "pomodoro.css",
          edits: [{ old_text: "color: white;", new_text: "color: red;" }],
        },
        { signal: new AbortController().signal, toolCallId: "test-dup-lines" },
      ),
    ).rejects.toThrow(/Matches at:[\s\S]*line 1[\s\S]*line 3[\s\S]*line 4/);
  });

  it("hints at replace_all in the duplicate-match error", async () => {
    const filePath = path.join(tmpDir, "hint.txt");
    await fs.writeFile(filePath, "foo\nfoo\nfoo\n");

    const tool = createEditTool(tmpDir);
    await expect(
      tool.execute(
        { file_path: "hint.txt", edits: [{ old_text: "foo", new_text: "bar" }] },
        { signal: new AbortController().signal, toolCallId: "test-dup-hint" },
      ),
    ).rejects.toThrow(/replace_all: true/);
  });

  it("replaces every occurrence when replace_all: true is set", async () => {
    const filePath = path.join(tmpDir, "rename.css");
    await fs.writeFile(
      filePath,
      [".timer { color: white; }", ".label { color: white; }", ".footer { color: white; }"].join(
        "\n",
      ) + "\n",
    );

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        file_path: "rename.css",
        edits: [{ old_text: "color: white;", new_text: "color: red;", replace_all: true }],
      },
      { signal: new AbortController().signal, toolCallId: "test-replace-all" },
    );

    const summary = typeof result === "string" ? result : (result as { content: string }).content;
    expect(summary).toMatch(/Successfully/);

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe(
      [".timer { color: red; }", ".label { color: red; }", ".footer { color: red; }"].join("\n") +
        "\n",
    );
  });

  it("replace_all still errors when no occurrences exist (with closest-match hint)", async () => {
    const filePath = path.join(tmpDir, "missing-all.txt");
    await fs.writeFile(filePath, "alpha beta\n");

    const tool = createEditTool(tmpDir);
    await expect(
      tool.execute(
        {
          file_path: "missing-all.txt",
          edits: [{ old_text: "gamma", new_text: "delta", replace_all: true }],
        },
        { signal: new AbortController().signal, toolCallId: "test-replace-all-missing" },
      ),
    ).rejects.toThrow(/old_text not found/);
  });

  it("replace_all coexists with sequential edits in one batch", async () => {
    const filePath = path.join(tmpDir, "mixed.css");
    await fs.writeFile(
      filePath,
      [".a { color: white; }", ".b { color: white; }", ".header { font-size: 12px; }"].join("\n") +
        "\n",
    );

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        file_path: "mixed.css",
        edits: [
          { old_text: "color: white;", new_text: "color: red;", replace_all: true },
          { old_text: "font-size: 12px;", new_text: "font-size: 14px;" },
        ],
      },
      { signal: new AbortController().signal, toolCallId: "test-mixed" },
    );

    const summary = typeof result === "string" ? result : (result as { content: string }).content;
    expect(summary).toContain("2 edits");

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe(
      [".a { color: red; }", ".b { color: red; }", ".header { font-size: 14px; }"].join("\n") +
        "\n",
    );
  });

  it("handles fuzzy matching with trailing whitespace and smart quotes", async () => {
    const filePath = path.join(tmpDir, "fuzzy.txt");
    await fs.writeFile(filePath, "const msg = 'hello';  \nend\n");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        file_path: "fuzzy.txt",
        edits: [
          {
            old_text: "const msg = \u2018hello\u2019;",
            new_text: "const msg = 'goodbye';",
          },
        ],
      },
      { signal: new AbortController().signal, toolCallId: "test-7" },
    );

    const diff = resultToString(result);
    expect(diff).toContain("+const msg = 'goodbye';");

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toContain("goodbye");
  });

  it("preserves CRLF line endings", async () => {
    const filePath = path.join(tmpDir, "crlf.txt");
    await fs.writeFile(filePath, "line one\r\nline two\r\nline three\r\n");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      { file_path: "crlf.txt", edits: [{ old_text: "line two", new_text: "line TWO" }] },
      { signal: new AbortController().signal, toolCallId: "test-8" },
    );

    const diff = resultToString(result);
    expect(diff).toContain("+line TWO");

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("line one\r\nline TWO\r\nline three\r\n");
  });

  it("calls mutation callback after successful edits", async () => {
    const filePath = path.join(tmpDir, "mutated.txt");
    await fs.writeFile(filePath, "alpha\n");
    const mutated: string[] = [];
    const tool = createEditTool(tmpDir, undefined, undefined, undefined, (mutatedPath) => {
      mutated.push(mutatedPath);
    });

    await tool.execute(
      { file_path: "mutated.txt", edits: [{ old_text: "alpha", new_text: "beta" }] },
      { signal: new AbortController().signal, toolCallId: "test-mutated" },
    );

    expect(mutated).toEqual([filePath]);
  });

  it("does not call mutation callback when no edits are written", async () => {
    const filePath = path.join(tmpDir, "not-mutated.txt");
    await fs.writeFile(filePath, "alpha\n");
    const mutated: string[] = [];
    const tool = createEditTool(tmpDir, undefined, undefined, undefined, (mutatedPath) => {
      mutated.push(mutatedPath);
    });

    await expect(
      tool.execute(
        { file_path: "not-mutated.txt", edits: [{ old_text: "missing", new_text: "beta" }] },
        { signal: new AbortController().signal, toolCallId: "test-not-mutated" },
      ),
    ).rejects.toThrow("old_text not found");

    expect(mutated).toEqual([]);
  });
});
