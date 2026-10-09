import fs from "node:fs/promises";
import path from "node:path";
import { runBackgroundGit } from "../utils/git.js";

// Raw, local signals behind the app's Project Health score. Read-only and
// bounded: files come from `git ls-files` (so ignored output never counts), no
// symlink is followed, and no project code or config is executed.

/** Source files longer than this count as oversized. */
export const OVERSIZED_LINES = 800;
/** Files bigger than this (outside Git LFS) count as large committed files. */
export const LARGE_FILE_BYTES = 5 * 1024 * 1024;
/** How far back Git history counts toward a file's change count. */
export const HOTSPOT_DAYS = 90;
/** Fewest changes within {@link HOTSPOT_DAYS} that can make an oversized file a hotspot. */
export const HOTSPOT_CHANGES = 5;
/**
 * A hotspot is among the repo's most-changed files (this share of all files
 * changed in the period), so "changing often" means the same thing in a quiet
 * repo and a busy one.
 */
export const HOTSPOT_TOP_SHARE = 0.02;
const MAX_HISTORY_COMMITS = 5_000;

/** Changes that make a file a hotspot, given every changed file's change count. */
export function hotspotThreshold(changeCounts: Iterable<number>): number {
  const sorted = [...changeCounts].sort((a, b) => b - a);
  const cutoff = sorted[Math.floor(sorted.length * HOTSPOT_TOP_SHARE)] ?? 0;
  return Math.max(HOTSPOT_CHANGES, cutoff);
}

/**
 * How much an oversized file's excess lines count: a big file that keeps
 * changing is where bugs come from; a big file nobody touches costs little.
 * null (no usable history) counts as ordinary.
 */
export function churnWeight(changes: number | null, threshold = HOTSPOT_CHANGES): number {
  if (changes === null) return 1;
  if (changes === 0) return 0.5;
  return changes >= threshold ? 2 : 1;
}

const MAX_LISTED = 50_000;
const MAX_SOURCE_FILES = 8_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const READ_CONCURRENCY = 16;
const KEPT_OFFENDERS = 20;
const TYPED_LANGUAGE_SHARE = 0.2;
const GIT_TIMEOUT_MS = 30_000;

export interface HealthFileLines {
  readonly path: string;
  readonly lines: number;
  /** Commits touching it in the last {@link HOTSPOT_DAYS} days; null without history. */
  readonly changes: number | null;
}
export interface HealthFileBytes {
  readonly path: string;
  readonly bytes: number;
}
export interface HealthSecretFile {
  readonly path: string;
  /** Committed (true) or merely not covered by .gitignore (false). */
  readonly tracked: boolean;
  /**
   * The kind of key found inside the file (e.g. "GitHub token"); null when the
   * file name alone marks it (`.env`, `id_rsa`). The value itself is never kept.
   */
  readonly found: string | null;
  /** 1-based line of the key; null for name-only matches. */
  readonly line: number | null;
}
export interface HealthDebt {
  readonly todos: number;
  readonly suppressions: number;
  readonly anyTypes: number;
  /** Non-test, non-generated source lines the markers were counted over. */
  readonly lines: number;
}

export interface ProjectHealthScan {
  /** The file list hit the scan bound; the score covers part of the project. */
  readonly truncated: boolean;
  /** App source only: tests and check scripts are left out of size. */
  readonly sourceFiles: number;
  readonly sourceLines: number;
  /** Riskiest first (excess lines × {@link churnWeight}), at most {@link KEPT_OFFENDERS}. */
  readonly oversized: readonly HealthFileLines[];
  readonly oversizedCount: number;
  /** Oversized files changed often recently ({@link hotspotThreshold}). */
  readonly hotspotCount: number;
  /** Lines beyond {@link OVERSIZED_LINES}, each file's weighted by {@link churnWeight}. */
  readonly oversizedWeightedExcess: number;
  readonly secretFiles: readonly HealthSecretFile[];
  /** Largest first, at most {@link KEPT_OFFENDERS}. */
  readonly largeFiles: readonly HealthFileBytes[];
  readonly largeFileCount: number;
  readonly hasGitignore: boolean;
  readonly missingLockfile: boolean;
  readonly hasTests: boolean;
  readonly hasLint: boolean;
  readonly hasFormat: boolean;
  /** null when no language here needs a separate type checker. */
  readonly hasTypecheck: boolean | null;
  readonly hasCIWorkflow: boolean;
  readonly debt: HealthDebt;
}

export interface ProjectHealthScanner {
  /** null when `cwd` is not inside a Git work tree (or the listing failed). */
  scan(cwd: string, now: Date, signal?: AbortSignal): Promise<ProjectHealthScan | null>;
}

// prettier-ignore
const SOURCE_EXTENSIONS = new Set([
  "astro", "bash", "c", "cc", "cjs", "clj", "cpp", "cs", "css", "cts", "dart", "ex", "exs",
  "go", "h", "hpp", "html", "java", "jl", "js", "jsx", "kt", "kts", "less", "lua", "m", "mjs",
  "mm", "mts", "php", "py", "r", "rb", "rs", "sass", "scala", "scss", "sh", "sql", "svelte",
  "swift", "ts", "tsx", "vue", "zig", "zsh",
]);
const TS_EXTENSIONS = new Set(["ts", "tsx", "mts", "cts"]);
const JS_FAMILY = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]);
// prettier-ignore
const GENERATED_DIRS = new Set([
  ".next", ".nuxt", ".venv", "Pods", "__fixtures__", "__generated__", "__snapshots__", "build",
  "coverage", "dist", "fixtures", "generated", "node_modules", "out", "target", "testdata",
  "third-party", "third_party", "vendor", "venv",
]);
const GENERATED_NAME =
  /\.min\.[a-z]+$|\.bundle\.js$|\.generated\.|\.d\.[cm]?ts$|\.pb\.go$|_pb2\.py$|\.g\.dart$|\.freezed\.dart$/;
const TEST_DIR = /(?:^|\/)(?:__tests__|tests?|spec|e2e|cypress|playwright)\//;
// Script-style suites: `scripts/check-auth.mjs`, `tools/smoke.ts`, run from a
// package script or CI rather than a test runner.
const CHECK_SCRIPT =
  /(?:^|\/)(?:scripts|tools)\/(?:.+\/)?(?:check|smoke|e2e|verify)(?:[-_.][^/]*)?$/;
/** npm's placeholder for a project without tests. */
const NO_TEST_PLACEHOLDER = /no test specified/;
const TEST_NAME =
  /\.(?:test|spec)\.[^.]+$|^test_.+\.py$|_test\.(?:go|py|rb|exs?)$|Tests?\.(?:java|kt|cs|swift)$/;
const SECRET_KEY_NAME = /\.(?:pem|key|p12|pfx|jks|keystore)$|^id_(?:rsa|dsa|ecdsa|ed25519)$/i;
const ENV_FILE = /^\.env(?:\..+)?$/;
const ENV_EXAMPLE = /\.(?:example|sample|template|dist|defaults?)$/i;
const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
];
const CI_FILE =
  /^(?:\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|Jenkinsfile|bitbucket-pipelines\.yml|\.buildkite\/pipeline\.ya?ml|\.travis\.yml)$/;
const LINT_CONFIG =
  /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.(?:c?js|json|ya?ml))?|biome\.jsonc?|\.oxlintrc\.json|\.golangci\.(?:ya?ml|toml|json)|\.?ruff\.toml|\.flake8|\.?pylintrc|\.?clippy\.toml|\.rubocop\.yml|\.swiftlint\.yml|detekt\.yml|\.credo\.exs|deno\.jsonc?|analysis_options\.yaml|\.stylelintrc(?:\.\w+)?)$/;
const FORMAT_CONFIG =
  /^(?:\.prettierrc(?:\.\w+)?|prettier\.config\.[cm]?[jt]s|biome\.jsonc?|\.?rustfmt\.toml|\.clang-format|\.swift-format|\.swiftformat|\.?dprint\.json|deno\.jsonc?|\.?ruff\.toml|\.scalafmt\.conf|\.php-cs-fixer(?:\.dist)?\.php)$/;
/** Toolchains that ship their own linter and formatter. */
const BUILTIN_TOOLCHAIN = new Set(["go.mod", "Cargo.toml", "pubspec.yaml"]);
const TS_CONFIG = /^(?:tsconfig(?:\.[\w-]+)?\.json|jsconfig\.json)$/;
const PY_TYPE_CONFIG = new Set(["mypy.ini", ".mypy.ini", "pyrightconfig.json"]);

/**
 * Keys with an unmistakable shape, so a match is almost never a false alarm.
 * Deliberately narrow: no "long random string" heuristics, and no Google API
 * keys (Firebase web keys are public by design).
 */
const SECRET_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  {
    label: "private key",
    // The header plus a key body, so code that merely names the header is fine.
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----(?:\\n|\s)+[A-Za-z0-9+/]{40,}/,
  },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    label: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b/,
  },
  { label: "Anthropic API key", pattern: /\bsk-ant-[a-z]+\d*-[A-Za-z0-9_-]{60,}/ },
  {
    label: "OpenAI API key",
    pattern:
      /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/,
  },
  { label: "OpenRouter API key", pattern: /\bsk-or-v1-[a-f0-9]{64}\b/ },
  { label: "Stripe live key", pattern: /\b[rs]k_live_[0-9A-Za-z]{24,}\b/ },
  { label: "Slack token", pattern: /\bxox[abprs]-[0-9]{10,13}-[0-9A-Za-z-]{10,}/ },
  {
    label: "Slack webhook",
    pattern: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{24}/,
  },
  { label: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
];
/** Docs-style stand-ins: AKIAIOSFODNN7EXAMPLE, sk-proj-your-key… */
const PLACEHOLDER_WORD = /example|placeholder|dummy|redacted|sample|your/i;
/** Filler like ghp_xxxx… or sk_live_0000…. Not for key bodies: real base64 has runs of A. */
const FILLER = /x{6,}|(.)\1{9,}/i;
/** Config files read only to look for keys (they don't count toward size or debt). */
const CONFIG_EXTENSIONS = new Set([
  "cfg",
  "conf",
  "ini",
  "json",
  "jsonc",
  "plist",
  "properties",
  "tf",
  "tfvars",
  "toml",
  "xml",
  "yaml",
  "yml",
]);
const CONFIG_NAMES = new Set([".npmrc", ".pypirc", ".netrc", ".dockercfg", "Dockerfile"]);
const MAX_CONFIG_FILES = 2_000;
const MAX_CONFIG_BYTES = 512 * 1024;

/**
 * The first real-looking key in `text`: its kind and 1-based line, never the
 * value. Exported for tests.
 */
export function findSecret(text: string): { label: string; line: number } | null {
  let best: { label: string; index: number } | null = null;
  for (const { label, pattern } of SECRET_PATTERNS) {
    const global = new RegExp(pattern.source, "g");
    for (const match of text.matchAll(global)) {
      if (PLACEHOLDER_WORD.test(match[0])) continue;
      if (label !== "private key" && FILLER.test(match[0])) continue;
      if (!best || match.index < best.index) best = { label, index: match.index };
      break;
    }
  }
  if (!best) return null;
  return { label: best.label, line: lineCount(text.slice(0, best.index + 1)) };
}

const TODO_MARKER = /\b(?:TODO|FIXME|HACK)\b/g;
const SUPPRESSION =
  /@ts-ignore|@ts-nocheck|eslint-disable|biome-ignore|#\s*type:\s*ignore|#\s*noqa|#\[allow\(|\/\/\s*nolint|@SuppressWarnings/g;
const ANY_TYPE = /:\s*any\b|\bas\s+any\b|<any>|\bany\[\]/g;
const GENERATED_HEADER = /@generated|DO NOT EDIT/;

function basename(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}
function extension(rel: string): string {
  const name = basename(rel);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
function isGeneratedPath(rel: string): boolean {
  const parts = rel.split("/");
  parts.pop();
  return parts.some((part) => GENERATED_DIRS.has(part)) || GENERATED_NAME.test(basename(rel));
}
/** Exported for tests. */
export function isTestPath(rel: string): boolean {
  return TEST_DIR.test(rel) || TEST_NAME.test(basename(rel)) || CHECK_SCRIPT.test(rel);
}

/** A package.json `test` script that runs something (not npm's placeholder). */
function hasTestScript(manifests: readonly string[]): boolean {
  for (const manifest of manifests) {
    if (!manifest) continue;
    try {
      const parsed: unknown = JSON.parse(manifest);
      if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) continue;
      const scripts = parsed.scripts;
      if (typeof scripts !== "object" || scripts === null || !("test" in scripts)) continue;
      const test = scripts.test;
      if (typeof test === "string" && test.trim() && !NO_TEST_PLACEHOLDER.test(test)) return true;
    } catch {
      // Unreadable or partial manifest: no signal.
    }
  }
  return false;
}
/** Exported for tests. */
export function isSecretPath(rel: string): boolean {
  const name = basename(rel);
  if (ENV_FILE.test(name)) return !ENV_EXAMPLE.test(name);
  // TLS test suites commit throwaway keys on purpose.
  return SECRET_KEY_NAME.test(name) && !isTestPath(rel) && !isGeneratedPath(rel);
}
function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}
function lineCount(text: string): number {
  if (text.length === 0) return 0;
  let lines = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
  return text.endsWith("\n") ? lines : lines + 1;
}

// `<` is left out: in TSX it is far more often `</tag>` than a comparison.
const REGEX_CAN_START = new Set("(,=:[!&|?{};+-*%>~^".split(""));

/**
 * Splits JS/TS source into code (with string, regex and comment contents
 * blanked) and the comment text. A small lexer, not a parser: template
 * `${}` nesting and regex literals are handled; an unterminated quote ends at
 * the line break (JSX text like `Don't` stays contained). Exported for tests.
 */
export function splitJsSource(text: string): { code: string; comments: string } {
  let code = "";
  const comments: string[] = [];
  // Brace depth per open template expression; empty when not inside `${}`.
  const templates: number[] = [];
  let lastSignificant = "";
  // Finds the next character that can open a string, comment, regex or brace.
  // Sticky state (lastIndex), so one per call.
  const plainRun = /[/'"`{}]/g;
  let i = 0;
  const n = text.length;
  const blank = (from: number, to: number): string => text.slice(from, to).replace(/[^\n]/g, " ");

  const readTemplate = (start: number): number => {
    // From just after a backtick (or a closing `}` of an expression).
    let j = start;
    while (j < n) {
      const c = text[j];
      if (c === "\\") j += 2;
      else if (c === "`") return j + 1;
      else if (c === "$" && text[j + 1] === "{") {
        templates.push(0);
        return j + 2;
      } else j++;
    }
    return n;
  };

  while (i < n) {
    const c = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      comments.push(text.slice(i, stop));
      code += blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      comments.push(text.slice(i, stop));
      code += blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      const stop = Math.min(n, text[j] === c ? j + 1 : j);
      code += blank(i, stop);
      lastSignificant = c;
      i = stop;
    } else if (c === "`") {
      const stop = readTemplate(i + 1);
      code += blank(i, stop);
      lastSignificant = "`";
      i = stop;
    } else if (c === "/" && (lastSignificant === "" || REGEX_CAN_START.has(lastSignificant))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== "\n") {
        const r = text[j];
        if (r === "\\") j++;
        else if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        j++;
      }
      const stop = text[j] === "/" ? j + 1 : i + 1;
      code += blank(i, stop);
      lastSignificant = "/x";
      i = stop;
    } else {
      if (templates.length > 0) {
        const depth = templates.length - 1;
        if (c === "{") templates[depth] = (templates[depth] ?? 0) + 1;
        else if (c === "}") {
          if ((templates[depth] ?? 0) === 0) {
            templates.pop();
            const stop = readTemplate(i + 1);
            code += blank(i, stop);
            lastSignificant = "`";
            i = stop;
            continue;
          }
          templates[depth] = (templates[depth] ?? 0) - 1;
        }
      }
      if (c === "{" || c === "}") {
        code += c;
        lastSignificant = c;
        i++;
        continue;
      }
      // Plain code: copy the whole run up to the next character that can
      // start a string, comment, regex or template brace in one slice. A
      // per-character loop made a 2 MB file stall the event loop for ~70 ms.
      plainRun.lastIndex = i;
      const stop = plainRun.test(text) ? plainRun.lastIndex - 1 : n;
      const end = Math.max(stop, i + 1);
      code += text.slice(i, end);
      for (let k = end - 1; k >= i; k--) {
        const ch = text[k] ?? "";
        if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
          lastSignificant = ch;
          break;
        }
      }
      i = end;
    }
  }
  return { code, comments: comments.join("\n") };
}

interface FileFacts {
  readonly mtimeMs: number;
  readonly size: number;
  /** null when skipped: binary, generated header, or unreadable. */
  readonly lines: number | null;
  readonly todos: number;
  readonly suppressions: number;
  readonly anyTypes: number;
  readonly secret: { readonly label: string; readonly line: number } | null;
}

/**
 * Reads one file: size and debt facts for source files, and for every file a
 * key check. Config files (`sourceFile` false) only get the key check.
 */
async function readFacts(
  file: string,
  rel: string,
  stat: { mtimeMs: number; size: number },
  sourceFile: boolean,
  signal?: AbortSignal,
): Promise<FileFacts> {
  const skipped = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    lines: null,
    todos: 0,
    suppressions: 0,
    anyTypes: 0,
    secret: null,
  };
  let text: string;
  try {
    const buffer = await fs.readFile(file, { signal });
    if (buffer.subarray(0, 8192).includes(0)) return skipped;
    text = buffer.toString("utf-8");
  } catch {
    return skipped;
  }
  if (GENERATED_HEADER.test(text.slice(0, 2048))) return skipped;
  const secret = findSecret(text);
  if (!sourceFile) return { ...skipped, secret };
  const ext = extension(rel);
  // In JS-family files markers only count where they mean something: TODOs
  // and suppressions in comments, `any` in code (not in strings or comments).
  const split = JS_FAMILY.has(ext) ? splitJsSource(text) : { code: text, comments: text };
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    lines: lineCount(text),
    todos: count(split.comments, TODO_MARKER),
    suppressions: count(split.comments, SUPPRESSION),
    anyTypes: TS_EXTENSIONS.has(ext) ? count(split.code, ANY_TYPE) : 0,
    secret,
  };
}

async function gitLines(
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const { stdout } = await runBackgroundGit(args, {
      cwd,
      signal,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

function zList(stdout: string): string[] {
  return stdout.split("\0").filter(Boolean);
}

async function readSmallText(file: string, signal?: AbortSignal): Promise<string> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return "";
    return await fs.readFile(file, { encoding: "utf-8", signal });
  } catch {
    return "";
  }
}

/** Paths among `candidates` that Git LFS stores (they don't bloat history). */
async function lfsPaths(
  top: string,
  candidates: readonly string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  const lfs = new Set<string>();
  for (let i = 0; i < candidates.length; i += 100) {
    const batch = candidates.slice(i, i + 100);
    const out = await gitLines(["check-attr", "-z", "filter", "--", ...batch], top, signal);
    if (out === null) continue;
    const parts = out.split("\0");
    for (let j = 0; j + 2 < parts.length; j += 3) {
      if (parts[j + 2] === "lfs") lfs.add(parts[j] ?? "");
    }
  }
  return lfs;
}

interface ChangeHistory {
  /** Commits per file in the last {@link HOTSPOT_DAYS} days. */
  readonly counts: Map<string, number>;
  /** Changes that make a file a hotspot ({@link hotspotThreshold}). */
  readonly threshold: number;
}

/** Recent change counts per file; null without history. */
async function changeCounts(top: string, signal?: AbortSignal): Promise<ChangeHistory | null> {
  const out = await gitLines(
    [
      "log",
      `--since=${HOTSPOT_DAYS}.days.ago`,
      "--no-merges",
      "--no-renames",
      `-n${MAX_HISTORY_COMMITS}`,
      // Each commit starts with \x01 (then a newline before its file list).
      "--pretty=format:%x01",
      "--name-only",
      "-z",
    ],
    top,
    signal,
  );
  if (out === null) return null;
  const counts = new Map<string, number>();
  for (const token of zList(out)) {
    const header = token.startsWith("\x01\n") ? 2 : token.startsWith("\x01") ? 1 : 0;
    const rel = token.slice(header);
    if (rel) counts.set(rel, (counts.get(rel) ?? 0) + 1);
  }
  return { counts, threshold: hotspotThreshold(counts.values()) };
}

async function pool<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker));
}

/**
 * A scanner with a per-file cache (by mtime + size), so a rescan of an
 * unchanged project only stats files. Create one per polled project.
 */
export function createProjectHealthScanner(): ProjectHealthScanner {
  let cache = new Map<string, FileFacts>();
  // History only changes with HEAD (or as days pass), so reuse it per HEAD
  // and day instead of re-walking the log every rescan.
  let history: { key: string; changes: ChangeHistory | null } | null = null;

  return {
    async scan(cwd, now, signal) {
      const topOut = await gitLines(["rev-parse", "--show-toplevel"], cwd, signal);
      const prefixOut = await gitLines(["rev-parse", "--show-prefix"], cwd, signal);
      if (topOut === null || prefixOut === null || !topOut.trim()) return null;
      const top = path.resolve(topOut.trim());
      // The opened folder may be a subfolder of the repo: score its files, but
      // look for repo-wide setup (CI, .gitignore, tool config) from the root.
      const prefix = prefixOut.trim();
      const [trackedOut, untrackedOut] = await Promise.all([
        gitLines(["ls-files", "-z", "--cached"], top, signal),
        gitLines(["ls-files", "-z", "--others", "--exclude-standard"], top, signal),
      ]);
      if (trackedOut === null || untrackedOut === null || signal?.aborted) return null;
      const tracked = new Set(zList(trackedOut));
      const all = [...new Set([...tracked, ...zList(untrackedOut)])].sort();
      const truncated = all.length > MAX_LISTED;
      const listed = truncated ? all.slice(0, MAX_LISTED) : all;
      const listedSet = new Set(listed);
      const names = new Set(listed.map(basename));
      const inScope = listed.filter((rel) => rel.startsWith(prefix));

      const secretFiles = inScope.filter(isSecretPath).map((rel): HealthSecretFile => ({
        path: rel.slice(prefix.length),
        tracked: tracked.has(rel),
        found: null,
        line: null,
      }));

      const sources = inScope.filter(
        (rel) => SOURCE_EXTENSIONS.has(extension(rel)) && !isGeneratedPath(rel),
      );
      const scanned = sources.slice(0, MAX_SOURCE_FILES);
      const sourceSet = new Set(scanned);
      // Config files that can hold keys; lockfiles are huge and only hold hashes.
      const configs = inScope
        .filter((rel) => {
          const name = basename(rel);
          return (
            (CONFIG_EXTENSIONS.has(extension(rel)) || CONFIG_NAMES.has(name)) &&
            !LOCKFILES.includes(name) &&
            !isGeneratedPath(rel) &&
            !isTestPath(rel)
          );
        })
        .slice(0, MAX_CONFIG_FILES);
      const nextCache = new Map<string, FileFacts>();
      const facts = new Map<string, FileFacts>();
      const big: HealthFileBytes[] = [];
      const scannedSet = new Set([...scanned, ...configs]);

      await pool(inScope, async (rel) => {
        if (signal?.aborted) return;
        const file = path.join(top, rel);
        let stat: Awaited<ReturnType<typeof fs.lstat>>;
        try {
          stat = await fs.lstat(file);
        } catch {
          return; // deleted in the work tree
        }
        if (!stat.isFile()) return; // symlinks, submodules
        if (tracked.has(rel) && stat.size > LARGE_FILE_BYTES)
          big.push({ path: rel, bytes: stat.size });
        if (!scannedSet.has(rel)) return;
        const isSource = sourceSet.has(rel);
        if (stat.size > (isSource ? MAX_SOURCE_BYTES : MAX_CONFIG_BYTES)) return;
        const cached = cache.get(file);
        const entry =
          cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
            ? cached
            : await readFacts(file, rel, stat, isSource, signal);
        nextCache.set(file, entry);
        facts.set(rel, entry);
      });
      if (signal?.aborted) return null;
      cache = nextCache;

      const lfs =
        big.length > 0
          ? await lfsPaths(
              top,
              big.map((file) => file.path),
              signal,
            )
          : new Set<string>();
      const largeFiles = big
        .filter((file) => !lfs.has(file.path))
        .map((file) => ({ path: file.path.slice(prefix.length), bytes: file.bytes }))
        .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));

      const head = (await gitLines(["rev-parse", "HEAD"], top, signal))?.trim() ?? "";
      const historyKey = `${head}:${now.toISOString().slice(0, 10)}`;
      if (!head) history = { key: historyKey, changes: null };
      else if (history?.key !== historyKey) {
        history = { key: historyKey, changes: await changeCounts(top, signal) };
      }
      const counts = history.changes?.counts ?? null;
      const threshold = history.changes?.threshold ?? HOTSPOT_CHANGES;

      let sourceLines = 0;
      let weightedExcess = 0;
      let hotspotCount = 0;
      const oversized: HealthFileLines[] = [];
      const debt = { todos: 0, suppressions: 0, anyTypes: 0, lines: 0 };
      const namedSecrets = new Set(secretFiles.map((file) => file.path));
      for (const [rel, entry] of facts) {
        const shown = rel.slice(prefix.length);
        // Test fixtures hold fake keys on purpose.
        if (entry.secret && !isTestPath(rel) && !namedSecrets.has(shown)) {
          secretFiles.push({
            path: shown,
            tracked: tracked.has(rel),
            found: entry.secret.label,
            line: entry.secret.line,
          });
        }
        // Tests and check scripts don't count toward size or debt: a long
        // test file isn't the maintenance risk a long app file is. Config
        // files were only read for keys.
        if (entry.lines === null || isTestPath(rel) || !sourceSet.has(rel)) continue;
        sourceLines += entry.lines;
        if (entry.lines > OVERSIZED_LINES) {
          const changes = counts ? (counts.get(rel) ?? 0) : null;
          weightedExcess += (entry.lines - OVERSIZED_LINES) * churnWeight(changes, threshold);
          if (changes !== null && changes >= threshold) hotspotCount++;
          oversized.push({ path: rel.slice(prefix.length), lines: entry.lines, changes });
        }
        debt.todos += entry.todos;
        debt.suppressions += entry.suppressions;
        debt.anyTypes += entry.anyTypes;
        debt.lines += entry.lines;
      }
      const risk = (file: HealthFileLines): number =>
        (file.lines - OVERSIZED_LINES) * churnWeight(file.changes, threshold);
      oversized.sort(
        (a, b) => risk(b) - risk(a) || b.lines - a.lines || a.path.localeCompare(b.path),
      );
      const appSources = sources.filter((rel) => !isTestPath(rel));
      // A language needs a type checker only when it's a real part of the
      // project, not a stray build script.
      const share = (match: (ext: string) => boolean): number =>
        appSources.filter((rel) => match(extension(rel))).length / Math.max(1, appSources.length);
      const hasTs = share((ext) => TS_EXTENSIONS.has(ext)) >= TYPED_LANGUAGE_SHARE;
      const hasPy = share((ext) => ext === "py") >= TYPED_LANGUAGE_SHARE;

      // Root manifests can declare tools without a config file.
      const manifests = [...new Set(["", prefix])];
      const packageJsons = await Promise.all(
        manifests.map((dir) => readSmallText(path.join(top, dir, "package.json"), signal)),
      );
      const packageJson = packageJsons.join("\n");
      const python = (
        await Promise.all(
          manifests.flatMap((dir) => [
            readSmallText(path.join(top, dir, "pyproject.toml"), signal),
            readSmallText(path.join(top, dir, "setup.cfg"), signal),
          ]),
        )
      ).join("\n");
      const builtin = [...names].some((name) => BUILTIN_TOOLCHAIN.has(name));
      const hasLint =
        builtin ||
        [...names].some((name) => LINT_CONFIG.test(name)) ||
        /"eslintConfig"\s*:|\b(?:eslint|biome|oxlint|xo)\b/.test(packageJson) ||
        /\[tool\.(?:ruff|pylint|flake8)|\[flake8\]/.test(python);
      const hasFormat =
        builtin ||
        [...names].some((name) => FORMAT_CONFIG.test(name)) ||
        /"prettier"\s*:|\b(?:prettier|biome|dprint)\b/.test(packageJson) ||
        /\[tool\.(?:ruff|black)/.test(python);
      const tsOk = !hasTs || [...names].some((name) => TS_CONFIG.test(name));
      const pyOk =
        !hasPy ||
        [...names].some((name) => PY_TYPE_CONFIG.has(name)) ||
        /\[tool\.(?:mypy|pyright|basedpyright)\]|\[mypy\]/.test(python);

      const hasPackage = listedSet.has(`${prefix}package.json`);
      const hasLock = LOCKFILES.some(
        (lock) => tracked.has(`${prefix}${lock}`) || tracked.has(lock),
      );

      return {
        truncated: truncated || sources.length > MAX_SOURCE_FILES,
        sourceFiles: [...facts].filter(
          ([rel, entry]) => entry.lines !== null && !isTestPath(rel) && sourceSet.has(rel),
        ).length,
        sourceLines,
        oversized: oversized.slice(0, KEPT_OFFENDERS),
        oversizedCount: oversized.length,
        hotspotCount,
        oversizedWeightedExcess: weightedExcess,
        // Committed first: those are the incidents.
        secretFiles: secretFiles
          .sort((a, b) => Number(b.tracked) - Number(a.tracked) || a.path.localeCompare(b.path))
          .slice(0, KEPT_OFFENDERS),
        largeFiles: largeFiles.slice(0, KEPT_OFFENDERS),
        largeFileCount: largeFiles.length,
        hasGitignore: listedSet.has(".gitignore"),
        missingLockfile: hasPackage && !hasLock,
        hasTests: sources.some(isTestPath) || hasTestScript(packageJsons),
        hasLint,
        hasFormat,
        hasTypecheck: hasTs || hasPy ? tsOk && pyOk : null,
        hasCIWorkflow: listed.some((rel) => CI_FILE.test(rel)),
        debt,
      };
    },
  };
}
