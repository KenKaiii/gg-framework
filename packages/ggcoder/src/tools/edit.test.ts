import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prettifyError } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createEditTool } from "./edit.js";
import { lineHash } from "../core/hashline.js";
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

  it.each([
    {
      label: "retention fields without duplicating the first object",
      original:
        "const a = { created_at: cutoff };\nconst b = { created_at: cutoff };\nconst c = { created_at: cutoff };\n",
      oldText: "created_at: cutoff",
      newText: "created_at: cutoff, retention_acquired_at: cutoff",
      expected:
        "const a = { created_at: cutoff, retention_acquired_at: cutoff };\nconst b = { created_at: cutoff, retention_acquired_at: cutoff };\nconst c = { created_at: cutoff, retention_acquired_at: cutoff };\n",
    },
    {
      label: "adjacent matches with a self-containing replacement",
      original: "aaaa",
      oldText: "a",
      newText: "ba",
      expected: "babababa",
    },
    {
      label: "shorter replacements",
      original: "abab abab",
      oldText: "abab",
      newText: "ab",
      expected: "ab ab",
    },
    {
      label: "deletion without matching newly joined boundaries",
      original: "aabb ab",
      oldText: "ab",
      newText: "",
      expected: "ab ",
    },
    {
      label: "fuzzy matches without revisiting replacement text",
      original: "say(“hello”);\nsay(“hello”);\n",
      oldText: 'say("hello");',
      newText: 'say("hello"); extra();',
      expected: 'say("hello"); extra();\nsay("hello"); extra();\n',
    },
    {
      label: "multiline fuzzy matches with different original lengths",
      original: "say(“hello”);  \nnext();\nsay(“hello”); \nnext();\n",
      oldText: 'say("hello");\nnext();',
      newText: 'say("hello");\nnext();\nextra();',
      expected: 'say("hello");\nnext();\nextra();\nsay("hello");\nnext();\nextra();\n',
    },
    {
      label: "exact matches without broadening to fuzzy matches",
      original: 'say(“hello”);\nsay("hello");\nsay("hello");\n',
      oldText: 'say("hello");',
      newText: 'say("hello"); extra();',
      expected: 'say(“hello”);\nsay("hello"); extra();\nsay("hello"); extra();\n',
    },
  ])("replace_all handles $label", async ({ original, oldText, newText, expected }) => {
    const filePath = path.join(tmpDir, "replace-all.txt");
    await fs.writeFile(filePath, original);
    const tool = createEditTool(tmpDir);
    await tool.execute(
      {
        file_path: "replace-all.txt",
        edits: [{ old_text: oldText, new_text: newText, replace_all: true }],
      },
      { signal: new AbortController().signal, toolCallId: "replace-all-regression" },
    );
    expect(await fs.readFile(filePath, "utf-8")).toBe(expected);
  });

  it("replaces non-overlapping fuzzy blocks without double-counting shared lines", async () => {
    const filePath = path.join(tmpDir, "overlap.txt");
    await fs.writeFile(filePath, "A \nA \nA \n");
    await createEditTool(tmpDir).execute(
      {
        file_path: "overlap.txt",
        edits: [{ old_text: "A\nA", new_text: "X\nX", replace_all: true }],
      },
      { signal: new AbortController().signal, toolCallId: "overlapping-fuzzy" },
    );
    expect(await fs.readFile(filePath, "utf-8")).toBe("X\nX\nA \n");
  });

  it("rejects global elision instead of reporting a single replacement as complete", async () => {
    const filePath = path.join(tmpDir, "elision.txt");
    const original =
      "function f() {\n  keep();\n  return 1;\n}\n\nfunction f() {\n  keep();\n  return 1;\n}\n";
    await fs.writeFile(filePath, original);
    await expect(
      createEditTool(tmpDir).execute(
        {
          file_path: "elision.txt",
          edits: [
            {
              old_text: "function f() {\n  ...\n  return 1;\n}",
              new_text: "function f() {\n  ...\n  return 2;\n}",
              replace_all: true,
            },
          ],
        },
        { signal: new AbortController().signal, toolCallId: "global-elision" },
      ),
    ).rejects.toThrow(/replace_all.*elision/);
    expect(await fs.readFile(filePath, "utf-8")).toBe(original);
  });

  it("still rejects ambiguous overlapping fuzzy matches for a single edit", async () => {
    const filePath = path.join(tmpDir, "ambiguous-overlap.txt");
    const original = "A \nA \nA \n";
    await fs.writeFile(filePath, original);
    await expect(
      createEditTool(tmpDir).execute(
        { file_path: "ambiguous-overlap.txt", edits: [{ old_text: "A\nA", new_text: "X\nX" }] },
        { signal: new AbortController().signal, toolCallId: "ambiguous-overlap" },
      ),
    ).rejects.toThrow(/old_text found 2 times/);
    expect(await fs.readFile(filePath, "utf-8")).toBe(original);
  });

  it("permits global literal dots when the complete text actually exists", async () => {
    const filePath = path.join(tmpDir, "literal-dots.txt");
    await fs.writeFile(filePath, "header\n...\nend\nheader\n...\nend\n");
    await createEditTool(tmpDir).execute(
      {
        file_path: "literal-dots.txt",
        edits: [{ old_text: "header\n...\nend", new_text: "changed\n...\nend", replace_all: true }],
      },
      { signal: new AbortController().signal, toolCallId: "literal-dots" },
    );
    expect(await fs.readFile(filePath, "utf-8")).toBe("changed\n...\nend\nchanged\n...\nend\n");
  });

  it.each([false, true])(
    "removes exact invisible characters through the edit tool (replace_all=%s)",
    async (replaceAll) => {
      const filePath = path.join(tmpDir, "invisible.txt");
      await fs.writeFile(filePath, replaceAll ? "a\u200bb\u200b" : "a\u200bb");
      await createEditTool(tmpDir).execute(
        {
          file_path: "invisible.txt",
          edits: [{ old_text: "\u200b", new_text: "", replace_all: replaceAll }],
        },
        { signal: new AbortController().signal, toolCallId: "exact-invisible-removal" },
      );
      expect(await fs.readFile(filePath, "utf-8")).toBe("ab");
    },
  );

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

  it("dotdotdots: model can omit common indentation from elided bookends", async () => {
    const filePath = path.join(tmpDir, "elide-indent.ts");
    await fs.writeFile(
      filePath,
      "    function pomodoro() {\n      trackPomodoro(timer);\n      return timer;\n    }\n",
    );

    const tool = createEditTool(tmpDir);
    await tool.execute(
      {
        file_path: "elide-indent.ts",
        edits: [
          {
            old_text: "function pomodoro() {\n  ...\n  return timer;\n}",
            new_text: "function pomodoro(): Timer {\n  ...\n  return timer;\n}",
          },
        ],
      },
      { signal: new AbortController().signal, toolCallId: "test-elide-indent" },
    );

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe(
      "    function pomodoro(): Timer {\n      trackPomodoro(timer);\n      return timer;\n    }\n",
    );
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

  it("treats no-op edits where old_text equals new_text as successful no-ops", async () => {
    const filePath = path.join(tmpDir, "noop.txt");
    await fs.writeFile(filePath, "hello world\n");

    const mutated: string[] = [];
    const tool = createEditTool(tmpDir, undefined, undefined, undefined, (mutatedPath) => {
      mutated.push(mutatedPath);
    });
    const result = await tool.execute(
      {
        file_path: "noop.txt",
        edits: [{ old_text: "hello", new_text: "hello" }],
      },
      { signal: new AbortController().signal, toolCallId: "test-noop" },
    );

    const summary = typeof result === "string" ? result : (result as { content: string }).content;
    expect(summary).toMatch(/No changes needed[\s\S]*no-op/);
    expect(mutated).toEqual([]);

    // File untouched — confirms we didn't write a no-op.
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("hello world\n");
  });

  it("applies real edits atomically when the batch also contains no-ops", async () => {
    const filePath = path.join(tmpDir, "noop-atomic.txt");
    await fs.writeFile(filePath, "alpha\nbeta\ngamma\n");

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        file_path: "noop-atomic.txt",
        edits: [
          { old_text: "alpha", new_text: "ALPHA" },
          { old_text: "beta", new_text: "beta" },
          { old_text: "gamma", new_text: "GAMMA" },
        ],
        atomic: true,
      },
      { signal: new AbortController().signal, toolCallId: "test-noop-atomic" },
    );

    const summary = typeof result === "string" ? result : (result as { content: string }).content;
    expect(summary).toContain("3 edits");

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("ALPHA\nbeta\nGAMMA\n");
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
    expect(summary).toMatch(/Successfully applied 2 edits/);

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

  it("keeps the read tracker valid after a not_found failure so the model can retry immediately", async () => {
    const filePath = path.join(tmpDir, "guardrail.txt");
    await fs.writeFile(filePath, "the actual content\n");

    const tracker: ReadTracker = new Map();
    await markRead(tracker, filePath);

    const tool = createEditTool(tmpDir, tracker);

    // First edit fails with not_found. Nothing was written, so the file is
    // unchanged and the tracker must stay valid — invalidating it here used to
    // surface a misleading "File must be read first" on the next edit.
    await expect(
      tool.execute(
        {
          file_path: "guardrail.txt",
          edits: [{ old_text: "the wrong content", new_text: "anything" }],
        },
        { signal: new AbortController().signal, toolCallId: "guardrail-1" },
      ),
    ).rejects.toThrow(/old_text not found/);

    expect(tracker.has(filePath)).toBe(true);

    // Second edit with corrected old_text succeeds without a forced re-read.
    const result = await tool.execute(
      {
        file_path: "guardrail.txt",
        edits: [{ old_text: "the actual content", new_text: "replaced" }],
      },
      { signal: new AbortController().signal, toolCallId: "guardrail-2" },
    );
    const summary = typeof result === "string" ? result : (result as { content: string }).content;
    expect(summary).toMatch(/Successfully replaced/);
    expect(await fs.readFile(filePath, "utf-8")).toBe("replaced\n");
  });

  it("refreshes (not clears) the tracker on partial-apply so retries validate against the written content", async () => {
    const filePath = path.join(tmpDir, "partial.txt");
    await fs.writeFile(filePath, "alpha\nbeta\ngamma\n");

    const tracker: ReadTracker = new Map();
    await markRead(tracker, filePath);

    const tool = createEditTool(tmpDir, tracker);

    // One edit succeeds (alpha → ALPHA), one fails with not_found (missing).
    // The success is written and the tracker is refreshed to the new content.
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

    expect(await fs.readFile(filePath, "utf-8")).toBe("ALPHA\nbeta\ngamma\n");
    expect(tracker.has(filePath)).toBe(true);

    // A follow-up edit against the just-written content applies without a re-read.
    const result = await tool.execute(
      {
        file_path: "partial.txt",
        edits: [{ old_text: "beta", new_text: "BETA" }],
      },
      { signal: new AbortController().signal, toolCallId: "partial-2" },
    );
    const summary = typeof result === "string" ? result : (result as { content: string }).content;
    expect(summary).toMatch(/Successfully replaced/);
    expect(await fs.readFile(filePath, "utf-8")).toBe("ALPHA\nBETA\ngamma\n");
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

  it("replace_all applies fuzzy matches instead of requiring exact split", async () => {
    const filePath = path.join(tmpDir, "replace-all-fuzzy.txt");
    await fs.writeFile(filePath, "say “hi”\nsay “hi”\n");

    const tool = createEditTool(tmpDir);
    await tool.execute(
      {
        file_path: "replace-all-fuzzy.txt",
        edits: [{ old_text: 'say "hi"', new_text: "say hello", replace_all: true }],
      },
      { signal: new AbortController().signal, toolCallId: "test-replace-all-fuzzy" },
    );

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("say hello\nsay hello\n");
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

  describe("LSP diagnostics", () => {
    function contentOf(result: unknown): string {
      if (result && typeof result === "object" && "content" in result) {
        const c = (result as { content: unknown }).content;
        if (typeof c === "string") return c;
      }
      return String(result);
    }

    it("appends a non-empty diagnostics string to a successful edit", async () => {
      const filePath = path.join(tmpDir, "diag.ts");
      await fs.writeFile(filePath, "const x = 1;\n");
      const seen: Array<{ filePath: string; content: string }> = [];
      const tool = createEditTool(
        tmpDir,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async (fp, content) => {
          seen.push({ filePath: fp, content });
          return "\n\nDiagnostics in diag.ts (informational — may resolve after related edits):\nL1:7 boom (typescript)";
        },
      );

      const result = await tool.execute(
        {
          file_path: "diag.ts",
          edits: [{ old_text: "const x = 1;", new_text: 'const x: number = "a";' }],
        },
        { signal: new AbortController().signal, toolCallId: "test-diag-1" },
      );

      const content = contentOf(result);
      expect(content).toContain("Successfully replaced text in diag.ts.");
      expect(content).toContain("L1:7 boom (typescript)");
      expect(seen).toEqual([{ filePath, content: 'const x: number = "a";\n' }]);
    });

    it("leaves the result unchanged when the provider returns empty", async () => {
      const filePath = path.join(tmpDir, "clean.ts");
      await fs.writeFile(filePath, "alpha\n");
      const tool = createEditTool(
        tmpDir,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async () => "",
      );

      const result = await tool.execute(
        { file_path: "clean.ts", edits: [{ old_text: "alpha", new_text: "beta" }] },
        { signal: new AbortController().signal, toolCallId: "test-diag-2" },
      );

      expect(contentOf(result)).toBe("Successfully replaced text in clean.ts.");
    });

    it("tells the provider which matching strategy placed the edit", async () => {
      // Attribution is the point of the telemetry: a regression traced to `...`
      // elision means something very different from one traced to an exact
      // match, and only this tool knows which ladder rung fired.
      const cases: { name: string; file: string; old: string; next: string; expect: string }[] = [
        { name: "exact.ts", file: "alpha\n", old: "alpha", next: "beta", expect: "text" },
        {
          name: "indent.ts",
          file: "    const x = 1;\n    const y = 2;\n",
          old: "const x = 1;\nconst y = 2;",
          next: "const x = 10;\nconst y = 20;",
          expect: "indent_flex",
        },
        {
          name: "elide.ts",
          file: "function f() {\n  keep();\n  return 1;\n}\n",
          old: "function f() {\n  ...\n  return 1;\n}",
          next: "function g() {\n  ...\n  return 1;\n}",
          expect: "dotdotdot",
        },
      ];

      for (const c of cases) {
        await fs.writeFile(path.join(tmpDir, c.name), c.file);
        let seen: string | undefined;
        const tool = createEditTool(
          tmpDir,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          async (_p, _c, source) => {
            seen = source;
            return "";
          },
        );

        await tool.execute(
          { file_path: c.name, edits: [{ old_text: c.old, new_text: c.next }] },
          { signal: new AbortController().signal, toolCallId: `test-source-${c.expect}` },
        );

        expect(seen).toBe(c.expect);
      }
    });

    it("blames the riskiest strategy when one batch mixes them", async () => {
      // A batch that needed an elision is a batch whose breakage should be
      // attributed to the elision, not to the exact match beside it.
      await fs.writeFile(
        path.join(tmpDir, "mixed.ts"),
        "const a = 1;\nfunction f() {\n  keep();\n  return 1;\n}\n",
      );
      let seen: string | undefined;
      const tool = createEditTool(
        tmpDir,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async (_p, _c, source) => {
          seen = source;
          return "";
        },
      );

      await tool.execute(
        {
          file_path: "mixed.ts",
          edits: [
            { old_text: "const a = 1;", new_text: "const a = 2;" },
            {
              old_text: "function f() {\n  ...\n  return 1;\n}",
              new_text: "function g() {\n  ...\n  return 1;\n}",
            },
          ],
        },
        { signal: new AbortController().signal, toolCallId: "test-source-mixed" },
      );

      expect(seen).toBe("dotdotdot");
    });

    it("leaves the result unchanged when the provider throws", async () => {
      const filePath = path.join(tmpDir, "throws.ts");
      await fs.writeFile(filePath, "alpha\n");
      const tool = createEditTool(
        tmpDir,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async () => {
          throw new Error("lsp exploded");
        },
      );

      const result = await tool.execute(
        { file_path: "throws.ts", edits: [{ old_text: "alpha", new_text: "beta" }] },
        { signal: new AbortController().signal, toolCallId: "test-diag-3" },
      );

      expect(contentOf(result)).toBe("Successfully replaced text in throws.ts.");
      expect(await fs.readFile(filePath, "utf-8")).toBe("beta\n");
    });

    it("does not call the provider when nothing was written", async () => {
      const filePath = path.join(tmpDir, "untouched.ts");
      await fs.writeFile(filePath, "alpha\n");
      let calls = 0;
      const tool = createEditTool(
        tmpDir,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async () => {
          calls++;
          return "should not appear";
        },
      );

      await expect(
        tool.execute(
          { file_path: "untouched.ts", edits: [{ old_text: "missing", new_text: "beta" }] },
          { signal: new AbortController().signal, toolCallId: "test-diag-4" },
        ),
      ).rejects.toThrow("old_text not found");

      expect(calls).toBe(0);
    });

    it("appends diagnostics to partial-success results", async () => {
      const filePath = path.join(tmpDir, "partial.ts");
      await fs.writeFile(filePath, "alpha\ngamma\n");
      const tool = createEditTool(
        tmpDir,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async () =>
          "\n\nDiagnostics in partial.ts (informational — may resolve after related edits):\nL1:1 oops (typescript)",
      );

      const result = await tool.execute(
        {
          file_path: "partial.ts",
          edits: [
            { old_text: "alpha", new_text: "beta" },
            { old_text: "missing", new_text: "x" },
          ],
        },
        { signal: new AbortController().signal, toolCallId: "test-diag-5" },
      );

      const content = contentOf(result);
      expect(content).toContain("Applied 1 of 2 edits");
      expect(content).toContain("L1:1 oops (typescript)");
    });
  });
});

describe("edit anchor guard", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-anchor-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function diffOf(result: unknown): string {
    if (typeof result === "string") return result;
    if (result && typeof result === "object" && "details" in result) {
      return (result as { details?: { diff?: string } }).details?.diff ?? "";
    }
    return "";
  }

  /** Anchor for a 1-based line in `content`. */
  function anchorFor(content: string, line1: number) {
    const idx = line1 - 1;
    const text = content.split("\n")[idx]!;
    return { line: line1, hash: lineHash(text, idx) };
  }

  it("applies normally when the anchor matches", async () => {
    const filePath = path.join(tmpDir, "a.ts");
    const content = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    await fs.writeFile(filePath, content);
    const tracker: ReadTracker = new Map();
    await markRead(tracker, filePath);

    const a = anchorFor(content, 2);
    const tool = createEditTool(tmpDir, tracker);
    const result = await tool.execute(
      {
        file_path: "a.ts",
        edits: [
          {
            old_text: "const b = 2;",
            new_text: "const b = 20;",
            anchor: { start_line: a.line, start_hash: a.hash, end_line: a.line, end_hash: a.hash },
          },
        ],
      },
      { signal: new AbortController().signal, toolCallId: "anc-1" },
    );

    expect(diffOf(result)).toContain("+const b = 20;");
    expect(await fs.readFile(filePath, "utf-8")).toBe(
      "const a = 1;\nconst b = 20;\nconst c = 3;\n",
    );
  });

  it("rejects a wrong start_hash with stale_anchor and writes nothing", async () => {
    const filePath = path.join(tmpDir, "b.ts");
    const content = "const a = 1;\nconst b = 2;\n";
    await fs.writeFile(filePath, content);
    const tracker: ReadTracker = new Map();
    await markRead(tracker, filePath);

    const tool = createEditTool(tmpDir, tracker);
    await expect(
      tool.execute(
        {
          file_path: "b.ts",
          edits: [
            {
              old_text: "const b = 2;",
              new_text: "const b = 20;",
              anchor: { start_line: 2, start_hash: "dead", end_line: 2, end_hash: "dead" },
            },
          ],
        },
        { signal: new AbortController().signal, toolCallId: "anc-2" },
      ),
    ).rejects.toThrow(/changed since you read it/);

    // File untouched.
    expect(await fs.readFile(filePath, "utf-8")).toBe(content);
  });

  it("partial-applies a multi-edit batch where one anchor is stale", async () => {
    const filePath = path.join(tmpDir, "c.ts");
    const content = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    await fs.writeFile(filePath, content);
    const tracker: ReadTracker = new Map();
    await markRead(tracker, filePath);

    const a = anchorFor(content, 1);
    const tool = createEditTool(tmpDir, tracker);
    const result = await tool.execute(
      {
        file_path: "c.ts",
        edits: [
          {
            old_text: "const a = 1;",
            new_text: "const a = 10;",
            anchor: { start_line: a.line, start_hash: a.hash, end_line: a.line, end_hash: a.hash },
          },
          {
            old_text: "const c = 3;",
            new_text: "const c = 30;",
            anchor: { start_line: 3, start_hash: "dead", end_line: 3, end_hash: "dead" },
          },
        ],
      },
      { signal: new AbortController().signal, toolCallId: "anc-3" },
    );

    const content2 = contentOf(result);
    expect(content2).toContain("Applied 1 of 2 edits");
    expect(content2).toContain("changed since you read it");
    // First edit persisted; the stale one did not.
    expect(await fs.readFile(filePath, "utf-8")).toBe(
      "const a = 10;\nconst b = 2;\nconst c = 3;\n",
    );
  });

  it("absent anchor behaves exactly like today (fuzzy path)", async () => {
    const filePath = path.join(tmpDir, "d.ts");
    await fs.writeFile(filePath, "const a = 1;\n");
    const tracker: ReadTracker = new Map();
    await markRead(tracker, filePath);

    const tool = createEditTool(tmpDir, tracker);
    const result = await tool.execute(
      { file_path: "d.ts", edits: [{ old_text: "const a = 1;", new_text: "const a = 2;" }] },
      { signal: new AbortController().signal, toolCallId: "anc-4" },
    );

    expect(diffOf(result)).toContain("+const a = 2;");
    expect(await fs.readFile(filePath, "utf-8")).toBe("const a = 2;\n");
  });

  // ── Span form { span, lines } ──

  function spanFor(content: string, startLine: number, endLine: number) {
    const lines = content.split("\n");
    return {
      start_line: startLine,
      start_hash: lineHash(lines[startLine - 1]!, startLine - 1),
      end_line: endLine,
      end_hash: lineHash(lines[endLine - 1]!, endLine - 1),
    };
  }

  it("span form replaces the pinned line range without old_text", async () => {
    const content = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    const filePath = path.join(tmpDir, "span1.ts");
    await fs.writeFile(filePath, content);

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        file_path: "span1.ts",
        edits: [{ span: spanFor(content, 2, 2), lines: ["const b = 20;"] }],
      },
      { signal: new AbortController().signal, toolCallId: "span-1" },
    );

    expect(diffOf(result)).toContain("+const b = 20;");
    expect(await fs.readFile(filePath, "utf-8")).toBe(
      "const a = 1;\nconst b = 20;\nconst c = 3;\n",
    );
  });

  it("span form: multi-line replace, insert-by-expansion, and delete via empty lines", async () => {
    const content = "one\ntwo\nthree\nfour\nfive\n";
    const filePath = path.join(tmpDir, "span2.txt");
    await fs.writeFile(filePath, content);

    const tool = createEditTool(tmpDir);
    await tool.execute(
      {
        file_path: "span2.txt",
        edits: [
          // Replace lines 2-3 with three lines (expansion = insertion).
          { span: spanFor(content, 2, 3), lines: ["TWO", "TWO.5", "THREE"] },
          // Delete line 5 ("five"). Anchors verify against the file AS READ,
          // and spans apply bottom-up, so the earlier expansion doesn't shift this.
          { span: spanFor(content, 5, 5), lines: [] },
        ],
      },
      { signal: new AbortController().signal, toolCallId: "span-2" },
    );

    // Deleting line 5 ("five") leaves the trailing newline's empty segment as EOF.
    expect(await fs.readFile(filePath, "utf-8")).toBe("one\nTWO\nTWO.5\nTHREE\nfour\n");
  });

  it("span form rejects stale hashes without touching the file", async () => {
    const content = "alpha\nbeta\n";
    const filePath = path.join(tmpDir, "span3.txt");
    await fs.writeFile(filePath, content);

    const tool = createEditTool(tmpDir);
    await expect(
      tool.execute(
        {
          file_path: "span3.txt",
          edits: [
            {
              span: { start_line: 1, start_hash: "dead", end_line: 1, end_hash: "dead" },
              lines: ["hijacked"],
            },
          ],
        },
        { signal: new AbortController().signal, toolCallId: "span-3" },
      ),
    ).rejects.toThrow(/changed since you read it/);
    expect(await fs.readFile(filePath, "utf-8")).toBe(content);
  });

  it("span form rejects overlapping spans (first wins, overlap reported)", async () => {
    const content = "l1\nl2\nl3\nl4\n";
    const filePath = path.join(tmpDir, "span4.txt");
    await fs.writeFile(filePath, content);

    const tool = createEditTool(tmpDir);
    const result = await tool.execute(
      {
        file_path: "span4.txt",
        edits: [
          { span: spanFor(content, 1, 2), lines: ["A"] },
          { span: spanFor(content, 2, 3), lines: ["B"] },
        ],
      },
      { signal: new AbortController().signal, toolCallId: "span-4" },
    );

    expect(contentOf(result)).toContain("overlaps");
    expect(await fs.readFile(filePath, "utf-8")).toBe("A\nl3\nl4\n");
  });

  it("span and text forms mix in one batch: spans first, then text on the result", async () => {
    const content = "const x = 1;\nconst y = 2;\n";
    const filePath = path.join(tmpDir, "span5.ts");
    await fs.writeFile(filePath, content);

    const tool = createEditTool(tmpDir);
    await tool.execute(
      {
        file_path: "span5.ts",
        edits: [
          { span: spanFor(content, 1, 1), lines: ["const x = 10;"] },
          { old_text: "const y = 2;", new_text: "const y = 20;" },
        ],
      },
      { signal: new AbortController().signal, toolCallId: "span-5" },
    );

    expect(await fs.readFile(filePath, "utf-8")).toBe("const x = 10;\nconst y = 20;\n");
  });

  it("rejects an edit that mixes span with old_text, and one with neither form", async () => {
    const content = "a\nb\n";
    const filePath = path.join(tmpDir, "span6.txt");
    await fs.writeFile(filePath, content);

    const tool = createEditTool(tmpDir);
    await expect(
      tool.execute(
        {
          file_path: "span6.txt",
          edits: [{ span: spanFor(content, 1, 1), lines: ["z"], old_text: "a", new_text: "z" }],
        },
        { signal: new AbortController().signal, toolCallId: "span-6" },
      ),
    ).rejects.toThrow(/must not mix/);

    await expect(
      tool.execute(
        { file_path: "span6.txt", edits: [{}] },
        { signal: new AbortController().signal, toolCallId: "span-7" },
      ),
    ).rejects.toThrow(/has neither/);
    expect(await fs.readFile(filePath, "utf-8")).toBe(content);
  });

  it("blocks edits outside the workspace with the guard error", async () => {
    const tool = createEditTool(tmpDir);
    const outside = path.join(os.homedir(), "Documents", "gg-guard-test-outside.txt");

    const raw = await tool.execute(
      { file_path: outside, edits: [{ old_text: "a", new_text: "b" }] },
      { signal: new AbortController().signal, toolCallId: "guard-1" },
    );

    expect(contentOf(raw)).toContain("outside the workspace");
    expect(contentOf(raw)).toContain("allowOutsideWorkspaceWrites");
  });
});

/**
 * Models intermittently hand-serialize `edits` into a JSON string instead of
 * emitting a real array (~1% of edit calls across opus-5/sonnet-5/glm-5.x).
 * Well-formed strings are coerced; malformed ones must be rejected with a
 * message that names the mistake, because the stock "expected array, received
 * string" made the model re-send the identical payload until the agent loop's
 * repeat counter killed the turn.
 */
describe("edit stringified `edits` handling", () => {
  const parse = (edits: unknown) =>
    createEditTool(os.tmpdir()).parameters.safeParse({ file_path: "a.ts", edits });

  const errorFor = (edits: unknown): string => {
    const result = parse(edits);
    expect(result.success).toBe(false);
    return result.success ? "" : prettifyError(result.error);
  };

  it("coerces a well-formed stringified array back into edits", () => {
    const result = parse(JSON.stringify([{ old_text: "a", new_text: "b" }]));
    expect(result.success).toBe(true);
    expect(result.success && result.data.edits).toEqual([{ old_text: "a", new_text: "b" }]);
  });

  // Verbatim payloads recovered from ~/.gg session logs. Each broke a real
  // turn: unescaped control characters, a dropped `new_text` key, a `":`
  // corrupted into `>`, and a stream truncated mid-string.
  it.each([
    ["raw control character", '[{"old_text": "a\\nb", "new_text": "c\nd"}]'],
    ["missing new_text key", '[{"old_text": "a", " * Egress limits"}]'],
    ["corrupted key delimiter", '[{"old_text">function stopServer() {'],
    ["truncated mid-payload", '[{"old_text": "a", "new_text": "bb'],
  ])("rejects %s with actionable guidance", (_label, payload) => {
    const message = errorFor(payload);
    expect(message).toContain("JSON-encoded string");
    expect(message).toContain("real JSON array");
    expect(message).toContain("split the work");
    // The unactionable stock message is what caused the retry loop.
    expect(message).not.toContain("expected array, received string");
  });

  it("leaves non-string type errors on their default message", () => {
    expect(errorFor(42)).toContain("expected array, received number");
  });

  it("still reports per-item errors inside a real array", () => {
    expect(errorFor([{ old_text: 5 }])).toContain("expected string, received number");
  });
});

function contentOf(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result) {
    return (result as { content?: string }).content ?? "";
  }
  return "";
}
