import type { GoalRun } from "./goal-store.js";
import { decideGoalNextAction } from "./goal-controller.js";
import { buildGoalWorkerSystemPrompt } from "./goal-worker.js";
import {
  buildGoalSetupPromptFromPlanner,
  collectAssistantTextSince,
} from "../ui/prompt-routing.js";
import { buildSystemPrompt } from "../system-prompt.js";
import type { Message } from "@kenkaiiii/gg-ai";

export interface GoalOverheadStageMeasurement {
  stage: string;
  promptChars: number;
  taskCount: number;
  blockerCount: number;
  requiredProofGates: number;
  decisionKind?: string;
  decisionReasonChars?: number;
}

export interface GoalOverheadScenarioMeasurement {
  scenario: "simple" | "complex";
  stageCount: number;
  promptChars: number;
  taskCount: number;
  blockerCount: number;
  requiredProofGates: number;
  stages: GoalOverheadStageMeasurement[];
}

export interface GoalOverheadHarnessResult {
  intendedExperience: string;
  failureModes: string[];
  observedSignals: string[];
  scenarios: GoalOverheadScenarioMeasurement[];
  comparisons: {
    promptCharsComplexToSimpleRatio: number;
    stageCountDelta: number;
    taskCountDelta: number;
    blockerCountDelta: number;
    requiredProofGateDelta: number;
  };
}

const ORIGINAL_GOAL_PROMPT_REFERENCE = "[original-goal-prompt]";
const CREATED_AT = "2024-01-01T00:00:00.000Z";

function baseRun(overrides: Partial<GoalRun>): GoalRun {
  return {
    id: "goal-overhead-harness",
    title: "Goal overhead harness",
    goal: "Optimize /goal to be faster, lower-token, less blocker-prone, and simpler while preserving durable delivery using [original-goal-prompt].",
    status: "ready",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    projectPath: "/tmp/ggcoder-goal-overhead-harness",
    successCriteria: [],
    prerequisites: [],
    harness: [],
    evidencePlan: [],
    tasks: [],
    evidence: [
      {
        id: "planner-plan",
        kind: "summary",
        label: "Planner GOAL_PLAN",
        content:
          "GOAL_PLAN\nresearch=local goal overhead harness\nsuccess=compare simple and complex /goal setup/controller overhead using [original-goal-prompt]\nEND_GOAL_PLAN",
        createdAt: CREATED_AT,
      },
    ],
    blockers: [],
    references: [
      {
        id: "original-goal-prompt",
        kind: "prompt",
        label: "Original Goal prompt",
        source: "user",
        content:
          "Users report /goal is slow, high-token, blocker-prone, and over-engineered; optimize it while preserving reliable durable delivery.",
      },
    ],
    ...overrides,
  };
}

function proofGateCount(run: GoalRun): number {
  const verifierGate = run.verifier?.command ? 1 : 0;
  const finalAuditGate = run.verifier?.lastResult?.status === "pass" ? 1 : 0;
  return (
    run.prerequisites.length +
    run.harness.length +
    run.evidencePlan.length +
    verifierGate +
    finalAuditGate
  );
}

function blockerCount(run: GoalRun): number {
  const missingPrerequisites = run.prerequisites.filter((item) => item.status === "missing").length;
  const blockedEvidence = run.evidencePlan.filter((item) => item.status === "blocked").length;
  const blockedTasks = run.tasks.filter((item) => item.status === "blocked").length;
  return run.blockers.length + missingPrerequisites + blockedEvidence + blockedTasks;
}

function promptCharCount(...prompts: Array<string | undefined>): number {
  return prompts.reduce((total, prompt) => total + (prompt?.length ?? 0), 0);
}

function measureControllerStage(stage: string, run: GoalRun): GoalOverheadStageMeasurement {
  const decision = decideGoalNextAction(run);
  const prompt = decision.kind === "create_task" ? decision.prompt : undefined;
  return {
    stage,
    promptChars: promptCharCount(prompt),
    taskCount: run.tasks.length,
    blockerCount: blockerCount(run),
    requiredProofGates: proofGateCount(run),
    decisionKind: decision.kind,
    decisionReasonChars: decision.reason.length,
  };
}

function scenarioTotals(
  scenario: GoalOverheadScenarioMeasurement["scenario"],
  stages: GoalOverheadStageMeasurement[],
): GoalOverheadScenarioMeasurement {
  return {
    scenario,
    stageCount: stages.length,
    promptChars: stages.reduce((total, stage) => total + stage.promptChars, 0),
    taskCount: stages.reduce((total, stage) => total + stage.taskCount, 0),
    blockerCount: stages.reduce((total, stage) => total + stage.blockerCount, 0),
    requiredProofGates: stages.reduce((total, stage) => total + stage.requiredProofGates, 0),
    stages,
  };
}

function measurePromptSetup(
  originalGoalPrompt: string,
  plannerOutput: string,
): GoalOverheadStageMeasurement {
  const messages: Message[] = [{ role: "assistant", content: plannerOutput }];
  const collectedPlannerOutput = collectAssistantTextSince(messages, 0);
  const setupPrompt = buildGoalSetupPromptFromPlanner({
    originalGoalPrompt,
    plannerOutput: collectedPlannerOutput,
  });
  return {
    stage: "prompt-routing: planner-to-setup",
    promptChars: promptCharCount(originalGoalPrompt, collectedPlannerOutput, setupPrompt),
    taskCount: 0,
    blockerCount: 0,
    requiredProofGates: 0,
  };
}

export async function runGoalOverheadHarness(): Promise<GoalOverheadHarnessResult> {
  const simpleOriginalPrompt = `/goal Fix a small local bug. ${ORIGINAL_GOAL_PROMPT_REFERENCE}`;
  const complexOriginalPrompt = `/goal Optimize the GG Coder /goal system using ${ORIGINAL_GOAL_PROMPT_REFERENCE}: make runs faster, lower-token, less blocker-prone, and simpler while preserving durable delivery.`;

  const simpleRun = baseRun({
    successCriteria: [
      "Local verifier proves the small bug is fixed and mentions [original-goal-prompt].",
    ],
    evidencePlan: [
      {
        id: "local-proof",
        label: "Local proof for [original-goal-prompt]",
        mechanism: "test",
        description: "A single local command proves the change.",
        status: "ready",
        evidence: "local command available",
        command: "pnpm test --filter local-proof",
      },
    ],
    verifier: {
      description: "Run one local verifier for [original-goal-prompt].",
      command: "pnpm test --filter local-proof",
    },
  });

  const complexRun = baseRun({
    successCriteria: [
      "Compare representative simple vs complex Goal overhead by stage count and prompt characters using [original-goal-prompt].",
      "Measure task count, blocker count, and required proof gates before changing the flow.",
      "Preserve durable verifier and final audit reliability.",
    ],
    prerequisites: [
      {
        id: "external-service",
        label: "External benchmark service",
        status: "missing",
        instructions: "Provide paid benchmark credentials.",
      },
    ],
    harness: [
      {
        id: "missing-harness",
        label: "Synthetic /goal overhead harness",
        description: "Compares setup/controller overhead.",
      },
    ],
    evidencePlan: [
      {
        id: "overhead-metrics",
        label: "Synthetic /goal overhead metrics for [original-goal-prompt]",
        mechanism: "test",
        description:
          "Captures stage count, prompt characters, task count, blocker count, and required proof gates.",
        status: "planned",
      },
      {
        id: "audit-proof",
        label: "Final audit proof gate",
        mechanism: "command",
        description: "Confirms reliable durable delivery remains present.",
        status: "planned",
      },
    ],
    tasks: [
      {
        id: "task-1",
        title: "Research hotspots",
        prompt:
          "Inspect prompt-routing.ts, system-prompt.ts, goal-controller.ts, and goal-worker.ts for [original-goal-prompt].",
        status: "done",
        attempts: 1,
      },
      {
        id: "task-2",
        title: "Implement simplification",
        prompt: "Reduce overhead while preserving [original-goal-prompt] reliability.",
        status: "pending",
        attempts: 0,
        dependsOn: ["task-1"],
      },
    ],
    blockers: ["Unnecessary missing external prerequisite should be visible to blocker metrics."],
  });

  const simpleStages = [
    measurePromptSetup(
      simpleOriginalPrompt,
      "GOAL_PLAN\nresearch=none\nsuccess=single local verifier using [original-goal-prompt]\nEND_GOAL_PLAN",
    ),
    measureControllerStage("controller: ready-to-verify", simpleRun),
    {
      stage: "worker: system-prompt",
      promptChars: promptCharCount(
        buildGoalWorkerSystemPrompt({
          cwd: simpleRun.projectPath,
          goalRunId: simpleRun.id,
          goalTaskId: "simple-task",
          taskTitle: "Simple local work",
        }),
      ),
      taskCount: 1,
      blockerCount: 0,
      requiredProofGates: proofGateCount(simpleRun),
    },
    {
      stage: "system: goal-mode prompt",
      promptChars: promptCharCount(
        await buildSystemPrompt(
          simpleRun.projectPath,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "setup",
        ),
      ),
      taskCount: 0,
      blockerCount: 0,
      requiredProofGates: 0,
    },
  ];

  const complexStages = [
    measurePromptSetup(
      complexOriginalPrompt,
      "GOAL_PLAN\nresearch=prompt-routing.ts system-prompt.ts goal-controller.ts goal-worker.ts\nsuccess=stage count, prompt chars, task count, blocker count, proof gates for [original-goal-prompt]\nproof=synthetic harness\nEND_GOAL_PLAN",
    ),
    measureControllerStage("controller: blocked-prerequisite", complexRun),
    measureControllerStage(
      "controller: evidence-instrumentation",
      baseRun({
        ...complexRun,
        prerequisites: [],
        blockers: [],
      }),
    ),
    measureControllerStage(
      "controller: harness-instrumentation",
      baseRun({
        ...complexRun,
        prerequisites: [],
        blockers: [],
        evidencePlan: complexRun.evidencePlan.map((item) => ({
          ...item,
          status: "ready" as const,
          evidence: "ready for harness comparison",
        })),
      }),
    ),
    {
      stage: "worker: system-prompt",
      promptChars: promptCharCount(
        buildGoalWorkerSystemPrompt({
          cwd: complexRun.projectPath,
          goalRunId: complexRun.id,
          goalTaskId: "complex-task",
          taskTitle: "Complex optimization work",
        }),
      ),
      taskCount: complexRun.tasks.length,
      blockerCount: blockerCount(complexRun),
      requiredProofGates: proofGateCount(complexRun),
    },
    {
      stage: "system: goal-mode prompt",
      promptChars: promptCharCount(
        await buildSystemPrompt(
          complexRun.projectPath,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "setup",
        ),
      ),
      taskCount: 0,
      blockerCount: 0,
      requiredProofGates: 0,
    },
  ];

  const simple = scenarioTotals("simple", simpleStages);
  const complex = scenarioTotals("complex", complexStages);

  return {
    intendedExperience:
      "A /goal run should move from the user's original-goal-prompt to local work, verifier evidence, and durable delivery with minimal stages, compact prompts, and no avoidable blockers when local proof is possible.",
    failureModes: [
      "Prompt-routing or system/worker prompts inflate token use before any useful work begins.",
      "Controller creates extra instrumentation/audit tasks for simple local goals instead of proceeding A-to-Z.",
      "Missing or blocked prerequisites stop a run even though local/free evidence could be produced.",
      "Proof gates multiply beyond the verifier/audit needed for reliable durable delivery.",
    ],
    observedSignals: [
      "stageCount",
      "promptChars",
      "taskCount",
      "blockerCount",
      "requiredProofGates",
      "controller decision kind and reason length",
    ],
    scenarios: [simple, complex],
    comparisons: {
      promptCharsComplexToSimpleRatio: Number(
        (complex.promptChars / simple.promptChars).toFixed(2),
      ),
      stageCountDelta: complex.stageCount - simple.stageCount,
      taskCountDelta: complex.taskCount - simple.taskCount,
      blockerCountDelta: complex.blockerCount - simple.blockerCount,
      requiredProofGateDelta: complex.requiredProofGates - simple.requiredProofGates,
    },
  };
}
