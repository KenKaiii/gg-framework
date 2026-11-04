import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createWriteTool } from "./write.js";
import { recordRead, type ReadTracker } from "./read-tracker.js";
import { useFakeHome } from "../test-support/fake-home.js";

async function markRead(tracker: ReadTracker, filePath: string): Promise<void> {
  const stat = await fs.stat(filePath);
  const content = await fs.readFile(filePath, "utf-8");
  recordRead(tracker, filePath, content, stat.mtimeMs);
}

function resultToString(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result) {
    const c = (result as { content: unknown }).content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .map((b: { type: string; text?: string }) =>
          b.type === "text" ? (b.text ?? "") : "[image]",
        )
        .join("\n");
    }
  }
  return String(result);
}

describe("createWriteTool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("opts into sequential agent-loop execution", () => {
    const tool = createWriteTool(tmpDir);

    expect(tool.executionMode).toBe("sequential");
  });

  it("writes file and returns line count with absolute path", async () => {
    const tool = createWriteTool(tmpDir);
    const content = "line1\nline2\nline3\n";
    const raw = await tool.execute(
      { file_path: "test.txt", content },
      { signal: new AbortController().signal, toolCallId: "test-1" },
    );

    const result = resultToString(raw);
    expect(result).toBe(`Wrote 4 lines to ${path.join(tmpDir, "test.txt")}`);

    // Verify file was actually written
    const written = await fs.readFile(path.join(tmpDir, "test.txt"), "utf-8");
    expect(written).toBe(content);
  });

  it("reports correct line count for unicode content", async () => {
    const tool = createWriteTool(tmpDir);
    const content = "héllo wörld 🚀\n";
    const raw = await tool.execute(
      { file_path: "unicode.txt", content },
      { signal: new AbortController().signal, toolCallId: "test-2" },
    );

    const result = resultToString(raw);
    expect(result).toBe(`Wrote 2 lines to ${path.join(tmpDir, "unicode.txt")}`);
  });

  it("creates parent directories if needed", async () => {
    const tool = createWriteTool(tmpDir);
    const raw = await tool.execute(
      { file_path: "sub/dir/file.txt", content: "test\n" },
      { signal: new AbortController().signal, toolCallId: "test-3" },
    );

    const resolved = path.join(tmpDir, "sub/dir/file.txt");
    const result = resultToString(raw);
    expect(result).toBe(`Wrote 2 lines to ${resolved}`);

    // Verify file was actually created in the nested directory
    const written = await fs.readFile(resolved, "utf-8");
    expect(written).toBe("test\n");
  });

  it("allows overwriting files that have been read", async () => {
    const readFiles: ReadTracker = new Map();
    const filePath = path.join(tmpDir, "existing.txt");
    await fs.writeFile(filePath, "original");

    await markRead(readFiles, filePath);

    const tool = createWriteTool(tmpDir, readFiles);
    const raw = await tool.execute(
      { file_path: "existing.txt", content: "new content" },
      { signal: new AbortController().signal, toolCallId: "test-5" },
    );

    const result = resultToString(raw);
    expect(result).toContain("Wrote");
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("new content");
  });

  it("allows writing new files without reading", async () => {
    const readFiles: ReadTracker = new Map();
    const tool = createWriteTool(tmpDir, readFiles);

    const raw = await tool.execute(
      { file_path: "brand-new.txt", content: "hello" },
      { signal: new AbortController().signal, toolCallId: "test-6" },
    );

    const result = resultToString(raw);
    expect(result).toContain("Wrote 1 lines");
  });

  it("writes empty content", async () => {
    const tool = createWriteTool(tmpDir);
    const raw = await tool.execute(
      { file_path: "empty.txt", content: "" },
      { signal: new AbortController().signal, toolCallId: "test-9" },
    );

    const result = resultToString(raw);
    expect(result).toBe(`Wrote 1 lines to ${path.join(tmpDir, "empty.txt")}`);
  });

  it("calls mutation callback after successful writes", async () => {
    const mutated: string[] = [];
    const tool = createWriteTool(tmpDir, undefined, undefined, undefined, (filePath) => {
      mutated.push(filePath);
    });

    await tool.execute(
      { file_path: "mutated.txt", content: "changed" },
      { signal: new AbortController().signal, toolCallId: "test-mutated" },
    );

    expect(mutated).toEqual([path.join(tmpDir, "mutated.txt")]);
  });

  it("does not call mutation callback when write validation fails", async () => {
    const mutated: string[] = [];
    const tool = createWriteTool(tmpDir, new Map(), undefined, { current: true }, (mutatedPath) => {
      mutated.push(mutatedPath);
    });

    const result = await tool.execute(
      { file_path: "existing.txt", content: "new" },
      { signal: new AbortController().signal, toolCallId: "test-mutated-fail" },
    );

    expect(resultToString(result)).toContain("restricted in plan mode");
    expect(mutated).toEqual([]);
  });

  // Refusing an overwrite threw away the model's generated content and forced a
  // full regeneration. The write now always lands; lines it removed that the
  // model never saw are listed and the previous file is backed up.
  describe("unseen lines removed by an overwrite", () => {
    let restoreHome: () => void;

    // Backups go to ~/.gg/tool-output; keep them out of the real home.
    beforeEach(() => {
      restoreHome = useFakeHome(path.join(tmpDir, "home"));
    });

    afterEach(() => {
      restoreHome();
    });

    it("overwrites an unread file, listing the unseen lines it removed and backing them up", async () => {
      const readFiles: ReadTracker = new Map();
      const tool = createWriteTool(tmpDir, readFiles);
      const filePath = path.join(tmpDir, "existing.txt");
      await fs.writeFile(filePath, "keep\nold one\nold two\n");

      const result = resultToString(
        await tool.execute(
          { file_path: "existing.txt", content: "keep\nnew\n" },
          { signal: new AbortController().signal, toolCallId: "test-4" },
        ),
      );

      expect(await fs.readFile(filePath, "utf-8")).toBe("keep\nnew\n");
      expect(result).toContain("removed 2 lines you had not seen");
      expect(result).toContain("2|-old one\n3|-old two");
      expect(result).not.toContain("|-keep");
      const backup = /saved at (\S+)\./.exec(result)?.[1];
      expect(backup && (await fs.readFile(backup, "utf-8"))).toBe("keep\nold one\nold two\n");
    });

    it("reports lines another process added after the read when the overwrite drops them", async () => {
      const readFiles: ReadTracker = new Map();
      const filePath = path.join(tmpDir, "stale.txt");
      await fs.writeFile(filePath, "original");
      await markRead(readFiles, filePath);

      // External rewrite + bumped mtime
      await fs.writeFile(filePath, "original\nadded by teammate\n");
      const future = new Date(Date.now() + 5_000);
      await fs.utimes(filePath, future, future);

      const tool = createWriteTool(tmpDir, readFiles);
      const result = resultToString(
        await tool.execute(
          { file_path: "stale.txt", content: "from agent\n" },
          { signal: new AbortController().signal, toolCallId: "test-stale" },
        ),
      );
      expect(await fs.readFile(filePath, "utf-8")).toBe("from agent\n");
      expect(result).toContain("2|-added by teammate");
    });

    it("adds no note when the overwrite only adds lines to an unread file", async () => {
      const filePath = path.join(tmpDir, "grow.ts");
      await fs.writeFile(filePath, "one\ntwo\n");
      const tool = createWriteTool(tmpDir, new Map());

      const result = resultToString(
        await tool.execute(
          { file_path: "grow.ts", content: "zero\none\ntwo\nthree\n" },
          { signal: new AbortController().signal, toolCallId: "grow" },
        ),
      );
      expect(result).toBe(`Wrote 5 lines to ${filePath}`);
    });

    it("ignores CRLF-to-LF line endings when listing removed lines", async () => {
      const filePath = path.join(tmpDir, "crlf.ts");
      await fs.writeFile(filePath, "same\r\nold\r\nsame too\r\n");
      const tool = createWriteTool(tmpDir, new Map());

      const result = resultToString(
        await tool.execute(
          { file_path: "crlf.ts", content: "same\nnew\nsame too\n" },
          { signal: new AbortController().signal, toolCallId: "crlf" },
        ),
      );
      expect(result).toContain("removed 1 line you had not seen");
      expect(result).toContain("2|-old");
      expect(result).not.toContain("|-same");
    });

    it("summarizes the removed line numbers when there are too many to list", async () => {
      const filePath = path.join(tmpDir, "huge.ts");
      const original = Array.from({ length: 3000 }, (_, i) => `original line ${i + 1}`).join("\n");
      await fs.writeFile(filePath, original);
      const tool = createWriteTool(tmpDir, new Map());

      const result = resultToString(
        await tool.execute(
          { file_path: "huge.ts", content: "original line 1\nshort\n" },
          { signal: new AbortController().signal, toolCallId: "huge" },
        ),
      );
      expect(result).toContain(
        "removed 2999 lines you had not seen in their current form (old lines 2-3000)",
      );
      expect(result).not.toContain("|-original line 2");
    });

    // Regression: an unbounded line diff of a large rewrite took ~190s for 30k
    // lines and blocked the shared daemon. Past the cap it falls back to a count.
    it("reports a large, wholly different rewrite of an unread file without stalling", async () => {
      const filePath = path.join(tmpDir, "rewrite.ts");
      const lines = 20_000;
      await fs.writeFile(
        filePath,
        Array.from({ length: lines }, (_, i) => `const a${i} = ${i};`).join("\n"),
      );
      const kept = "const a7 = 7;";
      const next = [kept, ...Array.from({ length: lines }, (_, i) => `let b${i} = "${i}";`)];
      const tool = createWriteTool(tmpDir, new Map());

      const result = resultToString(
        await tool.execute(
          { file_path: "rewrite.ts", content: next.join("\n") },
          { signal: new AbortController().signal, toolCallId: "rewrite" },
        ),
      );
      expect(await fs.readFile(filePath, "utf-8")).toBe(next.join("\n"));
      // Line 8 survives (moved to the top); every other old line is reported.
      expect(result).toContain(
        `removed ${lines - 1} lines you had not seen in their current form (old lines 1-7, 9-${lines})`,
      );
    });
  });

  describe("LSP diagnostics", () => {
    it("appends a non-empty diagnostics string to the result", async () => {
      const seen: Array<{ filePath: string; content: string }> = [];
      const tool = createWriteTool(
        tmpDir,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async (filePath, content) => {
          seen.push({ filePath, content });
          return "\n\nDiagnostics in diag.ts (informational — may resolve after related edits):\nL1:1 boom (typescript)";
        },
      );

      const raw = await tool.execute(
        { file_path: "diag.ts", content: "const x = 1;\n" },
        { signal: new AbortController().signal, toolCallId: "test-diag-1" },
      );

      const result = resultToString(raw);
      expect(result).toContain(`Wrote 2 lines to ${path.join(tmpDir, "diag.ts")}`);
      expect(result).toContain("L1:1 boom (typescript)");
      expect(seen).toEqual([{ filePath: path.join(tmpDir, "diag.ts"), content: "const x = 1;\n" }]);
    });

    it("leaves the result unchanged when the provider returns empty", async () => {
      const tool = createWriteTool(
        tmpDir,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async () => "",
      );

      const raw = await tool.execute(
        { file_path: "clean.ts", content: "ok\n" },
        { signal: new AbortController().signal, toolCallId: "test-diag-2" },
      );

      expect(resultToString(raw)).toBe(`Wrote 2 lines to ${path.join(tmpDir, "clean.ts")}`);
    });

    it("leaves the result unchanged when the provider throws", async () => {
      const tool = createWriteTool(
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

      const raw = await tool.execute(
        { file_path: "throws.ts", content: "ok\n" },
        { signal: new AbortController().signal, toolCallId: "test-diag-3" },
      );

      expect(resultToString(raw)).toBe(`Wrote 2 lines to ${path.join(tmpDir, "throws.ts")}`);
      const written = await fs.readFile(path.join(tmpDir, "throws.ts"), "utf-8");
      expect(written).toBe("ok\n");
    });

    it("is identical to today when no provider is passed", async () => {
      const tool = createWriteTool(tmpDir);

      const raw = await tool.execute(
        { file_path: "plain.ts", content: "ok\n" },
        { signal: new AbortController().signal, toolCallId: "test-diag-4" },
      );

      expect(resultToString(raw)).toBe(`Wrote 2 lines to ${path.join(tmpDir, "plain.ts")}`);
    });
  });

  describe("workspace write guard", () => {
    it("blocks writes outside the workspace and does not create the file", async () => {
      const tool = createWriteTool(tmpDir);
      const outside = path.join(os.homedir(), "Documents", "gg-guard-test-outside.txt");

      const raw = await tool.execute(
        { file_path: outside, content: "nope\n" },
        { signal: new AbortController().signal, toolCallId: "guard-1" },
      );

      expect(resultToString(raw)).toContain("outside the workspace");
      expect(resultToString(raw)).toContain("allowOutsideWorkspaceWrites");
      await expect(fs.stat(outside)).rejects.toThrow();
    });

    // The allowOutsideWorkspaceWrites escape hatch is covered by
    // core/workspace-guard.test.ts — the tool just forwards the settings.
  });
});
