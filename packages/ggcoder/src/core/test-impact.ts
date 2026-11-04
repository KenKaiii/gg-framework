import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { log } from "./logger.js";

/**
 * Edit impact for JavaScript/TypeScript projects: which tests actually reach a
 * changed file through its import graph (with the command that runs exactly
 * those), and which importers still use an export the edit removed.
 *
 * The sibling-test check (`detectTestDrift`) only sees `foo.test.ts` next to
 * `foo.ts`; the tests that break when a shared helper changes usually live
 * elsewhere. Built from relative imports only — package-name imports across a
 * workspace and path aliases are not followed, so the list can be incomplete
 * but never names a test with no import path to the change.
 */

const execFileAsync = promisify(execFile);

const SOURCE_GLOB = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const IGNORED_DIRS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/target/**",
  "**/.next/**",
];
const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 512 * 1024;
const READ_BATCH = 64;
/** Reverse-import hops searched for tests; deep chains reach nearly everything. */
const MAX_DEPTH = 6;
/** Longest the first scan may hold an edit result; it finishes in the background. */
const NOTE_SCAN_BUDGET_MS = 1_500;
/** Tests named in one note; a longer list is noise the model will not read. */
const MAX_LISTED_TESTS = 8;
/** Test files one command names before it falls back to the package suite. */
const MAX_COMMAND_TESTS = 20;
const MAX_LISTED_CALLERS = 6;
/** A full rescan is reused this long; edits made through the tools update it directly. */
const RESCAN_AFTER_MS = 30_000;

interface ImportRef {
  /** Resolved absolute path of the imported file. */
  target: string;
  /** Names imported by name (`import { a }`, `export { a } from`), `default` for a default import. */
  names: string[];
}

interface FileEntry {
  mtimeMs: number;
  imports: ImportRef[];
  exports: Set<string>;
}

export interface TestImpactOptions {
  now?: () => number;
}

const IMPORT_FROM_RE =
  /(?:^|[\s;])(?:import|export)\s+(type\s+)?([^'"`;]*?)\s*from\s*["']([^"']+)["']/g;
const BARE_IMPORT_RE = /(?:^|[\s;])import\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\b(?:import|require|vi\.mock|jest\.mock)\s*\(\s*["']([^"']+)["']/g;

/** Names an import clause pulls in by name: `Foo, { a, b as c, type D }` → default, a, b, D. */
function importedNames(clause: string): string[] {
  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces?.[1]) {
    for (const part of braces[1].split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name && /^[\w$]+$/.test(name)) names.push(name);
    }
  }
  const head = clause.replace(/\{[^}]*\}/, "").replace(/^type\s+/, "");
  const defaultName = head.split(",")[0]?.trim();
  if (defaultName && /^[\w$]+$/.test(defaultName)) names.push("default");
  return names;
}

/** Names a module exports, from its source text. */
export function parseExports(source: string): Set<string> {
  const exports = new Set<string>();
  const declRe =
    /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum|namespace)\s+([\w$]+)/gm;
  for (const match of source.matchAll(declRe)) {
    if (match[1]) exports.add(match[1]);
  }
  for (const match of source.matchAll(/^\s*export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of (match[1] ?? "").split(",")) {
      const pieces = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/);
      const name = (pieces[1] ?? pieces[0])?.trim();
      if (name && /^[\w$]+$/.test(name)) exports.add(name);
    }
  }
  if (/^\s*export\s+default\b/m.test(source)) exports.add("default");
  return exports;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/** Relative imports of one file, resolved against the set of known files. */
function parseImports(
  file: string,
  source: string,
  resolve: (from: string, spec: string) => string | undefined,
): ImportRef[] {
  const text = stripComments(source);
  const refs = new Map<string, Set<string>>();
  const add = (spec: string, names: readonly string[]) => {
    if (!spec.startsWith(".")) return;
    const target = resolve(file, spec);
    if (!target) return;
    const set = refs.get(target) ?? new Set<string>();
    for (const name of names) set.add(name);
    refs.set(target, set);
  };
  for (const match of text.matchAll(IMPORT_FROM_RE)) {
    add(match[3] ?? "", importedNames(match[2] ?? ""));
  }
  for (const match of text.matchAll(BARE_IMPORT_RE)) add(match[1] ?? "", []);
  for (const match of text.matchAll(DYNAMIC_IMPORT_RE)) add(match[1] ?? "", []);
  return [...refs].map(([target, names]) => ({ target, names: [...names].sort() }));
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export interface EditImpact {
  /** Nearest test files reaching the changed file, relative to cwd, sorted. */
  tests: string[];
  /** Tests reaching it only through more layers of imports; counted, not listed. */
  fartherTests: number;
  /** One shell command per package that runs exactly those tests. */
  commands: string[];
  /** Exports the edit removed that some importer still imports by name. */
  brokenCallers: Array<{ name: string; importers: string[] }>;
}

export class TestImpactIndex {
  private readonly entries = new Map<string, FileEntry>();
  private readonly importers = new Map<string, Set<string>>();
  private known = new Set<string>();
  private scannedAt = -Infinity;
  private scanning: Promise<void> | undefined;
  /** Export sets captured just before a tool write, keyed by absolute path. */
  private readonly preWriteExports = new Map<string, Set<string>>();
  /** Files whose reaching tests were already shown; later edits stay quiet. */
  private readonly shown = new Set<string>();
  private readonly runnerCache = new Map<string, Promise<string | undefined>>();
  private readonly now: () => number;

  constructor(
    private readonly cwd: string,
    options: TestImpactOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Record a file's exports before a tool overwrites it. */
  async beforeWrite(absPath: string): Promise<void> {
    if (!this.isSource(absPath)) return;
    try {
      this.preWriteExports.set(absPath, parseExports(await fs.readFile(absPath, "utf-8")));
    } catch {
      this.preWriteExports.delete(absPath); // new file: nothing could be removed
    }
  }

  /**
   * Model-facing note for a just-written file: the tests that reach it (first
   * edit of each file only) and importers left using a removed export (every
   * time). Empty when there is nothing to say.
   */
  async noteAfterWrite(absPath: string, content: string): Promise<string> {
    if (!this.isSource(absPath)) return "";
    const started = this.now();
    try {
      const before = this.preWriteExports.get(absPath);
      this.preWriteExports.delete(absPath);
      // Never hold the edit for a cold scan of a huge tree: say nothing this
      // time (and do not mark the file shown) and let the scan finish behind.
      const scan = this.ensureScanned();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ready = await Promise.race([
        scan.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), NOTE_SCAN_BUDGET_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (!ready) {
        void scan.then(() => this.updateEntry(absPath, content)).catch(() => undefined);
        return "";
      }
      this.updateEntry(absPath, content);
      const brokenCallers = before ? this.brokenCallers(absPath, before) : [];
      const showTests = !this.shown.has(absPath);
      this.shown.add(absPath);
      const impact = showTests
        ? await this.impactFor([absPath], brokenCallers)
        : { tests: [], fartherTests: 0, commands: [], brokenCallers };
      return formatEditImpactNote(toPosix(path.relative(this.cwd, absPath)), impact);
    } catch (error) {
      log("WARN", "test-impact", "Edit impact failed", { error: String(error) });
      return "";
    } finally {
      log("INFO", "test-impact", "Edit impact computed", {
        file: absPath,
        elapsedMs: String(this.now() - started),
      });
    }
  }

  /** Tests and commands covering a set of changed files (cwd-relative or absolute). */
  async impactFor(
    files: Iterable<string>,
    brokenCallers: EditImpact["brokenCallers"] = [],
  ): Promise<EditImpact> {
    await this.ensureScanned();
    const tests = new Set<string>();
    let farther = 0;
    for (const file of files) {
      const reach = this.reachingTests(path.resolve(this.cwd, file));
      for (const test of reach.tests) tests.add(test);
      farther += reach.farther;
    }
    const sorted = [...tests].sort();
    return {
      tests: sorted.map((t) => toPosix(path.relative(this.cwd, t))),
      fartherTests: farther,
      commands: await this.commandsFor(sorted),
      brokenCallers,
    };
  }

  private isSource(absPath: string): boolean {
    return (
      RESOLVE_EXTS.includes(path.extname(absPath)) &&
      !absPath.includes(`${path.sep}node_modules${path.sep}`)
    );
  }

  private async ensureScanned(): Promise<void> {
    if (this.now() - this.scannedAt < RESCAN_AFTER_MS) return;
    this.scanning ??= this.scan().finally(() => {
      this.scanning = undefined;
    });
    await this.scanning;
  }

  /**
   * Source files under cwd, cwd-relative and sorted. `git ls-files` first: it
   * applies every nested .gitignore and never walks ignored trees (measured on
   * this repo: 17ms vs 12s for a directory walk that descends into build
   * output before filtering). The walk is the fallback outside a git checkout.
   */
  private async listSourceFiles(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["ls-files", "-co", "--exclude-standard", "-z", "--", ...RESOLVE_EXTS.map((e) => `*${e}`)],
        { cwd: this.cwd, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 },
      );
      return stdout
        .split("\0")
        .filter((rel) => rel && !rel.split("/").includes("node_modules"))
        .sort();
    } catch {
      // Not a git checkout, or git is unavailable.
    }
    const [fg, ignore] = await Promise.all([import("fast-glob"), import("ignore")]);
    const ig = ignore.default();
    try {
      ig.add(await fs.readFile(path.join(this.cwd, ".gitignore"), "utf-8"));
    } catch {
      // No root .gitignore: the fixed ignore list still applies.
    }
    const entries = await fg.default(SOURCE_GLOB, {
      cwd: this.cwd,
      onlyFiles: true,
      ignore: IGNORED_DIRS,
      suppressErrors: true,
      followSymbolicLinks: false,
    });
    return entries.filter((entry) => !ig.ignores(entry)).sort();
  }

  private async scan(): Promise<void> {
    const started = this.now();
    const relative = (await this.listSourceFiles()).slice(0, MAX_FILES);
    const found: Array<{ file: string; size: number; mtimeMs: number }> = [];
    for (let i = 0; i < relative.length; i += READ_BATCH) {
      const batch = relative.slice(i, i + READ_BATCH).map((rel) => path.resolve(this.cwd, rel));
      const stats = await Promise.all(batch.map((file) => fs.stat(file).catch(() => undefined)));
      batch.forEach((file, j) => {
        const stat = stats[j];
        // Listed but deleted since (git ls-files -c), or not a regular file.
        if (stat?.isFile()) found.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
      });
    }
    // The full file set must be known before any import is resolved against it.
    this.known = new Set(found.map((entry) => entry.file));
    for (const file of [...this.entries.keys()]) {
      if (!this.known.has(file)) this.removeEntry(file);
    }
    const stale = found.filter(
      (entry) =>
        entry.size <= MAX_FILE_BYTES && this.entries.get(entry.file)?.mtimeMs !== entry.mtimeMs,
    );
    // Read in parallel batches; parse in sorted order so the graph is deterministic.
    for (let i = 0; i < stale.length; i += READ_BATCH) {
      const batch = stale.slice(i, i + READ_BATCH);
      const contents = await Promise.all(
        batch.map((entry) => fs.readFile(entry.file, "utf-8").catch(() => undefined)),
      );
      batch.forEach((entry, j) => {
        const content = contents[j];
        if (content !== undefined) this.updateEntry(entry.file, content, entry.mtimeMs);
      });
    }
    this.scannedAt = this.now();
    log("INFO", "test-impact", "Import graph scanned", {
      files: String(this.known.size),
      elapsedMs: String(this.now() - started),
    });
  }

  private resolveSpec = (from: string, spec: string): string | undefined => {
    const base = path.resolve(path.dirname(from), spec);
    const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
    const candidates = [
      base,
      ...RESOLVE_EXTS.map((ext) => `${stem}${ext}`),
      ...RESOLVE_EXTS.map((ext) => path.join(base, `index${ext}`)),
    ];
    return candidates.find((candidate) => this.known.has(candidate));
  };

  private updateEntry(file: string, content: string, mtimeMs = this.now()): void {
    this.known.add(file);
    this.removeEntry(file);
    const imports = parseImports(file, content, this.resolveSpec);
    this.entries.set(file, { mtimeMs, imports, exports: parseExports(content) });
    for (const ref of imports) {
      const set = this.importers.get(ref.target) ?? new Set<string>();
      set.add(file);
      this.importers.set(ref.target, set);
    }
  }

  private removeEntry(file: string): void {
    const entry = this.entries.get(file);
    if (!entry) return;
    for (const ref of entry.imports) this.importers.get(ref.target)?.delete(file);
    this.entries.delete(file);
  }

  /**
   * Tests reaching `file`, nearest import layer first. A layer is added while
   * the running total stays at or under {@link MAX_COMMAND_TESTS}, and the
   * first layer that finds any test is always added. Without the cap a shared
   * hub (a session object most tests construct) makes a leaf helper "reach"
   * half the suite, and a list that long is a list nobody runs. `farther`
   * counts the reaching tests left out.
   */
  private reachingTests(file: string): { tests: string[]; farther: number } {
    const tests = new Set<string>();
    if (TEST_FILE_RE.test(file)) tests.add(file);
    const seen = new Set([file]);
    let frontier = [file];
    let farther = 0;
    let collecting = true;
    for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
      const layer: string[] = [];
      const next: string[] = [];
      for (const current of frontier) {
        for (const importer of this.importers.get(current) ?? []) {
          if (seen.has(importer)) continue;
          seen.add(importer);
          if (TEST_FILE_RE.test(importer)) layer.push(importer);
          else next.push(importer);
        }
      }
      if (collecting && (tests.size === 0 || tests.size + layer.length <= MAX_COMMAND_TESTS)) {
        for (const test of layer) tests.add(test);
      } else {
        if (layer.length > 0) collecting = false;
        farther += layer.length;
      }
      frontier = next;
    }
    return { tests: [...tests], farther };
  }

  private brokenCallers(file: string, before: Set<string>): EditImpact["brokenCallers"] {
    const after = this.entries.get(file)?.exports ?? new Set<string>();
    const removed = [...before].filter((name) => !after.has(name)).sort();
    const result: EditImpact["brokenCallers"] = [];
    for (const name of removed) {
      const users = [...(this.importers.get(file) ?? [])]
        .filter((importer) =>
          this.entries
            .get(importer)
            ?.imports.some((ref) => ref.target === file && ref.names.includes(name)),
        )
        .map((importer) => toPosix(path.relative(this.cwd, importer)))
        .sort();
      if (users.length > 0) result.push({ name, importers: users });
    }
    return result;
  }

  /** Nearest package.json's test runner (vitest or jest), walking up to cwd. */
  private runnerFor(dir: string): Promise<string | undefined> {
    let cached = this.runnerCache.get(dir);
    if (!cached) {
      cached = (async () => {
        try {
          const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf-8")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          };
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          if ("vitest" in deps) return `${dir}\u0000vitest`;
          if ("jest" in deps) return `${dir}\u0000jest`;
        } catch {
          // No package.json here: keep walking up.
        }
        const parent = path.dirname(dir);
        if (dir === this.cwd || parent === dir || !parent.startsWith(this.cwd)) return undefined;
        return this.runnerFor(parent);
      })();
      this.runnerCache.set(dir, cached);
    }
    return cached;
  }

  private async commandsFor(tests: readonly string[]): Promise<string[]> {
    const groups = new Map<string, string[]>();
    for (const test of tests) {
      const runner = await this.runnerFor(path.dirname(test));
      if (!runner) continue;
      const list = groups.get(runner) ?? [];
      list.push(test);
      groups.set(runner, list);
    }
    const commands: string[] = [];
    for (const [key, files] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const [dir = this.cwd, runner = "vitest"] = key.split("\u0000");
      const base = runner === "vitest" ? "npx vitest run" : "npx jest";
      const args =
        files.length > MAX_COMMAND_TESTS
          ? ""
          : ` ${files.map((f) => shellQuote(toPosix(path.relative(dir, f)))).join(" ")}`;
      const rel = toPosix(path.relative(this.cwd, dir));
      commands.push(`${rel ? `cd ${shellQuote(rel)} && ` : ""}${base}${args}`);
    }
    return commands;
  }
}

/** The note appended to a successful edit/write result. Empty when nothing applies. */
export function formatEditImpactNote(relPath: string, impact: EditImpact): string {
  const lines: string[] = [];
  if (impact.tests.length > 0) {
    const shown = impact.tests.slice(0, MAX_LISTED_TESTS).join(", ");
    const more =
      impact.tests.length > MAX_LISTED_TESTS
        ? `, +${impact.tests.length - MAX_LISTED_TESTS} more`
        : "";
    const farther =
      impact.fartherTests > 0
        ? ` (${impact.fartherTests} more reach it only through more layers of imports)`
        : "";
    lines.push(
      `Nearest tests that import ${relPath} (directly or through other files): ${shown}${more}${farther}`,
    );
    for (const command of impact.commands) lines.push(`Run them: \`${command}\``);
  }
  for (const { name, importers } of impact.brokenCallers) {
    const shown = importers.slice(0, MAX_LISTED_CALLERS).join(", ");
    const more =
      importers.length > MAX_LISTED_CALLERS
        ? `, +${importers.length - MAX_LISTED_CALLERS} more`
        : "";
    lines.push(
      `Possibly broken callers: this edit removed the export \`${name}\`, still imported by ${shown}${more}.`,
    );
  }
  return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
}

/** One line for the verification demand: which tests reach the changed files, and how to run them. */
export function formatImpactForVerification(impact: EditImpact): string {
  if (impact.tests.length === 0 || impact.commands.length === 0) return "";
  const count =
    impact.tests.length === 1 ? "1 test file reaches" : `${impact.tests.length} test files reach`;
  return `\n${count} these changes: ${impact.commands.map((c) => `\`${c}\``).join(" ; ")}`;
}
