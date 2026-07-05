import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve a dependency-backed stdio MCP server to a direct `node <binScript>`
 * invocation instead of `npx -y <pkg>`.
 *
 * `npx` (= `npm exec`) spawns a full Node "wrapper" process (~100 MB RSS) whose
 * only job is to resolve the package and spawn the REAL server — doubling the
 * memory of every connection. When the package ships as a ggcoder dependency we
 * can skip the wrapper entirely: resolve the package's bin entry script and run
 * it with `process.execPath` (the same Node already running). This mirrors the
 * LSP server resolution in `core/lsp/servers.ts` (`resolveNodeServer`), which
 * spawns Node-based language servers via `process.execPath` + the real bin
 * script, never the `node_modules/.bin` shim (shims need `node` on PATH).
 *
 * Only `npx`/`npm exec` invocations of a known, locally-resolvable package are
 * rewritten. Everything else (other commands, unresolvable packages) passes
 * through unchanged, so behavior degrades gracefully to the original `npx` path.
 */

/** Directory of this module — anchor for resolving ggcoder's own bundled deps. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Find a file at `node_modules/<relPath>` walking up from `start`.
 * Deterministic fs checks only — no resolver hooks, no createRequire (whose
 * resolution can be patched by dev runners and global fallback paths). Mirrors
 * `findInNodeModulesUp` in `core/lsp/servers.ts`.
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
 * `node_modules/.bin` shim). `binName` selects which bin when a package exposes
 * several; defaults to the package's sole/string bin. Returns an absolute path
 * to the script, or null when the package or its bin can't be resolved.
 */
export function findPackageBinScript(
  pkgName: string,
  binName: string,
  start: string = MODULE_DIR,
): string | null {
  const pkgJsonPath = findInNodeModulesUp(path.join(pkgName, "package.json"), start);
  if (!pkgJsonPath) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const bin = selectBin(pkg.bin, binName);
    if (!bin) return null;
    const script = path.join(path.dirname(pkgJsonPath), bin);
    return fs.existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

/**
 * Pick a package's bin script path from its `bin` field.
 * - string bin → that path.
 * - object with exactly ONE entry → that entry, whatever its key. (The bin name
 *   very often differs from the unscoped package name — e.g. `@z_ai/mcp-server`
 *   exposes `zai-mcp-server` — so keying by package name would wrongly miss it.
 *   npx runs a sole bin regardless of its name; we mirror that.)
 * - object with several entries → the one keyed by `binName` (needed to
 *   disambiguate), else null.
 */
function selectBin(
  bin: string | Record<string, string> | undefined,
  binName: string,
): string | undefined {
  if (!bin) return undefined;
  if (typeof bin === "string") return bin;
  const keys = Object.keys(bin);
  if (keys.length === 1) return bin[keys[0]];
  return bin[binName];
}

/**
 * Parse an `npx`/`npm exec` command + args into the target package spec, or null
 * when the command isn't an npx/npm-exec invocation. Skips npx flags (`-y`,
 * `--yes`, `-p <pkg>`, `--package <pkg>`, `--`) to find the package positional.
 * The returned `pkg` keeps any leading `@scope/name`; a trailing `@version` is
 * stripped for resolution since the installed copy's version is authoritative.
 */
export function parseNpxPackage(command: string, args: readonly string[]): string | null {
  const base = path.basename(command).toLowerCase();
  let rest: readonly string[];
  if (base === "npx" || base === "npx.cmd") {
    rest = args;
  } else if (base === "npm" || base === "npm.cmd") {
    if (args[0] !== "exec") return null;
    rest = args.slice(1);
  } else {
    return null;
  }

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-y" || a === "--yes" || a === "--prefer-offline" || a === "--prefer-online") {
      continue;
    }
    if (a === "-p" || a === "--package") {
      i++; // skip the package flag's value; the positional (if any) still wins
      continue;
    }
    if (a === "--") continue;
    if (a.startsWith("-")) continue;
    return a; // first non-flag positional is the package spec
  }
  return null;
}

/** Strip a trailing `@version` from a package spec, preserving a leading scope. */
function stripVersion(pkgSpec: string): string {
  if (pkgSpec.startsWith("@")) {
    const slash = pkgSpec.indexOf("/");
    if (slash === -1) return pkgSpec;
    const at = pkgSpec.indexOf("@", slash);
    return at === -1 ? pkgSpec : pkgSpec.slice(0, at);
  }
  const at = pkgSpec.indexOf("@");
  return at === -1 ? pkgSpec : pkgSpec.slice(0, at);
}

/**
 * Extract a trailing `@version` pin from a package spec, or `undefined` when
 * unpinned. Complement of `stripVersion`: `@z_ai/mcp-server@1.2.3` → `"1.2.3"`,
 * `@z_ai/mcp-server` → `undefined`, `foo@2.0.0` → `"2.0.0"`.
 */
function versionPinOf(pkgSpec: string): string | undefined {
  if (pkgSpec.startsWith("@")) {
    const slash = pkgSpec.indexOf("/");
    if (slash === -1) return undefined;
    const at = pkgSpec.indexOf("@", slash);
    return at === -1 ? undefined : pkgSpec.slice(at + 1);
  }
  const at = pkgSpec.indexOf("@");
  return at === -1 ? undefined : pkgSpec.slice(at + 1);
}

/** Compare two dotted numeric version strings (highest first via sort). Numeric
 *  segments compare numerically; non-numeric (pre-release) tiebreak lexically.
 *  Returns >0 when `a` > `b`, <0 when `a` < `b`, 0 when equal. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10);
    const nb = Number.parseInt(pb[i] ?? "0", 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const c = (pa[i] ?? "").localeCompare(pb[i] ?? "");
      if (c !== 0) return c;
    } else if (na !== nb) {
      return na - nb;
    }
  }
  return 0;
}

/**
 * Candidate `_npx` cache roots where `npx -y <pkg>` installs on-demand packages
 * (`<cache>/_npx/<hash>/node_modules/<pkg>`). Ordered by trust: an explicit
 * `npm_config_cache` first, then the POSIX/npm default (`~/.npm`), then the
 * Windows default (`%LOCALAPPDATA%\npm-cache`). De-duplicated.
 */
function npxCacheRoots(): string[] {
  const roots: string[] = [];
  const envCache = process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE;
  if (envCache) roots.push(path.join(envCache, "_npx"));
  roots.push(path.join(os.homedir(), ".npm", "_npx"));
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) roots.push(path.join(localAppData, "npm-cache", "_npx"));
  return roots.filter((r, i) => roots.indexOf(r) === i);
}

/**
 * Resolve a package's real bin script from npx's on-demand cache. This is where
 * `npx -y <pkg>` installs a server on first run, so from the SECOND launch
 * onward we can spawn the real bin directly with `process.execPath` and skip
 * npx's ~90 MB `npm exec` wrapper — for ANY package, including user-added MCP
 * servers we don't (and can't) bundle.
 *
 * `versionPin` (from a `<pkg>@x.y.z` spec) is honoured strictly: a cached copy
 * is used only when its `package.json` version matches exactly, so a pin never
 * silently resolves to the wrong cached version (it falls through to npx, which
 * resolves the pin correctly). Unpinned specs take the highest cached version.
 * Deterministic fs reads only — no resolver hooks.
 */
export function findNpxCachedBinScript(
  pkgName: string,
  binName: string,
  versionPin?: string,
): string | null {
  const segs = pkgName.split("/");
  const candidates: { version: string; script: string }[] = [];
  for (const root of npxCacheRoots()) {
    let hashes: string[];
    try {
      hashes = fs.readdirSync(root);
    } catch {
      continue; // this cache root doesn't exist
    }
    for (const hash of hashes) {
      const pkgJsonPath = path.join(root, hash, "node_modules", ...segs, "package.json");
      let pkg: { version?: string; bin?: string | Record<string, string> };
      try {
        pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
      } catch {
        continue; // no such cached package here
      }
      const version = typeof pkg.version === "string" ? pkg.version : "";
      if (versionPin && version !== versionPin) continue; // honour the pin
      const bin = selectBin(pkg.bin, binName);
      if (!bin) continue;
      const script = path.join(path.dirname(pkgJsonPath), bin);
      if (fs.existsSync(script)) candidates.push({ version, script });
    }
  }
  if (candidates.length === 0) return null;
  // Highest cached version wins — deterministic when several are cached.
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0].script;
}

/** Derive the conventional bin name from a package name (drop the scope). */
function binNameFor(pkgName: string): string {
  return pkgName.startsWith("@") ? (pkgName.split("/")[1] ?? pkgName) : pkgName;
}

export interface ResolvedStdioCommand {
  command: string;
  args: string[];
}

/**
 * Rewrite a stdio `{ command, args }` to a direct `node <binScript>` invocation
 * when it's an `npx`/`npm exec` of a package whose bin script is resolvable
 * either from ggcoder's install (bundled/dep) OR from npx's on-demand cache
 * (`~/.npm/_npx/...`, populated on the package's first run). Returns the
 * original `{ command, args }` unchanged otherwise (non-npx command, or the
 * package isn't cached yet — the true first run, which npx then installs).
 */
export function resolveStdioCommand(
  command: string,
  args: readonly string[] = [],
): ResolvedStdioCommand {
  const passthrough: ResolvedStdioCommand = { command, args: [...args] };

  const pkgSpec = parseNpxPackage(command, args);
  if (!pkgSpec) return passthrough;

  const pkgName = stripVersion(pkgSpec);
  const binName = binNameFor(pkgName);
  // 1) Local resolution (bundled next to the sidecar / ggcoder deps) — fastest,
  //    version-authoritative. 2) npx on-demand cache — covers non-bundled
  //    defaults (e.g. zai) and any user-added MCP once npx has cached it.
  const binScript =
    findPackageBinScript(pkgName, binName) ??
    findNpxCachedBinScript(pkgName, binName, versionPinOf(pkgSpec));
  if (!binScript) return passthrough;

  // Drop the npx package positional + its flags; forward only the args that
  // come AFTER the package spec (the server's own args, usually after `--`).
  const tail = serverArgsAfterPackage(command, args, pkgSpec);
  return { command: process.execPath, args: [binScript, ...tail] };
}

/**
 * The args intended for the server itself — everything after the package
 * positional in an npx/npm-exec command. `--` separators are dropped.
 */
function serverArgsAfterPackage(
  command: string,
  args: readonly string[],
  pkgSpec: string,
): string[] {
  const base = path.basename(command).toLowerCase();
  const start = base === "npm" || base === "npm.cmd" ? 1 : 0; // skip `exec`
  const idx = args.indexOf(pkgSpec, start);
  if (idx === -1) return [];
  return args.slice(idx + 1).filter((a) => a !== "--");
}
