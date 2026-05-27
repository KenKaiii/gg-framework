#!/usr/bin/env -S pnpm exec tsx
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_REPORT_PATH = "packages/ggcoder/docs/goal-system-efficiency-audit.md";
const DEFAULT_INVENTORY_PATH = "packages/ggcoder/docs/goal-system-overhead-inventory.json";
const PACKAGE_PREFIX = "packages/ggcoder/";

function resolveExistingPath(path: string): string {
  if (existsSync(path)) return path;
  if (path.startsWith(PACKAGE_PREFIX)) {
    const packageRelativePath = path.slice(PACKAGE_PREFIX.length);
    if (existsSync(packageRelativePath)) return packageRelativePath;
  }
  return path;
}

const verifyFlagIndex = process.argv.indexOf("--verify");
const positionalReportPath = process.argv.find(
  (arg, index) => index > 1 && arg !== "--" && arg !== "--verify" && process.argv[index - 1] !== "--verify",
);
const reportPath = resolveExistingPath(
  verifyFlagIndex >= 0
    ? (process.argv[verifyFlagIndex + 1] ?? DEFAULT_REPORT_PATH)
    : (positionalReportPath ?? DEFAULT_REPORT_PATH),
);
const inventoryPath = resolveExistingPath(DEFAULT_INVENTORY_PATH);

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function readRequired(path: string): string {
  if (!existsSync(path)) fail(`Missing required file: ${path}`);
  return readFileSync(path, "utf8");
}

const report = readRequired(reportPath);
const inventoryText = readRequired(inventoryPath);
let inventory: any;
try {
  inventory = JSON.parse(inventoryText);
} catch (error) {
  fail(`Inventory is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

const requiredReportNeedles = [
  "[original-goal-prompt]",
  "GOAL_PLAN",
  "packages/ggcoder/src/ui/App.tsx",
  "packages/ggcoder/src/ui/prompt-routing.ts",
  "packages/ggcoder/src/system-prompt.ts",
  "packages/ggcoder/src/core/goal-controller.ts",
  "packages/ggcoder/src/core/goal-store.ts",
  "packages/ggcoder/src/core/goal-worker.ts",
  "packages/ggcoder/src/core/goal-overhead-harness.ts",
  "Stage count",
  "Prompt chars",
  "Ranked quick wins/design changes",
];
for (const needle of requiredReportNeedles) {
  if (!report.includes(needle)) fail(`Report is missing required coverage: ${needle}`);
}

if (inventory?.referenceCoverage?.mandatoryReference !== "[original-goal-prompt]") {
  fail("Inventory does not preserve [original-goal-prompt] reference coverage.");
}
if (inventory?.referenceCoverage?.plannerEvidence !== "GOAL_PLAN") {
  fail("Inventory does not preserve GOAL_PLAN coverage.");
}
const measured = inventory?.measuredEvidence;
if (!measured?.simpleScenario || !measured?.complexScenario || !measured?.deltas) {
  fail("Inventory is missing measured simple/complex/delta overhead evidence.");
}
const signals = ["stageCount", "promptChars", "taskCount", "blockerCount", "requiredProofGates"];
for (const signal of signals) {
  if (typeof measured.simpleScenario[signal] !== "number") fail(`Simple scenario missing numeric ${signal}.`);
  if (typeof measured.complexScenario[signal] !== "number") fail(`Complex scenario missing numeric ${signal}.`);
}
if (measured.complexScenario.stageCount <= measured.simpleScenario.stageCount) {
  fail("Complex scenario should have higher stage count than simple scenario.");
}
if (measured.complexScenario.taskCount <= measured.simpleScenario.taskCount) {
  fail("Complex scenario should have higher task count than simple scenario.");
}
if (measured.complexScenario.requiredProofGates <= measured.simpleScenario.requiredProofGates) {
  fail("Complex scenario should have higher proof-gate count than simple scenario.");
}
if (!Array.isArray(inventory.rankedRecommendations) || inventory.rankedRecommendations.length < 5) {
  fail("Inventory must include at least five ranked recommendations.");
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      report: resolve(reportPath),
      inventory: resolve(inventoryPath),
      reference: inventory.referenceCoverage.mandatoryReference,
      plannerEvidence: inventory.referenceCoverage.plannerEvidence,
      simple: measured.simpleScenario,
      complex: measured.complexScenario,
      recommendationCount: inventory.rankedRecommendations.length,
    },
    null,
    2,
  ),
);
