import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  branchChangeNote,
  checkSharedCheckoutSwitch,
  checkoutRoot,
  anyOtherWindowBusyOnCheckout,
  countOtherWindowsOnCheckout,
  describeOtherWindows,
  findBranchSwitches,
  parentCheckoutSharers,
} from "./shared-checkout-guard.js";
import { ProcessManager } from "./process-manager.js";
import { createBashTool } from "../tools/bash.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

describe("findBranchSwitches (parse)", () => {
  const cwd = path.resolve("/work/repo");
  const found = (command: string): string[] =>
    findBranchSwitches(command, cwd).map((m) => m.display);

  it.each([
    "git checkout -b feature",
    "git checkout -B feature origin/main",
    "git checkout --orphan pages",
    "git checkout -",
    "git checkout --detach v1.2",
    "git switch feature",
    "git switch -",
    "git switch -c feature",
    "git switch --detach HEAD~2",
    "git -C sub switch main",
    "cd sub && git checkout -b x",
    "gh pr checkout 123",
  ])("flags %s", (command) => {
    expect(found(command)).toHaveLength(1);
  });

  it.each([
    "git checkout -- a.ts",
    "git checkout main -- a.ts",
    "git checkout HEAD a.ts",
    "git checkout ./a.ts",
    "git checkout",
    "git switch --help",
    "git worktree add ../repo-feature -b feature",
    "git status && git log --oneline",
    "gh pr view 123",
    "echo 'git checkout -b x'",
  ])("ignores %s", (command) => {
    expect(found(command)).toEqual([]);
  });

  it("keeps an ambiguous `git checkout <name>` as a candidate to verify", () => {
    const [match] = findBranchSwitches("git checkout feature", cwd);
    expect(match?.maybeRef).toBe("feature");
  });

  it("follows cd and -C to the directory git runs in", () => {
    expect(findBranchSwitches("cd sub && git switch x", cwd)[0]?.dir).toBe(path.join(cwd, "sub"));
    expect(findBranchSwitches("git -C /other/repo switch x", cwd)[0]?.dir).toBe(
      path.resolve("/other/repo"),
    );
  });
});

describe("shared-checkout guard (real repo)", () => {
  let root: string;
  let repo: string;
  let worktree: string;

  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gg-shared-checkout-")));
    repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    git(repo, "init", "-q");
    fs.writeFileSync(path.join(repo, "a.ts"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "branch", "feature");
    worktree = path.join(root, "repo-wt");
    git(repo, "worktree", "add", "-q", worktree, "-b", "wt-branch");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves each worktree to its own checkout root", async () => {
    expect(await checkoutRoot(path.join(repo, "src"))).toBe(repo);
    expect(await checkoutRoot(worktree)).toBe(worktree);
    expect(await checkoutRoot(root)).toBeNull();
  });

  const sharedWith = (count: number, seen: string[] = []) => ({
    cwd: repo,
    sharedWith: async (r: string) => {
      seen.push(r);
      return describeOtherWindows(count);
    },
  });

  it("blocks a branch switch when another window uses the checkout", async () => {
    const seen: string[] = [];
    const message = await checkSharedCheckoutSwitch("git checkout -b topic", sharedWith(1, seen));
    expect(message).toMatch(
      /^Blocked `git checkout -b topic`: 1 other open GG Coder window also work/,
    );
    expect(message).toContain("git worktree add ../repo-<branch> -b <branch>");
    expect(message).toContain("GG_SHARED_CHECKOUT_OK=1");
    expect(seen).toEqual([repo]);
    expect(git(repo, "branch", "--show-current").trim()).toBe("main");
  });

  it("verifies an ambiguous name is a commit before blocking", async () => {
    expect(await checkSharedCheckoutSwitch("git checkout feature", sharedWith(2))).toMatch(
      /2 other open GG Coder windows/,
    );
    expect(await checkSharedCheckoutSwitch("git checkout no-such-ref", sharedWith(2))).toBeNull();
  });

  it("allows the switch when no other window shares the checkout", async () => {
    expect(await checkSharedCheckoutSwitch("git switch feature", sharedWith(0))).toBeNull();
  });

  it("checks the worktree's own root, not the main checkout's", async () => {
    const seen: string[] = [];
    await checkSharedCheckoutSwitch(`git -C '${worktree}' switch feature`, sharedWith(0, seen));
    expect(seen).toEqual([worktree]);
  });

  it("lets a user-confirmed switch through with the override", async () => {
    expect(
      await checkSharedCheckoutSwitch("GG_SHARED_CHECKOUT_OK=1 git switch feature", sharedWith(3)),
    ).toBeNull();
  });

  it("fails open when the window count cannot be read", async () => {
    const failing = {
      cwd: repo,
      sharedWith: async () => {
        throw new Error("boom");
      },
    };
    expect(await checkSharedCheckoutSwitch("git switch feature", failing)).toBeNull();
  });

  it("bash refuses the switch end to end and leaves the branch alone", async () => {
    const tool = createBashTool(
      repo,
      new ProcessManager(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => "the agent that started you",
    );
    const ctx = { signal: new AbortController().signal, toolCallId: "s1" };
    const result = await tool.execute({ command: "git switch -c topic2" }, ctx);
    expect(String(result)).toMatch(
      /^Error: Blocked `git switch -c topic2`: the agent that started you also work/,
    );
    expect(git(repo, "branch", "--show-current").trim()).toBe("main");
    const allowed = createBashTool(repo, new ProcessManager());
    const ran = await allowed.execute({ command: "git switch -q feature" }, ctx);
    expect(String(ran)).toContain("Exit code: 0");
    expect(git(repo, "branch", "--show-current").trim()).toBe("feature");
    git(repo, "switch", "-q", "main");
  });
});

describe("countOtherWindowsOnCheckout", () => {
  const roots: Record<string, string | null> = {
    "/r/app": "/r/app",
    "/r/app/src": "/r/app",
    "/r/app-wt": "/r/app-wt",
    "/notes": null,
  };
  const resolve = async (dir: string) => roots[dir] ?? null;

  it("counts other windows inside the same checkout, never itself or other worktrees", async () => {
    const windows = [
      { id: "self", gitDir: "/r/app" },
      { id: "b", gitDir: "/r/app/src" },
      { id: "c", gitDir: "/r/app-wt" },
      { id: "d", gitDir: "/notes" },
      { id: "e", gitDir: null },
    ];
    expect(await countOtherWindowsOnCheckout(windows, "self", "/r/app", resolve)).toBe(1);
    expect(await countOtherWindowsOnCheckout(windows, "c", "/r/app-wt", resolve)).toBe(0);
    expect(await countOtherWindowsOnCheckout(windows, "c", "/r/app", resolve)).toBe(2);
  });
});

describe("anyOtherWindowBusyOnCheckout", () => {
  const roots: Record<string, string> = {
    "/r/app": "/r/app",
    "/r/app/src": "/r/app",
    "/r/wt": "/r/wt",
  };
  const resolve = async (dir: string) => roots[dir] ?? null;
  const win = (id: string, gitDir: string, busy: boolean) => ({ id, gitDir, isBusy: () => busy });

  it("is true only for another working window in the same checkout", async () => {
    const windows = [
      win("self", "/r/app", true),
      win("b", "/r/app/src", false),
      win("c", "/r/wt", true),
    ];
    expect(await anyOtherWindowBusyOnCheckout(windows, "self", "/r/app", resolve)).toBe(false);
    expect(await anyOtherWindowBusyOnCheckout(windows, "b", "/r/app", resolve)).toBe(true);
    expect(await anyOtherWindowBusyOnCheckout(windows, "self", "/r/wt", resolve)).toBe(true);
  });
});

describe("parentCheckoutSharers (workers)", () => {
  it("treats the worker's own checkouts as shared with its parent, nothing else", async () => {
    const roots: Record<string, string | null> = { "/r/app/pkg": "/r/app", "/r/lib": "/r/lib" };
    let lookups = 0;
    const sharers = parentCheckoutSharers(["/r/app/pkg", "/r/lib", "/tmp/x"], async (dir) => {
      lookups++;
      return roots[dir] ?? null;
    });
    expect(await sharers("/r/app")).toMatch(/^the agent that started you/);
    expect(await sharers("/r/lib")).toMatch(/^the agent that started you/);
    expect(await sharers("/r/other")).toBeNull();
    expect(lookups).toBe(3);
  });
});

describe("branchChangeNote", () => {
  it("names both branches and asks for a fresh git status", () => {
    const note = branchChangeNote("main", "world-mode");
    expect(note).toContain("from `main` to `world-mode`");
    expect(note).toContain("git status");
  });
});
