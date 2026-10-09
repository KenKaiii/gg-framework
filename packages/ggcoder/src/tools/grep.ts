import readline from "node:readline";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { sliceHead } from "@kenkaiiii/gg-ai";
import { resolvePath } from "./path-utils.js";
import { BINARY_EXTENSIONS } from "./read.js";
import { localOperations, type ToolOperations } from "./operations.js";

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
const MAX_CANDIDATE_FILES = 10_000;
/** Wall-clock budget for a single grep call — catastrophic backtracking is count-bounded but not time-bounded */
const GREP_DEADLINE_MS = 5_000;
/**
 * Files scanned concurrently on the in-process path. A grep call is almost
 * entirely I/O wait, so scanning one file at a time turned "slow" into
 * "incomplete": the wall-clock budget expired mid-directory and the model saw a
 * partial answer as if it were the whole one.
 */
const SCAN_CONCURRENCY = 12;
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
}

export function createGrepTool(
  cwd: string,
  ops: ToolOperations = localOperations,
  options: GrepToolOptions = {},
): AgentTool<typeof GrepParams> {
  const deadlineMs = options.deadlineMs ?? GREP_DEADLINE_MS;
  // The external scanner reads the real filesystem, so it is only valid when
  // this tool is also pointed at the real filesystem. Remote operations
  // (SSH/Docker) must stay on the in-process path.
  const externalAllowed = ops === localOperations;
  return {
    name: "grep",
    description:
      "Regex search of file contents → path:line:text. Skips .gitignored and binary files.",
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

      // Check if dir is a file
      const stat = await ops.stat(dir);
      if (stat.isFile()) {
        const results = await searchFile(dir, regex, cwd, maxResults, ops, deadline);
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
      const results = await scanFiles(files, dir, regex, cwd, maxResults, ops, deadline);
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
  const ignoreModule = await import("ignore");
  const ig = ignoreModule.default();
  ig.add(await loadIgnorePatterns(dir));

  const globPattern = normalizeIncludeGlob(include);
  const entries = await fg.default(globPattern, {
    cwd: dir,
    dot: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/.git/**"],
    suppressErrors: true,
    followSymbolicLinks: false,
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
  const sortedByPath = [...byPath.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [, lines] of sortedByPath) {
    for (const line of lines) {
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
): Promise<string[]> {
  const results: string[] = [];
  const relPath = path.relative(cwd, filePath);

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

function deadlineNotice(deadlineMs: number): string {
  return `[Stopped after ${deadlineMs / 1000}s — narrow the pattern or pass a narrower path/include]`;
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

  let output = results.join("\n");
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
