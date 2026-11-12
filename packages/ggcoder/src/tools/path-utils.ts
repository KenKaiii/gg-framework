import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getMsysTempDir } from "../core/temp-paths.js";

export interface ResolvePathOpts {
  /** Injected for testability; defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/**
 * MSYS drive path → native Windows path, e.g. `/c/Users/x` → `C:\Users\x`.
 *
 * On Windows our bash tool runs Git Bash (see core/shell.ts), an MSYS2
 * environment, so command output is full of `/c/...`, `//c/...` and
 * `/cygdrive/c/...` paths. The model reads those out of bash output and hands
 * them straight back to the file tools; `path.resolve` then turns `/c/Users/x`
 * into `C:\c\Users\x`, which never exists, so every such call fails and the
 * agent burns turns guessing.
 *
 * Deliberate non-goals:
 *   - Non-Windows platforms are left completely alone: `/c/foo` is a perfectly
 *     legitimate POSIX path on macOS/Linux and rewriting it would be a
 *     data-corrupting regression. Hence the strict platform gate.
 *   - Virtual mounts are not guessed here. `resolvePath` separately handles
 *     `/tmp` using the selected shell's cached mount lookup; `/usr`, `/home`
 *     and `/bin` remain untranslated.
 *   - Drive conversion is pure string manipulation, with no process spawn.
 */
export function msysToWindowsPath(filePath: string, opts: ResolvePathOpts = {}): string {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return filePath;
  // `//c/x` (MSYS's own drive spelling) and `/cygdrive/c/x` mean exactly the
  // same as `/c/x`. The drive must be a single letter and must be followed by a
  // separator or end-of-string, so `/config` and `/cygdrive` stay untouched.
  //
  // `//c/x` is formally ambiguous with a UNC path whose HOST is one character.
  // Single-letter hostnames don't exist in practice and Git Bash really does
  // emit this form for drives, so translating is the right bet.
  const match = /^(?:\/\/|\/cygdrive\/|\/)([A-Za-z])(?:\/(.*))?$/.exec(filePath);
  if (!match) return filePath;
  const drive = match[1].toUpperCase();
  const rest = match[2] ?? "";
  // Always keep the trailing separator: bare `C:` is drive-RELATIVE on Windows
  // (the cwd of that drive), which is not what `/c` means.
  return `${drive}:\\${rest.replaceAll("/", "\\")}`;
}

export function resolvePath(cwd: string, filePath: string, opts: ResolvePathOpts = {}): string {
  if (filePath.startsWith("~")) {
    filePath = path.join(os.homedir(), filePath.slice(1));
  }
  if ((opts.platform ?? process.platform) === "win32" && /^\/tmp(?:\/|$)/.test(filePath)) {
    const temp = getMsysTempDir(opts);
    if (!temp) {
      throw new Error(
        "Cannot resolve Git Bash /tmp. Use the native Windows path reported by `cygpath -aw /tmp`.",
      );
    }
    return path.win32.resolve(temp, `.${filePath.slice(4)}`);
  }
  return path.resolve(cwd, msysToWindowsPath(filePath, opts));
}

/**
 * Check if a path is a symlink. Used by file tools to prevent symlink-based
 * attacks that could read/write sensitive files outside the working directory.
 */
export async function rejectSymlink(resolved: string): Promise<void> {
  try {
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to follow symlink: ${resolved}`);
    }
  } catch (err) {
    // Re-throw our own error; swallow ENOENT (file doesn't exist yet, e.g. write/new file)
    if (err instanceof Error && err.message.startsWith("Refusing to follow")) throw err;
  }
}
