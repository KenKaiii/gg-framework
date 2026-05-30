import { describe, expect, it } from "vitest";
import type { GoalRun } from "./goal-store.js";
import {
  buildGoalFailureDiagnosis,
  canCompleteGoalRun,
  decideGoalNextAction,
  formatGoalControllerDecision,
  hasFreshGoalCompletionAudit,
  hasRequiredGoalEvidence,
  shouldClearGoalContinuation,
} from "./goal-controller.js";

const durablePromptReference = {
  id: "original-goal-prompt",
  kind: "prompt" as const,
  label: "Original Goal prompt",
  content: "Original /goal prompt requiring durable references and.",
  source: "user",
};

const durablePlanEvidence = {
  id: "planner-plan",
  kind: "summary" as const,
  label: "Planner GOAL_PLAN",
  content:
    "GOAL_PLAN\nresearch=local\nfacts=goal-controller.ts\nsuccess=durable prompt and durable plan\nproof=contract test\nsetup=references verifier audit\nEND_GOAL_PLAN",
  createdAt: "2024-01-01T00:00:00.000Z",
};

function goalRun(overrides: Partial<GoalRun> = {}): GoalRun {
  return {
    id: "goal-a",
    title: "Programmatic loop",
    goal: "Make the loop deterministic",
    status: "ready",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    projectPath: "/tmp/project",
    successCriteria: ["Verifier passes"],
    prerequisites: [],
    harness: [],
    evidencePlan: [
      {
        id: "proof",
        label: "Proof",
        mechanism: "command",
        description: "Run verifier",
        status: "ready",
        evidence: "verified",
        command: "npm test",
      },
    ],
    verifier: {
      description: "Verifier",
      command: "npm test",
      lastResult: {
        status: "pass",
        summary: "passed",
        command: "npm test",
        outputPath: "out.log",
        checkedAt: "2024-01-01T00:00:02.000Z",
      },
    },
    references: [durablePromptReference],
    tasks: [],
    evidence: [durablePlanEvidence],
    blockers: [],
    ...overrides,
  };
}

function withPassingCompletionAudit(run: GoalRun): GoalRun {
  const verifier = run.verifier?.lastResult;
  if (!verifier) throw new Error("run must have verifier result");
  return {
    ...run,
    completionAudit: {
      status: "pass",
      summary: `FINAL_AUDIT_PASS verifier_checked_at=${verifier.checkedAt} output=${verifier.outputPath ?? "inline"} original-goal-prompt GOAL_PLAN`,
      checkedAt: "2024-01-01T00:00:03.000Z",
      verifierCheckedAt: verifier.checkedAt,
      ...(verifier.outputPath ? { outputPath: verifier.outputPath } : {}),
    },
  };
}

describe("goal controller", () => {
  it("blocks completion when mandatory non-prompt references are silently ignored", () => {
    const ignored = withPassingCompletionAudit(
      goalRun({
        references: [
          {
            id: "original-goal-prompt",
            kind: "prompt",
            label: "Original Goal prompt",
            content: "Fix feature based off X, Y, Z with supplied references.",
            source: "user",
          },
          {
            id: "repo-reference",
            kind: "repo",
            label: "Reference repository https://github.com/acme/product-reference",
            value: "https://github.com/acme/product-reference",
          },
          {
            id: "image-reference",
            kind: "image",
            label: "Attached image reference liked-ui.png",
            path: ".gg/goal-references/image-liked-ui.png",
          },
          {
            id: "text-reference",
            kind: "text",
            label: "Attached text reference feature-fix-x-y-z.md",
            path: ".gg/goal-references/text-feature-fix-x-y-z.md",
            content: "X: keyboard flow, Y: empty state copy, Z: error recovery.",
          },
        ],
      }),
    );

    expect(canCompleteGoalRun(ignored)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Goal references are not covered"),
    });
    expect(canCompleteGoalRun(ignored).reason).toContain("Reference repository");
    expect(canCompleteGoalRun(ignored).reason).toContain("Attached image reference");
    expect(canCompleteGoalRun(ignored).reason).toContain("Attached text reference");

    const covered = withPassingCompletionAudit(
      goalRun({
        successCriteria: [
          "Worker task prompts and setup criteria must mention repo-reference, image-reference, text-reference, and the X/Y/Z feature-fix document.",
        ],
        evidencePlan: [
          {
            id: "reference-proof",
            label: "repo-reference/image-reference/text-reference evidence plan paths",
            mechanism: "test",
            description:
              "Proves mandatory URL/repo, screenshot/image, attached text document, and X/Y/Z feature-fix references are carried into proof paths.",
            status: "ready",
            evidence: "reference-proof ready",
            path: ".goal-evidence/reference-proof.log",
          },
        ],
        verifier: {
          description:
            "Verifier covers repo-reference, image-reference, text-reference, and feature-fix-x-y-z.md.",
          command: "pnpm vitest goal-references.test.ts goal-controller.test.ts",
          lastResult: {
            status: "pass",
            summary: "passed repo-reference image-reference text-reference feature-fix-x-y-z.md",
            command: "pnpm vitest goal-references.test.ts goal-controller.test.ts",
            outputPath: ".goal-evidence/reference-proof.log",
            checkedAt: "2024-01-01T00:00:02.000Z",
          },
        },
        tasks: [
          {
            id: "worker-task",
            title: "Use mandatory references",
            prompt:
              "Implement using repo-reference, image-reference at .gg/goal-references/image-liked-ui.png, and text-reference at .gg/goal-references/text-feature-fix-x-y-z.md for X/Y/Z.",
            status: "done",
            attempts: 1,
          },
        ],
        references: ignored.references,
      }),
    );

    expect(canCompleteGoalRun(covered)).toEqual({
      ok: true,
      reason: "All tasks are done, verifier evidence passed, and final completion audit passed.",
    });
  });

  it("starts the next pending worker task deterministically", () => {
    const task = {
      id: "task-a",
      title: "Implement loop",
      prompt: "Do work",
      status: "pending" as const,
      attempts: 1,
    };

    expect(decideGoalNextAction(goalRun({ tasks: [task] }))).toEqual({
      kind: "start_worker",
      task,
      attempts: 2,
      reason: 'Goal task "Implement loop" is ready for worker attempt 2.',
    });
  });

  it("waits instead of starting duplicate work when a worker or task is active", () => {
    expect(decideGoalNextAction(goalRun({ activeWorkerId: "worker-a" }))).toEqual({
      kind: "wait",
      reason: "Goal already has an active worker.",
      workerId: "worker-a",
    });
    expect(
      decideGoalNextAction(
        goalRun({
          tasks: [
            {
              id: "task-a",
              title: "Running task",
              prompt: "Do work",
              status: "running",
              workerId: "worker-a",
              attempts: 1,
            },
          ],
        }),
      ),
    ).toMatchObject({ kind: "wait", workerId: "worker-a" });
  });

  it("waits for typed task dependencies before starting dependent DAG nodes", () => {
    const schemaTask = {
      id: "schema-task",
      title: "Change schema",
      prompt: "Update schema",
      status: "pending" as const,
      attempts: 0,
      parallelGroup: "model",
      expectedChangedScope: ["packages/ggcoder/src/core/**"],
      integration: "candidate" as const,
    };
    const uiTask = {
      id: "ui-task",
      title: "Change UI",
      prompt: "Update UI after schema",
      status: "pending" as const,
      attempts: 0,
      dependsOn: ["schema-task"],
      parallelGroup: "frontend",
      expectedChangedScope: ["packages/ggcoder/src/ui/**"],
      integration: "candidate" as const,
    };

    const missingDepDecision = decideGoalNextAction(goalRun({ tasks: [uiTask] }));
    expect(missingDepDecision).toMatchObject({ kind: "terminal", status: "failed" });
    expect(missingDepDecision.reason).toContain(
      "depends on missing task(s) that cannot be synthesized: schema-task",
    );
    expect(decideGoalNextAction(goalRun({ tasks: [uiTask, schemaTask] }))).toEqual({
      kind: "start_worker",
      task: schemaTask,
      attempts: 1,
      reason: 'Goal task "Change schema" is ready for worker attempt 1.',
    });
    expect(
      decideGoalNextAction(goalRun({ tasks: [{ ...schemaTask, status: "done" }, uiTask] })),
    ).toEqual({
      kind: "start_worker",
      task: uiTask,
      attempts: 1,
      reason: 'Goal task "Change UI" is ready for worker attempt 1.',
    });
  });

  it("reproduces blocked-after-pass shape by completing from durable evidence despite stale blocked status and planned items", () => {
    const run = goalRun({
      status: "blocked",
      blockers: ["Verifier was interrupted"],
      tasks: [{ id: "task-a", title: "Done", prompt: "Done", status: "done", attempts: 1 }],
      evidencePlan: [
        {
          id: "targeted-tests",
          label: "Targeted regression tests",
          mechanism: "test",
          description: "Run the focused local regression command.",
          status: "planned",
          command: "pnpm vitest run src/core/goal-controller.test.ts",
        },
        {
          id: "verifier-log",
          label: "Verifier log artifact",
          mechanism: "log",
          description: "Persist the verifier output log.",
          status: "planned",
          path: ".goal-evidence/blocked-after-pass.log",
        },
      ],
      evidence: [
        {
          id: "evidence-targeted-tests",
          createdAt: "2024-01-01T00:00:00.000Z",
          kind: "command",
          label: "Targeted regression tests",
          content: "pnpm vitest run src/core/goal-controller.test.ts passed",
        },
        {
          id: "evidence-verifier-log",
          createdAt: "2024-01-01T00:00:01.000Z",
          kind: "log",
          label: "Verifier log artifact",
          path: ".goal-evidence/blocked-after-pass.log",
          content: "Verifier passed after interruption.",
        },
      ],
      verifier: {
        description: "Full check",
        command: "pnpm vitest run src/core/goal-controller.test.ts",
        lastResult: {
          status: "pass",
          summary: "Verifier passed after earlier interruption.",
          command: "pnpm vitest run src/core/goal-controller.test.ts",
          outputPath: ".goal-evidence/blocked-after-pass.log",
          checkedAt: "2024-01-01T00:00:02.000Z",
        },
      },
    });

    expect(canCompleteGoalRun(run)).toEqual({
      ok: false,
      reason: "Goal has no final completion audit.",
    });
    expect(decideGoalNextAction(run)).toMatchObject({
      kind: "create_task",
      title: "Audit Goal completion evidence",
      reason:
        "Verifier passed; creating final read-only completion audit before the Goal can pass (1/3).",
    });
    const audited = withPassingCompletionAudit(run);
    expect(canCompleteGoalRun(audited)).toEqual({
      ok: true,
      reason: "All tasks are done, verifier evidence passed, and final completion audit passed.",
    });
    expect(decideGoalNextAction(audited)).toEqual({
      kind: "complete",
      reason: "All tasks are done, verifier evidence passed, and final completion audit passed.",
    });
  });

  it("treats closure evidence and ready evidence-plan items as satisfied after verifier pass", () => {
    const run = goalRun({
      evidencePlan: [
        {
          id: "ready-proof",
          label: "Ready proof",
          mechanism: "test",
          description: "Ready proof was produced by the harness.",
          status: "ready",
          evidence: "Regression harness artifact was recorded.",
        },
        {
          id: "closure-proof",
          label: "Closure proof",
          mechanism: "browser",
          description: "Browser closure evidence proves the flow works.",
          status: "planned",
          evidence: "Browser closure evidence proves the flow works.",
        },
        {
          id: "verifier-output-proof",
          label: "Verifier output proof",
          mechanism: "screenshot",
          description: "Capture final verifier artifact.",
          status: "planned",
          path: "artifacts/final-verifier.log",
        },
      ],
      evidence: [
        {
          id: "evidence-closure-proof",
          createdAt: "2024-01-01T00:00:00.000Z",
          kind: "summary",
          label: "Closure proof",
          content: "Closure evidence recorded after the worker finished.",
        },
      ],
      verifier: {
        description: "Full check",
        command: "pnpm test",
        lastResult: {
          status: "pass",
          summary: "Verifier passed and wrote final artifact.",
          command: "pnpm test",
          outputPath: "artifacts/final-verifier.log",
          checkedAt: "2024-01-01T00:00:00.000Z",
        },
      },
    });
    expect(canCompleteGoalRun(run)).toEqual({
      ok: false,
      reason: "Goal has no final completion audit.",
    });
    expect(decideGoalNextAction(run)).toMatchObject({
      kind: "create_task",
      title: "Audit Goal completion evidence",
      reason:
        "Verifier passed; creating final read-only completion audit before the Goal can pass (1/3).",
    });
    const audited = withPassingCompletionAudit(run);
    expect(canCompleteGoalRun(audited)).toEqual({
      ok: true,
      reason: "All tasks are done, verifier evidence passed, and final completion audit passed.",
    });
    expect(decideGoalNextAction(audited)).toEqual({
      kind: "complete",
      reason: "All tasks are done, verifier evidence passed, and final completion audit passed.",
    });
  });

  it("uses final audit to reconcile planned evidence after verifier success", () => {
    const decision = decideGoalNextAction(
      goalRun({
        tasks: [{ id: "task-a", title: "Done", prompt: "Done", status: "done", attempts: 1 }],
        evidencePlan: [
          {
            id: "proof",
            label: "Unmatched proof",
            mechanism: "browser",
            description: "Needs screenshot",
            status: "planned",
          },
        ],
        verifier: {
          description: "Full check",
          command: "pnpm test",
          lastResult: {
            status: "pass",
            summary: "tests passed",
            command: "pnpm test",
            checkedAt: "2024-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    expect(decision).toMatchObject({
      kind: "create_task",
      title: "Audit Goal completion evidence",
      reason:
        "Verifier passed; final read-only audit must reconcile 1 evidence-plan item(s) before the Goal can pass (1/3).",
    });
    expect(decision.kind === "create_task" ? decision.prompt : "").toContain(
      "final pre-audit gate",
    );
    expect(decision.kind === "create_task" ? decision.prompt : "").toContain(
      "update that evidence_plan item to status=ready",
    );
  });

  it("explains ready evidence-plan items that have no durable proof anchor", () => {
    const run = goalRun({
      evidencePlan: [
        {
          id: "plan",
          label: "GOAL_PLAN setup evidence",
          mechanism: "log",
          description: "The exact planner output must be durable.",
          status: "ready",
        },
      ],
    });

    expect(hasRequiredGoalEvidence(run)).toEqual({
      ok: false,
      reason:
        "Goal evidence plan is not satisfied: GOAL_PLAN setup evidence (ready but no durable evidence, path, or command recorded).",
    });
  });

  it("rejects evidence-plan false positives before final audit", () => {
    const run = goalRun({
      tasks: [{ id: "task-a", title: "Done", prompt: "Done", status: "done", attempts: 1 }],
      evidencePlan: [
        {
          id: "proof",
          label: "Screenshot proof",
          mechanism: "screenshot",
          description: "Needs a real screenshot artifact.",
          status: "planned",
          path: "artifacts/screenshot.png",
        },
      ],
      evidence: [
        {
          id: "narrative-only",
          kind: "summary",
          label: "Screenshot proof",
          content: "I looked at the screen and it seemed fine.",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      verifier: {
        description: "Full check",
        command: "pnpm test",
        lastResult: {
          status: "pass",
          summary: "tests passed without screenshot path",
          command: "pnpm test",
          checkedAt: "2024-01-01T00:00:01.000Z",
        },
      },
    });

    expect(hasRequiredGoalEvidence(run)).toEqual({
      ok: false,
      reason:
        "Goal evidence plan is not satisfied: Screenshot proof (missing durable evidence for path artifacts/screenshot.png).",
    });
    expect(decideGoalNextAction(run)).toMatchObject({
      kind: "create_task",
      title: "Audit Goal completion evidence",
    });
  });

  it("does not create zero-item evidence reconciliation before final audit", () => {
    const run = goalRun({
      tasks: [{ id: "task-a", title: "Done", prompt: "Done", status: "done", attempts: 1 }],
      evidencePlan: [
        {
          id: "proof",
          label: "Matched proof",
          mechanism: "test",
          description: "Matched by verifier output.",
          status: "planned",
          command: "pnpm test",
        },
      ],
      verifier: {
        description: "Full check",
        command: "pnpm test",
        lastResult: {
          status: "pass",
          summary: "Matched proof passed.",
          command: "pnpm test",
          checkedAt: "2024-01-01T00:00:00.000Z",
        },
      },
    });

    expect(decideGoalNextAction(run)).toMatchObject({
      kind: "create_task",
      title: "Audit Goal completion evidence",
    });
  });

  it("uses final audit for real blocked-after-pass evidence-plan labels", () => {
    const decision = decideGoalNextAction(
      goalRun({
        tasks: [{ id: "task-a", title: "Done", prompt: "Done", status: "done", attempts: 1 }],
        evidencePlan: [
          {
            id: "slash-wrapper-evidence",
            label: "/goal slash wrapper evidence",
            mechanism: "test",
            description:
              "Assertions prove /goal prompt is short and delegates deep policy to active Goal setup system instructions.",
            status: "planned",
            command:
              "pnpm --filter @kenkaiiii/ggcoder test -- prompt-commands.test.ts slash-command-images.test.ts",
          },
          {
            id: "context-wiring-evidence",
            label: "Context wiring source audit",
            mechanism: "source",
            description:
              "Inspect App/render/cli/tools wiring to document exactly which context is shared through refs/session state and which context is isolated to workers.",
            status: "planned",
            path: "packages/ggcoder/src/ui/App.tsx; packages/ggcoder/src/ui/render.ts; packages/ggcoder/src/cli.ts; packages/ggcoder/src/tools/index.ts",
          },
        ],
        evidence: [
          {
            id: "focused-tests",
            kind: "command",
            label: "Focused Goal-mode test coverage command",
            content:
              "Command passed: pnpm --filter @kenkaiiii/ggcoder test -- system-prompt.test.ts prompt-commands.test.ts goal-mode.test.ts slash-command-images.test.ts footer-status-layout.test.ts goal-lifecycle-orchestration.test.ts",
            createdAt: "2024-01-01T00:00:00.000Z",
          },
          {
            id: "audit",
            kind: "summary",
            label: "Goal-mode architecture audit",
            content:
              "Inspected runtime-mode.ts, system-prompt.ts, prompt-commands.ts, cli.ts, ui/render.ts, ui/App.tsx, and tools/index.ts.",
            createdAt: "2024-01-01T00:00:01.000Z",
          },
        ],
        verifier: {
          description: "Full check",
          command: "pnpm check && pnpm lint && pnpm format:check && pnpm build",
          lastResult: {
            status: "pass",
            summary: "Focused tests, Goal E2E harness, and quality gates passed.",
            command: "pnpm check && pnpm lint && pnpm format:check && pnpm build",
            checkedAt: "2024-01-01T00:00:02.000Z",
          },
        },
      }),
    );
    expect(decision).toMatchObject({
      kind: "create_task",
      title: "Audit Goal completion evidence",
    });
    expect(decision.kind === "create_task" ? decision.prompt : "").toContain(
      "slash-wrapper-evidence / /goal slash wrapper evidence",
    );
    expect(decision.kind === "create_task" ? decision.prompt : "").toContain(
      "context-wiring-evidence / Context wiring source audit",
    );
  });

  it("blocks after bounded final audit attempts fail to reconcile evidence", () => {
    const auditTask = {
      id: "audit-a",
      title: "Audit Goal completion evidence",
      prompt: "Audit evidence",
      status: "done" as const,
      attempts: 1,
    };
    const decision = decideGoalNextAction(
      goalRun({
        tasks: [auditTask, { ...auditTask, id: "audit-b" }, { ...auditTask, id: "audit-c" }],
        evidencePlan: [
          {
            id: "proof",
            label: "Unmatched proof",
            mechanism: "browser",
            description: "Needs screenshot",
            status: "planned",
          },
        ],
        verifier: {
          description: "Full check",
          command: "pnpm test",
          lastResult: {
            status: "pass",
            summary: "tests passed",
            command: "pnpm test",
            checkedAt: "2024-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    expect(decision).toMatchObject({ kind: "terminal", status: "failed" });
    expect(decision.reason).toContain(
      "Verifier passed, but the final completion audit could not reconcile the Goal evidence plan after bounded attempts.",
    );
  });

  it("creates a main-checkout apply task before verifier when integration worktree changes exist", () => {
    expect(
      decideGoalNextAction(
        goalRun({
          tasks: [
            {
              id: "integrate",
              title: "Integrate candidates and verify",
              prompt: "Integrate accepted candidates",
              status: "done",
              attempts: 1,
              integration: "candidate",
              worktree: {
                baseRef: "base-sha",
                branchName: "goal/a/integrate-worker",
                path: "/tmp/worktrees/integrate-worker",
                status: "created",
              },
              candidate: {
                baseRef: "base-sha",
                headSha: "head-sha",
                branchName: "goal/a/integrate-worker",
                changedFiles: ["src/x.ts"],
                committed: true,
              },
              lastSummary: "Integrated accepted candidate patches and wrote integration.patch.",
            },
          ],
          verifier: { description: "Full check", command: "pnpm test" },
        }),
      ),
    ).toMatchObject({
      kind: "create_task",
      title: "Apply integrated worktree to main",
      reason:
        "Accepted integration worktree changes must be applied to the user's main checkout before verifier, final audit, release, commit, or completion.",
    });
  });

  it("runs verifier after main integration, then completes when typed integration is committed", () => {
    const integratedTask = {
      id: "integrate",
      title: "Integrate candidates and verify",
      prompt: "Integrate accepted candidates",
      status: "done" as const,
      attempts: 1,
      integration: "candidate" as const,
      worktree: {
        baseRef: "base-sha",
        branchName: "goal/a/integrate-worker",
        path: "/tmp/worktrees/integrate-worker",
        status: "created" as const,
      },
      candidate: {
        baseRef: "base-sha",
        headSha: "head-sha",
        branchName: "goal/a/integrate-worker",
        changedFiles: ["src/x.ts"],
        committed: true,
      },
    };
    const appliedEvidence = {
      id: "applied",
      kind: "summary" as const,
      label: "Integrated worktree applied to main",
      content: "Accepted integration diff applied to main and checks passed.",
      createdAt: "2024-01-01T00:00:01.000Z",
    };

    expect(
      decideGoalNextAction(
        goalRun({
          tasks: [
            integratedTask,
            {
              id: "apply",
              title: "Apply integrated worktree to main",
              prompt: "Apply accepted changes",
              status: "done",
              attempts: 1,
            },
          ],
          verifier: { description: "Full check", command: "pnpm test" },
          evidence: [durablePlanEvidence, appliedEvidence],
        }),
      ),
    ).toEqual({
      kind: "run_verifier",
      command: "pnpm test",
      reason: "All Goal tasks are done; running configured verifier for real completion evidence.",
    });

    const committed = withPassingCompletionAudit(
      goalRun({
        tasks: [
          integratedTask,
          {
            id: "apply",
            title: "Apply integrated worktree to main",
            prompt: "Apply accepted changes",
            status: "done",
            attempts: 1,
          },
        ],
        evidence: [durablePlanEvidence, appliedEvidence],
        integration: {
          status: "committed",
          headSha: "abc1234",
          updatedAt: "2024-01-01T00:00:03.000Z",
        },
        verifier: {
          description: "Full check",
          command: "pnpm test",
          lastResult: {
            status: "pass",
            summary: "main checkout verifier passed",
            command: "pnpm test",
            outputPath: ".goal-evidence/verifier.log",
            checkedAt: "2024-01-01T00:00:02.000Z",
          },
        },
      }),
    );

    expect(decideGoalNextAction(committed)).toEqual({
      kind: "complete",
      reason: "All tasks are done, verifier evidence passed, and final completion audit passed.",
    });
  });

  it("creates a verifier-building task when done tasks have no verifier command", () => {
    expect(
      decideGoalNextAction(
        goalRun({
          verifier: undefined,
          tasks: [{ id: "task-a", title: "Done", prompt: "Done", status: "done", attempts: 1 }],
        }),
      ),
    ).toMatchObject({
      kind: "create_task",
      title: "Define Goal verifier",
      reason: "No pending Goal task or verifier command is configured.",
    });
  });

  it("creates a mobile/UI evidence-path task before verifier execution when proof is only planned", () => {
    const decision = decideGoalNextAction(
      goalRun({
        goal: "Make the mobile checkout screen render correctly on small viewports",
        tasks: [{ id: "task-a", title: "Done", prompt: "Done", status: "done", attempts: 1 }],
        evidencePlan: [
          {
            id: "mobile-ui-proof",
            label: "iOS simulator screenshot comparison",
            mechanism: "screenshot",
            description:
              "Capture the mobile checkout screen in a local simulator or browser viewport and compare the image/frame output.",
            status: "planned",
            path: "artifacts/mobile-checkout-diff.png",
          },
        ],
        verifier: { description: "Full check", command: "pnpm test:e2e" },
      }),
    );

    expect(decision).toMatchObject({
      kind: "create_task",
      title: "Build Goal evidence path",
      reason:
        "Goal evidence plan requires local instrumentation or exact prerequisite handling before verification.",
    });
    const prompt = decision.kind === "create_task" ? decision.prompt : "";
    expect(prompt).toContain("iOS simulator screenshot comparison (screenshot)");
    expect(prompt).toContain("goal-specific sensory intent");
    expect(prompt).toContain("what experience is being observed");
    expect(prompt).toContain("what failure it catches");
    expect(prompt).toContain("what signal proves it");
    expect(prompt).toContain("Build only the proportional instrument needed");
    expect(prompt).toContain(
      "If the verifier artifact exists only in your isolated worker worktree",
    );
    expect(prompt).toContain("set verifier_cwd to that worktree path");
    expect(prompt).toContain("copy/integrate the verifier artifact into the main checkout");
    expect(prompt).toContain("not use narrative-only verification or human visual inspection");
  });

  it("blocks when an evidence plan item requires a true external prerequisite", () => {
    expect(
      decideGoalNextAction(
        goalRun({
          tasks: [{ id: "task-a", title: "Done", prompt: "Done", status: "done", attempts: 1 }],
          evidencePlan: [
            {
              id: "device-proof",
              label: "Physical iPhone capture",
              mechanism: "device",
              description: "Run on a real phone.",
              status: "blocked",
              instructions: "Connect an unlocked iPhone with Developer Mode enabled.",
            },
          ],
          verifier: { description: "Full check", command: "pnpm test:e2e" },
        }),
      ),
    ).toEqual({
      kind: "blocked",
      reason: "Physical iPhone capture: Connect an unlocked iPhone with Developer Mode enabled.",
    });
  });

  it("creates a harness-building task before verifier execution when instrumentation is missing", () => {
    const decision = decideGoalNextAction(
      goalRun({
        tasks: [{ id: "task-a", title: "Done", prompt: "Done", status: "done", attempts: 1 }],
        harness: [{ id: "harness-a", label: "Browser fixture", description: "Create fixture" }],
        verifier: { description: "Full check", command: "pnpm test:e2e" },
      }),
    );

    expect(decision).toMatchObject({
      kind: "create_task",
      title: "Build Goal verification harness",
      reason: "Goal harness requires local instrumentation before verification.",
    });
    const prompt = decision.kind === "create_task" ? decision.prompt : "";
    expect(prompt).toContain("Build only the missing local/free harness instrumentation");
    expect(prompt).toContain("intended experience");
    expect(prompt).toContain("relevant failure modes");
    expect(prompt).toContain("senses/signals this harness must observe");
    expect(prompt).toContain("do not default to generic tests");
  });

  it("blocks missing prerequisites with exact user instructions", () => {
    expect(
      decideGoalNextAction(
        goalRun({
          prerequisites: [
            {
              id: "api-key",
              label: "Demo API key",
              status: "missing",
              instructions: "Provide DEMO_API_KEY in the local environment.",
            },
          ],
        }),
      ),
    ).toEqual({
      kind: "blocked",
      reason: "Demo API key: Provide DEMO_API_KEY in the local environment.",
    });
  });

  it("creates a bounded fix task for verifier failure when resumed", () => {
    const run = goalRun({
      tasks: [{ id: "task-a", title: "Done", prompt: "Done", status: "done", attempts: 1 }],
      verifier: {
        description: "Full check",
        command: "pnpm test",
        lastResult: {
          status: "fail",
          summary: "tests failed",
          checkedAt: "2024-01-01T00:00:00.000Z",
          exitCode: 1,
          outputPath: ".gg/log.log",
        },
      },
      evidence: [
        {
          id: "evidence-a",
          kind: "command",
          label: "Verifier fail",
          content: "tests failed",
          path: ".gg/log.log",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    const decision = decideGoalNextAction(run);
    expect(decision).toMatchObject({
      kind: "create_task",
      title: "Fix verifier failure",
      reason: "Verifier failed; creating bounded fix task 1/5.",
    });
    expect(decision.kind === "create_task" ? decision.prompt : "").toContain(
      "Output path: .gg/log.log",
    );
  });

  it("blocks repeated identical verifier failures instead of looping forever", () => {
    const run = goalRun({
      tasks: [{ id: "task-a", title: "Done", prompt: "Done", status: "done", attempts: 1 }],
      verifier: {
        description: "Full check",
        command: "pnpm test",
        lastResult: {
          status: "fail",
          summary: "same",
          checkedAt: "2024-01-01T00:00:00.000Z",
          exitCode: 1,
        },
      },
      evidence: [
        {
          id: "e1",
          kind: "command",
          label: "Verifier fail",
          content: "same",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "e2",
          kind: "command",
          label: "Verifier fail",
          content: "same",
          createdAt: "2024-01-01T00:00:01.000Z",
        },
      ],
    });
    expect(decideGoalNextAction(run)).toMatchObject({
      kind: "create_task",
      title: "Re-strategize Goal approach",
      reason:
        "Verifier produced the same failure repeatedly; re-strategizing with a fundamentally different approach. (1/2)",
    });
  });

  it("treats failed status as terminal unless a later tool action revives it to ready", () => {
    const run = goalRun({
      status: "failed",
      tasks: [{ id: "task-a", title: "Done", prompt: "Done", status: "done", attempts: 1 }],
      verifier: {
        description: "Full check",
        command: "pnpm test",
        lastResult: {
          status: "fail",
          summary: "tests failed",
          checkedAt: "2024-01-01T00:00:00.000Z",
          exitCode: 1,
        },
      },
      evidence: [
        {
          id: "evidence-a",
          kind: "command",
          label: "Verifier result",
          content: "tests failed",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(canCompleteGoalRun(run)).toEqual({ ok: false, reason: "Verifier status is fail." });
    expect(decideGoalNextAction(run)).toEqual({
      kind: "terminal",
      status: "failed",
      reason: "Goal is failed.",
    });
  });

  it("rejects spoofed final audit pass summaries", () => {
    const run = goalRun({
      tasks: [{ id: "task-a", title: "Done", prompt: "Done", status: "done", attempts: 1 }],
      verifier: {
        description: "Full check",
        command: "pnpm test",
        lastResult: {
          status: "pass",
          summary: "passed original-goal-prompt GOAL_PLAN",
          checkedAt: "2024-01-01T00:00:02.000Z",
          outputPath: "artifacts/verifier.log",
        },
      },
      completionAudit: {
        status: "pass",
        summary:
          "FINAL_AUDIT_PASS verifier_checked_at=2024-01-01T00:00:01.000Z artifact=artifacts/verifier.log original-goal-prompt GOAL_PLAN",
        checkedAt: "2024-01-01T00:00:03.000Z",
        verifierCheckedAt: "2024-01-01T00:00:01.000Z",
        outputPath: "artifacts/verifier.log",
      },
    });

    expect(hasFreshGoalCompletionAudit(run)).toEqual({
      ok: false,
      reason: "Final completion audit does not match the latest verifier result.",
    });
    expect(canCompleteGoalRun(run)).toEqual({
      ok: false,
      reason: "Final completion audit does not match the latest verifier result.",
    });
  });

  it("completes only with all tasks done and pass verifier evidence", () => {
    const run = goalRun({
      tasks: [{ id: "task-a", title: "Done", prompt: "Done", status: "done", attempts: 1 }],
      verifier: {
        description: "Full check",
        command: "pnpm test",
        lastResult: {
          status: "pass",
          summary: "passed original-goal-prompt GOAL_PLAN",
          checkedAt: "2024-01-01T00:00:00.000Z",
          outputPath: "out.log",
        },
      },
    });

    expect(canCompleteGoalRun(run)).toEqual({
      ok: false,
      reason: "Goal has no final completion audit.",
    });
    expect(decideGoalNextAction(run)).toMatchObject({
      kind: "create_task",
      title: "Audit Goal completion evidence",
      reason:
        "Verifier passed; creating final read-only completion audit before the Goal can pass (1/3).",
    });
    const audited = withPassingCompletionAudit(run);
    expect(canCompleteGoalRun(audited)).toEqual({
      ok: true,
      reason: "All tasks are done, verifier evidence passed, and final completion audit passed.",
    });
    expect(decideGoalNextAction(audited)).toEqual({
      kind: "complete",
      reason: "All tasks are done, verifier evidence passed, and final completion audit passed.",
    });
  });

  it("reruns the verifier when a substantive worker completed after the latest verifier pass", () => {
    const run = goalRun({
      tasks: [{ id: "task-a", title: "Done", prompt: "Done", status: "done", attempts: 1 }],
      lastSubstantiveWorkerAt: "2024-01-01T00:00:02.000Z",
      verifier: {
        description: "Full check",
        command: "pnpm test",
        lastResult: {
          status: "pass",
          summary: "passed original-goal-prompt GOAL_PLAN",
          command: "pnpm test",
          checkedAt: "2024-01-01T00:00:00.000Z",
          outputPath: "out.log",
        },
      },
      completionAudit: {
        status: "pass",
        summary:
          "FINAL_AUDIT_PASS verifier_checked_at=2024-01-01T00:00:00.000Z original-goal-prompt GOAL_PLAN",
        checkedAt: "2024-01-01T00:00:03.000Z",
        verifierCheckedAt: "2024-01-01T00:00:00.000Z",
        outputPath: "out.log",
      },
    });

    expect(hasFreshGoalCompletionAudit(run)).toEqual({
      ok: false,
      reason: "Latest verifier result is stale after a later substantive Goal worker completion.",
    });
    expect(decideGoalNextAction(run)).toEqual({
      kind: "run_verifier",
      command: "pnpm test",
      reason:
        "Latest verifier result is stale after later Goal worker evidence; rerunning configured verifier as the final pre-audit gate.",
    });
  });

  it("does not complete when verifier passed but tasks remain", () => {
    const run = goalRun({
      tasks: [
        { id: "done", title: "Done", prompt: "Done", status: "done", attempts: 1 },
        { id: "pending", title: "Pending", prompt: "Pending", status: "pending", attempts: 0 },
      ],
      verifier: {
        description: "Full check",
        command: "pnpm test",
        lastResult: {
          status: "pass",
          summary: "passed original-goal-prompt GOAL_PLAN",
          checkedAt: "2024-01-01T00:00:00.000Z",
        },
      },
    });

    expect(canCompleteGoalRun(run)).toEqual({ ok: false, reason: "1 Goal task is not done." });
    expect(decideGoalNextAction(run)).toMatchObject({ kind: "start_worker" });
  });

  it("retries a failed task below the attempt limit for corrective work", () => {
    const task = {
      id: "task-a",
      title: "Repair verifier failure",
      prompt: "Fix the verifier failure using persisted evidence",
      status: "failed" as const,
      attempts: 1,
      lastSummary: "Verifier failed: assertion mismatch",
    };

    expect(decideGoalNextAction(goalRun({ tasks: [task] }))).toEqual({
      kind: "start_worker",
      task,
      attempts: 2,
      reason: 'Goal task "Repair verifier failure" is ready for worker attempt 2.',
    });
  });

  it("formats durable-readable controller decisions", () => {
    const decision = decideGoalNextAction(goalRun({ tasks: [] }));
    const formatted = formatGoalControllerDecision(decision);
    expect(formatted.label).toBe(`Goal decision: ${decision.kind}`);
    expect(formatted.content).toContain(`kind=${decision.kind}`);
    expect(shouldClearGoalContinuation({ kind: "wait", reason: "active" })).toBe(false);
    expect(shouldClearGoalContinuation(decision)).toBe(true);
  });

  it("re-strategizes on no-progress repeats, then fails with a diagnosis past the strategy limit", () => {
    const task = {
      id: "task-a",
      title: "Flaky repair",
      prompt: "Do work",
      status: "failed" as const,
      attempts: 5,
      workerId: "worker-a",
    };
    const repeatedEvidence = [
      {
        id: "e1",
        kind: "log" as const,
        label: "Worker worker-a failed",
        content: "same crash",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        kind: "log" as const,
        label: "Worker worker-a failed",
        content: "same crash",
        createdAt: "2024-01-01T00:00:01.000Z",
      },
    ];

    // No-progress repeat below the strategy limit -> create a re-strategy task.
    const reStrategy = decideGoalNextAction(goalRun({ tasks: [task], evidence: repeatedEvidence }));
    expect(reStrategy).toMatchObject({
      kind: "create_task",
      title: "Re-strategize Goal approach",
    });

    // Past the bounded strategy limit (with done re-strategy tasks) -> terminal failed.
    const exhausted = decideGoalNextAction(
      goalRun({
        tasks: [
          task,
          {
            id: "s1",
            title: "Re-strategize Goal approach",
            prompt: "x",
            status: "done",
            attempts: 1,
          },
          {
            id: "s2",
            title: "Re-strategize Goal approach",
            prompt: "x",
            status: "done",
            attempts: 1,
          },
        ],
        evidence: repeatedEvidence,
      }),
    );
    expect(exhausted).toMatchObject({ kind: "terminal", status: "failed" });
    expect(exhausted.reason).toContain("GOAL_FAILURE_DIAGNOSIS");
    expect(exhausted.reason).toContain("Flaky repair");
  });

  it("keeps retrying past the soft attempt limit while still making progress", () => {
    const task = {
      id: "task-a",
      title: "Improving repair",
      prompt: "Do work",
      status: "failed" as const,
      attempts: 5,
      workerId: "worker-a",
    };
    const progressingEvidence = [
      {
        id: "e1",
        kind: "log" as const,
        label: "Worker worker-a failed",
        content: "error A",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        kind: "log" as const,
        label: "Worker worker-a failed",
        content: "error B (different)",
        createdAt: "2024-01-01T00:00:01.000Z",
      },
    ];

    expect(
      decideGoalNextAction(goalRun({ tasks: [task], evidence: progressingEvidence })),
    ).toMatchObject({ kind: "start_worker", attempts: 6 });
  });

  it("does not create duplicate auto evidence or harness tasks", () => {
    const evidenceTask = {
      id: "evidence-task",
      title: "Build Goal evidence path",
      prompt: "Build proof",
      status: "done" as const,
      attempts: 1,
    };
    expect(
      decideGoalNextAction(
        goalRun({
          tasks: [evidenceTask],
          evidencePlan: [
            {
              id: "missing-proof",
              label: "Missing proof",
              mechanism: "command",
              description: "Needs a command artifact.",
              status: "planned",
              command: "pnpm missing-proof",
            },
          ],
          verifier: { description: "Verifier", command: "pnpm verify" },
        }),
      ),
    ).toEqual({
      kind: "blocked",
      reason:
        'Goal auto-task "Build Goal evidence path" already exists with status done; not creating a duplicate. Reconcile its evidence or update the existing task before continuing. Goal evidence plan still requires local instrumentation or exact prerequisite handling before verification.',
    });

    const harnessTask = {
      id: "harness-task",
      title: "Build Goal verification harness",
      prompt: "Build harness",
      status: "blocked" as const,
      attempts: 1,
    };
    expect(
      decideGoalNextAction(
        goalRun({
          tasks: [harnessTask],
          harness: [{ id: "harness", label: "Harness", description: "Needs instrumentation" }],
          verifier: { description: "Verifier" },
        }),
      ),
    ).toEqual({
      kind: "blocked",
      reason:
        'Goal auto-task "Build Goal verification harness" already exists with status blocked; not creating a duplicate. Reconcile its evidence or update the existing task before continuing. Goal harness still requires local instrumentation before verification.',
    });
  });

  it("reuses existing pending auto tasks instead of creating duplicates", () => {
    const verifierTask = {
      id: "verifier-task",
      title: "Define Goal verifier",
      prompt: "Define verifier",
      status: "pending" as const,
      attempts: 1,
    };

    expect(
      decideGoalNextAction(
        goalRun({ tasks: [verifierTask], verifier: { description: "Verifier" } }),
      ),
    ).toEqual({
      kind: "start_worker",
      task: verifierTask,
      attempts: 2,
      reason: 'Goal task "Define Goal verifier" is ready for worker attempt 2.',
    });
  });

  it("blocks rather than creating another verifier-fix task when one is already blocked", () => {
    const run = goalRun({
      tasks: [
        { id: "task-a", title: "Done", prompt: "Done", status: "done", attempts: 1 },
        {
          id: "fix-a",
          title: "Fix verifier failure",
          prompt: "Fix it",
          status: "blocked",
          attempts: 1,
        },
      ],
      verifier: {
        description: "Full check",
        command: "pnpm test",
        lastResult: {
          status: "fail",
          summary: "tests failed",
          checkedAt: "2024-01-01T00:00:00.000Z",
          exitCode: 1,
        },
      },
    });

    expect(decideGoalNextAction(run)).toMatchObject({
      kind: "create_task",
      title: "Re-strategize Goal approach",
      reason:
        "A blocked verifier-fix task exists; re-strategizing the verifier fix with a different approach. (1/2)",
    });
  });

  it("builds a structured failure diagnosis brief", () => {
    const diagnosis = buildGoalFailureDiagnosis(
      goalRun({
        goal: "Ship the widget",
        tasks: [
          { id: "task-a", title: "Build widget", prompt: "x", status: "failed", attempts: 6 },
        ],
        prerequisites: [
          {
            id: "key",
            label: "Vendor API key",
            status: "missing",
            kind: "external",
            instructions: "Provide VENDOR_KEY.",
          },
        ],
        verifier: {
          description: "check",
          command: "pnpm test",
          lastResult: {
            status: "fail",
            summary: "2 failing tests",
            checkedAt: "2024-01-01T00:00:00.000Z",
            exitCode: 1,
          },
        },
        evidence: [
          {
            id: "e1",
            kind: "command",
            label: "Verifier fail",
            content: "2 failing tests",
            createdAt: "2024-01-01T00:00:00.000Z",
          },
        ],
      }),
      "Bounded re-strategy exhausted.",
    );
    expect(diagnosis).toContain("GOAL_FAILURE_DIAGNOSIS");
    expect(diagnosis).toContain("objective=Ship the widget");
    expect(diagnosis).toContain("reason=Bounded re-strategy exhausted.");
    expect(diagnosis).toContain("Build widget (task-a): status=failed; attempts=6");
    expect(diagnosis).toContain("2 failing tests");
    expect(diagnosis).toContain("Vendor API key: Provide VENDOR_KEY.");
  });

  it("resolves unmet local prerequisites with a worker task instead of blocking", () => {
    const decision = decideGoalNextAction(
      goalRun({
        prerequisites: [
          {
            id: "node",
            label: "Node toolchain",
            status: "missing",
            checkCommand: "node --version",
          },
        ],
      }),
    );
    expect(decision).toMatchObject({
      kind: "create_task",
      title: "Resolve local Goal prerequisites",
    });
    expect(decision.kind === "create_task" ? decision.prompt : "").toContain("Node toolchain");
  });

  it("hard-fails with a diagnosis once the decision ceiling is exceeded", () => {
    const decisionEvidence = Array.from({ length: 4 }, (_unused, index) => ({
      id: `d${index}`,
      kind: "summary" as const,
      label: "Goal decision: start_worker",
      content: `decision ${index}`,
      createdAt: `2024-01-01T00:00:0${index}.000Z`,
    }));
    const decision = decideGoalNextAction(
      goalRun({
        tasks: [{ id: "t", title: "T", prompt: "x", status: "pending", attempts: 0 }],
        evidence: decisionEvidence,
      }),
      { decisionLimit: 3 },
    );
    expect(decision).toMatchObject({ kind: "terminal", status: "failed" });
    expect(decision.reason).toContain("maximum of 3 controller decisions");
  });

  it("still blocks on unmet external prerequisites", () => {
    expect(
      decideGoalNextAction(
        goalRun({
          prerequisites: [
            {
              id: "api-key",
              label: "Demo API key",
              status: "missing",
              kind: "external",
              instructions: "Provide DEMO_API_KEY in the local environment.",
            },
          ],
        }),
      ),
    ).toEqual({
      kind: "blocked",
      reason: "Demo API key: Provide DEMO_API_KEY in the local environment.",
    });
  });
});
