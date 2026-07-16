import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { getGitDirtyFileCount } from "./git.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("getGitDirtyFileCount", () => {
  it("counts staged, modified, and untracked files", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gg-git-dirty-"));
    tempDirs.push(cwd);
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd });
    await execFileAsync("git", ["config", "user.name", "GG Test"], { cwd });

    await writeFile(path.join(cwd, "modified.txt"), "original\n");
    await execFileAsync("git", ["add", "modified.txt"], { cwd });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
    expect(await getGitDirtyFileCount(cwd)).toBe(0);

    await writeFile(path.join(cwd, "modified.txt"), "changed\n");
    await writeFile(path.join(cwd, "staged.txt"), "staged\n");
    await execFileAsync("git", ["add", "staged.txt"], { cwd });
    await writeFile(path.join(cwd, "untracked.txt"), "untracked\n");

    expect(await getGitDirtyFileCount(cwd)).toBe(3);
  });

  it("rejects outside a git repository so callers can preserve the last known count", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gg-not-git-"));
    tempDirs.push(cwd);

    await expect(getGitDirtyFileCount(cwd)).rejects.toBeDefined();
  });
});
