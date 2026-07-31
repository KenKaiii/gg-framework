// Build an unsigned local-patched installer. Official release builds are unchanged.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const repoRoot = join(appDir, "..");
const srcTauri = join(appDir, "src-tauri");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const env = { ...process.env, VITE_GG_LOCAL_PATCHED: "1", VITE_GG_SOURCE_ROOT: repoRoot };

function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function requireSuccess(status) {
  if (status !== 0) process.exit(status);
}

function newestFreshFile(dir, extension, startedAt) {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(extension.toLowerCase()))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).mtimeMs >= startedAt)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

export function freshInstallerForPlatform(srcTauriRoot, platform, startedAt) {
  const bundleDir = join(srcTauriRoot, "target", "release", "bundle");
  if (platform === "win32") return newestFreshFile(join(bundleDir, "nsis"), ".exe", startedAt);
  if (platform === "darwin") return newestFreshFile(join(bundleDir, "dmg"), ".dmg", startedAt);
  return newestFreshFile(join(bundleDir, "appimage"), ".AppImage", startedAt);
}

function hostTriple() {
  return execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
}

export function runWithCargoTomlRestored(cargoTomlPath, build) {
  const originalCargoToml = readFileSync(cargoTomlPath);
  try {
    return build();
  } finally {
    writeFileSync(cargoTomlPath, originalCargoToml);
  }
}

export function tauriBuildArgs(platform, configPath) {
  const bundleArgs = platform === "win32" ? ["--bundles", "nsis"] : [];
  return [
    "--filter",
    "gg-app",
    "tauri",
    "build",
    ...bundleArgs,
    "--no-sign",
    "--config",
    configPath,
  ];
}

function stagedNodePath() {
  return join(
    srcTauri,
    "binaries",
    `ggnode-${hostTriple()}${process.platform === "win32" ? ".exe" : ""}`,
  );
}

function localTauriConfigPath() {
  const configDir = join(repoRoot, ".gg", "local-fixes");
  const configPath = join(configDir, "tauri-local-patched.conf.json");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify({ bundle: { createUpdaterArtifacts: false } }, null, 2)}\n`,
  );
  return configPath;
}

function installerMetadata(path) {
  const stats = statSync(path);
  return {
    path,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function writeInstallerManifest(metadata) {
  const outputDir = join(repoRoot, ".gg", "local-fixes");
  mkdirSync(outputDir, { recursive: true });
  const path = join(outputDir, "latest-installer.json");
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`Verified fresh installer: ${metadata.path}`);
  console.log(`SHA-256: ${metadata.sha256}`);
}

async function main() {
  if (!env.GG_NODE_SOURCE) {
    const stagedNode = stagedNodePath();
    if (existsSync(stagedNode)) env.GG_NODE_SOURCE = stagedNode;
    else requireSuccess(run(pnpm, ["--filter", "gg-app", "stage:node"]));
  }
  for (const packageName of [
    "@kenkaiiii/gg-ai",
    "@kenkaiiii/gg-agent",
    "@kenkaiiii/gg-core",
    "@kenkaiiii/ggcoder",
  ]) {
    requireSuccess(run(pnpm, ["--filter", packageName, "build"]));
  }
  requireSuccess(run(pnpm, ["--filter", "gg-app", "bundle:sidecar"]));
  const bundleBuildStartedAt = Date.now();
  const cargoTomlPath = join(srcTauri, "Cargo.toml");
  const buildStatus = runWithCargoTomlRestored(cargoTomlPath, () =>
    run(pnpm, tauriBuildArgs(process.platform, localTauriConfigPath())),
  );
  if (buildStatus !== 0) process.exit(buildStatus);
  const installer = freshInstallerForPlatform(srcTauri, process.platform, bundleBuildStartedAt);
  if (!installer) {
    console.error("Tauri did not produce a fresh installer for this build.");
    process.exit(1);
  }
  writeInstallerManifest(installerMetadata(installer));
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
