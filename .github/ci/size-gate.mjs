#!/usr/bin/env node
// size-gate — bundle-size report against .github/ci/baseline/sizes.json.
// Artifacts:
//   dist:ggcoder — total bytes of packages/ggcoder/dist (the shipped CLI).
//   frontend:initial — entry JS + static imports, excluding on-demand chunks.
//   sidecar      — app-sidecar.mjs + bundled skills bytes (gg-app/src-tauri/sidecar).
//   sidecar:deps — the sidecar's copied node_modules. Its native binaries differ
//                  per OS/arch, so it is baselined per platform
//                  (e.g. sidecar:deps:darwin-arm64).
//   prompt:prefix — the golden cached system-prompt prefix, sent on every request.
// Usage:
//   node .github/ci/size-gate.mjs                 # check all artifacts against baseline
//   node .github/ci/size-gate.mjs --only sidecar  # check one artifact
//   node .github/ci/size-gate.mjs --update        # re-baseline after an intentional change
// Highlight growth above baseline + max(2%, 100KB; 10KB for initial frontend JS,
// 1KB for the prompt prefix).
// Growth is informational for every artifact except `frontend:initial` — the
// JavaScript every window loads before it can render — whose budget is exactly
// that allowance and BLOCKING: add eager code past it and the step fails.
// Lazy-load what was added, or re-baseline with --update so the growth is a
// reviewed change. Missing or unreadable build artifacts fail too.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE_PATH = path.join(REPO_ROOT, ".github/ci/baseline/sizes.json");
const TOLERANCE = { relative: 0.02, absoluteBytes: 100 * 1024 };

/** Recursive byte total of a directory (or single file). */
function dirBytes(target) {
  const stat = statSync(target);
  if (stat.isFile()) return stat.size;
  return readdirSync(target).reduce(
    (total, entry) => total + dirBytes(path.join(target, entry)),
    0,
  );
}

function initialFrontendBytes() {
  const dist = path.join(REPO_ROOT, "gg-app/dist");
  const manifest = JSON.parse(readFileSync(path.join(dist, ".vite/manifest.json"), "utf8"));
  const entries = Object.keys(manifest).filter((key) => manifest[key].isEntry);
  if (entries.length === 0) throw new Error("Frontend manifest has no entry points");
  const seen = new Set();
  function visit(key) {
    if (seen.has(key)) return 0;
    seen.add(key);
    const chunk = manifest[key];
    return (
      statSync(path.join(dist, chunk.file)).size +
      (chunk.imports ?? []).reduce((sum, key) => sum + visit(key), 0)
    );
  }
  return entries.reduce((sum, key) => sum + visit(key), 0);
}

const ARTIFACTS = {
  "dist:ggcoder": () => dirBytes(path.join(REPO_ROOT, "packages/ggcoder/dist")),
  "frontend:initial": initialFrontendBytes,
  sidecar: () =>
    dirBytes(path.join(REPO_ROOT, "gg-app/src-tauri/sidecar/app-sidecar.mjs")) +
    dirBytes(path.join(REPO_ROOT, "gg-app/src-tauri/sidecar/skills")),
  "sidecar:deps": () => dirBytes(path.join(REPO_ROOT, "gg-app/src-tauri/sidecar/node_modules")),
  "prompt:prefix": () =>
    dirBytes(path.join(REPO_ROOT, "packages/ggcoder/src/__golden__/system-prompt-prefix.md")),
};
const ABSOLUTE_TOLERANCE = { "frontend:initial": 10 * 1024, "prompt:prefix": 1024 };
const PER_PLATFORM = new Set(["sidecar:deps"]);
// Artifacts whose allowance is a budget: growth past it fails the run.
const ENFORCED = new Set(["frontend:initial"]);

const fmt = (bytes) => `${(bytes / 1024).toFixed(1)}KB`;
const args = process.argv.slice(2);
const update = args.includes("--update");
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    return { artifacts: {} };
  }
}

const baseline = await loadBaseline();
let failed = false;
const overBudget = [];

const rows = [];
for (const [name, measure] of Object.entries(ARTIFACTS)) {
  if (only && name !== only) continue;
  let bytes;
  try {
    bytes = measure();
  } catch (error) {
    console.error(`✖ ${name}: artifact not built (${error.message})`);
    failed = true;
    continue;
  }
  const key = PER_PLATFORM.has(name) ? `${name}:${process.platform}-${process.arch}` : name;
  const entry = baseline.artifacts[key];
  baseline.artifacts[key] = { bytes, recorded_at: new Date().toISOString() };

  if (!entry) {
    const gated = ENFORCED.has(name);
    // A budget with no baseline is no budget: the allowance is a share of it.
    rows.push([key, "—", fmt(bytes), "—", gated ? "no baseline (BLOCKING)" : "no baseline"]);
    failed ||= gated && !update;
    continue;
  }
  const absoluteTolerance = ABSOLUTE_TOLERANCE[name] ?? TOLERANCE.absoluteBytes;
  const allowed = entry.bytes + Math.max(entry.bytes * TOLERANCE.relative, absoluteTolerance);
  const delta = bytes - entry.bytes;
  const gated = ENFORCED.has(name);
  const verdict =
    bytes <= allowed
      ? delta < 0
        ? "smaller"
        : "ok"
      : gated
        ? "OVER BUDGET"
        : "growth (informational)";
  rows.push([key, fmt(entry.bytes), fmt(bytes), `${delta >= 0 ? "+" : ""}${fmt(delta)}`, verdict]);
  if (bytes > allowed && gated && !update) overBudget.push([key, entry.bytes, allowed, bytes]);
}

const widths = [28, 12, 12, 12, 28];
const header = ["artifact", "baseline", "current", "change", "note"];
console.log(
  rows
    .map((row) => row.map((cell, i) => String(cell).padEnd(widths[i])).join(" "))
    .join("\n")
    .replace(/^/, `${header.map((cell, i) => cell.padEnd(widths[i])).join(" ")}\n`),
);

if (failed) {
  console.error(
    "\nSize report incomplete: required build artifacts could not be measured" +
      " or have no baseline. Record one, on purpose, with `--update --only <artifact>`.",
  );
  process.exit(1);
}

if (update) {
  await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  console.log(`\nBaseline updated: ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
}

for (const [key, base, allowed, bytes] of overBudget) {
  console.error(
    `\nBudget exceeded for ${key}: ${fmt(bytes)} against ${fmt(allowed)} ` +
      `(baseline ${fmt(base)} + max(${TOLERANCE.relative * 100}%, ${fmt(ABSOLUTE_TOLERANCE[key])})).\n` +
      "It is the JavaScript every window loads before it can render: lazy-load what was " +
      "added. If the growth is intended, re-baseline so that it is a reviewed change:\n" +
      `  node .github/ci/size-gate.mjs --update --only ${key}`,
  );
}
if (overBudget.length > 0) process.exit(1);
