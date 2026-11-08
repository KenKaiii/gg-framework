import readline from "node:readline";
import path from "node:path";
import { spawn } from "node:child_process";
import { readdir as readdirCallback, type Dirent } from "node:fs";
import type { Ignore } from "ignore";
import { z } from "zod";
import type { AgentTool } from "@kleio/agent";
import { sliceHead } from "@kleio/ai";
import { resolvePath } from "./path-utils.js";
import { BINARY_EXTENSIONS } from "./read.js";
import { localOperations, readFileBounded, type ToolOperations } from "./operations.js";
import {
  getGrepWorkerPool,
  makeByteFilter,
  scanText,
  type ByteFilter,
  type GrepWorkerPool,
  type ScanJobResult,
  type ScanTextOptions,
} from "./grep-scan.js";

const GrepParams = z.object({
  pattern: z.string().describe("JS regex"),
  path: z.string().optional(),
  include: z.string().optional().describe("File glob"),
  max_results: z.number().int().min(1).optional(),
  case_insensitive: z.boolean().optional(),
});

const DEFAULT_MAX_RESULTS = 50;
const MAX_LINE_LENGTH = 500;
/** Skip files larger than 10 MB — single-line files (minified JS, data blobs) can OOM readline */
const MAX_FILE_SIZE = 10 * 1024 * 1024;
/**
 * Files up to this size are read in one call and rejected with a single regex
 * pass when nothing matches; larger ones stream line by line. Reading whole is
 * 3–4x faster than readline on source trees, and the cap bounds the memory a
 * full scan pool can hold at once (SCAN_CONCURRENCY × this).
 */
const WHOLE_READ_MAX_BYTES = 1024 * 1024;
/** Lines checked for a NUL byte before a file is treated as binary and abandoned. */
const BINARY_SNIFF_LINES = 5;
/**
 * Upper bound on files one call scans. The wall-clock deadline is the real
 * time bound; this caps memory. At 10k it silently hid everything past the
 * first 10k paths (a 12.8k-file repo, a 57k-file goal folder); the byte filter
 * scans 57k files in ~2s, inside the deadline.
 */
const MAX_CANDIDATE_FILES = 100_000;
/** Wall-clock budget for a single grep call — catastrophic backtracking is count-bounded but not time-bounded */
const GREP_DEADLINE_MS = 5_000;
/**
 * Files scanned concurrently on the in-process path. A grep call is almost
 * entirely I/O wait, so scanning one file at a time turned "slow" into
 * "incomplete": the wall-clock budget expired mid-directory and the model saw a
 * partial answer as if it were the whole one.
 */
const SCAN_CONCURRENCY = 12;
/**
 * Scans of at least this many files run on the worker-thread pool. Below it,
 * a cold pool's ~15ms startup costs more than the parallelism saves.
 */
const WORKER_MIN_FILES = 256;
/** Cap on bytes accepted from the external scanner before results are ranked. */
const MAX_EXTERNAL_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Long patterns are almost always mistakes and raise the cost of every pathological shape */
const MAX_PATTERN_LENGTH = 1_000;
/** Check the clock every N lines inside a file scan — cheap enough to be free, dense enough to bound one bad line */
const DEADLINE_CHECK_INTERVAL = 512;

/** Shared wall-clock budget for one grep call. */
interface Deadline {
  readonly expiresAt: number;
  hit: boolean;
}

function createDeadline(budgetMs = GREP_DEADLINE_MS): Deadline {
  return { expiresAt: Date.now() + budgetMs, hit: false };
}

function isExpired(deadline: Deadline): boolean {
  if (deadline.hit) return true;
  if (Date.now() >= deadline.expiresAt) {
    deadline.hit = true;
    return true;
  }
  return false;
}

const QUANTIFIER_CHARS = new Set(["+", "*", "?"]);
/** Quantifiers with no upper bound — only these make an outer group explode. */
const UNBOUNDED_QUANTIFIER_CHARS = new Set(["+", "*"]);
/** `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>` — a group modifier, not a quantifier. */
const GROUP_MODIFIER = /^\?(?::|=|!|<=|<!|<[^>]*>)/;

/**
 * Detect a quantified group whose body itself contains a quantifier — `(a+)+`,
 * `(\w+\s?)*`, `(x*){2,}`. These are the classic catastrophic-backtracking shapes:
 * a single long line can pin the event loop for minutes. Deliberately narrow —
 * it rejects the shapes models actually emit by accident, not every slow regex.
 */
function findNestedQuantifier(pattern: string): string | undefined {
  const groupStarts: number[] = [];
  let inClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      groupStarts.push(i);
      continue;
    }
    if (ch !== ")") continue;

    const start = groupStarts.pop();
    if (start === undefined) continue;

    const next = pattern[i + 1];
    // `(...)?` can never backtrack catastrophically — only unbounded outer
    // quantifiers (`+`, `*`, `{n,}`) can.
    const quantified =
      next !== undefined &&
      (UNBOUNDED_QUANTIFIER_CHARS.has(next) ||
        (next === "{" && /^\{\d*,\}/.test(pattern.slice(i + 1))));
    if (!quantified) continue;

    const body = pattern.slice(start + 1, i).replace(GROUP_MODIFIER, "");
    if (containsQuantifier(body)) {
      const end = next === "{" ? i + 1 + pattern.slice(i + 1).indexOf("}") + 1 : i + 2;
      return pattern.slice(start, end);
    }
  }

  return undefined;
}

function containsQuantifier(body: string): boolean {
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (QUANTIFIER_CHARS.has(ch)) return true;
    if (ch === "{" && /^\{\d*,\d*\}/.test(body.slice(i))) return true;
  }
  return false;
}

export interface GrepToolOptions {
  /** Wall-clock budget for one call. Overridable so tests can trip it without a 5s wait. */
  deadlineMs?: number;
  /**
   * Whether the external `rg` scanner may be used when it is on PATH. Read
   * lazily so a settings change takes effect without rebuilding the toolset.
   */
  useExternalScanner?: () => boolean;
  /** Test seam: smallest scan that uses worker threads (default WORKER_MIN_FILES). */
  workerMinFiles?: number;
}

export function createGrepTool(
  cwd: string,
  ops: ToolOperations = localOperations,
  options: GrepToolOptions = {},
): AgentTool<typeof GrepParams> {
  const deadlineMs = options.deadlineMs ?? GREP_DEADLINE_MS;
  const workerMinFiles = options.workerMinFiles ?? WORKER_MIN_FILES;
  // The external scanner reads the real filesystem, so it is only valid when
  // this tool is also pointed at the real filesystem. Remote operations
  // (SSH/Docker) must stay on the in-process path.
  const externalAllowed = ops === localOperations;
  return {
    name: "grep",
    description:
      "Regex search of file contents → matches grouped by file (path, then line:text rows). Skips .gitignored and binary files.",
    parameters: GrepParams,
    async execute({ pattern, path: searchPath, include, max_results, case_insensitive }) {
      const dir = searchPath ? resolvePath(cwd, searchPath) : cwd;
      const maxResults = max_results ?? DEFAULT_MAX_RESULTS;
      // Models commonly emit the RE2/PCRE-style leading `(?i)` flag. JavaScript
      // rejects it as an invalid group, so translate that safe, unambiguous form
      // to the equivalent RegExp flag while preserving the explicit tool option.
      const hasInlineCaseInsensitiveFlag = pattern.startsWith("(?i)");
      const normalizedPattern = hasInlineCaseInsensitiveFlag ? pattern.slice(4) : pattern;
      const flags = case_insensitive || hasInlineCaseInsensitiveFlag ? "gi" : "g";

      if (pattern.length > MAX_PATTERN_LENGTH) {
        throw new Error(
          `Invalid regex pattern: ${pattern.length} characters exceeds the ${MAX_PATTERN_LENGTH}-character limit. ` +
            `Search for a shorter literal substring and filter the results instead.`,
        );
      }

      const nested = findNestedQuantifier(normalizedPattern);
      if (nested) {
        throw new Error(
          `Invalid regex pattern: nested quantifier \`${nested}\` can backtrack catastrophically. ` +
            `Rewrite it as a literal or an anchored pattern (e.g. \`^\\w+$\` instead of \`(\\w+)+$\`).`,
        );
      }

      let regex: RegExp;
      try {
        regex = new RegExp(normalizedPattern, flags);
      } catch (err) {
        throw new Error(`Invalid regex pattern: ${(err as Error).message}`, { cause: err });
      }

      const deadline = createDeadline(deadlineMs);
      const literals = requiredLiterals(normalizedPattern);
      const byteFilter = makeByteFilter(literals, flags.includes("i"));

      // Check if dir is a file
      const stat = await ops.stat(dir);
      if (stat.isFile()) {
        const results = await searchFile(dir, regex, cwd, maxResults, ops, deadline, byteFilter);
        return formatResults(results, maxResults, false, deadline.hit, deadlineMs);
      }

      // An already-spent budget must not start a scan it cannot honour.
      // `runExternalScan` floors the child's budget at 1ms, so without this
      // guard an expired deadline still races ripgrep and returns real matches
      // whenever the child wins — reporting results the caller's budget had
      // already ruled out, and non-deterministically at that. The in-process
      // path below reports the expiry directly instead.
      const useExternal =
        externalAllowed &&
        !isExpired(deadline) &&
        (options.useExternalScanner?.() ?? true) &&
        isExternallySupported(normalizedPattern) &&
        (await detectExternalScanner()) !== undefined;

      if (useExternal) {
        const external = await runExternalScan({
          dir,
          cwd,
          pattern: normalizedPattern,
          include,
          caseInsensitive: flags.includes("i"),
          maxResults,
          deadline,
          deadlineMs,
        });
        // A scanner failure is a tooling problem, not a search result — retry
        // the query in-process rather than reporting a false "no matches".
        if (external) {
          return formatResults(external, maxResults, false, deadline.hit, deadlineMs);
        }
      }

      const { files, candidateLimitHit } = await enumerateCandidates(dir, include);
      // Workers read the real filesystem, so remote operations stay on the
      // main thread, as does any scan too small to repay a pool's startup.
      const pool =
        ops === localOperations && files.length >= workerMinFiles
          ? getGrepWorkerPool(WHOLE_READ_MAX_BYTES)
          : undefined;
      const results = pool
        ? await scanWithWorkers(pool, {
            files,
            dir,
            regex,
            cwd,
            maxResults,
            deadline,
            literals,
            byteFilter,
          })
        : await scanFiles(files, dir, regex, cwd, maxResults, ops, deadline, byteFilter);
      return formatResults(results, maxResults, candidateLimitHit, deadline.hit, deadlineMs);
    },
  };
}

/**
 * Build the candidate file list for one directory scan.
 *
 * Two recall fixes live here. Dot-entries are included, because `.github/`,
 * `.changeset/` and similar directories hold real, searchable project files.
 * And `.gitignore` is applied for real (it previously was not, despite being
 * advertised), so build output and vendored trees stop crowding out source.
 * An explicit `path` INTO an ignored directory still searches it: the ignore
 * file is read relative to the scan root, so scoping past it is the escape
 * hatch.
 *
 * The list is sorted so results are deterministic and byte-comparable across
 * scanners; the parallel scan below relies on that order too.
 */
async function enumerateCandidates(
  dir: string,
  include: string | undefined,
): Promise<{ files: string[]; candidateLimitHit: boolean }> {
  const fg = await import("fast-glob");
  const ignorePatterns = await loadIgnorePatterns(dir);
  const ig = await rootIgnore(dir, ignorePatterns);

  const globPattern = normalizeIncludeGlob(include);
  const entries = await fg.default(globPattern, {
    cwd: dir,
    dot: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/.git/**"],
    suppressErrors: true,
    followSymbolicLinks: false,
    // Prune ignored directories during the walk. Filtering only afterwards
    // walked every file under `target/`, `.venv/` or a build cache first —
    // 121k files walked to keep 3k on this repo.
    ...(ignorePatterns.length > 0 ? { fs: { readdir: prunedReaddir(dir, ig) } } : {}),
  });

  const kept = entries
    .filter((entry) => !BINARY_EXTENSIONS.has(path.extname(entry).toLowerCase()))
    .filter((entry) => !ig.ignores(entry))
    .sort();
  return {
    files: kept.slice(0, MAX_CANDIDATE_FILES),
    candidateLimitHit: kept.length > MAX_CANDIDATE_FILES,
  };
}

type ReaddirCallback = (err: NodeJS.ErrnoException | null, entries: Dirent[]) => void;

/**
 * A `readdir` for fast-glob's walker that drops entries the root `.gitignore`
 * ignores, so ignored directories are never descended into. The final
 * `ig.ignores` filter still runs on every file, so this only removes work:
 * `ignore` treats a path as ignored when any parent directory is, and git
 * cannot re-include a file under an ignored directory, so a pruned directory
 * held nothing the filter would have kept.
 */
function prunedReaddir(root: string, ig: Ignore): typeof readdirCallback {
  const pruned = (
    dirPath: string,
    options: unknown,
    callback: ReaddirCallback | undefined,
  ): void => {
    // Only the `withFileTypes` form is pruned; any other call shape (a plain
    // name list) passes through untouched rather than guessing at types.
    if (typeof callback !== "function" || !isWithFileTypes(options)) {
      Reflect.apply(readdirCallback, undefined, [dirPath, options, callback]);
      return;
    }
    readdirCallback(dirPath, { withFileTypes: true }, (err, dirents) => {
      if (err) {
        callback(err, []);
        return;
      }
      const relDir = path.relative(root, dirPath).replace(/\\/g, "/");
      callback(
        null,
        dirents.filter((entry) => {
          // Files are left to the final filter: checking them here as well
          // costs a pattern match per file and saves no directory reads.
          if (!entry.isDirectory()) return true;
          const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
          // `ignore` throws on paths outside the root; keep anything odd.
          if (rel.startsWith("../") || path.isAbsolute(rel)) return true;
          return !ig.ignores(`${rel}/`);
        }),
      );
    });
  };
  // fast-glob types this slot as Node's fully overloaded `readdir`; `pruned`
  // implements the one overload the walker calls and forwards the rest.
  return pruned as unknown as typeof readdirCallback;
}

function isWithFileTypes(options: unknown): boolean {
  return (
    typeof options === "object" &&
    options !== null &&
    "withFileTypes" in options &&
    options.withFileTypes === true
  );
}

/**
 * Normalize an `include` glob to gitignore-style semantics: a bare pattern
 * with no separator matches at any depth. Models write `*.ts` meaning "every
 * TypeScript file", and a root-only interpretation silently returned nothing
 * for any project that keeps its sources in a subdirectory.
 */
function normalizeIncludeGlob(include: string | undefined): string {
  // Backslashes are picomatch ESCAPES, not separators: a Windows-shaped
  // `include` (e.g. `src\**\*.ts`) would match nothing.
  const normalized = (include ?? "**/*").replace(/\\/g, "/");
  return normalized.includes("/") ? normalized : `**/${normalized}`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const fs = await import("node:fs/promises");
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Compiled root ignore files, most recently used last. */
const ignoreCache = new Map<string, Ignore>();
const IGNORE_CACHE_SIZE = 8;

/**
 * The matcher for one scan root's ignore patterns, reused across calls while
 * the patterns are unchanged. `ignore` tests every rule against every path and
 * memoizes answers per instance: a fresh instance per call spent ~80ms on a
 * 346-line .gitignore (osu) re-deciding the same paths. The key is the pattern
 * text itself, so an edited .gitignore gets a fresh matcher.
 */
async function rootIgnore(dir: string, patterns: readonly string[]): Promise<Ignore> {
  const key = `${path.resolve(dir)}\0${patterns.join("\n")}`;
  const cached = ignoreCache.get(key);
  if (cached) {
    ignoreCache.delete(key);
    ignoreCache.set(key, cached);
    return cached;
  }
  const ignoreModule = await import("ignore");
  const ig = ignoreModule.default().add([...patterns]);
  ignoreCache.set(key, ig);
  for (const stale of ignoreCache.keys()) {
    if (ignoreCache.size <= IGNORE_CACHE_SIZE) break;
    ignoreCache.delete(stale);
  }
  return ig;
}

async function loadIgnorePatterns(dir: string): Promise<string[]> {
  try {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(path.join(dir, ".gitignore"), "utf-8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * Scan candidates with a bounded worker pool, emitting results in candidate
 * order regardless of completion order: each file writes into its own slot and
 * the slots are flattened at the end. Ordering is therefore identical to a
 * sequential scan over the same list.
 *
 * Scheduling stops as soon as enough matches exist. Because candidates are in
 * sorted order and every scheduled index precedes every unscheduled one, the
 * first `maxResults` entries of the flattened array are exactly the ones a
 * sequential scan would have produced before stopping.
 */
async function scanFiles(
  files: readonly string[],
  dir: string,
  regex: RegExp,
  cwd: string,
  maxResults: number,
  ops: ToolOperations,
  deadline: Deadline,
  byteFilter?: ByteFilter,
): Promise<string[]> {
  const slots: string[][] = new Array(files.length).fill(undefined).map(() => []);
  let next = 0;
  let collected = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (collected >= maxResults || isExpired(deadline)) return;
      const index = next++;
      if (index >= files.length) return;
      // Each worker owns a private RegExp: `lastIndex` on a shared global regex
      // is mutated during `test`, so concurrent scans would corrupt each other.
      const own = new RegExp(regex.source, regex.flags);
      const fileResults = await searchFile(
        path.join(dir, files[index]),
        own,
        cwd,
        maxResults,
        ops,
        deadline,
        byteFilter,
      );
      slots[index] = fileResults;
      collected += fileResults.length;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, files.length || 1) }, () => worker()),
  );

  const results: string[] = [];
  for (const slot of slots) {
    for (const line of slot) {
      results.push(line);
      if (results.length >= maxResults) return results;
    }
  }
  return results;
}

interface WorkerScanRequest {
  files: readonly string[];
  dir: string;
  regex: RegExp;
  cwd: string;
  maxResults: number;
  deadline: Deadline;
  literals: string[] | undefined;
  byteFilter: ByteFilter | undefined;
}

/**
 * `scanFiles` on the worker pool: same results, same order, same early stop.
 *
 * Chunks are dispatched in candidate order and dispatch stops once enough
 * matches exist, exactly like `scanFiles`' per-file scheduling. A chunk may
 * also stop itself once it alone has found the matches still missing when it
 * was sent (`stopAfter`): everything collected at that moment came from
 * earlier files, so the first `maxResults` of the flattened output are already
 * settled by the files before its stopping point.
 *
 * Files a worker cannot read whole (large, symlinked, unreadable), and whole
 * chunks whose worker failed, are scanned on the main thread by the same
 * `searchFile` that `scanFiles` uses.
 */
async function scanWithWorkers(pool: GrepWorkerPool, req: WorkerScanRequest): Promise<string[]> {
  const { files, dir, regex, cwd, maxResults, deadline } = req;
  const slots: Array<string[] | undefined> = new Array(files.length);
  const chunkSize = Math.min(256, Math.max(16, Math.ceil(files.length / (pool.size * 8))));
  const options: ScanTextOptions = {
    source: regex.source,
    flags: regex.flags,
    prefilter: isExternallySupported(regex.source),
    maxResults,
    expiresAt: deadline.expiresAt,
    maxLineLength: MAX_LINE_LENGTH,
    checkInterval: DEADLINE_CHECK_INTERVAL,
    sniffLines: BINARY_SNIFF_LINES,
  };
  const onMainThread = async (index: number): Promise<void> => {
    const lines = await searchFile(
      path.join(dir, files[index] ?? ""),
      new RegExp(regex.source, regex.flags),
      cwd,
      maxResults,
      localOperations,
      deadline,
      req.byteFilter,
    );
    slots[index] = lines;
    collected += lines.length;
  };

  let next = 0;
  let collected = 0;
  const pending: Promise<void>[] = [];
  // Candidates are clean relative paths (no `.`/`..` segments), so joining
  // them onto precomputed prefixes equals path.join/path.relative per file at
  // a fraction of the cost.
  const toCwd = path.relative(cwd, dir);
  const displayPath = (rel: string): string => {
    if (toCwd !== "") return path.join(toCwd, rel);
    return path.sep === "/" ? rel : path.normalize(rel);
  };

  const lane = async (): Promise<void> => {
    for (;;) {
      if (collected >= maxResults || isExpired(deadline)) return;
      const start = next;
      if (start >= files.length) return;
      next = Math.min(files.length, start + chunkSize);
      const chunk = files
        .slice(start, next)
        .map((rel) => [path.join(dir, rel), displayPath(rel)] as const);

      let outcome: ScanJobResult;
      try {
        outcome = await pool.run({
          files: chunk,
          options,
          literals: req.literals,
          caseInsensitive: regex.flags.includes("i"),
          readLimit: WHOLE_READ_MAX_BYTES,
          stopAfter: maxResults - collected,
        });
      } catch {
        // The worker died: scan its chunk here rather than lose it.
        for (let index = start; index < next; index++) await onMainThread(index);
        continue;
      }

      if (outcome.expired) deadline.hit = true;
      outcome.results.forEach((lines, offset) => {
        const index = start + offset;
        if (lines === null) {
          pending.push(onMainThread(index));
          return;
        }
        slots[index] = lines;
        collected += lines.length;
      });
    }
  };

  await Promise.all(Array.from({ length: pool.size }, () => lane()));
  await Promise.all(pending);

  const results: string[] = [];
  for (const slot of slots) {
    if (!slot) continue;
    for (const line of slot) {
      results.push(line);
      if (results.length >= maxResults) return results;
    }
  }
  return results;
}

/**
 * Constructs the external scanner's regex engine cannot execute. It uses a
 * finite-automaton engine with linear-time guarantees, which is exactly why it
 * is fast — and exactly why lookaround and backreferences are missing. Those
 * patterns fall back to the in-process backtracking scanner, which is the
 * semantic reference for this tool.
 */
const EXTERNALLY_UNSUPPORTED = /\(\?=|\(\?!|\(\?</;
const BACKREFERENCE = /\\[1-9]/;

function isExternallySupported(pattern: string): boolean {
  return !EXTERNALLY_UNSUPPORTED.test(pattern) && !BACKREFERENCE.test(pattern);
}

/** Resolved once per process: probing costs a spawn, and the answer cannot change. */
let externalScannerProbe: Promise<string | undefined> | undefined;

export function detectExternalScanner(): Promise<string | undefined> {
  externalScannerProbe ??= new Promise<string | undefined>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // windowsHide: a bare spawn pops a console window on Windows. `grep` is
      // one of the most-called tools, so without it a search session strobes
      // the user's screen. No-op on other platforms.
      child = spawn("rg", ["--version"], { stdio: "ignore", windowsHide: true });
    } catch {
      resolve(undefined);
      return;
    }
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => resolve(code === 0 ? "rg" : undefined));
  });
  return externalScannerProbe;
}

/** Test seam: forget the cached probe result. */
export function resetExternalScannerProbe(): void {
  externalScannerProbe = undefined;
}

interface ExternalScanRequest {
  dir: string;
  cwd: string;
  pattern: string;
  include: string | undefined;
  caseInsensitive: boolean;
  maxResults: number;
  deadline: Deadline;
  deadlineMs: number;
}

/**
 * Run the external scanner and format its output exactly like the in-process
 * path: same relative paths, same line truncation, same path ordering.
 *
 * Returns `undefined` when the scanner could not complete, which makes the
 * caller retry in-process. Reporting "no matches" for a spawn failure would be
 * a silent recall loss — the failure mode this whole path exists to remove.
 */
async function runExternalScan(req: ExternalScanRequest): Promise<string[] | undefined> {
  const args = [
    "--no-config",
    "--line-number",
    "--no-heading",
    "--with-filename",
    "--color",
    "never",
    "--no-messages",
    "--hidden",
    // Apply exactly one ignore file — the scan root's .gitignore, wired in
    // below — and nothing else: no nested, parent, global, or non-VCS ignore
    // files. The in-process scanner is this tool's semantic reference and it
    // reads that one file; anything wider would make the two paths disagree
    // about which files exist.
    "--no-ignore",
    "--max-filesize",
    String(MAX_FILE_SIZE),
    "--max-count",
    String(req.maxResults),
    "--glob",
    "!**/.git/**",
    "--glob",
    "!**/node_modules/**",
  ];
  const rootIgnore = path.join(req.dir, ".gitignore");
  if (await fileExists(rootIgnore)) args.push("--ignore-file", rootIgnore);
  if (req.caseInsensitive) args.push("--ignore-case");
  if (req.include) args.push("--glob", req.include.replace(/\\/g, "/"));
  // Relative root on purpose — `formatExternalMatches` parses `path:line:text`
  // by first colon, which an absolute Windows path would break.
  args.push("--regexp", req.pattern, "--", ".");

  const remainingMs = Math.max(1, req.deadline.expiresAt - Date.now());
  const output = await new Promise<{ stdout: string; ok: boolean; timedOut: boolean } | undefined>(
    (resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("rg", args, { cwd: req.dir, windowsHide: true });
      } catch {
        resolve(undefined);
        return;
      }
      let stdout = "";
      let bytes = 0;
      let timedOut = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, remainingMs);
      const finish = (value: { stdout: string; ok: boolean; timedOut: boolean } | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      child.stdout?.setEncoding("utf-8");
      child.stdout?.on("data", (chunk: string) => {
        bytes += chunk.length;
        if (bytes > MAX_EXTERNAL_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          return;
        }
        stdout += chunk;
      });
      child.stderr?.resume();
      child.once("error", () => finish(undefined));
      // Exit 0 = matches, 1 = no matches. Anything else is a real failure.
      child.once("close", (code) => finish({ stdout, ok: code === 0 || code === 1, timedOut }));
    },
  );

  if (!output) return undefined;
  if (output.timedOut) req.deadline.hit = true;
  else if (!output.ok) return undefined;

  return formatExternalMatches(output.stdout, req);
}

/**
 * Parse `path:line:text` records into this tool's output shape. The scanner
 * emits paths relative to the scan root, so they are re-based onto the tool's
 * cwd and re-sorted into candidate order before truncation.
 */
function formatExternalMatches(stdout: string, req: ExternalScanRequest): string[] {
  const byPath = new Map<string, string[]>();
  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    // Splitting on the first colon is only safe because the scan is rooted at a
    // RELATIVE path (see the `.` argument above), so no Windows drive prefix
    // ("C:\") can appear here. Keep it that way: the guards below fail CLOSED,
    // so a misparsed line number drops the match silently — the exact
    // "silence looks like no results" failure this scanner exists to avoid.
    const firstSep = raw.indexOf(":");
    if (firstSep <= 0) continue;
    const secondSep = raw.indexOf(":", firstSep + 1);
    if (secondSep < 0) continue;
    const lineNum = raw.slice(firstSep + 1, secondSep);
    if (!/^\d+$/.test(lineNum)) continue;

    const scanRelative = raw.slice(0, firstSep).replace(/^\.[\\/]/, "");
    if (BINARY_EXTENSIONS.has(path.extname(scanRelative).toLowerCase())) continue;
    const text = raw.slice(secondSep + 1).replace(/\r$/, "");
    const relPath = path.relative(req.cwd, path.join(req.dir, scanRelative));
    const truncated = text.length > MAX_LINE_LENGTH ? sliceHead(text, MAX_LINE_LENGTH) + "…" : text;

    const key = scanRelative.replace(/\\/g, "/");
    const bucket = byPath.get(key);
    const formatted = `${relPath}:${lineNum}:${truncated}`;
    if (bucket) bucket.push(formatted);
    else byPath.set(key, [formatted]);
  }

  const results: string[] = [];
  for (const key of [...byPath.keys()].sort()) {
    for (const line of byPath.get(key)!) {
      results.push(line);
      if (results.length >= req.maxResults) return results;
    }
  }
  return results;
}

async function searchFile(
  filePath: string,
  regex: RegExp,
  cwd: string,
  maxResults: number,
  ops: ToolOperations,
  deadline: Deadline,
  byteFilter?: ByteFilter,
): Promise<string[]> {
  const results: string[] = [];
  const relPath = path.relative(cwd, filePath);

  // Fast path: most source files fit in memory. Anything it cannot read
  // (too large, a symlink the bounded reader refuses, an error) streams below.
  const small = await readSmallFile(filePath, ops);
  if (small !== undefined) {
    if (typeof small === "string") return searchText(small, relPath, regex, maxResults, deadline);
    // Decoding UTF-8 cost more than everything else combined on large trees,
    // and most files cannot match: check the raw bytes first.
    if (byteFilter && !byteFilter(small)) return results;
    return searchText(small.toString("utf-8"), relPath, regex, maxResults, deadline);
  }

  // Skip oversized files — readline buffers entire lines in memory, so a single-line
  // file (minified JS, data blobs) can exceed V8's max string length and crash.
  try {
    const fileStat = await ops.stat(filePath);
    if (fileStat.size > MAX_FILE_SIZE) return results;
  } catch {
    return results;
  }

  const stream = ops.createReadStream(filePath, "utf-8");
  try {
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    let lineNum = 0;
    try {
      for await (const line of rl) {
        lineNum++;
        if (lineNum % DEADLINE_CHECK_INTERVAL === 0 && isExpired(deadline)) break;

        // Bail out if line contains null bytes (binary file not caught by extension check)
        if (lineNum <= 5 && line.includes("\0")) {
          break;
        }

        // Reset lastIndex for global regex
        regex.lastIndex = 0;
        if (regex.test(line)) {
          // Truncate long lines to prevent massive output from binary/minified files
          const truncatedLine =
            line.length > MAX_LINE_LENGTH ? sliceHead(line, MAX_LINE_LENGTH) + "…" : line;
          results.push(`${relPath}:${lineNum}:${truncatedLine}`);
          if (results.length >= maxResults) {
            break;
          }
        }
      }
    } finally {
      rl.close();
    }
  } catch {
    // Skip unreadable files
  } finally {
    stream.destroy();
  }

  return results;
}

/**
 * Read a file of at most WHOLE_READ_MAX_BYTES in one call: raw bytes locally
 * (so the byte filter can run before decoding), text through remote
 * operations. `undefined` sends the caller to the streaming path, which
 * reproduces the old behaviour for every case this one declines.
 */
async function readSmallFile(
  filePath: string,
  ops: ToolOperations,
): Promise<Buffer | string | undefined> {
  try {
    if (ops === localOperations) return await readFileBounded(filePath, WHOLE_READ_MAX_BYTES);
    if ((await ops.stat(filePath)).size > WHOLE_READ_MAX_BYTES) return undefined;
    return await ops.readFile(filePath);
  } catch {
    return undefined;
  }
}

/**
 * For each top-level alternative, the longest run of literal characters every
 * match of that alternative contains. `undefined` when any alternative has no
 * such run, since that alternative could match a file containing none of them.
 * Deliberately conservative: groups, classes, escapes of letters/digits and
 * anything non-ASCII end a run instead of being reasoned about.
 */
export function requiredLiterals(pattern: string): string[] | undefined {
  const literals: string[] = [];
  for (const branch of splitTopLevelAlternatives(pattern)) {
    const literal = longestRequiredRun(branch);
    if (!literal) return undefined;
    literals.push(literal);
  }
  return literals.length > 0 ? literals : undefined;
}

function splitTopLevelAlternatives(pattern: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
    } else if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    } else if (ch === "|" && depth === 0) {
      branches.push(pattern.slice(start, i));
      start = i + 1;
    }
  }
  branches.push(pattern.slice(start));
  return branches;
}

/** Characters that stand for themselves when they appear unescaped. */
const PLAIN_LITERAL = /^[\x20-\x7e]$/;
const REGEX_SYNTAX = new Set([
  ".",
  "^",
  "$",
  "*",
  "+",
  "?",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "|",
  "\\",
]);

function longestRequiredRun(branch: string): string | undefined {
  let best = "";
  let run = "";
  const endRun = (): void => {
    if (run.length > best.length) best = run;
    run = "";
  };

  let i = 0;
  while (i < branch.length) {
    // Parse one atom: a literal character, or something opaque.
    let literal: string | undefined;
    const ch = branch[i] ?? "";
    if (ch === "\\") {
      const next = branch[i + 1];
      // `\.` is a literal dot; `\d`, `\b`, `\1`, `\u…` are not literals.
      if (next !== undefined && PLAIN_LITERAL.test(next) && !/[A-Za-z0-9]/.test(next)) {
        literal = next;
      }
      i += 2;
    } else if (ch === "[" || ch === "(") {
      i = skipBracketed(branch, i);
    } else {
      if (PLAIN_LITERAL.test(ch) && !REGEX_SYNTAX.has(ch)) literal = ch;
      i++;
    }

    // A quantifier on the atom: `?`, `*` and `{0,…}` make it optional.
    const quantifier = /^(?:[*+?]|\{(\d+)(?:,\d*)?\})\??/.exec(branch.slice(i));
    if (quantifier) {
      i += quantifier[0].length;
      const minimum = quantifier[0].startsWith("+") ? 1 : Number(quantifier[1] ?? 0);
      if (literal !== undefined && minimum >= 1) run += literal;
      endRun();
    } else if (literal !== undefined) {
      run += literal;
    } else {
      endRun();
    }
  }
  endRun();
  return best || undefined;
}

/** Index just past the class or group opening at `start`. */
function skipBracketed(text: string, start: number): number {
  let depth = 0;
  let inClass = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
    } else if (inClass) {
      if (ch === "]") {
        inClass = false;
        if (depth === 0) return i + 1;
      }
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** Search in-memory file text on the main thread (see `scanText`). */
function searchText(
  text: string,
  relPath: string,
  regex: RegExp,
  maxResults: number,
  deadline: Deadline,
): string[] {
  const scanned = scanText(text, relPath, {
    source: regex.source,
    flags: regex.flags,
    // Lookaround can see past a line end and flip, so it skips the prefilter.
    prefilter: isExternallySupported(regex.source),
    maxResults,
    expiresAt: deadline.expiresAt,
    maxLineLength: MAX_LINE_LENGTH,
    checkInterval: DEADLINE_CHECK_INTERVAL,
    sniffLines: BINARY_SNIFF_LINES,
  });
  if (scanned.expired) deadline.hit = true;
  return scanned.lines;
}

function deadlineNotice(deadlineMs: number): string {
  return `[Stopped after ${deadlineMs / 1000}s — narrow the pattern or pass a narrower path/include]`;
}

/**
 * Render `path:line:text` records ripgrep `--heading` style: each file's path
 * once, then its `line:text` rows, files separated by a blank line.
 *
 * Every grep result stays in the conversation and is re-read on each later
 * request. Repeating the path on every row was ~23% of grep output on a real
 * repo (bench/prompt-diet opt-repo1: 739k → 566k chars over 92 calls), so the
 * heading form carries the same facts for fewer tokens. Records arrive grouped
 * already (each scan path walks file by file); a path that reappears later
 * simply gets another heading. The path is split at the first `:<digits>:` —
 * relative paths have no such run, and a Windows drive prefix (`D:\`) does
 * not match it.
 */
export function groupByFile(results: readonly string[]): string {
  const out: string[] = [];
  let current: string | undefined;
  for (const record of results) {
    const m = /^(.*?):(\d+):/.exec(record);
    if (!m) {
      current = undefined;
      out.push(record);
      continue;
    }
    const file = m[1]!;
    if (file !== current) {
      if (out.length > 0) out.push("");
      out.push(file);
      current = file;
    }
    out.push(record.slice(file.length + 1));
  }
  return out.join("\n");
}

function formatResults(
  results: string[],
  maxResults: number,
  candidateLimitHit = false,
  deadlineHit = false,
  deadlineMs = GREP_DEADLINE_MS,
): string {
  if (results.length === 0) {
    let empty = "No matches found.";
    if (candidateLimitHit) {
      empty += ` [Stopped after scanning ${MAX_CANDIDATE_FILES} candidate files]`;
    }
    if (deadlineHit) empty += ` ${deadlineNotice(deadlineMs)}`;
    return empty;
  }

  let output = groupByFile(results);
  if (results.length >= maxResults) {
    output += `\n\n[Truncated at ${maxResults} matches]`;
  } else {
    output += `\n\n${results.length} match(es) found`;
  }
  if (candidateLimitHit) {
    output += `\n[Stopped after scanning ${MAX_CANDIDATE_FILES} candidate files]`;
  }
  if (deadlineHit) {
    output += `\n${deadlineNotice(deadlineMs)}`;
  }
  return output;
}
