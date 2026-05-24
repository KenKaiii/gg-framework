#!/usr/bin/env -S pnpm exec tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const evidenceDir = "packages/ggcoder/.goal-evidence";
mkdirSync(evidenceDir, { recursive: true });
const logPath = `${evidenceDir}/goal-system-audit-verifier.log`;

const checks: { label: string; ok: boolean; detail: string }[] = [];
function read(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
function check(label: string, ok: boolean, detail: string) {
  checks.push({ label, ok, detail });
}
function hasAll(text: string, needles: string[]) {
  return needles.every((needle) => text.includes(needle));
}

const map = read("packages/ggcoder/docs/goal-system-map.md");
const audit = read("packages/ggcoder/docs/goal-quality-audit.md");
const promptCommands = read("packages/ggcoder/src/core/prompt-commands.ts");
const systemPrompt = read("packages/ggcoder/src/system-prompt.ts");
const goalsTool = read("packages/ggcoder/src/tools/goals.ts");
const store = read("packages/ggcoder/src/core/goal-store.ts");
const controller = read("packages/ggcoder/src/core/goal-controller.ts");
const app = read("packages/ggcoder/src/ui/App.tsx");
const worker = read("packages/ggcoder/src/core/goal-worker.ts");
const verifier = read("packages/ggcoder/src/core/goal-verifier.ts");

check(
  "end-to-end surface map exists",
  hasAll(map, [
    "Invocation and runtime modes",
    "Setup and coordinator system prompts",
    "Goals tool A-Z",
    "Goal-store persistence",
    "Controller decision engine",
    "UI overlay, status bar, start and continue flow",
    "Worker lifecycle",
    "Synthetic Goal events and session recovery",
    "Verifier behavior and final completion",
    "Test coverage map",
  ]),
  "packages/ggcoder/docs/goal-system-map.md must map invocation, persistence, UI, workers, verifier, completion, and tests",
);

check(
  "audit artifact captures findings and recommendations",
  hasAll(audit, ["## Evidence and commands used", "## Findings", "Confidence:", "Recommendation:", "Action status"]),
  "packages/ggcoder/docs/goal-quality-audit.md must provide source-backed findings/recommendations rather than narrative-only proof",
);

check(
  "/goal prompt is setup-only and evidence-oriented",
  hasAll(promptCommands, ["/goal", "Do not implement", "success criteria", "evidence_plan", "verifier", "goals", "then stop"]),
  "prompt-commands.ts must preserve the operator contract for setup-only Goal creation with evidence planning",
);

check(
  "global instructions mention Goal proof semantics",
  /Goal/i.test(systemPrompt) && /sensory|signal|evidence|verifier/i.test(systemPrompt),
  "system-prompt.ts must include applicable Goal proof guidance",
);

check(
  "goals tool exposes complete lifecycle actions",
  hasAll(goalsTool, ["create", "prerequisite", "task", "evidence", "verify", "status", "pause", "resume", "complete"]),
  "goals.ts must expose all expected actions",
);

check(
  "store persists durable goal state",
  hasAll(store, ["GoalRun", "evidencePlan", "harness", "appendGoalEvidence", "upsertGoalRun", "goals.json"]),
  "goal-store.ts must persist runs, harness/evidence plan, and evidence",
);

check(
  "controller gates completion on proof",
  hasAll(controller, ["canCompleteGoalRun", "hasRequiredGoalEvidence", "decideGoalNextAction", "run_verifier"]),
  "goal-controller.ts must gate completion and define next actions",
);

check(
  "UI wires goals overlay and lifecycle",
  hasAll(app, ["startGoalRun", "verifyGoalRun", "continueGoalRun", "GoalOverlay", "goal" ]),
  "App.tsx must connect overlay/status/lifecycle entry points",
);

check(
  "worker and verifier are locally observable",
  hasAll(worker, ["buildGoalWorkerSystemPrompt", "startGoalWorker", "logFile", "appendGoalEvidence"]) && hasAll(verifier, ["runGoalVerifierCommand", "timeoutMs", "outputPath"]),
  "goal-worker.ts and goal-verifier.ts must produce durable local logs/results",
);

const targeted = spawnSync(
  "pnpm",
  [
    "--filter",
    "@kenkaiiii/ggcoder",
    "test",
    "--run",
    "src/core/goal-controller.test.ts",
    "src/core/goal-prerequisites.test.ts",
    "src/core/goal-store.test.ts",
    "src/core/goal-worker.test.ts",
    "src/core/goal-verifier.test.ts",
    "src/tools/goals.test.ts",
    "src/tools/goal-mode.test.ts",
    "src/core/prompt-commands.test.ts",
    "src/system-prompt.test.ts",
    "src/core/goal-lifecycle-smoke.test.ts",
    "src/ui/goal-events.test.ts",
    "src/ui/goal-lifecycle-orchestration.test.ts",
    "--reporter=dot",
  ],
  { encoding: "utf8", stdio: "pipe", timeout: 120_000 },
);
check(
  "targeted /goal behavior tests pass",
  targeted.status === 0,
  `command: pnpm --filter @kenkaiiii/ggcoder test -- src/core/goal-controller.test.ts src/core/goal-prerequisites.test.ts src/core/goal-store.test.ts src/core/goal-worker.test.ts src/core/goal-verifier.test.ts src/tools/goals.test.ts src/tools/goal-mode.test.ts src/core/prompt-commands.test.ts src/system-prompt.test.ts src/core/goal-lifecycle-smoke.test.ts src/ui/goal-events.test.ts src/ui/goal-lifecycle-orchestration.test.ts --reporter=dot\nexit=${targeted.status}\n${(targeted.stdout + targeted.stderr).slice(-4000)}`,
);

const typecheck = spawnSync("pnpm", ["--filter", "@kenkaiiii/ggcoder", "check"], {
  encoding: "utf8",
  stdio: "pipe",
  timeout: 120_000,
});
check(
  "package typecheck passes",
  typecheck.status === 0,
  `command: pnpm --filter @kenkaiiii/ggcoder check\nexit=${typecheck.status}\n${(typecheck.stdout + typecheck.stderr).slice(-4000)}`,
);

let output = "Goal system audit verifier\n";
for (const item of checks) {
  output += `${item.ok ? "PASS" : "FAIL"} ${item.label}\n`;
  if (!item.ok) output += `  ${item.detail.replace(/\n/g, "\n  ")}\n`;
}
output += "\nSignals checked: source map coverage, contradiction/gap audit artifact, setup-only /goal contract, durable goals tool/store/controller/UI/worker/verifier plumbing, prerequisite/evidence-plan/worker/verifier/synthetic-event/pause-resume/final-audit tests, and TypeScript check.\n";
writeFileSync(logPath, output);
console.log(output);
process.exit(checks.every((item) => item.ok) ? 0 : 1);
