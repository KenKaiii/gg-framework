import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BranchSwitchError,
  copyLocalFiles,
  listBranches,
  resolveResumeCheckout,
  switchBranch,
  worktreeMoveNote,
  worktreePathFor,
} from "./git-branches.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

let root: string;
let repo: string;
let trees: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gg-branches-")));
  repo = path.join(root, "app");
  trees = path.join(root, "worktrees");
  fs.mkdirSync(repo);
  // Deliberately not "main": nothing may assume a default branch name.
  git(repo, "init", "-q", "-b", "trunk");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env*\nnode_modules/\nsecret.json\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "branch", "feature/login");
  fs.writeFileSync(path.join(repo, ".env"), "KEY=1\n");
  fs.writeFileSync(path.join(repo, ".env.local"), "LOCAL=1\n");
  fs.writeFileSync(path.join(repo, "secret.json"), "{}\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const current = () => git(repo, "branch", "--show-current").trim();

describe("listBranches", () => {
  it("lists every local branch with the current one marked, whatever it is called", async () => {
    const list = await listBranches(repo);
    expect(list.current).toBe("trunk");
    expect(list.branches.map((b) => [b.name, b.current]).sort()).toEqual([
      ["feature/login", false],
      ["trunk", true],
    ]);
  });

  it("points at the other worktree that has a branch checked out", async () => {
    const elsewhere = path.join(root, "app-login");
    git(repo, "worktree", "add", "-q", elsewhere, "feature/login");
    const login = (await listBranches(repo)).branches.find((b) => b.name === "feature/login");
    expect(login?.worktree).toBe(fs.realpathSync(elsewhere));
    const fromThere = await listBranches(elsewhere);
    expect(fromThere.current).toBe("feature/login");
    expect(fromThere.branches.find((b) => b.name === "trunk")?.worktree).toBe(repo);
  });
});

describe("switchBranch", () => {
  const base = { dir: repo, worktreesRoot: "", create: false, isolate: false };
  const req = (over: Partial<typeof base> & { branch: string }) => ({
    ...base,
    dir: repo,
    worktreesRoot: trees,
    ...over,
  });

  it("switches in place when nobody else uses the checkout", async () => {
    expect(await switchBranch(req({ branch: "feature/login" }))).toEqual({
      kind: "switched",
      branch: "feature/login",
      previous: "trunk",
    });
    expect(current()).toBe("feature/login");
  });

  it("creates a branch in place from the current commit", async () => {
    await switchBranch(req({ branch: "topic", create: true }));
    expect(current()).toBe("topic");
  });

  it("moves to a new worktree instead when other windows share the checkout", async () => {
    const outcome = await switchBranch(req({ branch: "feature/login", isolate: true }));
    expect(current()).toBe("trunk");
    if (outcome.kind !== "moved") throw new Error(`expected a move, got ${outcome.kind}`);
    expect(outcome.created).toBe(true);
    expect(outcome.path.startsWith(fs.realpathSync(root))).toBe(true);
    expect(path.basename(outcome.path)).toBe("feature-login");
    expect(git(outcome.path, "branch", "--show-current").trim()).toBe("feature/login");
    // Ignored local config follows; other ignored files do not.
    expect(outcome.copied).toEqual([".env", ".env.local"]);
    expect(fs.readFileSync(path.join(outcome.path, ".env"), "utf8")).toBe("KEY=1\n");
    expect(fs.existsSync(path.join(outcome.path, "secret.json"))).toBe(false);
  });

  it("creates a new branch straight into its own worktree", async () => {
    const outcome = await switchBranch(req({ branch: "spike", create: true, isolate: true }));
    if (outcome.kind !== "moved") throw new Error("expected a move");
    expect(git(outcome.path, "branch", "--show-current").trim()).toBe("spike");
    expect(current()).toBe("trunk");
  });

  it("goes to the worktree that already has the branch, without creating another", async () => {
    const elsewhere = path.join(root, "app-login");
    git(repo, "worktree", "add", "-q", elsewhere, "feature/login");
    expect(await switchBranch(req({ branch: "feature/login" }))).toEqual({
      kind: "moved",
      branch: "feature/login",
      path: fs.realpathSync(elsewhere),
      created: false,
      copied: [],
    });
    expect(current()).toBe("trunk");
  });

  it("leaves the current branch alone", async () => {
    expect(await switchBranch(req({ branch: "trunk" }))).toEqual({
      kind: "unchanged",
      branch: "trunk",
    });
  });

  it.each([
    ["an invalid name", { branch: "bad..name", create: true }, /isn't a valid branch name/],
    ["an option-looking name", { branch: "-D", create: true }, /isn't a valid branch name/],
    ["a missing branch", { branch: "nope" }, /doesn't exist/],
    ["an existing branch to create", { branch: "feature/login", create: true }, /already exists/],
  ])("refuses %s", async (_label, over, message) => {
    await expect(switchBranch(req(over))).rejects.toThrow(message);
    expect(current()).toBe("trunk");
  });

  it("reports git's own reason when local changes would be overwritten", async () => {
    git(repo, "switch", "-q", "feature/login");
    fs.writeFileSync(path.join(repo, "a.txt"), "on login\n");
    git(repo, "commit", "-qam", "login");
    git(repo, "switch", "-q", "trunk");
    fs.writeFileSync(path.join(repo, "a.txt"), "uncommitted\n");
    const error = await switchBranch(req({ branch: "feature/login" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BranchSwitchError);
    expect(String((error as Error).message)).toMatch(/would be overwritten/);
    expect(current()).toBe("trunk");
  });
});

describe("worktree helpers", () => {
  it("never reuses an existing folder", async () => {
    const first = await worktreePathFor(trees, repo, "a/b");
    fs.mkdirSync(first, { recursive: true });
    const second = await worktreePathFor(trees, repo, "a/b");
    expect(path.basename(first)).toBe("a-b");
    expect(second).toBe(`${first}-2`);
  });

  it("copies what .worktreeinclude lists, and only ignored files", async () => {
    fs.writeFileSync(path.join(repo, ".worktreeinclude"), "secret.json\na.txt\n");
    const target = path.join(root, "copy-target");
    fs.mkdirSync(target);
    expect(await copyLocalFiles(repo, target)).toEqual(["secret.json"]);
  });

  it("tells the agent where it now works", () => {
    const note = worktreeMoveNote("/r/app", {
      kind: "moved",
      branch: "x",
      path: "/w/x",
      created: true,
      copied: [".env"],
    });
    expect(note).toContain("branch `x`");
    expect(note).toContain("Work only in /w/x");
    expect(note).toContain(".env");
  });
});

describe("resolveResumeCheckout (a resumed conversation keeps its branch)", () => {
  it("opens the main folder unchanged when it is still on the recorded branch", async () => {
    expect(await resolveResumeCheckout(repo, { branch: "trunk", cwd: repo }, trees)).toEqual({
      cwd: repo,
      note: null,
    });
  });

  it("goes back to the worktree the conversation was in", async () => {
    const moved = await switchBranch({
      dir: repo,
      branch: "feature/login",
      create: false,
      isolate: true,
      worktreesRoot: trees,
    });
    if (moved.kind !== "moved") throw new Error("expected a move");
    const record = { branch: "feature/login", cwd: moved.path };
    expect(await resolveResumeCheckout(repo, record, trees)).toEqual({
      cwd: moved.path,
      note: null,
    });
  });

  it("puts the branch in its own worktree when the folder moved on, leaving the folder alone", async () => {
    // Switched in place earlier; the folder has since gone back to trunk.
    const resumed = await resolveResumeCheckout(
      repo,
      { branch: "feature/login", cwd: repo },
      trees,
    );
    expect(current()).toBe("trunk");
    expect(resumed.cwd).not.toBe(repo);
    expect(git(resumed.cwd, "branch", "--show-current").trim()).toBe("feature/login");
    expect(resumed.note).toContain("feature/login");
    // The user sees why the window opened somewhere new.
    expect(resumed.notice).toBe(
      "Opened on branch feature/login in its own worktree, because the project folder is on trunk now.",
    );
  });

  it("finds the branch in whichever worktree has it now", async () => {
    const elsewhere = path.join(root, "app-login");
    git(repo, "worktree", "add", "-q", elsewhere, "feature/login");
    const resumed = await resolveResumeCheckout(
      repo,
      { branch: "feature/login", cwd: path.join(root, "gone") },
      trees,
    );
    expect(resumed.cwd).toBe(fs.realpathSync(elsewhere));
  });

  it("reopens in the folder, and says so, when the branch was deleted", async () => {
    const resumed = await resolveResumeCheckout(repo, { branch: "deleted", cwd: repo }, trees);
    expect(resumed.cwd).toBe(repo);
    expect(resumed.note).toMatch(/`deleted`, which no longer exists.*on `trunk`/);
    expect(resumed.notice).toBe(
      "Branch deleted no longer exists, so this conversation opened on trunk.",
    );
  });

  it("ignores a record from another repository", async () => {
    const other = path.join(root, "other");
    fs.mkdirSync(other);
    git(other, "init", "-q", "-b", "elsewhere");
    expect(await resolveResumeCheckout(repo, { branch: "elsewhere", cwd: other }, trees)).toEqual({
      cwd: repo,
      note: null,
    });
  });
});
