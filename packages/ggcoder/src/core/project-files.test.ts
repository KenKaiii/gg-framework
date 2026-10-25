import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listProjectFiles, PROJECT_FILES_SHOWN } from "./project-files.js";

const tempDirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ggcoder-project-files-"));
  tempDirs.push(dir);
  return dir;
}

async function put(root: string, rel: string, body = "x"): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), body);
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fs.rm(tempDirs.pop() ?? "", { recursive: true, force: true });
  }
});

describe("listProjectFiles", () => {
  it("lists tracked and untracked files shallowest first, skipping ignored and .gg/", async () => {
    const root = await makeDir();
    execFileSync("git", ["init", "-q"], { cwd: root });
    await put(root, ".gitignore", "dist/\n");
    await put(root, "src/lib/deep.js");
    await put(root, "src/b.js");
    await put(root, "src/a.js");
    await put(root, "package.json");
    await put(root, "dist/out.js");
    await put(root, ".gg/state.json");
    execFileSync("git", ["add", "src/a.js", "package.json"], { cwd: root });

    expect(await listProjectFiles(root)).toEqual({
      total: 5,
      shown: [".gitignore", "package.json", "src/a.js", "src/b.js", "src/lib/deep.js"],
    });
  });

  it("caps the shown list but reports the total", async () => {
    const root = await makeDir();
    execFileSync("git", ["init", "-q"], { cwd: root });
    for (let i = 0; i < PROJECT_FILES_SHOWN + 5; i++) {
      await put(root, `f${String(i).padStart(3, "0")}.txt`);
    }
    const list = await listProjectFiles(root);
    expect(list?.total).toBe(PROJECT_FILES_SHOWN + 5);
    expect(list?.shown).toHaveLength(PROJECT_FILES_SHOWN);
    expect(list?.shown[0]).toBe("f000.txt");
  });

  it("returns null outside a git work tree", async () => {
    const root = await makeDir();
    await put(root, "a.txt");
    expect(await listProjectFiles(root)).toBeNull();
  });
});
