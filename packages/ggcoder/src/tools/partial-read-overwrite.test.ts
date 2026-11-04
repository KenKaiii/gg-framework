import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { createTools } from "./index.js";
import type { ReadTracker } from "./read-tracker.js";
import { useFakeHome } from "../test-support/fake-home.js";

// A full-file `write` replaces every line. After a read cut short by
// offset/limit or the 2000-line cap, the lines it drops that the model never
// saw must never vanish silently: the write lands (refusing it threw away the
// generated content and forced a full regeneration), and its result lists
// exactly those lines and where the previous file was backed up.

function ctx(id: string) {
  return { signal: new AbortController().signal, toolCallId: id };
}

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("write after a partial read", () => {
  let tmpDir: string;
  let readFiles: ReadTracker;

  let restoreHome: () => void;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "partial-read-test-"));
    restoreHome = useFakeHome(path.join(tmpDir, "home"));
    readFiles = new Map();
  });

  afterEach(async () => {
    restoreHome();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function setup(name: string, content: string) {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, content);
    return {
      filePath,
      read: createReadTool(tmpDir, readFiles),
      write: createWriteTool(tmpDir, readFiles),
      edit: createEditTool(tmpDir, readFiles),
    };
  }

  it("lists only the unseen lines an overwrite after a limited read removed, with a backup", async () => {
    const original = numberedLines(50);
    const { filePath, read, write } = await setup("big.ts", original);
    await read.execute({ file_path: filePath, limit: 10 }, ctx("r1"));

    const result = String(
      await write.execute({ file_path: filePath, content: "replacement\n" }, ctx("w1")),
    );
    expect(await fs.readFile(filePath, "utf-8")).toBe("replacement\n");
    expect(result).toContain("removed 40 lines you had not seen");
    expect(result).toContain("11|-line 11\n");
    expect(result).toContain("50|-line 50");
    expect(result).not.toContain("|-line 10\n");
    const backup = /saved at (\S+)\./.exec(result)?.[1];
    expect(backup && (await fs.readFile(backup, "utf-8"))).toBe(original);
  });

  it("reports the lines past the 2000-line read cap that an overwrite removed", async () => {
    const { filePath, read, write } = await setup("huge.ts", numberedLines(2500));
    await read.execute({ file_path: filePath }, ctx("r1"));

    const result = String(
      await write.execute({ file_path: filePath, content: "replacement\n" }, ctx("w1")),
    );
    expect(result).toContain(
      "removed 500 lines you had not seen in their current form (old lines 2001-2500)",
    );
  });

  it("adds no note when an overwrite after a partial read keeps every unseen line", async () => {
    const original = numberedLines(50);
    const { filePath, read, write } = await setup("keep.ts", original);
    await read.execute({ file_path: filePath, limit: 10 }, ctx("r1"));

    const result = String(
      await write.execute(
        { file_path: filePath, content: original.replace("line 2\n", "line two\n") },
        ctx("w1"),
      ),
    );
    expect(result).toBe(`Wrote 50 lines to ${filePath}`);
  });

  it("allows the overwrite once the model has paged through every line", async () => {
    const { filePath, read, write } = await setup("huge.ts", numberedLines(2500));
    await read.execute({ file_path: filePath }, ctx("r1"));
    await read.execute({ file_path: filePath, offset: 2001 }, ctx("r2"));

    const result = await write.execute(
      { file_path: filePath, content: "replacement\n" },
      ctx("w1"),
    );
    expect(String(result)).toContain("Wrote");
    expect(await fs.readFile(filePath, "utf-8")).toBe("replacement\n");
  });

  it("lists only the gap between reads as unseen", async () => {
    const { filePath, read, write } = await setup("gappy.ts", numberedLines(30));
    await read.execute({ file_path: filePath, limit: 10 }, ctx("r1"));
    await read.execute({ file_path: filePath, offset: 21 }, ctx("r2"));

    const result = String(
      await write.execute({ file_path: filePath, content: "replacement\n" }, ctx("w1")),
    );
    expect(result).toContain("removed 10 lines you had not seen");
    expect(result).toContain("11|-line 11\n");
    expect(result).toContain("20|-line 20");
    expect(result).not.toContain("|-line 21");
  });

  it("keeps targeted edits working after a partial read, and reports what a later overwrite drops", async () => {
    const { filePath, read, write, edit } = await setup("mixed.ts", numberedLines(50));
    await read.execute({ file_path: filePath, limit: 10 }, ctx("r1"));

    await edit.execute(
      { file_path: filePath, edits: [{ old_text: "line 3\n", new_text: "line three\n" }] },
      ctx("e1"),
    );
    expect(await fs.readFile(filePath, "utf-8")).toContain("line three\nline 4");

    // The edit shifted lines, so none of the file counts as seen any more.
    const result = String(
      await write.execute({ file_path: filePath, content: "replacement\n" }, ctx("w1")),
    );
    expect(result).toContain("removed 50 lines you had not seen");
  });

  it("allows the overwrite after a full read followed by an edit", async () => {
    const { filePath, read, write, edit } = await setup("small.ts", numberedLines(5));
    await read.execute({ file_path: filePath }, ctx("r1"));
    await edit.execute(
      { file_path: filePath, edits: [{ old_text: "line 2", new_text: "line two" }] },
      ctx("e1"),
    );

    const result = await write.execute({ file_path: filePath, content: "fresh\n" }, ctx("w1"));
    expect(String(result)).toContain("Wrote");
  });

  // A line longer than the read tool's byte cap can never be shown. Counting
  // it as unseen would block `write` on the file forever (minified bundles,
  // one-line JSON), so the read reports the line and moves past it instead.
  it("does not trap a file whose line is too long to show", async () => {
    const { filePath, read, write } = await setup(
      "bundle.min.js",
      `${"x".repeat(60_000)}\nconsole.log(1);\n`,
    );

    const first = String(await read.execute({ file_path: filePath }, ctx("r1")));
    expect(first).toMatch(/Line 1 is too long to show[\s\S]*offset=2/);

    await read.execute({ file_path: filePath, offset: 2 }, ctx("r2"));
    const result = await write.execute({ file_path: filePath, content: "fresh\n" }, ctx("w2"));
    expect(String(result)).toBe(`Wrote 2 lines to ${filePath}`);
  });

  it("allows rewriting a file the model itself wrote in full", async () => {
    const { filePath, read, write } = await setup("own.ts", numberedLines(50));
    await read.execute({ file_path: filePath }, ctx("r1"));
    await write.execute({ file_path: filePath, content: numberedLines(3000) }, ctx("w1"));

    const result = await write.execute({ file_path: filePath, content: "again\n" }, ctx("w2"));
    expect(String(result)).toContain("Wrote");
  });
});

describe("clearing the read tracker", () => {
  let tmpDir: string;
  let restoreHome: () => void;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clear-read-test-"));
    restoreHome = useFakeHome(path.join(tmpDir, "home"));
  });

  afterEach(async () => {
    restoreHome();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("treats a file read before the conversation was rewound as unseen", async () => {
    const filePath = path.join(tmpDir, "notes.md");
    await fs.writeFile(filePath, "keep me\n");
    const result = await createTools(tmpDir, { lspDiagnostics: false });
    try {
      const read = result.tools.find((t) => t.name === "read");
      const write = result.tools.find((t) => t.name === "write");
      if (!read || !write) throw new Error("read/write tools missing");

      await read.execute({ file_path: filePath }, ctx("r1"));
      result.clearReadTracker();

      const out = String(
        await write.execute({ file_path: filePath, content: "gone\n" }, ctx("w1")),
      );
      expect(out).toContain("removed 1 line you had not seen");
      expect(out).toContain("1|-keep me");
    } finally {
      await result.lspManager?.shutdownAll();
      result.processManager.shutdownAll();
    }
  });
});
