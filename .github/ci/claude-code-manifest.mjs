#!/usr/bin/env node
// Regenerates packages/gg-core/src/claude-code/manifest.json: the per-platform
// Claude Code binary tarballs GG Coder downloads on demand for "Sign in with
// Claude", pinned to the @anthropic-ai/claude-agent-sdk version ggcoder uses.
//
//   node .github/ci/claude-code-manifest.mjs          # rewrite from the npm registry
//   node .github/ci/claude-code-manifest.mjs --check  # CI: fail if out of date (offline)
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SDK = "@anthropic-ai/claude-agent-sdk";
const MANIFEST = join(ROOT, "packages/gg-core/src/claude-code/manifest.json");
const PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-arm64-musl",
  "linux-x64",
  "linux-x64-musl",
  "win32-arm64",
  "win32-x64",
];

function pinnedSdkVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "packages/ggcoder/package.json"), "utf8"));
  const version = pkg.dependencies?.[SDK];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${SDK} must be pinned to an exact version in packages/ggcoder/package.json`);
  }
  return version;
}

function installedClaudeCodeVersion() {
  // The SDK's exports map hides package.json; resolve the entry and walk up.
  const require = createRequire(join(ROOT, "packages/ggcoder/package.json"));
  const sdkDir = dirname(require.resolve(SDK));
  return JSON.parse(readFileSync(join(sdkDir, "manifest.json"), "utf8")).version;
}

async function generate() {
  const sdkVersion = pinnedSdkVersion();
  const platforms = {};
  for (const platform of PLATFORMS) {
    const name = `${SDK}-${platform}`;
    const res = await fetch(`https://registry.npmjs.org/${name}/${sdkVersion}`);
    if (!res.ok) throw new Error(`${name}@${sdkVersion}: registry returned ${res.status}`);
    const { dist } = await res.json();
    if (!dist?.integrity?.startsWith("sha512-")) throw new Error(`${name}: no sha512 integrity`);
    platforms[platform] = {
      url: dist.tarball,
      integrity: dist.integrity,
      bin: platform.startsWith("win32") ? "claude.exe" : "claude",
    };
  }
  const manifest = { sdkVersion, claudeCodeVersion: installedClaudeCodeVersion(), platforms };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Wrote ${MANIFEST} for ${SDK}@${sdkVersion}`);
}

function check() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const problems = [];
  const sdkVersion = pinnedSdkVersion();
  if (manifest.sdkVersion !== sdkVersion) {
    problems.push(`manifest sdkVersion ${manifest.sdkVersion} != pinned ${SDK}@${sdkVersion}`);
  }
  const cc = installedClaudeCodeVersion();
  if (manifest.claudeCodeVersion !== cc) {
    problems.push(
      `manifest claudeCodeVersion ${manifest.claudeCodeVersion} != installed SDK's ${cc}`,
    );
  }
  for (const platform of PLATFORMS) {
    const entry = manifest.platforms?.[platform];
    if (!entry?.url?.includes(`-${sdkVersion}.tgz`) || !entry.integrity?.startsWith("sha512-")) {
      problems.push(`platform ${platform} missing or not for ${sdkVersion}`);
    }
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error("Run: node .github/ci/claude-code-manifest.mjs");
    process.exit(1);
  }
  console.log(`Claude Code manifest matches ${SDK}@${sdkVersion}`);
}

if (process.argv.includes("--check")) check();
else await generate();
