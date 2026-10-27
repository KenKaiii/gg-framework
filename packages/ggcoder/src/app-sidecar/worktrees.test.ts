import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorktreeRemoveError,
  listWorktrees,
  mainCheckoutOf,
  parseWorktreePorcelain,
  removeWorktree,
  resolveSetupCommand,
  setupNote,
} from "./worktrees.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

let root: string;
let repo: string;
let managed: string;
let mine: string;
let own: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gg-worktrees-")));
  repo = path.join(root, "app");
  managed = path.join(root, "gg-worktrees");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "trunk");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  mine = path.join(managed, "app-1234", "feature");
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", "feature", mine);
  fs.writeFileSync(path.join(mine, "b.txt"), "b\n");
  git(mine, "add", "-A");
  git(mine, "commit", "-q", "-m", "feature work");
  own = path.join(root, "app-own");
  git(repo, "worktree", "add", "-q", "-b", "own", own);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const options = (target: string, over: Partial<Parameters<typeof removeWorktree>[0]> = {}) => ({
  dir: repo,
  target,
  managedRoot: managed,
  force: false,
  openWindows: 0,
  ...over,
});

describe("listWorktrees", () => {
  it("lists linked worktrees with branch, ownership and status against the main folder", async () => {
    fs.writeFileSync(path.join(mine, "dirty.txt"), "x\n");
    const list = await listWorktrees(repo, managed);
    expect(list?.mainPath).toBe(repo);
    expect(list?.mainBranch).toBe("trunk");
    expect(list?.worktrees).toEqual([
      { path: mine, branch: "feature", managed: true, missing: false, dirty: 1, ahead: 1 },
      { path: own, branch: "own", managed: false, missing: false, dirty: 0, ahead: 0 },
    ]);
  });

  it("answers the same from inside a worktree, and names the main folder", async () => {
    expect((await listWorktrees(mine, managed))?.mainPath).toBe(repo);
    expect(await mainCheckoutOf(mine)).toBe(repo);
    expect(await mainCheckoutOf(repo)).toBe(repo);
    expect(await mainCheckoutOf(root)).toBeNull();
  });

  it("parses detached and prunable entries", () => {
    const parsed = parseWorktreePorcelain(
      "worktree /a\nHEAD 1\nbranch refs/heads/x\n\nworktree /b\nHEAD 2\ndetached\nprunable gitdir file points to non-existent location\n",
    );
    expect(parsed).toEqual([
      { path: "/a", head: "1", branch: "x", bare: false, prunable: false },
      { path: "/b", head: "2", branch: null, bare: false, prunable: true },
    ]);
  });
});

describe("removeWorktree", () => {
  it("removes a clean GG-made worktree and keeps its branch", async () => {
    await removeWorktree(options(mine));
    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.existsSync(path.dirname(mine))).toBe(false);
    expect(git(repo, "branch", "--list", "feature").trim()).toBe("feature");
  });

  it("refuses uncommitted changes unless forced", async () => {
    fs.writeFileSync(path.join(mine, "dirty.txt"), "x\n");
    const error = await removeWorktree(options(mine)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorktreeRemoveError);
    expect((error as WorktreeRemoveError).dirty).toBe(1);
    expect(fs.existsSync(mine)).toBe(true);
    await removeWorktree(options(mine, { force: true }));
    expect(fs.existsSync(mine)).toBe(false);
  });

  it("never removes the user's own worktrees, or one a window is open in", async () => {
    await expect(removeWorktree(options(own))).rejects.toThrow(/Only worktrees GG Coder made/);
    await expect(removeWorktree(options(mine, { openWindows: 1 }))).rejects.toThrow(
      /Close it first/,
    );
    await expect(removeWorktree(options(repo))).rejects.toThrow(/isn't a worktree/);
    expect(fs.existsSync(own) && fs.existsSync(mine)).toBe(true);
  });

  it("prunes a worktree whose folder was deleted", async () => {
    fs.rmSync(mine, { recursive: true, force: true });
    expect((await listWorktrees(repo, managed))?.worktrees[0]?.missing).toBe(true);
    await removeWorktree(options(mine));
    expect((await listWorktrees(repo, managed))?.worktrees.map((w) => w.branch)).toEqual(["own"]);
  });
});

describe("resolveSetupCommand", () => {
  it("prefers .gg/worktree.json, then the lockfile, else nothing", async () => {
    expect(await resolveSetupCommand(repo)).toBeNull();
    fs.writeFileSync(path.join(repo, "package-lock.json"), "{}");
    fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), "");
    expect(await resolveSetupCommand(repo)).toEqual({
      command: "pnpm install --frozen-lockfile --prefer-offline",
      source: "pnpm-lock.yaml",
    });
    fs.mkdirSync(path.join(repo, ".gg"));
    fs.writeFileSync(path.join(repo, ".gg", "worktree.json"), '{"setup": "make bootstrap"}');
    expect(await resolveSetupCommand(repo)).toEqual({
      command: "make bootstrap",
      source: path.join(".gg", "worktree.json"),
    });
    fs.writeFileSync(path.join(repo, ".gg", "worktree.json"), '{"setup": false}');
    expect(await resolveSetupCommand(repo)).toBeNull();
    fs.writeFileSync(path.join(repo, ".gg", "worktree.json"), "{not json");
    expect((await resolveSetupCommand(repo))?.source).toBe("pnpm-lock.yaml");
  });

  it("tells the agent what is running, or what it must do", () => {
    const setup = { command: "pnpm install", source: "pnpm-lock.yaml" };
    expect(setupNote(setup, "abc123")).toContain("background task abc123");
    expect(setupNote(setup, null)).toContain("could not start");
    expect(setupNote(null, null)).toContain("Install them");
  });
});
