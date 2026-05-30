import { describe, expect, it } from "vitest";
import { stepGoalRun, type GoalEffects, type GoalStepResult } from "./goal-engine.js";
import type { GoalControllerOptions } from "./goal-controller.js";
import type { GoalStageResult } from "./goal-integration.js";
import type { GoalRun, GoalTask, GoalVerificationResult } from "./goal-store.js";

const APPLY_TITLE = "Apply integrated worktree to main";
const AUDIT_TITLE = "Audit Goal completion evidence";
const VERIFIER_COMMAND = "node --test";

function baseRun(overrides: Partial<GoalRun> = {}): GoalRun {
  return {
    id: "engine-goal",
    title: "Engine goal",
    goal: "Drive the pure orchestration engine",
    status: "ready",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    projectPath: "/tmp/project",
    successCriteria: ["Verifier passes"],
    prerequisites: [],
    harness: [],
    evidencePlan: [
      {
        id: "tests-green",
        label: "tests green",
        mechanism: "test",
        description: "node --test passes",
        status: "ready",
        evidence: "ready",
      },
    ],
    tasks: [],
    evidence: [],
    blockers: [],
    verifier: { description: "node test", command: VERIFIER_COMMAND },
    ...overrides,
  };
}

function implTask(): GoalTask {
  return {
    id: "impl",
    title: "Implement feature",
    prompt: "Implement it",
    status: "pending",
    attempts: 0,
    integration: "candidate",
    expectedChangedScope: ["src/**"],
    worktree: {
      baseRef: "base-sha",
      branchName: "goal/impl",
      path: "/tmp/wt/impl",
      status: "created",
    },
  };
}

interface HarnessConfig {
  stage?: GoalStageResult;
  verifier?: (call: number) => GoalVerificationStatusLike;
}

type GoalVerificationStatusLike = "pass" | "fail";

interface Harness {
  effects: GoalEffects;
  run: GoalRun;
}

function makeHarness(initial: GoalRun, config: HarnessConfig = {}): Harness {
  const state: { run: GoalRun } = { run: initial };
  let tick = 0;
  const now = (): string => new Date(Date.UTC(2024, 0, 1, 0, 0, tick++)).toISOString();
  let verifierCalls = 0;

  const effects: GoalEffects = {
    now,
    log: () => undefined,
    reload: async () => state.run,
    startWorker: async (task, attempts) => {
      const at = now();
      state.run = {
        ...state.run,
        tasks: state.run.tasks.map((item) =>
          item.id === task.id
            ? {
                ...item,
                status: "done",
                attempts,
                ...(item.worktree
                  ? {
                      candidate: {
                        baseRef: item.worktree.baseRef,
                        headSha: "head-sha",
                        branchName: item.worktree.branchName,
                        changedFiles: ["src/x.ts"],
                        committed: true,
                      },
                    }
                  : {}),
              }
            : item,
        ),
      };
      if (task.title === APPLY_TITLE) {
        state.run = {
          ...state.run,
          integration: { status: "committed", headSha: "apply-sha", updatedAt: at },
        };
      } else if (task.title === "Fix verifier failure") {
        // A fix worker does substantive work (above), then re-runs the verifier
        // command itself and records the fresh result, just like the real worker.
        state.run = { ...state.run, lastSubstantiveWorkerAt: at };
        const status = config.verifier ? config.verifier(verifierCalls++) : "pass";
        const result: GoalVerificationResult = {
          status,
          summary: status === "pass" ? "ok" : "node: exit 1",
          command: VERIFIER_COMMAND,
          exitCode: status === "pass" ? 0 : 1,
          outputPath: "out.log",
          checkedAt: now(),
        };
        state.run = {
          ...state.run,
          verifier: {
            description: state.run.verifier?.description ?? "verifier",
            command: state.run.verifier?.command,
            lastResult: result,
          },
          ...(status === "pass"
            ? {
                completionAudit: {
                  status: "unknown" as const,
                  summary: "pending",
                  checkedAt: result.checkedAt,
                  verifierCheckedAt: result.checkedAt,
                  outputPath: result.outputPath,
                },
              }
            : {}),
          evidence: [
            ...state.run.evidence,
            {
              id: `verifier-${verifierCalls}`,
              kind: "command",
              label: `Verifier ${status}`,
              content: result.summary,
              createdAt: now(),
            },
          ],
        };
      } else if (task.title === AUDIT_TITLE) {
        const verifier = state.run.verifier?.lastResult;
        state.run = {
          ...state.run,
          completionAudit: {
            status: "pass",
            summary: "audited",
            checkedAt: at,
            ...(verifier?.checkedAt ? { verifierCheckedAt: verifier.checkedAt } : {}),
            outputPath: verifier?.outputPath ?? "out.log",
          },
        };
      } else {
        state.run = { ...state.run, lastSubstantiveWorkerAt: at };
      }
    },
    runVerifier: async (command): Promise<GoalVerificationResult> => {
      const status = config.verifier ? config.verifier(verifierCalls++) : "pass";
      return {
        status,
        summary: status === "pass" ? "ok" : "node: exit 1",
        command,
        exitCode: status === "pass" ? 0 : 1,
        outputPath: "out.log",
        checkedAt: now(),
      };
    },
    recordVerifierResult: async (result) => {
      state.run = {
        ...state.run,
        status: "ready",
        verifier: {
          description: state.run.verifier?.description ?? "verifier",
          command: state.run.verifier?.command,
          lastResult: result,
        },
        ...(result.status === "pass"
          ? {
              completionAudit: {
                status: "unknown" as const,
                summary: "pending",
                checkedAt: result.checkedAt,
                verifierCheckedAt: result.checkedAt,
                ...(result.outputPath ? { outputPath: result.outputPath } : {}),
              },
            }
          : {}),
        evidence: [
          ...state.run.evidence,
          {
            id: `verifier-${verifierCalls}`,
            kind: "command",
            label: `Verifier ${result.status}`,
            content: result.summary,
            createdAt: now(),
          },
        ],
      };
      return state.run;
    },
    stageIntegration: async () =>
      config.stage ?? {
        status: "staged",
        stagingBranch: "goal/integration",
        stagingPath: "/tmp/wt/integration",
        mainBase: "base-sha",
        integratedTaskIds: ["impl"],
        changedFiles: ["src/x.ts"],
      },
    finalizeIntegration: async () => ({ commitSha: "ff-sha" }),
    discardIntegration: async () => undefined,
    setIntegrationState: async (integration) => {
      state.run = { ...state.run, integration };
    },
    createTask: async (title, prompt) => {
      state.run = {
        ...state.run,
        tasks: [
          ...state.run.tasks,
          { id: `auto-${tick}`, title, prompt, status: "pending", attempts: 0 },
        ],
      };
    },
    appendEvidence: async (entry) => {
      state.run = {
        ...state.run,
        evidence: [
          ...state.run.evidence,
          {
            id: `ev-${tick}`,
            kind: entry.kind,
            label: entry.label,
            ...(entry.path ? { path: entry.path } : {}),
            ...(entry.content ? { content: entry.content } : {}),
            createdAt: now(),
          },
        ],
      };
    },
  };

  return {
    effects,
    get run() {
      return state.run;
    },
  } as Harness;
}

async function drive(
  initial: GoalRun,
  harness: Harness,
  options: GoalControllerOptions = {},
): Promise<GoalStepResult> {
  let current = initial;
  for (let i = 0; i < 40; i += 1) {
    const result = await stepGoalRun(current, harness.effects, options);
    current = result.run;
    if (result.outcome !== "continue") return result;
  }
  throw new Error("engine did not settle");
}

describe("goal engine", () => {
  it("drives the happy path: implement -> stage integrate -> verify -> audit -> complete", async () => {
    const run = baseRun({ tasks: [implTask()] });
    const harness = makeHarness(run);
    const result = await drive(run, harness);

    expect(result.outcome).toBe("complete");
    expect(harness.run.integration?.status).toBe("committed");
    expect(harness.run.verifier?.lastResult?.status).toBe("pass");
    expect(harness.run.completionAudit?.status).toBe("pass");
    expect(harness.run.tasks.find((task) => task.title === AUDIT_TITLE)?.status).toBe("done");
  });

  it("falls back to an LLM apply task when deterministic staging is not eligible", async () => {
    const run = baseRun({ tasks: [implTask()] });
    const harness = makeHarness(run, {
      stage: { status: "fallback", reason: "Main checkout has uncommitted changes." },
    });
    const result = await drive(run, harness);

    expect(result.outcome).toBe("complete");
    // The guarded apply task was created and run in the main checkout, and the
    // deterministic confirm stamped committed integration state.
    expect(harness.run.tasks.some((task) => task.title === APPLY_TITLE)).toBe(true);
    expect(harness.run.integration?.status).toBe("committed");
    expect(
      harness.run.evidence.some(
        (item) => item.label === "Goal decision: staged_integration_fallback",
      ),
    ).toBe(true);
  });

  it("creates a fix task on verifier failure then completes once it passes", async () => {
    // No worktree task, so no integration; just verify -> fail -> fix -> pass.
    const run = baseRun({
      tasks: [{ id: "impl", title: "Implement", prompt: "do", status: "done", attempts: 1 }],
    });
    const harness = makeHarness(run, { verifier: (call) => (call === 0 ? "fail" : "pass") });
    const result = await drive(run, harness, { verifierFixLimit: 3 });

    expect(result.outcome).toBe("complete");
    expect(harness.run.tasks.some((task) => task.title === "Fix verifier failure")).toBe(true);
    expect(harness.run.verifier?.lastResult?.status).toBe("pass");
  });

  it("re-strategizes then fails with a diagnosis on repeated identical verifier failure", async () => {
    const run = baseRun({
      tasks: [{ id: "impl", title: "Implement", prompt: "do", status: "done", attempts: 1 }],
    });
    const harness = makeHarness(run, { verifier: () => "fail" });
    const result = await drive(run, harness, { verifierFixLimit: 1, strategyLimit: 0 });

    expect(result.outcome).toBe("terminal");
    expect(harness.run.evidence.some((item) => item.label === "Goal failure diagnosis")).toBe(true);
  });
});
