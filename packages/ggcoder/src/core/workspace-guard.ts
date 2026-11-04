import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAppPaths } from "../config.js";
import {
  commandName,
  expandShellPath,
  type ShellInvocation,
  walkShell,
} from "./destructive-git-guard.js";
import { getTempRoots } from "./temp-paths.js";

/**
 * Workspace write guard + catastrophic-command guard.
 *
 * Enforced in code (not just prompt): write/edit targets outside the
 * allow-listed roots are blocked with an instructive tool error unless the
 * user opted in via the `allowOutsideWorkspaceWrites` setting. The bash tool
 * additionally refuses a tiny set of unambiguous filesystem disasters
 * (recursive removal of /, ~, $HOME, the workspace root or anything that
 * contains them, a bare drive root, and mirror force-pushes) until the user
 * explicitly confirms.
 *
 * Deliberately narrow: ordinary `rm -rf node_modules`, `git reset --hard`,
 * etc. stay instructional (ask-first at the prompt level), exactly as today.
 */

export interface WriteGuardSettings {
  allowOutsideWorkspaceWrites?: boolean;
  /** Extra workspace roots added at runtime via `/add-dir`. */
  additionalRoots?: string[];
}

export interface WriteGuardResult {
  allowed: boolean;
  reason?: string;
}

/** True when `target` is `root` or contained within it. */
function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve a path through symlinks, tolerating one that does not exist yet.
 *
 * `path.resolve` is pure string arithmetic: it collapses `..` but knows nothing
 * about links, so `<repo>/link/x` stays textually "inside the repo" even when
 * `link` points at the home directory. A repo we clone or open is untrusted
 * content, and a committed symlink is a normal thing for it to carry — so a
 * textual containment check hands any such repo a write primitive anywhere the
 * user can write (`~/.ssh/authorized_keys`, `~/.zshrc`), with no prompt.
 *
 * Writes usually target a file that does not exist yet, so `realpathSync` on
 * the full path would throw. Walk up to the nearest ancestor that DOES exist,
 * resolve that, then re-attach the remaining segments: the existing part is
 * where a planted link would have to live, and the non-existent tail cannot be
 * pointing anywhere yet.
 *
 * simplification: this is a check-then-write, so a link swapped in between the
 * two would still win (TOCTOU). Closing that needs the write itself to be
 * link-safe (`O_NOFOLLOW`), which Node does not expose on `writeFile`. The
 * planted-symlink case this blocks does not require the race; the racing one
 * needs code already executing locally.
 */
function realResolve(target: string): string {
  let current = path.resolve(target);
  const trailing: string[] = [];
  for (;;) {
    try {
      return path.resolve(realpathSync(current), ...trailing);
    } catch {
      const parent = path.dirname(current);
      // Hit the filesystem root without finding anything that exists: there is
      // no link on this path to resolve, so the textual form is already final.
      if (parent === current) return path.resolve(target);
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Decide whether a resolved write/edit target path is allowed.
 * Allowed by default: under `cwd`, under the OS temp dir, and under the
 * agent's own state dir (~/.gg) — sessions/plans/settings must keep working.
 *
 * Both sides are compared AFTER symlink resolution (see {@link realResolve}):
 * the target, so a link inside the workspace cannot point out of it, and the
 * roots, because the OS aliases its own (macOS `/tmp` → `/private/tmp`, and
 * `/var/folders` under it) and comparing a resolved target against an
 * unresolved root would deny every legitimate temp-dir write.
 */
export function resolveWriteGuard(
  cwd: string,
  resolvedPath: string,
  settings?: WriteGuardSettings,
): WriteGuardResult {
  if (settings?.allowOutsideWorkspaceWrites) return { allowed: true };

  const target = realResolve(resolvedPath);
  const extraRoots = (settings?.additionalRoots ?? []).map((root) => realResolve(root));
  const allowedRoots = [
    realResolve(cwd),
    ...extraRoots,
    ...getTempRoots().map(realResolve),
    realResolve(getAppPaths().agentDir),
  ];
  for (const root of allowedRoots) {
    if (isWithin(root, target)) return { allowed: true };
  }
  const workspaceRoots = [realResolve(cwd), ...extraRoots].join(", ");
  // Name the redirection when there is one: "foo/link/x is outside the
  // workspace" reads like a bug when the path visibly starts at the workspace.
  const literal = path.resolve(resolvedPath);
  const via = literal === target ? "" : ` (${literal} resolves there through a symlink)`;
  return {
    allowed: false,
    reason:
      `Blocked: ${target} is outside the workspace (${workspaceRoots})${via}. ` +
      "Writing outside the workspace requires user approval — ask the user to confirm, " +
      "or have them enable the allowOutsideWorkspaceWrites setting.",
  };
}

// ── Catastrophic command guard ─────────────────────────────

const CONFIRM_NOTE =
  "This command is irreversible and destroys data far beyond the workspace. " +
  "Get explicit user confirmation first, then re-run it quoting the user's words " +
  "authorizing it.";

/** Commands the guard inspects. `echo`/`printf` feed `… | xargs rm`. */
const INSPECTED: ReadonlySet<string> = new Set([
  "rm",
  "rd",
  "rmdir",
  "del",
  "erase",
  "remove-item",
  "ri",
  "find",
  "git",
  "echo",
  "printf",
]);

/** The directory a whole-contents glob empties: `X/*`, `X/.*` → X; `*`, `.*` → `.`. */
function globParent(target: string): string {
  if (target === "*" || target === ".*") return ".";
  const match = /^(.*)[\\/]\.?\*$/.exec(target);
  if (!match) return target;
  return match[1] === "" ? "/" : (match[1] ?? target);
}

function resolveTarget(target: string, runCwd: string): string {
  return path.resolve(runCwd, expandShellPath(target, runCwd));
}

/** A filesystem root (`/`, `C:\`), including a bare drive spec as written. */
function isRoot(target: string, resolved: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(target) || resolved === path.parse(resolved).root;
}

/**
 * Recursive removal of `rawTarget` is never acceptable without confirmation
 * when it is a filesystem root, the home directory, the workspace root, or a
 * directory containing either of the last two. `runCwd` is where the command
 * runs (after any `cd`); `workspace` is the session's project root.
 */
function isCatastrophicRemovalTarget(
  rawTarget: string,
  runCwd: string,
  workspace: string,
): boolean {
  const target = globParent(rawTarget);
  const resolved = resolveTarget(target, runCwd);
  if (isRoot(target, resolved)) return true;
  return [os.homedir(), workspace].some((protectedDir) =>
    isWithin(resolved, path.resolve(protectedDir)),
  );
}

/** `rm`: recursive flag in any spelling (`-r`, `-R`, `-rf`, `--recursive`, `-Recurse`) and operands. */
function parseRm(args: readonly string[]): { recursive: boolean; targets: string[] } {
  let recursive = false;
  const targets: string[] = [];
  let options = true;
  for (const arg of args) {
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && arg.startsWith("--") && arg.length > 2) {
      if ("--recursive".startsWith(arg) && arg.length >= 3) recursive = true;
      continue;
    }
    if (options && /^-[A-Za-z]+$/.test(arg)) {
      if (/[rR]/.test(arg)) recursive = true;
      continue;
    }
    targets.push(arg);
  }
  return { recursive, targets };
}

const PS_PATH_PARAMS = /^-(?:path|literalpath|lp|pspath)$/i;
const PS_VALUE_PARAMS = /^-(?:filter|include|exclude|credential|stream)$/i;
const PS_RECURSE = /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i;

/** PowerShell `Remove-Item` (alias `ri`): `-Recurse` plus `-Path`/positional targets. */
function parseRemoveItem(args: readonly string[]): { recursive: boolean; targets: string[] } {
  const targets: string[] = [];
  let recursive = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (PS_RECURSE.test(arg)) recursive = true;
    else if (PS_PATH_PARAMS.test(arg)) {
      if (args[i + 1] !== undefined) targets.push(args[i + 1] ?? "");
      i += 1;
    } else if (PS_VALUE_PARAMS.test(arg)) i += 1;
    else if (!arg.startsWith("-")) targets.push(arg);
  }
  return { recursive, targets };
}

/** cmd.exe `rd /s`, `rmdir /s`, `del /s`, `erase /s`. */
function parseCmdRemove(args: readonly string[]): { recursive: boolean; targets: string[] } {
  return {
    recursive: args.some((a) => /^\/s$/i.test(a)),
    targets: args.filter((a) => !/^\/[A-Za-z]$/.test(a)),
  };
}

/** find predicates that do not narrow which files match. */
const FIND_NON_FILTERS: ReadonlySet<string> = new Set([
  "-delete",
  "-depth",
  "-d",
  "-mindepth",
  "-maxdepth",
  "-xdev",
  "-mount",
  "-print",
  "-print0",
  "-follow",
  "-noleaf",
  "-ignore_readdir_race",
]);
const FIND_EXEC = /^-(?:exec|execdir|ok|okdir)$/;
const DELETERS: ReadonlySet<string> = new Set(["rm", "rmdir", "unlink", "shred"]);

/**
 * `find START… -delete` or `-exec rm …`. Blocks when a start is a root, home,
 * or contains home — always; and when it is (or contains) the workspace with
 * no narrowing test (`find . -name '*.log' -delete` is ordinary cleanup).
 */
function checkFind(call: ShellInvocation, workspace: string): string | null {
  const { args } = call;
  let i = 0;
  while (i < args.length && /^-(?:[HLP]|O\d)$/.test(args[i] ?? "")) i += 1;
  const starts: string[] = [];
  while (i < args.length && !/^[-(!]/.test(args[i] ?? "")) {
    starts.push(args[i] ?? "");
    i += 1;
  }
  let deletes = false;
  let filtered = false;
  const rest = args.slice(i);
  for (let j = 0; j < rest.length; j += 1) {
    const arg = rest[j] ?? "";
    if (arg === "-delete") deletes = true;
    if (FIND_EXEC.test(arg)) {
      if (DELETERS.has(commandName(rest[j + 1] ?? ""))) deletes = true;
      // Skip the exec'd command up to its `;` / `+` terminator.
      while (j + 1 < rest.length && rest[j + 1] !== ";" && rest[j + 1] !== "+") j += 1;
      j += 1;
      continue;
    }
    if ((arg.startsWith("-") && !FIND_NON_FILTERS.has(arg)) || arg === "!" || arg === "(")
      filtered = true;
  }
  if (!deletes) return null;
  for (const start of starts.length > 0 ? starts : ["."]) {
    const resolved = resolveTarget(start, call.cwd);
    const severe = isRoot(start, resolved) || isWithin(resolved, path.resolve(os.homedir()));
    const wipesWorkspace = !filtered && isWithin(resolved, path.resolve(workspace));
    if (severe || wipesWorkspace) {
      return `Refusing to run: find deletes everything under ${start}. ${CONFIRM_NOTE}`;
    }
  }
  return null;
}

/** `git push --force --mirror` (either order; `-f` counts as `--force`). */
function isMirrorForcePush(args: readonly string[]): boolean {
  const push = args.indexOf("push");
  if (push === -1) return false;
  const rest = args.slice(push + 1);
  return (
    rest.includes("--mirror") &&
    (rest.includes("--force") || rest.some((a) => /^-[A-Za-z]*f[A-Za-z]*$/.test(a)))
  );
}

/** Operands an `echo`/`printf` would hand to a following `| xargs`. */
function echoedOperands(call: ShellInvocation | undefined): string[] {
  if (!call || (call.name !== "echo" && call.name !== "printf")) return [];
  return call.args.filter((a) => !/^-[neE]+$/.test(a));
}

/**
 * Match only the unambiguous disasters, wherever they sit in the command —
 * after `;`/`&&`/`||`/pipes, inside `if`/`for`/`while`/`{ }`/`( )`, behind
 * wrappers (`sudo`, `env`, `timeout`, `nohup`, `nice`, `exec`, `time`,
 * `xargs`, …), inside `bash -c`/`eval`/`pwsh -c`, and after a `cd`:
 * - recursive `rm` (any flag spelling, any path form of the command) of a
 *   filesystem root, `~`/`$HOME`, the workspace root, a directory containing
 *   either, or the whole contents of one (`/*`, `cd ~ && rm -rf *`)
 * - the same through PowerShell `Remove-Item -Recurse` and cmd `rd /s`
 * - `find` deleting from root/home, or from the workspace with no filter
 * - `git push --force --mirror` (mirror force-push rewrites every ref)
 *
 * Returns an error string telling the model to get explicit user confirmation,
 * or null when the command is not catastrophic. Pure: nothing is executed.
 *
 * Backslashes are read both ways: as bash escapes, and literally, as cmd.exe
 * and PowerShell (the Windows fallbacks) read them, where `C:\Users\me` is a
 * path rather than `C:Usersme`. Either reading hitting a protected directory
 * blocks the command.
 */
export function isCatastrophicCommand(command: string, cwd: string): string | null {
  const readings = command.includes("\\") ? [command, command.replaceAll("\\", "\\\\")] : [command];
  for (const reading of readings) {
    const blocked = checkCalls(
      walkShell(reading, cwd, (name) => INSPECTED.has(name.toLowerCase())),
      cwd,
    );
    if (blocked) return blocked;
  }
  return null;
}

function checkCalls(calls: readonly ShellInvocation[], cwd: string): string | null {
  for (const [index, call] of calls.entries()) {
    const name = call.name.toLowerCase();
    if (name === "git") {
      if (isMirrorForcePush(call.args)) {
        return `Refusing to run: mirror force-push rewrites every ref on the remote. ${CONFIRM_NOTE}`;
      }
      continue;
    }
    if (name === "find") {
      const blocked = checkFind(call, cwd);
      if (blocked) return blocked;
      continue;
    }
    const parsed =
      name === "rm"
        ? parseRm(call.args)
        : name === "remove-item" || name === "ri"
          ? parseRemoveItem(call.args)
          : name === "rd" || name === "rmdir" || name === "del" || name === "erase"
            ? parseCmdRemove(call.args)
            : null;
    if (!parsed?.recursive) continue;
    // `echo ~ | xargs rm -rf`: the operands arrive on stdin from the echo.
    const targets =
      call.viaXargs && parsed.targets.length === 0
        ? echoedOperands(calls[index - 1])
        : parsed.targets;
    for (const target of targets) {
      if (isCatastrophicRemovalTarget(target, call.cwd, cwd)) {
        return `Refusing to run: recursive removal of ${target}. ${CONFIRM_NOTE}`;
      }
    }
  }
  return null;
}
