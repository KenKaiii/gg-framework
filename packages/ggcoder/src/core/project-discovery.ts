import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { getAppPaths } from "../config.js";
import { encodeCwd, stripExtendedLengthPrefix } from "./encode-cwd.js";
import { getUserSessionPrompt } from "./session-preview.js";
import { isSessionPath, openSessionReadStream, resolveSessionPath } from "./session-storage.js";
import { parseForeignTranscript } from "./foreign-session-import.js";

export type ProjectSource = "ggcoder" | "claude-code" | "codex";

export interface DiscoveredProject {
  name: string;
  path: string;
  lastActiveMs: number;
  lastActiveDisplay: string;
  /** Sorted, deduped list of stores this project showed up in. */
  sources: ProjectSource[];
}

/**
 * Scan ggcoder + Claude Code + Codex session stores and return one row per
 * project, sorted most-recent first. Duplicates (same cwd) are collapsed; the
 * `sources` field lists every store the project appeared in so the picker can
 * show a combined badge.
 */
export async function discoverProjects(): Promise<DiscoveredProject[]> {
  const [gg, cc, cx] = await Promise.all([
    discoverGgcoderProjects(),
    discoverClaudeProjects(),
    discoverCodexProjects(),
  ]);

  return mergeDiscoveredProjects([...gg, ...cc, ...cx]);
}

const SOURCE_ORDER: Record<ProjectSource, number> = {
  ggcoder: 0,
  "claude-code": 1,
  codex: 2,
};

function mergeSources(a: ProjectSource[], b: ProjectSource[]): ProjectSource[] {
  const set = new Set<ProjectSource>([...a, ...b]);
  return Array.from(set).sort((x, y) => SOURCE_ORDER[x] - SOURCE_ORDER[y]);
}

/** Comparison key for resolved project paths; Windows filesystems are case-insensitive. */
export function discoveryPathKey(projectPath: string, platform = process.platform): string {
  const resolved = path.resolve(projectPath);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Merge discovery sources by normalized path, retaining newest activity and all sources. */
export function mergeDiscoveredProjects(
  projects: DiscoveredProject[],
  platform = process.platform,
): DiscoveredProject[] {
  const byPath = new Map<string, DiscoveredProject>();
  for (const project of projects) {
    const resolvedPath = path.resolve(project.path);
    const key = discoveryPathKey(resolvedPath, platform);
    const existing = byPath.get(key);
    if (!existing) {
      byPath.set(key, { ...project, path: resolvedPath });
      continue;
    }
    const lastActiveMs = Math.max(existing.lastActiveMs, project.lastActiveMs);
    byPath.set(key, {
      ...existing,
      lastActiveMs,
      lastActiveDisplay: formatRelativeTime(lastActiveMs),
      sources: mergeSources(existing.sources, project.sources),
    });
  }
  return Array.from(byPath.values())
    .map((project) => ({
      ...project,
      lastActiveDisplay: formatRelativeTime(project.lastActiveMs),
    }))
    .sort((a, b) => b.lastActiveMs - a.lastActiveMs);
}

/** Discover readable direct child directories under the configured projects root. */
export async function discoverProjectsRootFolders(
  projectsRoot: string,
): Promise<DiscoveredProject[]> {
  if (!projectsRoot.trim()) return [];
  const resolvedRoot = path.resolve(projectsRoot);
  let entries;
  try {
    entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const projects: DiscoveredProject[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectPath = path.resolve(resolvedRoot, entry.name);
    try {
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;
      projects.push({
        name: entry.name,
        path: projectPath,
        lastActiveMs: stat.mtimeMs,
        lastActiveDisplay: formatRelativeTime(stat.mtimeMs),
        sources: ["ggcoder"],
      });
    } catch {
      // Best effort: a disappearing or unreadable child must not fail discovery.
    }
  }
  return projects;
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

  const results: DiscoveredProject[] = [];
  for (const entry of entries) {
    const dir = path.join(sessionsDir, entry);
    const mtime = await maxGgcoderSessionMtime(dir);
    if (mtime === null) continue;

    const rawCwd =
      (await readFirstFromGgcoderDir(dir, ggcoderCwdExtractor)) ?? fallbackUnderscoreDecode(entry);
    if (!rawCwd) continue;
    // Normalize traversal segments (e.g. an agent launched with cwd
    // `.../src-tauri/../..`) so the basename isn't a stray "..", and drop any
    // Windows extended-length prefix so a session recorded as `\\?\C:\proj`
    // (what Rust's canonicalize used to hand the sidecar) resolves to the same
    // project as a plain `C:\proj` instead of listing a prefixed duplicate.
    const cwd = path.resolve(stripExtendedLengthPrefix(rawCwd));
    if (!(await isDirectory(cwd))) continue;

    results.push({
      name: path.basename(cwd),
      path: cwd,
      lastActiveMs: mtime,
      lastActiveDisplay: formatRelativeTime(mtime),
      sources: ["ggcoder"],
    });
  }
  return results;
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

  const results = await Promise.all(
    entries.map(async (entry): Promise<DiscoveredProject | null> => {
      const dir = path.join(projectsDir, entry);
      const mtime = await maxJsonlMtime(dir);
      if (mtime === null) return null;

      const cwd =
        (await readFirstFromJsonlDir(dir, claudeCwdExtractor)) ?? fallbackDashDecode(entry);
      if (!cwd) return null;
      if (!(await isDirectory(cwd))) return null;

      return {
        name: path.basename(cwd),
        path: cwd,
        lastActiveMs: mtime,
        lastActiveDisplay: formatRelativeTime(mtime),
        sources: ["claude-code"],
      };
    }),
  );
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

  const byCwd = new Map<string, number>();
  for (const f of files) {
    const cwd = await readFirstFromFile(f.path, codexCwdExtractor);
    if (!cwd) continue;
    const prev = byCwd.get(cwd);
    if (prev === undefined || f.mtime > prev) byCwd.set(cwd, f.mtime);
  }

  const results: DiscoveredProject[] = [];
  for (const [cwd, mtime] of byCwd) {
    if (!(await isDirectory(cwd))) continue;
    results.push({
      name: path.basename(cwd),
      path: cwd,
      lastActiveMs: mtime,
      lastActiveDisplay: formatRelativeTime(mtime),
      sources: ["codex"],
    });
  }
  return results;
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

async function maxGgcoderSessionMtime(dir: string): Promise<number | null> {
  if (!(await isDirectory(dir))) return null;
  const files = await collectGgcoderSessionFiles(dir, 2);
  if (files.length === 0) return null;
  return Math.max(...files.map((file) => file.mtime));
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
    try {
      const { stream } = await openSessionReadStream(file.path);
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let lines = 0;
      for await (const line of rl) {
        if (++lines > 200) break;
        const value = extractor(line);
        if (value) return value;
      }
    } catch {
      // A corrupt archive must not hide otherwise valid projects in this store.
    }
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

function formatRelativeTime(ms: number): string {
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
): Promise<RecentSession[]> {
  const dir = path.join(sessionsDir, encodeCwd(cwd));
  const files = await collectGgcoderSessionFiles(dir, 1);
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
    const { path: resolvedPath, stream } = await openSessionReadStream(file);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let id = "";
    let conversationId = "";
    let messageCount = 0;
    let lastActivity = "";
    let headerPreview = "";
    let preview = "";
    let label = "";
    let valid = false;

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
