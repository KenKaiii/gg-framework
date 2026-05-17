import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

/**
 * Stack-frame source map resolution.
 *
 * Browser SDKs send minified frames like
 *   { file: "https://app.com/dist/main.abc123.js", line: 1, col: 48201, fn: "<anon>" }
 *
 * Source maps emitted by bundlers (Vite, Webpack, Rollup, esbuild) translate
 * those `(line, col)` coordinates back to the original source `(file, line, col, name)`.
 *
 * We resolve **client-side** in the runner: we walk the user's project
 * directory looking for `.map` files whose name matches the minified
 * filename in the stack frame. If found, we use `@jridgewell/trace-mapping`
 * to look up each frame's original position.
 *
 * Limitations (deliberately documented):
 * - Requires the maps to exist locally (project's `dist/`, `build/`, etc.).
 *   For deployed apps where the dev's machine has no build, server-side
 *   symbolication via uploaded maps is needed — that's a separate slice.
 * - Walks up to 4 levels deep into common build dirs to keep cost bounded.
 */

export interface StackFrame {
  file: string;
  line: number;
  col: number;
  fn: string;
  in_app: boolean;
}

const DEBUG_BUILD = process.env.NODE_ENV !== "production";
const COMMON_BUILD_DIRS = ["dist", "build", ".next", "out", "public", ".vite"];
const MAX_DEPTH = 4;
const MAX_ENTRIES = 50;

interface MapCacheEntry {
  trace: TraceMap;
  mapDir: string;
}

export class SourceMapResolver {
  private readonly cache = new Map<string, MapCacheEntry | null>();
  private readonly accessOrder: string[] = [];

  constructor(private readonly projectDir: string) {}

  /**
   * Resolve a minified stack into the original source. Frames that can't
   * be resolved are returned unchanged so the caller still sees something.
   */
  resolveStack(stack: StackFrame[]): StackFrame[] {
    return stack.map((f) => this.resolveFrame(f));
  }

  resolveFrame(frame: StackFrame): StackFrame {
    const minifiedName = filenameFromUrl(frame.file);
    if (!minifiedName) return frame;
    const entry = this.findMap(minifiedName);
    if (!entry) return frame;
    let resolved;
    try {
      resolved = originalPositionFor(entry.trace, { line: frame.line, column: frame.col });
    } catch {
      return frame;
    }
    if (!resolved.source) return frame;
    const sourceAbs = posix.normalize(posix.join(entry.mapDir, resolved.source));
    return {
      file: sourceAbs,
      line: resolved.line ?? frame.line,
      col: resolved.column ?? frame.col,
      fn: resolved.name || frame.fn,
      in_app: !sourceAbs.includes("/node_modules/") && !sourceAbs.startsWith("webpack:///"),
    };
  }

  private findMap(minifiedName: string): MapCacheEntry | null {
    const cached = this.cache.get(minifiedName);
    if (cached !== undefined) {
      // Move to end (most recently used)
      const idx = this.accessOrder.indexOf(minifiedName);
      if (idx !== -1) this.accessOrder.splice(idx, 1);
      this.accessOrder.push(minifiedName);
      return cached;
    }
    const result = this.searchForMap(minifiedName);
    this.cache.set(minifiedName, result);
    this.accessOrder.push(minifiedName);
    if (this.cache.size > MAX_ENTRIES) {
      // Evict oldest (front of accessOrder)
      const evictKey = this.accessOrder.shift()!;
      this.cache.delete(evictKey);
    }
    return result;
  }

  private searchForMap(minifiedName: string): MapCacheEntry | null {
    for (const dir of COMMON_BUILD_DIRS) {
      const root = join(this.projectDir, dir);
      if (!existsSync(root)) continue;
      const found = walkForMap(root, minifiedName, MAX_DEPTH);
      if (found) return loadMap(found);
    }
    const rootCandidate = join(this.projectDir, minifiedName + ".map");
    if (existsSync(rootCandidate)) return loadMap(rootCandidate);
    if (DEBUG_BUILD) {
      console.warn(`[source-maps] map not found for: ${minifiedName}`);
    }
    return null;
  }
}

function filenameFromUrl(file: string): string | null {
  if (!file) return null;
  const cleaned = file.split("?")[0]!.split("#")[0]!;
  const last = cleaned.split("/").pop();
  return last || null;
}

function walkForMap(root: string, minifiedName: string, depth: number): string | null {
  const target = minifiedName + ".map";
  const direct = join(root, target);
  if (existsSync(direct)) return direct;
  if (depth <= 0) return null;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const child = join(root, entry);
    if (!isDirectorySafe(child)) continue;
    const found = walkForMap(child, minifiedName, depth - 1);
    if (found) return found;
  }
  return null;
}

function isDirectorySafe(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function loadMap(mapPath: string): MapCacheEntry | null {
  try {
    const raw = readFileSync(mapPath, "utf8");
    const parsed = JSON.parse(raw) as object;
    try {
      return { trace: new TraceMap(parsed as never), mapDir: dirname(mapPath) };
    } catch (parseErr) {
      if (DEBUG_BUILD) {
        console.warn("[source-maps] TraceMap parse failure:", parseErr);
      }
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Best-effort wrapper that swallows all errors. The runner calls this on
 * every error fetch — if anything goes wrong, we don't want to break the
 * whole TUI.
 */
export function tryResolveStack(stack: StackFrame[], projectDir: string): StackFrame[] {
  try {
    const resolver = new SourceMapResolver(projectDir);
    return resolver.resolveStack(stack);
  } catch {
    return stack;
  }
}
