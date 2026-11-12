#!/usr/bin/env node
// size-gate — informational bundle-size report (legacy command name).
// Artifacts:
//   dist:ggcoder — total bytes of packages/ggcoder/dist (the shipped CLI).
//   frontend:initial — entry JS + static imports, excluding on-demand chunks.
//   sidecar      — app-sidecar.mjs + bundled skills bytes (gg-app/src-tauri/sidecar).
//   sidecar:deps — the sidecar's copied node_modules. Its native binaries differ
//                  per OS/arch, so it is baselined per platform
//                  (e.g. sidecar:deps:darwin-arm64).
// Usage:
//   node .github/ci/size-gate.mjs                 # check all artifacts against baseline
//   node .github/ci/size-gate.mjs --only sidecar  # check one artifact
//   node .github/ci/size-gate.mjs --update        # re-baseline after an intentional change
// Highlight growth above baseline + max(2%, 100KB; 10KB for initial frontend JS).
// Size growth never fails CI; missing or unreadable build artifacts still do.
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
};
const PER_PLATFORM = new Set(["sidecar:deps"]);

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
    rows.push([key, "—", fmt(bytes), "—", "no baseline"]);
    continue;
  }
  const absoluteTolerance = name === "frontend:initial" ? 10 * 1024 : TOLERANCE.absoluteBytes;
  const allowed = entry.bytes + Math.max(entry.bytes * TOLERANCE.relative, absoluteTolerance);
  const delta = bytes - entry.bytes;
  const verdict = bytes > allowed ? "growth (informational)" : delta < 0 ? "smaller" : "ok";
  rows.push([key, fmt(entry.bytes), fmt(bytes), `${delta >= 0 ? "+" : ""}${fmt(delta)}`, verdict]);
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
  console.error("\nSize report incomplete: required build artifacts could not be measured.");
  process.exit(1);
}

if (update) {
  await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  console.log(`\nBaseline updated: ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
}
