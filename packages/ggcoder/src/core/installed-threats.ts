/**
 * Already-installed packages: check a project's existing lockfiles against the
 * malware data (local daily feed + one batched OSV lookup per lockfile), so a
 * package flagged AFTER it was installed is still found. Runs in the
 * background (session start, after each daily feed update, after a run that
 * changed a lockfile); never on a command's critical path, never a prompt.
 *
 * Cost: one `stat` per known lockfile name; a lockfile is only read when it
 * exists, and its verdict is cached by content hash and re-asked of OSV at most
 * once a day (core/package-threats.ts).
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { BlockedPackage } from "./shell-threats.js";
import {
  checkLockfileMalware,
  PROJECT_LOCKFILES,
  type PackageCheckOptions,
} from "./package-threats.js";

export interface InstalledThreat {
  /** Stable id: lockfile path + flagged items (a fix or new hit is a new key). */
  key: string;
  /** Absolute lockfile path. */
  file: string;
  /** Flagged `name@version (IDs)` items. */
  packages: string[];
  /** The same, structured, for the project's "don't install" list. */
  blocked: BlockedPackage[];
  /** One plain line for the user. */
  message: string;
  /** What the agent is told to do. */
  agentText: string;
}

/** Lockfile path → mtime, for "did a run change a lockfile?" checks. */
export type LockfileStamp = Map<string, number>;

/** Which known lockfiles exist in `dir`, with their mtimes. Missing ones are skipped. */
export async function stampProjectLockfiles(dir: string): Promise<LockfileStamp> {
  const stamp: LockfileStamp = new Map();
  await Promise.all(
    PROJECT_LOCKFILES.map(async (lock) => {
      const file = path.join(dir, lock.file);
      try {
        const st = await fsp.stat(file);
        if (st.isFile()) stamp.set(file, st.mtimeMs);
      } catch {
        // Not there: nothing to check.
      }
    }),
  );
  return stamp;
}

export function sameStamp(a: LockfileStamp, b: LockfileStamp): boolean {
  if (a.size !== b.size) return false;
  for (const [file, mtime] of a) if (b.get(file) !== mtime) return false;
  return true;
}

function describe(
  file: string,
  dir: string,
  packages: string[],
  blocked: BlockedPackage[],
): InstalledThreat {
  const rel = path.relative(dir, file) || path.basename(file);
  const list =
    packages.slice(0, 5).join(", ") +
    (packages.length > 5 ? ` and ${packages.length - 5} more` : "");
  return {
    key: `${file}\0${[...packages].sort().join("\0")}`,
    file,
    packages,
    blocked,
    message:
      `This project uses a package now known to be infected: ${list} (in ${rel}). ` +
      `The agent has been told to replace it.`,
    agentText:
      `Security notice: ${rel} in this project pins a package that is now known to be malware: ${list}. ` +
      `Before running any of the project's code, replace it: update the dependency to a clean version ` +
      `(the release before the flagged one, or a newer fixed one), regenerate the lockfile and reinstall. ` +
      `Then tell the user in one plain sentence what you changed. Do not run the flagged version.`,
  };
}

/** Check every known lockfile in `dir`. Clean or nothing to check → []. */
export async function scanProjectLockfiles(
  dir: string,
  options: PackageCheckOptions = {},
): Promise<InstalledThreat[]> {
  const stamp = await stampProjectLockfiles(dir);
  if (stamp.size === 0) return [];
  const found = await Promise.all(
    PROJECT_LOCKFILES.filter((lock) => stamp.has(path.join(dir, lock.file))).map(async (lock) => {
      const threats = await checkLockfileMalware(lock, dir, options);
      const packages = threats.flatMap((t) => t.packages ?? []);
      const blocked = threats.flatMap((t) => t.blocked ?? []);
      return packages.length > 0
        ? describe(path.join(dir, lock.file), dir, packages, blocked)
        : null;
    }),
  );
  return found.filter((t): t is InstalledThreat => t !== null);
}
