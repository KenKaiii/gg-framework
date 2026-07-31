import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  NOTES_REFERENCE_METADATA_FIELDS,
  NOTES_REFERENCE_METADATA_MAX_LENGTH,
  NOTES_REFERENCE_URL_MAX_LENGTH,
} from "./notes-reference";
import { validateNotesDocumentV3 } from "./notes-types";
import type { NotesDocumentV2, NotesDocumentV3 } from "./notes-types";
import {
  canonicalProjectKey,
  createNotesRepository,
  legacyNotesKey,
  parseNotesDocument,
  v2NotesKey,
  v3NotesKey,
} from "./notes-storage";

const NOW = "2026-07-15T12:00:00.000Z";

async function canonicalNotesFixture(): Promise<unknown> {
  return JSON.parse(
    await fs.readFile(new URL("../../fixtures/project-notes-v3.json", import.meta.url), "utf8"),
  ) as unknown;
}

async function malformedLegacyV3Fixture(): Promise<unknown> {
  return JSON.parse(
    await fs.readFile(
      new URL("../../fixtures/project-notes-v3-malformed-legacy.json", import.meta.url),
      "utf8",
    ),
  ) as unknown;
}

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  readonly failingWrites = new Set<string>();
  failReads = false;
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    if (this.failReads) throw new DOMException("Storage blocked", "SecurityError");
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.failingWrites.has(key)) throw new DOMException("Storage full", "QuotaExceededError");
    this.values.set(key, value);
  }
}

function legacyDocument(reference: string): NotesDocumentV2 {
  return {
    version: 2,
    reference,
    currentFocus: "Ship structured notes",
    tasks: [
      {
        id: "task-1",
        text: "Verify switching",
        status: "todo",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
      },
    ],
    handoff: { text: "Continue here", updatedAt: NOW, readAt: null },
    updatedAt: NOW,
    legacyImportedAt: null,
  };
}

function document(reference: string): NotesDocumentV3 {
  return {
    ...legacyDocument(reference),
    version: 3,
    references: [
      {
        id: "ref-1",
        provider: "github",
        tool: "search",
        canonicalUrl: "https://github.com/owner/repo/blob/abc/src/file.ts#L1-L2",
        owner: "owner",
        repo: "repo",
        revision: "abc",
        path: "src/file.ts",
        range: { startLine: 1, endLine: 2 },
        issue: null,
        pullRequest: null,
        query: "schema",
        anchor: "L1-L2",
        relevance: "Boundary fixture",
        capturedAt: NOW,
      },
    ],
    phases: [
      {
        id: "phase-1",
        title: "Schema phase",
        goal: "Round-trip structured Notes",
        doneWhen: ["Boundary tests pass"],
        order: 0,
        status: "not-started",
        sourcePrompt: "Implement Phase 16",
        referenceIds: ["ref-1"],
        session: { sessionId: "session-1", sessionPath: "/session" },
        reminder: {
          id: "reminder-1",
          occurrenceKey: "occurrence-1",
          dueAt: NOW,
          note: "Check",
          createdAt: NOW,
          lastDelivery: null,
        },
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

describe("structured project notes storage", () => {
  it("accepts and exactly round-trips the canonical v3 contract fixture", async () => {
    const fixture = await canonicalNotesFixture();
    const validated = validateNotesDocumentV3(fixture);

    expect(validated).toEqual({ ok: true, document: fixture });
    if (!validated.ok) throw new Error(validated.error.message);

    const cwd = "/work/canonical-fixture";
    const storage = new MemoryStorage();
    const repository = createNotesRepository(storage, () => NOW);
    repository.save(cwd, validated.document);

    expect(JSON.parse(storage.getItem(v3NotesKey(cwd))!)).toEqual(fixture);
    expect(repository.load(cwd).document).toEqual(fixture);
  });

  it("deterministically upgrades legacy v3 reminders and round-trips the current shape", () => {
    const legacy = structuredClone(document("legacy reminder")) as unknown as {
      phases: Array<{ reminder: Record<string, unknown> | null }>;
    };
    const legacyReminder = legacy.phases[0]!.reminder!;
    delete legacyReminder.occurrenceKey;
    delete legacyReminder.lastDelivery;

    expect(validateNotesDocumentV3(legacy)).toMatchObject({
      ok: false,
      error: { path: "phases[0].reminder" },
    });
    const parsed = parseNotesDocument(JSON.stringify(legacy));
    expect(parsed).toMatchObject({
      ok: true,
      migratedArchiveShape: true,
      document: {
        phases: [
          {
            reminder: {
              id: "reminder-1",
              occurrenceKey: "reminder-1",
              dueAt: NOW,
              note: "Check",
              createdAt: NOW,
              lastDelivery: null,
            },
          },
        ],
      },
    });
    if (!parsed.ok) throw new Error("Expected legacy reminder migration");

    const cwd = "/work/legacy-reminder";
    const repository = createNotesRepository(new MemoryStorage(), () => NOW);
    repository.save(cwd, parsed.document);
    expect(repository.load(cwd).document).toEqual(parsed.document);
  });

  it("normalizes legacy v3 lifecycle events without kind before persisting them", () => {
    const cwd = "/work/legacy-lifecycle-kind";
    const storage = new MemoryStorage();
    const legacy = structuredClone(document("legacy lifecycle")) as unknown as {
      phases: Array<Record<string, unknown>>;
    };
    legacy.phases[0]!.status = "planning";
    legacy.phases[0]!.lifecycleEvents = [
      {
        id: "legacy-planning",
        fromStatus: null,
        toStatus: "planning",
        source: "user",
        timestamp: NOW,
        reason: "Planning started",
      },
    ];
    storage.setItem(v3NotesKey(cwd), JSON.stringify(legacy));

    expect(validateNotesDocumentV3(legacy)).toMatchObject({
      ok: false,
      error: { path: "phases[0].lifecycleEvents[0]" },
    });
    const loaded = createNotesRepository(storage, () => NOW).load(cwd);

    expect(loaded.document.phases[0]!.lifecycleEvents).toEqual([
      expect.objectContaining({ id: "legacy-planning", kind: "other" }),
    ]);
    expect(JSON.parse(storage.getItem(v3NotesKey(cwd))!).phases[0].lifecycleEvents).toEqual([
      expect.objectContaining({ id: "legacy-planning", kind: "other" }),
    ]);
  });

  it("rejects malformed nested delivery evidence and oversized reminder notes", () => {
    const invalidDelivery = document("invalid delivery") as unknown as {
      phases: Array<{
        reminder: { lastDelivery: Record<string, unknown>; note: string };
      }>;
    };
    invalidDelivery.phases[0]!.reminder.lastDelivery = {
      occurrenceKey: "occurrence-1",
      attemptedAt: NOW,
      channel: "native",
      permission: "granted",
      privateContent: "must not survive",
    };
    expect(validateNotesDocumentV3(invalidDelivery)).toMatchObject({
      ok: false,
      error: { path: "phases[0].reminder.lastDelivery" },
    });

    const oversized = document("oversized reminder");
    oversized.phases[0]!.reminder!.note = "x".repeat(501);
    expect(validateNotesDocumentV3(oversized)).toMatchObject({
      ok: false,
      error: { path: "phases[0].reminder.note" },
    });
  });

  it("rejects impossible current-v3 delivery evidence before sidecar migration", () => {
    const cwd = "/work/impossible-delivery";
    const storage = new MemoryStorage();
    const invalid = document("impossible delivery");
    invalid.phases[0]!.reminder!.lastDelivery = {
      occurrenceKey: "occurrence-1",
      attemptedAt: NOW,
      channel: "in-app-fallback",
      permission: "granted",
    };
    const raw = JSON.stringify(invalid);

    expect(validateNotesDocumentV3(invalid)).toEqual({
      ok: false,
      error: {
        path: "phases[0].reminder.lastDelivery.permission",
        message: "permission does not match delivery channel",
      },
    });
    expect(parseNotesDocument(raw)).toMatchObject({
      ok: false,
      reason: "invalid-shape",
      error: { path: "phases[0].reminder.lastDelivery.permission" },
    });

    storage.setItem(v3NotesKey(cwd), raw);
    const loaded = createNotesRepository(storage, () => NOW).load(cwd);
    expect(loaded.migrationEligibility).toBe("ineligible-invalid-document");
    expect(storage.getItem(v3NotesKey(cwd))).toBe(raw);
  });

  it("accepts equal timestamps in append order across lifecycle and roadmap histories", async () => {
    const fixture = (await canonicalNotesFixture()) as NotesDocumentV3;
    const phase = fixture.phases[0]!;
    const sharedTimestamp = phase.lifecycleEvents[0]!.timestamp;
    phase.lifecycleEvents = phase.lifecycleEvents.map((event) => ({
      ...event,
      timestamp: sharedTimestamp,
    }));

    expect(new Set(phase.lifecycleEvents.map(({ timestamp }) => timestamp)).size).toBe(1);
    expect(new Set(phase.roadmapEvents.map(({ timestamp }) => timestamp)).size).toBe(1);
    expect(validateNotesDocumentV3(fixture)).toEqual({ ok: true, document: fixture });

    const cwd = "/work/equal-event-timestamps";
    const repository = createNotesRepository(new MemoryStorage(), () => NOW);
    repository.save(cwd, fixture);
    expect(repository.load(cwd).document).toEqual(fixture);
  });

  it.each([
    "failed implementation checkpoint",
    "incomplete implementation checkpoint",
    "failed verification",
    "unaccepted verification exception",
    "exception acceptance without an exception",
    "verification from a different session",
    "evidence from before the latest rejection",
  ] as const)("rejects an impossible automatic Done with %s", async (shape) => {
    const fixture = (await canonicalNotesFixture()) as NotesDocumentV3;
    const events = fixture.phases[0]!.roadmapEvents;
    const checkpoint = events.find((event) => event.type === "implementation-checkpoint")!;
    const verification = events.find((event) => event.type === "status-update")!;
    const review = events.find((event) => event.type === "completion-review")!;

    switch (shape) {
      case "failed implementation checkpoint":
        checkpoint.runOutcome = "failed";
        break;
      case "incomplete implementation checkpoint":
        checkpoint.completedPlanSteps = [1, 2];
        break;
      case "failed verification":
        verification.verification = "failed";
        verification.verificationReason = "Focused verification failed";
        break;
      case "unaccepted verification exception":
        verification.verification = "exception-requested";
        verification.verificationReason = "Verification exception requires review";
        break;
      case "exception acceptance without an exception":
        review.acceptsVerificationException = true;
        break;
      case "verification from a different session":
        verification.verificationSession = {
          sessionId: "replacement-session",
          sessionPath: "/sessions/replacement.jsonl",
        };
        break;
      case "evidence from before the latest rejection":
        events.splice(events.indexOf(review), 0, {
          type: "completion-review",
          id: "review-rejected-before-acceptance",
          reviewer: "ken-autopilot",
          decision: "rejected",
          evidence: [],
          reason: "Revise the implementation",
          implementationCheckpointId: checkpoint.id,
          verificationStatusUpdateId: verification.id,
          acceptsVerificationException: false,
          gateOutcome: "review",
          unmetGateCodes: [],
          timestamp: review.timestamp,
        });
        break;
    }

    expect(validateNotesDocumentV3(fixture)).toMatchObject({ ok: false });
    expect(parseNotesDocument(JSON.stringify(fixture))).toMatchObject({
      ok: false,
      reason: "invalid-shape",
    });
  });

  it("accepts and persists automatic Done with an accepted verification exception", async () => {
    const fixture = (await canonicalNotesFixture()) as NotesDocumentV3;
    const events = fixture.phases[0]!.roadmapEvents;
    const verification = events.find((event) => event.type === "status-update")!;
    const review = events.find((event) => event.type === "completion-review")!;
    verification.verification = "exception-requested";
    verification.verificationReason = "The approved environment cannot run this verification";
    review.acceptsVerificationException = true;

    expect(validateNotesDocumentV3(fixture)).toEqual({ ok: true, document: fixture });
    const cwd = "/work/accepted-exception";
    const repository = createNotesRepository(new MemoryStorage(), () => NOW);
    repository.save(cwd, fixture);
    expect(repository.load(cwd).document).toEqual(fixture);
  });

  it("enforces canonical reference identity and GitHub coordinate parity", () => {
    const valid = document("identity");
    const first = valid.references[0]!;
    const duplicate = {
      ...first,
      id: "ref-duplicate",
      provider: " GitHub ",
      canonicalUrl: "HTTPS://GITHUB.COM:443/owner/repo/blob/abc/src/file.ts/#L1-L2",
    };

    expect(validateNotesDocumentV3({ ...valid, references: [first, duplicate] })).toMatchObject({
      ok: false,
      error: { path: "references[1].canonicalUrl", message: expect.stringContaining("duplicate") },
    });
    expect(
      validateNotesDocumentV3({
        ...valid,
        references: [{ ...first, canonicalUrl: "https://gitlab.com/owner/repo" }],
      }),
    ).toMatchObject({ ok: false, error: { path: "references[0].canonicalUrl" } });
    expect(
      validateNotesDocumentV3({
        ...valid,
        references: [
          {
            ...first,
            canonicalUrl: "https://github.com/owner/repo/issues/12",
            revision: null,
            path: null,
            range: null,
            issue: 11,
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { path: "references[0].issue" } });
  });

  it.each([
    ["username", "https://user@github.com/owner/repo/blob/abc/src/file.ts#L1-L2"],
    ["password", "https://:secret@github.com/owner/repo/blob/abc/src/file.ts#L1-L2"],
  ])("rejects a reference URL containing a %s", (_credential, canonicalUrl) => {
    const invalid = document("credentials");
    invalid.references[0] = { ...invalid.references[0]!, canonicalUrl };

    expect(validateNotesDocumentV3(invalid)).toEqual({
      ok: false,
      error: {
        path: "references[0].canonicalUrl",
        message: "expected an absolute http(s) URL without username or password",
      },
    });
  });

  it.each(NOTES_REFERENCE_METADATA_FIELDS)(
    "matches form validation at the shared metadata limit for %s",
    (field) => {
      const exact = document("metadata limit");
      exact.references[0] = {
        ...exact.references[0]!,
        provider: "example",
        [field]: "x".repeat(NOTES_REFERENCE_METADATA_MAX_LENGTH),
      };
      const oversized = document("metadata limit");
      oversized.references[0] = {
        ...oversized.references[0]!,
        provider: "example",
        [field]: "x".repeat(NOTES_REFERENCE_METADATA_MAX_LENGTH + 1),
      };

      expect(validateNotesDocumentV3(exact).ok).toBe(true);
      expect(validateNotesDocumentV3(oversized)).toMatchObject({
        ok: false,
        error: { path: `references[0].${field}`, message: expect.stringContaining("4,096") },
      });
    },
  );

  it("matches form validation at the shared canonical URL limit", () => {
    const prefix = "https://example.com/";
    const canonicalUrl = `${prefix}${"x".repeat(NOTES_REFERENCE_URL_MAX_LENGTH - prefix.length)}`;
    const exact = document("URL limit");
    exact.references[0] = { ...exact.references[0]!, provider: "example", canonicalUrl };
    const oversized = document("URL limit");
    oversized.references[0] = {
      ...oversized.references[0]!,
      provider: "example",
      canonicalUrl: `${canonicalUrl}x`,
    };

    expect(validateNotesDocumentV3(exact).ok).toBe(true);
    expect(validateNotesDocumentV3(oversized)).toMatchObject({
      ok: false,
      error: { path: "references[0].canonicalUrl", message: expect.stringContaining("2,048") },
    });
  });

  it("imports legacy free-form notes byte-for-byte into the project-scoped v3 document", () => {
    const cwd = "C:\\Work\\Project";
    const storage = new MemoryStorage();
    const legacy = "  existing\r\nnotes 😀\n";
    storage.setItem(legacyNotesKey(cwd), legacy);

    const loaded = createNotesRepository(storage, () => NOW).load(cwd);
    const persisted = parseNotesDocument(storage.getItem(v3NotesKey(cwd))!);

    expect(loaded.document).toMatchObject({
      version: 3,
      reference: legacy,
      legacyImportedAt: NOW,
      phases: [],
      references: [],
    });
    expect(persisted.ok && persisted.document.reference).toBe(legacy);
    expect(storage.getItem(legacyNotesKey(cwd))).toBe(legacy);
  });

  it("round-trips every v3 field while keeping the rollback reference key", () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const notes = document("reference bytes");
    const repository = createNotesRepository(storage, () => NOW);

    repository.save(cwd, notes);

    expect(repository.load(cwd).document).toEqual(notes);
    expect(storage.getItem(legacyNotesKey(cwd))).toBe("reference bytes");
    expect(parseNotesDocument(storage.getItem(v3NotesKey(cwd))!)).toEqual({
      ok: true,
      document: notes,
      migratedFromV2: false,
      migratedArchiveShape: false,
    });
  });

  it("migrates v2 to v3 once and preserves every existing field across restart", () => {
    const cwd = "/work/v2";
    const storage = new MemoryStorage();
    const legacy = legacyDocument("  v2\r\nbytes 😀\n");
    storage.setItem(v2NotesKey(cwd), JSON.stringify(legacy));

    const first = createNotesRepository(storage, () => NOW).load(cwd);
    const restarted = createNotesRepository(storage, () => NOW).load(cwd);
    const expected = { ...legacy, version: 3, phases: [], references: [] };

    expect(first).toMatchObject({
      source: "v2-migrated",
      migrationEligibility: "valid-v2-migrated",
      v2ImportAttempted: true,
      v2ImportSucceeded: true,
      document: expected,
    });
    expect(restarted).toMatchObject({ source: "v3", document: expected });
    expect(JSON.parse(storage.getItem(v2NotesKey(cwd))!)).toEqual(legacy);
    expect(JSON.parse(storage.getItem(v3NotesKey(cwd))!)).toEqual(expected);
  });

  it.each([
    ["archivedAt present and roadmapEvents absent", ["roadmapEvents"]],
    ["both additive fields absent", ["archivedAt", "roadmapEvents"]],
    ["archivedAt absent and roadmapEvents present", ["archivedAt"]],
  ])("rewrites a v3 phase with %s without losing existing data", (caseName, missingFields) => {
    const cwd = `/work/${caseName.replace(/ /g, "-")}`;
    const storage = new MemoryStorage();
    const expected = document(caseName);
    const original = structuredClone(expected) as unknown as {
      phases: Array<Record<string, unknown>>;
    };
    for (const field of missingFields) delete original.phases[0]![field];
    storage.setItem(v3NotesKey(cwd), JSON.stringify(original));

    const loaded = createNotesRepository(storage, () => NOW).load(cwd);
    const persisted = JSON.parse(storage.getItem(v3NotesKey(cwd))!) as unknown;
    const restarted = createNotesRepository(storage, () => NOW).load(cwd);

    expect(loaded).toMatchObject({
      source: "v3",
      migrationEligibility: "valid-v3",
      document: expected,
    });
    expect(loaded.document).toEqual(expected);
    expect(persisted).toEqual(expected);
    expect(restarted.document).toEqual(expected);
  });

  it("returns the shared post-normalization error for malformed legacy v3 Notes", async () => {
    const fixture = await malformedLegacyV3Fixture();

    expect(validateNotesDocumentV3(fixture)).toMatchObject({
      ok: false,
      error: { path: "phases[0]" },
    });
    expect(parseNotesDocument(JSON.stringify(fixture))).toEqual({
      ok: false,
      reason: "invalid-shape",
      error: {
        path: "phases[0].status",
        message: "unknown phase status",
      },
    });
  });

  it("migrates legacy v3 proposal outcomes without inferring override protection", () => {
    const cwd = "/work/legacy-roadmap-proposal";
    const storage = new MemoryStorage();
    const legacy = document("legacy roadmap proposal");
    const { id: _referenceId, capturedAt: _capturedAt, ...proposal } = legacy.references[0]!;
    (legacy.phases[0] as unknown as { roadmapEvents: unknown[] }).roadmapEvents = [
      {
        type: "status-update",
        id: "legacy-update",
        actor: "gg-coder",
        transition: "in-progress",
        progress: "Legacy report",
        blocker: null,
        evidence: [],
        statusOutcome: "applied",
        proposedReferences: [
          {
            ...proposal,
            id: "legacy-proposal",
            disposition: "pending",
            referenceId: null,
          },
        ],
        timestamp: NOW,
      },
    ];
    storage.setItem(v3NotesKey(cwd), JSON.stringify(legacy));

    const loaded = createNotesRepository(storage, () => NOW).load(cwd);

    expect(loaded.document.phases[0]!.roadmapEvents[0]).toMatchObject({
      verification: null,
      verificationReason: null,
      verificationSession: null,
      proposedReferences: [
        {
          disposition: "pending",
          policyOutcome: "manual-review",
          referenceId: null,
        },
      ],
    });
    expect(JSON.parse(storage.getItem(v3NotesKey(cwd))!).phases[0].roadmapEvents[0]).toMatchObject({
      verification: null,
      verificationReason: null,
      verificationSession: null,
      proposedReferences: [{ policyOutcome: "manual-review" }],
    });
  });

  it("rejects proposal policy outcomes that contradict their disposition", () => {
    const invalid = document("invalid roadmap policy");
    const { id: _referenceId, capturedAt: _capturedAt, ...proposal } = invalid.references[0]!;
    invalid.phases[0]!.roadmapEvents = [
      {
        type: "status-update",
        id: "invalid-policy-update",
        actor: "gg-coder",
        transition: "in-progress",
        progress: "Invalid policy report",
        blocker: null,
        evidence: [],
        verification: null,
        verificationReason: null,
        verificationSession: null,
        statusOutcome: "applied",
        proposedReferences: [
          {
            ...proposal,
            id: "invalid-policy-proposal",
            disposition: "pending",
            policyOutcome: "accepted",
            referenceId: null,
          },
        ],
        timestamp: NOW,
      },
    ];

    expect(validateNotesDocumentV3(invalid)).toMatchObject({
      ok: false,
      error: {
        path: "phases[0].roadmapEvents[0].proposedReferences[0].policyOutcome",
        message: "must match the proposal disposition",
      },
    });
  });

  it.each([
    ["roadmapEvents absent", ["roadmapEvents"]],
    ["both additive fields absent", ["archivedAt", "roadmapEvents"]],
    ["archivedAt absent", ["archivedAt"]],
  ])("rejects %s lookalikes with unknown phase keys", (_caseName, missingFields) => {
    const original = document("invalid additive shape") as unknown as {
      phases: Array<Record<string, unknown>>;
    };
    for (const field of missingFields) delete original.phases[0]![field];
    original.phases[0]!.unexpected = true;

    expect(parseNotesDocument(JSON.stringify(original))).toMatchObject({
      ok: false,
      reason: "invalid-shape",
      error: { path: "phases[0]" },
    });
  });

  it("repairs empty and duplicate task IDs while migrating legacy v2 Notes", () => {
    const cwd = "/work/v2-task-ids";
    const storage = new MemoryStorage();
    const legacy = legacyDocument("legacy IDs");
    const task = legacy.tasks[0]!;
    legacy.tasks = [
      { ...task, id: "", text: "empty" },
      { ...task, id: "duplicate", text: "first duplicate" },
      { ...task, id: "duplicate", text: "second duplicate" },
    ];
    storage.setItem(v2NotesKey(cwd), JSON.stringify(legacy));

    const first = createNotesRepository(storage, () => NOW).load(cwd);
    const restarted = createNotesRepository(storage, () => NOW).load(cwd);

    expect(first.source).toBe("v2-migrated");
    expect(first.document.tasks.map(({ id }) => id)).toEqual([
      "legacy-task-1",
      "duplicate",
      "legacy-task-3",
    ]);
    expect(restarted).toMatchObject({ source: "v3", document: first.document });
  });

  it("keeps phase and reference IDs stable through reorder and edit", () => {
    const cwd = "/work/stable";
    const storage = new MemoryStorage();
    const repository = createNotesRepository(storage, () => NOW);
    const initial = document("stable");
    const ref2 = {
      ...initial.references[0]!,
      id: "ref-2",
      canonicalUrl: "https://github.com/owner/repo/issues/2",
      revision: null,
      path: null,
      range: null,
      issue: 2,
      query: null,
      anchor: null,
    };
    const phase2 = {
      ...initial.phases[0]!,
      id: "phase-2",
      title: "Second",
      order: 1,
      referenceIds: ["ref-2"],
      session: null,
      reminder: null,
    };
    repository.save(cwd, {
      ...initial,
      references: [...initial.references, ref2],
      phases: [...initial.phases, phase2],
    });
    const loaded = repository.load(cwd).document;
    const reordered = {
      ...loaded,
      references: [loaded.references[1]!, loaded.references[0]!],
      phases: [
        { ...loaded.phases[1]!, title: "Second edited", order: 0 },
        { ...loaded.phases[0]!, goal: "Edited", order: 1 },
      ],
    };

    repository.save(cwd, reordered);

    expect(repository.load(cwd).document).toMatchObject({
      phases: [{ id: "phase-2" }, { id: "phase-1" }],
      references: [{ id: "ref-2" }, { id: "ref-1" }],
    });
  });

  it("keeps a newer v3 reference when the rollback legacy write fails", () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const repository = createNotesRepository(storage, () => NOW);
    storage.setItem(legacyNotesKey(cwd), "old reference");
    storage.failingWrites.add(legacyNotesKey(cwd));

    const saved = repository.save(cwd, document("new reference"));
    const loaded = repository.load(cwd);

    expect(saved.legacy.ok).toBe(false);
    expect(saved.v3.ok).toBe(true);
    expect(loaded.document.reference).toBe("new reference");
    expect(storage.getItem(legacyNotesKey(cwd))).toBe("old reference");
  });

  it("marks only safe browser states as eligible for sidecar migration", () => {
    const cwd = "/work/project";
    const empty = createNotesRepository(new MemoryStorage(), () => NOW).load(cwd);

    const validV3Storage = new MemoryStorage();
    validV3Storage.setItem(v3NotesKey(cwd), JSON.stringify(document("v3")));
    const validV3 = createNotesRepository(validV3Storage, () => NOW).load(cwd);

    const validV2Storage = new MemoryStorage();
    validV2Storage.setItem(v2NotesKey(cwd), JSON.stringify(legacyDocument("v2")));
    const validV2 = createNotesRepository(validV2Storage, () => NOW).load(cwd);

    const legacyStorage = new MemoryStorage();
    legacyStorage.setItem(v3NotesKey(cwd), "{broken");
    legacyStorage.setItem(legacyNotesKey(cwd), "  legacy\r\nbytes ");
    const legacyFallback = createNotesRepository(legacyStorage, () => NOW).load(cwd);

    expect(empty.migrationEligibility).toBe("empty");
    expect(validV3.migrationEligibility).toBe("valid-v3");
    expect(validV2.migrationEligibility).toBe("valid-v2-migrated");
    expect(legacyFallback.migrationEligibility).toBe("valid-legacy");
    expect(legacyFallback.document.reference).toBe("  legacy\r\nbytes ");
  });

  it("refuses sidecar initialization from malformed or unsupported current records", () => {
    const cwd = "/work/project";
    for (const raw of ["{broken", JSON.stringify({ ...document("future"), version: 4 })]) {
      const storage = new MemoryStorage();
      storage.setItem(v3NotesKey(cwd), raw);

      const loaded = createNotesRepository(storage, () => NOW).load(cwd);

      expect(loaded.migrationEligibility).toBe("ineligible-invalid-document");
      expect(storage.getItem(v3NotesKey(cwd))).toBe(raw);
    }
  });

  it.each([
    [
      "invalid URL",
      {
        ...document("invalid"),
        references: [{ ...document("invalid").references[0], canonicalUrl: "bad" }],
      },
      "references[0].canonicalUrl",
    ],
    [
      "missing repository identity",
      { ...document("invalid"), references: [{ ...document("invalid").references[0], repo: "" }] },
      "references[0].repo",
    ],
    [
      "broken reference link",
      {
        ...document("invalid"),
        phases: [{ ...document("invalid").phases[0], referenceIds: ["missing"] }],
      },
      "phases[0].referenceIds[0]",
    ],
    [
      "unknown status",
      { ...document("invalid"), phases: [{ ...document("invalid").phases[0], status: "blocked" }] },
      "phases[0].status",
    ],
    [
      "invalid archive timestamp",
      {
        ...document("invalid"),
        phases: [{ ...document("invalid").phases[0], archivedAt: "next week" }],
      },
      "phases[0].archivedAt",
    ],
    [
      "invalid transition",
      {
        ...document("invalid"),
        phases: [
          {
            ...document("invalid").phases[0],
            status: "planning",
            lifecycleEvents: [
              {
                id: "event-1",
                fromStatus: "planning",
                toStatus: "planning",
                source: "agent",
                timestamp: NOW,
                reason: null,
                kind: "other",
              },
            ],
          },
        ],
      },
      "phases[0].lifecycleEvents[0]",
    ],
  ])("returns an actionable boundary error for %s", (_name, value, expectedPath) => {
    const parsed = parseNotesDocument(JSON.stringify(value));

    expect(parsed).toMatchObject({
      ok: false,
      reason: "invalid-shape",
      error: { path: expectedPath, message: expect.any(String) },
    });
  });

  it("refuses sidecar initialization when browser storage cannot be read", () => {
    const storage = new MemoryStorage();
    storage.failReads = true;

    const loaded = createNotesRepository(storage, () => NOW).load("/work/project");

    expect(loaded.migrationEligibility).toBe("ineligible-unreadable");
    expect(loaded.diagnostics.some((diagnostic) => diagnostic.kind === "storage-read")).toBe(true);
  });

  it("converges Windows cwd aliases but preserves POSIX case", () => {
    expect(v2NotesKey("C:\\Work\\.\\App\\..\\Project\\")).toBe(v2NotesKey("c:/work/project"));
    expect(v3NotesKey("C:\\Work\\.\\App\\..\\Project\\")).toBe(v3NotesKey("c:/work/project"));
    expect(v3NotesKey("\\\\Server\\Share\\Folder\\..\\Project")).toBe(
      v3NotesKey("//server/share/project"),
    );
    expect(canonicalProjectKey("/Work/Project")).not.toBe(canonicalProjectKey("/work/project"));
  });
});
