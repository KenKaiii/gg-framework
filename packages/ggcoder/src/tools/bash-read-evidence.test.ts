import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolCall, ToolResult } from "@kleio/ai";
import { catTargets, rangeTargets, recordBashReads } from "./bash-read-evidence.js";
import { localOperations } from "./operations.js";
import type { ReadTracker } from "./read-tracker.js";
import { createEditTool } from "./edit.js";
import { createWriteTool } from "./write.js";
import { useFakeHome } from "../test-support/fake-home.js";

function call(command: string, id = "c1"): ToolCall {
  return { type: "tool_call", id, name: "bash", args: { command } };
}
function result(content: string, id = "c1", isError = false): ToolResult {
  return { type: "tool_result", toolCallId: id, content, isError };
}

describe("catTargets", () => {
  it.each([
    ["cat src/a.js", ["src/a.js"]],
    ["cat -n src/a.js src/b.js", ["src/a.js", "src/b.js"]],
    ["git status; cat package.json && cat -n src/x.ts", ["package.json", "src/x.ts"]],
    ['for f in src/a.js src/b.js; do echo "=== $f"; cat -n $f; done', ["src/a.js", "src/b.js"]],
    ['for f in a.js b.js; do echo "== $f"; cat "$f"; done; git log', ["a.js", "b.js"]],
    ["cat src/*.js", ["src/*.js"]],
    ['for f in src/*.js test/*.js; do echo "=== $f"; cat -n "$f"; done', ["src/*.js", "test/*.js"]],
  ])("%s", (command, expected) => {
    expect(catTargets(command)).toEqual(expected);
  });

  it.each([
    "cat $FILE",
    "cat src/**/*.js",
    "cat -A a.js",
    "cat a.js | head -5",
    "cat a.js > b.js",
    "head -20 a.js",
    "for f in a.js; do cat -n $f | head; done",
    "sed -n 1,20p a.js",
  ])("ignores %s", (command) => {
    expect(catTargets(command)).toEqual([]);
  });
});

describe("rangeTargets", () => {
  it.each([
    ["sed -n 1,20p a.js", [{ target: "a.js", start: 1, end: 20 }]],
    ["sed -n '5,9p' src/a.ts", [{ target: "src/a.ts", start: 5, end: 9 }]],
    ['sed -n "7p" a.ts', [{ target: "a.ts", start: 7, end: 7 }]],
    ["head -20 a.js", [{ target: "a.js", start: 1, end: 20 }]],
    ["head -n 15 a.js", [{ target: "a.js", start: 1, end: 15 }]],
    [
      "sed -n 1,10p a.ts && sed -n 11,30p a.ts",
      [
        { target: "a.ts", start: 1, end: 10 },
        { target: "a.ts", start: 11, end: 30 },
      ],
    ],
  ])("%s", (command, expected) => {
    expect(rangeTargets(command)).toEqual(expected);
  });

  it.each([
    "sed -n 1,20p a.js | grep x",
    "sed -n 1,20p a.js b.js",
    "sed -n 1,20p $FILE",
    "sed -n 1,20p src/*.js",
    "sed -n '/start/,/end/p' a.js",
    "sed -n 20,10p a.js",
    "sed -i 1,20p a.js",
    "head -c 100 a.js",
    "nl -ba a.js | sed -n 1,20p",
  ])("ignores %s", (command) => {
    expect(rangeTargets(command)).toEqual([]);
  });
});

describe("recordBashReads", () => {
  let dir: string;
  const content = "line one\nline two\nline three\n";

  let restoreHome: () => void;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-read-"));
    restoreHome = useFakeHome(path.join(dir, "home"));
    await fs.mkdir(path.join(dir, "src"));
    await fs.writeFile(path.join(dir, "src/a.js"), content);
  });
  afterEach(async () => {
    restoreHome();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("records a plain cat whose output holds the whole file", async () => {
    const tracker: ReadTracker = new Map();
    const done = await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call("cat src/a.js")],
      [result(content)],
    );
    expect(done).toEqual([path.join(dir, "src/a.js")]);
    expect(tracker.get(path.join(dir, "src/a.js"))?.seen).toBe("all");
  });

  it("records cat -n output", async () => {
    const tracker: ReadTracker = new Map();
    const out = "=== src/a.js\n     1\tline one\n     2\tline two\n     3\tline three\n";
    await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call('for f in src/a.js; do echo "=== $f"; cat -n $f; done')],
      [result(out)],
    );
    expect(tracker.get(path.join(dir, "src/a.js"))?.seen).toBe("all");
  });

  it("never records output the model did not fully receive", async () => {
    const tracker: ReadTracker = new Map();
    // Trimmed by the per-turn budget: the last line is missing.
    await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call("cat src/a.js")],
      [result("line one\nline two\n[... trimmed ...]")],
    );
    expect(tracker.has(path.join(dir, "src/a.js"))).toBe(false);
  });

  it("never records a failed command or a file that changed after the cat", async () => {
    const tracker: ReadTracker = new Map();
    await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call("cat src/a.js")],
      [result(content, "c1", true)],
    );
    expect(tracker.size).toBe(0);
    await fs.writeFile(path.join(dir, "src/a.js"), "rewritten\n");
    await recordBashReads(tracker, dir, localOperations, [call("cat src/a.js")], [result(content)]);
    expect(tracker.size).toBe(0);
  });

  it("expands a one-directory glob and records only files fully shown", async () => {
    await fs.writeFile(path.join(dir, "src/b.js"), "bee\n");
    await fs.writeFile(path.join(dir, "src/c.js"), "never shown\n");
    const tracker: ReadTracker = new Map();
    const out = "=== src/a.js\n" + content + "=== src/b.js\nbee\n=== src/c.js\nnever";
    await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call('for f in src/*.js; do echo "=== $f"; cat "$f"; done')],
      [result(out)],
    );
    expect([...tracker.keys()].sort()).toEqual([
      path.join(dir, "src/a.js"),
      path.join(dir, "src/b.js"),
    ]);
  });

  it("lets write replace a file the model saw only through cat", async () => {
    const tracker: ReadTracker = new Map();
    await recordBashReads(tracker, dir, localOperations, [call("cat src/a.js")], [result(content)]);
    const write = createWriteTool(dir, tracker);
    await write.execute(
      { file_path: "src/a.js", content: "new\n" },
      { signal: new AbortController().signal, toolCallId: "w1" },
    );
    expect(await fs.readFile(path.join(dir, "src/a.js"), "utf8")).toBe("new\n");
  });

  it("does not count a trimmed cat as a read: a write reports every line it removed", async () => {
    const tracker: ReadTracker = new Map();
    await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call("cat src/a.js")],
      [result("line one\n…")],
    );
    const write = createWriteTool(dir, tracker);
    const out = String(
      await write.execute(
        { file_path: "src/a.js", content: "new\n" },
        { signal: new AbortController().signal, toolCallId: "w2" },
      ),
    );
    expect(out).toContain("removed 3 lines you had not seen");
  });

  it("records the lines a sed -n range showed, so a write reports only the rest", async () => {
    const tracker: ReadTracker = new Map();
    const recorded = await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call("sed -n 1,2p src/a.js")],
      [result("line one\nline two\n")],
    );
    expect(recorded).toEqual([path.join(dir, "src/a.js")]);
    expect(tracker.get(path.join(dir, "src/a.js"))?.seen).toEqual([[1, 2]]);

    const write = createWriteTool(dir, tracker);
    const out = String(
      await write.execute(
        { file_path: "src/a.js", content: "new\n" },
        { signal: new AbortController().signal, toolCallId: "w1" },
      ),
    );
    expect(out).toContain("removed 1 line you had not seen");
    expect(out).toContain("3|-line three");
  });

  it("credits sed ranges that together cover the file as a full read", async () => {
    const tracker: ReadTracker = new Map();
    await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call("sed -n 1,2p src/a.js && sed -n 3,40p src/a.js")],
      [result("line one\nline two\nline three\n")],
    );
    expect(tracker.get(path.join(dir, "src/a.js"))?.seen).toBe("all");
  });

  it("does not credit a sed range whose lines are not in the output", async () => {
    const tracker: ReadTracker = new Map();
    await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call("sed -n 1,3p src/a.js")],
      [result("line one\n[output trimmed]\n")],
    );
    expect(tracker.size).toBe(0);
  });

  it("a fresh cat replaces a stale full read, so write is allowed again", async () => {
    const file = path.join(dir, "src/a.js");
    const tracker: ReadTracker = new Map();
    await recordBashReads(tracker, dir, localOperations, [call("cat src/a.js")], [result(content)]);
    // The model's own script rewrites the file; the recorded read is now stale.
    await fs.writeFile(file, "rewritten\n");
    await fs.utimes(file, new Date(), new Date(Date.now() + 5000));
    await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call("cat src/a.js", "c2")],
      [result("rewritten\n", "c2")],
    );
    const write = createWriteTool(dir, tracker);
    await write.execute(
      { file_path: "src/a.js", content: "final\n" },
      { signal: new AbortController().signal, toolCallId: "w3" },
    );
    expect(await fs.readFile(file, "utf8")).toBe("final\n");
  });

  it("an edit after cat leaves the file fully known for a later write", async () => {
    const tracker: ReadTracker = new Map();
    await recordBashReads(tracker, dir, localOperations, [call("cat src/a.js")], [result(content)]);
    const edit = createEditTool(dir, tracker);
    await edit.execute(
      { file_path: "src/a.js", edits: [{ old_text: "line two", new_text: "line 2" }] },
      { signal: new AbortController().signal, toolCallId: "e1" },
    );
    expect(tracker.get(path.join(dir, "src/a.js"))?.seen).toBe("all");
  });
});
