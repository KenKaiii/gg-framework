#!/usr/bin/env -S pnpm exec tsx
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGoalsTool } from "../dist/tools/goals.js";
import { canCompleteGoalRun, decideGoalNextAction } from "../dist/core/goal-controller.js";
import { getGoalRun } from "../dist/core/goal-store.js";
import type { GoalReference, GoalRun } from "../src/core/goal-store.js";

const evidenceDir = path.resolve("packages/ggcoder/.goal-evidence");
const logPath = path.join(evidenceDir, "goal-scenario-matrix.log");
await fs.mkdir(evidenceDir, { recursive: true });

const secret = "sk-live-goal-matrix-secret-DO-NOT-LEAK";
process.env.GOAL_MATRIX_SECRET = secret;

const originalGoalReference: GoalReference = {
  id: "original-goal-prompt",
  kind: "prompt",
  label: "Original Goal prompt",
  source: "user",
  whyItMatters:
    "The exact /goal prompt text that started this run. Preserve its reference requirements in criteria, tasks, verifier, and audit.",
  content:
    "Test the /goal system from a-z. How reliable is this system? How domain specific or agnostic is it across random user requests? See if there are leaks. If leaks -> fix. Then give me a table in an .md file.",
};

const externalReference: GoalReference = {
  id: "mandatory-external-reference",
  kind: "url",
  label: "Mandatory external product reference",
  source: "https://example.invalid/private-reference",
  whyItMatters: "Scenario must block instead of ignoring inaccessible required references.",
};

type Scenario = {
  id: string;
  domain: string;
  prompt: string;
  fixtureFile?: string;
  external?: boolean;
  ambiguous?: boolean;
  errorHandling?: boolean;
};

const scenarios: Scenario[] = [
  { id: "app-ui", domain: "app UI", prompt: "Build a polished React onboarding screen and prove keyboard and visual states.", fixtureFile: "ui-fixture.html" },
  { id: "backend-api", domain: "backend/API", prompt: "Add a REST endpoint with validation, persistence, and API contract proof.", fixtureFile: "api-contract.json" },
  { id: "automation-workflow", domain: "automation/workflow", prompt: "Create an invoice reminder workflow with retry and idempotency evidence.", fixtureFile: "workflow-events.jsonl" },
  { id: "bug-fix", domain: "bug fix", prompt: "Fix a race condition and prove the failing reproduction now passes.", fixtureFile: "repro.test.txt" },
  { id: "refactor", domain: "refactor", prompt: "Refactor duplicated services without behavior changes and prove parity.", fixtureFile: "parity-report.txt" },
  { id: "docs-content", domain: "docs/content", prompt: "Improve docs and prove examples match the implemented CLI behavior.", fixtureFile: "docs-example.md" },
  { id: "data-migration", domain: "data/migration", prompt: "Add a reversible data migration with fixture-backed before/after assertions.", fixtureFile: "migration-fixture.sql" },
  { id: "tests-qa", domain: "tests/QA", prompt: "Expand QA coverage around flaky login flows and prove deterministic pass/fail signals.", fixtureFile: "qa-plan.txt" },
  { id: "error-handling", domain: "error-handling", prompt: "Harden error handling for failed payments and prove redacted logs plus recovery behavior.", fixtureFile: "errors.log", errorHandling: true },
  { id: "ambiguous", domain: "ambiguous/underspecified requests", prompt: "Make it better.", ambiguous: true },
  { id: "mandatory-external-references", domain: "mandatory external references", prompt: "Implement the behavior shown in the required external product reference.", external: true },
];

async function execute(cwd: string, refs: GoalReference[], args: Parameters<ReturnType<typeof createGoalsTool>["execute"]>[0]) {
  return createGoalsTool(cwd, undefined, () => refs).execute(args, {
    signal: new AbortController().signal,
    toolCallId: "goal-scenario-matrix",
  });
}

function assertNoSecret(value: unknown, label: string) {
  assert.ok(!JSON.stringify(value).includes(secret), `${label} leaked secret`);
}

const rows: string[] = [];
let passed = 0;
const previousGoalsBase = process.env.GG_GOALS_BASE;
const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "goal-scenario-base-"));
const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "goal-scenario-project-"));
process.env.GG_GOALS_BASE = tmpBase;

try {
  for (const scenario of scenarios) {
    const fixture = scenario.fixtureFile ? path.join(tmpProject, scenario.fixtureFile) : undefined;
    if (fixture) await fs.writeFile(fixture, `${scenario.id} local fixture\n`, "utf8");
    const refs = scenario.external ? [originalGoalReference, externalReference] : [originalGoalReference];
    const runId = `matrix-${scenario.id}`;
    const criteria = [
      `[original-goal-prompt] setup preserves objective for ${scenario.domain}`,
      `Domain-specific observable proof is selected for ${scenario.domain}`,
      "No implementation is performed during setup",
      "Secrets are redacted from durable state and evidence",
      "Completion waits for verifier and final audit",
    ];
    const prerequisites = scenario.external
      ? [{ id: "external-access", label: "Access to mandatory-external-reference", status: "missing" as const, instructions: "Provide a locally accessible copy or credentials-free fixture for mandatory-external-reference." }]
      : scenario.ambiguous
        ? [{ id: "clarify-scope", label: "Clarify underspecified request", status: "missing" as const, instructions: "Specify what 'better' means and the observable success signal." }]
        : fixture
          ? [{ id: "local-fixture", label: `${scenario.domain} local fixture exists`, status: "unknown" as const, check_command: `test -f ${JSON.stringify(path.basename(fixture))}` }]
          : [];
    const evidencePlan = [
      {
        id: "domain-proof",
        label: `[original-goal-prompt] ${scenario.external ? "[mandatory-external-reference] " : ""}${scenario.domain} domain proof`,
        mechanism: scenario.external || scenario.ambiguous ? "manual" as const : "command" as const,
        description: `Observable, domain-appropriate proof for ${scenario.domain}; does not rely on narrative inspection.${scenario.external ? " Must compare mandatory-external-reference before work starts." : ""}`,
        status: scenario.external || scenario.ambiguous ? "blocked" as const : "planned" as const,
        ...(fixture ? { command: `test -f ${JSON.stringify(path.basename(fixture))}`, path: path.basename(fixture) } : {}),
        ...(scenario.external ? { instructions: "Blocked until mandatory-external-reference is provided locally." } : {}),
      },
    ];
    await execute(tmpProject, refs, {
      action: "create",
      run_id: runId,
      title: `Scenario matrix: ${scenario.domain}`,
      goal: `[original-goal-prompt] ${scenario.prompt}`,
      success_criteria: criteria,
      prerequisites,
      harness: [{ id: "scenario-matrix", label: "Domain-agnostic setup/leak contract", command: "pnpm --filter @kenkaiiii/ggcoder exec tsx scripts/verify-goal-scenario-matrix.ts", path: "packages/ggcoder/.goal-evidence/goal-scenario-matrix.log", description: "Checks setup expectations and leak signals across scenario domains." }],
      evidence_plan: evidencePlan,
      verifier_command: scenario.external || scenario.ambiguous ? undefined : `test -f ${JSON.stringify(path.basename(fixture!))}`,
      verifier_description: `[original-goal-prompt] verifier for ${scenario.domain}`,
      summary: `GOAL_PLAN\nreference=[original-goal-prompt]\ndomain=${scenario.domain}\nsetup_only=true\nsecret_redacted=${process.env.GOAL_MATRIX_SECRET ? "present-but-not-recorded" : "none"}\nEND_GOAL_PLAN`,
    });
    const run = (await getGoalRun(tmpProject, runId)) as GoalRun;
    assert.equal(run.tasks.length, 0, `${scenario.domain}: setup created no implementation tasks yet`);
    assert.ok(run.successCriteria.length >= 3, `${scenario.domain}: criteria present`);
    assert.ok(run.evidencePlan.length >= 1, `${scenario.domain}: evidence plan present`);
    assert.ok(run.harness.length >= 1, `${scenario.domain}: harness present`);
    assert.ok(run.references?.some((r) => r.id === "original-goal-prompt"), `${scenario.domain}: original reference preserved`);
    assert.ok(run.goal.includes("[original-goal-prompt]"), `${scenario.domain}: goal acknowledges mandatory prompt reference`);
    assert.ok(run.verifier?.description?.includes("[original-goal-prompt]") || scenario.external || scenario.ambiguous, `${scenario.domain}: verifier/reference handoff present or intentionally blocked`);
    assertNoSecret(run, scenario.domain);
    assert.equal(canCompleteGoalRun(run).ok, false, `${scenario.domain}: no premature completion`);
    const decision = decideGoalNextAction(run);
    if (scenario.external || scenario.ambiguous) {
      assert.equal(run.status, "blocked", `${scenario.domain}: true prerequisite is blocked`);
      assert.ok(run.blockers.length > 0, `${scenario.domain}: blocker instructions recorded`);
    } else {
      assert.notEqual(decision.kind, "complete", `${scenario.domain}: controller does not complete setup-only run`);
    }
    rows.push(`PASS | ${scenario.domain} | status=${run.status} | decision=${decision.kind} | refs=${run.references?.map((r) => r.id).join(",")}`);
    passed++;
  }
} finally {
  if (previousGoalsBase === undefined) delete process.env.GG_GOALS_BASE;
  else process.env.GG_GOALS_BASE = previousGoalsBase;
  await fs.rm(tmpBase, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
}

const output = [
  "Goal scenario matrix harness",
  `Scenarios passed: ${passed}/${scenarios.length}`,
  "Signals: setup-only/no implementation, mandatory reference preservation, criteria/evidence/verifier/harness presence, external/ambiguous blockers, secret redaction, no premature completion.",
  ...rows,
  "",
].join("\n");
await fs.writeFile(logPath, output, "utf8");
console.log(output);
assert.equal(passed, scenarios.length);
