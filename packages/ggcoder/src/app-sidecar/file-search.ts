import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../core/logger.js";

// ── @-mention file search (chat-input file picker) ─────────────────────────
// Lists project files for the webview's `@` picker. Empty query → newest files
// by mtime; a query → fuzzy-ranked basename/path matches. Honors .gitignore and
// skips node_modules/.git so the picker mirrors the agent's `find` tool.
interface FileHit {
  /** Project-relative POSIX path, e.g. "src/App.tsx". */
  path: string;
  /** File name only, e.g. "App.tsx". */
  name: string;
}

const FILE_SEARCH_LIMIT = 20;

// Upper bound on files walked per search (baseline #8 memory cap). Far above the
// 20-result output limit, so relevance/recency ranking is unaffected in practice.
const FILE_SEARCH_SCAN_CAP = 50_000;

/** Score a candidate path against a lowercased query. Higher is better; a
 *  negative score means "no match". Basename hits beat path hits; prefix beats
 *  substring; shorter paths break ties. */
function scoreFile(relPath: string, name: string, query: string): number {
  const lcPath = relPath.toLowerCase();
  const lcName = name.toLowerCase();
  let score = -1;
  if (lcName === query) score = 1000;
  else if (lcName.startsWith(query)) score = 800;
  else if (lcName.includes(query)) score = 600;
  else if (lcPath.startsWith(query)) score = 400;
  else if (lcPath.includes(query)) score = 200;
  else if (subsequenceMatch(lcPath, query)) score = 100;
  if (score < 0) return -1;
  // Prefer shorter paths (closer to root, less nesting) on equal match class.
  return score - relPath.length * 0.1;
}

/** True when every char of `needle` appears in `haystack` in order (fuzzy). */
function subsequenceMatch(haystack: string, needle: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

export async function searchProjectFiles(cwd: string, rawQuery: string): Promise<FileHit[]> {
  const fg = await import("fast-glob");
  const ignore = await import("ignore");
  const query = rawQuery.trim().toLowerCase();

  let gitignore: string[] = [];
  try {
    const content = await fs.readFile(path.join(cwd, ".gitignore"), "utf-8");
    gitignore = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    // No .gitignore — nothing extra to ignore.
  }
  const ig = ignore.default().add(gitignore);

  // `stats: true` gives mtime without a second stat pass, so the empty-query
  // "recent files" path is a single walk. Stream + hard scan cap (baseline #8):
  // collecting the full result array retained ~0.9 MB per 1k files (18.5 MB at
  // 20k), unbounded. Bail after FILE_SEARCH_SCAN_CAP entries so a giant repo
  // can't balloon RSS; the newest/most-relevant matches still surface because
  // the cap is far above the 20-result output limit.
  const entries: { path: string; stats?: { mtimeMs: number } }[] = [];
  const scanStream = fg.default.stream("**/*", {
    cwd,
    dot: false,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/.git/**", "**/.gg/**"],
    suppressErrors: true,
    followSymbolicLinks: false,
    stats: true,
  });
  for await (const entry of scanStream) {
    entries.push(entry as unknown as { path: string; stats?: { mtimeMs: number } });
    if (entries.length >= FILE_SEARCH_SCAN_CAP) {
      (scanStream as unknown as { destroy: () => void }).destroy();
      log("DEBUG", "app-sidecar", "file search scan cap hit", {
        cap: String(FILE_SEARCH_SCAN_CAP),
        cwd,
      });
      break;
    }
  }
  const files = entries.filter((e) => !ig.ignores(e.path));

  if (!query) {
    return files
      .sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0))
      .slice(0, FILE_SEARCH_LIMIT)
      .map((e) => ({ path: e.path, name: path.posix.basename(e.path) }));
  }

  const scored: { hit: FileHit; score: number }[] = [];
  for (const e of files) {
    const name = path.posix.basename(e.path);
    const score = scoreFile(e.path, name, query);
    if (score >= 0) scored.push({ hit: { path: e.path, name }, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, FILE_SEARCH_LIMIT).map((s) => s.hit);
}
