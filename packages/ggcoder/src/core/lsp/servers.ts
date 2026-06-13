import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Language-server catalog. Binaries are resolved from the project's
 * node_modules/.bin (walking up for monorepo hoisting), ggcoder's OWN install
 * (typescript-language-server + typescript ship as ggcoder dependencies, so
 * TS/JS diagnostics work for every user out of the box), and the user's PATH —
 * never auto-installed at runtime, never fetched over the network. A server
 * that can't be resolved silently degrades to "no diagnostics".
 *
 * Extension lists stay consistent with `core/language-detector.ts` MARKERS.
 */

export interface ResolvedCommand {
  command: string;
  args: string[];
  /** Server-specific LSP initializationOptions (e.g. explicit tsserver path). */
  initializationOptions?: unknown;
}

export interface LspServerSpec {
  id: string;
  /** File extensions (lowercase, with dot) this server covers. */
  extensions: readonly string[];
  /** Marker files that identify a project root, nearest-first walking up. */
  rootMarkers: readonly string[];
  /** LSP languageId for a given extension. */
  languageIdFor(extension: string): string;
  /** Resolve the server binary for a project root, or null when unavailable. */
  resolveCommand(projectRoot: string): ResolvedCommand | null;
}

const WINDOWS_SUFFIXES = [".cmd", ".exe", ".bat"] as const;

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

function candidateNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  return [name, ...WINDOWS_SUFFIXES.map((suffix) => `${name}${suffix}`)];
}

/** Directory of this module — anchor for resolving ggcoder's own bundled deps. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function binDirsUpFrom(start: string): string[] {
  const dirs: string[] = [];
  let dir = start;
  for (;;) {
    dirs.push(path.join(dir, "node_modules", ".bin"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/**
 * Find `name`, in priority order:
 *   1. <projectRoot>/node_modules/.bin walking up (project's own version wins)
 *   2. ggcoder's own node_modules/.bin walking up (bundled fallback — this is
 *      how typescript-language-server works for users who never installed it)
 *   3. PATH
 */
export function findExecutable(name: string, projectRoot: string): string | null {
  const names = candidateNames(name);

  const binDirs = [...binDirsUpFrom(projectRoot), ...binDirsUpFrom(MODULE_DIR)];
  for (const binDir of binDirs) {
    for (const candidate of names) {
      const binPath = path.join(binDir, candidate);
      if (isExecutableFile(binPath)) return binPath;
    }
  }

  // PATH lookup.
  const pathEnv = process.env.PATH ?? "";
  for (const pathDir of pathEnv.split(path.delimiter)) {
    if (!pathDir) continue;
    for (const candidate of names) {
      const binPath = path.join(pathDir, candidate);
      if (isExecutableFile(binPath)) return binPath;
    }
  }
  return null;
}

/**
 * Find a file at `node_modules/<relPath>` walking up from `start`.
 * Deterministic fs checks only — no resolver hooks, no createRequire (whose
 * resolution can be patched by dev runners and global fallback paths).
 */
function findInNodeModulesUp(relPath: string, start: string): string | null {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, "node_modules", relPath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve an npm package's bin entry script (the real .js/.mjs file, NOT the
 * node_modules/.bin shim). Shims are shell scripts or symlinks that require
 * `node` on PATH; spawning the entry with `process.execPath` works always —
 * including for users whose only node is the one running ggcoder.
 */
function findPackageBinScript(pkgName: string, binName: string, start: string): string | null {
  const pkgJsonPath = findInNodeModulesUp(path.join(pkgName, "package.json"), start);
  if (!pkgJsonPath) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName];
    if (!bin) return null;
    const script = path.join(path.dirname(pkgJsonPath), bin);
    return fs.existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a node-based language server: the project's own install wins, then
 * ggcoder's bundled dependency, then a PATH binary as a last resort.
 */
function resolveNodeServer(
  pkgName: string,
  binName: string,
  projectRoot: string,
  args: string[],
): ResolvedCommand | null {
  const script =
    findPackageBinScript(pkgName, binName, projectRoot) ??
    findPackageBinScript(pkgName, binName, MODULE_DIR);
  if (script) return { command: process.execPath, args: [script, ...args] };
  const bin = findExecutable(binName, projectRoot);
  return bin ? { command: bin, args } : null;
}

const TSSERVER_REL_PATH = path.join("typescript", "lib", "tsserver.js");

/** The project's own tsserver.js (hoisting-aware), or null. */
function projectTsserverPath(projectRoot: string): string | null {
  return findInNodeModulesUp(TSSERVER_REL_PATH, projectRoot);
}

/**
 * ggcoder's bundled tsserver.js — the fallback when the project has no
 * `typescript` install. Resolved relative to THIS module so it finds
 * ggcoder's own dependency regardless of where the user runs.
 */
function bundledTsserverPath(): string | null {
  return findInNodeModulesUp(TSSERVER_REL_PATH, MODULE_DIR);
}

const TS_LANGUAGE_IDS: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
};

export const LSP_SERVER_CATALOG: readonly LspServerSpec[] = [
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: [
      "tsconfig.json",
      "jsconfig.json",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "bun.lockb",
    ],
    languageIdFor: (extension) => TS_LANGUAGE_IDS[extension] ?? "typescript",
    resolveCommand(projectRoot) {
      const command = resolveNodeServer(
        "typescript-language-server",
        "typescript-language-server",
        projectRoot,
        ["--stdio"],
      );
      if (!command) return null;
      // Prefer the project's own typescript (correct version semantics); fall
      // back to ggcoder's bundled copy so bare projects still get diagnostics.
      if (projectTsserverPath(projectRoot)) return command;
      const tsserver = bundledTsserverPath();
      if (!tsserver) return null;
      return { ...command, initializationOptions: { tsserver: { path: tsserver } } };
    },
  },
  {
    id: "python",
    extensions: [".py"],
    rootMarkers: [
      "pyrightconfig.json",
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
    ],
    languageIdFor: () => "python",
    resolveCommand(projectRoot) {
      return resolveNodeServer("pyright", "pyright-langserver", projectRoot, ["--stdio"]);
    },
  },
  {
    id: "go",
    extensions: [".go"],
    rootMarkers: ["go.mod"],
    languageIdFor: () => "go",
    resolveCommand(projectRoot) {
      const bin = findExecutable("gopls", projectRoot);
      return bin ? { command: bin, args: ["serve"] } : null;
    },
  },
  {
    id: "rust",
    extensions: [".rs"],
    rootMarkers: ["Cargo.toml"],
    languageIdFor: () => "rust",
    resolveCommand(projectRoot) {
      const bin = findExecutable("rust-analyzer", projectRoot);
      return bin ? { command: bin, args: [] } : null;
    },
  },
  {
    id: "clangd",
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"],
    rootMarkers: ["compile_commands.json", ".clangd", "CMakeLists.txt"],
    languageIdFor: (extension) => (extension === ".c" || extension === ".h" ? "c" : "cpp"),
    resolveCommand(projectRoot) {
      const bin = findExecutable("clangd", projectRoot);
      return bin ? { command: bin, args: ["--log=error"] } : null;
    },
  },
];

/** Server spec for a file path, or null when no server covers its extension. */
export function serverForFile(
  filePath: string,
  catalog: readonly LspServerSpec[] = LSP_SERVER_CATALOG,
): LspServerSpec | null {
  const extension = path.extname(filePath).toLowerCase();
  if (!extension) return null;
  return catalog.find((spec) => spec.extensions.includes(extension)) ?? null;
}

/**
 * Nearest directory containing one of `markers`, walking up from the file's
 * directory. The walk is capped at `ceiling` when the file lives under it.
 * Falls back to the file's own directory when no marker is found.
 */
export function findProjectRoot(
  filePath: string,
  markers: readonly string[],
  ceiling: string,
): string {
  const fileDir = path.dirname(path.resolve(filePath));
  const cap = path.resolve(ceiling);
  const underCeiling = fileDir === cap || fileDir.startsWith(cap + path.sep);

  let dir = fileDir;
  for (;;) {
    for (const marker of markers) {
      try {
        fs.statSync(path.join(dir, marker));
        return dir;
      } catch {
        // marker absent — keep walking
      }
    }
    if (underCeiling && dir === cap) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fileDir;
}
