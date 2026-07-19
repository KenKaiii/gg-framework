import os from "node:os";
import path from "node:path";
import { getAppPaths } from "../config.js";

/**
 * Workspace write guard + catastrophic-command guard.
 *
 * Enforced in code (not just prompt): write/edit targets outside the
 * allow-listed roots are blocked with an instructive tool error unless the
 * user opted in via the `allowOutsideWorkspaceWrites` setting. The bash tool
 * additionally refuses a tiny set of unambiguous filesystem disasters
 * (recursive force-remove of /, ~, $HOME, the workspace root, a bare drive
 * root, and mirror force-pushes) until the user explicitly confirms.
 *
 * Deliberately narrow: ordinary `rm -rf node_modules`, `git reset --hard`,
 * etc. stay instructional (ask-first at the prompt level), exactly as today.
 */

export interface WriteGuardSettings {
  allowOutsideWorkspaceWrites?: boolean;
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
 * Decide whether a resolved write/edit target path is allowed.
 * Allowed by default: under `cwd`, under the OS temp dir, and under the
 * agent's own state dir (~/.gg) — sessions/plans/settings must keep working.
 */
export function resolveWriteGuard(
  cwd: string,
  resolvedPath: string,
  settings?: WriteGuardSettings,
): WriteGuardResult {
  if (settings?.allowOutsideWorkspaceWrites) return { allowed: true };

  const target = path.resolve(resolvedPath);
  const allowedRoots = [
    path.resolve(cwd),
    path.resolve(os.tmpdir()),
    path.resolve(getAppPaths().agentDir),
  ];
  for (const root of allowedRoots) {
    if (isWithin(root, target)) return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      `Blocked: ${target} is outside the workspace (${path.resolve(cwd)}). ` +
      "Writing outside the workspace requires user approval — ask the user to confirm, " +
      "or have them enable the allowOutsideWorkspaceWrites setting.",
  };
}

// ── Catastrophic command guard ─────────────────────────────

/** Strip simple quoting so `rm -rf "/"` and `rm -rf '/'` match too. */
function unquote(token: string): string {
  const trimmed = token.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Targets whose recursive force-removal is never acceptable without explicit
 *  user confirmation. `cwd` adds the workspace root itself. */
function isCatastrophicRemovalTarget(rawTarget: string, cwd: string): boolean {
  const target = unquote(rawTarget);
  if (target === "/" || target === "~" || target === "$HOME" || target === "${HOME}") return true;
  // Bare drive roots (Windows-style), e.g. C:\ or C:/
  if (/^[A-Za-z]:[\\/]?$/.test(target)) return true;
  // Home directory or workspace root by absolute/relative path.
  const home = os.homedir();
  const resolved = path.resolve(cwd, target.replace(/^~(?=\/|$)/, home));
  if (resolved === path.resolve(home)) return true;
  if (resolved === path.resolve(cwd)) return true;
  if (resolved === path.parse(resolved).root) return true;
  return false;
}

/**
 * Match only the unambiguous disasters:
 * - `rm -rf` (any flag spelling including -r -f, -fr, --recursive --force)
 *   targeting /, ~, $HOME, the workspace root, or a bare drive root
 * - Windows `rd /s /q C:\` (or `rmdir`)
 * - `git push --force --mirror` (mirror force-push rewrites every ref)
 *
 * Returns an error string telling the model to get explicit user confirmation,
 * or null when the command is not catastrophic.
 */
export function isCatastrophicCommand(command: string, cwd: string): string | null {
  const confirmNote =
    "This command is irreversible and destroys data far beyond the workspace. " +
    "Get explicit user confirmation first, then re-run it quoting the user's words " +
    "authorizing it.";

  // rm with both recursive and force flags
  const rmMatch = /(?:^|[;&|]\s*)(?:sudo\s+)?rm\s+((?:-{1,2}[A-Za-z-]+\s+)+)(.+)/.exec(command);
  if (rmMatch) {
    const flags = rmMatch[1];
    const recursive = /(?:^|\s)-{1,2}(?:[a-zA-Z]*r[a-zA-Z]*|recursive)(?:\s|$)/.test(flags);
    const force = /(?:^|\s)-{1,2}(?:[a-zA-Z]*f[a-zA-Z]*|force)(?:\s|$)/.test(flags);
    if (recursive && force) {
      const targets = rmMatch[2].split(/\s+/).filter((t) => t.length > 0 && !t.startsWith("-"));
      for (const target of targets) {
        if (isCatastrophicRemovalTarget(target, cwd)) {
          return `Refusing to run: recursive force-remove of ${unquote(target)}. ${confirmNote}`;
        }
      }
    }
  }

  // Windows: rd /s /q C:\  (or rmdir)
  const rdMatch = /(?:^|[;&|]\s*)(?:rd|rmdir)\s+((?:\/[sq]\s+)+)(.+)/i.exec(command);
  if (rdMatch && /\/s/i.test(rdMatch[1])) {
    const targets = rdMatch[2].split(/\s+/).filter((t) => t.length > 0 && !t.startsWith("/"));
    for (const target of targets) {
      if (isCatastrophicRemovalTarget(target, cwd)) {
        return `Refusing to run: recursive removal of ${unquote(target)}. ${confirmNote}`;
      }
    }
  }

  // git push --force --mirror (in either order; -f counts as --force)
  if (
    /(?:^|[;&|]\s*)git\s+push\b/.test(command) &&
    /\s--mirror\b/.test(command) &&
    /\s(?:--force\b|-f\b)/.test(command)
  ) {
    return `Refusing to run: mirror force-push rewrites every ref on the remote. ${confirmNote}`;
  }

  return null;
}
