/**
 * Package-install guard. Blocks only on concrete signals; everything else
 * passes silently. A catch is a block with one plain line for the agent.
 *
 * - Known malware: local threat feed (instant) + OSV querybatch with the exact
 *   version that would install (name-only queries flag every package that
 *   ever had one bad release, e.g. chalk/debug).
 * - Lockfile installs (`npm ci`, `pnpm install`, `uv sync`, …): every locked
 *   name@version, cached by lockfile hash.
 * - Release age when the manager has no native cooldown (P3).
 * - Provenance downgrade: previous version had attestations, this one not (P4).
 * - Typosquat: one edit from a popular name AND new / missing / barely used (P5).
 *
 * Network only for install commands, parallel, one ≤2.5 s deadline, fail-open.
 * Clean answers are cached on disk (package-verdicts.json in the GG dir).
 */
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import { getAppPaths } from "@kleio/core";
import path from "node:path";
import { log } from "./logger.js";
import { POPULAR_NPM_PACKAGES, POPULAR_PYPI_PACKAGES } from "./shell-threats-popular-packages.js";
import type { BlockedPackage, ShellThreat } from "./shell-threats.js";
import { SAFETY_BLOCK_NOTE } from "./action-threats.js";
import {
  compareVersions,
  emptyFeed,
  feedMatches,
  loadThreatFeed,
  type ThreatFeedData,
  writeJsonAtomic,
} from "./threat-feed.js";
import {
  hasNativeCooldown,
  managerVersion,
  type PackageManager,
  usesCustomNpmRegistry,
  usesCustomPypiIndex,
} from "./package-cooldown.js";

export type PackageEcosystem = "npm" | "PyPI";

export interface PackageRef {
  ecosystem: PackageEcosystem;
  name: string;
  /** Version, range or dist-tag as written (`5.3.0`, `^5`, `next`); undefined when unpinned. */
  spec?: string;
  manager: PackageManager | "npx" | "uvx";
}

export interface LockfileInstall {
  ecosystem: PackageEcosystem;
  manager: PackageManager;
  /** Lockfile path relative to the command's directory. */
  file: string;
  /** The command re-resolves (`uv sync --upgrade`): the locked-age check doesn't apply. */
  resolves?: boolean;
}

export interface PackageCheckOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Directory the command runs in (lockfiles are read from here). */
  cwd?: string;
  /** Release-age cooldown in days (0 disables the age check). */
  cooldownDays?: number;
  now?: () => number;
  feed?: ThreatFeedData;
  /** Verdict cache dir; null = memory only. Default: the GG dir (memory only under vitest). */
  cacheDir?: string | null;
  /** Environment for registry settings (default process.env; tests). */
  env?: NodeJS.ProcessEnv;
  /** Override manager version detection (tests). */
  managerVersion?: (manager: PackageManager) => Promise<string | null>;
}

const OSV_URL = "https://api.osv.dev/v1/querybatch";
/** Full advisories for one version (severity + fixed versions); only asked when flawed. */
const OSV_QUERY_URL = "https://api.osv.dev/v1/query";
const NPM_REGISTRY = "https://registry.npmjs.org";
const NPM_DOWNLOADS = "https://api.npmjs.org/downloads/point/last-week";
const PYPI = "https://pypi.org/pypi";
const TIMEOUT_MS = 2_500;
const OSV_BATCH = 1000;
const DAY_MS = 86_400_000;
const TYPOSQUAT_NEW_DAYS = 90;
const TYPOSQUAT_MIN_WEEKLY = 500;
const NPM_INSTALL = new Set(["add", "install", "i"]);

// Per-process caches; answers are stable within a session.
/**
 * OSV answers by `eco:name@version`: MAL ids, whether it has any other
 * (vulnerability) advisories, and when asked. Clean answers expire after a day.
 */
const osvCache = new Map<string, { ids: string[]; flawed: boolean; at: number }>();
/** Serious-flaw verdicts by `eco:name@version` (detailed OSV query), with when asked. */
const vulnCache = new Map<string, { verdict: VulnVerdict | null; at: number }>();
const metaCache = new Map<string, Promise<unknown>>();
const lockfileCache = new Map<string, LockVerdict>();

// ── Parsing ───────────────────────────────────────────────

/** Split `react@18`, `@a/b@1`, `requests==2.0`, `x[extra]>=1` into name + spec. */
function splitSpec(
  raw: string,
  ecosystem: PackageEcosystem,
): { name: string; spec?: string } | null {
  if (ecosystem === "npm") {
    const at = raw.indexOf("@", 1);
    const name = at === -1 ? raw : raw.slice(0, at);
    const spec = at === -1 ? undefined : raw.slice(at + 1) || undefined;
    if (spec?.startsWith("npm:") || spec?.includes(":") || spec?.includes("/")) return null;
    return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)
      ? { name: name.toLowerCase(), spec }
      : null;
  }
  const m = /^([a-z0-9][a-z0-9._-]*)(?:\[[^\]]*\])?(.*)$/i.exec(raw);
  if (!m) return null;
  const name = (m[1] ?? "").toLowerCase().replace(/[._]+/g, "-");
  const rest = (m[2] ?? "").split(";")[0]?.trim() ?? "";
  if (rest.startsWith("@")) return null; // PEP 508 URL
  const pin = /^===?\s*([^\s,*]+)$/.exec(rest);
  return { name, spec: pin ? pin[1] : rest || undefined };
}

function tokenize(segment: string): string[] {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^['"]|['"]$/g, ""))
    .filter((t) => t.length > 0);
  while (tokens[0] === "sudo" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) tokens.shift();
  return tokens;
}

function segments(command: string): string[] {
  return command.split(/(?:&&|\|\||[;|\n])/);
}

const VALUE_FLAGS =
  /^(?:-r|-c|-e|--requirement|--constraint|--editable|--registry|-i|--index-url|--extra-index-url|--filter|-F|-C|--dir|--prefix|-w|--workspace|--python|-p|--package|--with|--from)$/;

/** Packages named by install commands in `command`. Local paths/URLs/git are skipped. */
export function parsePackageInstalls(command: string): PackageRef[] {
  const refs: PackageRef[] = [];
  for (const segment of segments(command)) {
    const [program, sub, ...rest] = tokenize(segment);
    let ecosystem: PackageEcosystem | null = null;
    let manager: PackageRef["manager"] = "npm";
    let args: string[] = [];
    let first = false;
    if ((program === "npx" || program === "bunx") && sub !== undefined) {
      ecosystem = "npm";
      manager = program === "npx" ? "npx" : "bun";
      args = [sub, ...rest];
      first = true;
    } else if (
      (program === "pnpm" || program === "yarn" || program === "npm") &&
      (sub === "dlx" || sub === "exec") &&
      program !== "yarn"
    ) {
      ecosystem = "npm";
      manager = program === "npm" ? "npx" : "pnpm";
      args = rest;
      first = true;
    } else if (
      (program === "npm" || program === "pnpm" || program === "yarn" || program === "bun") &&
      sub !== undefined &&
      NPM_INSTALL.has(sub)
    ) {
      ecosystem = "npm";
      manager = program;
      args = rest;
    } else if ((program === "pip" || program === "pip3") && sub === "install") {
      ecosystem = "PyPI";
      manager = "pip";
      args = rest;
    } else if (program === "pipx" && (sub === "run" || sub === "install")) {
      ecosystem = "PyPI";
      manager = "pip";
      args = rest;
      first = sub === "run";
    } else if (program === "uv" && sub === "pip" && rest[0] === "install") {
      ecosystem = "PyPI";
      manager = "uv";
      args = rest.slice(1);
    } else if (program === "uv" && sub === "add") {
      ecosystem = "PyPI";
      manager = "uv";
      args = rest;
    } else if (program === "uvx" && sub !== undefined) {
      ecosystem = "PyPI";
      manager = "uvx";
      args = [sub, ...rest];
      first = true;
    } else if (program === "uv" && sub === "tool" && (rest[0] === "run" || rest[0] === "install")) {
      ecosystem = "PyPI";
      manager = "uvx";
      args = rest.slice(1);
      first = rest[0] === "run";
    }
    if (!ecosystem) continue;
    let skipNext = false;
    for (const arg of args) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (arg === "--") {
        if (first) break;
        continue;
      }
      if (VALUE_FLAGS.test(arg)) {
        skipNext = true;
        continue;
      }
      if (arg.startsWith("-")) continue;
      const local = /[/\\:]/.test(arg.replace(/^@[^/]+\//, "")) || arg.startsWith(".");
      const parsed = local ? null : splitSpec(arg, ecosystem);
      if (parsed) refs.push({ ecosystem, manager, ...parsed });
      if (first) break; // npx/uvx: only the package positional
    }
  }
  return refs;
}

/** No-arg installs that install a whole lockfile. */
export function parseLockfileInstalls(command: string): LockfileInstall[] {
  const out: LockfileInstall[] = [];
  let dir = "";
  for (const segment of segments(command)) {
    const tokens = tokenize(segment);
    const [program, sub, ...rest] = tokens;
    if (program === "cd" && sub !== undefined) {
      dir = path.join(dir, sub);
      continue;
    }
    const positional = rest.filter((a) => !a.startsWith("-"));
    const at = (file: string): string => path.join(dir, file);
    if (
      program === "npm" &&
      (sub === "ci" || ((sub === "install" || sub === "i") && positional.length === 0))
    ) {
      out.push({ ecosystem: "npm", manager: "npm", file: at("package-lock.json") });
    } else if (
      program === "pnpm" &&
      (sub === "install" || sub === "i") &&
      positional.length === 0
    ) {
      out.push({ ecosystem: "npm", manager: "pnpm", file: at("pnpm-lock.yaml") });
    } else if (
      program === "yarn" &&
      (sub === undefined || sub.startsWith("-") || (sub === "install" && positional.length === 0))
    ) {
      out.push({ ecosystem: "npm", manager: "yarn", file: at("yarn.lock") });
    } else if (program === "bun" && (sub === "install" || sub === "i") && positional.length === 0) {
      out.push({ ecosystem: "npm", manager: "bun", file: at("bun.lock") });
    } else if (program === "uv" && sub === "sync") {
      const resolves = rest.some(
        (a) => a === "--upgrade" || a.startsWith("--upgrade-package") || a === "-U" || a === "-P",
      );
      out.push({ ecosystem: "PyPI", manager: "uv", file: at("uv.lock"), resolves });
    } else if (
      ((program === "pip" || program === "pip3") && sub === "install") ||
      (program === "uv" && sub === "pip" && (rest[0] === "install" || rest[0] === "sync"))
    ) {
      const args = program === "uv" ? rest.slice(1) : rest;
      for (let i = 0; i < args.length; i++) {
        const a = args[i] ?? "";
        if ((a === "-r" || a === "--requirement") && args[i + 1]) {
          out.push({
            ecosystem: "PyPI",
            manager: program === "uv" ? "uv" : "pip",
            file: at(args[i + 1] ?? ""),
          });
        } else if (a.startsWith("--requirement=")) {
          out.push({ ecosystem: "PyPI", manager: "pip", file: at(a.slice(14)) });
        } else if (program === "uv" && rest[0] === "sync" && !a.startsWith("-")) {
          out.push({ ecosystem: "PyPI", manager: "uv", file: at(a) });
        }
      }
    }
  }
  return out;
}

export interface LockedPackage {
  name: string;
  version: string;
}

type AddLocked = (name: string, version: string) => void;

/** The line reader met a package-lock shape it can't read exactly. */
class UnsupportedLockShape extends Error {}

/** Per-line parser for the line-oriented lockfile formats (state kept in the closure). */
function lineParser(base: string, add: AddLocked): (line: string) => void {
  if (base === "pnpm-lock.yaml") {
    let inPackages = false;
    return (line) => {
      if (/^\S/.test(line)) inPackages = line === "packages:" || line === "snapshots:";
      if (!inPackages) return;
      const m = /^ {2}'?\/?((?:@[^@/'\s]+\/)?[^@/'\s]+)@([^('\s:]+)/.exec(line);
      if (m) add(m[1] ?? "", m[2] ?? "");
    };
  }
  if (base === "yarn.lock") {
    let names: string[] = [];
    return (line) => {
      if (/^\S/.test(line) && line.endsWith(":")) {
        names = line
          .slice(0, -1)
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""))
          .map((s) => s.slice(0, s.indexOf("@", 1)))
          .filter((s) => s.length > 0);
        return;
      }
      const v = /^ {2}version:? "?([^"\s]+)"?/.exec(line);
      if (v && names[0]) add(names[0], v[1] ?? "");
    };
  }
  if (base === "bun.lock") {
    return (line) => {
      const m = /^\s*"[^"]+":\s*\[\s*"((?:@[^@/"]+\/)?[^@/"]+)@([^"]+)"/.exec(line);
      if (m) add(m[1] ?? "", m[2] ?? "");
    };
  }
  if (base === "uv.lock") {
    let name = "";
    return (line) => {
      if (line === "[[package]]") name = "";
      const n = /^name = "([^"]+)"/.exec(line);
      if (n) name = n[1] ?? "";
      const v = /^version = "([^"]+)"/.exec(line);
      if (v && name) add(name.replace(/[._]+/g, "-"), v[1] ?? "");
    };
  }
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") {
    // Pretty-printed (2-space) package-lock, read line by line so a huge one
    // never needs one long JSON.parse. Same answers as the JSON walk.
    let section = "";
    let key: string | null = null;
    let fields: { version?: string; name?: string; link?: boolean } = {};
    return (line) => {
      const top = /^ {2}"([^"]+)": \{/.exec(line);
      if (top) {
        section = top[1] ?? "";
        key = null;
        return;
      }
      if (section !== "packages" && section !== "dependencies") return;
      const open = /^ {4}"((?:[^"\\]|\\.)*)": \{(\}?),?$/.exec(line);
      // An entry line we don't fully recognise (hand-formatted, inline
      // objects): let the caller fall back to the exact JSON walk.
      if (!open && /^ {4}"/.test(line)) throw new UnsupportedLockShape();
      if (open) {
        key = open[1] ?? "";
        fields = {};
        if (!open[2]) return;
      } else if (key !== null && /^ {4}\},?$/.test(line)) {
        // close: fall through to emit
      } else {
        if (key === null) return;
        const f = /^ {6}"(version|name|link)": (?:"((?:[^"\\]|\\.)*)"|(true|false)),?$/.exec(line);
        if (!f && /^ {6}"(?:version|name|link)"/.test(line)) throw new UnsupportedLockShape();
        if (f?.[1] === "link") fields.link = f[3] === "true";
        else if (f?.[1] === "version") fields.version = f[2];
        else if (f?.[1] === "name") fields.name = f[2];
        return;
      }
      const k = key ?? "";
      key = null;
      if (section === "dependencies") {
        add(k, fields.version ?? "");
        return;
      }
      const idx = k.lastIndexOf("node_modules/");
      if (idx < 0 || fields.link || !fields.version) return;
      add(fields.name ?? k.slice(idx + 13), fields.version);
    };
  }
  // requirements file: only exact pins
  return (line) => {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([^\s;#,]+)/.exec(line);
    if (m) add((m[1] ?? "").replace(/[._]+/g, "-"), m[2] ?? "");
  };
}

function lockedCollector(): { add: AddLocked; out: Map<string, LockedPackage> } {
  const out = new Map<string, LockedPackage>();
  return {
    out,
    add: (name, version) => {
      if (!name || !/^\d/.test(version)) return;
      out.set(`${name}@${version}`, { name: name.toLowerCase(), version });
    },
  };
}

const stripBom = (raw: string): string => (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
const isNpmLock = (base: string): boolean =>
  base === "package-lock.json" || base === "npm-shrinkwrap.json";

/** A package-lock the line reader handles: 2-space pretty JSON that is complete. */
function npmLockByLines(text: string): boolean {
  return /^\{\r?\n {2}"/.test(text) && /\}\s*$/.test(text);
}

/** JSON walk of a package-lock (minified or odd indentation). */
function parseNpmLockJson(text: string, add: AddLocked): boolean {
  try {
    const json = JSON.parse(text) as {
      packages?: Record<string, { version?: string; name?: string; link?: boolean }>;
      dependencies?: Record<string, { version?: string }>;
    };
    for (const [key, v] of Object.entries(json.packages ?? {})) {
      const idx = key.lastIndexOf("node_modules/");
      if (idx < 0 || v.link || !v.version) continue;
      add(v.name ?? key.slice(idx + 13), v.version);
    }
    for (const [name, v] of Object.entries(json.dependencies ?? {})) add(name, v.version ?? "");
    return true;
  } catch {
    return false;
  }
}

/** Parse name@version pairs from a lockfile's text. Unknown shapes yield []. */
export function parseLockfile(file: string, raw: string): LockedPackage[] {
  const text = stripBom(raw); // BOM (Windows editors)
  const base = path.basename(file);
  const { add, out } = lockedCollector();
  if (isNpmLock(base)) return parseNpmLockJson(text, add) ? [...out.values()] : [];
  const onLine = lineParser(base, add);
  for (const line of text.split(/\r?\n/)) onLine(line);
  return [...out.values()];
}

const SLICE_MS = 4;
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * `parseLockfile` for the event loop's sake: walks lines in slices of a few
 * ms with a yield in between, so a 50k-entry lockfile never stalls the
 * sidecar (shared by every app window). Same results.
 */
export async function parseLockfileAsync(file: string, raw: string): Promise<LockedPackage[]> {
  const text = stripBom(raw);
  const base = path.basename(file);
  const { add, out } = lockedCollector();
  if (isNpmLock(base) && !npmLockByLines(text)) {
    // Truncated (no closing brace) can't be valid JSON: skip the long parse.
    if (!/\}\s*$/.test(text)) return [];
    return parseNpmLockJson(text, add) ? [...out.values()] : [];
  }
  try {
    await readLinesInSlices(text, lineParser(base, add));
  } catch (err) {
    if (!(err instanceof UnsupportedLockShape)) throw err;
    const exact = lockedCollector();
    return parseNpmLockJson(text, exact.add) ? [...exact.out.values()] : [];
  }
  return [...out.values()];
}

/** Feed `text` line by line to `onLine`, yielding to the event loop every few ms. */
async function readLinesInSlices(text: string, onLine: (line: string) => void): Promise<void> {
  let start = 0;
  let sliceAt = performance.now();
  let n = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl;
    const line = text.slice(start, end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end);
    onLine(line);
    start = end + 1;
    if (++n % 128 === 0 && performance.now() - sliceAt > SLICE_MS) {
      await yieldToLoop();
      sliceAt = performance.now();
    }
  }
}

/** sha256 of a big text in slices with yields (hashing 13 MB at once is ~20 ms). */
async function hashInSlices(text: string): Promise<string> {
  const h = createHash("sha256");
  const step = 1 << 20;
  for (let i = 0; i < text.length; i += step) {
    h.update(text.slice(i, i + step));
    if (i + step < text.length) await yieldToLoop();
  }
  return h.digest("hex");
}

// ── Typosquat (local candidate) ──────────────────────────

/** Optimal-string-alignment Damerau-Levenshtein distance. */
export function damerauLevenshtein(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  const at = (i: number, j: number): number => d[i]?.[j] ?? Number.POSITIVE_INFINITY;
  for (let i = 1; i <= a.length; i++) {
    const row = d[i];
    if (!row) continue;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, at(i - 2, j - 2) + 1);
      }
      row[j] = v;
    }
  }
  return at(a.length, b.length);
}

const popularSets = {
  npm: new Set(POPULAR_NPM_PACKAGES),
  PyPI: new Set(POPULAR_PYPI_PACKAGES),
};

/** The popular name `ref` is one edit away from, or null. Local only. */
export function typosquatCandidate(ref: Pick<PackageRef, "ecosystem" | "name">): string | null {
  const popular = ref.ecosystem === "npm" ? POPULAR_NPM_PACKAGES : POPULAR_PYPI_PACKAGES;
  if (popularSets[ref.ecosystem].has(ref.name)) return null;
  return (
    popular.find(
      (p) => Math.abs(p.length - ref.name.length) <= 1 && damerauLevenshtein(p, ref.name) === 1,
    ) ?? null
  );
}

// ── Local check (no network) ─────────────────────────────

export interface LocalCheck {
  refs: PackageRef[];
  lockfiles: LockfileInstall[];
  /** Blocks known from the local feed alone. */
  threats: ShellThreat[];
  typosquats: Array<{ ref: PackageRef; popular: string }>;
  /** Names already blocked by the local feed. */
  flagged: Set<string>;
  /** The feed used (loaded only when the command installs something). */
  feed: ThreatFeedData;
}

function isExact(spec: string | undefined): spec is string {
  return spec !== undefined && /^v?\d+(?:\.\d+)*(?:[-.+][0-9A-Za-z.-]+)?$/.test(spec);
}

function label(ref: PackageRef, version?: string): string {
  return version ? `${ref.name}@${version}` : ref.name;
}

/** Instant part of the check: parsing, typosquat candidates and local feed hits. */
export function localPackageCheck(
  command: string,
  feedOrLoad: ThreatFeedData | (() => ThreatFeedData),
): LocalCheck {
  const refs = parsePackageInstalls(command);
  const lockfiles = refs.length === 0 ? parseLockfileInstalls(command) : [];
  if (refs.length === 0 && lockfiles.length === 0) {
    return { refs, lockfiles, threats: [], typosquats: [], flagged: new Set(), feed: emptyFeed() };
  }
  const feed = typeof feedOrLoad === "function" ? feedOrLoad() : feedOrLoad;
  const threats: ShellThreat[] = [];
  const typosquats: LocalCheck["typosquats"] = [];
  const flagged = new Set<string>();
  for (const ref of refs) {
    const version = isExact(ref.spec) ? ref.spec.replace(/^v/, "") : undefined;
    const ids = feedMatches(feed, ref.ecosystem, ref.name, version);
    if (ids.length > 0) {
      threats.push(malwareThreat(ref, version, ids, null, 0));
      flagged.add(ref.name);
      continue;
    }
    const popular = typosquatCandidate(ref);
    if (popular) typosquats.push({ ref, popular });
  }
  return { refs, lockfiles, threats, typosquats, flagged, feed };
}

function malwareThreat(
  ref: PackageRef,
  version: string | undefined,
  ids: string[],
  safe: string | null,
  days: number,
): ShellThreat {
  const instead = safe
    ? `use ${ref.name}@${safe}, the last version older than ${days} days`
    : "pick a different version or package";
  return {
    rule: "malicious-package",
    severity: "block",
    detail: `${label(ref, version)} is flagged as malware (${ids.join(", ")}); ${instead}.`,
    blocked: [
      {
        ecosystem: ref.ecosystem,
        name: ref.name,
        ...(version ? { version } : {}),
        reason: `known malware (${ids.join(", ")})`,
      },
    ],
  };
}

// ── Registry metadata (network) ──────────────────────────

interface NpmVersionDoc {
  dist?: { attestations?: unknown };
}
interface NpmDoc {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, NpmVersionDoc>;
  time?: Record<string, string>;
}
interface PypiDoc {
  info?: { version?: string };
  releases?: Record<string, Array<{ upload_time_iso_8601?: string; yanked?: boolean }>>;
}

class NotFound {}

async function getJson(
  url: string,
  ctx: Ctx,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const key = `${headers.accept ?? ""} ${url}`;
  let hit = metaCache.get(key);
  if (!hit) {
    hit = fetchJson(url, { headers }, ctx, true);
    metaCache.set(key, hit);
    // A failed fetch should be retried next install, not cached.
    hit.catch(() => metaCache.delete(key));
  }
  return hit;
}

/**
 * Hosts that just failed or stalled: skipped (fail-open, instantly) for a
 * short while so an offline machine or a hung registry costs the deadline
 * once, not on every install.
 */
const downHosts = new Map<string, number>();
const DOWN_MS = 2 * 60_000;
/** Key for "nothing answered before the deadline" (offline, dead proxy): every host waits. */
const ALL_HOSTS = "*";

/** After a deadline cut: if no host answered at all, the network itself is down for a while. */
function noteDeadline(ctx: Ctx): void {
  if (!ctx.cancelled() && !ctx.reached.value) downHosts.set(ALL_HOSTS, Date.now() + DOWN_MS);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** fetch + status + JSON, honouring and feeding the down-host memory. 404 → NotFound when asked. */
async function fetchJson(
  url: string,
  init: RequestInit,
  ctx: Ctx,
  notFound = false,
): Promise<unknown> {
  const host = hostOf(url);
  const down = Math.max(downHosts.get(host) ?? 0, downHosts.get(ALL_HOSTS) ?? 0);
  if (Date.now() < down) throw new Error(`${host} recently unreachable`);
  try {
    // Raced with the signal too: a fetch that ignores aborts must not hang us.
    return await Promise.race([
      (async () => {
        const res = await ctx.fetch(url, { ...init, signal: ctx.signal });
        if (res.status < 500) ctx.reached.value = true;
        if (notFound && res.status === 404) return new NotFound();
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return res.json();
      })(),
      deadline(ctx.signal),
    ]);
  } catch (err) {
    // A cancel by the caller says nothing about the host; a network error,
    // 4xx other than 404 (429, proxy 403/407), 5xx, bad JSON or our deadline does.
    if (!ctx.cancelled()) downHosts.set(host, Date.now() + DOWN_MS);
    throw err;
  }
}

const enc = (name: string): string => name.replace("/", "%2F");

/** Abbreviated packument (no publish times); the full one only when times are needed. */
function npmDoc(name: string, full: boolean, ctx: Ctx): Promise<unknown> {
  const accept = full ? "application/json" : "application/vnd.npm.install-v1+json";
  // A full doc already fetched answers abbreviated questions too.
  const fullKey = `application/json ${NPM_REGISTRY}/${enc(name)}`;
  if (!full && metaCache.has(fullKey))
    return getJson(`${NPM_REGISTRY}/${enc(name)}`, ctx, { accept: "application/json" });
  return getJson(`${NPM_REGISTRY}/${enc(name)}`, ctx, { accept });
}
function pypiDoc(name: string, ctx: Ctx): Promise<unknown> {
  return getJson(`${PYPI}/${name}/json`, ctx);
}

function isStable(v: string): boolean {
  return /^\d+(?:\.\d+)*$/.test(v);
}

/** Highest version satisfying a simple npm range (exact, ^, ~, x, >=). Null if unsupported. */
function maxSatisfying(versions: string[], range: string): string | null {
  const r = range.trim();
  const m = /^(\^|~|>=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(r);
  if (r === "*" || r === "x" || r === "") return pickMax(versions.filter(isStable));
  if (!m) return null;
  const op = m[1] ?? "";
  const nums = [m[2], m[3], m[4]].map((n) =>
    n === undefined || n === "x" || n === "*" ? null : Number(n),
  );
  const [maj, min, pat] = nums;
  const ok = (v: string): boolean => {
    if (!isStable(v)) return false;
    const [a = 0, b = 0, c = 0] = v.split(".").map(Number);
    const lo = `${maj ?? 0}.${min ?? 0}.${pat ?? 0}`;
    if (compareVersions(v, lo) < 0) return false;
    if (op === ">=") return true;
    if (op === "^") {
      if ((maj ?? 0) > 0) return a === maj;
      if ((min ?? 0) > 0) return a === 0 && b === min;
      return a === 0 && b === 0 && (pat === null || c === pat);
    }
    if (op === "~") return a === maj && (min === null || b === min);
    return a === maj && (min === null || b === min) && (pat === null || c === pat);
  };
  return pickMax(versions.filter(ok));
}

function pickMax(versions: string[]): string | null {
  let best: string | null = null;
  for (const v of versions) if (best === null || compareVersions(v, best) > 0) best = v;
  return best;
}

interface Resolved {
  ref: PackageRef;
  version: string | null;
  missing: boolean;
  npm?: NpmDoc;
  /** npm doc includes publish times (full packument). */
  full?: boolean;
  pypi?: PypiDoc;
}

async function resolveRef(ref: PackageRef, full: boolean, ctx: Ctx): Promise<Resolved> {
  if (ref.ecosystem === "npm") {
    const doc = await npmDoc(ref.name, full, ctx);
    if (doc instanceof NotFound) return { ref, version: null, missing: true };
    const npm = doc as NpmDoc;
    const tags = npm["dist-tags"] ?? {};
    const all = Object.keys(npm.versions ?? {});
    let version: string | null;
    if (ref.spec === undefined) version = tags.latest ?? null;
    else if (tags[ref.spec]) version = tags[ref.spec] ?? null;
    else if (isExact(ref.spec)) version = ref.spec.replace(/^v/, "");
    else version = maxSatisfying(all, ref.spec);
    return { ref, version, missing: false, npm, full: npm.time !== undefined };
  }
  const doc = await pypiDoc(ref.name, ctx);
  if (doc instanceof NotFound) return { ref, version: null, missing: true };
  const pypi = doc as PypiDoc;
  const version =
    ref.spec === undefined ? (pypi.info?.version ?? null) : isExact(ref.spec) ? ref.spec : null;
  return { ref, version, missing: false, pypi };
}

/** Publish time (ms) per version. npm needs the full packument (fetched only when required). */
async function publishTimes(r: Resolved, ctx: Ctx): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (r.ref.ecosystem === "npm") {
    const full = r.full ? r.npm : await npmDoc(r.ref.name, true, ctx);
    if (!full || full instanceof NotFound) return out;
    for (const [v, t] of Object.entries((full as NpmDoc).time ?? {})) {
      if (v === "created" || v === "modified") continue;
      out.set(v, Date.parse(t));
    }
  } else {
    for (const [v, files] of Object.entries(r.pypi?.releases ?? {})) {
      const times = files
        .filter((f) => !f.yanked)
        .map((f) => Date.parse(f.upload_time_iso_8601 ?? ""))
        .filter((t) => !Number.isNaN(t));
      if (times.length > 0) out.set(v, Math.min(...times));
    }
  }
  return out;
}

/** Newest stable version published before the cutoff, skipping `bad`. */
/** The compatible release line of a version, as `^` reads it: `5` for 5.6.1, `0.30` for 0.30.4. */
function releaseLine(version: string): string {
  const [major = "", minor = ""] = version.replace(/^v/, "").split(".");
  return major === "0" ? `0.${minor}` : major;
}

/**
 * The version to suggest instead: the newest stable release older than
 * `cutoff`, not in `bad`, preferring the same release line as `near` so the
 * agent isn't steered into a breaking major upgrade. Falls back to any line.
 */
function lastOlderThan(
  times: Map<string, number>,
  cutoff: number,
  bad: Set<string>,
  near?: string,
): string | null {
  const ok = [...times]
    .filter(([v, t]) => t <= cutoff && isStable(v) && !bad.has(v))
    .map(([v]) => v);
  if (near) {
    const line = releaseLine(near);
    const same = pickMax(ok.filter((v) => releaseLine(v) === line));
    if (same) return same;
  }
  return pickMax(ok);
}

/** Versions of a package the local feed flags, so a suggestion never names one. */
function feedFlagged(ctx: Ctx, ref: PackageRef, versions: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const v of versions) {
    if (feedMatches(ctx.feed, ref.ecosystem, ref.name, v).length > 0) out.add(v);
  }
  return out;
}

// ── Verdict cache (disk) ────────────────────────────────

/**
 * Persisted answers so a restart doesn't re-query: OSV-clean name@version
 * (re-asked at most once a day; the local feed is re-checked every time) and
 * lockfile verdicts by content hash. Lives at `<gg dir>/package-verdicts.json`.
 */
interface DiskCache {
  /** No malware for this exact version, with when asked. */
  osvClean: Record<string, number>;
  /** Subset of osvClean: OSV also listed (non-malware) advisories. */
  osvFlawed?: Record<string, number>;
  locks: Record<string, LockVerdict>;
}
interface LockVerdict {
  at: number;
  threats: ShellThreat[];
}
const VERDICT_FILE = "package-verdicts.json";
const OSV_TTL_MS = DAY_MS;
const MAX_LOCKS = 50;

class VerdictCache {
  private data: DiskCache = { osvClean: {}, osvFlawed: {}, locks: {} };
  private loaded: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;
  constructor(private readonly file: string | null) {}

  load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = this.file
        ? fsp
            .readFile(this.file, "utf8")
            .then((text) => {
              const raw = JSON.parse(text) as Partial<DiskCache>;
              this.data = {
                osvClean: raw.osvClean ?? {},
                osvFlawed: raw.osvFlawed ?? {},
                locks: raw.locks ?? {},
              };
            })
            .catch(() => undefined)
        : Promise.resolve();
    }
    return this.loaded;
  }
  osvFresh(key: string, now: number): boolean {
    const at = this.data.osvClean[key];
    return at !== undefined && now - at < OSV_TTL_MS;
  }
  markClean(key: string, now: number, flawed = false): void {
    this.data.osvClean[key] = now;
    const f = (this.data.osvFlawed ??= {});
    if (flawed) f[key] = now;
    else delete f[key];
    this.dirty = true;
  }
  /** A remembered no-malware answer that also had advisories. */
  osvFlawed(key: string, now: number): boolean {
    const at = this.data.osvFlawed?.[key];
    return at !== undefined && now - at < OSV_TTL_MS;
  }
  lock(key: string): LockVerdict | undefined {
    return this.data.locks[key];
  }
  setLock(key: string, v: LockVerdict): void {
    this.data.locks[key] = v;
    this.dirty = true;
  }
  /** Write in the background (atomic rename); never on the caller's critical path. */
  save(now: number): void {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    const file = this.file;
    this.saving = this.saving.then(async () => {
      const osvClean = Object.fromEntries(
        Object.entries(this.data.osvClean).filter(([, at]) => now - at < OSV_TTL_MS),
      );
      const osvFlawed = Object.fromEntries(
        Object.entries(this.data.osvFlawed ?? {}).filter(([k]) => k in osvClean),
      );
      const locks = Object.fromEntries(
        Object.entries(this.data.locks)
          .sort(([, a], [, b]) => b.at - a.at)
          .slice(0, MAX_LOCKS),
      );
      this.data = { osvClean, osvFlawed, locks };
      try {
        await writeJsonAtomic(file, this.data);
      } catch (err) {
        log("WARN", "package-threats", `verdict cache write failed: ${String(err)}`);
      }
    });
  }
  flush(): Promise<void> {
    return this.saving;
  }
}

const verdictCaches = new Map<string, VerdictCache>();
function verdictCache(dir: string | null): VerdictCache {
  const file = dir === null ? null : path.join(dir, VERDICT_FILE);
  const key = file ?? "";
  let hit = verdictCaches.get(key);
  if (!hit) {
    hit = new VerdictCache(file);
    verdictCaches.set(key, hit);
  }
  return hit;
}

// ── OSV ─────────────────────────────────────────────────

interface OsvBatchResponse {
  results?: Array<{ vulns?: Array<{ id?: string }> }>;
}
interface OsvItem {
  ecosystem: PackageEcosystem;
  name: string;
  version: string;
}
const osvKey = (i: OsvItem): string => `${i.ecosystem}:${i.name}@${i.version}`;

/** MAL- IDs per `eco:name@version`, one request per 1000 queries, cached (memory + disk). */
/** A remembered OSV answer still holds: malware stays malware; "clean" is re-asked daily. */
function osvKnown(key: string, now: number): boolean {
  const hit = osvCache.get(key);
  if (!hit) return false;
  return hit.ids.length > 0 || now - hit.at < OSV_TTL_MS;
}

async function osvMalware(items: OsvItem[], ctx: Ctx): Promise<Map<string, string[]>> {
  const pending = [
    ...new Map(
      items
        .filter((i) => !osvKnown(osvKey(i), ctx.now) && !ctx.cache.osvFresh(osvKey(i), ctx.now))
        .map((i) => [osvKey(i), i]),
    ).values(),
  ];
  for (let start = 0; start < pending.length; start += OSV_BATCH) {
    const batch = pending.slice(start, start + OSV_BATCH);
    const body = (await fetchJson(
      OSV_URL,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queries: batch.map((i) => ({
            package: { ecosystem: i.ecosystem, name: i.name },
            version: i.version,
          })),
        }),
      },
      ctx,
    )) as OsvBatchResponse;
    batch.forEach((item, i) => {
      const all = (body.results?.[i]?.vulns ?? []).map((v) => v.id ?? "");
      const ids = all.filter((id) => id.startsWith("MAL-"));
      const flawed = all.some((id) => id !== "" && !id.startsWith("MAL-"));
      osvCache.set(osvKey(item), { ids, flawed, at: ctx.now });
      // Remembered on disk with whether it had advisories, so a restart
      // neither re-asks OSV nor loses the serious-flaw trigger.
      if (ids.length === 0) ctx.cache.markClean(osvKey(item), ctx.now, flawed);
    });
  }
  const out = new Map<string, string[]>();
  for (const i of items) {
    const ids = osvCache.get(osvKey(i))?.ids;
    if (ids && ids.length > 0) out.set(osvKey(i), ids);
  }
  return out;
}

// ── Serious known flaws ─────────────────────────────────

/**
 * Major version, the boundary for a flaw fix: moving 0.21 → 0.34 or 4.17 →
 * 4.18 is the normal upgrade path; 0.x → 1.x or 4 → 5 is the breaking one.
 * (Not `releaseLine`: under `^`, 0.21 and 0.31 count as different lines, which
 * would leave old 0.x packages with no fix to move to.)
 */
function majorOf(version: string): string {
  return version.replace(/^v/, "").split(".")[0] ?? "";
}

/** A version with HIGH/CRITICAL advisories and the versions that fix them. */
interface VulnVerdict {
  /** Advisory IDs rated HIGH or CRITICAL. */
  ids: string[];
  /** Short plain summary of the worst one. */
  summary: string;
  /** Highest severity seen ("CRITICAL" | "HIGH"). */
  severity: string;
  /** Per serious advisory: the `fixed` versions it lists (any release line). */
  fixes: string[][];
}

interface OsvAdvisory {
  id?: string;
  summary?: string;
  database_specific?: { severity?: string };
  affected?: Array<{
    package?: { name?: string; ecosystem?: string };
    ranges?: Array<{ type?: string; events?: Array<{ introduced?: string; fixed?: string }> }>;
  }>;
}

const SERIOUS = new Set(["HIGH", "CRITICAL"]);

/** Did the batch lookup see any non-malware advisory for this exact version? */
function osvFlawed(item: OsvItem, ctx: Ctx): boolean {
  const key = osvKey(item);
  const hit = osvCache.get(key);
  return hit ? hit.flawed : ctx.cache.osvFlawed(key, ctx.now);
}

/**
 * Serious advisories for one exact version (one detailed OSV request, only
 * made when the batch lookup already saw advisories). Cached for a day.
 */
async function seriousFlaws(item: OsvItem, ctx: Ctx): Promise<VulnVerdict | null> {
  const key = osvKey(item);
  const hit = vulnCache.get(key);
  if (hit && ctx.now - hit.at < OSV_TTL_MS) return hit.verdict;
  const body = (await fetchJson(
    OSV_QUERY_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        package: { ecosystem: item.ecosystem, name: item.name },
        version: item.version,
      }),
    },
    ctx,
  )) as { vulns?: OsvAdvisory[] };
  const serious = (body.vulns ?? []).filter(
    (v) =>
      !(v.id ?? "").startsWith("MAL-") &&
      SERIOUS.has((v.database_specific?.severity ?? "").toUpperCase()),
  );
  const verdict: VulnVerdict | null =
    serious.length === 0
      ? null
      : {
          ids: serious.map((v) => v.id ?? "").filter(Boolean),
          summary:
            (
              serious.find((v) => v.database_specific?.severity?.toUpperCase() === "CRITICAL") ??
              serious[0]
            )?.summary?.trim() ?? "",
          severity: serious.some((v) => v.database_specific?.severity?.toUpperCase() === "CRITICAL")
            ? "CRITICAL"
            : "HIGH",
          fixes: serious.map((v) =>
            (v.affected ?? [])
              .filter(
                (a) => !a.package?.name || a.package.name.toLowerCase() === item.name.toLowerCase(),
              )
              .flatMap((a) => a.ranges ?? [])
              .flatMap((r) => r.events ?? [])
              .map((e) => e.fixed)
              .filter((f): f is string => typeof f === "string" && f.length > 0),
          ),
        };
  vulnCache.set(key, { verdict, at: ctx.now });
  return verdict;
}

/**
 * The version to move to: the newest stable release on `version`'s release
 * line that is at or past a fix of EVERY serious advisory (on that line),
 * older than the cooldown, and not malware. Null when there is none (no fix
 * yet, or only fixed in another major) — then the install is left alone.
 */
function fixedOnSameLine(
  version: string,
  verdict: VulnVerdict,
  times: Map<string, number>,
  cutoff: number,
  bad: Set<string>,
): string | null {
  const line = majorOf(version);
  const floors: string[] = [];
  for (const fixes of verdict.fixes) {
    const onLine = fixes.filter((f) => majorOf(f) === line && compareVersions(f, version) > 0);
    if (onLine.length === 0) return null; // this flaw isn't fixed on this line
    floors.push(onLine.reduce((a, b) => (compareVersions(a, b) <= 0 ? a : b)));
  }
  const floor = floors.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  const ok = [...times]
    .filter(
      ([v, t]) =>
        t <= cutoff &&
        isStable(v) &&
        !bad.has(v) &&
        majorOf(v) === line &&
        compareVersions(v, floor) >= 0,
    )
    .map(([v]) => v);
  return pickMax(ok);
}

function vulnThreat(
  ref: PackageRef,
  version: string,
  verdict: VulnVerdict,
  fixed: string,
): ShellThreat {
  const what = verdict.summary ? `: ${verdict.summary.replace(/\s+/g, " ").slice(0, 100)}` : "";
  const ids = verdict.ids.slice(0, 3).join(", ") + (verdict.ids.length > 3 ? ", …" : "");
  return {
    rule: "known-vulnerability",
    severity: "block",
    detail: `${ref.name}@${version} has known ${verdict.severity} security flaws (${ids})${what}; use ${ref.name}@${fixed}, the newest ${majorOf(version)}.x release with those fixed.`,
  };
}

// ── Main check ──────────────────────────────────────────

interface Ctx {
  fetch: typeof fetch;
  signal: AbortSignal;
  /** The caller cancelled (not our deadline). */
  cancelled: () => boolean;
  /** Some host answered during this check (so the network is up). */
  reached: { value: boolean };
  now: number;
  days: number;
  feed: ThreatFeedData;
  cache: VerdictCache;
  managerVersion: (m: PackageManager) => Promise<string | null>;
  /** Installs may come from a private registry/index: "not on the public one" proves nothing. */
  privateSource: (eco: PackageEcosystem) => boolean;
}

/** Swallow network failures: the guard is fail-open (the cooldown still applies). */
async function safe<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    log("WARN", "package-threats", `${what} failed, allowing: ${String(err)}`);
    return null;
  }
}

function resolvedItem(r: Resolved): OsvItem {
  return { ecosystem: r.ref.ecosystem, name: r.ref.name, version: r.version ?? "" };
}

/**
 * Named installs. Everything independent runs at once, so a clean install
 * costs one registry round trip (+ one OSV round trip for unpinned refs whose
 * version isn't known until the registry answers):
 * - registry docs for every ref (full packument only for typosquat
 *   candidates; abbreviated otherwise),
 * - OSV for exactly pinned refs, concurrently with the registry,
 * - weekly downloads for npm typosquat candidates,
 * - the manager version (native cooldown?) — spawned once per process.
 */
async function checkNamed(local: LocalCheck, ctx: Ctx): Promise<ShellThreat[]> {
  const threats: ShellThreat[] = [];
  const refs = local.refs.filter((r) => !local.flagged.has(r.name));
  const squats = new Map(local.typosquats.map((t) => [t.ref.name, t.popular]));

  const native = new Map<string, Promise<boolean>>();
  for (const r of refs) {
    if (!native.has(r.manager)) native.set(r.manager, nativeCooldown(r.manager, ctx));
  }
  const pinned: OsvItem[] = refs
    .filter((r) => isExact(r.spec))
    .map((r) => ({
      ecosystem: r.ecosystem,
      name: r.name,
      version: (r.spec ?? "").replace(/^v/, ""),
    }));
  const earlyOsv = pinned.length > 0 ? safe("OSV lookup", () => osvMalware(pinned, ctx)) : null;
  const downloads = new Map(
    refs
      .filter((r) => r.ecosystem === "npm" && squats.has(r.name))
      .map((r) => [
        r.name,
        safe(`downloads ${r.name}`, () => getJson(`${NPM_DOWNLOADS}/${r.name}`, ctx)),
      ]),
  );
  const resolved = (
    await Promise.all(
      refs.map((r) => safe(`lookup ${r.name}`, () => resolveRef(r, squats.has(r.name), ctx))),
    )
  ).filter((r): r is Resolved => r !== null);

  // P5: typosquat → block only if missing, new or barely used.
  const squatted = new Set<string>();
  for (const r of resolved) {
    const popular = squats.get(r.ref.name);
    if (!popular) continue;
    const reason = await safe(`typosquat ${r.ref.name}`, () =>
      typosquatReason(r, downloads.get(r.ref.name) ?? Promise.resolve(null), ctx),
    );
    if (reason) {
      squatted.add(r.ref.name);
      threats.push({
        rule: "typosquat",
        severity: "block",
        detail: `${r.ref.name} looks like a typosquat of popular "${popular}" (${reason}); use ${popular} if that is what you meant.`,
        blocked: [
          { ecosystem: r.ref.ecosystem, name: r.ref.name, reason: `lookalike of "${popular}"` },
        ],
      });
    }
  }
  const live = resolved.filter(
    (r) => !r.missing && r.version !== null && !squatted.has(r.ref.name),
  );

  // Malware: local feed with the resolved version, then OSV with exact versions.
  const pinnedKeys = new Set(pinned.map(osvKey));
  const late = live.map(resolvedItem).filter((i) => !pinnedKeys.has(osvKey(i)));
  const [early, rest] = await Promise.all([
    earlyOsv,
    late.length > 0 ? safe("OSV lookup", () => osvMalware(late, ctx)) : null,
  ]);
  const osv = new Map([...(early ?? []), ...(rest ?? [])]);
  const malware = new Set<string>();
  for (const r of live) {
    const version = r.version ?? "";
    const ids = [
      ...new Set([
        ...feedMatches(ctx.feed, r.ref.ecosystem, r.ref.name, version),
        ...(osv.get(osvKey(resolvedItem(r))) ?? []),
      ]),
    ];
    if (ids.length === 0) continue;
    malware.add(r.ref.name);
    const times =
      (await safe("publish times", () => publishTimes(r, ctx))) ?? new Map<string, number>();
    const cutoff = ctx.now - Math.max(ctx.days, 0) * DAY_MS;
    const bad = feedFlagged(ctx, r.ref, times.keys()).add(version);
    const suggestion = lastOlderThan(times, cutoff, bad, version);
    threats.push(malwareThreat(r.ref, version, ids, suggestion, ctx.days));
  }

  // Serious known flaws: only versions the batch lookup already saw
  // advisories for get the one detailed request; all of them in parallel.
  const vulnChecks = await Promise.all(
    live
      .filter((r) => !malware.has(r.ref.name) && osvFlawed(resolvedItem(r), ctx))
      .map(async (r) => {
        const version = r.version ?? "";
        const verdict = await safe(`advisories ${r.ref.name}`, () =>
          seriousFlaws(resolvedItem(r), ctx),
        );
        if (!verdict) return null;
        const times = await safe("publish times", () => publishTimes(r, ctx));
        if (!times) return null;
        const cutoff = ctx.now - Math.max(ctx.days, 0) * DAY_MS;
        const bad = feedFlagged(ctx, r.ref, times.keys()).add(version);
        const fixed = fixedOnSameLine(version, verdict, times, cutoff, bad);
        return fixed
          ? { name: r.ref.name, threat: vulnThreat(r.ref, version, verdict, fixed) }
          : null;
      }),
  );
  const flawed = new Set<string>();
  for (const v of vulnChecks) {
    if (!v) continue;
    flawed.add(v.name);
    threats.push(v.threat);
  }

  for (const r of live) {
    if (malware.has(r.ref.name) || flawed.has(r.ref.name)) continue;
    const version = r.version ?? "";
    // P4: provenance downgrade (npm).
    if (r.npm?.versions) {
      const all = Object.keys(r.npm.versions);
      const prev = pickMax(all.filter((v) => isStable(v) && compareVersions(v, version) < 0));
      const had = prev ? r.npm.versions[prev]?.dist?.attestations : undefined;
      const has = r.npm.versions[version]?.dist?.attestations;
      if (prev && had && !has && r.npm.versions[version]) {
        threats.push({
          rule: "provenance-downgrade",
          severity: "block",
          detail: `${r.ref.name}@${version} was published without the provenance attestation ${r.ref.name}@${prev} had (a hijacked-release signal); use ${r.ref.name}@${prev}.`,
          blocked: [
            {
              ecosystem: r.ref.ecosystem,
              name: r.ref.name,
              version,
              reason: "published without its usual signature (likely hijacked)",
            },
          ],
        });
        continue;
      }
    }
    // P3: own release-age check only when the manager can't enforce the cooldown.
    if (ctx.days > 0 && !(await (native.get(r.ref.manager) ?? Promise.resolve(true)))) {
      const times =
        (await safe("publish times", () => publishTimes(r, ctx))) ?? new Map<string, number>();
      const published = times.get(version);
      const cutoff = ctx.now - ctx.days * DAY_MS;
      if (published !== undefined && published > cutoff) {
        const older = lastOlderThan(times, cutoff, feedFlagged(ctx, r.ref, times.keys()), version);
        const hours = Math.max(1, Math.round((ctx.now - published) / 3_600_000));
        const instead = older
          ? `use ${r.ref.name}@${older}, the last version older than ${ctx.days} days`
          : `wait until it is ${ctx.days} days old`;
        threats.push({
          rule: "release-age",
          severity: "block",
          detail: `${r.ref.name}@${version} was published ${hours}h ago (cooldown ${ctx.days} days); ${instead}.`,
        });
      }
    }
  }
  return threats;
}

async function nativeCooldown(manager: PackageRef["manager"], ctx: Ctx): Promise<boolean> {
  const m: PackageManager = manager === "npx" ? "npm" : manager === "uvx" ? "uv" : manager;
  if (m === "uv") return true;
  return hasNativeCooldown(m, await ctx.managerVersion(m));
}

async function typosquatReason(
  r: Resolved,
  downloads: Promise<unknown>,
  ctx: Ctx,
): Promise<string | null> {
  if (r.missing)
    return ctx.privateSource(r.ref.ecosystem) ? null : "it does not exist on the registry";
  const times = await publishTimes(r, ctx);
  const first = Math.min(...times.values());
  if (Number.isFinite(first) && ctx.now - first < TYPOSQUAT_NEW_DAYS * DAY_MS) {
    return `first published ${Math.max(0, Math.floor((ctx.now - first) / DAY_MS))} days ago`;
  }
  const dl = (await downloads) as { downloads?: number } | NotFound | null;
  if (
    dl &&
    !(dl instanceof NotFound) &&
    typeof dl.downloads === "number" &&
    dl.downloads < TYPOSQUAT_MIN_WEEKLY
  ) {
    return `only ${dl.downloads} downloads last week`;
  }
  return null;
}

async function checkLockfile(lock: LockfileInstall, cwd: string, ctx: Ctx): Promise<ShellThreat[]> {
  const file = path.resolve(cwd, lock.file);
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch {
    return [];
  }
  const hash = await hashInSlices(text);
  const cacheKey = `${lock.ecosystem}:${hash}:${Object.keys(ctx.feed.entries).length}`;
  const remembered = lockfileCache.get(cacheKey) ?? ctx.cache.lock(cacheKey);
  // A lockfile verdict is re-asked of OSV at most once a day, so a package
  // flagged after the last check is still caught even if the feed is unchanged.
  const cached = remembered && ctx.now - remembered.at < DAY_MS ? remembered : undefined;
  if (cached) {
    lockfileCache.set(cacheKey, cached);
    return cached.threats;
  }
  const pkgs = await parseLockfileAsync(file, text);
  const hits = new Map<string, string[]>();
  for (const p of pkgs) {
    const ids = feedMatches(ctx.feed, lock.ecosystem, p.name, p.version);
    if (ids.length > 0) hits.set(`${p.name}@${p.version}`, ids);
  }
  const osv = await safe("OSV lockfile lookup", () =>
    osvMalware(
      pkgs.map((p) => ({ ecosystem: lock.ecosystem, name: p.name, version: p.version })),
      ctx,
    ),
  );
  for (const [key, ids] of osv ?? []) {
    const short = key.slice(key.indexOf(":") + 1);
    hits.set(short, [...new Set([...(hits.get(short) ?? []), ...ids])]);
  }
  const threats: ShellThreat[] =
    hits.size === 0
      ? []
      : [
          {
            rule: "malicious-package",
            severity: "block",
            packages: [...hits].map(([k, ids]) => `${k} (${ids.join(", ")})`),
            blocked: [...hits].map(([k, ids]): BlockedPackage => {
              const at = k.lastIndexOf("@");
              return {
                ecosystem: lock.ecosystem,
                name: k.slice(0, at),
                version: k.slice(at + 1),
                reason: `known malware (${ids.join(", ")})`,
              };
            }),
            detail: `${path.basename(file)} pins malware: ${[...hits]
              .slice(0, 5)
              .map(([k, ids]) => `${k} (${ids.join(", ")})`)
              .join(
                ", ",
              )}${hits.size > 5 ? ` and ${hits.size - 5} more` : ""}; update those packages to a clean version and regenerate the lockfile.`,
          },
        ];
  // Only cache a complete answer (OSV reached); offline answers are retried.
  if (osv !== null) {
    const verdict: LockVerdict = { at: ctx.now, threats };
    lockfileCache.set(cacheKey, verdict);
    ctx.cache.setLock(cacheKey, verdict);
  }
  return threats;
}

/** Rejects with the deadline so no network wait can stack past it (fail-open). */
function deadline(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error("package check deadline"));
    signal.addEventListener("abort", () => reject(new Error("package check deadline")), {
      once: true,
    });
  });
}

/** Context for one check, under ONE deadline shared by every lookup. */
function makeCtx(options: PackageCheckOptions, feed: ThreatFeedData, command = ""): Ctx {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const cache = verdictCache(
    options.cacheDir !== undefined
      ? options.cacheDir
      : process.env.VITEST
        ? null // tests never write to the real GG dir
        : getAppPaths().agentDir,
  );
  return {
    fetch: options.fetch ?? fetch,
    signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
    cancelled: () => options.signal?.aborted === true,
    reached: { value: false },
    now: (options.now ?? Date.now)(),
    days: options.cooldownDays ?? 2,
    feed,
    cache,
    managerVersion: options.managerVersion ?? ((m) => managerVersion(m, options.cwd)),
    privateSource: (eco) =>
      eco === "npm"
        ? usesCustomNpmRegistry(command, options.cwd ?? process.cwd(), options.env)
        : usesCustomPypiIndex(command, options.env),
  };
}

/** Lockfile names checked for already-installed packages, with their ecosystem. */
export const PROJECT_LOCKFILES: readonly LockfileInstall[] = [
  { ecosystem: "npm", manager: "npm", file: "package-lock.json" },
  { ecosystem: "npm", manager: "pnpm", file: "pnpm-lock.yaml" },
  { ecosystem: "npm", manager: "yarn", file: "yarn.lock" },
  { ecosystem: "npm", manager: "bun", file: "bun.lock" },
  { ecosystem: "PyPI", manager: "uv", file: "uv.lock", resolves: true },
  { ecosystem: "PyPI", manager: "pip", file: "requirements.txt" },
];

/**
 * Malware check of one existing lockfile (already-installed packages): the
 * local feed plus one batched OSV lookup, cached by content hash and re-asked
 * at most once a day. No release-age check. Fail-open like every other check.
 */
export async function checkLockfileMalware(
  lock: LockfileInstall,
  cwd: string,
  options: PackageCheckOptions = {},
): Promise<ShellThreat[]> {
  const ctx = makeCtx(options, options.feed ?? loadThreatFeed());
  const work = (async () => {
    await ctx.cache.load();
    return checkLockfile({ ...lock, resolves: true }, cwd, ctx);
  })();
  const out = await Promise.race([work, deadline(ctx.signal)]).catch((err: unknown) => {
    log("WARN", "package-threats", `lockfile check cut short: ${String(err)}`);
    noteDeadline(ctx);
    return [] as ShellThreat[];
  });
  ctx.cache.save(ctx.now);
  return out;
}

/** Full check for one bash command. Returns blocks only; [] when clean or not an install. */
export async function checkPackageInstall(
  command: string,
  options: PackageCheckOptions = {},
): Promise<ShellThreat[]> {
  const local = localPackageCheck(command, () => options.feed ?? loadThreatFeed());
  if (local.refs.length === 0 && local.lockfiles.length === 0) return [];
  const ctx = makeCtx(options, local.feed, command);
  const cache = ctx.cache;
  const threats = [...local.threats];
  const cwd = options.cwd ?? process.cwd();
  const work = (async () => {
    await cache.load();
    const parts = await Promise.all([
      local.refs.length > 0 ? checkNamed(local, ctx) : [],
      ...local.lockfiles.map((lock) => checkLockfile(lock, cwd, ctx)),
    ]);
    return parts.flat();
  })();
  const out = await Promise.race([work, deadline(ctx.signal)]).catch((err: unknown) => {
    log("WARN", "package-threats", `check cut short, allowing: ${String(err)}`);
    noteDeadline(ctx);
    return [] as ShellThreat[];
  });
  cache.save(ctx.now);
  return [...threats, ...out];
}

/** One plain line for the agent, or null when nothing blocks. */
export function packageBlockMessage(threats: ShellThreat[]): string | null {
  const blocks = threats.filter((t) => t.severity === "block");
  if (blocks.length === 0) return null;
  return `Blocked install (${blocks[0]?.rule}): ${blocks.map((t) => t.detail).join(" ")} ${SAFETY_BLOCK_NOTE}`;
}

/**
 * Check an MCP stdio launch (`npx -y pkg`, `uvx pkg`) before spawning.
 * Returns the block line, or null to allow.
 */
export async function checkMcpLaunch(
  command: string,
  args: readonly string[],
  options: PackageCheckOptions = {},
): Promise<string | null> {
  const base = path
    .basename(command)
    .toLowerCase()
    .replace(/\.(cmd|exe)$/, "");
  if (!["npx", "uvx", "bunx", "pnpm", "npm", "uv"].includes(base)) return null;
  const line = [base, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  // MCP launches get no bun flag, so bunx gets the own age check.
  const versions = options.managerVersion ?? ((m: PackageManager) => managerVersion(m));
  const message = packageBlockMessage(
    await checkPackageInstall(line, {
      ...options,
      managerVersion: (m) => (m === "bun" ? Promise.resolve(null) : versions(m)),
    }),
  );
  // Shown to the user on the MCP settings row, not to the agent.
  return message?.replace(` ${SAFETY_BLOCK_NOTE}`, "") ?? null;
}

/** Wait for pending verdict-cache writes (tests). */
export async function flushPackageVerdicts(): Promise<void> {
  await Promise.all([...verdictCaches.values()].map((c) => c.flush()));
}

/** Test hook: forget cached answers (memory only; the disk file is left alone). */
export function clearPackageThreatCache(): void {
  osvCache.clear();
  vulnCache.clear();
  metaCache.clear();
  lockfileCache.clear();
  verdictCaches.clear();
  downHosts.clear();
}
