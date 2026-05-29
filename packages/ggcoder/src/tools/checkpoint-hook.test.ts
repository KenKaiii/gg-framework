import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { recordRead, type ReadTracker } from "./read-tracker.js";

let cwd: string;

function ctx() {
  return { signal: new AbortController().signal, toolCallId: "test" };
}

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ggcoder-hook-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("onPreFileMutation hook", () => {
  it("fires once for write before the file is written, with the resolved path", async () => {
    const seen: string[] = [];
    let contentAtHook: string | null = null;
    const target = path.join(cwd, "out.txt");

    const onPre = vi.fn(async (filePath: string) => {
      seen.push(filePath);
      contentAtHook = await fs.readFile(filePath, "utf-8").catch(() => "<absent>");
    });

    await fs.writeFile(target, "before");
    const readFiles: ReadTracker = new Map();
    recordRead(readFiles, target, "before", Date.now());

    const tool = createWriteTool(cwd, readFiles, undefined, undefined, undefined, undefined, onPre);
    await tool.execute({ file_path: "out.txt", content: "after" }, ctx());

    expect(onPre).toHaveBeenCalledTimes(1);
    expect(seen[0]).toBe(path.resolve(target));
    // Hook observed the OLD content (fired before the write).
    expect(contentAtHook).toBe("before");
    expect(await fs.readFile(target, "utf-8")).toBe("after");
  });

  it("fires once for edit before the file is rewritten", async () => {
    const target = path.join(cwd, "code.ts");
    await fs.writeFile(target, "const x = 1;\n");

    const readFiles: ReadTracker = new Map();
    recordRead(readFiles, target, "const x = 1;\n", Date.now());

    let contentAtHook: string | null = null;
    const onPre = vi.fn(async (filePath: string) => {
      contentAtHook = await fs.readFile(filePath, "utf-8");
    });

    const tool = createEditTool(cwd, readFiles, undefined, undefined, undefined, undefined, onPre);
    await tool.execute(
      { file_path: "code.ts", edits: [{ old_text: "const x = 1;", new_text: "const x = 2;" }] },
      ctx(),
    );

    expect(onPre).toHaveBeenCalledTimes(1);
    expect(contentAtHook).toBe("const x = 1;\n");
    expect(await fs.readFile(target, "utf-8")).toBe("const x = 2;\n");
  });

  it("does not fire for a no-op edit that writes nothing", async () => {
    const target = path.join(cwd, "code.ts");
    await fs.writeFile(target, "const x = 1;\n");
    const readFiles: ReadTracker = new Map();
    recordRead(readFiles, target, "const x = 1;\n", Date.now());

    const onPre = vi.fn();
    const tool = createEditTool(cwd, readFiles, undefined, undefined, undefined, undefined, onPre);
    await tool.execute(
      { file_path: "code.ts", edits: [{ old_text: "const x = 1;", new_text: "const x = 1;" }] },
      ctx(),
    );

    expect(onPre).not.toHaveBeenCalled();
  });
});
