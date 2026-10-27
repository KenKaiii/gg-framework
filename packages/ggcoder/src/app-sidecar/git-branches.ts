import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { CheckoutRecord } from "../core/checkout-record.js";
import { runBackgroundGit } from "../utils/git.js";

/**
 * The Git panel's branch picker: list local branches, and switch this window
 * to one. A checkout has one branch, so when other windows share this folder a
 * switch would move them too; instead this window gets its own worktree for
 * the branch (the pattern Claude Code, Codex and Conductor use for parallel
 * sessions). Nothing here assumes a branch name like `main`.
 */

const READ_TIMEOUT_MS = 5_000;
/** `git switch` / `git worktree add` check out files and run the repo's hooks. */
const WRITE_TIMEOUT_MS = 120_000;
const MAX_BRANCHES = 200;
/** Ignored local files bigger than this are not copied into a new worktree. */
const MAX_COPY_BYTES = 5 * 1024 * 1024;

export interface BranchRow {
  name: string;
  current: boolean;
  /** Another worktree that has this branch checked out, or null. */
  worktree: string | null;
  /** Last commit time, Unix seconds. */
  updatedAt: number;
}

export interface BranchList {
  current: string | null;
  branches: BranchRow[];
}

export type SwitchOutcome =
  | { kind: "unchanged"; branch: string }
  | { kind: "switched"; branch: string; previous: string | null }
  | { kind: "moved"; branch: string; path: string; created: boolean; copied: string[] };

/** A switch git refused; `message` is safe to show the user. */
export class BranchSwitchError extends Error {
  override name = "BranchSwitchError";
}

async function realRoot(dir: string): Promise<string> {
  const { stdout } = await runBackgroundGit(["rev-parse", "--show-toplevel"], {
    cwd: dir,
    timeoutMs: READ_TIMEOUT_MS,
  });
  return fs.realpath(stdout.trim());
}

async function currentBranch(dir: string): Promise<string | null> {
  try {
    const { stdout } = await runBackgroundGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: dir,
      timeoutMs: READ_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null; // detached HEAD
  }
}

/** Local branches, most recently committed first; `limit: null` lists all. */
export async function listBranches(
  dir: string,
  limit: number | null = MAX_BRANCHES,
): Promise<BranchList> {
  const root = await realRoot(dir);
  const current = await currentBranch(dir);
  const { stdout } = await runBackgroundGit(
    [
      "for-each-ref",
      "--sort=-committerdate",
      ...(limit === null ? [] : [`--count=${limit}`]),
      "--format=%(refname:short)%00%(committerdate:unix)%00%(worktreepath)",
      "refs/heads",
    ],
    { cwd: dir, timeoutMs: READ_TIMEOUT_MS },
  );
  const branches: BranchRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [name = "", time = "0", tree = ""] = line.split("\0");
    if (!name) continue;
    const elsewhere = tree ? await fs.realpath(tree).catch(() => tree) : "";
    branches.push({
      name,
      current: name === current,
      worktree: elsewhere && elsewhere !== root ? elsewhere : null,
      updatedAt: Number(time) || 0,
    });
  }
  return { current, branches };
}

/** Run git as the user would (hooks and LFS filters apply): this is their own action. */
function userGit(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, timeout: WRITE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const detail = (stderr || stdout || error.message).trim().split("\n").slice(-6).join("\n");
        reject(new BranchSwitchError(detail || "git failed"));
      },
    );
  });
}

async function validBranchName(dir: string, name: string): Promise<boolean> {
  if (!name || name.startsWith("-")) return false;
  try {
    await runBackgroundGit(["check-ref-format", "--branch", name], {
      cwd: dir,
      timeoutMs: READ_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/** `~/.gg/worktrees/<repo>-<hash>/<branch>`, outside the repo, never an existing path. */
export async function worktreePathFor(
  worktreesRoot: string,
  repoRoot: string,
  branch: string,
): Promise<string> {
  const hash = crypto.createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
  const folder = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "") || "branch";
  const base = path.join(worktreesRoot, `${path.basename(repoRoot)}-${hash}`, folder);
  let candidate = base;
  for (let n = 2; existsSync(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

/**
 * Copy the ignored local files a fresh checkout lacks (a worktree only gets
 * tracked files): those listed in `.worktreeinclude` (gitignore syntax, the
 * Claude Code / Conductor convention), else `.env` and `.env.*` at the root.
 * Only files git ignores are copied; dependencies are not.
 */
export async function copyLocalFiles(fromRoot: string, toRoot: string): Promise<string[]> {
  let candidates: string[];
  if (existsSync(path.join(fromRoot, ".worktreeinclude"))) {
    const { stdout } = await runBackgroundGit(
      ["ls-files", "--others", "--ignored", "--exclude-from=.worktreeinclude", "-z"],
      { cwd: fromRoot, timeoutMs: READ_TIMEOUT_MS },
    );
    candidates = stdout.split("\0").filter(Boolean);
  } else {
    candidates = (await fs.readdir(fromRoot)).filter((n) => /^\.env(\..+)?$/.test(n));
  }
  if (candidates.length === 0) return [];
  let ignored: Set<string>;
  try {
    const { stdout } = await runBackgroundGit(["check-ignore", "--stdin", "-z"], {
      cwd: fromRoot,
      timeoutMs: READ_TIMEOUT_MS,
      input: `${candidates.join("\0")}\0`,
    });
    ignored = new Set(stdout.split("\0").filter(Boolean));
  } catch {
    return []; // exit 1: none of them is ignored
  }
  const copied: string[] = [];
  for (const rel of candidates.sort()) {
    if (!ignored.has(rel)) continue;
    const from = path.join(fromRoot, rel);
    const stat = await fs.lstat(from).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_COPY_BYTES) continue;
    const to = path.join(toRoot, rel);
    if (existsSync(to)) continue;
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    copied.push(rel);
  }
  return copied;
}

export interface SwitchRequest {
  /** The checkout this window works in. */
  dir: string;
  branch: string;
  /** Create `branch` from the current commit. */
  create: boolean;
  /** Other windows share this checkout: never switch it, use a worktree. */
  isolate: boolean;
  /** Where new worktrees go (`~/.gg/worktrees`). */
  worktreesRoot: string;
}

/**
 * Put this window on `branch`. In place when nobody else uses the checkout;
 * otherwise in the worktree that already has the branch, or a new one.
 */
export async function switchBranch(req: SwitchRequest): Promise<SwitchOutcome> {
  const branch = req.branch.trim();
  if (!(await validBranchName(req.dir, branch))) {
    throw new BranchSwitchError(`“${branch}” isn't a valid branch name.`);
  }
  const root = await realRoot(req.dir);
  const { current, branches } = await listBranches(req.dir, null);
  const existing = branches.find((b) => b.name === branch);
  if (req.create && existing) throw new BranchSwitchError(`Branch “${branch}” already exists.`);
  if (!req.create && !existing) throw new BranchSwitchError(`Branch “${branch}” doesn't exist.`);
  if (branch === current) return { kind: "unchanged", branch };

  // Checked out in another worktree: git won't switch to it here; go there.
  if (existing?.worktree && existsSync(existing.worktree)) {
    return { kind: "moved", branch, path: existing.worktree, created: false, copied: [] };
  }

  if (!req.isolate) {
    await userGit(req.create ? ["switch", "-c", branch] : ["switch", branch], root);
    return { kind: "switched", branch, previous: current };
  }

  const target = await worktreePathFor(req.worktreesRoot, root, branch);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await userGit(
    req.create
      ? ["worktree", "add", "-b", branch, target, "HEAD"]
      : ["worktree", "add", target, branch],
    root,
  );
  const real = await fs.realpath(target);
  const copied = await copyLocalFiles(root, real).catch(() => []);
  return { kind: "moved", branch, path: real, created: true, copied };
}

async function commonGitDir(dir: string): Promise<string | null> {
  try {
    const { stdout } = await runBackgroundGit(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: dir, timeoutMs: READ_TIMEOUT_MS },
    );
    return await fs.realpath(stdout.trim());
  } catch {
    return null;
  }
}

export interface ResumeCheckout {
  /** Where the resumed conversation should work. */
  cwd: string;
  /** What to tell its agent, or null when nothing changed for it. */
  note: string | null;
  /** What to show the user in the chat, or null (see `noteCheckout`). */
  notice?: string | null;
  /** A worktree was created for it (and needs its setup run). */
  created?: boolean;
}

/**
 * Where a resumed conversation should open so it is back on the branch it
 * recorded (`record`), given the folder the window asked for. Never switches
 * a folder other windows may be using: a branch not checked out anywhere gets
 * its own worktree. A record from another repository is ignored.
 */
export async function resolveResumeCheckout(
  requestedCwd: string,
  record: CheckoutRecord,
  worktreesRoot: string,
): Promise<ResumeCheckout> {
  const unchanged: ResumeCheckout = { cwd: requestedCwd, note: null };
  const common = await commonGitDir(requestedCwd);
  if (!common) return unchanged;
  const requestedRoot = await realRoot(requestedCwd);

  const recordedCommon = existsSync(record.cwd) ? await commonGitDir(record.cwd) : null;
  // The conversation was in another repository: nothing here to restore.
  if (recordedCommon && recordedCommon !== common) return unchanged;
  // Still where it was, on its branch: go back there.
  if (recordedCommon && (await currentBranch(record.cwd)) === record.branch) {
    const recordedRoot = await realRoot(record.cwd);
    return recordedRoot === requestedRoot ? unchanged : { cwd: recordedRoot, note: null };
  }

  const { current, branches } = await listBranches(requestedCwd, null);
  const row = branches.find((b) => b.name === record.branch);
  if (!row) {
    return {
      cwd: requestedCwd,
      notice: `Branch ${record.branch} no longer exists, so this conversation opened on ${current ?? "the folder's current commit"}.`,
      note:
        `This conversation was on branch \`${record.branch}\`, which no longer exists. It ` +
        `reopened in ${requestedRoot}${current ? ` on \`${current}\`` : ""}; check git status ` +
        "before relying on earlier file contents.",
    };
  }
  if (row.current) return unchanged;
  if (row.worktree && existsSync(row.worktree)) {
    return {
      cwd: row.worktree,
      notice: `Opened on branch ${record.branch}, where it's checked out: ${row.worktree}.`,
      note: `This conversation's branch \`${record.branch}\` is checked out in ${row.worktree}; it reopened there.`,
    };
  }
  const outcome = await switchBranch({
    dir: requestedCwd,
    branch: record.branch,
    create: false,
    isolate: true,
    worktreesRoot,
  });
  if (outcome.kind !== "moved") return unchanged;
  return {
    cwd: outcome.path,
    note: worktreeMoveNote(requestedRoot, outcome),
    notice: `Opened on branch ${record.branch} in its own worktree, because the project folder is on ${current ?? "another commit"} now.`,
    created: outcome.created,
  };
}

/** What the agent is told after its window moved into a worktree. */
export function worktreeMoveNote(from: string, outcome: Extract<SwitchOutcome, { kind: "moved" }>) {
  const copied =
    outcome.copied.length > 0 ? ` Copied ignored local files: ${outcome.copied.join(", ")}.` : "";
  return (
    `The user switched this window to branch \`${outcome.branch}\` in its own git worktree at ` +
    `${outcome.path}, so it no longer shares ${from} with other windows. Work only in ` +
    `${outcome.path} from now on: files and paths you saw under ${from} earlier now live under ` +
    `${outcome.path}, and other windows may still be changing ${from}.${copied}`
  );
}
