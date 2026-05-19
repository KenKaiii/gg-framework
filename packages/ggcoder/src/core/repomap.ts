import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import ignore from "ignore";

export interface RepoMapOptions {
  cwd: string;
  maxFiles?: number;
  maxSymbolsPerFile?: number;
  maxChars?: number;
  changedFiles?: readonly string[];
  readFiles?: readonly string[];
  focusTerms?: readonly string[];
  now?: Date;
  cache?: RepoMapCache;
  readFile?: (absolutePath: string) => Promise<string>;
  listGitChangedFiles?: (cwd: string) => Promise<readonly string[]>;
}

export interface RepoMapFile {
  path: string;
  language: string;
  exports: string[];
  symbols: string[];
  imports: string[];
  signatures: string[];
  mtimeMs: number;
  size: number;
}

export interface RepoMapDirectory {
  path: string;
  files: number;
}

export interface RepoMapDirtyRoot {
  path: string;
  files: number;
}

export interface RepoMapStats {
  indexedFiles: number;
  shownFiles: number;
  totalSymbols: number;
  renderedChars: number;
  truncated: boolean;
}

export interface RepoMapSnapshot {
  version: number;
  createdAt: string;
  files: RepoMapFile[];
  directories: RepoMapDirectory[];
  stats: RepoMapStats;
  changedFiles: string[];
  readFiles: string[];
  activeRoots?: string[];
  otherDirtyRoots?: RepoMapDirtyRoot[];
  truncated: boolean;
}

export interface RenderedRepoMap {
  snapshot: RepoMapSnapshot;
  markdown: string;
}

export interface RepoMapCacheEntry {
  file: RepoMapFile;
  maxSymbolsPerFile: number;
}

export interface RepoMapCache {
  files: Map<string, RepoMapCacheEntry>;
}

export const DEFAULT_REPO_MAP_MAX_CHARS = 5000;
export const FIRST_TURN_REPO_MAP_MAX_CHARS = 6500;
export const FOCUSED_REPO_MAP_MAX_CHARS = 3500;

const DEFAULT_MAX_FILES = 80;
const DEFAULT_MAX_SYMBOLS_PER_FILE = 8;
const DEFAULT_MAX_CHARS = DEFAULT_REPO_MAP_MAX_CHARS;
const MAX_FILE_SIZE_BYTES = 200_000;
const REPO_MAP_VERSION = 3;
const MAX_RENDERED_DIRECTORIES = 6;
const MAX_RENDERED_CHANGED_FILES = 10;
const MAX_RENDERED_READ_FILES = 8;
const MAX_SIGNATURE_FILES = 12;
const MAX_SIGNATURES_PER_FILE = 3;
const MAX_CROSS_PACKAGE_FILES = 4;
const MAX_FALLBACK_DIRTY_ROOTS = 1;
const GENERIC_FOCUS_TERMS = new Set([
  "agent",
  "app",
  "cli",
  "core",
  "src",
  "test",
  "tests",
  "tool",
  "tools",
  "ui",
]);
const execFileAsync = promisify(execFile);

export function createRepoMapCache(): RepoMapCache {
  return { files: new Map() };
}

const IGNORE_PATTERNS = [
  "**/.git/**",
  "**/.gg/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/vendor/**",
  "**/*.lock",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
];

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
]);

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  [".ts", "TypeScript"],
  [".tsx", "TypeScript React"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript React"],
  [".mjs", "JavaScript"],
  [".cjs", "JavaScript"],
  [".json", "JSON"],
  [".md", "Markdown"],
  [".py", "Python"],
  [".go", "Go"],
  [".rs", "Rust"],
  [".css", "CSS"],
]);

export async function buildRepoMap(options: RepoMapOptions): Promise<RenderedRepoMap> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxSymbolsPerFile = options.maxSymbolsPerFile ?? DEFAULT_MAX_SYMBOLS_PER_FILE;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const explicitChangedFiles = normalizeRelativePaths(options.cwd, options.changedFiles ?? []);
  const gitChangedFiles = normalizeRelativePaths(
    options.cwd,
    await listChangedFiles(options.cwd, options.listGitChangedFiles),
  );
  const readFiles = normalizeRelativePaths(options.cwd, options.readFiles ?? []);
  const focusTerms = normalizeFocusTerms(options.focusTerms ?? []);
  const createdAt = (options.now ?? new Date()).toISOString();
  const cache = options.cache;
  const readFile =
    options.readFile ?? ((absolutePath: string) => fs.readFile(absolutePath, "utf-8"));

  const entries = await listCandidateFiles(options.cwd);
  const entrySet = new Set(entries);
  if (cache) {
    for (const cachedPath of cache.files.keys()) {
      if (!entrySet.has(cachedPath)) cache.files.delete(cachedPath);
    }
  }

  const files: RepoMapFile[] = [];

  for (const entry of entries) {
    const absolute = path.join(options.cwd, entry);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_FILE_SIZE_BYTES) {
      cache?.files.delete(entry);
      continue;
    }

    const cached = cache?.files.get(entry);
    if (
      cached &&
      cached.maxSymbolsPerFile === maxSymbolsPerFile &&
      cached.file.mtimeMs === stat.mtimeMs &&
      cached.file.size === stat.size
    ) {
      files.push(cached.file);
      continue;
    }

    const language = detectLanguage(entry);
    const shouldRead = isTextExtension(entry);
    const content = shouldRead ? await readFile(absolute).catch(() => "") : "";
    const extracted = extractFileFacts(entry, content, maxSymbolsPerFile);
    const file: RepoMapFile = {
      path: entry,
      language,
      exports: extracted.exports,
      symbols: extracted.symbols,
      imports: extracted.imports,
      signatures: extracted.signatures,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
    files.push(file);
    cache?.files.set(entry, { file, maxSymbolsPerFile });
  }

  const preferredDirtyRoots = inferPreferredDirtyRoots({
    files,
    explicitChangedFiles,
    gitChangedFiles,
    readFiles,
    focusTerms,
  });
  const filteredGitChangedFiles = filterGitChangedFiles(gitChangedFiles, preferredDirtyRoots);
  const changedFiles = unique([...explicitChangedFiles, ...filteredGitChangedFiles]);
  const otherDirtyRoots = summarizeOtherDirtyRoots(gitChangedFiles, changedFiles);
  const context = { changedFiles, readFiles, focusTerms };
  const ranked = selectRepoMapFiles(files, { ...context, maxFiles });
  const activeRoots = inferActivePackageRoots(files, context);
  const directories = summarizeDirectories(files, ranked, activeRoots);
  const snapshot = createSnapshot(
    ranked,
    directories,
    files.length,
    changedFiles,
    readFiles,
    [...activeRoots].sort((a, b) => a.localeCompare(b)),
    otherDirtyRoots,
    createdAt,
    maxChars,
  );
  const markdown = renderRepoMap(snapshot, maxChars);
  const renderedStats = { ...snapshot.stats, renderedChars: markdown.length };
  const renderedSnapshot = {
    ...snapshot,
    stats: renderedStats,
    truncated: snapshot.truncated || renderedStats.truncated,
  };

  return { snapshot: renderedSnapshot, markdown };
}

export function extractFileFacts(
  filePath: string,
  content: string,
  maxSymbolsPerFile = DEFAULT_MAX_SYMBOLS_PER_FILE,
): Pick<RepoMapFile, "exports" | "symbols" | "imports" | "signatures"> {
  if (!isCodeLike(filePath) || content.length === 0) {
    return { exports: [], symbols: [], imports: [], signatures: [] };
  }

  const imports = unique([
    ...matchAll(content, /import\s+(?:type\s+)?(?:[^"'\n]+?\s+from\s+)?["']([^"']+)["']/g),
    ...matchAll(content, /export\s+[^"'\n]+?\s+from\s+["']([^"']+)["']/g),
    ...matchAll(content, /require\(["']([^"']+)["']\)/g),
  ]).slice(0, maxSymbolsPerFile);

  const exportedDeclarations = matchNamedDeclarations(
    content,
    /export\s+(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  );
  const namedExports = matchExportLists(content);
  const symbols = unique([
    ...exportedDeclarations,
    ...matchNamedDeclarations(content, /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g),
    ...matchNamedDeclarations(content, /(?:^|\n)\s*class\s+([A-Za-z_$][\w$]*)/g),
    ...matchNamedDeclarations(content, /(?:^|\n)\s*interface\s+([A-Za-z_$][\w$]*)/g),
    ...matchNamedDeclarations(content, /(?:^|\n)\s*type\s+([A-Za-z_$][\w$]*)/g),
    ...matchNamedDeclarations(content, /(?:^|\n)\s*const\s+([A-Za-z_$][\w$]*)\s*=/g),
  ]).slice(0, maxSymbolsPerFile);

  return {
    exports: unique([...exportedDeclarations, ...namedExports]).slice(0, maxSymbolsPerFile),
    symbols,
    imports,
    signatures: extractSignatures(content, maxSymbolsPerFile),
  };
}

export function rankRepoMapFiles(
  files: readonly RepoMapFile[],
  context: {
    changedFiles: readonly string[];
    readFiles?: readonly string[];
    focusTerms: readonly string[];
  },
): RepoMapFile[] {
  return rankRepoMapFilesWithGraph(files, context, buildDependencyGraph(files));
}

function selectRepoMapFiles(
  files: readonly RepoMapFile[],
  context: {
    changedFiles: readonly string[];
    readFiles: readonly string[];
    focusTerms: readonly string[];
    maxFiles: number;
  },
): RepoMapFile[] {
  const graph = buildDependencyGraph(files);
  const ranked = rankRepoMapFilesWithGraph(files, context, graph);
  const activeRoots = inferActivePackageRoots(files, context);
  if (activeRoots.size === 0) return ranked.slice(0, context.maxFiles);

  const contextualPaths = new Set([...context.changedFiles, ...context.readFiles]);
  const readPaths = new Set(context.readFiles);
  const hasActiveDirtyContext = context.changedFiles.some((filePath) => {
    const root = packageRoot(filePath);
    return root && activeRoots.has(root);
  });
  const active: RepoMapFile[] = [];
  const explicitCrossPackage: RepoMapFile[] = [];
  const supportCrossPackage: RepoMapFile[] = [];

  for (const file of ranked) {
    const root = packageRoot(file.path);
    if (!root || activeRoots.has(root)) {
      active.push(file);
      continue;
    }
    if (!hasActiveDirtyContext && isExplicitlyRelevantCrossPackage(file, context.focusTerms)) {
      explicitCrossPackage.push(file);
      continue;
    }
    if (isConnectedToActivePackage(file.path, activeRoots, graph)) {
      supportCrossPackage.push(file);
    }
  }

  const anchors = active.filter(
    (file) =>
      contextualPaths.has(file.path) &&
      (readPaths.has(file.path) || !isColdStartSupportFile(file.path)),
  );
  const supportAnchors = active.filter(
    (file) => contextualPaths.has(file.path) && isColdStartSupportFile(file.path),
  );
  const relatedActive = active.filter(
    (file) =>
      !contextualPaths.has(file.path) && isRelatedToContext(file.path, contextualPaths, graph),
  );
  const fallbackActive = active.filter(
    (file) =>
      !contextualPaths.has(file.path) && !isRelatedToContext(file.path, contextualPaths, graph),
  );

  return uniqueFiles([
    ...anchors,
    ...relatedActive,
    ...supportAnchors,
    ...explicitCrossPackage.slice(0, MAX_CROSS_PACKAGE_FILES),
    ...supportCrossPackage.slice(0, MAX_CROSS_PACKAGE_FILES),
    ...fallbackActive,
  ]).slice(0, context.maxFiles);
}

function rankRepoMapFilesWithGraph(
  files: readonly RepoMapFile[],
  context: {
    changedFiles: readonly string[];
    readFiles?: readonly string[];
    focusTerms: readonly string[];
  },
  graph: RepoMapGraph,
): RepoMapFile[] {
  const changed = new Set(context.changedFiles);
  const read = new Set(context.readFiles ?? []);
  const isColdStart = read.size === 0;
  const activeRoots = inferActivePackageRoots(files, {
    changedFiles: context.changedFiles,
    readFiles: context.readFiles ?? [],
    focusTerms: context.focusTerms,
  });
  return [...files].sort((a, b) => {
    const scoreDelta =
      scoreFile(b, changed, read, activeRoots, graph, context.focusTerms, isColdStart) -
      scoreFile(a, changed, read, activeRoots, graph, context.focusTerms, isColdStart);
    if (scoreDelta !== 0) return scoreDelta;
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.path.localeCompare(b.path);
  });
}

export function renderRepoMap(snapshot: RepoMapSnapshot, maxChars = DEFAULT_MAX_CHARS): string {
  const lines = [
    "<!-- gg-repomap -->",
    "## Repo Map",
    "Navigation-only map. Read files before editing; entries may be stale.",
    "Format: path [lang size] ex=exports sym=locals deps=local imports sig=top signatures.",
  ];
  const activeRoots = renderedActiveRoots(snapshot);
  const changedFiles = filterPathsToActiveRoots(snapshot.changedFiles, activeRoots);
  const hiddenChangedFiles = snapshot.changedFiles.filter(
    (filePath) => !changedFiles.includes(filePath),
  );
  const otherDirtyRoots = mergeDirtyRoots(
    snapshot.otherDirtyRoots ?? [],
    summarizeDirtyRoots(hiddenChangedFiles),
  );
  const directories = filterDirectoriesToActiveRoots(snapshot.directories, activeRoots);

  if (changedFiles.length > 0) {
    lines.push(`Changed: ${formatPathList(changedFiles, MAX_RENDERED_CHANGED_FILES)}`);
  }
  if (otherDirtyRoots.length > 0) {
    lines.push(
      `Other dirty packages: ${formatDirtyRootList(otherDirtyRoots, MAX_RENDERED_CHANGED_FILES)}`,
    );
  }
  if (snapshot.readFiles.length > 0) {
    lines.push(`Already read: ${formatPathList(snapshot.readFiles, MAX_RENDERED_READ_FILES)}`);
  }
  if (directories.length > 0) {
    lines.push(
      `Dirs: ${directories.map((directory) => `${directory.path}/(${directory.files})`).join(" ")}`,
    );
  }

  for (const [index, file] of snapshot.files.entries()) {
    const parts = [`${file.path} [${file.language} ${formatBytes(file.size)}]`];
    const localImports = file.imports.filter(isLocalImport);
    const nonExportedSymbols = file.symbols.filter((symbol) => !file.exports.includes(symbol));
    if (file.exports.length > 0) parts.push(`ex=${file.exports.join(",")}`);
    if (nonExportedSymbols.length > 0) parts.push(`sym=${nonExportedSymbols.join(",")}`);
    if (localImports.length > 0) parts.push(`deps=${localImports.join(",")}`);
    if (index < MAX_SIGNATURE_FILES && file.signatures.length > 0) {
      parts.push(`sig=${file.signatures.slice(0, MAX_SIGNATURES_PER_FILE).join(" | ")}`);
    }
    lines.push(`- ${parts.join(" ")}`);
  }

  return fitLinesToBudget(lines, maxChars);
}

function createSnapshot(
  files: RepoMapFile[],
  directories: RepoMapDirectory[],
  indexedFiles: number,
  changedFiles: string[],
  readFiles: string[],
  activeRoots: string[],
  otherDirtyRoots: RepoMapDirtyRoot[],
  createdAt: string,
  maxChars: number,
): RepoMapSnapshot {
  const totalSymbols = files.reduce(
    (sum, file) => sum + file.symbols.length + file.exports.length,
    0,
  );
  const initial: RepoMapSnapshot = {
    version: REPO_MAP_VERSION,
    createdAt,
    files,
    directories,
    changedFiles,
    readFiles,
    activeRoots,
    otherDirtyRoots,
    stats: {
      indexedFiles,
      shownFiles: files.length,
      totalSymbols,
      renderedChars: 0,
      truncated: files.length < indexedFiles,
    },
    truncated: files.length < indexedFiles,
  };
  const markdown = renderRepoMap(initial, maxChars);
  const truncated = initial.truncated || markdown.includes("truncated to repo map budget");
  return {
    ...initial,
    stats: { ...initial.stats, renderedChars: markdown.length, truncated },
    truncated,
  };
}

async function listChangedFiles(
  cwd: string,
  override?: (cwd: string) => Promise<readonly string[]>,
): Promise<string[]> {
  if (override) return [...(await override(cwd))];
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-uall"], {
      cwd,
      timeout: 2_000,
      maxBuffer: 512_000,
    });
    return parseGitStatus(stdout);
  } catch {
    return [];
  }
}

function parseGitStatus(output: string): string[] {
  const files: string[] = [];
  for (const line of output.split("\n")) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    if (status === "!!") continue;
    const rawPath = line.slice(3).trim();
    if (!rawPath) continue;
    const renamedPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;
    if (renamedPath) files.push(unquoteGitPath(renamedPath));
  }
  return unique(files);
}

function unquoteGitPath(filePath: string): string {
  if (!filePath.startsWith('"') || !filePath.endsWith('"')) return filePath;
  try {
    return JSON.parse(filePath) as string;
  } catch {
    return filePath.slice(1, -1);
  }
}

async function listCandidateFiles(cwd: string): Promise<string[]> {
  const ignorePatterns = await loadGitignore(cwd);
  const ig = ignore().add(ignorePatterns);
  const entries = await fg("**/*", {
    cwd,
    dot: false,
    onlyFiles: true,
    ignore: IGNORE_PATTERNS,
  });
  return entries
    .filter((entry) => !BINARY_EXTENSIONS.has(path.extname(entry).toLowerCase()))
    .filter((entry) => !ig.ignores(entry))
    .sort((a, b) => a.localeCompare(b));
}

async function loadGitignore(cwd: string): Promise<string[]> {
  const content = await fs.readFile(path.join(cwd, ".gitignore"), "utf-8").catch(() => "");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function detectLanguage(filePath: string): string {
  return LANGUAGE_BY_EXTENSION.get(path.extname(filePath).toLowerCase()) ?? "Text";
}

function isTextExtension(filePath: string): boolean {
  return !BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isCodeLike(filePath: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(
    path.extname(filePath).toLowerCase(),
  );
}

function matchAll(content: string, regexp: RegExp): string[] {
  return [...content.matchAll(regexp)].map((match) => match[1]).filter(isPresent);
}

function matchNamedDeclarations(content: string, regexp: RegExp): string[] {
  return matchAll(content, regexp);
}

function matchExportLists(content: string): string[] {
  const names: string[] = [];
  for (const match of content.matchAll(/export\s*\{([^}]+)\}/g)) {
    const list = match[1];
    if (!list) continue;
    for (const raw of list.split(",")) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

function extractSignatures(content: string, maxSignatures: number): string[] {
  const code = stripTemplateLiterals(content);
  const signatures: string[] = [];
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)(?:\s*:\s*[^\n{]+)?/g,
    /(?:export\s+)?(?:class|interface|type)\s+[A-Za-z_$][\w$]*(?:\s*[^=\n{]*)?(?:\s*=\s*[^\n;]+)?/g,
    /(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const signature = match[0]?.replace(/\s+/g, " ").trim();
      if (signature) signatures.push(signature);
      if (signatures.length >= maxSignatures) return unique(signatures);
    }
  }
  return unique(signatures).slice(0, maxSignatures);
}

function stripTemplateLiterals(content: string): string {
  return content.replace(/`(?:\\.|[^`])*`/gs, "``");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function isPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function scoreFile(
  file: RepoMapFile,
  changedFiles: ReadonlySet<string>,
  readFiles: ReadonlySet<string>,
  activeRoots: ReadonlySet<string>,
  graph: RepoMapGraph,
  focusTerms: readonly string[],
  isColdStart: boolean,
): number {
  let score = 0;
  const isChanged = changedFiles.has(file.path);
  const isRead = readFiles.has(file.path);
  if (isChanged) score += 1200;
  if (isChanged && isRead) score += 700;
  if (isChanged && isRead && isCodeLike(file.path)) score += 300;
  if (isRead && !isChanged) score -= 450;
  score += scorePackageRoot(file.path, activeRoots, focusTerms);
  if (isReadNeighbor(file.path, readFiles, graph)) score += 260;
  if (isChangedNeighbor(file.path, changedFiles, graph)) score += 420;
  if (sharesNeighborhood(file.path, changedFiles)) score += 180;
  if (sharesNeighborhood(file.path, readFiles)) score += 120;
  score += Math.min(300, (graph.inbound.get(file.path)?.size ?? 0) * 45);
  score += Math.min(180, (graph.outbound.get(file.path)?.size ?? 0) * 25);
  if (isEntrypoint(file.path)) score += 150;
  if (file.path.startsWith("src/") || file.path.includes("/src/")) score += 80;
  score += Math.min(120, (file.exports.length + file.symbols.length) * 10);
  if (isColdStart && isChanged) score += scoreColdStartSpecificity(file, focusTerms);
  score -=
    isTestFile(file.path) && !focusTerms.includes("test") && !focusTerms.includes("tests") ? 80 : 0;
  score -= file.size > 100_000 ? 50 : 0;
  const searchable =
    `${file.path} ${file.exports.join(" ")} ${file.symbols.join(" ")} ${file.signatures.join(" ")}`.toLowerCase();
  for (const term of focusTerms) {
    if (searchable.includes(term)) score += 220;
    if (file.path.toLowerCase().includes(term)) score += 80;
  }
  return score;
}

function scoreColdStartSpecificity(file: RepoMapFile, focusTerms: readonly string[]): number {
  let score = 0;
  const pathTokens = tokenizePath(file.path);
  const filename = path.posix.basename(file.path).toLowerCase();
  for (const term of focusTerms) {
    if (pathTokens.includes(term)) score += 260;
  }
  if (pathTokens.includes("repomap")) score += 320;
  if (filename === "repomap.ts") score += 260;
  if (pathTokens.includes("test") || pathTokens.includes("spec")) score += 140;
  if (file.path.includes("/core/")) score += 120;
  if (file.path.includes("/scripts/")) score -= 520;
  if (filename === "app.tsx" || filename === "app.ts" || filename === "cli.ts") score -= 220;
  score -= Math.min(420, Math.floor(file.size / 20_000) * 90);
  return score;
}

function tokenizePath(filePath: string): string[] {
  return unique(
    filePath
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((part) => part.length >= 3),
  );
}

interface RepoMapGraph {
  outbound: Map<string, Set<string>>;
  inbound: Map<string, Set<string>>;
}

function buildDependencyGraph(files: readonly RepoMapFile[]): RepoMapGraph {
  const paths = new Set(files.map((file) => file.path));
  const outbound = new Map<string, Set<string>>();
  const inbound = new Map<string, Set<string>>();

  for (const file of files) {
    const dependencies = new Set<string>();
    for (const importPath of file.imports) {
      const resolved = resolveLocalImport(file.path, importPath, paths);
      if (resolved) dependencies.add(resolved);
    }
    outbound.set(file.path, dependencies);
    for (const dependency of dependencies) {
      const importers = inbound.get(dependency) ?? new Set<string>();
      importers.add(file.path);
      inbound.set(dependency, importers);
    }
  }

  return { outbound, inbound };
}

function filterGitChangedFiles(
  gitChangedFiles: readonly string[],
  preferredRoots: ReadonlySet<string>,
): string[] {
  if (gitChangedFiles.length === 0) return [];
  if (preferredRoots.size === 0) return [...gitChangedFiles];
  return gitChangedFiles.filter((filePath) => {
    const root = packageRoot(filePath);
    return !root || preferredRoots.has(root);
  });
}

function inferPreferredDirtyRoots(context: {
  files: readonly RepoMapFile[];
  explicitChangedFiles: readonly string[];
  gitChangedFiles: readonly string[];
  readFiles: readonly string[];
  focusTerms: readonly string[];
}): Set<string> {
  const explicitRoots = collectPackageRoots(context.explicitChangedFiles);
  if (explicitRoots.size > 0) return explicitRoots;

  const readRoots = collectPackageRoots(context.readFiles);
  if (readRoots.size > 0) return readRoots;

  const focusedRoots = inferFocusedPackageRoots(context.files, context.focusTerms);
  if (focusedRoots.size > 0) return focusedRoots;

  const focusMatchedDirtyRoots = inferFocusMatchedDirtyRoots(
    context.files,
    context.gitChangedFiles,
    context.focusTerms,
  );
  if (focusMatchedDirtyRoots.size > 0) return focusMatchedDirtyRoots;

  return inferRecentlyChangedDirtyRoots(context.gitChangedFiles, context.files);
}

function inferActivePackageRoots(
  files: readonly RepoMapFile[],
  context: {
    changedFiles: readonly string[];
    readFiles: readonly string[];
    focusTerms: readonly string[];
  },
): Set<string> {
  const readRoots = collectPackageRoots(context.readFiles);
  if (readRoots.size > 0) return readRoots;

  const focusedRoots = inferFocusedPackageRoots(files, context.focusTerms);
  if (focusedRoots.size > 0) return focusedRoots;

  const focusMatchedDirtyRoots = inferFocusMatchedDirtyRoots(
    files,
    context.changedFiles,
    context.focusTerms,
  );
  if (focusMatchedDirtyRoots.size > 0) return focusMatchedDirtyRoots;

  return collectPackageRoots(context.changedFiles);
}

function inferFocusedPackageRoots(
  files: readonly RepoMapFile[],
  focusTerms: readonly string[],
): Set<string> {
  const roots = new Set<string>();
  const knownRoots = new Set(files.map((file) => packageRoot(file.path)).filter(isPresent));
  for (const term of focusTerms) {
    for (const root of knownRoots) {
      if (isPackageExplicitlyMentioned(root, [term])) roots.add(root);
    }
  }
  return roots;
}

function inferFocusMatchedDirtyRoots(
  files: readonly RepoMapFile[],
  dirtyFiles: readonly string[],
  focusTerms: readonly string[],
): Set<string> {
  if (dirtyFiles.length === 0 || focusTerms.length === 0) return new Set();
  const dirty = new Set(dirtyFiles);
  const roots = new Set<string>();
  for (const file of files) {
    if (!dirty.has(file.path) || !matchesFocus(file, focusTerms)) continue;
    const root = packageRoot(file.path);
    if (root) roots.add(root);
  }
  return roots;
}

function matchesFocus(file: RepoMapFile, focusTerms: readonly string[]): boolean {
  const meaningfulTerms = focusTerms.filter((term) => !GENERIC_FOCUS_TERMS.has(term));
  const searchable = [
    ...tokenizePath(file.path),
    ...file.exports.map((value) => value.toLowerCase()),
    ...file.symbols.map((value) => value.toLowerCase()),
  ];
  const searchableSet = new Set(searchable);
  return meaningfulTerms.some(
    (term) => searchableSet.has(term) || searchable.some((value) => value.includes(term)),
  );
}

function collectPackageRoots(filePaths: readonly string[]): Set<string> {
  const roots = new Set<string>();
  for (const filePath of filePaths) {
    const root = packageRoot(filePath);
    if (root) roots.add(root);
  }
  return roots;
}

function inferRecentlyChangedDirtyRoots(
  gitChangedFiles: readonly string[],
  files: readonly RepoMapFile[],
): Set<string> {
  const dirtyRoots = collectPackageRoots(gitChangedFiles);
  if (dirtyRoots.size <= MAX_FALLBACK_DIRTY_ROOTS) return dirtyRoots;

  const recentByRoot = new Map<string, number>();
  for (const file of files) {
    const root = packageRoot(file.path);
    if (!root || !dirtyRoots.has(root)) continue;
    recentByRoot.set(root, Math.max(recentByRoot.get(root) ?? 0, file.mtimeMs));
  }

  return new Set(
    [...dirtyRoots]
      .sort((a, b) => (recentByRoot.get(b) ?? 0) - (recentByRoot.get(a) ?? 0) || a.localeCompare(b))
      .slice(0, MAX_FALLBACK_DIRTY_ROOTS),
  );
}

function scorePackageRoot(
  filePath: string,
  activeRoots: ReadonlySet<string>,
  focusTerms: readonly string[],
): number {
  if (activeRoots.size === 0) return 0;
  const root = packageRoot(filePath);
  if (!root) return 0;
  if (activeRoots.has(root)) return 900;
  if (isPackageExplicitlyMentioned(root, focusTerms)) return 500;
  return -900;
}

function isExplicitlyRelevantCrossPackage(
  file: RepoMapFile,
  focusTerms: readonly string[],
): boolean {
  const root = packageRoot(file.path);
  if (!root) return true;
  return isPackageExplicitlyMentioned(root, focusTerms);
}

function isRelatedToContext(
  filePath: string,
  contextualPaths: ReadonlySet<string>,
  graph: RepoMapGraph,
): boolean {
  if (contextualPaths.size === 0) return false;
  for (const contextualPath of contextualPaths) {
    if (contextualPath === filePath) return true;
    if (topDirectory(contextualPath) === topDirectory(filePath)) return true;
    if (graph.outbound.get(contextualPath)?.has(filePath)) return true;
    if (graph.inbound.get(contextualPath)?.has(filePath)) return true;
  }
  return false;
}

function isConnectedToActivePackage(
  filePath: string,
  activeRoots: ReadonlySet<string>,
  graph: RepoMapGraph,
): boolean {
  const outbound = graph.outbound.get(filePath) ?? new Set<string>();
  const inbound = graph.inbound.get(filePath) ?? new Set<string>();
  for (const related of [...outbound, ...inbound]) {
    const relatedRoot = packageRoot(related);
    if (relatedRoot && activeRoots.has(relatedRoot)) return true;
  }
  return false;
}

function isPackageExplicitlyMentioned(root: string, focusTerms: readonly string[]): boolean {
  const packageName = path.posix.basename(root).toLowerCase();
  const shortName = packageName.replace(/^gg-/, "");
  return (
    focusTerms.includes(packageName) ||
    (!GENERIC_FOCUS_TERMS.has(shortName) && focusTerms.includes(shortName))
  );
}

function packageRoot(filePath: string): string | undefined {
  const parts = filePath.split("/");
  if (parts[0] === "packages" && parts.length >= 2) return parts.slice(0, 2).join("/");
  return undefined;
}

function uniqueFiles(files: readonly RepoMapFile[]): RepoMapFile[] {
  const seen = new Set<string>();
  const result: RepoMapFile[] = [];
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    result.push(file);
  }
  return result;
}

function summarizeOtherDirtyRoots(
  gitChangedFiles: readonly string[],
  visibleChangedFiles: readonly string[],
): RepoMapDirtyRoot[] {
  const visibleRoots = new Set(
    visibleChangedFiles.map((filePath) => packageRoot(filePath)).filter(isPresent),
  );
  const hiddenFiles = gitChangedFiles.filter((filePath) => {
    const root = packageRoot(filePath);
    return root && !visibleRoots.has(root);
  });
  return summarizeDirtyRoots(hiddenFiles);
}

function summarizeDirectories(
  allFiles: readonly RepoMapFile[],
  rankedFiles: readonly RepoMapFile[],
  activeRoots: ReadonlySet<string>,
): RepoMapDirectory[] {
  const shown = new Set(rankedFiles.map((file) => topDirectory(file.path)));
  const counts = new Map<string, number>();
  for (const file of allFiles) {
    const directory = topDirectory(file.path);
    const root = packageRoot(file.path);
    if (!directory || shown.has(directory)) continue;
    if (root && activeRoots.size > 0 && !activeRoots.has(root)) continue;
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([directoryPath, files]) => ({ path: directoryPath, files }))
    .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path))
    .slice(0, MAX_RENDERED_DIRECTORIES);
}

function resolveLocalImport(
  sourcePath: string,
  importPath: string,
  paths: ReadonlySet<string>,
): string | undefined {
  if (!isLocalImport(importPath)) return undefined;
  const sourceDir = path.posix.dirname(sourcePath);
  const base = path.posix.normalize(path.posix.join(sourceDir, importPath));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    path.posix.join(base, "index.ts"),
    path.posix.join(base, "index.tsx"),
    path.posix.join(base, "index.js"),
    path.posix.join(base, "index.jsx"),
  ];
  return candidates.find((candidate) => paths.has(candidate));
}

function isReadNeighbor(
  filePath: string,
  readFiles: ReadonlySet<string>,
  graph: RepoMapGraph,
): boolean {
  for (const readFile of readFiles) {
    if (graph.outbound.get(readFile)?.has(filePath) || graph.inbound.get(readFile)?.has(filePath)) {
      return true;
    }
  }
  return false;
}

function isChangedNeighbor(
  filePath: string,
  changedFiles: ReadonlySet<string>,
  graph: RepoMapGraph,
): boolean {
  for (const changedFile of changedFiles) {
    if (
      graph.outbound.get(changedFile)?.has(filePath) ||
      graph.inbound.get(changedFile)?.has(filePath)
    ) {
      return true;
    }
  }
  return false;
}

function sharesNeighborhood(filePath: string, relatedFiles: ReadonlySet<string>): boolean {
  const directory = contextDirectory(filePath);
  if (!directory) return false;
  for (const relatedFile of relatedFiles) {
    if (relatedFile !== filePath && contextDirectory(relatedFile) === directory) return true;
  }
  return false;
}

function contextDirectory(filePath: string): string {
  const directory = path.posix.dirname(filePath);
  return directory === "." ? "" : directory;
}

function topDirectory(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 1) return "";
  if (parts[0] === "packages" && parts.length >= 4) return parts.slice(0, 3).join("/");
  if (parts[0] === "packages" && parts.length >= 2) return parts.slice(0, 2).join("/");
  return parts[0] ?? "";
}

function isColdStartSupportFile(filePath: string): boolean {
  return filePath.includes("/scripts/");
}

function isEntrypoint(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return ["package.json", "index.ts", "index.tsx", "index.js", "cli.ts", "main.ts"].includes(base);
}

function isTestFile(filePath: string): boolean {
  return /(?:^|\/|\.)(test|spec)\.[jt]sx?$/.test(filePath) || filePath.includes("__tests__");
}

function isLocalImport(importPath: string): boolean {
  return importPath.startsWith(".") || importPath.startsWith("/");
}

function normalizeFocusTerms(terms: readonly string[]): string[] {
  return unique(
    terms
      .flatMap((term) => term.toLowerCase().split(/[^a-z0-9_$-]+/))
      .filter((term) => term.length >= 3),
  );
}

function normalizeRelativePaths(cwd: string, files: readonly string[]): string[] {
  return unique(
    files.map((file) => {
      const absolute = path.isAbsolute(file) ? file : path.join(cwd, file);
      return path.relative(cwd, absolute).split(path.sep).join("/");
    }),
  ).sort((a, b) => a.localeCompare(b));
}

function fitLinesToBudget(lines: readonly string[], maxChars: number): string {
  const suffix = "… truncated to repo map budget.";
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const nextUsed = used + (kept.length > 0 ? 1 : 0) + line.length;
    if (nextUsed > maxChars) break;
    kept.push(line);
    used = nextUsed;
  }
  if (kept.length === lines.length) return kept.join("\n");
  while (kept.length > 0 && kept.join("\n").length + 1 + suffix.length > maxChars) {
    kept.pop();
  }
  if (kept.length === 0) return suffix.slice(0, maxChars);
  return `${kept.join("\n")}\n${suffix}`;
}

function formatPathList(paths: readonly string[], maxItems: number): string {
  const visible = paths.slice(0, maxItems);
  const hidden = paths.length - visible.length;
  return hidden > 0 ? `${visible.join(",")},+${hidden} more` : visible.join(",");
}

function formatDirtyRootList(roots: readonly RepoMapDirtyRoot[], maxItems: number): string {
  const visible = roots.slice(0, maxItems);
  const hidden = roots.length - visible.length;
  const formatted = visible
    .map((root) => `${path.posix.basename(root.path)}(${root.files})`)
    .join(",");
  return hidden > 0 ? `${formatted},+${hidden} more` : formatted;
}

function renderedActiveRoots(snapshot: RepoMapSnapshot): Set<string> {
  const roots = new Set(snapshot.activeRoots ?? []);
  if (roots.size > 0) return roots;
  for (const readFile of snapshot.readFiles) {
    const root = packageRoot(readFile);
    if (root) roots.add(root);
  }
  return roots;
}

function filterPathsToActiveRoots(
  paths: readonly string[],
  activeRoots: ReadonlySet<string>,
): string[] {
  if (activeRoots.size === 0) return [...paths];
  return paths.filter((filePath) => {
    const root = packageRoot(filePath);
    return !root || activeRoots.has(root);
  });
}

function filterDirectoriesToActiveRoots(
  directories: readonly RepoMapDirectory[],
  activeRoots: ReadonlySet<string>,
): RepoMapDirectory[] {
  if (activeRoots.size === 0) return [...directories];
  return directories.filter((directory) => {
    const root = packageRoot(directory.path);
    return !root || activeRoots.has(root);
  });
}

function summarizeDirtyRoots(files: readonly string[]): RepoMapDirtyRoot[] {
  const counts = new Map<string, number>();
  for (const filePath of files) {
    const root = packageRoot(filePath);
    if (!root) continue;
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([root, files]) => ({ path: root, files }))
    .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path));
}

function mergeDirtyRoots(
  primary: readonly RepoMapDirtyRoot[],
  secondary: readonly RepoMapDirtyRoot[],
): RepoMapDirtyRoot[] {
  const counts = new Map<string, number>();
  for (const root of [...primary, ...secondary]) {
    counts.set(root.path, Math.max(counts.get(root.path) ?? 0, root.files));
  }
  return [...counts.entries()]
    .map(([root, files]) => ({ path: root, files }))
    .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path));
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size}B`;
  return `${Math.round(size / 1024)}KB`;
}
