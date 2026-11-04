export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024; // 50KB

/** @deprecated Use MAX_BYTES instead. Kept for backwards compatibility with tests. */
export const MAX_CHARS = MAX_BYTES;

export interface TruncateResult {
  content: string;
  truncated: boolean;
  totalLines: number;
  keptLines: number;
}

/**
 * Truncate from the end — keep the first N lines.
 * Used by the read tool.
 */
export function truncateHead(
  content: string,
  maxLines = MAX_LINES,
  maxBytes = MAX_BYTES,
): TruncateResult {
  const lines = content.split("\n");
  const totalLines = lines.length;

  // Limit by line count
  let kept = lines.slice(0, maxLines);

  // Limit by byte count
  let size = 0;
  let cutIndex = kept.length;
  for (let i = 0; i < kept.length; i++) {
    size += Buffer.byteLength(kept[i], "utf-8") + 1; // +1 for newline
    if (size > maxBytes) {
      cutIndex = i;
      break;
    }
  }
  kept = kept.slice(0, cutIndex);

  const truncated = kept.length < totalLines;
  return {
    content: kept.join("\n"),
    truncated,
    totalLines,
    keptLines: kept.length,
  };
}

/**
 * Truncate from the beginning — keep the last N lines.
 * Used by the bash tool.
 */
export function truncateTail(
  content: string,
  maxLines = MAX_LINES,
  maxBytes = MAX_BYTES,
): TruncateResult {
  const lines = content.split("\n");
  const totalLines = lines.length;

  // Limit by line count — keep last N
  let kept = lines.slice(-maxLines);

  // Limit by byte count — keep last N bytes
  let size = 0;
  let cutIndex = 0;
  for (let i = kept.length - 1; i >= 0; i--) {
    size += Buffer.byteLength(kept[i], "utf-8") + 1;
    if (size > maxBytes) {
      cutIndex = i + 1;
      break;
    }
  }
  kept = kept.slice(cutIndex);

  const truncated = kept.length < totalLines;
  return {
    content: kept.join("\n"),
    truncated,
    totalLines,
    keptLines: kept.length,
  };
}

/* ----------------------------------------------------------------------- */
/* "What was cut" descriptor for truncation notes                            */
/* ----------------------------------------------------------------------- */

/** Hard cap on the descriptor appended to a truncation note. */
export const OMITTED_NOTE_MAX_CHARS = 300;

const SAMPLE_MAX_CHARS = 80;
const MAX_SAMPLES = 3;
const MAX_LABELS = 3;
const MAX_FILES = 3;

/** Cheap gate: a line that can't contain any of these is never error/warn-shaped. */
const DIAG_PREFILTER =
  /err|fail|fatal|panic|exception|traceback|crit|warn|caused by|not ok|[✗✖❌×]/i;

// Optional leading timestamp / [bracketed] prefix before an UPPERCASE log level.
const LOG_PREFIX = String.raw`^\W{0,4}(?:[\d\-/:.,TZ+]+\s+|\[[^\]]{1,40}\]\s*)*`;
const LEVEL_END = String.raw`(?=[\s:\]!|]|$)(?!\s*[=,;)])`;

/**
 * Shape-based (not keyword-based) error-line detectors, so source code being
 * paged through by `read` (`throw new Error(...)`, `console.error(...)`) does
 * not count — only lines that look like a diagnostic / log record.
 */
const ERROR_LINE: RegExp[] = [
  new RegExp(`${LOG_PREFIX}(?:ERROR|ERR!|FATAL|CRITICAL|PANIC|FAIL(?:ED|URE)?)${LEVEL_END}`),
  /^(?:error|fatal)(?:\[[\w-]+\])?:\s/i, // rustc/cargo/git/CLI `error: …` (column 0)
  /^npm ERR!/,
  /\.\w{1,6}(?::\d+){1,2}:?\s*(?:fatal\s+)?error\b/i, // gcc/clang `f.c:1:2: error:`
  /\(\d+,\d+\):\s*error\b/, // tsc `f.ts(1,2): error TS…`
  /^\s*\d+:\d+\s+error\s/, // eslint stylish
  /^\s*(?:E\s+)?(?:Uncaught\s+)?[A-Z][\w.$]*(?:Error|Exception)(?:\s*\[[\w-]+\])?:(?:\s|$)/,
  /^Traceback \(most recent call last\)/,
  /^\s*(?:✗|✖|❌|not ok\b|--- FAIL\b)/,
  /^thread '.*' panicked|^panic:/,
  /^\s*Caused by:/,
  /\blevel[=:]\s*"?(?:error|fatal)\b/i,
];

const WARN_LINE: RegExp[] = [
  new RegExp(`${LOG_PREFIX}(?:WARN(?:ING)?)${LEVEL_END}`),
  /^warn(?:ing)?(?:\[[\w-]+\])?:\s/i,
  /^npm WARN\b/,
  /\.\w{1,6}(?::\d+){1,2}:?\s*warning\b/i,
  /\(\d+,\d+\):\s*warning\b/,
  /^\s*\d+:\d+\s+warning\s/,
  /^\s*[A-Z]\w*Warning:\s/,
  /\blevel[=:]\s*"?warn(?:ing)?\b/i,
];

/** Error codes / exception names (headroom #3635's "exception types"). */
const LABEL_RES: RegExp[] = [
  /\berror\[([A-Z]?\d{3,5})\]/, // rustc E0425
  /\berror\s+(TS\d{3,5})\b/, // tsc TS2345
  /^\s*(?:E\s+)?(?:Uncaught\s+)?(?:[\w$]+\.)*([A-Z][\w$]*(?:Error|Exception|Warning))\b(?:\s*\[[\w-]+\])?:/,
  /\b(E(?:NOENT|ACCES|PERM|ADDRINUSE|CONNREFUSED|CONNRESET|TIMEDOUT|EXIST|ISDIR|NOTDIR|NOTEMPTY|MFILE|PIPE|NOTFOUND|HOSTUNREACH)|ERR_[A-Z0-9_]{3,})\b/,
];

const SRC_EXT =
  "ts|tsx|js|jsx|mjs|cjs|mts|cts|py|rs|go|java|kt|kts|rb|php|c|h|cc|cpp|cxx|hpp|cs|swift|m|mm|scala|ex|exs|erl|hs|ml|lua|sh|vue|svelte|json|ya?ml|toml|css|scss|less|html|sql|proto|zig|dart";
/** A source path followed by a line location: `a/b.ts:12`, `b.ts(3,4)`. */
const FILE_LOC = new RegExp(
  String.raw`(?:^|[\s(\["'\`])((?:[\w.@~+-]*/)*[\w@+-][\w.@+-]*\.(?:${SRC_EXT}))(?::\d+|\(\d+,\d+\))`,
);
const PY_FILE = /File "([^"]+)", line \d+/;
const RUST_FILE = /-->\s*([^\s:]+):\d+/;
/** Lines whose file references are diagnostic (stack frames, locations). */
const FRAME_LINE = new RegExp(
  String.raw`^\s*(?:at\s|File "|-->|from\s)|^\S+\.(?:${SRC_EXT})(?::\d+|\(\d+,\d+\))`,
);

/** Object-literal / call-argument continuation lines in source code. */
const CODE_TAIL = /[,{([]\s*$/;

function isError(line: string): boolean {
  return (
    DIAG_PREFILTER.test(line) && !CODE_TAIL.test(line) && ERROR_LINE.some((re) => re.test(line))
  );
}

function isWarning(line: string): boolean {
  return (
    DIAG_PREFILTER.test(line) && !CODE_TAIL.test(line) && WARN_LINE.some((re) => re.test(line))
  );
}

function extractFile(line: string): string | undefined {
  return (PY_FILE.exec(line) ?? RUST_FILE.exec(line) ?? FILE_LOC.exec(line))?.[1];
}

function shorten(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Last two path segments — enough to identify a file without eating the cap. */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? parts.join("/") : `…/${parts.slice(-2).join("/")}`;
}

function listWithMore(items: string[], max: number): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown}, +${items.length - max}` : shown;
}

/**
 * Describe WHAT a truncation dropped, so the agent can decide whether to fetch
 * the rest (modelled on headroomlabs-ai/headroom PR #3635's CCR descriptor):
 * error/warning line counts, distinct error codes / exception names, distinct
 * source files referenced by diagnostics/stack frames, and the first few
 * distinct error lines. Labels, files and sample lines already visible in
 * `shown` are left out — the note justifies retrieval, it doesn't restate.
 *
 * Returns `""` when nothing notable was cut (the note stays byte-identical),
 * otherwise `"Omitted part: …."`, never longer than OMITTED_NOTE_MAX_CHARS.
 * Deterministic: first-appearance order, no hashing or randomness.
 */
export function describeOmitted(omitted: readonly string[], shown: string): string {
  let errors = 0;
  let warnings = 0;
  const labels = new Set<string>();
  const files = new Set<string>();
  const samples: string[] = [];
  const sampleKeys = new Set<string>();
  // Everything already tested against `shown` (hit or miss) — each distinct
  // candidate costs one substring scan, however often it repeats.
  const checked = new Set<string>();
  const isNew = (s: string): boolean => {
    if (checked.has(s)) return false;
    checked.add(s);
    return !shown.includes(s);
  };

  for (const line of omitted) {
    const err = isError(line);
    const warn = !err && isWarning(line);
    if (err) errors++;
    else if (warn) warnings++;
    if (err || warn) {
      for (const re of LABEL_RES) {
        const label = re.exec(line)?.[1];
        if (label && isNew(label)) labels.add(label);
      }
    }
    if (err || warn || FRAME_LINE.test(line)) {
      const file = extractFile(line);
      if (file && isNew(file)) files.add(file);
    }
    if (err && samples.length < MAX_SAMPLES) {
      const text = line.trim().replace(/\s+/g, " ");
      // Distinct modulo numbers, so a retry loop doesn't fill every slot.
      const key = text.replace(/\d+/g, "#");
      if (text && !sampleKeys.has(key) && isNew(line.trim())) {
        sampleKeys.add(key);
        samples.push(text);
      }
    }
  }

  if (errors === 0 && warnings === 0 && files.size === 0) return "";

  const parts: string[] = [];
  if (errors || warnings) {
    const plural = (n: number, what: string) => `${n} ${what} line${n === 1 ? "" : "s"}`;
    const counts = [errors && plural(errors, "error"), warnings && plural(warnings, "warning")]
      .filter(Boolean)
      .join(", ");
    const labelList = labels.size ? ` (${listWithMore([...labels], MAX_LABELS)})` : "";
    parts.push(`${counts}${labelList}`);
  }
  if (files.size) {
    const names = [...files].map(shortPath);
    parts.push(
      `${files.size} file${files.size === 1 ? "" : "s"}: ${listWithMore(names, MAX_FILES)}`,
    );
  }
  const head = `Omitted part: ${parts.join("; ")}`;
  let note = `${head}.`;
  // Add sample error lines while they fit under the hard cap.
  const quoted: string[] = [];
  for (const s of samples) {
    const next = [...quoted, `"${shorten(s, SAMPLE_MAX_CHARS)}"`];
    const candidate = `${head}; first: ${next.join(" | ")}.`;
    if (candidate.length > OMITTED_NOTE_MAX_CHARS) break;
    quoted.push(next[next.length - 1]);
    note = candidate;
  }
  return shorten(note, OMITTED_NOTE_MAX_CHARS);
}

/** Timestamps / hex addresses vary across "similar" repeats — ignore them. */
function looseKey(line: string): string {
  return line
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "")
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "")
    .replace(/0x[0-9a-f]+/gi, "")
    .trim();
}

/**
 * `describeOmitted` for a non-positional cut (content-aware compression):
 * the omitted lines are the original lines with no counterpart in `shown`.
 * Repeats collapsed to `line  (×N)` / `(×N similar)` count as shown.
 */
export function describeCompressed(original: string, shown: string): string {
  const shownKeys = new Set<string>();
  for (const l of shown.split("\n")) {
    shownKeys.add(looseKey(l.replace(/ {2}\(×\d+(?: similar)?\)$/, "")));
  }
  const omitted = original.split("\n").filter((l) => !shownKeys.has(looseKey(l)));
  return describeOmitted(omitted, shown);
}
