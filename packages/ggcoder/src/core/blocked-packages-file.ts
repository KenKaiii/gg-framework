/**
 * The project's "don't install" list: when a guard refuses a package, the app
 * (not the agent) records it in the instruction file Kleio Coder loads for the
 * project, so every later session knows about it from its first token.
 *
 * One small managed block between markers, appended to the file Kleio Coder
 * reads (the first of INSTRUCTION_FILES that exists; CLAUDE.md is created when
 * none does, as /init does). Deduplicated, capped, and nothing but validated package names,
 * versions and our own reason text ever goes in, so the block can't carry
 * injected instructions. Never touched mid-prompt: the running session already
 * knows from the block message, and nothing re-renders the cached prompt.
 */
import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BlockedPackage } from "./shell-threats.js";
import { retryWindowsReplace } from "./session-storage.js";

export const BLOCKLIST_START = "<!-- gg-safe:blocked-packages:start -->";
export const BLOCKLIST_END = "<!-- gg-safe:blocked-packages:end -->";
const HEADER = [
  "## Blocked packages",
  "Kleio Coder's safety checks blocked these. Never install or run them; use another version or package.",
];
/** Newest entries kept; older ones fall off the top. */
const MAX_ENTRIES = 30;
/** Bigger instruction files are left alone (not ours to rewrite). */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/**
 * Same names and order as the system prompt's CONTEXT_FILES (a test keeps
 * them equal): Kleio Coder loads only the first that exists per folder, so the
 * list must go into that one. Creating a CLAUDE.md beside a .cursorrules
 * would outrank it and silently drop the user's own rules.
 */
export const INSTRUCTION_FILES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  "CONVENTIONS.md",
] as const;

const NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const VERSION = /^[a-z0-9][a-z0-9.+_-]{0,63}$/i;
const REASON = /^[\w "(),.:@/-]{1,120}$/;

/** The instruction file Kleio Coder reads in `dir` (CLAUDE.md when there is none yet, as /init). */
export async function instructionFileFor(dir: string): Promise<string> {
  for (const name of INSTRUCTION_FILES) {
    const file = path.join(dir, name);
    try {
      if ((await fsp.stat(file)).isFile()) return file;
    } catch {
      // Not there: try the next name.
    }
  }
  return path.join(dir, "CLAUDE.md");
}

/** One list line, or null when anything fails validation. */
export function blocklistLine(pkg: BlockedPackage): string | null {
  if (pkg.ecosystem !== "npm" && pkg.ecosystem !== "PyPI") return null;
  if (!NAME.test(pkg.name) || (pkg.version !== undefined && !VERSION.test(pkg.version))) {
    return null;
  }
  if (!REASON.test(pkg.reason)) return null;
  const id = pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;
  return `- ${pkg.ecosystem} \`${id}\`: ${pkg.reason}`;
}

/** `- npm \`chalk@5.6.1\`: …` → `npm chalk@5.6.1`, the dedupe key. */
function lineKey(line: string): string {
  return /^- (\S+) `([^`]+)`/.exec(line)?.slice(1, 3).join(" ").toLowerCase() ?? line;
}

/**
 * The managed block's span in `text`: the first end marker that has a start
 * marker before it, paired with the nearest such start. A stray start or end
 * marker (hand-edited, half-deleted) never makes us swallow the user's text
 * between it and a real block.
 */
function blockSpan(text: string): { start: number; end: number } | null {
  let end = text.indexOf(BLOCKLIST_END);
  while (end !== -1) {
    const start = text.lastIndexOf(BLOCKLIST_START, end);
    if (start !== -1) return { start, end };
    end = text.indexOf(BLOCKLIST_END, end + BLOCKLIST_END.length);
  }
  return null;
}

/** Lines inside the block that aren't ours (a user's own note): kept as-is. */
function blockExtras(text: string): string[] {
  const span = blockSpan(text);
  if (!span) return [];
  return text
    .slice(span.start + BLOCKLIST_START.length, span.end)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.startsWith("- ") && !HEADER.includes(line));
}

/** The text with the managed block set to `entries` (added at the end if missing). */
export function withBlocklist(text: string, entries: string[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = [BLOCKLIST_START, ...HEADER, ...blockExtras(text), ...entries, BLOCKLIST_END].join(
    eol,
  );
  const span = blockSpan(text);
  if (span) {
    return text.slice(0, span.start) + block + text.slice(span.end + BLOCKLIST_END.length);
  }
  const body = text.replace(/[ \t\r\n]+$/, "");
  return body ? `${body}${eol}${eol}${block}${eol}` : `${block}${eol}`;
}

/** Entries currently in the managed block of `text`. */
export function readBlocklist(text: string): string[] {
  const span = blockSpan(text);
  if (!span) return [];
  return text
    .slice(span.start + BLOCKLIST_START.length, span.end)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("- "));
}

/** Files and folders that make `dir` a real project (a worktree's `.git` is a file). */
const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "Cargo.toml",
  "go.mod",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "uv.lock",
  ...INSTRUCTION_FILES,
];

/**
 * Only write inside a real project: never the home folder or a filesystem
 * root (a ~/CLAUDE.md would apply to every project), and never a loose folder
 * such as Downloads or a temp dir with no project marker in it.
 */
export async function isProjectDir(dir: string, home: string = os.homedir()): Promise<boolean> {
  const resolved = path.resolve(dir);
  if (path.parse(resolved).root === resolved) return false;
  const norm = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
  if (home && norm(path.resolve(home)) === norm(resolved)) return false;
  const hits = await Promise.all(
    PROJECT_MARKERS.map((name) =>
      fsp.lstat(path.join(resolved, name)).then(
        () => true,
        () => false,
      ),
    ),
  );
  return hits.includes(true);
}

/** Lockfiles older than this are from a crashed writer and may be taken over. */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

/**
 * A cross-process lock beside the file (two GG windows on one project are two
 * sidecars only when they're separate apps; still, never lose an entry or the
 * user's text). Returns the release function, or throws after LOCK_WAIT_MS.
 */
async function lockFile(file: string): Promise<() => Promise<void>> {
  const lock = `${file}.gg-lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await fsp.open(lock, "wx");
      await handle.close();
      return () => fsp.rm(lock, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const st = await fsp.stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await fsp.rm(lock, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() > deadline)
        throw new Error(`${lock} is held by another writer`, { cause: err });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** Read, merge, write atomically; "changed" when the file moved under us. */
async function writeOnce(file: string, lines: string[]): Promise<string | null | "changed"> {
  const before = await fsp.stat(file).catch(() => null);
  const text = before ? await fsp.readFile(file, "utf8") : "";
  const entries = readBlocklist(text);
  const known = new Set(entries.map(lineKey));
  const added = lines.filter((line) => {
    const key = lineKey(line);
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  if (added.length === 0) return null;
  const next = withBlocklist(text, [...entries, ...added].slice(-MAX_ENTRIES));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, next, {
      encoding: "utf8",
      mode: before ? before.mode & 0o777 : 0o644,
    });
    const now = await fsp.stat(file).catch(() => null);
    if (now?.mtimeMs !== before?.mtimeMs || now?.size !== before?.size) {
      await fsp.rm(tmp, { force: true });
      return "changed";
    }
    await retryWindowsReplace(() => fsp.rename(tmp, file));
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return file;
}

/** One write at a time per file, so concurrent blocks never lose an entry. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Add `packages` to the project's list in `dir`. Returns the file written, or
 * null when nothing new needed recording (or `dir` isn't a project, or the
 * file is read-only/someone else's: their choice wins). Rejects on I/O
 * failure; callers fire and forget and log it.
 */
export async function recordBlockedPackages(
  dir: string,
  packages: readonly BlockedPackage[],
  options: { home?: string } = {},
): Promise<string | null> {
  const lines = packages.map(blocklistLine).filter((l): l is string => l !== null);
  if (lines.length === 0) return null;
  if (!(await isProjectDir(dir, options.home))) return null;
  let file = await instructionFileFor(dir);
  // A symlinked CLAUDE.md -> AGENTS.md: write through to the real file, never
  // replace the link with a regular file.
  const link = await fsp.lstat(file).catch(() => null);
  if (link?.isSymbolicLink()) file = await fsp.realpath(file).catch(() => file);
  const run = async (): Promise<string | null> => {
    const first = await fsp.stat(file).catch(() => null);
    if (first) {
      if (!first.isFile() || first.size > MAX_FILE_BYTES) return null;
      // Read-only or owned by someone else: leave it alone (a rename would
      // silently replace it).
      const writable = await fsp.access(file, fsConstants.W_OK).then(
        () => true,
        () => false,
      );
      if (!writable) return null;
    }
    const release = await lockFile(file);
    try {
      // An editor saving mid-write: re-read and try again, never clobber it.
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await writeOnce(file, lines);
        if (result !== "changed") return result;
      }
      return null;
    } finally {
      await release().catch(() => {});
    }
  };
  const prev = queues.get(file) ?? Promise.resolve();
  const next = prev.then(run, run);
  const settled = next.catch(() => null);
  queues.set(file, settled);
  // Drop the entry once idle, so the map doesn't grow with every project.
  void settled.then(() => {
    if (queues.get(file) === settled) queues.delete(file);
  });
  return next;
}
