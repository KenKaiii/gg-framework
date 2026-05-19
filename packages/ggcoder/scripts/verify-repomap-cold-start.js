/**
 * Smoke verification for fresh-session repo-map ranking.
 *
 * This intentionally passes no readFiles: a brand-new agent has only the repo map,
 * so specific changed files should lead broad hubs like App.tsx/cli.ts.
 * Run:
 *   pnpm --filter @kenkaiiii/ggcoder verify:repomap:cold-start
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { FOCUSED_REPO_MAP_MAX_CHARS, buildRepoMap } from "../dist/core/repomap.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");

const GGCODER_CHANGED_FILES = [
  "packages/ggcoder/src/core/repomap.test.ts",
  "packages/ggcoder/src/core/repomap.ts",
  "packages/ggcoder/package.json",
  "packages/ggcoder/scripts/verify-repomap-focus.js",
  "packages/ggcoder/scripts/verify-repomap-cold-start.js",
  "packages/ggcoder/src/cli.ts",
  "packages/ggcoder/src/core/agent-session.ts",
  "packages/ggcoder/src/core/repomap-context.test.ts",
  "packages/ggcoder/src/core/repomap-context.ts",
  "packages/ggcoder/src/tools/index.ts",
  "packages/ggcoder/src/tools/read.ts",
  "packages/ggcoder/src/ui/App.tsx",
  "packages/ggcoder/src/ui/render.ts",
];

const OTHER_CHANGED_FILES = [
  ...Array.from({ length: 16 }, (_, index) => `packages/gg-voice/src/dirty-${index}.ts`),
  ...Array.from({ length: 5 }, (_, index) => `packages/gg-ai/src/dirty-${index}.ts`),
  "packages/gg-agent/src/dirty.ts",
  "packages/gg-boss/src/dirty.ts",
];

const EXPECTED_EARLY_SOURCE_FILES = [
  "packages/ggcoder/src/core/repomap.ts",
  "packages/ggcoder/src/core/repomap.test.ts",
  "packages/ggcoder/src/core/agent-session.ts",
];

const checks = [];

function record(name, pass, detail = "") {
  checks.push({ name, pass, detail });
  process.stdout.write(`[${pass ? "PASS" : "FAIL"}] ${name}\n`);
  if (detail) process.stdout.write(`       ${detail.replace(/\n/g, "\n       ")}\n`);
}

function isGgCoderPath(filePath) {
  return filePath === "package.json" || filePath.startsWith("packages/ggcoder/");
}

async function main() {
  const rendered = await buildRepoMap({
    cwd: REPO_ROOT,
    maxChars: FOCUSED_REPO_MAP_MAX_CHARS,
    focusTerms: ["repo map", "cold start", "fresh agent"],
    now: new Date("2026-01-01T00:00:00.000Z"),
    listGitChangedFiles: async () => [...GGCODER_CHANGED_FILES, ...OTHER_CHANGED_FILES],
  });

  const paths = rendered.snapshot.files.map((file) => file.path);
  process.stdout.write("\nRendered cold-start repo map:\n");
  process.stdout.write(`${rendered.markdown}\n\n`);

  record("no Already read line is rendered", !rendered.markdown.includes("Already read:"));
  record(
    "active package is ggcoder",
    JSON.stringify(rendered.snapshot.activeRoots) === JSON.stringify(["packages/ggcoder"]),
    JSON.stringify(rendered.snapshot.activeRoots),
  );
  record(
    "gg-voice is summarized as other dirty package",
    rendered.markdown.includes("Other dirty packages: gg-voice(16)"),
  );
  record(
    "rendered files stay in ggcoder/root context",
    paths.every(isGgCoderPath),
    paths.filter((filePath) => !isGgCoderPath(filePath)).join("\n"),
  );
  record(
    "specific source files are early in cold-start ranking",
    EXPECTED_EARLY_SOURCE_FILES.every((filePath) => paths.slice(0, 5).includes(filePath)),
    paths.slice(0, 8).join("\n"),
  );
  record(
    "broad App.tsx and cli.ts are demoted",
    paths.indexOf("packages/ggcoder/src/ui/App.tsx") > 5 &&
      paths.indexOf("packages/ggcoder/src/cli.ts") > 5,
    paths.slice(0, 8).join("\n"),
  );

  const failed = checks.filter((check) => !check.pass);
  if (failed.length > 0) {
    process.stderr.write(`\n${failed.length} cold-start repo-map check(s) failed.\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
