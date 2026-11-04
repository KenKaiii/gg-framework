import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectReferenceProjectFiles } from "./reference-project.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-reference-files-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function put(name: string, text = "export const value = 1;"): Promise<void> {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

const signal = (): AbortSignal => new AbortController().signal;

describe("collectReferenceProjectFiles", () => {
  it("sorts source files and respects generated directories and nested ignore rules", async () => {
    await put("z.js");
    await put("src/a.ts");
    await put("src/b.mjs");
    await put("node_modules/pkg/index.js");
    await put("dist/output.js");
    await put(".hidden/no.js");
    await put(".gitignore", "*.mjs\n");
    await put("src/.gitignore", "!b.mjs\n");
    const result = await collectReferenceProjectFiles(root, signal());
    expect(result.complete).toBe(true);
    expect(result.files).toEqual(
      ["src/a.ts", "src/b.mjs", "z.js"].map((file) => path.join(root, file)),
    );
  });

  it("does not follow directory links outside the project and marks incomplete coverage", async () => {
    await put("outside/secret.js");
    await fs.mkdir(path.join(root, "project"));
    await fs.symlink(path.join(root, "outside"), path.join(root, "project/link"), "junction");
    const result = await collectReferenceProjectFiles(path.join(root, "project"), signal());
    expect(result).toEqual({ files: [], complete: false });
  });

  it("reports a file cap rather than silently claiming complete coverage", async () => {
    await put("a.js");
    await put("b.js");
    const result = await collectReferenceProjectFiles(root, signal(), 1);
    expect(result.files).toHaveLength(1);
    expect(result.complete).toBe(false);
  });

  it("bounds directory entries even when they are not source files", async () => {
    await put("a.txt");
    await put("b.txt");
    const result = await collectReferenceProjectFiles(root, signal(), 256, 1);
    expect(result).toEqual({ files: [], complete: false });
  });

  it("honors cancellation before scanning", async () => {
    await put("a.js");
    const controller = new AbortController();
    controller.abort();
    expect(await collectReferenceProjectFiles(root, controller.signal)).toEqual({
      files: [],
      complete: false,
    });
  });
});
