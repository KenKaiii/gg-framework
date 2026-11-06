#!/usr/bin/env node
// Prints the GitHub release body for a desktop version from gg-app/src/changelog.ts.
// Usage: node .github/ci/release-notes.mjs v0.103.1
// Exits 1 when the version has no changelog entry, so callers can fall back.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHANGELOG = path.join(REPO_ROOT, "gg-app/src/changelog.ts");

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!version) {
  console.error("usage: release-notes.mjs <version>");
  process.exit(2);
}

const { CHANGELOG: entries } = await import(pathToFileURL(CHANGELOG).href);
const entry = entries.find((e) => e.version === version);
if (!entry) {
  console.error(`No changelog entry for ${version}`);
  process.exit(1);
}

const lines = ["## What's new", "", ...entry.items.map((item) => `- ${item}`)];
lines.push("", "Download the installer for your platform from the assets below.");
console.log(lines.join("\n"));
