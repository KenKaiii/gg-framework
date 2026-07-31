import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppSidecarProjectAutopilotState } from "./app-sidecar-autopilot-state.js";
import {
  AppSidecarCancellationPersistence,
  handleCancellationPersistenceRetryRoute,
} from "./app-sidecar-cancellation.js";
import { commitPlanApprovalCheckpoint } from "./app-sidecar-phase-checkpoint.js";
import { AppSidecarPhaseCandidateStore } from "./app-sidecar-phase-candidates.js";
import {
  launchBoundPhase,
  type BoundPhaseCandidate,
  type BoundPhaseSession,
  type PhaseLaunchRepository,
  type PhaseStartResponseBody,
} from "./app-sidecar-phase-launch.js";
import {
  APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES,
  AppSidecarRoadmapToolHost,
} from "./app-sidecar-roadmap-tool-host.js";
import { AppSidecarSessionMutationCoordinator } from "./app-sidecar-session-mutation.js";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import {
  AppSidecarPhaseLifecycleCoordinator,
  type BoundPhaseLifecycleContext,
  type PhaseLifecycleRepositoryOutcome,
} from "./app-sidecar-phase-lifecycle.js";
import type { ActivePhaseContextV1, ActivePhaseExecutionStage } from "./phase-context.js";
import {
  ProjectNotesRepository,
  type NotesDocumentV3,
  type ProjectNotesSnapshot,
} from "./project-notes-repository.js";
import { createTools } from "./tools/index.js";
import { RoadmapStatusParams } from "./tools/roadmap-status.js";

const NOW = "2026-07-26T00:00:00.000Z";
const roots: string[] = [];

function document(): NotesDocumentV3 {
  return {
    version: 3,
    reference: "unrelated free-form Notes",
    currentFocus: "another phase",
    tasks: [],
    handoff: { text: "unrelated handoff", updatedAt: null, readAt: null },
    updatedAt: NOW,
    legacyImportedAt: null,
    references: [
      {
        id: "ref-1",
        provider: "github",
        tool: "searchCode",
        canonicalUrl: "https://github.com/acme/repo/blob/main/src/phase.ts#L1-L2",
        owner: "acme",
        repo: "repo",
        revision: "main",
        path: "src/phase.ts",
        range: { startLine: 1, endLine: 2 },
        issue: null,
        pullRequest: null,
        query: "launchPhase(",
        anchor: "launchPhase",
        relevance: "Transaction source",
        capturedAt: NOW,
      },
    ],
    phases: [
      {
        id: "phase-21",
        title: "Bound phase",
        goal: "Create one session",
        doneWhen: ["Binding commits before prompt"],
        order: 0,
        status: "not-started",
        sourcePrompt: "Plan only this phase",
        referenceIds: ["ref-1"],
        session: null,
        reminder: null,
        attentionReason: null,
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
        overrides: { status: null, referenceIds: null },
        pendingAutomaticLifecycleTransition: null,
        lifecycleEvents: [],
        roadmapEvents: [],
      },
    ],
  };
}

interface ResponseRecord {
  status: number;
  body: PhaseStartResponseBody;
}

class FakePhaseSession implements BoundPhaseSession {
  readonly state: {
    provider: "anthropic";
    model: string;
    sessionId: string;
    sessionPath: string;
  };
  activeContext: ActivePhaseContextV1 | undefined;
  disposeCalls = 0;
  promptCalls = 0;
  lastPrompt = "";
  planMode = false;
  readonly #paneEventListeners = new Set<(event: string) => void>();

  constructor(
    sessionNumber: number,
    private readonly events: string[],
    private readonly failures: { initialize?: boolean; context?: boolean; prompt?: boolean } = {},
    private readonly label = `candidate-${sessionNumber}`,
  ) {
    this.state = {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      sessionId: `session-${sessionNumber}`,
      sessionPath: `/sessions/session-${sessionNumber}.jsonl`,
    };
  }

  async initialize(): Promise<void> {
    this.events.push("candidate-initialize");
    if (this.failures.initialize) throw new Error("session creation failed");
  }

  getState() {
    return { ...this.state };
  }

  async setActivePhaseContext(context: ActivePhaseContextV1): Promise<void> {
    this.events.push("context-persisted");
    if (this.failures.context) throw new Error("active phase context persistence failed");
    this.activeContext = structuredClone(context);
  }

  getActivePhaseContext(): ActivePhaseContextV1 | undefined {
    return this.activeContext ? structuredClone(this.activeContext) : undefined;
  }

  async updateActivePhaseStage(
    executionStage: ActivePhaseExecutionStage,
    approvedPlanPath?: string,
  ): Promise<ActivePhaseContextV1> {
    const activeContext = this.activeContext;
    if (!activeContext) throw new Error("No active phase context is bound.");
    this.events.push("stage-persisted");
    const updated: ActivePhaseContextV1 = {
      ...activeContext,
      executionStage,
      ...(approvedPlanPath ? { approvedPlanPath } : {}),
    };
    this.activeContext = updated;
    return structuredClone(updated);
  }

  setIdealReviewSuppressed(suppressed: boolean): void {
    this.events.push(`ideal-review:${String(suppressed)}`);
  }

  async prompt(text: string): Promise<void> {
    this.promptCalls += 1;
    this.lastPrompt = text;
    this.events.push("prompt");
    if (this.failures.prompt) throw new Error("provider unavailable");
  }

  async newSession(preserveConversation = false): Promise<void> {
    this.events.push(`fresh-session:${String(preserveConversation)}`);
    const next = Number(this.state.sessionId.split("-").at(-1)) + 100;
    this.state.sessionId = `session-${next}`;
    this.state.sessionPath = `/sessions/session-${next}.jsonl`;
    if (!preserveConversation) this.activeContext = undefined;
  }

  onPaneEvent(listener: (event: string) => void): void {
    this.#paneEventListeners.add(listener);
  }

  emitPaneEvent(event: string): void {
    for (const listener of this.#paneEventListeners) listener(event);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.events.push(`${this.label}-disposed`);
    this.#paneEventListeners.clear();
  }
}

function createApprovalLifecycle(
  repository: ProjectNotesRepository,
  cwd: string,
  session: FakePhaseSession,
  broadcastSnapshot: (snapshot: ProjectNotesSnapshot) => void = () => undefined,
): AppSidecarPhaseLifecycleCoordinator {
  return new AppSidecarPhaseLifecycleCoordinator({
    cwd,
    repository,
    getActivePhase: () => {
      const active = session.getActivePhaseContext();
      if (!active) return undefined;
      const state = session.getState();
      return {
        phaseId: active.phase.id,
        session: { sessionId: state.sessionId, sessionPath: state.sessionPath },
        executionStage: active.executionStage,
      };
    },
    broadcastSnapshot,
  });
}

interface FixtureOptions {
  mode?: "code" | "chat";
  busyState?: { running: boolean; autopilotActive: boolean; runLifecycleRunning: boolean };
  autopilotEnabled?: boolean;
  failInitializeCount?: number;
  failContextCount?: number;
  failPromptCount?: number;
  failBindingCount?: number;
  failAttention?: boolean;
  failEnterPlanMode?: boolean;
  pauseBinding?: { promise: Promise<void> };
  pauseAttention?: { promise: Promise<void> };
  sessionNumberBase?: number;
}

class ProductionPhaseFixture {
  readonly events: string[] = [];
  readonly paneEvents: string[] = [];
  readonly responses: ResponseRecord[] = [];
  readonly broadcasts: Array<{ type: string; data: unknown }> = [];
  readonly candidates = new AppSidecarPhaseCandidateStore<BoundPhaseCandidate<FakePhaseSession>>();
  readonly mutations: AppSidecarSessionMutationCoordinator;
  readonly reconciliations = new AppSidecarRoadmapReconciliationCoordinator();
  readonly previousSession: FakePhaseSession;
  currentSession: FakePhaseSession;
  createdSessions: FakePhaseSession[] = [];
  createCalls = 0;
  promptSettled: Promise<void> = Promise.resolve();
  private sequence = 0;
  private failInitializeCount: number;
  private failContextCount: number;
  private failPromptCount: number;
  private failBindingCount: number;

  constructor(
    readonly repository: ProjectNotesRepository,
    readonly cwd: string,
    readonly options: FixtureOptions = {},
  ) {
    this.mutations = new AppSidecarSessionMutationCoordinator(() => `operation-${++this.sequence}`);
    this.previousSession = new FakePhaseSession(0, this.events, {}, "previous");
    this.currentSession = this.previousSession;
    this.bindPaneEvents(this.previousSession);
    this.failInitializeCount = options.failInitializeCount ?? 0;
    this.failContextCount = options.failContextCount ?? 0;
    this.failPromptCount = options.failPromptCount ?? 0;
    this.failBindingCount = options.failBindingCount ?? 0;
  }

  async start(phaseId = "phase-21"): Promise<ResponseRecord> {
    let responseRecord: ResponseRecord | undefined;
    const repository = this.phaseRepository();
    await launchBoundPhase({
      phaseId,
      mode: this.options.mode ?? "code",
      busyState: this.options.busyState ?? {
        running: false,
        autopilotActive: false,
        runLifecycleRunning: false,
      },
      mutations: this.mutations,
      reconciliations: this.reconciliations,
      repository,
      cwd: this.cwd,
      candidates: this.candidates,
      getSession: () => this.currentSession,
      getThinkingLevel: () => "high",
      createSession: () => {
        this.createCalls += 1;
        this.events.push("candidate-created");
        const session = new FakePhaseSession(
          (this.options.sessionNumberBase ?? 0) + this.createCalls,
          this.events,
          {
            initialize: this.takeFailure("initialize"),
            context: this.takeFailure("context"),
            prompt: this.takeFailure("prompt"),
          },
        );
        this.createdSessions.push(session);
        return session;
      },
      replaceSession: (session) => {
        this.events.push("session-replaced");
        this.currentSession = session;
      },
      bindSessionEvents: (session) => {
        this.events.push("events-bound");
        this.bindPaneEvents(session);
      },
      autopilotEnabled: this.options.autopilotEnabled ?? false,
      broadcastNotesSnapshot: () => this.events.push("notes-fan-out"),
      broadcast: (type, data) => {
        this.events.push(type === "session_reset" ? "session-reset" : type);
        this.broadcasts.push({ type, data });
      },
      resetSessionState: () => this.events.push("phase-state-reset"),
      enterPlanMode: async () => {
        this.currentSession.planMode = true;
        this.events.push("plan-mode");
        if (this.options.failEnterPlanMode) throw new Error("plan mode failed");
      },
      startPrompt: (_label, run, onFailure) => {
        this.events.push("prompt-started");
        this.promptSettled = run()
          .catch(onFailure)
          .then(() => undefined);
      },
      respond: (status, body) => {
        this.events.push(`response:${status}`);
        responseRecord = { status, body };
        this.responses.push(responseRecord);
      },
      onLaunchFailure: () => this.events.push("launch-failure-reported"),
      onAttentionFailure: () => this.events.push("attention-failure-reported"),
    });
    if (!responseRecord) throw new Error("phase launch did not respond");
    return responseRecord;
  }

  async resetSession(): Promise<void> {
    await this.candidates.clear();
    await this.currentSession.newSession();
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.candidates.dispose(), this.currentSession.dispose()]);
  }

  private phaseRepository(): PhaseLaunchRepository {
    return {
      launchPhase: async (cwd, phaseId, createBinding) => {
        this.events.push("bind-started");
        const outcome = await this.repository.launchPhase(cwd, phaseId, async (frozen) => {
          const binding = await createBinding(frozen);
          await this.options.pauseBinding?.promise;
          if (this.failBindingCount > 0) {
            this.failBindingCount -= 1;
            throw new Error("bind persistence failed");
          }
          return binding;
        });
        this.events.push("bind-committed");
        return outcome;
      },
      recordPhaseLaunchAttention: async (cwd, phaseId, reason, expectedSession) => {
        await this.options.pauseAttention?.promise;
        if (this.options.failAttention) {
          throw new Error("attention persistence failed");
        }
        return this.repository.recordPhaseLaunchAttention(cwd, phaseId, reason, expectedSession);
      },
    };
  }

  private bindPaneEvents(session: FakePhaseSession): void {
    session.onPaneEvent((event) => this.paneEvents.push(event));
  }
  private takeFailure(kind: "initialize" | "context" | "prompt"): boolean {
    const key =
      kind === "initialize"
        ? "failInitializeCount"
        : kind === "context"
          ? "failContextCount"
          : "failPromptCount";
    if (this[key] <= 0) return false;
    this[key] -= 1;
    return true;
  }
}

async function setup(migrate = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-phase-route-"));
  roots.push(root);
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd, { recursive: true });
  const repository = new ProjectNotesRepository(path.join(root, ".gg"));
  if (migrate) await repository.migrate(cwd, document());
  return { repository, cwd, root };
}

async function updatePhase(
  repository: ProjectNotesRepository,
  cwd: string,
  update: (document: NotesDocumentV3) => void,
): Promise<void> {
  const loaded = await repository.load(cwd);
  if (loaded.status !== "ok") throw new Error(`Project Notes load failed: ${loaded.status}`);
  const next = structuredClone(loaded.snapshot.document);
  update(next);
  const saved = await repository.save(cwd, loaded.snapshot.revision, next);
  if (saved.status !== "ok") throw new Error(`Project Notes save failed: ${saved.status}`);
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function roadmapInput(
  updateId: string,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof RoadmapStatusParams.parse> {
  return RoadmapStatusParams.parse({
    update_id: updateId,
    phase_id: "phase-21",
    transition: "in-progress",
    progress: `Progress for ${updateId}`,
    ...overrides,
  });
}

async function executeRoadmap(
  tool: AgentTool,
  input: ReturnType<typeof RoadmapStatusParams.parse>,
): Promise<Record<string, unknown>> {
  const output = await tool.execute(input, {} as never);
  if (typeof output !== "string") throw new Error("roadmap_status returned non-text output");
  return JSON.parse(output) as Record<string, unknown>;
}

function roadmapHost(
  repository: Pick<
    ProjectNotesRepository,
    "recordRoadmapStatusUpdate" | "recordRoadmapFinalReview"
  >,
  cwd: string,
  reconciliations: AppSidecarRoadmapReconciliationCoordinator,
  projectAutopilot: AppSidecarProjectAutopilotState,
  snapshots: ProjectNotesSnapshot[],
): AppSidecarRoadmapToolHost {
  return new AppSidecarRoadmapToolHost({
    cwd,
    repository,
    reconciliations,
    projectAutopilot,
    broadcastNotesSnapshot: (snapshot) => snapshots.push(snapshot),
    now: () => NOW,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("cancel route phase persistence", () => {
  const activeCancellation: BoundPhaseLifecycleContext = {
    phaseId: "phase-21",
    session: { sessionId: "session-21", sessionPath: "/sessions/session-21.jsonl" },
    executionStage: "implementing",
  };

  function cancellationFixture(outcomes: Array<PhaseLifecycleRepositoryOutcome | Error>): {
    persistence: AppSidecarCancellationPersistence;
    broadcasts: Array<{ type: string; data: unknown }>;
    successfulWrites: number;
  } {
    const broadcasts: Array<{ type: string; data: unknown }> = [];
    let successfulWrites = 0;
    const lifecycle = new AppSidecarPhaseLifecycleCoordinator({
      cwd: "/project",
      repository: {
        recordPhaseLifecycleTransition: vi.fn(async () => {
          const outcome = outcomes.shift();
          if (outcome instanceof Error) throw outcome;
          if (!outcome) throw new Error("missing test outcome");
          if (outcome.status === "ok") successfulWrites += 1;
          return outcome;
        }),
      },
      getActivePhase: () => activeCancellation,
      broadcastSnapshot: vi.fn(),
    });
    return {
      persistence: new AppSidecarCancellationPersistence({
        lifecycle,
        broadcast: (type, data) => broadcasts.push({ type, data }),
        createOperationId: () => "cancel-operation-1",
      }),
      broadcasts,
      get successfulWrites() {
        return successfulWrites;
      },
    };
  }

  function cancellationSnapshot(): ProjectNotesSnapshot {
    const notes = document();
    const phase = notes.phases[0]!;
    phase.status = "cancelled";
    phase.completedAt = NOW;
    phase.session = { ...activeCancellation.session };
    phase.lifecycleEvents.push({
      id: "cancel-event-1",
      fromStatus: "in-progress",
      toStatus: "cancelled",
      source: "user",
      timestamp: NOW,
      reason: "Phase run cancelled by user",
      kind: "other",
    });
    return { projectKey: "/project", revision: 2, document: notes };
  }

  it("reports a committed Cancelled record without a partial failure", async () => {
    const fixture = cancellationFixture([{ status: "ok", snapshot: cancellationSnapshot() }]);

    await expect(
      fixture.persistence.recordConfirmedCancellation(activeCancellation),
    ).resolves.toMatchObject({
      roadmapStatusSaved: true,
      roadmapStatusOutcome: "committed",
      roadmapStatusRetryable: false,
    });
    expect(fixture.broadcasts).toEqual([]);
  });

  it.each(["manual-override", "done-terminal"] as const)(
    "keeps the cancelled run truthful when Project Notes is protected by %s",
    async (status) => {
      const fixture = cancellationFixture([
        status === "manual-override" ? { status, snapshot: cancellationSnapshot() } : { status },
      ]);

      const response = {
        cancelled: true,
        ...(await fixture.persistence.recordConfirmedCancellation(activeCancellation)),
      };
      expect(response).toEqual({
        cancelled: true,
        roadmapStatusSaved: false,
        roadmapStatusOutcome: status,
        roadmapStatusRetryable: false,
      });
      expect(fixture.broadcasts).toEqual([]);
    },
  );

  it.each(["stale-session", "missing", "corrupt", "phase-not-found", "phase-archived"] as const)(
    "surfaces %s as a typed cancellation persistence partial failure",
    async (status) => {
      const fixture = cancellationFixture([{ status }]);

      const response = {
        cancelled: true,
        ...(await fixture.persistence.recordConfirmedCancellation(activeCancellation)),
      };
      expect(response).toMatchObject({
        cancelled: true,
        roadmapStatusSaved: false,
        roadmapStatusOutcome: status,
        roadmapStatusRetryable: true,
        roadmapStatusFailure: {
          operationId: "cancel-operation-1",
          phaseId: "phase-21",
          code: status,
          recovery: expect.stringContaining("Project Notes"),
        },
      });
      expect(fixture.broadcasts).toEqual([
        {
          type: "phase_cancellation_persistence_failed",
          data: expect.objectContaining({ code: status, phaseId: "phase-21" }),
        },
      ]);
    },
  );

  it("surfaces a thrown storage failure while leaving cancellation acknowledged", async () => {
    const fixture = cancellationFixture([new Error("disk full")]);

    const response = {
      cancelled: true,
      ...(await fixture.persistence.recordConfirmedCancellation(activeCancellation)),
    };
    expect(response).toMatchObject({
      cancelled: true,
      roadmapStatusSaved: false,
      roadmapStatusOutcome: "storage-failure",
      roadmapStatusRetryable: true,
      roadmapStatusFailure: { code: "storage-failure", detail: "disk full" },
    });
  });

  it("retries the captured phase through the route and appends exactly one Cancelled event", async () => {
    const fixture = cancellationFixture([
      new Error("temporary storage failure"),
      { status: "ok", snapshot: cancellationSnapshot() },
    ]);
    await fixture.persistence.recordConfirmedCancellation(activeCancellation);
    const response = new Promise<{ status: number; body: unknown }>((resolve) => {
      expect(
        handleCancellationPersistenceRetryRoute({
          method: "POST",
          url: "/cancel/roadmap-status/retry",
          retry: () => fixture.persistence.retry(),
          respond: (status, body) => resolve({ status, body }),
        }),
      ).toBe(true);
    });

    await expect(response).resolves.toMatchObject({
      status: 200,
      body: {
        roadmapStatusSaved: true,
        roadmapStatusOutcome: "committed",
        roadmapStatusRetryable: false,
      },
    });
    expect(fixture.successfulWrites).toBe(1);
    expect(cancellationSnapshot().document.phases[0]!.lifecycleEvents).toHaveLength(1);
    await expect(fixture.persistence.retry()).resolves.toMatchObject({
      roadmapStatusOutcome: "not-pending",
    });
    expect(fixture.successfulWrites).toBe(1);
    expect(fixture.broadcasts.at(-1)).toMatchObject({
      type: "phase_cancellation_persistence_recovered",
      data: { phaseId: "phase-21", roadmapStatusSaved: true },
    });
  });
});

describe("production launchBoundPhase orchestration", () => {
  it("uses the production bind → fan-out → replacement → reset → Plan Mode → response → prompt order", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd);

    const response = await fixture.start();
    await fixture.promptSettled;

    expect(response).toMatchObject({
      status: 202,
      body: {
        status: "accepted",
        operationId: "operation-1",
        session: { sessionId: "session-1", sessionPath: "/sessions/session-1.jsonl" },
        packageTokenCount: expect.any(Number),
      },
    });
    expect(fixture.events).toEqual([
      "bind-started",
      "candidate-created",
      "candidate-initialize",
      "context-persisted",
      "bind-committed",
      "notes-fan-out",
      "session-replaced",
      "events-bound",
      "ideal-review:false",
      "phase-state-reset",
      "session-reset",
      "plan-mode",
      "previous-disposed",
      "response:202",
      "prompt-started",
      "prompt",
    ]);
    expect(fixture.currentSession.planMode).toBe(true);
    expect(fixture.currentSession.activeContext).toMatchObject({
      phase: { id: "phase-21" },
      references: [{ id: "ref-1" }],
      session: { sessionId: "session-1" },
    });
    expect(fixture.currentSession.lastPrompt).toContain('"id": "phase-21"');
    expect(fixture.currentSession.lastPrompt).toContain('"id": "ref-1"');
    expect(fixture.currentSession.lastPrompt).not.toContain("unrelated free-form Notes");
    expect(fixture.currentSession.lastPrompt).not.toContain("another phase");
    expect(fixture.mutations.owner).toBeNull();
    const promoted = fixture.createdSessions[0]!;
    expect(promoted.disposeCalls).toBe(0);
    expect(fixture.candidates.has("phase-21")).toBe(false);

    await fixture.dispose();

    expect(promoted.disposeCalls).toBe(1);
  });

  it("persists the complete Phase 26 release-gate journey and rejects restart after Done", async () => {
    const { repository, cwd, root } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd);

    const accepted = await fixture.start();
    await fixture.promptSettled;

    expect(accepted).toMatchObject({
      status: 202,
      body: {
        status: "accepted",
        session: { sessionId: "session-1", sessionPath: "/sessions/session-1.jsonl" },
      },
    });
    expect(fixture.currentSession.activeContext).toMatchObject({
      phase: {
        id: "phase-21",
        sourcePrompt: "Plan only this phase",
      },
      references: [
        {
          id: "ref-1",
          canonicalUrl: "https://github.com/acme/repo/blob/main/src/phase.ts#L1-L2",
        },
      ],
    });
    expect(fixture.currentSession.lastPrompt).toContain("Plan only this phase");
    expect(fixture.currentSession.lastPrompt).toContain(
      "https://github.com/acme/repo/blob/main/src/phase.ts#L1-L2",
    );
    expect(fixture.currentSession.lastPrompt).not.toContain("unrelated free-form Notes");
    expect(fixture.currentSession.lastPrompt).not.toContain("unrelated handoff");
    expect(fixture.currentSession.lastPrompt).not.toContain("another phase");

    const session = fixture.currentSession;
    const approvalLifecycle = createApprovalLifecycle(repository, cwd, session);
    await expect(
      commitPlanApprovalCheckpoint({
        session,
        repository,
        cwd,
        planPath: "/plans/phase-26-release-gate.md",
        approvalSource: "user",
        reconcileLifecycle: (signal) => approvalLifecycle.enqueue(signal),
        prepareFreshSession: async () => {
          await session.newSession(true);
          return 3;
        },
      }),
    ).resolves.toMatchObject({ planTotal: 3, phaseLink: { status: "synchronized" } });

    const afterApproval = await repository.load(cwd);
    if (afterApproval.status !== "ok") throw new Error("Expected approved phase");
    const approvedPhase = afterApproval.snapshot.document.phases[0]!;
    const boundSession = approvedPhase.session!;
    const approvalTime = Date.parse(approvedPhase.lifecycleEvents.at(-1)!.timestamp);
    const checkpointAt = new Date(approvalTime + 1_000).toISOString();
    const verificationAt = new Date(approvalTime + 2_000).toISOString();
    const reviewAt = new Date(approvalTime + 3_000).toISOString();

    await expect(
      repository.recordImplementationCheckpoint(cwd, {
        checkpointId: "phase-26-implementation",
        phaseId: "phase-21",
        expectedSession: boundSession,
        planStepTotal: 3,
        completedPlanSteps: [1, 2, 3],
        runOutcome: "succeeded",
        timestamp: checkpointAt,
      }),
    ).resolves.toMatchObject({ status: "committed" });

    let roadmapTimestamp = verificationAt;
    const snapshots: ProjectNotesSnapshot[] = [];
    const host = new AppSidecarRoadmapToolHost({
      cwd,
      repository,
      reconciliations: fixture.reconciliations,
      projectAutopilot: new AppSidecarProjectAutopilotState(),
      broadcastNotesSnapshot: (snapshot) => snapshots.push(snapshot),
      now: () => roadmapTimestamp,
    });
    await expect(
      executeRoadmap(
        host.createSessionTools("coding", () => fixture.currentSession)[0]!,
        roadmapInput("phase-26-verification", {
          transition: "review",
          progress: "Phase 26 focused verification passed",
          evidence: ["Focused Track B tests passed"],
          verification: { result: "passed" },
        }),
      ),
    ).resolves.toMatchObject({ result: "committed", statusOutcome: "applied" });

    roadmapTimestamp = reviewAt;
    await expect(
      executeRoadmap(
        host.createSessionTools("ken-autopilot")[0]!,
        roadmapInput("phase-26-final-status", {
          transition: "review",
          progress: "Phase 26 completion evidence reviewed",
          evidence: ["Implementation and verification evidence accepted"],
          final_review: {
            review_id: "phase-26-final-review",
            decision: "accepted",
            evidence: ["Autopilot Ken accepted every completion gate"],
          },
        }),
      ),
    ).resolves.toMatchObject({
      result: "completion-review-committed",
      gateOutcome: "done",
      unmetGateCodes: [],
    });
    expect(snapshots).toHaveLength(2);

    await fixture.dispose();

    const restartedRepository = new ProjectNotesRepository(path.join(root, ".gg"));
    const restartedLoad = await restartedRepository.load(cwd);
    if (restartedLoad.status !== "ok") throw new Error("Expected durable completed phase");
    const durable = restartedLoad.snapshot.document.phases[0]!;
    expect(durable).toMatchObject({
      id: "phase-21",
      sourcePrompt: "Plan only this phase",
      referenceIds: ["ref-1"],
      session: boundSession,
      status: "done",
      archivedAt: null,
    });
    expect(restartedLoad.snapshot.document.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ref-1",
          canonicalUrl: "https://github.com/acme/repo/blob/main/src/phase.ts#L1-L2",
        }),
      ]),
    );
    expect(durable.roadmapEvents).toEqual([
      expect.objectContaining({
        type: "implementation-checkpoint",
        id: "phase-26-implementation",
        session: boundSession,
        planStepTotal: 3,
        completedPlanSteps: [1, 2, 3],
        runOutcome: "succeeded",
      }),
      expect.objectContaining({
        type: "status-update",
        id: "phase-26-verification",
        actor: "gg-coder",
        verification: "passed",
        verificationSession: boundSession,
        evidence: ["Focused Track B tests passed"],
      }),
      expect.objectContaining({
        type: "status-update",
        id: "phase-26-final-status",
        actor: "ken-autopilot",
        statusOutcome: "evidence-only",
      }),
      expect.objectContaining({
        type: "completion-review",
        id: "phase-26-final-review",
        reviewer: "ken-autopilot",
        decision: "accepted",
        implementationCheckpointId: "phase-26-implementation",
        verificationStatusUpdateId: "phase-26-verification",
        gateOutcome: "done",
        unmetGateCodes: [],
      }),
    ]);
    expect(durable.lifecycleEvents.map((event) => event.toStatus)).toEqual([
      "planning",
      "in-progress",
      "review",
      "done",
    ]);
    expect(durable.lifecycleEvents.filter((event) => event.toStatus === "done")).toHaveLength(1);
    const chronologicalActivity = [
      ...durable.lifecycleEvents.map((event) => ({
        label: `lifecycle:${event.toStatus}`,
        timestamp: event.timestamp,
      })),
      ...durable.roadmapEvents.map((event) => ({
        label: `${event.type}:${event.id}`,
        timestamp: event.timestamp,
      })),
    ]
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
      .map(({ label }) => label);
    expect(chronologicalActivity).toEqual([
      "lifecycle:planning",
      "lifecycle:in-progress",
      "implementation-checkpoint:phase-26-implementation",
      "lifecycle:review",
      "status-update:phase-26-verification",
      "lifecycle:done",
      "status-update:phase-26-final-status",
      "completion-review:phase-26-final-review",
    ]);

    const restarted = new ProductionPhaseFixture(restartedRepository, cwd);
    await expect(restarted.start()).resolves.toMatchObject({
      status: 409,
      body: {
        status: "failed",
        code: "phase-inactive",
        message: "This phase is already Done. Reopen Roadmap to review its completion evidence.",
      },
    });
    expect(restarted.createCalls).toBe(0);
    expect(restarted.currentSession.promptCalls).toBe(0);
    expect(restarted.events).not.toContain("session-replaced");
    expect(restarted.events).not.toContain("phase-state-reset");
    expect(restarted.events).not.toContain("prompt-started");
    await restarted.dispose();
  });

  it.each([
    ["chat mode", { mode: "chat" as const }, "coding-mode-required"],
    [
      "active run",
      { busyState: { running: true, autopilotActive: false, runLifecycleRunning: true } },
      "session-busy",
    ],
    [
      "Autopilot review",
      { busyState: { running: false, autopilotActive: true, runLifecycleRunning: false } },
      "session-busy",
    ],
  ])("rejects %s before mutation or candidate creation", async (_name, options, code) => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd, options);

    const response = await fixture.start();

    expect(response).toMatchObject({ status: 409, body: { status: "failed", code } });
    expect(fixture.createCalls).toBe(0);
    expect(fixture.events).toEqual(["response:409"]);
    expect(fixture.mutations.owner).toBeNull();
  });

  it("gives a double-click one mutation winner and releases the lease for retry", async () => {
    const { repository, cwd } = await setup();
    const pause = deferred();
    const fixture = new ProductionPhaseFixture(repository, cwd, { pauseBinding: pause });

    const winner = fixture.start();
    await viWaitFor(() => fixture.candidates.has("phase-21"));
    const loser = await fixture.start();

    expect(loser).toEqual({
      status: 409,
      body: {
        status: "failed",
        code: "session-mutation-in-progress",
        operationId: "operation-1",
        message: "Another session action is already in progress.",
      },
    });
    pause.resolve();
    await expect(winner).resolves.toMatchObject({ status: 202, body: { status: "accepted" } });
    await fixture.promptSettled;
    expect(fixture.createCalls).toBe(1);
    expect(fixture.currentSession.promptCalls).toBe(1);
    expect(fixture.mutations.owner).toBeNull();
  });

  it("allows one cross-window binding winner and makes the loser an exact Resume response", async () => {
    const { repository, cwd, root } = await setup();
    const first = new ProductionPhaseFixture(repository, cwd);
    const second = new ProductionPhaseFixture(
      new ProjectNotesRepository(path.join(root, ".gg")),
      cwd,
    );

    const [left, right] = await Promise.all([first.start(), second.start()]);
    await Promise.all([first.promptSettled, second.promptSettled]);

    expect(new Set([left.body.status, right.body.status])).toEqual(
      new Set(["accepted", "already-bound"]),
    );
    const resume = left.body.status === "already-bound" ? left : right;
    expect(resume).toMatchObject({
      status: 200,
      body: {
        status: "already-bound",
        session: { sessionId: "session-1", sessionPath: "/sessions/session-1.jsonl" },
        packageTokenCount: 0,
      },
    });
    expect(first.createCalls + second.createCalls).toBe(1);
    expect(first.currentSession.promptCalls + second.currentSession.promptCalls).toBe(1);
  });

  it.each(["not-started", "needs-attention", "cancelled"] as const)(
    "recovers a null-path %s binding with one authoritative replacement",
    async (status) => {
      const { repository, cwd } = await setup();
      await updatePhase(repository, cwd, (notes) => {
        const phase = notes.phases[0]!;
        phase.status = status;
        phase.session = { sessionId: "bound", sessionPath: null };
        phase.attentionReason =
          status === "needs-attention" ? "Previous launch lost its session path." : null;
        phase.completedAt = status === "cancelled" ? NOW : null;
        phase.overrides.status = null;
        phase.lifecycleEvents = [];
      });
      const fixture = new ProductionPhaseFixture(repository, cwd);

      const response = await fixture.start();
      await fixture.promptSettled;

      expect(response).toMatchObject({
        status: 202,
        body: {
          status: "accepted",
          session: { sessionId: "session-1", sessionPath: "/sessions/session-1.jsonl" },
        },
      });
      expect(fixture.createCalls).toBe(1);
      expect(fixture.currentSession.promptCalls).toBe(1);
      expect(await repository.load(cwd)).toMatchObject({
        status: "ok",
        snapshot: {
          document: {
            phases: [
              {
                status: "planning",
                session: {
                  sessionId: "session-1",
                  sessionPath: "/sessions/session-1.jsonl",
                },
                lifecycleEvents: [
                  expect.objectContaining({ fromStatus: status, toStatus: "planning" }),
                ],
              },
            ],
          },
        },
      });
      await fixture.dispose();
    },
  );

  it("records launch attention against the original null-path binding when replacement commit fails", async () => {
    const { repository, cwd } = await setup();
    await updatePhase(repository, cwd, (notes) => {
      const phase = notes.phases[0]!;
      phase.session = { sessionId: "bound", sessionPath: null };
    });
    const fixture = new ProductionPhaseFixture(repository, cwd, { failBindingCount: 1 });

    await expect(fixture.start()).resolves.toMatchObject({
      status: 500,
      body: { code: "launch-failed" },
    });

    expect(await repository.load(cwd)).toMatchObject({
      status: "ok",
      snapshot: {
        document: {
          phases: [
            {
              status: "needs-attention",
              session: { sessionId: "bound", sessionPath: null },
              attentionReason: "Phase launch failed. Retry Start phase.",
            },
          ],
        },
      },
    });
    expect(fixture.events.filter((event) => event === "notes-fan-out")).toHaveLength(1);
    await fixture.dispose();
  });

  it("rejects losing pre-binding attention after a cross-window winner commits", async () => {
    const { repository, cwd, root } = await setup();
    const bindingGate = deferred();
    const attentionGate = deferred();
    const loser = new ProductionPhaseFixture(repository, cwd, {
      failBindingCount: 1,
      pauseBinding: bindingGate,
      pauseAttention: attentionGate,
    });
    const winner = new ProductionPhaseFixture(
      new ProjectNotesRepository(path.join(root, ".gg")),
      cwd,
      { sessionNumberBase: 100 },
    );

    const losingStart = loser.start();
    await viWaitFor(() => loser.candidates.has("phase-21"));
    const winningStart = winner.start();
    await viWaitFor(() => winner.events.includes("bind-started"));

    bindingGate.resolve();
    await viWaitFor(() => loser.events.includes("launch-failure-reported"));
    await expect(winningStart).resolves.toMatchObject({
      status: 202,
      body: { status: "accepted", session: { sessionId: "session-101" } },
    });
    await winner.promptSettled;
    attentionGate.resolve();
    await expect(losingStart).resolves.toMatchObject({
      status: 500,
      body: { code: "launch-failed" },
    });

    expect(await repository.load(cwd)).toMatchObject({
      status: "ok",
      snapshot: {
        document: {
          phases: [
            {
              status: "planning",
              session: {
                sessionId: "session-101",
                sessionPath: "/sessions/session-101.jsonl",
              },
              attentionReason: null,
              lifecycleEvents: [
                expect.objectContaining({
                  fromStatus: "not-started",
                  toStatus: "planning",
                  source: "user",
                }),
              ],
            },
          ],
        },
      },
    });
    expect(loser.events.filter((event) => event === "notes-fan-out")).toHaveLength(0);
  });

  it("retires the previous session after promotion when Plan Mode entry fails", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd, { failEnterPlanMode: true });
    const previous = fixture.previousSession;

    await expect(fixture.start()).resolves.toMatchObject({
      status: 500,
      body: { code: "launch-failed" },
    });

    const promoted = fixture.createdSessions[0]!;
    expect(previous.disposeCalls).toBe(1);
    expect(fixture.currentSession).toBe(promoted);
    expect(promoted.disposeCalls).toBe(0);
    expect(fixture.candidates.has("phase-21")).toBe(false);
    expect(fixture.events.filter((event) => event === "session-replaced")).toHaveLength(1);
    expect(fixture.events.filter((event) => event === "events-bound")).toHaveLength(1);

    previous.emitPaneEvent("stale-previous-session-event");
    promoted.emitPaneEvent("promoted-session-event");
    expect(fixture.paneEvents).toEqual(["promoted-session-event"]);

    expect(await repository.load(cwd)).toMatchObject({
      status: "ok",
      snapshot: {
        document: {
          phases: [
            {
              status: "needs-attention",
              session: {
                sessionId: "session-1",
                sessionPath: "/sessions/session-1.jsonl",
              },
              attentionReason: "Phase launch failed. Retry Start phase.",
            },
          ],
        },
      },
    });

    await expect(fixture.start()).resolves.toMatchObject({
      status: 200,
      body: {
        status: "already-bound",
        session: {
          sessionId: "session-1",
          sessionPath: "/sessions/session-1.jsonl",
        },
      },
    });
    expect(fixture.createCalls).toBe(1);
    expect(fixture.currentSession).toBe(promoted);
    expect(promoted.promptCalls).toBe(0);
    expect(promoted.disposeCalls).toBe(0);
    expect(previous.disposeCalls).toBe(1);
    expect(fixture.events.filter((event) => event === "session-replaced")).toHaveLength(1);

    await fixture.dispose();
    expect(promoted.disposeCalls).toBe(1);
    expect(previous.disposeCalls).toBe(1);
  });

  it("guards post-binding launch failure attention with the committed session", async () => {
    const { repository, cwd } = await setup();
    const attentionGate = deferred();
    const fixture = new ProductionPhaseFixture(repository, cwd, {
      failEnterPlanMode: true,
      pauseAttention: attentionGate,
    });

    const start = fixture.start();
    await viWaitFor(() => fixture.events.includes("launch-failure-reported"));
    await expect(
      repository.updatePhaseSessionLink(cwd, "phase-21", {
        sessionId: "session-new-owner",
        sessionPath: "/sessions/new-owner.jsonl",
      }),
    ).resolves.toMatchObject({ status: "ok" });
    attentionGate.resolve();
    await expect(start).resolves.toMatchObject({
      status: 500,
      body: { code: "launch-failed" },
    });

    expect(await repository.load(cwd)).toMatchObject({
      status: "ok",
      snapshot: {
        document: {
          phases: [
            {
              status: "planning",
              session: {
                sessionId: "session-new-owner",
                sessionPath: "/sessions/new-owner.jsonl",
              },
              attentionReason: null,
              lifecycleEvents: [
                expect.objectContaining({
                  fromStatus: "not-started",
                  toStatus: "planning",
                  source: "user",
                }),
              ],
            },
          ],
        },
      },
    });
    expect(fixture.events.filter((event) => event === "notes-fan-out")).toHaveLength(1);
  });

  it.each([
    ["session initialization", { failInitializeCount: 1 }],
    ["active-context persistence", { failContextCount: 1 }],
  ])(
    "disposes a failed %s candidate, releases mutation, and retries safely",
    async (_name, options) => {
      const { repository, cwd } = await setup();
      const fixture = new ProductionPhaseFixture(repository, cwd, options);

      const failed = await fixture.start();

      expect(failed).toMatchObject({ status: 500, body: { code: "launch-failed" } });
      expect(fixture.createdSessions[0]?.disposeCalls).toBe(1);
      expect(fixture.previousSession.disposeCalls).toBe(0);
      expect(fixture.candidates.has("phase-21")).toBe(false);
      expect(fixture.mutations.owner).toBeNull();
      expect(await repository.load(cwd)).toMatchObject({
        status: "ok",
        snapshot: {
          document: {
            phases: [
              {
                status: "needs-attention",
                session: null,
                lifecycleEvents: [
                  expect.objectContaining({
                    fromStatus: "not-started",
                    toStatus: "needs-attention",
                    source: "system",
                  }),
                ],
              },
            ],
          },
        },
      });

      await expect(fixture.start()).resolves.toMatchObject({
        status: 202,
        body: { status: "accepted" },
      });
      await fixture.promptSettled;
      expect(fixture.createCalls).toBe(2);
      expect(fixture.createdSessions[0]?.disposeCalls).toBe(1);
      expect(fixture.previousSession.disposeCalls).toBe(1);
      expect(fixture.currentSession.promptCalls).toBe(1);
    },
  );

  it("retains one initialized candidate across bind failure and reuses it on retry", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd, { failBindingCount: 1 });

    const failed = await fixture.start();

    expect(failed).toMatchObject({ status: 500, body: { code: "launch-failed" } });
    expect(fixture.candidates.has("phase-21")).toBe(true);
    expect(fixture.createdSessions[0]?.disposeCalls).toBe(0);
    expect(fixture.currentSession.promptCalls).toBe(0);
    expect(fixture.mutations.owner).toBeNull();

    const retried = await fixture.start();
    await fixture.promptSettled;

    expect(retried).toMatchObject({ status: 202, body: { status: "accepted" } });
    expect(fixture.createCalls).toBe(1);
    expect(fixture.candidates.has("phase-21")).toBe(false);
    expect(fixture.currentSession).toBe(fixture.createdSessions[0]);
    expect(fixture.currentSession.promptCalls).toBe(1);
  });

  it("disposes a retained bind-failure candidate exactly once with its logical owner", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd, { failBindingCount: 1 });

    await fixture.start();
    const retained = fixture.createdSessions[0]!;
    expect(retained.disposeCalls).toBe(0);

    await fixture.dispose();
    await fixture.candidates.dispose();

    expect(retained.disposeCalls).toBe(1);
    expect(fixture.candidates.has("phase-21")).toBe(false);
  });

  it("disposes a retained candidate when an external owner wins before retry", async () => {
    const { repository, cwd, root } = await setup();
    const staleOwner = new ProductionPhaseFixture(repository, cwd, { failBindingCount: 1 });
    const winner = new ProductionPhaseFixture(
      new ProjectNotesRepository(path.join(root, ".gg")),
      cwd,
    );

    await staleOwner.start();
    const stale = staleOwner.createdSessions[0]!;
    await expect(winner.start()).resolves.toMatchObject({
      status: 202,
      body: { status: "accepted" },
    });
    await winner.promptSettled;

    await expect(staleOwner.start()).resolves.toMatchObject({
      status: 200,
      body: { status: "already-bound" },
    });
    expect(stale.disposeCalls).toBe(1);
    expect(staleOwner.candidates.has("phase-21")).toBe(false);

    await staleOwner.dispose();
    await winner.dispose();
    expect(stale.disposeCalls).toBe(1);
  });

  it("disposes a retained candidate exactly once on explicit New Session reset", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd, { failBindingCount: 1 });

    await fixture.start();
    const stale = fixture.createdSessions[0]!;

    await fixture.resetSession();

    expect(stale.disposeCalls).toBe(1);
    expect(fixture.candidates.has("phase-21")).toBe(false);
    await fixture.dispose();
    expect(stale.disposeCalls).toBe(1);
  });

  it("responds before prompting and turns provider failure into durable retry attention", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd, { failPromptCount: 1 });

    const accepted = await fixture.start();
    expect(accepted).toMatchObject({ status: 202, body: { status: "accepted" } });
    expect(fixture.events.indexOf("response:202")).toBeLessThan(fixture.events.indexOf("prompt"));
    await fixture.promptSettled;

    expect(await repository.load(cwd)).toMatchObject({
      status: "ok",
      snapshot: {
        document: {
          phases: [
            {
              session: { sessionId: "session-1" },
              attentionReason:
                "The phase session was created, but its first planning prompt failed. Resume the phase to retry.",
            },
          ],
        },
      },
    });
    expect(fixture.broadcasts.at(-1)).toMatchObject({
      type: "phase_launch_error",
      data: { code: "prompt-failed", detail: "provider unavailable" },
    });
    expect(fixture.mutations.owner).toBeNull();
  });

  it("broadcasts prompt failure even when durable attention cannot be saved", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd, {
      failPromptCount: 1,
      failAttention: true,
    });

    await expect(fixture.start()).resolves.toMatchObject({
      status: 202,
      body: { status: "accepted" },
    });
    await fixture.promptSettled;

    expect(fixture.events).toContain("attention-failure-reported");
    expect(fixture.broadcasts.at(-1)).toMatchObject({
      type: "phase_launch_error",
      data: { code: "prompt-failed", detail: "provider unavailable" },
    });
  });

  it.each([
    ["missing", false, 404, "notes-missing"],
    ["corrupt", true, 409, "notes-corrupt"],
    ["phase-not-found", true, 409, "phase-not-found"],
    ["phase-archived", true, 409, "phase-archived"],
  ])(
    "returns the exact %s response without replacement or prompt",
    async (kind, migrate, status, code) => {
      const { repository, cwd } = await setup(migrate);
      if (kind === "corrupt") {
        const paths = repository.paths(cwd);
        await Promise.all([
          fs.writeFile(paths.primary, "{malformed"),
          fs.writeFile(paths.backup, "{malformed"),
        ]);
      } else if (kind === "phase-not-found") {
        await updatePhase(repository, cwd, (notes) => {
          notes.phases = [];
        });
      } else if (kind === "phase-archived") {
        await updatePhase(repository, cwd, (notes) => {
          notes.phases[0]!.archivedAt = NOW;
        });
      }
      const fixture = new ProductionPhaseFixture(repository, cwd);

      const response = await fixture.start();

      expect(response).toMatchObject({ status, body: { status: "failed", code } });
      expect(fixture.createCalls).toBe(0);
      expect(fixture.events).not.toContain("session-replaced");
      expect(fixture.events).not.toContain("prompt");
      expect(fixture.mutations.owner).toBeNull();
    },
  );

  it("returns the durable binding after restart so the caller can Resume without a second prompt", async () => {
    const { repository, cwd, root } = await setup();
    const first = new ProductionPhaseFixture(repository, cwd);
    const accepted = await first.start();
    await first.promptSettled;
    await first.dispose();

    const restarted = new ProductionPhaseFixture(
      new ProjectNotesRepository(path.join(root, ".gg")),
      cwd,
    );
    const resume = await restarted.start();

    expect(accepted).toMatchObject({ status: 202, body: { status: "accepted" } });
    expect(resume).toMatchObject({
      status: 200,
      body: {
        status: "already-bound",
        session: accepted.body.status === "accepted" ? accepted.body.session : undefined,
        packageTokenCount: 0,
      },
    });
    expect(restarted.createCalls).toBe(0);
    expect(restarted.currentSession.promptCalls).toBe(0);
  });

  it.each(["manual", "Autopilot"])(
    "keeps the launched phase linked through the %s approval checkpoint",
    async (approvalSource) => {
      const { repository, cwd } = await setup();
      const fixture = new ProductionPhaseFixture(repository, cwd, {
        autopilotEnabled: approvalSource === "Autopilot",
      });
      await fixture.start();
      await fixture.promptSettled;
      const session = fixture.currentSession;
      const approvalLifecycle = createApprovalLifecycle(repository, cwd, session, () =>
        fixture.events.push("approval-notes-fan-out"),
      );

      const result = await commitPlanApprovalCheckpoint({
        session,
        repository,
        cwd,
        planPath: "/plans/phase-21.md",
        approvalSource: approvalSource === "Autopilot" ? "agent" : "user",
        reconcileLifecycle: (signal) => approvalLifecycle.enqueue(signal),
        prepareFreshSession: async () => {
          fixture.events.push(`${approvalSource}-approval`);
          await session.newSession(true);
          return 3;
        },
        onSnapshot: () => fixture.events.push("unexpected-direct-approval-fan-out"),
      });

      expect(result.planTotal).toBe(3);
      expect(fixture.events.slice(-4)).toEqual([
        `${approvalSource}-approval`,
        "fresh-session:true",
        "stage-persisted",
        "approval-notes-fan-out",
      ]);
      expect(session.activeContext).toMatchObject({
        executionStage: "implementing",
        approvedPlanPath: "/plans/phase-21.md",
      });
      expect(await repository.load(cwd)).toMatchObject({
        status: "ok",
        snapshot: {
          document: {
            phases: [
              {
                status: "in-progress",
                session: {
                  sessionId: session.state.sessionId,
                  sessionPath: session.state.sessionPath,
                },
                lifecycleEvents: expect.arrayContaining([
                  expect.objectContaining({
                    toStatus: "in-progress",
                    source: approvalSource === "Autopilot" ? "agent" : "user",
                    reason:
                      approvalSource === "Autopilot"
                        ? "Plan approved by Autopilot"
                        : "Plan approved by user",
                  }),
                ]),
              },
            ],
          },
        },
      });
    },
  );

  it("persists plan approval as the pending automatic target while a user override is active", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd);
    await fixture.start();
    await fixture.promptSettled;
    await updatePhase(repository, cwd, (notes) => {
      const phase = notes.phases[0]!;
      phase.overrides.status = {
        value: phase.status,
        source: "user",
        updatedAt: phase.updatedAt,
      };
    });
    const session = fixture.currentSession;
    const snapshots: ProjectNotesSnapshot[] = [];
    const approvalLifecycle = createApprovalLifecycle(repository, cwd, session, (snapshot) =>
      snapshots.push(snapshot),
    );

    await commitPlanApprovalCheckpoint({
      session,
      repository,
      cwd,
      planPath: "/plans/phase-21.md",
      approvalSource: "user",
      reconcileLifecycle: (signal) => approvalLifecycle.enqueue(signal),
      prepareFreshSession: async () => {
        await session.newSession(true);
        return 3;
      },
      onSnapshot: () => {
        throw new Error(
          "manual override persistence must fan out through lifecycle reconciliation",
        );
      },
    });

    const loaded = await repository.load(cwd);
    expect(loaded).toMatchObject({
      status: "ok",
      snapshot: {
        document: {
          phases: [
            {
              status: "planning",
              overrides: { status: { value: "planning", source: "user" } },
              pendingAutomaticLifecycleTransition: {
                status: "in-progress",
                source: "user",
                reason: "Plan approved by user",
                kind: "approval-resolved",
                expectedSession: {
                  sessionId: session.state.sessionId,
                  sessionPath: session.state.sessionPath,
                },
              },
            },
          ],
        },
      },
    });
    expect(snapshots).toHaveLength(1);
    if (loaded.status !== "ok") throw new Error("Expected pending approval Notes");
    expect(snapshots[0]).toEqual(loaded.snapshot);
  });

  it("disposes a retained candidate when retry discovers a phase archive", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd, { failBindingCount: 1 });
    await fixture.start();
    const stale = fixture.createdSessions[0]!;
    await updatePhase(repository, cwd, (notes) => {
      notes.phases[0]!.archivedAt = NOW;
    });

    await expect(fixture.start()).resolves.toMatchObject({
      status: 409,
      body: { code: "phase-archived" },
    });
    expect(stale.disposeCalls).toBe(1);
    expect(fixture.candidates.has("phase-21")).toBe(false);
    await fixture.dispose();
    expect(stale.disposeCalls).toBe(1);
  });

  it("disposes a stale candidate when another window completes the phase before Start", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd);
    const staleCandidate = new FakePhaseSession(99, fixture.events);
    await fixture.candidates.add("phase-21", {
      session: staleCandidate,
      initialPrompt: "stale prompt",
      tokenCount: 1,
    });
    await updatePhase(repository, cwd, (notes) => {
      const phase = notes.phases[0]!;
      phase.status = "done";
      phase.completedAt = NOW;
      phase.overrides.status = null;
      phase.lifecycleEvents.push({
        id: "event-done",
        fromStatus: "not-started",
        toStatus: "done",
        source: "user",
        timestamp: NOW,
        reason: "Completion review accepted",
        kind: "other",
      });
    });
    const beforeStart = await repository.load(cwd);
    if (beforeStart.status !== "ok") throw new Error("Expected completed phase");

    await expect(fixture.start()).resolves.toEqual({
      status: 409,
      body: {
        status: "failed",
        code: "phase-inactive",
        operationId: "operation-1",
        message: "This phase is already Done. Reopen Roadmap to review its completion evidence.",
      },
    });

    expect(fixture.createCalls).toBe(0);
    expect(staleCandidate.disposeCalls).toBe(1);
    expect(fixture.candidates.has("phase-21")).toBe(false);
    expect(fixture.events).not.toContain("session-replaced");
    expect(fixture.events).not.toContain("phase-state-reset");
    expect(fixture.events).not.toContain("session-reset");
    expect(fixture.events).not.toContain("plan-mode");
    expect(fixture.events).not.toContain("prompt-started");
    expect(staleCandidate.promptCalls).toBe(0);
    await expect(repository.load(cwd)).resolves.toMatchObject({
      status: "ok",
      snapshot: {
        revision: beforeStart.snapshot.revision,
        document: { phases: [{ status: "done", session: null }] },
      },
    });
    await fixture.dispose();
    expect(staleCandidate.disposeCalls).toBe(1);
  });

  it("registers roadmap_status for coding, Ken, and Autopilot Ken with production actors", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd);
    await fixture.start();
    await fixture.promptSettled;
    const snapshots: ProjectNotesSnapshot[] = [];
    const projectAutopilot = new AppSidecarProjectAutopilotState();
    const host = roadmapHost(repository, cwd, fixture.reconciliations, projectAutopilot, snapshots);
    const registrations = [
      {
        role: "coding" as const,
        tools: host.createSessionTools("coding", () => fixture.currentSession),
      },
      { role: "ken" as const, tools: host.createSessionTools("ken") },
      { role: "ken-autopilot" as const, tools: host.createSessionTools("ken-autopilot") },
    ];

    expect(
      registrations.map(({ role, tools }) => ({ role, names: tools.map((tool) => tool.name) })),
    ).toEqual([
      { role: "coding", names: ["roadmap_status"] },
      { role: "ken", names: ["roadmap_status"] },
      { role: "ken-autopilot", names: ["roadmap_status"] },
    ]);
    expect(APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES).toContain("roadmap_status");
    await expect(
      executeRoadmap(registrations[0]!.tools[0]!, roadmapInput("coding-update")),
    ).resolves.toMatchObject({ result: "committed" });
    await expect(
      executeRoadmap(
        registrations[1]!.tools[0]!,
        roadmapInput("ken-update", { transition: "blocked", blocker: "Waiting for CI" }),
      ),
    ).resolves.toMatchObject({ result: "committed" });
    await expect(
      executeRoadmap(
        registrations[2]!.tools[0]!,
        roadmapInput("autopilot-update", {
          transition: "review",
          evidence: ["Focused tests passed"],
        }),
      ),
    ).resolves.toMatchObject({ result: "committed" });

    const loaded = await repository.load(cwd);
    expect(loaded).toMatchObject({
      status: "ok",
      snapshot: {
        document: {
          phases: [
            {
              status: "review",
              roadmapEvents: [
                expect.objectContaining({ id: "coding-update", actor: "gg-coder" }),
                expect.objectContaining({ id: "ken-update", actor: "ken" }),
                expect.objectContaining({ id: "autopilot-update", actor: "ken-autopilot" }),
              ],
            },
          ],
        },
      },
    });
    if (loaded.status === "ok") expect(loaded.snapshot.document.phases[0]!.status).not.toBe("done");
    expect(snapshots).toHaveLength(3);
  });

  it("routes typed verification and reviewer-only final decisions through the completion gate", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd);
    await fixture.start();
    await fixture.promptSettled;
    const loaded = await repository.load(cwd);
    if (loaded.status !== "ok") throw new Error("Expected bound phase");
    const bound = loaded.snapshot.document.phases[0]!.session!;
    await repository.recordImplementationCheckpoint(cwd, {
      checkpointId: "checkpoint-final-review",
      phaseId: "phase-21",
      expectedSession: bound,
      planStepTotal: 2,
      completedPlanSteps: [1, 2],
      runOutcome: "succeeded",
      timestamp: "2026-07-26T00:01:00.000Z",
    });
    await repository.recordRoadmapStatusUpdate(cwd, {
      updateId: "verification-final-review",
      phaseId: "phase-21",
      actor: "gg-coder",
      transition: "review",
      progress: "Focused checks passed",
      blocker: null,
      evidence: ["pnpm test passed"],
      verification: "passed",
      verificationReason: null,
      proposedReferences: [],
      timestamp: "2026-07-26T00:02:00.000Z",
      expectedSession: bound,
      requireBoundPhase: true,
      autopilotEnabled: false,
    });
    const snapshots: ProjectNotesSnapshot[] = [];
    const host = new AppSidecarRoadmapToolHost({
      cwd,
      repository,
      reconciliations: fixture.reconciliations,
      projectAutopilot: new AppSidecarProjectAutopilotState(),
      broadcastNotesSnapshot: (snapshot) => snapshots.push(snapshot),
      now: () => "2026-07-26T00:03:00.000Z",
    });
    const finalReview = {
      review_id: "review-final",
      decision: "accepted",
      evidence: ["Ken reviewed all completion gates"],
    };

    await expect(
      executeRoadmap(
        host.createSessionTools("coding", () => fixture.currentSession)[0]!,
        roadmapInput("coder-cannot-review", {
          transition: "review",
          evidence: ["Verification reported"],
          final_review: finalReview,
        }),
      ),
    ).resolves.toEqual({ result: "reviewer-not-authorized", phaseId: "phase-21" });
    const checkpointBlockedHost = new AppSidecarRoadmapToolHost({
      cwd,
      repository,
      canSubmitFinalReview: () => false,
      reconciliations: fixture.reconciliations,
      projectAutopilot: new AppSidecarProjectAutopilotState(),
      broadcastNotesSnapshot: (snapshot) => snapshots.push(snapshot),
      now: () => "2026-07-26T00:03:00.000Z",
    });
    await expect(
      executeRoadmap(
        checkpointBlockedHost.createSessionTools("ken")[0]!,
        roadmapInput("blocked-final-status", {
          transition: "review",
          evidence: ["This evidence must not persist"],
          final_review: { ...finalReview, review_id: "blocked-final-review" },
        }),
      ),
    ).resolves.toEqual({ result: "completion-checkpoint-blocked", phaseId: "phase-21" });
    const afterBlockedCheckpoint = await repository.load(cwd);
    if (afterBlockedCheckpoint.status !== "ok") throw new Error("Expected bound phase");
    expect(afterBlockedCheckpoint.snapshot.document.phases[0]!.roadmapEvents).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "blocked-final-status" }),
        expect.objectContaining({ id: "blocked-final-review" }),
      ]),
    );
    expect(snapshots).toEqual([]);

    await expect(
      executeRoadmap(
        host.createSessionTools("ken")[0]!,
        roadmapInput("ken-final-status", {
          transition: "review",
          evidence: ["Ken reviewed the phase"],
          final_review: finalReview,
        }),
      ),
    ).resolves.toMatchObject({
      result: "completion-review-committed",
      gateOutcome: "done",
      unmetGateCodes: [],
    });
    const completed = await repository.load(cwd);
    expect(completed).toMatchObject({
      status: "ok",
      snapshot: { document: { phases: [{ status: "done", archivedAt: null }] } },
    });
    expect(snapshots).toHaveLength(1);
    if (completed.status !== "ok") throw new Error("Expected completed phase");
    expect(completed.snapshot.document.phases[0]!.roadmapEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "ken-final-status", statusOutcome: "evidence-only" }),
        expect.objectContaining({ id: "review-final", type: "completion-review" }),
      ]),
    );
  });

  it("forwards manual-review proposals for committed and duplicate final reviews", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd);
    await fixture.start();
    await fixture.promptSettled;
    const snapshots: ProjectNotesSnapshot[] = [];
    const host = new AppSidecarRoadmapToolHost({
      cwd,
      repository,
      reconciliations: fixture.reconciliations,
      projectAutopilot: new AppSidecarProjectAutopilotState(),
      broadcastNotesSnapshot: (snapshot) => snapshots.push(snapshot),
      now: () => "2026-07-26T00:03:00.000Z",
    });
    const tool = host.createSessionTools("ken")[0]!;
    const input = roadmapInput("manual-final-status", {
      transition: "review",
      evidence: ["Ken reviewed the manual reference proposal"],
      proposed_references: [
        {
          provider: "github",
          canonical_url: "https://github.com/acme/repo/blob/main/src/manual.ts",
          owner: "acme",
          repo: "repo",
          relevance: "Manual review source",
        },
      ],
      final_review: {
        review_id: "manual-final-review",
        decision: "accepted",
        evidence: ["Ken reviewed the completion evidence"],
      },
    });

    const committed = await executeRoadmap(tool, input);
    expect(committed).toMatchObject({
      result: "completion-review-committed",
      statusOutcome: "evidence-only",
      proposals: [
        {
          proposalId: expect.any(String),
          outcome: "pending",
          policyOutcome: "manual-review",
          referenceId: null,
        },
      ],
    });
    expect(committed).not.toHaveProperty("statusUpdate");
    await expect(executeRoadmap(tool, input)).resolves.toEqual({
      ...committed,
      result: "completion-review-duplicate",
    });
    expect(snapshots).toHaveLength(1);
  });

  it("forwards Autopilot accepted and reused proposals for committed and duplicate final reviews", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd);
    await fixture.start();
    await fixture.promptSettled;
    const snapshots: ProjectNotesSnapshot[] = [];
    const projectAutopilot = new AppSidecarProjectAutopilotState();
    projectAutopilot.set(cwd, true);
    const host = new AppSidecarRoadmapToolHost({
      cwd,
      repository,
      reconciliations: fixture.reconciliations,
      projectAutopilot,
      broadcastNotesSnapshot: (snapshot) => snapshots.push(snapshot),
      now: () => "2026-07-26T00:03:00.000Z",
    });
    const tool = host.createSessionTools("ken-autopilot")[0]!;
    const input = roadmapInput("autopilot-final-status", {
      transition: "review",
      evidence: ["Autopilot reviewed both reference proposals"],
      proposed_references: [
        {
          provider: "github",
          canonical_url: "https://github.com/acme/repo/blob/main/src/autopilot.ts",
          owner: "acme",
          repo: "repo",
          relevance: "New Autopilot source",
        },
        {
          provider: "github",
          tool: "searchCode",
          canonical_url: "https://github.com/acme/repo/blob/main/src/phase.ts#L1-L2",
          owner: "acme",
          repo: "repo",
          revision: "main",
          path: "src/phase.ts",
          range: { start_line: 1, end_line: 2 },
          query: "launchPhase(",
          anchor: "launchPhase",
          relevance: "Existing phase source",
        },
      ],
      final_review: {
        review_id: "autopilot-final-review",
        decision: "accepted",
        evidence: ["Autopilot accepted the completion evidence"],
      },
    });

    const committed = await executeRoadmap(tool, input);
    expect(committed).toMatchObject({
      result: "completion-review-committed",
      statusOutcome: "evidence-only",
      proposals: [
        {
          proposalId: expect.any(String),
          outcome: "accepted",
          policyOutcome: "accepted",
          referenceId: expect.any(String),
        },
        {
          proposalId: expect.any(String),
          outcome: "reused",
          policyOutcome: "reused",
          referenceId: "ref-1",
        },
      ],
    });
    expect(committed).not.toHaveProperty("statusUpdate");
    await expect(executeRoadmap(tool, input)).resolves.toEqual({
      ...committed,
      result: "completion-review-duplicate",
    });
    expect(snapshots).toHaveLength(1);
  });

  it("keeps roadmap_status out of ordinary CLI createTools", async () => {
    const { cwd } = await setup();
    const created = await createTools(cwd, { lspDiagnostics: false });
    try {
      expect(created.tools.map((tool) => tool.name)).not.toContain("roadmap_status");
    } finally {
      created.processManager.shutdownAll();
    }
  });

  it("enforces the coding session's active phase and durable session binding", async () => {
    const { repository, cwd } = await setup();
    const fixture = new ProductionPhaseFixture(repository, cwd);
    await fixture.start();
    await fixture.promptSettled;
    const snapshots: ProjectNotesSnapshot[] = [];
    const host = roadmapHost(
      repository,
      cwd,
      fixture.reconciliations,
      new AppSidecarProjectAutopilotState(),
      snapshots,
    );
    const unboundSession = new FakePhaseSession(90, []);
    const unboundTool = host.createSessionTools("coding", () => unboundSession)[0]!;
    const codingTool = host.createSessionTools("coding", () => fixture.currentSession)[0]!;

    await expect(executeRoadmap(unboundTool, roadmapInput("no-active-phase"))).resolves.toEqual({
      result: "phase-not-bound",
      phaseId: "phase-21",
    });
    await expect(
      executeRoadmap(codingTool, roadmapInput("wrong-active-phase", { phase_id: "phase-other" })),
    ).resolves.toEqual({ result: "phase-not-bound", phaseId: "phase-other" });

    await updatePhase(repository, cwd, (notes) => {
      notes.phases[0]!.session = {
        sessionId: "replacement-owner",
        sessionPath: "/sessions/replacement-owner.jsonl",
      };
    });
    await expect(executeRoadmap(codingTool, roadmapInput("stale-session"))).resolves.toEqual({
      result: "stale-session",
      phaseId: "phase-21",
    });
    expect(snapshots).toEqual([]);
  });

  it("fans out exactly once for a commit and never for duplicate or conflicting calls", async () => {
    const { repository, cwd } = await setup();
    const reconciliations = new AppSidecarRoadmapReconciliationCoordinator(
      () => "status-operation",
    );
    const snapshots: ProjectNotesSnapshot[] = [];
    const host = roadmapHost(
      repository,
      cwd,
      reconciliations,
      new AppSidecarProjectAutopilotState(),
      snapshots,
    );
    const tool = host.createSessionTools("ken")[0]!;
    const input = roadmapInput("stable-update");

    await expect(executeRoadmap(tool, input)).resolves.toMatchObject({ result: "committed" });
    expect(snapshots).toHaveLength(1);
    await expect(executeRoadmap(tool, input)).resolves.toMatchObject({ result: "duplicate" });
    expect(snapshots).toHaveLength(1);
    await expect(
      executeRoadmap(tool, roadmapInput("stable-update", { progress: "Conflicting payload" })),
    ).resolves.toMatchObject({ result: "duplicate-id-conflict" });
    expect(snapshots).toHaveLength(1);

    const owner = reconciliations.tryAcquire(cwd, "phase-start")!;
    await expect(executeRoadmap(tool, roadmapInput("lease-conflict"))).resolves.toEqual({
      result: "reconciliation-in-progress",
      phaseId: "phase-21",
      owner: { operationId: "status-operation", kind: "phase-start" },
    });
    owner.release();
    expect(snapshots).toHaveLength(1);
  });

  it("shares one project lease between launch and roadmap_status in both directions", async () => {
    const first = await setup();
    const launchGate = deferred();
    const launchFixture = new ProductionPhaseFixture(first.repository, first.cwd, {
      pauseBinding: launchGate,
    });
    const launchSnapshots: ProjectNotesSnapshot[] = [];
    const launchHost = roadmapHost(
      first.repository,
      first.cwd,
      launchFixture.reconciliations,
      new AppSidecarProjectAutopilotState(),
      launchSnapshots,
    );
    const launch = launchFixture.start();
    await viWaitFor(() => launchFixture.candidates.has("phase-21"));

    await expect(
      executeRoadmap(launchHost.createSessionTools("ken")[0]!, roadmapInput("during-launch")),
    ).resolves.toMatchObject({
      result: "reconciliation-in-progress",
      owner: { kind: "phase-start" },
    });
    expect(launchSnapshots).toEqual([]);
    launchGate.resolve();
    await expect(launch).resolves.toMatchObject({ status: 202 });
    await launchFixture.promptSettled;

    const second = await setup();
    const updateGate = deferred();
    const updateEntered = deferred();
    const updateFixture = new ProductionPhaseFixture(second.repository, second.cwd);
    const pausingRepository = {
      recordRoadmapStatusUpdate: async (
        ...args: Parameters<ProjectNotesRepository["recordRoadmapStatusUpdate"]>
      ) => {
        updateEntered.resolve();
        await updateGate.promise;
        return second.repository.recordRoadmapStatusUpdate(...args);
      },
      recordRoadmapFinalReview: vi.fn(async () => {
        throw new Error("Final review is not used by this status-only fixture.");
      }),
    };
    const updateHost = roadmapHost(
      pausingRepository,
      second.cwd,
      updateFixture.reconciliations,
      new AppSidecarProjectAutopilotState(),
      [],
    );
    const update = executeRoadmap(
      updateHost.createSessionTools("ken")[0]!,
      roadmapInput("before-launch"),
    );
    await updateEntered.promise;

    await expect(updateFixture.start()).resolves.toMatchObject({
      status: 409,
      body: { status: "failed", code: "reconciliation-in-progress" },
    });
    expect(updateFixture.createCalls).toBe(0);
    updateGate.resolve();
    await expect(update).resolves.toMatchObject({ result: "committed" });
  });

  it("serializes update-versus-update and releases the lease after the winner", async () => {
    const { repository, cwd } = await setup();
    const gate = deferred();
    const entered = deferred();
    const reconciliations = new AppSidecarRoadmapReconciliationCoordinator();
    const pausingRepository = {
      recordRoadmapStatusUpdate: async (
        ...args: Parameters<ProjectNotesRepository["recordRoadmapStatusUpdate"]>
      ) => {
        entered.resolve();
        await gate.promise;
        return repository.recordRoadmapStatusUpdate(...args);
      },
      recordRoadmapFinalReview: vi.fn(async () => {
        throw new Error("Final review is not used by this status-only fixture.");
      }),
    };
    const host = roadmapHost(
      pausingRepository,
      cwd,
      reconciliations,
      new AppSidecarProjectAutopilotState(),
      [],
    );
    const first = executeRoadmap(host.createSessionTools("ken")[0]!, roadmapInput("update-winner"));
    await entered.promise;

    await expect(
      executeRoadmap(host.createSessionTools("ken-autopilot")[0]!, roadmapInput("update-loser")),
    ).resolves.toMatchObject({
      result: "reconciliation-in-progress",
      owner: { kind: "status-update" },
    });
    gate.resolve();
    await expect(first).resolves.toMatchObject({ result: "committed" });
    await expect(
      executeRoadmap(host.createSessionTools("ken-autopilot")[0]!, roadmapInput("update-retry")),
    ).resolves.toMatchObject({ result: "committed" });
  });

  it("reads live Autopilot policy and preserves overrides, malformed-call silence, and no Done path", async () => {
    const { repository, cwd } = await setup();
    await updatePhase(repository, cwd, (notes) => {
      notes.phases[0]!.overrides.status = {
        value: "not-started",
        source: "user",
        updatedAt: NOW,
      };
    });
    const projectAutopilot = new AppSidecarProjectAutopilotState();
    await projectAutopilot.initialize(cwd, async () => false);
    const snapshots: ProjectNotesSnapshot[] = [];
    const host = roadmapHost(
      repository,
      cwd,
      new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot,
      snapshots,
    );
    const tool = host.createSessionTools("ken-autopilot")[0]!;

    await expect(
      executeRoadmap(
        tool,
        roadmapInput("manual-override", { transition: "blocked", blocker: "User owns status" }),
      ),
    ).resolves.toMatchObject({ result: "committed", statusOutcome: "manual-override" });
    const reference = {
      provider: "github",
      canonical_url: "https://github.com/acme/repo/blob/main/src/phase.ts#L1",
      owner: "acme",
      repo: "repo",
      relevance: "Phase implementation",
    };
    await expect(
      executeRoadmap(tool, roadmapInput("manual-policy", { proposed_references: [reference] })),
    ).resolves.toMatchObject({
      result: "committed",
      proposals: [{ outcome: "pending", policyOutcome: "manual-review" }],
    });

    projectAutopilot.set(cwd, true);
    await expect(
      executeRoadmap(
        tool,
        roadmapInput("autopilot-policy", {
          proposed_references: [
            {
              ...reference,
              canonical_url: "https://github.com/acme/repo/blob/main/src/phase.ts#L2",
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      result: "committed",
      proposals: [{ outcome: "accepted", policyOutcome: "accepted" }],
    });
    expect(snapshots).toHaveLength(3);

    await expect(
      executeRoadmap(
        tool,
        roadmapInput("malformed-reference", {
          proposed_references: [{ ...reference, canonical_url: "not a URL" }],
        }),
      ),
    ).resolves.toMatchObject({ result: "invalid-reference" });
    expect(snapshots).toHaveLength(3);

    const loaded = await repository.load(cwd);
    expect(loaded).toMatchObject({
      status: "ok",
      snapshot: { document: { phases: [{ status: "not-started" }] } },
    });
    if (loaded.status === "ok") {
      const phase = loaded.snapshot.document.phases[0]!;
      expect(phase.status).not.toBe("done");
      expect(
        phase.roadmapEvents
          .filter((event) => event.type === "status-update")
          .map((event) => event.transition),
      ).not.toContain("done");
    }
  });
});

async function viWaitFor(assertion: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("phase candidate ownership", () => {
  it("settles every remaining disposal even when one candidate throws", async () => {
    const calls = [0, 0];
    const candidates = new AppSidecarPhaseCandidateStore<{
      session: { dispose: () => void };
    }>();
    await candidates.add("phase-a", {
      session: {
        dispose: () => {
          calls[0] += 1;
          throw new Error("dispose failed");
        },
      },
    });
    await candidates.add("phase-b", {
      session: {
        dispose: () => {
          calls[1] += 1;
        },
      },
    });

    await expect(candidates.dispose()).resolves.toBeUndefined();

    expect(calls).toEqual([1, 1]);
  });
});
