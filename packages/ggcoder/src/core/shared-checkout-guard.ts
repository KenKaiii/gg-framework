import { existsSync } from "node:fs";
import path from "node:path";
import { realpathNative, runBackgroundGit } from "../utils/git.js";
import {
  hasLong,
  hasShort,
  isPathspecShaped,
  operands,
  parseGitInvocation,
  splitAtDoubleDash,
  walkShell,
} from "./destructive-git-guard.js";
import { log } from "./logger.js";

/**
 * Branch switches in a checkout another open window also uses.
 *
 * A git checkout has ONE branch. Two app windows on the same folder share it,
 * so an agent in one window that runs `git checkout -b feature` moves the other
 * window onto `feature` too — its files change underneath it, and its agent
 * keeps editing and committing on a branch it never chose (observed: a goal's
 * agent switched the shared gg-coder checkout and later commits swept another
 * window's uncommitted work onto that branch). A separate worktree gives each
 * branch its own folder, so the guard blocks the switch and points there.
 */

/** Set on the command (`GG_SHARED_CHECKOUT_OK=1 git checkout …`) after the user confirms. */
export const SHARED_CHECKOUT_OVERRIDE = "GG_SHARED_CHECKOUT_OK";

const GIT_TIMEOUT_MS = 3_000;
const SWITCH_VALUE_OPTS: ReadonlySet<string> = new Set(["-c", "-C", "--orphan", "--conflict"]);
const CHECKOUT_VALUE_OPTS: ReadonlySet<string> = new Set([
  "-b",
  "-B",
  "--orphan",
  "--conflict",
  "-U",
  "--unified",
]);

export interface BranchSwitch {
  /** The invocation, for the block message. */
  display: string;
  /** Directory it would run in (after `cd`, `-C`). */
  dir: string;
  /** `--git-dir=`/`--work-tree=` globals to forward when resolving the checkout. */
  gitArgs: string[];
  /** `git checkout <name>`: switches only when `name` is a commit-ish, not a path. */
  maybeRef?: string;
}

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function classifyGit(args: readonly string[], cwd: string): BranchSwitch | null {
  const { dir, gitArgs, subcommand, rest } = parseGitInvocation(args, cwd);
  if (subcommand === undefined) return null;
  const base = { display: truncate(["git", subcommand, ...rest].join(" ")), dir, gitArgs };
  if (rest.some((t) => t === "-h" || t === "--help")) return null;

  if (subcommand === "switch") {
    const creates = hasShort(rest, "c") || hasShort(rest, "C") || hasLong(rest, "--orphan");
    const detach = hasShort(rest, "d") || hasLong(rest, "--detach", 5);
    // A bare `-` is the previous branch, not an option.
    const previous = rest.includes("-");
    return creates || detach || previous || operands(rest, SWITCH_VALUE_OPTS).length > 0
      ? base
      : null;
  }

  if (subcommand === "checkout") {
    const { before, after } = splitAtDoubleDash(rest);
    if (before.some((t) => t === "-b" || t === "-B" || t === "--orphan")) return base;
    // `git checkout [<ref>] -- <paths>` restores files; the branch stays.
    if (after !== null) return null;
    // A bare `-` is the previous branch, not an option.
    if (before.includes("-")) return base;
    const positional = operands(before, CHECKOUT_VALUE_OPTS);
    // Two operands is `<tree-ish> <paths>`, a file restore.
    if (positional.length !== 1) return null;
    const operand = positional[0] ?? "";
    if (hasShort(before, "d") || hasLong(before, "--detach", 5)) return base;
    if (isPathspecShaped(operand) || existsSync(path.resolve(dir, operand))) return null;
    return { ...base, maybeRef: operand };
  }
  return null;
}

/**
 * Every invocation in `command` that changes the branch of the checkout it runs
 * in: `git switch`, `git checkout <branch>` / `-b`, `gh pr checkout`. Pure apart
 * from `existsSync` for the ambiguous `git checkout <name>`.
 */
export function findBranchSwitches(command: string, cwd: string): BranchSwitch[] {
  const out: BranchSwitch[] = [];
  for (const call of walkShell(command, cwd, (name) => name === "git" || name === "gh")) {
    if (call.name === "gh") {
      const [group, action] = operands(call.args, new Set(["-R", "--repo"]));
      if (group === "pr" && action === "checkout") {
        out.push({ display: truncate(["gh", ...call.args].join(" ")), dir: call.cwd, gitArgs: [] });
      }
      continue;
    }
    const match = classifyGit(call.args, call.cwd);
    if (match) out.push(match);
  }
  return out;
}

/**
 * The root of the checkout (working tree) `dir` belongs to, symlinks resolved,
 * or null outside a repo. Each worktree is its own checkout with its own root.
 */
export async function checkoutRoot(
  dir: string,
  gitArgs: readonly string[] = [],
): Promise<string | null> {
  try {
    const { stdout } = await runBackgroundGit(["rev-parse", "--show-toplevel"], {
      cwd: dir,
      globalArgs: gitArgs,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const top = stdout.trim();
    return top ? await realpathNative(top) : null;
  } catch {
    return null;
  }
}

async function isCommit(match: BranchSwitch, ref: string): Promise<boolean> {
  try {
    await runBackgroundGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: match.dir,
      globalArgs: match.gitArgs,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export interface SharedCheckoutCheckOptions {
  /** The tool's working directory. */
  cwd: string;
  /** The shell's real directory when it can differ from `cwd` (persistent shell). */
  resolveCwd?: () => Promise<string | null>;
  /**
   * Who else works in the checkout rooted at `root` ("2 other open GG Coder
   * windows", "the agent that started you"), or null when nobody does.
   */
  sharedWith: (root: string) => Promise<string | null>;
}

/** "1 other open GG Coder window" / "3 other open GG Coder windows", or null for none. */
export function describeOtherWindows(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 other open GG Coder window" : `${count} other open GG Coder windows`;
}

function blockMessage(match: BranchSwitch, root: string, others: string): string {
  const repo = path.basename(root);
  return (
    `Blocked \`${match.display}\`: ${others} also work in this checkout (${root}). A checkout has one ` +
    "branch, so switching it here switches it for them too: their files change underneath " +
    "them and their agents keep editing and committing on the new branch. Work in a separate " +
    `worktree instead, e.g. \`git worktree add ../${repo}-<branch> -b <branch>\` (or ` +
    "`git worktree add <folder> <existing-branch>`), then run your commands in that folder; " +
    "the user can open it in its own window. If the user explicitly wants this shared checkout " +
    `switched, confirm with ask_user first, then re-run the command prefixed with ` +
    `\`${SHARED_CHECKOUT_OVERRIDE}=1\`.`
  );
}

/**
 * Returns a block message for the model when `command` would switch the branch
 * of a checkout another open window also uses, or null to let it run. Fails
 * open: a guard error never blocks a command.
 */
export async function checkSharedCheckoutSwitch(
  command: string,
  options: SharedCheckoutCheckOptions,
): Promise<string | null> {
  try {
    if (!/\b(git|gh)\b/.test(command)) return null;
    if (new RegExp(`(^|[\\s;&|(])${SHARED_CHECKOUT_OVERRIDE}=1(\\s|$)`).test(command)) return null;
    let matches = findBranchSwitches(command, options.cwd);
    if (matches.length === 0) return null;
    if (options.resolveCwd) {
      const real = await options.resolveCwd();
      if (real && path.isAbsolute(real) && real !== options.cwd) {
        matches = findBranchSwitches(command, real);
      }
    }
    const reasons: string[] = [];
    for (const match of matches) {
      if (!existsSync(match.dir)) continue;
      if (match.maybeRef !== undefined && !(await isCommit(match, match.maybeRef))) continue;
      const root = await checkoutRoot(match.dir, match.gitArgs);
      if (!root) continue;
      const others = await options.sharedWith(root);
      if (others) reasons.push(blockMessage(match, root, others));
    }
    return reasons.length > 0 ? reasons.join("\n") : null;
  } catch (error) {
    log("WARN", "git-guard", `Shared-checkout guard failed open: ${(error as Error).message}`);
    return null;
  }
}

/**
 * How many windows other than `selfId` read git from a folder inside the
 * checkout rooted at `root`. `resolveRoot` is {@link checkoutRoot}, injectable.
 */
export async function countOtherWindowsOnCheckout(
  windows: readonly { id: string; gitDir: string | null }[],
  selfId: string,
  root: string,
  resolveRoot: (dir: string) => Promise<string | null> = (dir) => checkoutRoot(dir),
): Promise<number> {
  const others = windows.filter((w) => w.id !== selfId && w.gitDir !== null);
  const roots = await Promise.all(others.map((w) => resolveRoot(w.gitDir ?? "")));
  return roots.filter((r) => r === root).length;
}

/** Whether any window other than `selfId` in the checkout rooted at `root` is working. */
export async function anyOtherWindowBusyOnCheckout(
  windows: readonly { id: string; gitDir: string | null; isBusy: () => boolean }[],
  selfId: string,
  root: string,
  resolveRoot: (dir: string) => Promise<string | null> = (dir) => checkoutRoot(dir),
): Promise<boolean> {
  const busy = windows.filter((w) => w.id !== selfId && w.gitDir !== null && w.isBusy());
  const roots = await Promise.all(busy.map((w) => resolveRoot(w.gitDir ?? "")));
  return roots.includes(root);
}

/**
 * For a worker agent: its parent (and every sibling worker and window) works in
 * the checkouts of `dirs`, the worker's cwd and shared roots. Resolved once,
 * lazily, on the first branch switch the worker tries.
 */
export function parentCheckoutSharers(
  dirs: readonly string[],
  resolveRoot: (dir: string) => Promise<string | null> = (dir) => checkoutRoot(dir),
): (root: string) => Promise<string | null> {
  let roots: Promise<Set<string>> | undefined;
  return async (root) => {
    roots ??= Promise.all(dirs.map(resolveRoot)).then(
      (found) => new Set(found.filter((r): r is string => r !== null)),
    );
    return (await roots).has(root)
      ? "the agent that started you (and any window or worker on this folder)"
      : null;
  };
}

/**
 * The note an agent gets when its checkout's branch changed while it was not
 * looking (another window, the user's terminal, or its own last command).
 */
export function branchChangeNote(previous: string, next: string): string {
  return (
    `The git branch of this checkout changed from \`${previous}\` to \`${next}\` (switched by ` +
    "another window, the user, or one of your own commands). Your working files now follow " +
    `\`${next}\`: re-check \`git status\` before editing or committing, and don't assume ` +
    `\`${previous}\` is still checked out.`
  );
}
