import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { slowRevParseGit } from "../test-support/slow-git.js";
import { readGitState, resolveGitCwd } from "./git-target.js";

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

describe("resolveGitCwd", () => {
  const repos = new Set(["/work/site", "/work/engine"]);
  const isRepo = async (dir: string): Promise<boolean> => repos.has(dir);

  it("uses the window's cwd outside a goal", async () => {
    expect(await resolveGitCwd("/work/site", null, isRepo)).toEqual({
      dir: "/work/site",
      settled: true,
    });
  });

  it("uses a goal's first attached folder that is a git repo", async () => {
    // Live bug: a goal window read git from its own goal folder, which isn't a
    // repo, so the titlebar never showed the project's uncommitted files.
    const goal = {
      context: [
        { path: "/work/site/README.md", kind: "file" as const },
        { path: "/work/notes", kind: "folder" as const },
        { path: "/work/site", kind: "folder" as const },
        { path: "/work/engine", kind: "folder" as const },
      ],
    };
    expect(await resolveGitCwd("/home/agent/goals/speed", goal, isRepo)).toEqual({
      dir: "/work/site",
      settled: true,
    });
  });

  it("keeps the goal folder when no attached folder is a repo", async () => {
    const goal = { context: [{ path: "/work/notes", kind: "folder" as const }] };
    expect(await resolveGitCwd("/home/agent/goals/speed", goal, isRepo)).toEqual({
      dir: "/home/agent/goals/speed",
      settled: true,
    });
  });

  it("skips a folder whose repo check fails, and says the choice is unsettled", async () => {
    const goal = {
      context: [
        { path: "/gone", kind: "folder" as const },
        { path: "/work/engine", kind: "folder" as const },
      ],
    };
    const flaky = async (dir: string): Promise<boolean> => {
      if (dir === "/gone") throw new Error("ENOENT");
      return repos.has(dir);
    };
    // A failed check is no answer: the caller re-reads with more time.
    expect(await resolveGitCwd("/home/agent/goals/speed", goal, flaky)).toEqual({
      dir: "/work/engine",
      settled: false,
    });
  });
});
