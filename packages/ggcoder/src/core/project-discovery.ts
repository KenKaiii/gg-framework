import fs from "node:fs/promises";
import { createReadStream, realpathSync } from "node:fs";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { getAppPaths } from "../config.js";
import { encodeCwd, stripExtendedLengthPrefix } from "./encode-cwd.js";
import { getUserSessionPrompt } from "./session-preview.js";
import { isSessionPath, openSessionReadStream, resolveSessionPath } from "./session-storage.js";
import { parseForeignTranscript } from "./foreign-session-import.js";

export type ProjectSource = "ggcoder" | "claude-code" | "codex" | "folder";

export interface DiscoverProjectsOptions {
  /** The user's configured projects folder; always scanned when set. */
  projectsRoot?: string;
  /**
   * Extra folders the user has explicitly added as project roots. Scanned like
   * `projectsRoot`; an explicit list beats inference, which stays as the
   * zero-config default for people who never open Settings.
   */
  extraRoots?: readonly string[];
  /** Project paths the user dismissed from the picker. */
  hiddenPaths?: readonly string[];
  /**
   * Folders whose contents are never projects (Goal workspaces under
   * `~/.gg/goals`). Anything at or below one of these is dropped.
   */
  excludeRoots?: readonly string[];
}

export interface DiscoveredProject {
  name: string;
  path: string;
  lastActiveMs: number;
  lastActiveDisplay: string;
  /** Sorted, deduped list of stores this project showed up in. */
  sources: ProjectSource[];
}

/**
 * Scan ggcoder + Claude Code + Codex session stores AND the user's project
 * folders, returning one row per project sorted most-recent first. Duplicates
 * (same cwd) are collapsed; the `sources` field lists every store the project
 * appeared in so the picker can show a combined badge.
 *
 * Session stores alone only ever surface projects you have *already opened with
 * an agent*, so a folder full of real projects stayed invisible until each one
 * had been opened by some other route. The filesystem pass fixes that: it lists
 * the direct children of every known project root, tagged `folder`.
 */
export async function discoverProjects(
  options: DiscoverProjectsOptions = {},
): Promise<DiscoveredProject[]> {
  const [gg, cc, cx] = await Promise.all([
    discoverGgcoderProjects(),
    discoverClaudeProjects(),
    discoverCodexProjects(),
  ]);

  const fromSessions = [...gg, ...cc, ...cx];
  const folders = await discoverFolderProjects(
    resolveProjectRoots(options.projectsRoot, options.extraRoots, fromSessions),
  );

  const byPath = new Map<string, DiscoveredProject>();
  for (const p of [...fromSessions, ...folders]) {
    const existing = byPath.get(p.path);
    if (!existing) {
      byPath.set(p.path, p);
      continue;
    }
    // A folder's mtime is not activity: a checkout or a build touching the
    // directory must not reorder a project above one you actually worked in.
    // Session recency wins whenever any session store knows this project.
    const merged = mergeSources(existing.sources, p.sources);
    const sessionOnly = [existing, p].filter((row) => !isFolderOnly(row.sources));
    byPath.set(p.path, {
      name: existing.name,
      path: existing.path,
      lastActiveMs: Math.max(
        ...(sessionOnly.length > 0 ? sessionOnly : [existing, p]).map((r) => r.lastActiveMs),
      ),
      lastActiveDisplay: "", // recomputed below
      sources: merged,
    });
  }

  // Hiding is by resolved path so a row dismissed once stays gone regardless of
  // which store re-surfaces it later.
  const hidden = new Set((options.hiddenPaths ?? []).map((p) => path.resolve(p)));
  const excluded = (options.excludeRoots ?? []).map((root) => path.resolve(root));
  const isExcluded = (target: string): boolean =>
    excluded.some((root) => {
      const relative = path.relative(root, path.resolve(target));
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
  const merged = Array.from(byPath.values())
    .filter((p) => !hidden.has(p.path) && !isExcluded(p.path))
    .map((p) => ({
      ...p,
      lastActiveDisplay: formatRelativeTime(p.lastActiveMs),
    }));
  merged.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  return merged;
}

const SOURCE_ORDER: Record<ProjectSource, number> = {
  ggcoder: 0,
  "claude-code": 1,
  codex: 2,
  folder: 3,
};

function isFolderOnly(sources: ProjectSource[]): boolean {
  return sources.length === 1 && sources[0] === "folder";
}

function mergeSources(a: ProjectSource[], b: ProjectSource[]): ProjectSource[] {
  const set = new Set<ProjectSource>([...a, ...b]);
  return Array.from(set).sort((x, y) => SOURCE_ORDER[x] - SOURCE_ORDER[y]);
}

/**
 * Scan ~/.gg/sessions/. Each session directory's name is the encoded cwd
 * (slashes → underscores), but that encoding is lossy: any real path segment
 * containing a literal underscore round-trips wrong (e.g. `my_app` decodes to
 * `.../my/app`, which doesn't exist, so the project silently vanished from the
 * picker). So — like Claude Code discovery — we read the real cwd out of the
 * session header (`{"type":"session",...,"cwd":"/abs"}`) and only fall back to
 * decoding the directory name when no header carries a cwd.
 */
async function discoverGgcoderProjects(): Promise<DiscoveredProject[]> {
  const sessionsDir = getAppPaths().sessionsDir;
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }

  // Per-entry work is independent I/O (readdir + stat + a header read), so it
  // runs concurrently; sequentially this dominated picker load time once a user
  // had dozens of session stores.
  const results = await mapConcurrent(entries, async (entry): Promise<DiscoveredProject | null> => {
    const dir = path.join(sessionsDir, entry);
    const mtime = await lastUsedGgcoderSessionMtime(dir);
    if (mtime === null) return null;

    const rawCwd =
      (await readFirstFromGgcoderDir(dir, ggcoderCwdExtractor)) ?? fallbackUnderscoreDecode(entry);
    if (!rawCwd) return null;
    // Normalize traversal segments (e.g. an agent launched with cwd
    // `.../src-tauri/../..`) so the basename isn't a stray "..", and drop any
    // Windows extended-length prefix so a session recorded as `\\?\C:\proj`
    // (what Rust's canonicalize used to hand the sidecar) resolves to the same
    // project as a plain `C:\proj` instead of listing a prefixed duplicate.
    const cwd = path.resolve(stripExtendedLengthPrefix(rawCwd));
    if (!(await isDirectory(cwd))) return null;

    return {
      name: path.basename(cwd),
      path: cwd,
      lastActiveMs: mtime,
      lastActiveDisplay: formatRelativeTime(mtime),
      sources: ["ggcoder"],
    };
  });
  return results.filter((p): p is DiscoveredProject => p !== null);
}

/**
 * Bounded-concurrency `Promise.all`. Discovery fans out over hundreds of
 * session files; an unbounded `Promise.all` exhausts the file-descriptor limit
 * on a large store, while running sequentially is needlessly slow.
 */
const IO_CONCURRENCY = 32;

async function mapConcurrent<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(IO_CONCURRENCY, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Is `value` an absolute path on ANY platform?
 *
 * `path.isAbsolute` is platform-bound, but a session store is portable: read on
 * Windows it carries `C:\Users\…` / `\\server\share\…`, on POSIX `/Users/…`.
 * The old POSIX-only `startsWith("/")` check silently rejected every Windows
 * cwd header, so discovery fell back to the lossy directory-name decode and
 * every project/session vanished from the picker on Windows.
 */
export function isAbsoluteCwd(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

/**
 * Best-effort decode of a ggcoder session directory name back to a cwd, used
 * only when the session files carry no `cwd` header. Lossy by design (literal
 * underscores are indistinguishable from separators); the caller still verifies
 * the result is an existing directory.
 *
 * `encodeCwd` drops the drive colon (`C:\a\b` → `C_a_b`), so on Windows we
 * re-attach it for a leading single-letter segment; otherwise a decoded
 * `/C/a/b` names a directory that never exists and the project disappears.
 */
function fallbackUnderscoreDecode(entry: string): string {
  if (process.platform === "win32") {
    const parts = entry.split("_");
    if (parts.length > 1 && /^[A-Za-z]$/.test(parts[0]!)) {
      return `${parts[0]}:\\${parts.slice(1).join("\\")}`;
    }
    return entry.replace(/_/g, "\\");
  }
  return "/" + entry.replace(/_/g, "/");
}

/**
 * Scan ~/.claude/projects/. Claude Code's directory encoding replaces every
 * "/" with "-", which is genuinely ambiguous — a real dash in a path component
 * (e.g. "gg-coder") collides with the separator. So we extract the cwd from
 * the JSONL events themselves; Claude writes it into user/assistant records.
 * Falls back to a best-effort dash decode only if no event carries a cwd.
 */
async function discoverClaudeProjects(): Promise<DiscoveredProject[]> {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  let entries: string[];
  try {
    entries = await fs.readdir(projectsDir);
  } catch {
    return [];
  }

  const results = await mapConcurrent(entries, async (entry): Promise<DiscoveredProject | null> => {
    const dir = path.join(projectsDir, entry);
    const mtime = await maxJsonlMtime(dir);
    if (mtime === null) return null;

    const cwd = (await readFirstFromJsonlDir(dir, claudeCwdExtractor)) ?? fallbackDashDecode(entry);
    if (!cwd) return null;
    if (!(await isDirectory(cwd))) return null;

    return {
      name: path.basename(cwd),
      path: cwd,
      lastActiveMs: mtime,
      lastActiveDisplay: formatRelativeTime(mtime),
      sources: ["claude-code"],
    };
  });
  return results.filter((p): p is DiscoveredProject => p !== null);
}

/**
 * Scan ~/.codex/sessions/. Codex stores sessions flat by date
 * (`YYYY/MM/DD/rollout-*.jsonl`) with the cwd embedded in the first user
 * message as `<environment_context><cwd>/abs/path</cwd>...</environment_context>`.
 * We group sessions by extracted cwd and take max mtime per group.
 */
async function discoverCodexProjects(): Promise<DiscoveredProject[]> {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
  if (!(await isDirectory(sessionsDir))) return [];

  // Layout is YYYY/MM/DD/*.jsonl — depth 4 covers it.
  const files = await collectJsonlFiles(sessionsDir, 4);
  if (files.length === 0) return [];

  // Process newest first so per-cwd we always start with the latest mtime.
  files.sort((a, b) => b.mtime - a.mtime);

  const cwds = await mapConcurrent(files, (f) => readFirstFromFile(f.path, codexCwdExtractor));

  const byCwd = new Map<string, number>();
  files.forEach((f, i) => {
    const cwd = cwds[i];
    if (!cwd) return;
    const prev = byCwd.get(cwd);
    if (prev === undefined || f.mtime > prev) byCwd.set(cwd, f.mtime);
  });

  const results = await mapConcurrent(
    Array.from(byCwd),
    async ([cwd, mtime]): Promise<DiscoveredProject | null> => {
      if (!(await isDirectory(cwd))) return null;
      return {
        name: path.basename(cwd),
        path: cwd,
        lastActiveMs: mtime,
        lastActiveDisplay: formatRelativeTime(mtime),
        sources: ["codex"],
      };
    },
  );
  return results.filter((p): p is DiscoveredProject => p !== null);
}

/**
 * How many already-known projects must share a parent directory before that
 * parent is treated as a project root in its own right. Users keep more than
 * one "projects folder" (the configured root plus wherever the rest actually
 * live), but only one is configurable — so a directory that has repeatedly
 * acted like a root is inferred from evidence rather than guessed.
 */
const INFERRED_ROOT_MIN_PROJECTS = 3;

/** Directory names that are never a project of their own. */
const FOLDER_SCAN_IGNORED = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  "tmp",
  "temp",
  "Library",
  "Applications",
  // GG Motion's video workspace lives in the projects root but is not a codebase.
  "GG Motion",
]);

/**
 * Which directories should be scanned for project folders: the configured root,
 * plus any parent that already holds several known projects.
 *
 * Scanning the home directory, a filesystem/temp root or a hidden tool folder
 * would list mail, music, scratch dirs and tool state as "projects", so those
 * are never inferred as roots no matter how many sessions point inside them.
 * Roots the user configured are always scanned.
 */
function resolveProjectRoots(
  projectsRoot: string | undefined,
  extraRoots: readonly string[] | undefined,
  discovered: DiscoveredProject[],
): string[] {
  const roots = new Set<string>();
  const configured = projectsRoot?.trim();
  if (configured) roots.add(path.resolve(configured));
  for (const extra of extraRoots ?? []) {
    const trimmed = extra.trim();
    if (trimmed) roots.add(path.resolve(trimmed));
  }

  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const project of discovered) {
    if (seen.has(project.path)) continue;
    seen.add(project.path);
    const parent = path.dirname(project.path);
    if (parent === project.path) continue;
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  for (const [parent, count] of counts) {
    if (count >= INFERRED_ROOT_MIN_PROJECTS && !isUnscannableRoot(parent)) roots.add(parent);
  }

  return Array.from(roots);
}

function isUnscannableRoot(dir: string): boolean {
  // Hidden folders hold tool state, not projects: GG Coder's own `.gg` keeps
  // uploads, plans and throwaway PR worktrees. Sessions in a few of those
  // worktrees must not list every folder beside them as a project.
  if (isInsideHiddenFolder(dir)) return true;
  const resolved = resolveExistingPath(dir);
  if (resolved === resolveExistingPath(path.parse(resolved).root)) return true;
  if (resolved === resolveExistingPath(os.homedir())) return true;
  // Scratch checkouts and test fixtures cluster as direct children of the temp
  // dir, which would otherwise infer it as a root and list every stale
  // `tmp.XXXX` as a project. Resolve symlinks before comparing because macOS
  // reports the same temp directory through both `/var` and `/private/var`.
  // Only the temp dir itself is barred — a real projects folder below it is
  // still scannable.
  return resolved === resolveExistingPath(os.tmpdir());
}

/**
 * Is `dir` a dot-folder or inside one (`.gg`, `.cache/checkouts`)? Checks the
 * path as discovered rather than symlink-resolved, so it matches what the
 * picker shows. Splits on both separators because Claude Code and Codex cwds
 * are raw transcript strings.
 */
function isInsideHiddenFolder(dir: string): boolean {
  return path
    .resolve(dir)
    .split(/[\\/]/)
    .some((segment) => segment.startsWith("."));
}

function resolveExistingPath(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * List the direct children of each project root as projects. Directory mtime
 * stands in for "last active" — imprecise, but these rows are session-less by
 * definition and merging keeps real session recency where it exists.
 */
async function discoverFolderProjects(roots: string[]): Promise<DiscoveredProject[]> {
  const candidates: { name: string; path: string }[] = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      if (FOLDER_SCAN_IGNORED.has(entry.name)) continue;
      candidates.push({ name: entry.name, path: path.join(root, entry.name) });
    }
  }

  // `stat` (not `lstat`) so a symlinked project folder resolves to its target:
  // `readdir` reports a symlink as neither file nor directory, so checking the
  // dirent alone would silently drop linked-in projects.
  const rows = await mapConcurrent(candidates, async (c): Promise<DiscoveredProject | null> => {
    try {
      const stats = await fs.stat(c.path);
      if (!stats.isDirectory()) return null;
      return {
        name: c.name,
        path: c.path,
        lastActiveMs: stats.mtimeMs,
        lastActiveDisplay: formatRelativeTime(stats.mtimeMs),
        sources: ["folder"],
      };
    } catch {
      return null;
    }
  });
  return rows.filter((r): r is DiscoveredProject => r !== null);
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function maxJsonlMtime(dir: string): Promise<number | null> {
  if (!(await isDirectory(dir))) return null;
  const files = await collectJsonlFiles(dir, 2);
  if (files.length === 0) return null;
  let max = 0;
  for (const f of files) if (f.mtime > max) max = f.mtime;
  return max > 0 ? max : null;
}

/**
 * Last activity in a ggcoder session store, counting only sessions that
 * recorded a message. A session writes its header as soon as it starts, so a
 * header-only file means the project was opened, not worked in; the same rule
 * `listRecentSessions` applies. Compaction checkpoints re-save their messages,
 * so compacted conversations still count.
 */
async function lastUsedGgcoderSessionMtime(dir: string): Promise<number | null> {
  if (!(await isDirectory(dir))) return null;
  const files = await collectGgcoderSessionFiles(dir, 2);
  // Newest first: the first used file is also the latest real activity.
  files.sort((a, b) => b.mtime - a.mtime);
  for (const file of files) {
    if (await readFirstFromGgcoderFile(file.path, ggcoderMessageExtractor)) return file.mtime;
  }
  return null;
}

/**
 * Walk `dir` up to `maxDepth` levels deep collecting every .jsonl file. Used
 * for both Claude Code (top-level + `<uuid>/subagents/`) and Codex
 * (`YYYY/MM/DD/`) layouts.
 */
async function collectJsonlFiles(
  dir: string,
  maxDepth: number,
): Promise<{ path: string; mtime: number }[]> {
  const out: { path: string; mtime: number }[] = [];
  await walk(dir, 0);
  return out;

  async function walk(current: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          const s = await fs.stat(full);
          out.push({ path: full, mtime: s.mtimeMs });
        } catch {
          // skip unreadable
        }
      } else if (e.isDirectory() && depth < maxDepth) {
        await walk(full, depth + 1);
      }
    }
  }
}

async function collectGgcoderSessionFiles(
  dir: string,
  maxDepth: number,
): Promise<{ path: string; mtime: number }[]> {
  const byResolvedPath = new Map<string, { path: string; mtime: number }>();
  await walk(dir, 0);
  return [...byResolvedPath.values()];

  async function walk(current: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && isSessionPath(entry.name)) {
        try {
          const resolvedPath = await resolveSessionPath(fullPath);
          const stat = await fs.stat(resolvedPath);
          byResolvedPath.set(resolvedPath, { path: resolvedPath, mtime: stat.mtimeMs });
        } catch {
          // Ignore malformed redirects, incomplete archives, and raced files.
        }
      } else if (entry.isDirectory() && depth < maxDepth && !entry.name.endsWith(".assets")) {
        await walk(fullPath, depth + 1);
      }
    }
  }
}

type LineExtractor = (line: string) => string | null;

const claudeCwdExtractor: LineExtractor = (line) => {
  try {
    const parsed = JSON.parse(line) as { cwd?: unknown };
    if (typeof parsed.cwd === "string" && isAbsoluteCwd(parsed.cwd)) return parsed.cwd;
  } catch {
    // skip malformed
  }
  return null;
};

// ggcoder session files open with a `{"type":"session",...,"cwd":"/abs"}` header
// that stores the real cwd verbatim. Prefer it over decoding the directory name,
// whose slash→underscore encoding is lossy for paths containing literal
// underscores (e.g. `my_app` would wrongly decode to `.../my/app`).
const ggcoderCwdExtractor: LineExtractor = (line) => {
  try {
    const parsed = JSON.parse(line) as { type?: unknown; cwd?: unknown };
    if (parsed.type === "session" && typeof parsed.cwd === "string" && isAbsoluteCwd(parsed.cwd)) {
      return parsed.cwd;
    }
  } catch {
    // skip malformed
  }
  return null;
};

// Hits on the first message entry; a session counts as used once it has one.
const ggcoderMessageExtractor: LineExtractor = (line) => {
  try {
    const parsed = JSON.parse(line) as { type?: unknown };
    if (parsed.type === "message") return "message";
  } catch {
    // skip malformed
  }
  return null;
};

const CODEX_CWD_RE = /<cwd>([^<]+)<\/cwd>/;
const codexCwdExtractor: LineExtractor = (line) => {
  // Current format (openai/codex protocol.rs, late-2025+): RolloutLine wraps
  // SessionMeta / TurnContext items with `{ type, payload: { cwd, ... } }`.
  // First line is always SessionMeta, so this hits on read 1.
  try {
    const parsed = JSON.parse(line) as { payload?: { cwd?: unknown } };
    const cwd = parsed.payload?.cwd;
    if (typeof cwd === "string" && isAbsoluteCwd(cwd)) return cwd;
  } catch {
    // not JSON or unexpected shape; fall through to legacy regex
  }
  // Legacy format (pre-late-2025): cwd embedded as <cwd>...</cwd> inside an
  // <environment_context> user-message string.
  const m = CODEX_CWD_RE.exec(line);
  if (m && m[1] && isAbsoluteCwd(m[1])) return m[1];
  return null;
};

/**
 * Walk all plain Claude/Codex JSONL files under `dir` newest-first, returning
 * the first non-null extractor result.
 */
async function readFirstFromJsonlDir(
  dir: string,
  extractor: LineExtractor,
): Promise<string | null> {
  const files = await collectJsonlFiles(dir, 2);
  if (files.length === 0) return null;
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files) {
    const v = await readFirstFromFile(f.path, extractor);
    if (v) return v;
  }
  return null;
}

async function readFirstFromGgcoderDir(
  dir: string,
  extractor: LineExtractor,
): Promise<string | null> {
  const files = await collectGgcoderSessionFiles(dir, 2);
  files.sort((a, b) => b.mtime - a.mtime);
  for (const file of files) {
    const value = await readFirstFromGgcoderFile(file.path, extractor);
    if (value) return value;
  }
  return null;
}

/**
 * Stream one ggcoder session file, plain or archived, and return the first
 * non-null extractor result. Line-capped like {@link readFirstFromFile}.
 */
async function readFirstFromGgcoderFile(
  file: string,
  extractor: LineExtractor,
): Promise<string | null> {
  try {
    const { stream, close } = await openSessionReadStream(file);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      let lines = 0;
      for await (const line of rl) {
        if (++lines > 200) break;
        const value = extractor(line);
        if (value) return value;
      }
    } finally {
      // Always via close(): destroying the gunzip alone strands the source fd.
      rl.close();
      close();
    }
  } catch {
    // A corrupt archive must not hide otherwise valid projects in this store.
  }
  return null;
}

/**
 * Stream `file` line-by-line and return the first non-null extractor result.
 * Caps lines so a giant transcript can't stall discovery.
 */
async function readFirstFromFile(file: string, extractor: LineExtractor): Promise<string | null> {
  return new Promise((resolve) => {
    const stream = createReadStream(file, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lines = 0;
    let done = false;
    const MAX_LINES = 200;
    // Resolve before tearing down. rl.close() synchronously emits 'close',
    // and if the close handler resolves first our real value gets swallowed.
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      resolve(value);
      rl.close();
      stream.destroy();
    };
    rl.on("line", (line) => {
      if (done) return;
      lines++;
      if (lines > MAX_LINES) {
        finish(null);
        return;
      }
      const v = extractor(line);
      if (v) finish(v);
    });
    rl.on("close", () => finish(null));
    rl.on("error", () => finish(null));
    stream.on("error", () => finish(null));
  });
}

function fallbackDashDecode(entry: string): string | null {
  // Strip leading "-" then turn remaining "-" into "/". Lossy by design — only
  // used when the JSONLs have no cwd events; the caller still verifies the
  // result is an existing directory.
  if (!entry.startsWith("-")) return null;
  const body = entry.slice(1);
  if (process.platform === "win32") {
    // Claude Code on Windows encodes `C:\a\b` as `C--a-b` (drive colon → dash).
    const drive = /^([A-Za-z])--(.*)$/.exec(body);
    if (drive) return `${drive[1]}:\\${drive[2]!.replace(/-/g, "\\")}`;
    return body.replace(/-/g, "\\");
  }
  return "/" + body.replace(/-/g, "/");
}

/** Short "5m ago" style label for a millisecond timestamp; "—" for 0. */
export function formatRelativeTime(ms: number): string {
  if (ms === 0) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < week) return `${Math.floor(diff / day)}d ago`;
  if (diff < month) return `${Math.floor(diff / week)}w ago`;
  return `${Math.floor(diff / month)}mo ago`;
}

// ── Recent sessions (ggcoder) ──────────────────────────────

export interface RecentSession {
  /** Session id. */
  id: string;
  /** Absolute resumable path to a plain or gzip GG Coder session. */
  path: string;
  /** Legacy saved label, falling back to the first real user prompt. */
  preview: string;
  /** Relative "3h ago" string from last activity. */
  lastActiveDisplay: string;
  messageCount: number;
  /**
   * Which store this row came from. Absent means `ggcoder` — a session that is
   * already resumable as-is. A foreign value means `path` points at that tool's
   * own transcript, which the host imports before opening.
   */
  source?: ProjectSource;
}

/**
 * List the most recent ggcoder conversations for a project cwd. Compaction
 * checkpoints share a conversation id, so only the newest resumable checkpoint
 * is shown. Legacy labels win; otherwise the first real user prompt is used.
 */
export async function listRecentSessions(
  cwd: string,
  limit = 5,
  sessionsDir = getAppPaths().sessionsDir,
  /** More folders whose conversations belong to this project (its worktrees). */
  extraCwds: readonly string[] = [],
): Promise<RecentSession[]> {
  const dirs = [cwd, ...extraCwds].map((dir) => path.join(sessionsDir, encodeCwd(dir)));
  const files = (await Promise.all(dirs.map((dir) => collectGgcoderSessionFiles(dir, 1)))).flat();
  if (files.length === 0) return [];
  files.sort((a, b) => b.mtime - a.mtime);

  const out: RecentSession[] = [];
  const seenConversationIds = new Set<string>();
  for (const f of files) {
    if (out.length >= limit) break;
    const parsed = await readSessionSummary(f.path);
    if (!parsed || parsed.messageCount === 0) continue;
    if (seenConversationIds.has(parsed.conversationId)) continue;
    seenConversationIds.add(parsed.conversationId);
    const { conversationId: _conversationId, ...session } = parsed;
    out.push(session);
  }
  return out;
}

/**
 * List the most recent Claude Code and Codex conversations for a project cwd.
 *
 * The project picker has always surfaced these stores (`discoverProjects`), so a
 * project can appear *because* it has Claude Code history — and then show an
 * empty session list, because that only read GG Coder's own directory. These
 * rows close that gap: each one points at the foreign transcript, tagged with
 * its `source`, and the host imports it on click.
 *
 * Cheap by construction: a transcript is only opened if its cwd matches, and
 * both the per-store file walk and the preview read are line-capped.
 */
export async function listForeignSessions(
  cwd: string,
  limit = 5,
  homeDir = os.homedir(),
): Promise<RecentSession[]> {
  const [claude, codex] = await Promise.all([
    listClaudeSessions(cwd, limit, homeDir),
    listCodexSessions(cwd, limit, homeDir),
  ]);
  return [...claude, ...codex]
    .sort((left, right) => right.lastActiveMs - left.lastActiveMs)
    .slice(0, limit)
    .map(({ lastActiveMs: _lastActiveMs, ...session }) => session);
}

/** A foreign row plus the raw mtime the caller sorts on before discarding it. */
type DatedForeignSession = RecentSession & { lastActiveMs: number };

async function listClaudeSessions(
  cwd: string,
  limit: number,
  homeDir: string,
): Promise<DatedForeignSession[]> {
  const projectsDir = path.join(homeDir, ".claude", "projects");
  if (!(await isDirectory(projectsDir))) return [];

  // Claude's directory encoding is ambiguous (every "/" becomes "-", colliding
  // with real dashes), so we cannot map cwd → directory. Instead walk the files
  // newest-first and keep the ones whose recorded cwd matches.
  const files = await collectJsonlFiles(projectsDir, 3);
  return collectMatchingForeignSessions(files, cwd, limit, "claude-code", claudeCwdExtractor);
}

async function listCodexSessions(
  cwd: string,
  limit: number,
  homeDir: string,
): Promise<DatedForeignSession[]> {
  const sessionsDir = path.join(homeDir, ".codex", "sessions");
  if (!(await isDirectory(sessionsDir))) return [];
  // Layout is YYYY/MM/DD/*.jsonl — depth 4 covers it.
  const files = await collectJsonlFiles(sessionsDir, 4);
  return collectMatchingForeignSessions(files, cwd, limit, "codex", codexCwdExtractor);
}

/**
 * Newest-first scan for transcripts belonging to `cwd`. Stops as soon as
 * `limit` matches are found so a large history costs only the files it reads.
 */
async function collectMatchingForeignSessions(
  files: { path: string; mtime: number }[],
  cwd: string,
  limit: number,
  source: ProjectSource,
  extractor: LineExtractor,
): Promise<DatedForeignSession[]> {
  if (files.length === 0) return [];
  files.sort((left, right) => right.mtime - left.mtime);
  const target = path.resolve(stripExtendedLengthPrefix(cwd));

  const out: DatedForeignSession[] = [];
  for (const file of files) {
    if (out.length >= limit) break;
    const recorded = await readFirstFromFile(file.path, extractor);
    if (!recorded) continue;
    if (path.resolve(stripExtendedLengthPrefix(recorded)) !== target) continue;

    const summary = await readForeignSessionSummary(file.path, source);
    if (!summary) continue;
    out.push({
      ...summary,
      lastActiveDisplay: formatRelativeTime(file.mtime),
      lastActiveMs: file.mtime,
    });
  }
  return out;
}

/**
 * Preview + message count for a foreign transcript, using the same parsers the
 * importer uses — so the row's title is exactly the title the imported session
 * ends up with (notably Cursor's `<user_query>` unwrapping).
 */
async function readForeignSessionSummary(
  file: string,
  source: ProjectSource,
): Promise<Omit<RecentSession, "lastActiveDisplay"> | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = parseForeignTranscript(text, source === "codex" ? "codex" : "claude");
    if (parsed.messages.length === 0) return null;
    return {
      id: path.basename(file).replace(/\.jsonl$/, ""),
      path: file,
      preview: parsed.preview ?? "(no prompt)",
      messageCount: parsed.messages.length,
      source,
    };
  } catch {
    // An unreadable transcript is skipped, never surfaced as a broken row.
    return null;
  }
}

interface ParsedRecentSession extends RecentSession {
  conversationId: string;
}

/** Single-pass parse of one session file: identity + count + activity + preview. */
async function readSessionSummary(file: string): Promise<ParsedRecentSession | null> {
  try {
    const { path: resolvedPath, stream, close } = await openSessionReadStream(file);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let id = "";
    let conversationId = "";
    let messageCount = 0;
    let lastActivity = "";
    let headerPreview = "";
    let preview = "";
    let label = "";
    let valid = false;

    try {
      for await (const line of rl) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as {
            type?: string;
            id?: string;
            conversationId?: string;
            preview?: unknown;
            timestamp?: string;
            label?: unknown;
            message?: { role?: string; content?: unknown };
          };
          if (!valid) {
            if (entry.type !== "session") return null;
            valid = true;
            id = entry.id ?? "";
            conversationId = entry.conversationId ?? id;
            if (typeof entry.preview === "string") {
              headerPreview = entry.preview.replace(/\s+/g, " ").trim().slice(0, 80);
            }
            if (entry.timestamp) lastActivity = entry.timestamp;
            continue;
          }
          if (entry.type === "label" && typeof entry.label === "string" && entry.label.trim()) {
            label = entry.label.replace(/\s+/g, " ").trim().slice(0, 80);
          } else if (entry.type === "message") {
            messageCount += 1;
            if (entry.timestamp) lastActivity = entry.timestamp;
            if (!preview && entry.message?.role === "user") {
              const text = getUserSessionPrompt(entry.message.content);
              if (text) preview = text.replace(/\s+/g, " ").trim().slice(0, 80);
            }
          }
        } catch {
          // Skip malformed lines; archive migration preserves them byte-for-byte.
        }
      }
    } finally {
      // `return null` above exits mid-stream; close() destroys gunzip + source.
      rl.close();
      close();
    }
    return valid
      ? {
          id,
          conversationId: conversationId || id,
          path: resolvedPath,
          preview: label || headerPreview || preview,
          lastActiveDisplay: rel(lastActivity),
          messageCount,
        }
      : null;
  } catch {
    return null;
  }
}

function rel(timestamp: string): string {
  return formatRelativeTime(Date.parse(timestamp) || 0);
}
