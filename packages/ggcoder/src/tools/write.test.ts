import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createWriteTool } from "./write.js";
import { recordRead, type ReadTracker } from "./read-tracker.js";

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

  it("blocks overwriting existing files that haven't been read", async () => {
    const readFiles: ReadTracker = new Map();
    const tool = createWriteTool(tmpDir, readFiles);

    // Create an existing file
    const filePath = path.join(tmpDir, "existing.txt");
    await fs.writeFile(filePath, "original");

    await expect(
      tool.execute(
        { file_path: "existing.txt", content: "new content" },
        { signal: new AbortController().signal, toolCallId: "test-4" },
      ),
    ).rejects.toThrow("File must be read first");
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

  it("rejects overwriting when the file changed since it was read", async () => {
    const readFiles: ReadTracker = new Map();
    const filePath = path.join(tmpDir, "stale.txt");
    await fs.writeFile(filePath, "original");
    await markRead(readFiles, filePath);

    // External rewrite + bumped mtime
    await fs.writeFile(filePath, "external");
    const future = new Date(Date.now() + 5_000);
    await fs.utimes(filePath, future, future);

    const tool = createWriteTool(tmpDir, readFiles);
    await expect(
      tool.execute(
        { file_path: "stale.txt", content: "from agent" },
        { signal: new AbortController().signal, toolCallId: "test-stale" },
      ),
    ).rejects.toThrow(/modified since/);
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
    const readFiles: ReadTracker = new Map();
    const mutated: string[] = [];
    const filePath = path.join(tmpDir, "existing.txt");
    await fs.writeFile(filePath, "original");
    const tool = createWriteTool(tmpDir, readFiles, undefined, undefined, (mutatedPath) => {
      mutated.push(mutatedPath);
    });

    await expect(
      tool.execute(
        { file_path: "existing.txt", content: "new" },
        { signal: new AbortController().signal, toolCallId: "test-mutated-fail" },
      ),
    ).rejects.toThrow("File must be read first");

    expect(mutated).toEqual([]);
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
});
