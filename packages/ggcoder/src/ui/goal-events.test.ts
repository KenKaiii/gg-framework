import { describe, expect, it } from "vitest";
import type { GoalRun } from "../core/goal-store.js";
import type { GoalWorkerCompletion } from "../core/goal-worker.js";
import {
  GOAL_EVENT_PAYLOAD_PREFIX,
  GOAL_VERIFIER_EVENT_PREFIX,
  GOAL_WORKER_EVENT_PREFIX,
  buildGoalStateSnapshot,
  formatGoalVerifierCompletionEvent,
  formatGoalWorkerCompletionEvent,
  isGoalSyntheticEvent,
  parseGoalSyntheticEvent,
  shouldContinueGoalRun,
} from "./goal-events.js";

function goalRun(overrides: Partial<GoalRun> = {}): GoalRun {
  return {
    id: "goal-12345678",
    title: "Fix messy web output",
    goal: "Fix web search and fetch output clarity",
    status: "ready",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    projectPath: "/tmp/project",
    successCriteria: ["Verifier passes"],
    prerequisites: [],
    harness: [],
    evidencePlan: [],
    tasks: [],
    evidence: [],
    blockers: [],
    ...overrides,
  };
}

function workerCompletion(overrides: Partial<GoalWorkerCompletion> = {}): GoalWorkerCompletion {
  return {
    worker: {
      id: "worker-a",
      pid: 123,
      goalRunId: "goal-12345678",
      goalTaskId: "task-a",
      cwd: "/tmp/project",
      provider: "anthropic",
      model: "claude-test",
      startedAt: "2024-01-01T00:00:00.000Z",
      logFile: "/tmp/worker.ndjson",
      status: "done",
      exitCode: 0,
    },
    summary: "Changed: web output cleaner\nVerified: npm run typecheck\nStatus: DONE",
    status: "done",
    exitCode: 0,
    toolsUsed: [
      { name: "read", ok: true },
      { name: "edit", ok: true },
      { name: "bash", ok: true },
    ],
    ...overrides,
  };
}

describe("goal event formatting", () => {
  it("formats worker completion as a synthetic orchestrator event", () => {
    const event = formatGoalWorkerCompletionEvent(
      goalRun(),
      "Implement cleaner web output",
      workerCompletion(),
    );

    expect(event).toContain(GOAL_WORKER_EVENT_PREFIX);
    expect(event).toContain('run_id="goal-12345678"');
    expect(event).toContain('task_id="task-a"');
    expect(event).toContain('worker="worker-a"');
    expect(event).toContain("status=done");
    expect(event).toContain("exit_code=0");
    expect(event).toContain(GOAL_EVENT_PAYLOAD_PREFIX);
    expect(event).toContain("tools_used: ✓read, ✓edit, ✓bash");
    expect(event).toContain("current_goal_state:");
    expect(event).toContain("user_prerequisites: (none)");
    expect(event).toContain("tasks:\n(none)");
    expect(event).toContain("summary:\nChanged: web output cleaner");
    expect(event).toContain("coordinator_instructions:");
    expect(event).toContain('Call goals({ action: "status", run_id }) before deciding.');
    expect(event).toContain("Briefly say what you are doing as the coordinator");
    expect(isGoalSyntheticEvent(event)).toBe(true);
    expect(parseGoalSyntheticEvent(event)).toMatchObject({
      kind: "worker",
      runId: "goal-12345678",
      goal: "Fix messy web output",
      taskId: "task-a",
      task: "Implement cleaner web output",
      worker: "worker-a",
      status: "done",
      exitCode: 0,
      summary: expect.stringContaining("Changed: web output cleaner"),
      toolsUsed: [
        { name: "read", ok: true },
        { name: "edit", ok: true },
        { name: "bash", ok: true },
      ],
      goalState: expect.objectContaining({ status: "ready", evidenceCount: 0 }),
    });
  });

  it("includes exact user prerequisite instructions in synthetic state", () => {
    const event = formatGoalWorkerCompletionEvent(
      goalRun({
        status: "blocked",
        prerequisites: [
          {
            id: "supabase-token",
            label: "Supabase token",
            status: "missing",
            instructions: "Provide SUPABASE_ACCESS_TOKEN in chat or the local environment.",
          },
        ],
      }),
      "Collect prerequisites",
      workerCompletion(),
    );

    expect(event).toContain(
      "user_prerequisites: Supabase token: Provide SUPABASE_ACCESS_TOKEN in chat or the local environment.",
    );
    expect(event).toContain(
      "- supabase-token: missing; Supabase token; instructions=Provide SUPABASE_ACCESS_TOKEN in chat or the local environment.",
    );
  });

  it("formats failed worker completion with failed tool markers", () => {
    const event = formatGoalWorkerCompletionEvent(
      goalRun(),
      "Fix verifier failure",
      workerCompletion({
        status: "failed",
        exitCode: 1,
        summary: "Status: BLOCKED",
        toolsUsed: [{ name: "bash", ok: false }],
      }),
    );

    expect(event).toContain("status=failed");
    expect(event).toContain("exit_code=1");
    expect(event).toContain("tools_used: ✗bash");
    expect(isGoalSyntheticEvent(event)).toBe(true);
    expect(parseGoalSyntheticEvent(event)).toMatchObject({
      kind: "worker",
      status: "failed",
      exitCode: 1,
    });
  });

  it("formats crashed worker completion as failed synthetic event", () => {
    const event = formatGoalWorkerCompletionEvent(
      goalRun(),
      "Run disposable worker",
      workerCompletion({
        status: "failed",
        exitCode: 1,
        reason: "spawn_error",
        summary: "Failed to spawn Goal worker: spawn exploded",
        toolsUsed: [],
      }),
    );

    expect(event).toContain("status=failed");
    expect(event).toContain("reason=spawn_error");
    expect(event).toContain("Failed to spawn Goal worker: spawn exploded");
    expect(parseGoalSyntheticEvent(event)).toMatchObject({
      kind: "worker",
      runId: "goal-12345678",
      status: "failed",
      exitCode: 1,
    });
  });

  it("formats stopped worker completion as failed synthetic event when a stop is summarized", () => {
    const event = formatGoalWorkerCompletionEvent(
      goalRun(),
      "Stop disposable worker",
      workerCompletion({
        status: "failed",
        exitCode: 1,
        summary: "Worker stopped by user.",
        worker: { ...workerCompletion().worker, status: "stopped", exitCode: null },
        toolsUsed: [],
      }),
    );

    expect(event).toContain("status=failed");
    expect(event).toContain("Worker stopped by user.");
    expect(parseGoalSyntheticEvent(event)).toMatchObject({
      kind: "worker",
      status: "failed",
      exitCode: 1,
    });
  });

  it("formats verifier completion as a synthetic orchestrator event", () => {
    const event = formatGoalVerifierCompletionEvent(
      goalRun(),
      "pass",
      "npm run typecheck && node scripts/test-web-tools.mjs",
      0,
      "Verifier passed",
    );

    expect(event).toContain(GOAL_VERIFIER_EVENT_PREFIX);
    expect(event).toContain('run_id="goal-12345678"');
    expect(event).toContain("status=pass");
    expect(event).toContain("exit_code=0");
    expect(event).toContain("command: npm run typecheck && node scripts/test-web-tools.mjs");
    expect(event).toContain("summary:\nVerifier passed");
    expect(event).toContain("current_goal_state:");
    expect(event).toContain("verifier: (none - define an exact verifier before completion)");
    expect(event).toContain("Complete only if goals(status) shows success criteria");
    expect(event).toContain("fix_attempts: 0/5");
    expect(isGoalSyntheticEvent(event)).toBe(true);
    expect(parseGoalSyntheticEvent(event)).toMatchObject({
      kind: "verifier",
      runId: "goal-12345678",
      goal: "Fix messy web output",
      status: "pass",
      exitCode: 0,
      command: "npm run typecheck && node scripts/test-web-tools.mjs",
      fixAttempts: 0,
      fixLimit: 5,
      summary: "Verifier passed",
      goalState: expect.objectContaining({ status: "ready", evidenceCount: 0 }),
    });
  });

  it("formats verifier failure as corrective orchestrator input", () => {
    const event = formatGoalVerifierCompletionEvent(
      goalRun(),
      "fail",
      "pnpm test",
      1,
      "Verifier failed",
    );

    expect(event).toContain("status=fail");
    expect(event).toContain("exit_code=1");
    expect(event).toContain("Verifier failed");
    expect(event).toContain("Inspect durable tasks, verifier state, blockers, and evidence.");
    expect(event).not.toContain("what the orchestrator is doing");
    expect(parseGoalSyntheticEvent(event)).toMatchObject({
      kind: "verifier",
      runId: "goal-12345678",
      goal: "Fix messy web output",
      status: "fail",
      exitCode: 1,
      command: "pnpm test",
      summary: "Verifier failed",
    });
  });

  it("round-trips structured payloads containing quotes and newlines", () => {
    const run = goalRun({
      title: 'Fix "quoted" output',
      tasks: [
        {
          id: "task-a",
          title: 'Handle "quotes"',
          prompt: "Do work",
          status: "done",
          attempts: 1,
        },
      ],
      evidence: [
        {
          id: "evidence-a",
          kind: "log",
          label: "Verifier log",
          path: "artifacts/goal.log",
          content: "ok",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    const event = formatGoalWorkerCompletionEvent(
      run,
      'Handle "quotes"',
      workerCompletion({ summary: 'Line one\nLine "two"' }),
    );

    const parsed = parseGoalSyntheticEvent(event);

    expect(parsed).toMatchObject({
      kind: "worker",
      goal: 'Fix "quoted" output',
      task: 'Handle "quotes"',
      summary: 'Line one\nLine "two"',
      goalState: expect.objectContaining({
        evidenceCount: 1,
        latestEvidence: expect.objectContaining({ path: "artifacts/goal.log" }),
      }),
    });
    expect(parsed?.payload?.kind).toBe("worker");
  });

  it("builds a compact typed goal state snapshot for orchestrator review", () => {
    const snapshot = buildGoalStateSnapshot(
      goalRun({
        status: "blocked",
        blockers: ["Need token"],
        prerequisites: [
          {
            id: "token",
            label: "API token",
            status: "missing",
            instructions: "Provide API_TOKEN.",
          },
        ],
        evidencePlan: [
          {
            id: "verifier-log",
            label: "Verifier log",
            mechanism: "command",
            description: "Verifier output",
            status: "planned",
            command: "pnpm test",
          },
        ],
      }),
    );

    expect(snapshot).toMatchObject({
      status: "blocked",
      userPrerequisites: "API token: Provide API_TOKEN.",
      blockers: ["Need token"],
      prerequisites: [expect.objectContaining({ id: "token", status: "missing" })],
      evidencePlan: [expect.objectContaining({ id: "verifier-log", command: "pnpm test" })],
      evidenceCount: 0,
    });
  });

  it("classifies only prefixed worker/verifier pings as synthetic events so display can hide them", () => {
    expect(
      isGoalSyntheticEvent(formatGoalWorkerCompletionEvent(goalRun(), "Task", workerCompletion())),
    ).toBe(true);
    expect(
      isGoalSyntheticEvent(
        formatGoalVerifierCompletionEvent(goalRun(), "fail", "pnpm test", 1, "Verifier failed"),
      ),
    ).toBe(true);
    expect(isGoalSyntheticEvent("Please inspect the goal")).toBe(false);
    expect(isGoalSyntheticEvent(`note ${GOAL_WORKER_EVENT_PREFIX}`)).toBe(false);
    expect(parseGoalSyntheticEvent("Please inspect the goal")).toBeNull();
  });

  it("parses hidden synthetic events from payload while preserving markdown and fallback headers", () => {
    const event = formatGoalWorkerCompletionEvent(
      goalRun({ title: "Render **Goal** rows" }),
      "Check `markdown` and wrapping",
      workerCompletion({ summary: "Status: **done**\nChanged: `rows` stayed hidden" }),
    );
    const parsed = parseGoalSyntheticEvent(event);

    expect(parsed).toMatchObject({
      kind: "worker",
      goal: "Render **Goal** rows",
      task: "Check `markdown` and wrapping",
      summary: "Status: **done**\nChanged: `rows` stayed hidden",
    });
    expect(parsed?.payload).toBeDefined();

    expect(
      parseGoalSyntheticEvent(
        `${GOAL_WORKER_EVENT_PREFIX} run_id="run-legacy" goal="Legacy Goal" task_id="task-1" task="Legacy Task" worker="worker-1" status=done exit_code=0`,
      ),
    ).toMatchObject({
      kind: "worker",
      runId: "run-legacy",
      goal: "Legacy Goal",
      task: "Legacy Task",
      status: "done",
      exitCode: 0,
    });
  });

  it("continues non-terminal goals that have no active worker or running task", () => {
    expect(shouldContinueGoalRun(goalRun({ status: "ready" }))).toBe(true);
    expect(shouldContinueGoalRun(goalRun({ status: "running" }))).toBe(true);
    expect(shouldContinueGoalRun(goalRun({ status: "verifying" }))).toBe(true);
  });

  it("does not continue terminal or already-active goals", () => {
    expect(shouldContinueGoalRun(goalRun({ status: "blocked" }))).toBe(false);
    expect(shouldContinueGoalRun(goalRun({ status: "paused" }))).toBe(false);
    expect(shouldContinueGoalRun(goalRun({ status: "passed" }))).toBe(false);
    expect(shouldContinueGoalRun(goalRun({ status: "failed" }))).toBe(false);
    expect(shouldContinueGoalRun(goalRun({ activeWorkerId: "worker-a" }))).toBe(false);
    expect(
      shouldContinueGoalRun(
        goalRun({
          tasks: [
            {
              id: "task-a",
              title: "Running task",
              prompt: "Do work",
              status: "running",
              attempts: 1,
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});
