// Bump the gg-app desktop version across ALL four places that must stay in
// lockstep, so a release tag never ships with mismatched versions:
//   1. gg-app/package.json            "version"
//   2. gg-app/src-tauri/tauri.conf.json  "version"  (the bundle/updater version)
//   3. gg-app/src-tauri/Cargo.toml    [package] version
//   4. gg-app/src-tauri/Cargo.lock    the gg-app package entry
//
// Usage:
//   node scripts/bump-version.mjs patch        # 0.1.40 -> 0.1.41
//   node scripts/bump-version.mjs minor        # 0.1.40 -> 0.2.0
//   node scripts/bump-version.mjs major        # 0.1.40 -> 1.0.0
//   node scripts/bump-version.mjs 0.1.42       # explicit version
//
// Prints the new version to stdout on success (so a caller can capture it).
// Does NOT git-add/commit/tag — that's the release command's job.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const pkgPath = join(appRoot, "package.json");
const confPath = join(appRoot, "src-tauri", "tauri.conf.json");
const cargoPath = join(appRoot, "src-tauri", "Cargo.toml");
const lockPath = join(appRoot, "src-tauri", "Cargo.lock");

const SEMVER = /^\d+\.\d+\.\d+$/;

function fail(msg) {
  console.error(`bump-version: ${msg}`);
  process.exit(1);
}

function nextVersion(current, arg) {
  if (SEMVER.test(arg)) return arg;
  const [major, minor, patch] = current.split(".").map(Number);
  if (arg === "major") return `${major + 1}.0.0`;
  if (arg === "minor") return `${major}.${minor + 1}.0`;
  if (arg === "patch") return `${major}.${minor}.${patch + 1}`;
  fail(`unknown bump "${arg}" — use patch | minor | major | x.y.z`);
}

const arg = process.argv[2];
if (!arg) fail("missing argument — use patch | minor | major | x.y.z");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const current = pkg.version;
if (!SEMVER.test(current)) fail(`current package.json version "${current}" is not x.y.z`);

const next = nextVersion(current, arg);
if (next === current) fail(`new version equals current (${current}) — nothing to do`);

// 1. package.json (keep 2-space JSON + trailing newline, matching the repo).
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// 2. tauri.conf.json — bump ONLY the top-level "version" key (string-targeted so
// nested versions like the schema URL are untouched).
const confRaw = readFileSync(confPath, "utf8");
const confNext = confRaw.replace(
  /("version":\s*")\d+\.\d+\.\d+(")/,
  (_m, a, b) => `${a}${next}${b}`,
);
if (confNext === confRaw) fail("could not find a version field in tauri.conf.json");
writeFileSync(confPath, confNext);

// 3. Cargo.toml — the [package] version line (first `version = "x.y.z"`).
const cargoRaw = readFileSync(cargoPath, "utf8");
const cargoNext = cargoRaw.replace(/^version = "\d+\.\d+\.\d+"/m, `version = "${next}"`);
if (cargoNext === cargoRaw) fail("could not find the [package] version in Cargo.toml");
writeFileSync(cargoPath, cargoNext);

// 4. Cargo.lock — the gg-app entry only (anchored to the name line so other
// packages that happen to share the old version are not touched).
const lockRaw = readFileSync(lockPath, "utf8");
const lockNext = lockRaw.replace(
  /(name = "gg-app"\nversion = ")\d+\.\d+\.\d+(")/,
  (_m, a, b) => `${a}${next}${b}`,
);
if (lockNext === lockRaw) fail("could not find the gg-app entry in Cargo.lock");
writeFileSync(lockPath, lockNext);

console.error(
  `bump-version: ${current} -> ${next} (package.json, tauri.conf.json, Cargo.toml, Cargo.lock)`,
);
process.stdout.write(next + "\n");
