/**
 * Package-install threat checks: typosquat detection against popular package
 * names (local) and known-malicious packages via OSV (network, fail-open).
 */
import { log } from "./logger.js";
import { POPULAR_NPM_PACKAGES, POPULAR_PYPI_PACKAGES } from "./shell-threats-popular-packages.js";
import type { ShellThreat } from "./shell-threats.js";

export type PackageEcosystem = "npm" | "PyPI";

export interface PackageRef {
  ecosystem: PackageEcosystem;
  name: string;
}

export interface PackageCheckOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

const OSV_URL = "https://api.osv.dev/v1/querybatch";
const OSV_TIMEOUT_MS = 3_000;
const NPM_INSTALL = new Set(["add", "install", "i"]);
const osvCache = new Map<string, string[]>();

/** Strip a version/range/extras suffix: `react@18`, `@a/b@1`, `requests==2.0`, `x[extra]`. */
function bareName(spec: string, ecosystem: PackageEcosystem): string | null {
  if (ecosystem === "npm") {
    const at = spec.indexOf("@", 1);
    const name = at === -1 ? spec : spec.slice(0, at);
    return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ? name.toLowerCase() : null;
  }
  const name = spec.split(/[[=<>!~;@\s]/)[0] ?? "";
  return /^[a-z0-9][a-z0-9._-]*$/i.test(name) ? name.toLowerCase().replace(/[._]/g, "-") : null;
}

/** Packages named by install commands in `command`. Local paths/URLs are skipped. */
export function parsePackageInstalls(command: string): PackageRef[] {
  const refs: PackageRef[] = [];
  for (const segment of command.split(/(?:&&|\|\||[;|\n])/)) {
    const tokens = segment
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/^['"]|['"]$/g, ""))
      .filter((t) => t.length > 0);
    if (tokens[0] === "sudo") tokens.shift();
    const [program, sub, ...rest] = tokens;
    let ecosystem: PackageEcosystem | null = null;
    let args: string[] = [];
    if (program === "npx" && sub !== undefined) {
      ecosystem = "npm";
      args = [sub, ...rest].filter((a) => !a.startsWith("-")).slice(0, 1);
    } else if (
      (program === "npm" || program === "pnpm" || program === "yarn" || program === "bun") &&
      sub !== undefined &&
      NPM_INSTALL.has(sub)
    ) {
      ecosystem = "npm";
      args = rest;
    } else if ((program === "pip" || program === "pip3") && sub === "install") {
      ecosystem = "PyPI";
      args = rest;
    } else if (program === "uv" && sub === "pip" && rest[0] === "install") {
      ecosystem = "PyPI";
      args = rest.slice(1);
    }
    if (!ecosystem) continue;
    let skipNext = false;
    for (const arg of args) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      // Options that take a value (`-r requirements.txt`, `--registry x`).
      if (
        /^(?:-r|-c|-e|--requirement|--constraint|--editable|--registry|-i|--index-url)$/.test(arg)
      ) {
        skipNext = true;
        continue;
      }
      if (arg.startsWith("-") || /[/\\:]/.test(arg.replace(/^@[^/]+\//, ""))) continue;
      const name = bareName(arg, ecosystem);
      if (name) refs.push({ ecosystem, name });
    }
  }
  return refs;
}

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

function typosquatOf(ref: PackageRef): string | null {
  const popular = ref.ecosystem === "npm" ? POPULAR_NPM_PACKAGES : POPULAR_PYPI_PACKAGES;
  if (popular.includes(ref.name)) return null;
  return (
    popular.find(
      (p) => Math.abs(p.length - ref.name.length) <= 1 && damerauLevenshtein(p, ref.name) === 1,
    ) ?? null
  );
}

interface OsvBatchResponse {
  results?: Array<{ vulns?: Array<{ id?: string }> }>;
}

async function malwareIds(
  refs: PackageRef[],
  options: PackageCheckOptions,
): Promise<Map<string, string[]>> {
  const key = (r: PackageRef): string => `${r.ecosystem}:${r.name}`;
  const pending = refs.filter((r) => !osvCache.has(key(r)));
  if (pending.length > 0) {
    const doFetch = options.fetch ?? fetch;
    const signals = [AbortSignal.timeout(OSV_TIMEOUT_MS)];
    if (options.signal) signals.push(options.signal);
    try {
      const res = await doFetch(OSV_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queries: pending.map((r) => ({ package: { ecosystem: r.ecosystem, name: r.name } })),
        }),
        signal: AbortSignal.any(signals),
      });
      if (!res.ok) throw new Error(`OSV HTTP ${res.status}`);
      const body = (await res.json()) as OsvBatchResponse;
      pending.forEach((r, i) => {
        const ids = (body.results?.[i]?.vulns ?? [])
          .map((v) => v.id ?? "")
          .filter((id) => id.startsWith("MAL-"));
        osvCache.set(key(r), ids);
      });
    } catch (err) {
      log("WARN", "shell-threats", `OSV lookup failed, allowing install: ${String(err)}`);
    }
  }
  const out = new Map<string, string[]>();
  for (const r of refs) {
    const ids = osvCache.get(key(r));
    if (ids && ids.length > 0) out.set(r.name, ids);
  }
  return out;
}

/** Typosquat warnings (local) and known-malware blocks (OSV, fail-open). */
export async function checkPackageInstall(
  command: string,
  options: PackageCheckOptions = {},
): Promise<ShellThreat[]> {
  const refs = parsePackageInstalls(command);
  if (refs.length === 0) return [];
  const threats: ShellThreat[] = [];
  for (const ref of refs) {
    const intended = typosquatOf(ref);
    if (intended) {
      threats.push({
        rule: "typosquat",
        severity: "warn",
        detail: `${ref.ecosystem} package "${ref.name}" is one edit away from popular "${intended}" — did you mean ${intended}?`,
      });
    }
  }
  for (const [name, ids] of await malwareIds(refs, options)) {
    threats.push({
      rule: "malicious-package",
      severity: "block",
      detail: `package "${name}" is flagged as malware by OSV (${ids.join(", ")})`,
    });
  }
  return threats;
}

/** Test hook: forget cached OSV answers. */
export function clearPackageThreatCache(): void {
  osvCache.clear();
}
