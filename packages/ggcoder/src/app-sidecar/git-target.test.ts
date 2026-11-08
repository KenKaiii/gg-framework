import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { slowRevParseGit } from "../test-support/slow-git.js";
import { readGitState } from "./git-target.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("readGitState", () => {
  // Regression: on a busy CI machine git missed GG's 2-second limit and the
  // repo was reported as "not a repo, 0 changed files" with nothing to say the
  // answer was a guess, so it was never corrected.
  it.skipIf(process.platform === "win32")(
    "marks a too-slow answer as unsettled, and a longer read gets the real state",
    async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), "gg-git-target-"));
      tempDirs.push(cwd);
      await execFileAsync("git", ["init", "-q"], { cwd });
      await writeFile(path.join(cwd, "a.txt"), "changed\n");
      tempDirs.push(await slowRevParseGit(1));

      expect(await readGitState(cwd, { timeoutMs: 100 })).toMatchObject({
        isRepo: false,
        settled: false,
      });
      expect(await readGitState(cwd, { timeoutMs: 5_000 })).toMatchObject({
        isRepo: true,
        dirtyFileCount: 1,
        settled: true,
      });
    },
  );

  it("is settled for a folder git says is not a repo", async () => {
    // `git status` fails outside a repo; that must read as 0, not reject the whole state.
    const cwd = await mkdtemp(path.join(tmpdir(), "gg-git-target-plain-"));
    tempDirs.push(cwd);
    expect(await readGitState(cwd)).toMatchObject({
      branch: null,
      isRepo: false,
      dirtyFileCount: 0,
      gitHubSlug: null,
      settled: true,
    });
  });
});
