import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slowRevParseGit } from "../test-support/slow-git.js";
import { getGitDirtyFileCount, isGitRepo } from "./git.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
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

describe("isGitRepo", () => {
  it("is false when git answers that the folder is not a repo", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gg-not-git-"));
    tempDirs.push(cwd);

    expect(await isGitRepo(cwd)).toBe(false);
  });

  // Regression: a git call that timed out on a busy CI machine was reported
  // as "not a repo", so a goal window's titlebar lost the project's changes.
  it.skipIf(process.platform === "win32")(
    "rejects instead of answering false when git does not answer in time",
    async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), "gg-git-slow-"));
      tempDirs.push(cwd);
      await execFileAsync("git", ["init", "-q"], { cwd });
      tempDirs.push(await slowRevParseGit(1));

      await expect(isGitRepo(cwd, { timeoutMs: 100 })).rejects.toBeDefined();
      expect(await isGitRepo(cwd, { timeoutMs: 5_000 })).toBe(true);
    },
  );
});
