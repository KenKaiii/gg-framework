import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  NOTES_COMPLETION_GATE_OUTCOMES,
  NOTES_COMPLETION_UNMET_GATE_CODES,
  NOTES_IMPLEMENTATION_RUN_OUTCOMES,
  NOTES_LIFECYCLE_EVENT_SOURCES,
  NOTES_PHASE_STATUSES,
  NOTES_ROADMAP_REFERENCE_POLICY_OUTCOMES,
  canonicalProjectKey,
  canonicalReferenceIdentity,
  classifyLegacyNotesLifecycleEvent,
  isNotesCompletionGateOutcome,
  isNotesCompletionUnmetGateCode,
  isNotesDocumentV2,
  isNotesDocumentV3,
  isNotesImplementationRunOutcome,
  isNotesLifecycleEventSource,
  isNotesPhaseStatus,
  isNotesRoadmapReferencePolicyOutcome,
  isNotesSessionLink,
  isNullableNotesSessionLink,
  isValidNotesReminderDeliveryPair,
  migrateNotesDocumentV2,
  migrateNotesDocumentV3PhaseShape,
  normalizeCanonicalUrl,
  notesAutomaticStatusAfterOverrideReset,
  notesPhaseStatusForRoadmapTransition,
  NOTES_REFERENCE_METADATA_FIELDS,
  NOTES_REFERENCE_METADATA_MAX_LENGTH,
  NOTES_REFERENCE_URL_MAX_LENGTH,
  NOTES_REMINDER_NOTE_MAX_LENGTH,
  validateNotesCompletionReviewFields,
  validateNotesDocumentV3,
  validateNotesImplementationCheckpointFields,
  validateNotesReferenceProjection,
  validateNotesSessionLink,
  type NotesDocumentV2,
  type NotesDocumentV3,
  type NotesPhase,
  type NotesPhaseStatus,
  type NotesRoadmapStatusUpdate,
  type NotesRoadmapTransition,
  type NotesRoadmapStatusOutcome,
  type NotesSessionLink,
} from "./project-notes.js";

const NOW = "2026-07-25T12:34:56.000Z";
const CURRENT_SESSION = { sessionId: "session-current", sessionPath: "/sessions/current.jsonl" };

function protectedStatusReport(
  id: string,
  transition: NotesRoadmapTransition,
  statusOutcome: Extract<NotesRoadmapStatusOutcome, "manual-override" | "done-terminal">,
): NotesRoadmapStatusUpdate {
  return {
    type: "status-update",
    id,
    actor: "gg-coder",
    transition,
    progress: "Protected automatic status report",
    blocker: transition === "blocked" ? "Waiting for verification" : null,
    evidence: [],
    verification: null,
    verificationReason: null,
    verificationSession: null,
    statusOutcome,
    proposedReferences: [],
    timestamp: NOW,
  };
}

function pendingAutomaticStatus(
  status: Exclude<NotesPhaseStatus, "not-started" | "done">,
  expectedSession: NotesSessionLink | null,
): NotesPhase["pendingAutomaticLifecycleTransition"] {
  return {
    status,
    source: "agent",
    reason: "Protected lifecycle transition",
    kind: "other",
    timestamp: NOW,
    expectedSession,
  };
}

async function fixture(): Promise<NotesDocumentV3> {
  return JSON.parse(
    await fs.readFile(new URL("../../../fixtures/project-notes-v3.json", import.meta.url), "utf8"),
  ) as NotesDocumentV3;
}

function legacyV2(): NotesDocumentV2 {
  return {
    version: 2,
    reference: "legacy",
    currentFocus: "Migrate Notes",
    tasks: [
      {
        id: "",
        text: "Empty ID",
        status: "todo",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
      },
      {
        id: "duplicate",
        text: "First duplicate",
        status: "todo",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
      },
      {
        id: "duplicate",
        text: "Second duplicate",
        status: "done",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: NOW,
        archivedAt: null,
      },
    ],
    handoff: { text: "Continue", updatedAt: NOW, readAt: null },
    updatedAt: NOW,
    legacyImportedAt: null,
  };
}

function expectError(value: unknown, path: string, message?: string): void {
  const result = validateNotesDocumentV3(value);
  expect(result).toMatchObject({
    ok: false,
    error: { path, ...(message === undefined ? {} : { message }) },
  });
}

describe("project Notes contract", () => {
  it.each([
    ["pending", "planning"],
    ["in-progress", "in-progress"],
    ["blocked", "needs-attention"],
    ["review", "review"],
  ] as const)("maps the %s roadmap transition to %s", (transition, status) => {
    expect(notesPhaseStatusForRoadmapTransition(transition)).toBe(status);
  });

  it.each([
    {
      name: "keeps Done terminal",
      arrange(phase: NotesPhase) {
        phase.status = "done";
        phase.pendingAutomaticLifecycleTransition = pendingAutomaticStatus("review", {
          ...CURRENT_SESSION,
        });
        phase.roadmapEvents = [protectedStatusReport("blocked", "blocked", "manual-override")];
      },
      expected: "done",
    },
    {
      name: "applies a pending transition for the matching session",
      arrange(phase: NotesPhase) {
        phase.pendingAutomaticLifecycleTransition = pendingAutomaticStatus("review", {
          ...CURRENT_SESSION,
        });
        phase.roadmapEvents = [
          protectedStatusReport("older-protected", "blocked", "manual-override"),
        ];
      },
      expected: "review",
    },
    {
      name: "ignores a pending transition for a stale session path",
      arrange(phase: NotesPhase) {
        phase.status = "planning";
        phase.pendingAutomaticLifecycleTransition = pendingAutomaticStatus("review", {
          sessionId: CURRENT_SESSION.sessionId,
          sessionPath: "/sessions/stale.jsonl",
        });
      },
      expected: "planning",
    },
    {
      name: "uses the latest protected manual report",
      arrange(phase: NotesPhase) {
        phase.roadmapEvents = [
          protectedStatusReport("older-protected", "pending", "manual-override"),
          protectedStatusReport("latest-protected", "review", "manual-override"),
          {
            ...protectedStatusReport("newer-unprotected", "blocked", "manual-override"),
            statusOutcome: "same-status",
          },
        ];
      },
      expected: "review",
    },
    {
      name: "uses a protected done-terminal report",
      arrange(phase: NotesPhase) {
        phase.roadmapEvents = [protectedStatusReport("done-terminal", "pending", "done-terminal")];
      },
      expected: "planning",
    },
    {
      name: "maps a protected blocked transition to Needs attention",
      arrange(phase: NotesPhase) {
        phase.roadmapEvents = [protectedStatusReport("blocked", "blocked", "manual-override")];
      },
      expected: "needs-attention",
    },
    {
      name: "falls back to the current status",
      arrange(phase: NotesPhase) {
        phase.status = "cancelled";
      },
      expected: "cancelled",
    },
  ] satisfies Array<{
    name: string;
    arrange(phase: NotesPhase): void;
    expected: NotesPhaseStatus;
  }>)("restores automatic status: $name", async ({ arrange, expected }) => {
    const document = await fixture();
    const phase = document.phases[0]!;
    phase.status = "in-progress";
    phase.session = { ...CURRENT_SESSION };
    phase.pendingAutomaticLifecycleTransition = null;
    phase.roadmapEvents = [];
    arrange(phase);

    expect(notesAutomaticStatusAfterOverrideReset(phase)).toBe(expected);
  });

  it.each([
    [NOTES_PHASE_STATUSES, isNotesPhaseStatus],
    [NOTES_LIFECYCLE_EVENT_SOURCES, isNotesLifecycleEventSource],
    [NOTES_IMPLEMENTATION_RUN_OUTCOMES, isNotesImplementationRunOutcome],
    [NOTES_COMPLETION_GATE_OUTCOMES, isNotesCompletionGateOutcome],
    [NOTES_COMPLETION_UNMET_GATE_CODES, isNotesCompletionUnmetGateCode],
    [NOTES_ROADMAP_REFERENCE_POLICY_OUTCOMES, isNotesRoadmapReferencePolicyOutcome],
  ] as const)("derives every runtime guard from its canonical tuple", (values, guard) => {
    expect(values.every((value) => guard(value))).toBe(true);
    expect(guard("not-a-notes-value")).toBe(false);
  });

  it("shares checkpoint and completion-review field semantics", () => {
    expect(
      validateNotesImplementationCheckpointFields({
        planStepTotal: 3,
        completedPlanSteps: [1, 3, 2],
        runOutcome: "succeeded",
      }),
    ).toEqual({ field: "completedPlanSteps", code: "invalid-step", index: 2 });
    expect(
      validateNotesImplementationCheckpointFields({
        planStepTotal: 3,
        completedPlanSteps: [1, 2, 3],
        runOutcome: "succeeded",
      }),
    ).toBeNull();
    expect(
      validateNotesCompletionReviewFields({
        decision: "accepted",
        evidence: [],
        reason: null,
      }),
    ).toEqual({ field: "evidence", code: "accepted-requires-evidence" });
    expect(
      validateNotesCompletionReviewFields({
        decision: "rejected",
        evidence: [],
        reason: "Needs another pass",
      }),
    ).toBeNull();
  });
  it.each([
    ["C:\\Work\\.\\App\\..\\Project\\", "c:/work/project"],
    ["C:/../Project", "c:/project"],
    ["\\\\Server\\Share\\Folder\\..\\Project", "//server/share/project"],
    ["/Work/./App/../Project/", "/Work/Project"],
    ["/work/../../project", "/project"],
    ["work/../../project", "../project"],
    ["", "."],
  ])("canonicalizes project path %s", (cwd, expected) => {
    expect(canonicalProjectKey(cwd)).toBe(expected);
  });

  it("folds Windows path case while preserving POSIX path case", () => {
    expect(canonicalProjectKey("C:/WORK/PROJECT")).toBe(canonicalProjectKey("c:\\work\\project"));
    expect(canonicalProjectKey("\\\\SERVER\\SHARE\\PROJECT")).toBe(
      canonicalProjectKey("//server/share/project"),
    );
    expect(canonicalProjectKey("/Work/Project")).not.toBe(canonicalProjectKey("/work/project"));
  });

  it("requires lifecycle event kinds in the current v3 type", () => {
    type CurrentLifecycleEvent = NotesDocumentV3["phases"][number]["lifecycleEvents"][number];
    type KindIsRequired = CurrentLifecycleEvent extends { kind: CurrentLifecycleEvent["kind"] }
      ? true
      : false;
    const kindIsRequired: KindIsRequired = true;

    expect(kindIsRequired).toBe(true);
  });

  it("accepts the canonical fixture without cloning or rewriting it", async () => {
    const document = await fixture();

    expect(validateNotesDocumentV3(document)).toEqual({ ok: true, document });
    expect(isNotesDocumentV3(document)).toBe(true);
    expect(migrateNotesDocumentV3PhaseShape(document)).toEqual({ ok: true, document });
  });

  it("strictly binds pending automatic lifecycle provenance to an active status override", async () => {
    const withoutOverride = await fixture();
    withoutOverride.phases[0]!.overrides.status = null;
    expectError(
      withoutOverride,
      "phases[0].pendingAutomaticLifecycleTransition",
      "requires an active status override",
    );

    const malformedSession = await fixture();
    malformedSession.phases[0]!.pendingAutomaticLifecycleTransition!.expectedSession = {
      sessionId: "session",
      sessionPath: "",
    };
    expectError(
      malformedSession,
      "phases[0].pendingAutomaticLifecycleTransition.expectedSession.sessionPath",
    );

    const incompatibleKind = await fixture();
    incompatibleKind.phases[0]!.pendingAutomaticLifecycleTransition!.kind = "approval-opened";
    expectError(incompatibleKind, "phases[0].pendingAutomaticLifecycleTransition.kind");
  });

  it("validates reference and session projections with the authoritative semantics", async () => {
    const document = await fixture();
    const { capturedAt: _capturedAt, ...projection } = document.references[0]!;

    expect(validateNotesReferenceProjection(projection)).toBeNull();
    expect(validateNotesReferenceProjection({ ...projection, issue: 0 })).toMatchObject({
      path: "reference.issue",
    });
    expect(
      validateNotesReferenceProjection({
        ...projection,
        path: null,
        range: { startLine: 1, endLine: 2 },
      }),
    ).toMatchObject({ path: "reference.path" });
    const completeSession = { sessionId: "session-1", sessionPath: "/session.jsonl" };
    expect(validateNotesSessionLink(completeSession)).toBeNull();
    expect(isNotesSessionLink(completeSession)).toBe(true);
    expect(isNullableNotesSessionLink(completeSession)).toBe(true);
    expect(isNotesSessionLink(null)).toBe(false);
    expect(isNullableNotesSessionLink(null)).toBe(true);

    for (const malformed of [
      { sessionId: "", sessionPath: "/session.jsonl" },
      { sessionId: "   ", sessionPath: "/session.jsonl" },
      { sessionId: "session-1", sessionPath: "" },
      { sessionId: "session-1", sessionPath: " \t " },
      { ...completeSession, extra: true },
    ]) {
      expect(isNotesSessionLink(malformed)).toBe(false);
      expect(isNullableNotesSessionLink(malformed)).toBe(false);
    }
    expect(validateNotesSessionLink({ sessionId: "session-1", sessionPath: "" })).toMatchObject({
      path: "session.sessionPath",
    });
  });

  it.each([
    ["in-app", "not-required"],
    ["native", "granted"],
    ["in-app-fallback", "denied"],
    ["in-app-fallback", "unavailable"],
  ] as const)("accepts the valid %s and %s reminder delivery pair", (channel, permission) => {
    expect(isValidNotesReminderDeliveryPair(channel, permission)).toBe(true);
  });

  it.each([
    ["in-app", "granted"],
    ["native", "denied"],
    ["in-app-fallback", "not-required"],
  ] as const)("rejects the impossible %s and %s reminder delivery pair", (channel, permission) => {
    expect(isValidNotesReminderDeliveryPair(channel, permission)).toBe(false);
  });

  it("rejects impossible current-v3 reminder evidence at its permission path", async () => {
    const document = await fixture();
    document.phases[0]!.reminder!.lastDelivery!.permission = "granted";
    const expected = {
      ok: false as const,
      error: {
        path: "phases[0].reminder.lastDelivery.permission",
        message: "permission does not match delivery channel",
      },
    };

    expect(validateNotesDocumentV3(document)).toEqual(expected);
    expect(migrateNotesDocumentV3PhaseShape(document)).toEqual(expected);
  });
  it("accepts the backend final-review evidence-only status outcome", async () => {
    const document = await fixture();
    const update = document.phases[0]!.roadmapEvents.find(
      (event) => event.type === "status-update",
    )!;
    update.statusOutcome = "evidence-only";

    expect(validateNotesDocumentV3(document)).toEqual({ ok: true, document });
  });

  it("deterministically stabilizes missing and duplicate v2 task IDs", () => {
    const legacy = legacyV2();

    expect(isNotesDocumentV2(legacy)).toBe(true);
    const first = migrateNotesDocumentV2(legacy);
    const second = migrateNotesDocumentV2(structuredClone(legacy));

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      document: {
        version: 3,
        phases: [],
        references: [],
        tasks: [{ id: "legacy-task-1" }, { id: "duplicate" }, { id: "legacy-task-3" }],
      },
    });
  });

  it.each([
    ["waiting-for-approval", "agent", "legacy approval copy", "approval-opened"],
    ["needs-attention", "session", "legacy runtime copy", "attention-runtime-opened"],
    ["needs-attention", "agent", "bash failed: legacy copy", "attention-tool-opened"],
    ["needs-attention", "agent", "legacy question copy", "attention-question-opened"],
    ["needs-attention", "system", "legacy generic copy", "attention-generic-opened"],
    ["in-progress", "user", "Plan approved by user", "approval-resolved"],
    ["in-progress", "agent", "Plan approved by Autopilot", "approval-resolved"],
    ["in-progress", "session", "Implementation run started", "attention-implementation-resolved"],
    [
      "in-progress",
      "session",
      "Implementation session resumed",
      "attention-implementation-resolved",
    ],
    ["review", "session", "Review session resumed", "attention-review-resolved"],
    ["in-progress", "session", "localized new copy", "other"],
  ] as const)(
    "classifies legacy $0/$1 lifecycle copy once as $3",
    (toStatus, source, reason, expected) => {
      expect(classifyLegacyNotesLifecycleEvent({ toStatus, source, reason })).toBe(expected);
    },
  );

  it("migrates every additive legacy-v3 field family and nothing else", async () => {
    const expected = await fixture();
    const legacy = structuredClone(expected) as unknown as {
      phases: Array<Record<string, unknown>>;
    };
    const firstPhase = legacy.phases[0]!;
    const secondPhase = legacy.phases[1]!;
    delete firstPhase.archivedAt;
    delete firstPhase.pendingAutomaticLifecycleTransition;
    delete secondPhase.archivedAt;
    delete secondPhase.pendingAutomaticLifecycleTransition;
    delete secondPhase.roadmapEvents;
    for (const phase of legacy.phases) {
      for (const event of phase.lifecycleEvents as Array<Record<string, unknown>>) {
        delete event.kind;
      }
    }

    const reminder = firstPhase.reminder as Record<string, unknown>;
    delete reminder.occurrenceKey;
    delete reminder.lastDelivery;

    const events = firstPhase.roadmapEvents as Array<Record<string, unknown>>;
    const statusUpdate = events.find((event) => event.type === "status-update")!;
    firstPhase.roadmapEvents = [statusUpdate];
    delete statusUpdate.verification;
    delete statusUpdate.verificationReason;
    delete statusUpdate.verificationSession;
    const source = expected.references[0]!;
    statusUpdate.proposedReferences = [
      {
        provider: source.provider,
        tool: source.tool,
        canonicalUrl: source.canonicalUrl,
        owner: source.owner,
        repo: source.repo,
        revision: source.revision,
        path: source.path,
        range: source.range,
        issue: source.issue,
        pullRequest: source.pullRequest,
        query: source.query,
        anchor: source.anchor,
        relevance: source.relevance,
        id: "legacy-proposal",
        disposition: "pending",
        referenceId: null,
      },
    ];

    const migrated = migrateNotesDocumentV3PhaseShape(legacy);

    expect(migrated).toMatchObject({
      ok: true,
      document: {
        phases: [
          {
            archivedAt: null,
            pendingAutomaticLifecycleTransition: null,
            lifecycleEvents: [
              { kind: "other" },
              { kind: "other" },
              { kind: "attention-question-opened" },
            ],
            reminder: {
              occurrenceKey: "reminder-review-contract",
              lastDelivery: null,
            },
            roadmapEvents: [
              {
                verification: null,
                verificationReason: null,
                verificationSession: null,
                proposedReferences: [{ policyOutcome: "manual-review" }],
              },
            ],
          },
          {
            archivedAt: null,
            pendingAutomaticLifecycleTransition: null,
            lifecycleEvents: [{ kind: "other" }, { kind: "other" }],
            roadmapEvents: [],
          },
        ],
      },
    });
  });

  it("adds only verificationSession to the recognized intermediate status-update shape", async () => {
    const legacy = await fixture();
    const update = legacy.phases[0]!.roadmapEvents.find(
      (event) => event.type === "status-update",
    )! as unknown as Record<string, unknown>;
    legacy.phases[0]!.roadmapEvents = [update as never];
    delete update.verificationSession;

    const migrated = migrateNotesDocumentV3PhaseShape(legacy);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) throw new Error(migrated.error.message);
    expect(migrated.document.phases[0]!.roadmapEvents).toMatchObject([
      { verificationSession: null },
    ]);
  });

  it("does not strip unknown keys from legacy-v3 lookalikes", async () => {
    const legacy = (await fixture()) as unknown as {
      phases: Array<Record<string, unknown>>;
    };
    delete legacy.phases[0]!.archivedAt;
    legacy.phases[0]!.privateState = true;

    const strict = validateNotesDocumentV3(legacy);
    const migrated = migrateNotesDocumentV3PhaseShape(legacy);

    expect(strict).toMatchObject({ ok: false, error: { path: "phases[0]" } });
    expect(migrated).toEqual(strict);
  });

  it.each([
    [
      "task",
      (document: NotesDocumentV3) => Object.assign(document.tasks[0]!, { extra: true }),
      "tasks[0]",
    ],
    [
      "reference range",
      (document: NotesDocumentV3) => Object.assign(document.references[1]!.range!, { extra: true }),
      "references[1].range",
    ],
    [
      "reminder delivery",
      (document: NotesDocumentV3) =>
        Object.assign(document.phases[0]!.reminder!.lastDelivery!, { extra: true }),
      "phases[0].reminder.lastDelivery",
    ],
    [
      "lifecycle event",
      (document: NotesDocumentV3) =>
        Object.assign(document.phases[0]!.lifecycleEvents[0]!, { extra: true }),
      "phases[0].lifecycleEvents[0]",
    ],
    [
      "roadmap event",
      (document: NotesDocumentV3) =>
        Object.assign(document.phases[0]!.roadmapEvents[0]!, { extra: true }),
      "phases[0].roadmapEvents[0]",
    ],
  ])("rejects unknown keys in a nested %s at a stable path", async (_name, mutate, path) => {
    const document = await fixture();
    mutate(document);
    expectError(document, path);
  });

  it("normalizes URL identity while preserving path, query, and fragment", () => {
    expect(normalizeCanonicalUrl("HTTPS://EXAMPLE.COM:443/a/b/?q=A#L2")).toBe(
      "https://example.com/a/b?q=A#L2",
    );
    expect(normalizeCanonicalUrl("ftp://example.com/a")).toBeNull();
    expect(normalizeCanonicalUrl("https://user@example.com/a")).toBeNull();
    expect(
      canonicalReferenceIdentity({
        provider: " GitHub ",
        canonicalUrl: "HTTPS://GITHUB.COM:443/owner/repo/",
      }),
    ).toBe("github\nhttps://github.com/owner/repo");
  });

  it.each(NOTES_REFERENCE_METADATA_FIELDS)("enforces the metadata limit for %s", async (field) => {
    const exact = await fixture();
    exact.references[0] = {
      ...exact.references[0]!,
      provider: "example",
      [field]: "x".repeat(NOTES_REFERENCE_METADATA_MAX_LENGTH),
    };
    const oversized = structuredClone(exact);
    oversized.references[0] = {
      ...oversized.references[0]!,
      [field]: "x".repeat(NOTES_REFERENCE_METADATA_MAX_LENGTH + 1),
    };

    expect(validateNotesDocumentV3(exact).ok).toBe(true);
    expectError(oversized, `references[0].${field}`);
  });

  it("enforces URL and reminder limits", async () => {
    const prefix = "https://example.com/";
    const exactUrl = `${prefix}${"x".repeat(NOTES_REFERENCE_URL_MAX_LENGTH - prefix.length)}`;
    const exact = await fixture();
    exact.references[0] = { ...exact.references[0]!, provider: "example", canonicalUrl: exactUrl };
    exact.phases[0]!.reminder!.note = "x".repeat(NOTES_REMINDER_NOTE_MAX_LENGTH);
    expect(validateNotesDocumentV3(exact).ok).toBe(true);

    const longUrl = structuredClone(exact);
    longUrl.references[0]!.canonicalUrl += "x";
    expectError(longUrl, "references[0].canonicalUrl");

    const longNote = structuredClone(exact);
    longNote.phases[0]!.reminder!.note += "x";
    expectError(longNote, "phases[0].reminder.note");
  });

  it("rejects duplicate task, phase, reference IDs, and canonical identities", async () => {
    const duplicateTask = await fixture();
    duplicateTask.tasks[1]!.id = duplicateTask.tasks[0]!.id;
    expectError(duplicateTask, "tasks[1].id");

    const duplicatePhase = await fixture();
    duplicatePhase.phases[1]!.id = duplicatePhase.phases[0]!.id;
    expectError(duplicatePhase, "phases[1].id");

    const duplicateReferenceId = await fixture();
    duplicateReferenceId.references[1]!.id = duplicateReferenceId.references[0]!.id;
    expectError(duplicateReferenceId, "references[1].id");

    const duplicateIdentity = await fixture();
    duplicateIdentity.references[1] = {
      ...duplicateIdentity.references[0]!,
      id: "duplicate-source",
      provider: " GitHub ",
      canonicalUrl: `${duplicateIdentity.references[0]!.canonicalUrl}/`,
    };
    expectError(duplicateIdentity, "references[1].canonicalUrl");
  });

  it.each([
    {
      field: "id" as const,
      duplicateValue: "reminder-review-contract",
      uniqueValue: "occurrence-second-reminder",
      path: "phases[1].reminder.id",
      message: "duplicate reminder ID; already used at phases[0].reminder.id",
    },
    {
      field: "occurrenceKey" as const,
      duplicateValue: "occurrence-review-contract",
      uniqueValue: "reminder-second-reminder",
      path: "phases[1].reminder.occurrenceKey",
      message: "duplicate occurrence key; already used at phases[0].reminder.occurrenceKey",
    },
  ])(
    "rejects a document-wide duplicate reminder $field at its duplicate path",
    async (testCase) => {
      const document = await fixture();
      const firstReminder = document.phases[0]!.reminder!;
      document.phases[1]!.reminder = {
        ...firstReminder,
        id: testCase.field === "id" ? testCase.duplicateValue : testCase.uniqueValue,
        occurrenceKey:
          testCase.field === "occurrenceKey" ? testCase.duplicateValue : testCase.uniqueValue,
        lastDelivery: null,
      };

      expectError(document, testCase.path, testCase.message);
    },
  );

  it("enforces lifecycle and roadmap chronology", async () => {
    const lifecycle = await fixture();
    lifecycle.phases[0]!.lifecycleEvents[1]!.timestamp = "2026-07-22T00:00:00.000Z";
    expectError(
      lifecycle,
      "phases[0].lifecycleEvents[1].timestamp",
      "events must be chronological",
    );

    const roadmap = await fixture();
    roadmap.phases[0]!.roadmapEvents[1]!.timestamp = "2026-07-24T00:00:00.000Z";
    expectError(roadmap, "phases[0].roadmapEvents[1].timestamp", "events must be chronological");
  });

  it.each([
    [
      "failed run",
      (document: NotesDocumentV3) => {
        const checkpoint = document.phases[0]!.roadmapEvents.find(
          (event) => event.type === "implementation-checkpoint",
        )!;
        checkpoint.runOutcome = "failed";
      },
    ],
    [
      "incomplete plan",
      (document: NotesDocumentV3) => {
        const checkpoint = document.phases[0]!.roadmapEvents.find(
          (event) => event.type === "implementation-checkpoint",
        )!;
        checkpoint.completedPlanSteps = [1, 2];
      },
    ],
    [
      "failed verification",
      (document: NotesDocumentV3) => {
        const update = document.phases[0]!.roadmapEvents.find(
          (event) => event.type === "status-update",
        )!;
        update.verification = "failed";
        update.verificationReason = "Focused verification failed";
      },
    ],
    [
      "unaccepted exception",
      (document: NotesDocumentV3) => {
        const update = document.phases[0]!.roadmapEvents.find(
          (event) => event.type === "status-update",
        )!;
        update.verification = "exception-requested";
        update.verificationReason = "Needs reviewer acceptance";
      },
    ],
    [
      "different verification session",
      (document: NotesDocumentV3) => {
        const update = document.phases[0]!.roadmapEvents.find(
          (event) => event.type === "status-update",
        )!;
        update.verificationSession = { sessionId: "other", sessionPath: "/sessions/other.jsonl" };
      },
    ],
  ])("rejects Done when the completion gate has a %s", async (_name, mutate) => {
    const document = await fixture();
    mutate(document);
    expectError(document, "phases[0].roadmapEvents[2]");
  });

  it("rejects Done when matching completion evidence belongs to a prior phase session", async () => {
    const document = await fixture();
    document.phases[0]!.session = {
      sessionId: "replacement-session",
      sessionPath: "/sessions/replacement.jsonl",
    };

    expectError(
      document,
      "phases[0].roadmapEvents[2]",
      "Done requires accepted review evidence, a successful complete implementation checkpoint, passed verification or an accepted verification exception, evidence matching the current phase session, and no unmet gates",
    );
  });

  it("accepts historical non-Done completion evidence from a prior phase session", async () => {
    const document = await fixture();
    const phase = document.phases[0]!;
    phase.session = {
      sessionId: "replacement-session",
      sessionPath: "/sessions/replacement.jsonl",
    };
    const review = phase.roadmapEvents.find((event) => event.type === "completion-review")!;
    review.gateOutcome = "review";
    review.unmetGateCodes = ["stale-session"];

    expect(validateNotesDocumentV3(document)).toEqual({ ok: true, document });
  });
});
