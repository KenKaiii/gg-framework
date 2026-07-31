// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { NotesReferenceInput } from "./notes-reference";
import { createEmptyNotesDocument, createNotesRepository, v3NotesKey } from "./notes-storage";
import type {
  NotesClient,
  NotesDocumentV3,
  NotesReferenceOperationResult,
  NotesReminderMutationResult,
  NotesSidecarEvent,
  ProjectNotesMigrationOutcome,
  ProjectNotesReadOutcome,
  ProjectNotesSaveOutcome,
  ProjectNotesSnapshot,
} from "./notes-types";
import { useProjectNotes } from "./useProjectNotes";

const NOW = "2026-07-25T12:00:00.000Z";
const LATER = "2026-07-25T12:01:00.000Z";

function notes(
  reference: string,
  currentFocus = "",
  tasks: NotesDocumentV3["tasks"] = [],
): NotesDocumentV3 {
  return {
    ...createEmptyNotesDocument(NOW),
    reference,
    currentFocus,
    tasks,
  };
}

function task(id = "task-1"): NotesDocumentV3["tasks"][number] {
  return {
    id,
    text: `Task ${id}`,
    status: "todo",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    archivedAt: null,
  };
}

function referenceInput(
  canonicalUrl = "https://github.com/owner/repo/blob/main/src/file.ts#L1-L2",
): NotesReferenceInput {
  return {
    provider: "github",
    tool: "search",
    canonicalUrl,
    owner: "owner",
    repo: "repo",
    revision: "main",
    path: "src/file.ts",
    range: { startLine: 1, endLine: 2 },
    issue: null,
    pullRequest: null,
    query: null,
    anchor: "L1-L2",
    relevance: "Reference evidence",
  };
}

function savedReference(
  id = "ref-1",
  canonicalUrl = "https://github.com/owner/repo/blob/main/src/file.ts#L1-L2",
): NotesDocumentV3["references"][number] {
  return { ...referenceInput(canonicalUrl), id, capturedAt: NOW };
}

function phase(id: string, order: number): NotesDocumentV3["phases"][number] {
  return {
    id,
    title: `Phase ${id}`,
    goal: `Goal ${id}`,
    doneWhen: [`Done ${id}`],
    order,
    status: "not-started",
    sourcePrompt: "",
    referenceIds: [],
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
  };
}

function pendingPlanApprovalDocument(): NotesDocumentV3 {
  const document = notes("pending plan approval");
  const selected = phase("phase-planning", 0);
  selected.status = "planning";
  selected.session = { sessionId: "session-planning", sessionPath: "/sessions/planning.jsonl" };
  selected.overrides.status = { value: "planning", source: "user", updatedAt: NOW };
  selected.pendingAutomaticLifecycleTransition = {
    status: "in-progress",
    source: "user",
    reason: "Plan approved by user",
    kind: "approval-resolved",
    timestamp: LATER,
    expectedSession: { ...selected.session },
  };
  selected.updatedAt = LATER;
  selected.lifecycleEvents = [
    {
      id: "planning-started",
      fromStatus: null,
      toStatus: "planning",
      source: "user",
      timestamp: NOW,
      reason: "Phase started by user",
      kind: "other",
    },
  ];
  document.updatedAt = LATER;
  document.phases = [selected];
  return document;
}

function addPendingRoadmapProposal(
  document: NotesDocumentV3,
  options: {
    statusOverride?: boolean;
    referenceOverride?: boolean;
    transition?: "in-progress" | "blocked";
  } = {},
): NotesDocumentV3 {
  const selected = phase("phase-roadmap", 0);
  selected.status = "not-started";
  selected.overrides = {
    status: options.statusOverride
      ? { value: "not-started", source: "user", updatedAt: NOW }
      : null,
    referenceIds: options.referenceOverride ? { value: [], source: "user", updatedAt: NOW } : null,
  };
  const transition = options.transition ?? "in-progress";
  selected.roadmapEvents = [
    {
      type: "status-update",
      id: "update-1",
      actor: "gg-coder",
      transition,
      progress: "Implemented the Roadmap status path",
      blocker: transition === "blocked" ? "Waiting for CI" : null,
      evidence: ["Focused tests passed"],
      verification: null,
      verificationReason: null,
      verificationSession: null,
      statusOutcome: options.statusOverride ? "manual-override" : "same-status",
      proposedReferences: [
        {
          ...referenceInput(),
          id: "proposal-1",
          disposition: "pending",
          policyOutcome: options.referenceOverride
            ? "reference-override-protected"
            : "manual-review",
          referenceId: null,
        },
      ],
      timestamp: NOW,
    },
  ];
  return { ...document, phases: [selected] };
}

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

interface PendingSave {
  expectedRevision: number;
  document: NotesDocumentV3;
  resolve(outcome: ProjectNotesSaveOutcome): void;
}

class FakeNotesServer {
  readonly snapshots = new Map<string, ProjectNotesSnapshot>();
  readonly clients = new Set<FakeNotesClient>();
  migrationCreates = 0;

  connect(projectKey: string): FakeNotesClient {
    const client = new FakeNotesClient(this, projectKey);
    this.clients.add(client);
    return client;
  }

  read(projectKey: string): ProjectNotesReadOutcome {
    const snapshot = this.snapshots.get(projectKey);
    return snapshot
      ? { status: "ok", snapshot, recoveredFromBackup: false }
      : { status: "missing" };
  }

  migrate(projectKey: string, document: NotesDocumentV3): ProjectNotesMigrationOutcome {
    const existing = this.snapshots.get(projectKey);
    if (existing) return { status: "ok", snapshot: existing, migrated: false };
    const snapshot = { projectKey, revision: 1, document };
    this.snapshots.set(projectKey, snapshot);
    this.migrationCreates += 1;
    this.emit(projectKey, snapshot);
    return { status: "ok", snapshot, migrated: true };
  }

  save(
    projectKey: string,
    expectedRevision: number,
    document: NotesDocumentV3,
  ): ProjectNotesSaveOutcome {
    const current = this.snapshots.get(projectKey);
    if (!current) return { status: "missing" };
    if (current.revision !== expectedRevision) return { status: "conflict", snapshot: current };
    const snapshot = { projectKey, revision: expectedRevision + 1, document };
    this.snapshots.set(projectKey, snapshot);
    this.emit(projectKey, snapshot);
    return { status: "ok", snapshot };
  }

  emit(projectKey: string, snapshot: ProjectNotesSnapshot): void {
    for (const client of this.clients) {
      if (client.projectKey === projectKey) client.emit({ type: "notes_change", data: snapshot });
    }
  }
}

class FakeNotesClient implements NotesClient {
  readonly listeners = new Set<(event: NotesSidecarEvent) => void>();
  readonly saveCalls: Array<{ expectedRevision: number; document: NotesDocumentV3 }> = [];
  readonly pendingSaves: PendingSave[] = [];
  getCalls = 0;
  deferSaves = false;
  migrationError: unknown = null;
  migrationOutcome: ProjectNotesMigrationOutcome | null = null;
  saveOutcome: ProjectNotesSaveOutcome | null = null;
  saveError: unknown = null;
  getOverride: (() => Promise<ProjectNotesReadOutcome>) | null = null;

  constructor(
    readonly server: FakeNotesServer,
    readonly projectKey: string,
  ) {}

  async getNotes(): Promise<ProjectNotesReadOutcome> {
    this.getCalls += 1;
    if (this.getOverride) return this.getOverride();
    return this.server.read(this.projectKey);
  }

  async migrateNotes(document: NotesDocumentV3): Promise<ProjectNotesMigrationOutcome> {
    if (this.migrationError) throw this.migrationError;
    if (this.migrationOutcome) return this.migrationOutcome;
    return this.server.migrate(this.projectKey, document);
  }

  async saveNotes(
    expectedRevision: number,
    document: NotesDocumentV3,
  ): Promise<ProjectNotesSaveOutcome> {
    this.saveCalls.push({ expectedRevision, document });
    if (this.saveError) throw this.saveError;
    if (this.saveOutcome) return this.saveOutcome;
    if (!this.deferSaves) return this.server.save(this.projectKey, expectedRevision, document);
    return new Promise((resolve) => {
      this.pendingSaves.push({ expectedRevision, document, resolve });
    });
  }

  async reserveReminder() {
    return { status: "none" as const };
  }

  async claimReminder() {
    return { status: "already-delivered" as const };
  }

  async releaseReminder() {
    return { status: "released" as const };
  }

  subscribe(onEvent: (event: NotesSidecarEvent) => void): () => void {
    this.listeners.add(onEvent);
    return () => this.listeners.delete(onEvent);
  }

  emit(event: NotesSidecarEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  flushNextSave(): void {
    const pending = this.pendingSaves.shift();
    if (!pending) throw new Error("no pending Notes save");
    pending.resolve(this.server.save(this.projectKey, pending.expectedRevision, pending.document));
  }
}

function seed(storage: Storage, cwd: string, document: NotesDocumentV3): void {
  storage.setItem(v3NotesKey(cwd), JSON.stringify(document));
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function invokeMutation<T>(mutation: () => Promise<T>): Promise<T> {
  let result!: T;
  await act(async () => {
    result = await mutation();
  });
  return result;
}

const testClock = (): string => LATER;
const testIdFactory = (): string => "created-task";
const hookOptions = (
  client: NotesClient,
  storage: Storage,
): Parameters<typeof useProjectNotes>[1] => ({
  client,
  storage,
  clock: testClock,
  idFactory: testIdFactory,
});

afterEach(() => cleanup());

describe("useProjectNotes sidecar authority", () => {
  it("subscribes first and migrates a valid local v2 document exactly once", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const local = notes("  local\r\nbytes 😀\n", "focus", [task()]);
    seed(storage, cwd, local);
    const server = new FakeNotesServer();
    const client = server.connect(cwd);

    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));

    await waitFor(() => expect(hook.result.current.document).toEqual(local));
    expect(server.migrationCreates).toBe(1);
    expect(server.snapshots.get(cwd)).toEqual({ projectKey: cwd, revision: 1, document: local });
    expect(client.listeners.size).toBe(1);
  });

  it("converges simultaneous migrations on one revision-1 snapshot", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    const firstStorage = new MemoryStorage();
    const secondStorage = new MemoryStorage();
    seed(firstStorage, cwd, notes("first"));
    seed(secondStorage, cwd, notes("second"));
    const firstClient = server.connect(cwd);
    const secondClient = server.connect(cwd);

    const first = renderHook(() => useProjectNotes(cwd, hookOptions(firstClient, firstStorage)));
    const second = renderHook(() => useProjectNotes(cwd, hookOptions(secondClient, secondStorage)));

    await waitFor(() => expect(first.result.current.document.reference).not.toBe(""));
    await waitFor(() =>
      expect(second.result.current.document).toEqual(first.result.current.document),
    );
    expect(server.migrationCreates).toBe(1);
    expect(server.snapshots.get(cwd)?.revision).toBe(1);
  });

  it("always prefers an existing sidecar snapshot over stale localStorage", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    seed(storage, cwd, notes("stale local"));
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 7, document: notes("server wins") });
    const client = server.connect(cwd);

    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));

    await waitFor(() => expect(hook.result.current.document.reference).toBe("server wins"));
    expect(storage.getItem(v3NotesKey(cwd))).toContain("stale local");
  });

  it("refetches the authoritative snapshot when a reconnect ready event follows a missed change", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: notes("before drop") });
    const client = server.connect(cwd);
    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));
    await waitFor(() => expect(hook.result.current.document.reference).toBe("before drop"));

    server.snapshots.set(cwd, {
      projectKey: cwd,
      revision: 2,
      document: notes("saved while disconnected"),
    });
    act(() => client.emit({ type: "ready", data: {} }));

    await waitFor(() =>
      expect(hook.result.current.document.reference).toBe("saved while disconnected"),
    );
    expect(client.getCalls).toBe(2);
  });

  it("accepts a lower backup-recovery snapshot from an explicit ready refresh", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, {
      projectKey: cwd,
      revision: 5,
      document: notes("primary revision 5"),
    });
    const client = server.connect(cwd);
    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));
    await waitFor(() => expect(hook.result.current.document.reference).toBe("primary revision 5"));

    const recovered = {
      projectKey: cwd,
      revision: 4,
      document: notes("recovered backup revision 4"),
    };
    server.snapshots.set(cwd, recovered);
    client.getOverride = async () => ({
      status: "ok",
      snapshot: recovered,
      recoveredFromBackup: true,
    });
    act(() => client.emit({ type: "ready", data: {} }));

    await waitFor(() =>
      expect(hook.result.current.document.reference).toBe("recovered backup revision 4"),
    );
    expect(client.getCalls).toBe(2);
  });

  it("survives browser-storage clearing and remounts from the sidecar", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    seed(storage, cwd, notes("durable"));
    const server = new FakeNotesServer();
    const firstClient = server.connect(cwd);
    const first = renderHook(() => useProjectNotes(cwd, hookOptions(firstClient, storage)));
    await waitFor(() => expect(first.result.current.document.reference).toBe("durable"));
    first.unmount();
    storage.clear();

    const restartedClient = server.connect(cwd);
    const restarted = renderHook(() => useProjectNotes(cwd, hookOptions(restartedClient, storage)));

    await waitFor(() => expect(restarted.result.current.document.reference).toBe("durable"));
  });

  it("keeps local records and emergency edits recoverable when migration fails", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    seed(storage, cwd, notes("recover me"));
    const server = new FakeNotesServer();
    const client = server.connect(cwd);
    client.migrationError = new Error("offline");
    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));
    await waitFor(() => expect(hook.result.current.document.reference).toBe("recover me"));

    act(() => hook.result.current.onChange("emergency edit"));

    expect(createNotesRepository(storage).load(cwd).document.reference).toBe("emergency edit");
    expect(hook.result.current.diagnostics.authority.map((item) => item.kind)).toContain(
      "migration-failed",
    );
    expect(server.snapshots.has(cwd)).toBe(false);
  });

  it("retains the validation path and message when migration is invalid", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    seed(storage, cwd, notes("migration input"));
    const server = new FakeNotesServer();
    const client = server.connect(cwd);
    const validationError = {
      path: "references[0].canonicalUrl",
      message: "expected an absolute http(s) URL",
    };
    client.migrationOutcome = { status: "invalid", error: validationError };

    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));

    await waitFor(() =>
      expect(hook.result.current.diagnostics.authority).toContainEqual({
        kind: "migration-failed",
        error: validationError,
      }),
    );
  });

  it("retains the validation path and message when a save is invalid", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: notes("base") });
    const client = server.connect(cwd);
    const validationError = {
      path: "phases[0].lifecycleEvents[1].fromStatus",
      message: "expected in-progress",
    };
    client.saveOutcome = { status: "invalid", error: validationError };
    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));
    await waitFor(() => expect(hook.result.current.document.reference).toBe("base"));

    act(() => hook.result.current.onChange("invalid save"));

    await waitFor(() =>
      expect(hook.result.current.diagnostics.authority).toContainEqual({
        kind: "save-failed",
        error: validationError,
      }),
    );
  });

  it("serializes rapid text writes and coalesces only the unsent tail", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: notes("base") });
    const client = server.connect(cwd);
    client.deferSaves = true;
    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));
    await waitFor(() => expect(hook.result.current.document.reference).toBe("base"));

    act(() => hook.result.current.onChange("a"));
    await waitFor(() => expect(client.pendingSaves).toHaveLength(1));
    act(() => {
      hook.result.current.onChange("ab");
      hook.result.current.onChange("abc");
    });
    expect(hook.result.current.document.reference).toBe("abc");

    act(() => client.flushNextSave());
    await waitFor(() => expect(client.pendingSaves).toHaveLength(1));
    act(() => client.flushNextSave());
    await waitFor(() => expect(server.snapshots.get(cwd)?.document.reference).toBe("abc"));

    expect(client.saveCalls.map((call) => call.document.reference)).toEqual(["a", "abc"]);
    expect(client.saveCalls.map((call) => call.expectedRevision)).toEqual([1, 2]);
  });

  it("rebases a mutation onto a lower backup-recovery conflict without looping", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, {
      projectKey: cwd,
      revision: 5,
      document: notes("primary revision 5"),
    });
    const client = server.connect(cwd);
    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));
    await waitFor(() => expect(hook.result.current.document.reference).toBe("primary revision 5"));

    server.snapshots.set(cwd, {
      projectKey: cwd,
      revision: 4,
      document: notes("recovered backup revision 4"),
    });
    act(() => hook.result.current.onChange("rebased edit"));

    await waitFor(() => expect(server.snapshots.get(cwd)?.document.reference).toBe("rebased edit"));
    expect(server.snapshots.get(cwd)?.revision).toBe(5);
    expect(client.saveCalls.map((call) => call.expectedRevision)).toEqual([5, 4]);
    await Promise.resolve();
    expect(client.saveCalls).toHaveLength(2);
  });

  it("rebases unrelated concurrent operations and converges both hooks", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: notes("base", "base") });
    const firstClient = server.connect(cwd);
    const secondClient = server.connect(cwd);
    const firstStorage = new MemoryStorage();
    const secondStorage = new MemoryStorage();
    const first = renderHook(() => useProjectNotes(cwd, hookOptions(firstClient, firstStorage)));
    const second = renderHook(() => useProjectNotes(cwd, hookOptions(secondClient, secondStorage)));
    await waitFor(() => expect(first.result.current.document.reference).toBe("base"));
    await waitFor(() => expect(second.result.current.document.reference).toBe("base"));
    firstClient.deferSaves = true;
    secondClient.deferSaves = true;

    act(() => first.result.current.onChange("first reference"));
    act(() => second.result.current.changeCurrentFocus("second focus"));
    await waitFor(() => expect(firstClient.pendingSaves).toHaveLength(1));
    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(1));
    act(() => firstClient.flushNextSave());
    act(() => secondClient.flushNextSave());
    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(1));
    act(() => secondClient.flushNextSave());

    await waitFor(() => expect(server.snapshots.get(cwd)?.revision).toBe(3));
    await waitFor(() => expect(first.result.current.document.currentFocus).toBe("second focus"));
    expect(first.result.current.document.reference).toBe("first reference");
    expect(second.result.current.document).toEqual(first.result.current.document);
  });

  it("creates, edits, links, unlinks, and safely deletes a stable shared reference", async () => {
    const cwd = "/work/project";
    const storage = new MemoryStorage();
    const repository = createNotesRepository(storage, testClock);
    const initial = notes("free-form");
    initial.phases = [phase("active", 0), { ...phase("archived", 1), archivedAt: NOW }];
    seed(storage, cwd, initial);
    const hook = renderHook(() =>
      useProjectNotes(cwd, {
        storage,
        repository,
        clock: testClock,
        idFactory: () => "ref-created",
      }),
    );
    await waitFor(() => expect(hook.result.current.document.phases).toHaveLength(2));

    act(() => {
      void hook.result.current.createReference(referenceInput(), ["active", "archived"]);
    });
    expect(hook.result.current.document.references).toEqual([
      { ...referenceInput(), id: "ref-created", capturedAt: LATER },
    ]);
    expect(hook.result.current.document.phases.map((item) => item.referenceIds)).toEqual([
      ["ref-created"],
      ["ref-created"],
    ]);
    expect(hook.result.current.document.phases[1]?.overrides.referenceIds).toEqual({
      value: ["ref-created"],
      source: "user",
      updatedAt: LATER,
    });

    act(() => {
      void hook.result.current.editReference("ref-created", {
        ...referenceInput(),
        relevance: "Updated evidence",
      });
    });
    expect(hook.result.current.document.references[0]).toMatchObject({
      id: "ref-created",
      capturedAt: LATER,
      relevance: "Updated evidence",
    });

    act(() => {
      void hook.result.current.deleteReference("ref-created");
    });
    expect(hook.result.current.document.references).toHaveLength(1);
    act(() => {
      void hook.result.current.unlinkReferenceFromPhase("ref-created", "active");
    });
    act(() => {
      void hook.result.current.unlinkReferenceFromPhase("ref-created", "archived");
    });
    expect(hook.result.current.document.phases.map((item) => item.referenceIds)).toEqual([[], []]);
    act(() => {
      void hook.result.current.deleteReference("ref-created");
    });
    expect(hook.result.current.document.references).toEqual([]);
  });

  it("converges concurrent identical creates on one reference and merges requested phase links", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    const initial = notes("base");
    initial.phases = [phase("one", 0), phase("two", 1)];
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: initial });
    const firstClient = server.connect(cwd);
    const secondClient = server.connect(cwd);
    const firstStorage = new MemoryStorage();
    const secondStorage = new MemoryStorage();
    const firstOptions = {
      ...hookOptions(firstClient, firstStorage),
      idFactory: () => "ref-first",
    };
    const secondOptions = {
      ...hookOptions(secondClient, secondStorage),
      idFactory: () => "ref-second",
    };
    const first = renderHook(() => useProjectNotes(cwd, firstOptions));
    const second = renderHook(() => useProjectNotes(cwd, secondOptions));
    await waitFor(() => expect(first.result.current.document.phases).toHaveLength(2));
    await waitFor(() => expect(second.result.current.document.phases).toHaveLength(2));
    firstClient.deferSaves = true;
    secondClient.deferSaves = true;

    act(() => {
      void first.result.current.createReference(referenceInput(), ["one"]);
    });
    act(() => {
      void second.result.current.createReference(referenceInput(), ["two"]);
    });
    await waitFor(() => expect(firstClient.pendingSaves).toHaveLength(1));
    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(1));
    act(() => firstClient.flushNextSave());
    act(() => secondClient.flushNextSave());
    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(1));
    act(() => secondClient.flushNextSave());

    await waitFor(() => expect(server.snapshots.get(cwd)?.revision).toBe(3));
    const persisted = server.snapshots.get(cwd)!.document;
    expect(persisted.references.map(({ id }) => id)).toEqual(["ref-first"]);
    expect(persisted.phases.map((item) => item.referenceIds)).toEqual([
      ["ref-first"],
      ["ref-first"],
    ]);
  });

  it("merges unrelated concurrent reference links and makes delete lose to a new link", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    const initial = notes("base");
    initial.references = [savedReference()];
    initial.phases = [phase("one", 0), phase("two", 1)];
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: initial });
    const deleteClient = server.connect(cwd);
    const linkClient = server.connect(cwd);
    const deleteOptions = hookOptions(deleteClient, new MemoryStorage());
    const linkOptions = hookOptions(linkClient, new MemoryStorage());
    const deleting = renderHook(() => useProjectNotes(cwd, deleteOptions));
    const linking = renderHook(() => useProjectNotes(cwd, linkOptions));
    await waitFor(() => expect(deleting.result.current.document.references).toHaveLength(1));
    await waitFor(() => expect(linking.result.current.document.references).toHaveLength(1));
    deleteClient.deferSaves = true;
    linkClient.deferSaves = true;

    let deleteResult!: Promise<NotesReferenceOperationResult>;
    act(() => {
      deleteResult = deleting.result.current.deleteReference("ref-1");
    });
    act(() => {
      void linking.result.current.linkReferenceToPhase("ref-1", "one");
    });
    await waitFor(() => expect(deleteClient.pendingSaves).toHaveLength(1));
    await waitFor(() => expect(linkClient.pendingSaves).toHaveLength(1));
    act(() => linkClient.flushNextSave());
    act(() => deleteClient.flushNextSave());

    await waitFor(() => expect(deleteClient.pendingSaves).toHaveLength(0));
    let deleteOutcome: NotesReferenceOperationResult | undefined;
    await act(async () => {
      deleteOutcome = await deleteResult;
    });
    expect(deleteOutcome).toEqual({ status: "linked-blocked", phaseIds: ["one"] });
    expect(server.snapshots.get(cwd)).toMatchObject({
      revision: 2,
      document: {
        references: [{ id: "ref-1" }],
        phases: [{ id: "one", referenceIds: ["ref-1"] }, { id: "two" }],
      },
    });
  });

  it("merges unrelated concurrent links without replacing either phase reference set", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    const initial = notes("base");
    initial.references = [savedReference()];
    initial.phases = [phase("one", 0), phase("two", 1)];
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: initial });
    const firstClient = server.connect(cwd);
    const secondClient = server.connect(cwd);
    const firstOptions = hookOptions(firstClient, new MemoryStorage());
    const secondOptions = hookOptions(secondClient, new MemoryStorage());
    const first = renderHook(() => useProjectNotes(cwd, firstOptions));
    const second = renderHook(() => useProjectNotes(cwd, secondOptions));
    await waitFor(() => expect(first.result.current.document.references).toHaveLength(1));
    await waitFor(() => expect(second.result.current.document.references).toHaveLength(1));
    firstClient.deferSaves = true;
    secondClient.deferSaves = true;

    act(() => {
      void first.result.current.linkReferenceToPhase("ref-1", "one");
    });
    act(() => {
      void second.result.current.linkReferenceToPhase("ref-1", "two");
    });
    await waitFor(() => expect(firstClient.pendingSaves).toHaveLength(1));
    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(1));
    act(() => firstClient.flushNextSave());
    act(() => secondClient.flushNextSave());
    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(1));
    act(() => secondClient.flushNextSave());

    await waitFor(() => expect(server.snapshots.get(cwd)?.revision).toBe(3));
    expect(server.snapshots.get(cwd)?.document.phases.map((item) => item.referenceIds)).toEqual([
      ["ref-1"],
      ["ref-1"],
    ]);
  });

  it("drops a stale edit when its canonical identity collides after conflict replay", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    const initial = notes("base");
    initial.references = [savedReference()];
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: initial });
    const createClient = server.connect(cwd);
    const editClient = server.connect(cwd);
    const createOptions = {
      ...hookOptions(createClient, new MemoryStorage()),
      idFactory: () => "ref-winner",
    };
    const editOptions = hookOptions(editClient, new MemoryStorage());
    const creating = renderHook(() => useProjectNotes(cwd, createOptions));
    const editing = renderHook(() => useProjectNotes(cwd, editOptions));
    await waitFor(() => expect(creating.result.current.document.references).toHaveLength(1));
    await waitFor(() => expect(editing.result.current.document.references).toHaveLength(1));
    createClient.deferSaves = true;
    editClient.deferSaves = true;
    const collisionInput = referenceInput(
      "https://github.com/owner/repo/blob/main/src/other.ts#L1-L2",
    );

    act(() => {
      void creating.result.current.createReference(collisionInput, []);
    });
    let editResult!: Promise<NotesReferenceOperationResult>;
    act(() => {
      editResult = editing.result.current.editReference("ref-1", collisionInput);
    });
    await waitFor(() => expect(createClient.pendingSaves).toHaveLength(1));
    await waitFor(() => expect(editClient.pendingSaves).toHaveLength(1));
    act(() => createClient.flushNextSave());
    act(() => editClient.flushNextSave());

    await waitFor(() => expect(editClient.pendingSaves).toHaveLength(0));
    let editOutcome: NotesReferenceOperationResult | undefined;
    await act(async () => {
      editOutcome = await editResult;
    });
    expect(editOutcome).toEqual({ status: "collision", referenceId: "ref-winner" });
    const persisted = server.snapshots.get(cwd)!.document;
    expect(persisted.references).toHaveLength(2);
    expect(persisted.references.find((item) => item.id === "ref-1")?.canonicalUrl).toBe(
      savedReference().canonicalUrl,
    );
    expect(persisted.references.find((item) => item.id === "ref-winner")?.canonicalUrl).toBe(
      collisionInput.canonicalUrl,
    );
  });

  it("settles a rejected reference save and restores the authoritative document", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    const initial = notes("base");
    initial.references = [savedReference()];
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: initial });
    const client = server.connect(cwd);
    client.saveOutcome = {
      status: "invalid",
      error: { path: "references[0]", message: "invalid fixture" },
    };
    const storage = new MemoryStorage();
    const options = hookOptions(client, storage);
    const hook = renderHook(() => useProjectNotes(cwd, options));
    await waitFor(() => expect(hook.result.current.document.references).toHaveLength(1));

    let outcome: NotesReferenceOperationResult | undefined;
    await act(async () => {
      outcome = await hook.result.current.editReference("ref-1", {
        ...referenceInput(),
        relevance: "Rejected edit",
      });
    });

    expect(outcome).toEqual({ status: "failed", reason: "invalid" });
    await waitFor(() =>
      expect(hook.result.current.document.references[0]?.relevance).toBe("Reference evidence"),
    );
    expect(hook.result.current.diagnostics.authority[0]?.kind).toBe("save-failed");
  });

  it("rebases concurrent phase reorder and edit operations across windows", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    const initial = notes("base");
    initial.phases = [phase("one", 0), phase("two", 1)];
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: initial });
    const firstClient = server.connect(cwd);
    const secondClient = server.connect(cwd);
    const firstStorage = new MemoryStorage();
    const secondStorage = new MemoryStorage();
    const first = renderHook(() => useProjectNotes(cwd, hookOptions(firstClient, firstStorage)));
    const second = renderHook(() => useProjectNotes(cwd, hookOptions(secondClient, secondStorage)));
    await waitFor(() => expect(first.result.current.document.phases).toHaveLength(2));
    await waitFor(() => expect(second.result.current.document.phases).toHaveLength(2));
    firstClient.deferSaves = true;
    secondClient.deferSaves = true;

    act(() => first.result.current.movePhase("two", "up"));
    act(() =>
      second.result.current.editPhase("one", {
        title: "Phase one edited",
        goal: "Concurrent goal",
        doneWhen: ["Still ordered"],
      }),
    );
    await waitFor(() => expect(firstClient.pendingSaves).toHaveLength(1));
    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(1));
    act(() => firstClient.flushNextSave());
    act(() => secondClient.flushNextSave());
    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(1));
    act(() => secondClient.flushNextSave());

    await waitFor(() => expect(server.snapshots.get(cwd)?.revision).toBe(3));
    await waitFor(() =>
      expect(first.result.current.document).toEqual(second.result.current.document),
    );
    expect(first.result.current.document.phases.map((item) => item.id)).toEqual(["two", "one"]);
    expect(first.result.current.document.phases[1]).toMatchObject({
      title: "Phase one edited",
      goal: "Concurrent goal",
      order: 1,
    });
  });

  it("keeps an archived phase in its ordered slot while visible phases move and restore", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    const initial = notes("base");
    const archivedPhase = phase("B", 1);
    archivedPhase.archivedAt = NOW;
    initial.phases = [phase("A", 0), archivedPhase, phase("C", 2)];
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: initial });
    const client = server.connect(cwd);
    const storage = new MemoryStorage();
    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));
    await waitFor(() => expect(hook.result.current.document.phases).toHaveLength(3));
    client.deferSaves = true;

    act(() => hook.result.current.movePhase("C", "up"));
    await waitFor(() => expect(client.pendingSaves).toHaveLength(1));
    expect(client.pendingSaves[0]?.document.phases.map((item) => item.id)).toEqual(["C", "B", "A"]);

    act(() => hook.result.current.restorePhase("B"));
    act(() => client.flushNextSave());
    await waitFor(() => expect(client.pendingSaves).toHaveLength(1));
    act(() => client.flushNextSave());

    await waitFor(() => expect(server.snapshots.get(cwd)?.revision).toBe(3));
    const persisted = server.snapshots.get(cwd)!.document;
    await waitFor(() => expect(hook.result.current.document).toEqual(persisted));
    expect(persisted.phases.map((item) => item.id)).toEqual(["C", "B", "A"]);
    expect(persisted.phases.map((item) => item.order)).toEqual([0, 1, 2]);
    expect(persisted.phases[1]?.archivedAt).toBeNull();
  });

  it("drops a stale task operation that became invalid instead of resurrecting it", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, {
      projectKey: cwd,
      revision: 1,
      document: notes("base", "", [task()]),
    });
    const archiveClient = server.connect(cwd);
    const toggleClient = server.connect(cwd);
    const archiveStorage = new MemoryStorage();
    const toggleStorage = new MemoryStorage();
    const archiveHook = renderHook(() =>
      useProjectNotes(cwd, hookOptions(archiveClient, archiveStorage)),
    );
    const toggleHook = renderHook(() =>
      useProjectNotes(cwd, hookOptions(toggleClient, toggleStorage)),
    );
    await waitFor(() => expect(archiveHook.result.current.document.tasks).toHaveLength(1));
    await waitFor(() => expect(toggleHook.result.current.document.tasks).toHaveLength(1));
    archiveClient.deferSaves = true;
    toggleClient.deferSaves = true;

    act(() => archiveHook.result.current.archiveTask("task-1"));
    act(() => toggleHook.result.current.toggleTask("task-1"));
    await waitFor(() => expect(archiveClient.pendingSaves).toHaveLength(1));
    await waitFor(() => expect(toggleClient.pendingSaves).toHaveLength(1));
    act(() => archiveClient.flushNextSave());
    act(() => toggleClient.flushNextSave());

    await waitFor(() => expect(toggleClient.pendingSaves).toHaveLength(0));
    const winner = server.snapshots.get(cwd)!;
    expect(winner.revision).toBe(2);
    expect(winner.document.tasks[0]).toMatchObject({ status: "todo", archivedAt: LATER });
  });

  it("rebases concurrent identical toggles to one target status", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, {
      projectKey: cwd,
      revision: 1,
      document: notes("base", "", [task()]),
    });
    const firstClient = server.connect(cwd);
    const secondClient = server.connect(cwd);
    const firstStorage = new MemoryStorage();
    const secondStorage = new MemoryStorage();
    const first = renderHook(() => useProjectNotes(cwd, hookOptions(firstClient, firstStorage)));
    const second = renderHook(() => useProjectNotes(cwd, hookOptions(secondClient, secondStorage)));
    await waitFor(() => expect(first.result.current.document.tasks).toHaveLength(1));
    await waitFor(() => expect(second.result.current.document.tasks).toHaveLength(1));
    firstClient.deferSaves = true;
    secondClient.deferSaves = true;

    act(() => first.result.current.toggleTask("task-1"));
    act(() => second.result.current.toggleTask("task-1"));
    await waitFor(() => expect(firstClient.pendingSaves).toHaveLength(1));
    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(1));
    act(() => firstClient.flushNextSave());
    act(() => secondClient.flushNextSave());

    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(0));
    expect(server.snapshots.get(cwd)).toMatchObject({
      revision: 2,
      document: { tasks: [{ status: "done", completedAt: LATER }] },
    });
    expect(secondClient.saveCalls).toHaveLength(1);
  });

  it("rebases concurrent identical moves to one target order", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, {
      projectKey: cwd,
      revision: 1,
      document: notes("base", "", [task("task-1"), task("task-2"), task("task-3")]),
    });
    const firstClient = server.connect(cwd);
    const secondClient = server.connect(cwd);
    const firstStorage = new MemoryStorage();
    const secondStorage = new MemoryStorage();
    const first = renderHook(() => useProjectNotes(cwd, hookOptions(firstClient, firstStorage)));
    const second = renderHook(() => useProjectNotes(cwd, hookOptions(secondClient, secondStorage)));
    await waitFor(() => expect(first.result.current.document.tasks).toHaveLength(3));
    await waitFor(() => expect(second.result.current.document.tasks).toHaveLength(3));
    firstClient.deferSaves = true;
    secondClient.deferSaves = true;

    act(() => first.result.current.moveTask("task-3", "up"));
    act(() => second.result.current.moveTask("task-3", "up"));
    await waitFor(() => expect(firstClient.pendingSaves).toHaveLength(1));
    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(1));
    act(() => firstClient.flushNextSave());
    act(() => secondClient.flushNextSave());

    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(0));
    expect(server.snapshots.get(cwd)?.revision).toBe(2);
    expect(server.snapshots.get(cwd)?.document.tasks.map((item) => item.id)).toEqual([
      "task-1",
      "task-3",
      "task-2",
    ]);
    expect(secondClient.saveCalls).toHaveLength(1);
  });

  it("accepts a lower authoritative snapshot from a backup-recovery read", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    const client = server.connect(cwd);
    const opened = deferred<ProjectNotesReadOutcome>();
    client.getOverride = () => opened.promise;
    const storage = new MemoryStorage();
    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));

    act(() =>
      client.emit({
        type: "notes_change",
        data: { projectKey: cwd, revision: 5, document: notes("primary revision 5") },
      }),
    );
    await waitFor(() => expect(hook.result.current.document.reference).toBe("primary revision 5"));

    const recovered = {
      projectKey: cwd,
      revision: 4,
      document: notes("recovered backup revision 4"),
    };
    server.snapshots.set(cwd, recovered);
    act(() => opened.resolve({ status: "ok", snapshot: recovered, recoveredFromBackup: true }));

    await waitFor(() =>
      expect(hook.result.current.document.reference).toBe("recovered backup revision 4"),
    );
    act(() => hook.result.current.onChange("edit after recovery"));
    await waitFor(() =>
      expect(server.snapshots.get(cwd)?.document.reference).toBe("edit after recovery"),
    );
    expect(client.saveCalls.map((call) => call.expectedRevision)).toEqual([4]);
  });

  it("applies only newer same-project events", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 3, document: notes("current") });
    const client = server.connect(cwd);
    const storage = new MemoryStorage();
    const hook = renderHook(() => useProjectNotes(cwd, hookOptions(client, storage)));
    await waitFor(() => expect(hook.result.current.document.reference).toBe("current"));

    act(() => {
      client.emit({
        type: "notes_change",
        data: { projectKey: cwd, revision: 2, document: notes("stale") },
      });
      client.emit({
        type: "notes_change",
        data: { projectKey: "/work/other", revision: 99, document: notes("other") },
      });
    });
    expect(hook.result.current.document.reference).toBe("current");

    act(() =>
      client.emit({
        type: "notes_change",
        data: { projectKey: cwd, revision: 4, document: notes("newer") },
      }),
    );
    expect(hook.result.current.document.reference).toBe("newer");
  });

  it("creates one durable draft with exact prompt content and normalized order", async () => {
    const cwd = "/work/project";
    const initial = notes("base");
    initial.phases = [phase("existing", 4)];
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: initial });
    const client = server.connect(cwd);
    const options = {
      ...hookOptions(client, new MemoryStorage()),
      idFactory: () => "saved-prompt",
    };
    const hook = renderHook(() => useProjectNotes(cwd, options));
    await waitFor(() => expect(hook.result.current.document.phases).toHaveLength(1));

    let result!: Awaited<ReturnType<typeof hook.result.current.savePrompt>>;
    await act(async () => {
      result = await hook.result.current.savePrompt({
        kind: "new-draft",
        title: "Prompt draft",
        prompt: "Exact prompt\n  with indentation",
      });
    });

    expect(result).toEqual({ status: "committed", phaseId: "saved-prompt", title: "Prompt draft" });
    const saved = server.snapshots.get(cwd)!.document.phases;
    expect(saved.map((item) => item.order)).toEqual([0, 1]);
    expect(saved[1]).toMatchObject({
      id: "saved-prompt",
      status: "not-started",
      sourcePrompt: "Exact prompt\n  with indentation",
      goal: "",
      doneWhen: [],
      referenceIds: [],
      session: null,
      reminder: null,
    });
  });

  it("uses one monotonic timestamp policy for manual and prompt phase creation", async () => {
    const cwd = "/work/phase-clock-skew";
    const currentUpdatedAt = "2026-07-25T12:05:00.000Z";
    const initial = notes("base");
    initial.updatedAt = currentUpdatedAt;
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: initial });
    const client = server.connect(cwd);
    const storage = new MemoryStorage();
    const ids = ["manual-phase", "prompt-phase"];
    const skewedClock = (): string => NOW;
    const idFactory = (): string => ids.shift()!;
    const options = {
      ...hookOptions(client, storage),
      clock: skewedClock,
      idFactory,
    };
    const hook = renderHook(() => useProjectNotes(cwd, options));
    await waitFor(() => expect(hook.result.current.authorityReady).toBe(true));

    act(() =>
      hook.result.current.createPhase({
        title: "Manual phase",
        goal: "Keep timestamps monotonic",
        doneWhen: ["Created"],
      }),
    );
    await waitFor(() => expect(server.snapshots.get(cwd)?.document.phases).toHaveLength(1));
    await invokeMutation(() =>
      hook.result.current.savePrompt({
        kind: "new-draft",
        title: "Prompt phase",
        prompt: "Create from prompt",
      }),
    );

    const saved = server.snapshots.get(cwd)!.document;
    expect(saved.updatedAt).toBe(currentUpdatedAt);
    expect(saved.phases).toMatchObject([
      { id: "manual-phase", createdAt: currentUpdatedAt, updatedAt: currentUpdatedAt },
      { id: "prompt-phase", createdAt: currentUpdatedAt, updatedAt: currentUpdatedAt },
    ]);
  });

  it("updates only an existing phase prompt and refuses a concurrent replacement", async () => {
    const cwd = "/work/project";
    const initial = notes("base");
    initial.phases = [
      {
        ...phase("target", 0),
        status: "in-progress",
        sourcePrompt: "old prompt",
        referenceIds: ["ref-1"],
        session: { sessionId: "session-1", sessionPath: "/session" },
      },
    ];
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: initial });
    const firstClient = server.connect(cwd);
    const secondClient = server.connect(cwd);
    const firstOptions = hookOptions(firstClient, new MemoryStorage());
    const secondOptions = hookOptions(secondClient, new MemoryStorage());
    const first = renderHook(() => useProjectNotes(cwd, firstOptions));
    const second = renderHook(() => useProjectNotes(cwd, secondOptions));
    await waitFor(() => expect(first.result.current.document.phases).toHaveLength(1));
    await waitFor(() => expect(second.result.current.document.phases).toHaveLength(1));
    firstClient.deferSaves = true;
    secondClient.deferSaves = true;

    let firstSave!: ReturnType<typeof first.result.current.savePrompt>;
    let staleSave!: ReturnType<typeof second.result.current.savePrompt>;
    await act(async () => {
      firstSave = first.result.current.savePrompt({
        kind: "existing-phase",
        phaseId: "target",
        prompt: "first replacement",
        expectedSourcePrompt: "old prompt",
      });
      staleSave = second.result.current.savePrompt({
        kind: "existing-phase",
        phaseId: "target",
        prompt: "stale replacement",
        expectedSourcePrompt: "old prompt",
      });
    });
    await waitFor(() => expect(firstClient.pendingSaves).toHaveLength(1));
    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(1));

    let firstResult!: Awaited<typeof firstSave>;
    let staleResult!: Awaited<typeof staleSave>;
    await act(async () => {
      firstClient.flushNextSave();
      secondClient.flushNextSave();
      [firstResult, staleResult] = await Promise.all([firstSave, staleSave]);
    });
    expect(firstResult).toMatchObject({ status: "committed", phaseId: "target" });
    expect(staleResult).toEqual({
      status: "replacement-conflict",
      phaseId: "target",
      title: "Phase target",
    });
    expect(server.snapshots.get(cwd)!.document.phases[0]).toMatchObject({
      status: "in-progress",
      sourcePrompt: "first replacement",
      referenceIds: ["ref-1"],
      session: { sessionId: "session-1" },
    });
  });

  it("replays a stable new-draft ID without creating a duplicate", async () => {
    const cwd = "/work/project";
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: notes("base") });
    const firstClient = server.connect(cwd);
    const secondClient = server.connect(cwd);
    const firstOptions = {
      ...hookOptions(firstClient, new MemoryStorage()),
      idFactory: () => "same-draft",
    };
    const secondOptions = {
      ...hookOptions(secondClient, new MemoryStorage()),
      idFactory: () => "same-draft",
    };
    const first = renderHook(() => useProjectNotes(cwd, firstOptions));
    const second = renderHook(() => useProjectNotes(cwd, secondOptions));
    await waitFor(() => expect(first.result.current.document.reference).toBe("base"));
    await waitFor(() => expect(second.result.current.document.reference).toBe("base"));
    firstClient.deferSaves = true;
    secondClient.deferSaves = true;

    let firstSave!: ReturnType<typeof first.result.current.savePrompt>;
    let secondSave!: ReturnType<typeof second.result.current.savePrompt>;
    await act(async () => {
      firstSave = first.result.current.savePrompt({
        kind: "new-draft",
        title: "Winner",
        prompt: "first",
      });
      secondSave = second.result.current.savePrompt({
        kind: "new-draft",
        title: "Duplicate",
        prompt: "second",
      });
    });
    await waitFor(() => expect(firstClient.pendingSaves).toHaveLength(1));
    await waitFor(() => expect(secondClient.pendingSaves).toHaveLength(1));

    let firstResult!: Awaited<typeof firstSave>;
    let secondResult!: Awaited<typeof secondSave>;
    await act(async () => {
      firstClient.flushNextSave();
      secondClient.flushNextSave();
      [firstResult, secondResult] = await Promise.all([firstSave, secondSave]);
    });
    expect(firstResult).toMatchObject({ status: "committed" });
    expect(secondResult).toEqual({
      status: "committed",
      phaseId: "same-draft",
      title: "Winner",
    });
    expect(server.snapshots.get(cwd)!.document.phases).toHaveLength(1);
  });

  it("reports missing and archived destinations without redirecting", async () => {
    const cwd = "/work/project";
    const initial = notes("base");
    initial.phases = [{ ...phase("archived", 0), archivedAt: NOW }];
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: initial });
    const client = server.connect(cwd);
    const options = hookOptions(client, new MemoryStorage());
    const hook = renderHook(() => useProjectNotes(cwd, options));
    await waitFor(() => expect(hook.result.current.document.phases).toHaveLength(1));

    const missingResult = await invokeMutation(() =>
      hook.result.current.savePrompt({
        kind: "existing-phase",
        phaseId: "missing",
        prompt: "prompt",
        expectedSourcePrompt: "",
      }),
    );
    expect(missingResult).toEqual({ status: "missing-phase", phaseId: "missing" });

    const archivedResult = await invokeMutation(() =>
      hook.result.current.savePrompt({
        kind: "existing-phase",
        phaseId: "archived",
        prompt: "prompt",
        expectedSourcePrompt: "",
      }),
    );
    expect(archivedResult).toEqual({
      status: "archived-phase",
      phaseId: "archived",
      title: "Phase archived",
    });
    expect(client.saveCalls).toHaveLength(0);
  });

  it.each([
    { path: "phases", message: "invalid" },
    { path: "$", message: "notes request body exceeds 4194304 bytes" },
  ])("preserves an invalid sidecar save error through prompt settlement", async (error) => {
    const cwd = `/work/invalid-${error.path}`;
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: notes("base") });
    const client = server.connect(cwd);
    client.saveOutcome = { status: "invalid", error };
    const options = hookOptions(client, new MemoryStorage());
    const hook = renderHook(() => useProjectNotes(cwd, options));
    await waitFor(() => expect(hook.result.current.document.reference).toBe("base"));

    await act(async () => {
      await expect(
        hook.result.current.savePrompt({ kind: "new-draft", title: "Draft", prompt: "prompt" }),
      ).resolves.toEqual({ status: "failed", reason: "invalid", error });
    });
    expect(hook.result.current.document.phases).toHaveLength(0);
  });

  it.each([
    ["missing", { status: "missing" }],
    ["corrupt", { status: "corrupt", primary: "malformed-json", backup: null }],
  ] as const)("maps a %s sidecar save failure", async (reason, outcome) => {
    const cwd = `/work/${reason}`;
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: notes("base") });
    const client = server.connect(cwd);
    client.saveOutcome = outcome;
    const options = hookOptions(client, new MemoryStorage());
    const hook = renderHook(() => useProjectNotes(cwd, options));
    await waitFor(() => expect(hook.result.current.document.reference).toBe("base"));

    const result = await invokeMutation(() =>
      hook.result.current.savePrompt({ kind: "new-draft", title: "Draft", prompt: "prompt" }),
    );
    expect(result).toEqual({ status: "failed", reason });
  });

  it("maps unavailable and fallback storage failures", async () => {
    const cwd = "/work/unavailable";
    const server = new FakeNotesServer();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: notes("base") });
    const client = server.connect(cwd);
    client.saveError = new Error("offline");
    const sidecarOptions = hookOptions(client, new MemoryStorage());
    const sidecarHook = renderHook(() => useProjectNotes(cwd, sidecarOptions));
    await waitFor(() => expect(sidecarHook.result.current.document.reference).toBe("base"));
    const sidecarResult = await invokeMutation(() =>
      sidecarHook.result.current.savePrompt({
        kind: "new-draft",
        title: "Draft",
        prompt: "prompt",
      }),
    );
    expect(sidecarResult).toEqual({ status: "failed", reason: "unavailable" });

    const fallbackOptions: Parameters<typeof useProjectNotes>[1] = {
      repository: {
        load: () => ({
          document: notes("fallback"),
          value: "fallback",
          source: "empty",
          legacyKey: null,
          v2ImportAttempted: false,
          v2ImportSucceeded: null,
          legacyRecoveryAttempted: false,
          legacyRecoverySucceeded: null,
          diagnostics: [],
          migrationEligibility: "empty",
        }),
        save: () => ({
          v3: { key: "v3", ok: false, error: new Error("disk full") },
          legacy: { key: "legacy", ok: true },
        }),
      },
      storage: new MemoryStorage(),
      clock: testClock,
      idFactory: testIdFactory,
    };
    const fallbackHook = renderHook(() => useProjectNotes("/work/storage", fallbackOptions));
    await waitFor(() => expect(fallbackHook.result.current.document.reference).toBe("fallback"));
    const fallbackResult = await invokeMutation(() =>
      fallbackHook.result.current.savePrompt({
        kind: "new-draft",
        title: "Draft",
        prompt: "prompt",
      }),
    );
    expect(fallbackResult).toEqual({ status: "failed", reason: "storage" });
  });

  it("ignores late responses and callbacks from the previous project", async () => {
    const server = new FakeNotesServer();
    const slow = server.connect("/work/a");
    const getA = deferred<ProjectNotesReadOutcome>();
    slow.getOverride = () => getA.promise;
    server.snapshots.set("/work/b", {
      projectKey: "/work/b",
      revision: 1,
      document: notes("project B"),
    });
    const fast = server.connect("/work/b");
    const storage = new MemoryStorage();
    const hook = renderHook(
      ({ cwd, client }: { cwd: string; client: NotesClient }) =>
        useProjectNotes(cwd, hookOptions(client, storage)),
      { initialProps: { cwd: "/work/a", client: slow as NotesClient } },
    );

    hook.rerender({ cwd: "/work/b", client: fast });
    await waitFor(() => expect(hook.result.current.document.reference).toBe("project B"));
    act(() =>
      getA.resolve({
        status: "ok",
        recoveredFromBackup: false,
        snapshot: { projectKey: "/work/a", revision: 9, document: notes("late A") },
      }),
    );
    act(() =>
      slow.emit({
        type: "notes_change",
        data: { projectKey: "/work/a", revision: 10, document: notes("event A") },
      }),
    );

    await Promise.resolve();
    expect(hook.result.current.document.reference).toBe("project B");
    expect(slow.listeners.size).toBe(0);
  });

  it("accepts a pending proposal with canonical reuse and makes repeated decisions idempotent", async () => {
    const storage = new MemoryStorage();
    const document = addPendingRoadmapProposal(notes("proposal"));
    document.references = [savedReference("existing-ref")];
    seed(storage, "/work/proposal", document);
    let id = 0;
    const hook = renderHook(() =>
      useProjectNotes("/work/proposal", {
        storage,
        clock: testClock,
        idFactory: () => `generated-${++id}`,
      }),
    );

    const accepted = await invokeMutation(() =>
      hook.result.current.acceptReferenceProposal("phase-roadmap", "proposal-1"),
    );
    expect(accepted).toEqual({
      status: "committed",
      phaseId: "phase-roadmap",
      referenceId: "existing-ref",
    });
    await waitFor(() =>
      expect(hook.result.current.document.phases[0]!.roadmapEvents).toHaveLength(2),
    );
    expect(hook.result.current.document.references).toHaveLength(1);
    expect(hook.result.current.document.phases[0]).toMatchObject({
      referenceIds: ["existing-ref"],
      overrides: { referenceIds: { value: ["existing-ref"], source: "user" } },
      roadmapEvents: [
        expect.objectContaining({ type: "status-update" }),
        expect.objectContaining({
          type: "reference-decision",
          proposalId: "proposal-1",
          decision: "accepted",
          referenceId: "existing-ref",
        }),
      ],
    });
    const repeatedAcceptance = await invokeMutation(() =>
      hook.result.current.acceptReferenceProposal("phase-roadmap", "proposal-1"),
    );
    expect(repeatedAcceptance).toEqual({
      status: "already-decided",
      phaseId: "phase-roadmap",
      decision: "accepted",
    });

    const conflictingRejection = await invokeMutation(() =>
      hook.result.current.rejectReferenceProposal("phase-roadmap", "proposal-1"),
    );
    expect(conflictingRejection).toEqual({
      status: "decision-conflict",
      phaseId: "phase-roadmap",
      decision: "accepted",
    });
  });

  it("creates a valid reference when accepting a new proposal", async () => {
    const storage = new MemoryStorage();
    seed(storage, "/work/new-proposal", addPendingRoadmapProposal(notes("new proposal")));
    let id = 0;
    const hook = renderHook(() =>
      useProjectNotes("/work/new-proposal", {
        storage,
        clock: testClock,
        idFactory: () => `generated-${++id}`,
      }),
    );

    const result = await invokeMutation(() =>
      hook.result.current.acceptReferenceProposal("phase-roadmap", "proposal-1"),
    );
    expect(result).toEqual({
      status: "committed",
      phaseId: "phase-roadmap",
      referenceId: "generated-2",
    });
    await waitFor(() => expect(hook.result.current.document.references).toHaveLength(1));
    expect(hook.result.current.document.references[0]).toMatchObject({
      id: "generated-2",
      capturedAt: expect.any(String),
      canonicalUrl: "https://github.com/owner/repo/blob/main/src/file.ts#L1-L2",
    });
    expect(hook.result.current.document.references[0]).not.toHaveProperty("policyOutcome");
  });

  it("rejects a pending proposal without attaching it", async () => {
    const storage = new MemoryStorage();
    seed(storage, "/work/reject", addPendingRoadmapProposal(notes("reject")));
    let id = 0;
    const hook = renderHook(() =>
      useProjectNotes("/work/reject", {
        storage,
        clock: testClock,
        idFactory: () => `generated-${++id}`,
      }),
    );

    const result = await invokeMutation(() =>
      hook.result.current.rejectReferenceProposal("phase-roadmap", "proposal-1"),
    );
    expect(result).toEqual({ status: "committed", phaseId: "phase-roadmap" });
    await waitFor(() =>
      expect(hook.result.current.document.phases[0]!.roadmapEvents).toHaveLength(2),
    );
    expect(hook.result.current.document.references).toEqual([]);
    const rejectedEvents = hook.result.current.document.phases[0]!.roadmapEvents;
    expect(rejectedEvents[rejectedEvents.length - 1]).toMatchObject({
      type: "reference-decision",
      decision: "rejected",
      referenceId: null,
    });
  });

  it("saves only user-owned lifecycle, proposal-decision, and override-reset suffixes", async () => {
    const cwd = "/work/frontend-suffixes";
    const server = new FakeNotesServer();
    const document = addPendingRoadmapProposal(notes("frontend suffixes"), {
      statusOverride: true,
      referenceOverride: true,
      transition: "blocked",
    });
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document });
    const client = server.connect(cwd);
    let id = 0;
    const options = {
      ...hookOptions(client, new MemoryStorage()),
      idFactory: () => `frontend-${++id}`,
    };
    const hook = renderHook(() => useProjectNotes(cwd, options));
    await waitFor(() => expect(hook.result.current.document.phases).toHaveLength(1));

    act(() => hook.result.current.changePhaseStatus("phase-roadmap", "done"));
    await waitFor(() => expect(server.snapshots.get(cwd)?.document.phases[0]?.status).toBe("done"));
    let decision!: Awaited<ReturnType<typeof hook.result.current.rejectReferenceProposal>>;
    await act(async () => {
      decision = await hook.result.current.rejectReferenceProposal("phase-roadmap", "proposal-1");
    });
    expect(decision).toMatchObject({ status: "committed" });
    let statusReset!: Awaited<ReturnType<typeof hook.result.current.resumeAutomaticStatus>>;
    await act(async () => {
      statusReset = await hook.result.current.resumeAutomaticStatus("phase-roadmap");
    });
    expect(statusReset).toMatchObject({ status: "committed", resultingStatus: "done" });
    let referenceReset!: Awaited<ReturnType<typeof hook.result.current.resumeAutomaticReferences>>;
    await act(async () => {
      referenceReset = await hook.result.current.resumeAutomaticReferences("phase-roadmap");
    });
    expect(referenceReset).toMatchObject({ status: "committed" });

    const saved = server.snapshots.get(cwd)!;
    expect(saved.revision).toBe(5);
    expect(saved.document.phases[0]).toMatchObject({
      status: "done",
      overrides: { status: null, referenceIds: null },
      lifecycleEvents: [
        expect.objectContaining({
          fromStatus: "not-started",
          toStatus: "done",
          source: "user",
        }),
      ],
      roadmapEvents: [
        expect.objectContaining({ type: "status-update" }),
        expect.objectContaining({ type: "reference-decision", decision: "rejected" }),
        expect.objectContaining({ type: "override-reset", field: "status" }),
        expect.objectContaining({ type: "override-reset", field: "references" }),
      ],
    });
    expect(client.saveCalls).toHaveLength(4);
  });

  it("schedules, snoozes, and dismisses reminders without changing phase status", async () => {
    const cwd = "/work/reminder-mutations";
    const server = new FakeNotesServer();
    const document = notes("reminders");
    const reminderPhase = phase("phase-reminder", 0);
    reminderPhase.status = "in-progress";
    document.phases = [reminderPhase];
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document });
    const client = server.connect(cwd);
    const storage = new MemoryStorage();
    let id = 0;
    const hook = renderHook(() =>
      useProjectNotes(cwd, {
        ...hookOptions(client, storage),
        idFactory: () => `reminder-generated-${++id}`,
      }),
    );
    await waitFor(() => expect(hook.result.current.authorityReady).toBe(true));

    const scheduled = await invokeMutation(() =>
      hook.result.current.schedulePhaseReminder("phase-reminder", {
        dueAt: "2026-07-25T13:00:00.000Z",
        note: " Review the result ",
      }),
    );
    expect(scheduled).toEqual({
      status: "committed",
      phaseId: "phase-reminder",
      occurrenceKey: "reminder-generated-1",
    });
    await waitFor(() =>
      expect(hook.result.current.document.phases[0]!.reminder?.occurrenceKey).toBe(
        "reminder-generated-1",
      ),
    );
    expect(hook.result.current.document.phases[0]).toMatchObject({
      status: "in-progress",
      reminder: {
        id: "reminder-generated-2",
        occurrenceKey: "reminder-generated-1",
        dueAt: "2026-07-25T13:00:00.000Z",
        note: "Review the result",
        lastDelivery: null,
      },
    });

    const claimed = structuredClone(server.snapshots.get(cwd)!);
    claimed.revision += 1;
    claimed.document.phases[0]!.reminder!.lastDelivery = {
      occurrenceKey: "reminder-generated-1",
      attemptedAt: "2026-07-25T13:00:01.000Z",
      channel: "in-app",
      permission: "not-required",
    };
    server.snapshots.set(cwd, claimed);
    act(() => client.emit({ type: "notes_change", data: claimed }));
    await waitFor(() =>
      expect(hook.result.current.document.phases[0]!.reminder!.lastDelivery).not.toBeNull(),
    );

    const snoozed = await invokeMutation(() =>
      hook.result.current.snoozePhaseReminder("phase-reminder", "2026-07-25T14:00:00.000Z"),
    );
    expect(snoozed).toEqual({
      status: "committed",
      phaseId: "phase-reminder",
      occurrenceKey: "reminder-generated-3",
    });
    await waitFor(() =>
      expect(hook.result.current.document.phases[0]!.reminder?.occurrenceKey).toBe(
        "reminder-generated-3",
      ),
    );
    expect(hook.result.current.document.phases[0]).toMatchObject({
      status: "in-progress",
      reminder: {
        id: "reminder-generated-2",
        occurrenceKey: "reminder-generated-3",
        note: "Review the result",
        lastDelivery: { occurrenceKey: "reminder-generated-1", channel: "in-app" },
      },
    });

    const dismissed = await invokeMutation(() =>
      hook.result.current.dismissPhaseReminder("phase-reminder"),
    );
    expect(dismissed).toEqual({ status: "committed", phaseId: "phase-reminder" });
    await waitFor(() => expect(hook.result.current.document.phases[0]!.reminder).toBeNull());
    expect(hook.result.current.document.phases[0]).toMatchObject({
      status: "in-progress",
      reminder: null,
    });
  });

  it("rejects a generated reminder-ID collision before local fallback persistence", async () => {
    const cwd = "/work/reminder-id-collision";
    const storage = new MemoryStorage();
    const document = notes("reminder ID collision");
    const target = phase("target", 0);
    const occupied = phase("occupied", 1);
    occupied.reminder = {
      id: "shared-reminder-id",
      occurrenceKey: "occupied-occurrence",
      dueAt: "2026-07-25T13:00:00.000Z",
      note: "Existing reminder",
      createdAt: NOW,
      lastDelivery: null,
    };
    document.phases = [target, occupied];
    seed(storage, cwd, document);
    const generatedIds = ["new-occurrence", "shared-reminder-id"];
    let mutationClockCalls = 0;
    const mutationClock = () => {
      mutationClockCalls += 1;
      return LATER;
    };
    const hook = renderHook(() =>
      useProjectNotes(cwd, {
        storage,
        clock: mutationClock,
        idFactory: () => generatedIds.shift()!,
      }),
    );
    await waitFor(() => expect(hook.result.current.document.phases).toHaveLength(2));
    mutationClockCalls = 0;

    await expect(
      hook.result.current.schedulePhaseReminder("target", {
        dueAt: "2026-07-25T14:00:00.000Z",
        note: "Colliding reminder",
      }),
    ).resolves.toEqual({
      status: "failed",
      reason: "validation",
      error: {
        path: "phases[0].reminder.id",
        message: "duplicate reminder ID; already used at phases[1].reminder.id",
      },
    });
    expect(mutationClockCalls).toBe(1);
    expect(hook.result.current.document.phases[0]!.reminder).toBeNull();
    expect(JSON.parse(storage.getItem(v3NotesKey(cwd))!)).toMatchObject({
      phases: [{ reminder: null }, { reminder: { id: "shared-reminder-id" } }],
    });
  });

  it("drops a queued occurrence-key collision after conflict replay instead of saving it", async () => {
    const cwd = "/work/reminder-occurrence-replay-collision";
    const server = new FakeNotesServer();
    const document = notes("reminder occurrence replay collision");
    document.phases = [phase("target", 0), phase("remote", 1)];
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document });
    const client = server.connect(cwd);
    client.deferSaves = true;
    const storage = new MemoryStorage();
    const generatedIds = ["replay-occurrence", "target-reminder"];
    const hook = renderHook(() =>
      useProjectNotes(cwd, {
        ...hookOptions(client, storage),
        idFactory: () => generatedIds.shift()!,
      }),
    );
    await waitFor(() => expect(hook.result.current.authorityReady).toBe(true));

    let resultPromise!: ReturnType<typeof hook.result.current.schedulePhaseReminder>;
    await act(async () => {
      resultPromise = hook.result.current.schedulePhaseReminder("target", {
        dueAt: "2026-07-25T14:00:00.000Z",
        note: "Queued reminder",
      });
    });
    await waitFor(() => expect(client.pendingSaves).toHaveLength(1));

    const remote = structuredClone(server.snapshots.get(cwd)!);
    remote.revision = 2;
    remote.document.phases[1]!.reminder = {
      id: "remote-reminder",
      occurrenceKey: "replay-occurrence",
      dueAt: "2026-07-25T13:00:00.000Z",
      note: "Remote winner",
      createdAt: NOW,
      lastDelivery: null,
    };
    server.snapshots.set(cwd, remote);
    let result!: Awaited<typeof resultPromise>;
    await act(async () => {
      client.flushNextSave();
      result = await resultPromise;
    });

    expect(result).toEqual({
      status: "failed",
      reason: "validation",
      error: {
        path: "phases[0].reminder.occurrenceKey",
        message: "duplicate occurrence key; already used at phases[1].reminder.occurrenceKey",
      },
    });
    expect(client.saveCalls).toHaveLength(1);
    expect(server.snapshots.get(cwd)?.document.phases).toMatchObject([
      { reminder: null },
      { reminder: { id: "remote-reminder", occurrenceKey: "replay-occurrence" } },
    ]);
    await waitFor(() => expect(hook.result.current.document.phases[0]!.reminder).toBeNull());
  });

  it.each(["snooze", "dismiss"] as const)(
    "rejects a stale alert %s after conflict replay without mutating the replacement occurrence",
    async (actionName) => {
      const cwd = `/work/stale-${actionName}`;
      const server = new FakeNotesServer();
      const document = notes("stale alert reminder");
      const reminderPhase = phase("phase-reminder", 0);
      reminderPhase.status = "in-progress";
      reminderPhase.reminder = {
        id: "reminder-1",
        occurrenceKey: "occurrence-a",
        dueAt: NOW,
        note: "Occurrence A",
        createdAt: NOW,
        lastDelivery: null,
      };
      document.phases = [reminderPhase];
      server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document });
      const client = server.connect(cwd);
      client.deferSaves = true;
      const storage = new MemoryStorage();
      let id = 0;
      const hook = renderHook(() =>
        useProjectNotes(cwd, {
          ...hookOptions(client, storage),
          idFactory: () => `replacement-${++id}`,
        }),
      );
      await waitFor(() => expect(hook.result.current.authorityReady).toBe(true));

      let resultPromise!: Promise<NotesReminderMutationResult>;
      act(() => {
        resultPromise =
          actionName === "snooze"
            ? hook.result.current.snoozePhaseReminder(
                "phase-reminder",
                "2026-07-25T13:00:00.000Z",
                "occurrence-a",
              )
            : hook.result.current.dismissPhaseReminder("phase-reminder", "occurrence-a");
      });
      await waitFor(() => expect(client.pendingSaves).toHaveLength(1));

      const replacement = structuredClone(server.snapshots.get(cwd)!);
      replacement.revision = 2;
      replacement.document.phases[0]!.reminder = {
        ...replacement.document.phases[0]!.reminder!,
        occurrenceKey: "occurrence-b",
        dueAt: "2026-07-25T14:00:00.000Z",
        note: "Occurrence B",
      };
      server.snapshots.set(cwd, replacement);
      act(() => client.flushNextSave());

      let result!: NotesReminderMutationResult;
      await act(async () => {
        result = await resultPromise;
      });
      expect(result).toEqual({
        status: "stale-occurrence",
        phaseId: "phase-reminder",
        expectedOccurrenceKey: "occurrence-a",
        actualOccurrenceKey: "occurrence-b",
      });
      expect(client.saveCalls).toHaveLength(1);
      expect(server.snapshots.get(cwd)?.document.phases[0]!.reminder).toMatchObject({
        occurrenceKey: "occurrence-b",
        dueAt: "2026-07-25T14:00:00.000Z",
        note: "Occurrence B",
      });
      await waitFor(() =>
        expect(hook.result.current.document.phases[0]!.reminder?.occurrenceKey).toBe(
          "occurrence-b",
        ),
      );
    },
  );

  it("revalidates a future reminder after conflict replay and rejects it when time has passed", async () => {
    const cwd = "/work/reminder-stale-replay";
    const server = new FakeNotesServer();
    const document = notes("stale reminder");
    document.phases = [phase("phase-reminder", 0)];
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document });
    const client = server.connect(cwd);
    const storage = new MemoryStorage();
    client.deferSaves = true;
    let now = "2026-07-25T12:01:00.000Z";
    let mutationClockCalls = 0;
    const mutableClock = () => {
      mutationClockCalls += 1;
      return now;
    };
    let id = 0;
    const hook = renderHook(() =>
      useProjectNotes(cwd, {
        ...hookOptions(client, storage),
        clock: mutableClock,
        idFactory: () => `stale-${++id}`,
      }),
    );
    await waitFor(() => expect(hook.result.current.authorityReady).toBe(true));
    mutationClockCalls = 0;

    let resultPromise!: ReturnType<typeof hook.result.current.schedulePhaseReminder>;
    await act(async () => {
      resultPromise = hook.result.current.schedulePhaseReminder("phase-reminder", {
        dueAt: "2026-07-25T12:02:00.000Z",
        note: "Soon",
      });
    });
    await waitFor(() => expect(client.pendingSaves).toHaveLength(1));
    expect(mutationClockCalls).toBe(1);
    server.snapshots.set(cwd, { ...server.snapshots.get(cwd)!, revision: 2 });
    now = "2026-07-25T12:03:00.000Z";
    let result!: Awaited<typeof resultPromise>;
    await act(async () => {
      client.flushNextSave();
      result = await resultPromise;
    });

    expect(result).toEqual({
      status: "invalid-time",
      phaseId: "phase-reminder",
    });
    expect(mutationClockCalls).toBe(2);
    expect(client.saveCalls).toHaveLength(1);
    await waitFor(() => expect(hook.result.current.document.phases[0]!.reminder).toBeNull());
  });

  it("returns typed reminder guards for missing, archived, inactive, and malformed requests", async () => {
    const storage = new MemoryStorage();
    const document = notes("reminder guards");
    const archived = phase("archived", 0);
    archived.archivedAt = LATER;
    const inactive = phase("inactive", 1);
    inactive.status = "done";
    inactive.completedAt = LATER;
    document.phases = [archived, inactive];
    seed(storage, "/work/reminder-guards", document);
    let id = 0;
    const hook = renderHook(() =>
      useProjectNotes("/work/reminder-guards", {
        storage,
        clock: testClock,
        idFactory: () => `guard-${++id}`,
      }),
    );

    await expect(
      hook.result.current.schedulePhaseReminder("missing", {
        dueAt: "2026-07-25T13:00:00.000Z",
        note: "Missing",
      }),
    ).resolves.toEqual({ status: "missing-phase", phaseId: "missing" });
    await expect(
      hook.result.current.schedulePhaseReminder("archived", {
        dueAt: "2026-07-25T13:00:00.000Z",
        note: "Archived",
      }),
    ).resolves.toEqual({ status: "archived-phase", phaseId: "archived" });
    await expect(
      hook.result.current.schedulePhaseReminder("inactive", {
        dueAt: "2026-07-25T13:00:00.000Z",
        note: "Inactive",
      }),
    ).resolves.toEqual({ status: "inactive-phase", phaseId: "inactive" });
    await expect(
      hook.result.current.schedulePhaseReminder("inactive", { dueAt: "bad", note: "Bad" }),
    ).resolves.toEqual({ status: "inactive-phase", phaseId: "inactive" });
    await expect(hook.result.current.snoozePhaseReminder("archived", "bad")).resolves.toEqual({
      status: "archived-phase",
      phaseId: "archived",
    });
  });

  it("applies a suppressed plan approval immediately when automatic status resumes", async () => {
    const storage = new MemoryStorage();
    seed(storage, "/work/pending-plan-approval", pendingPlanApprovalDocument());
    let id = 0;
    const hook = renderHook(() =>
      useProjectNotes("/work/pending-plan-approval", {
        storage,
        clock: testClock,
        idFactory: () => `reset-${++id}`,
      }),
    );

    const result = await invokeMutation(() =>
      hook.result.current.resumeAutomaticStatus("phase-planning"),
    );
    expect(result).toEqual({
      status: "committed",
      phaseId: "phase-planning",
      resultingStatus: "in-progress",
    });
    await waitFor(() =>
      expect(hook.result.current.document.phases[0]!.overrides.status).toBeNull(),
    );
    const persisted = hook.result.current.document.phases[0]!;
    expect(persisted).toMatchObject({
      status: "in-progress",
      attentionReason: null,
      pendingAutomaticLifecycleTransition: null,
      lifecycleEvents: [
        expect.objectContaining({ id: "planning-started", toStatus: "planning" }),
        expect.objectContaining({
          fromStatus: "planning",
          toStatus: "in-progress",
          source: "user",
          reason: "Plan approved by user",
          kind: "approval-resolved",
        }),
      ],
      roadmapEvents: [expect.objectContaining({ type: "override-reset", field: "status" })],
    });
    expect(persisted.lifecycleEvents).toHaveLength(2);
  });

  it("keeps the suppressed cancellation timestamp when automatic status resumes later", async () => {
    const storage = new MemoryStorage();
    const document = pendingPlanApprovalDocument();
    const selected = document.phases[0]!;
    selected.pendingAutomaticLifecycleTransition = {
      status: "cancelled",
      source: "user",
      reason: "Phase run cancelled by user",
      kind: "other",
      timestamp: LATER,
      expectedSession: { ...selected.session! },
    };
    const resetAt = "2026-07-25T12:02:00.000Z";
    const resetClock = (): string => resetAt;
    seed(storage, "/work/pending-cancellation", document);
    let id = 0;
    const createId = (): string => `cancel-reset-${++id}`;
    const hook = renderHook(() =>
      useProjectNotes("/work/pending-cancellation", {
        storage,
        clock: resetClock,
        idFactory: createId,
      }),
    );

    const result = await invokeMutation(() =>
      hook.result.current.resumeAutomaticStatus("phase-planning"),
    );

    expect(result).toEqual({
      status: "committed",
      phaseId: "phase-planning",
      resultingStatus: "cancelled",
    });
    const persisted = hook.result.current.document.phases[0]!;
    expect(persisted).toMatchObject({
      status: "cancelled",
      completedAt: LATER,
      pendingAutomaticLifecycleTransition: null,
      lifecycleEvents: [
        expect.any(Object),
        expect.objectContaining({
          fromStatus: "planning",
          toStatus: "cancelled",
          timestamp: resetAt,
          reason: "Phase run cancelled by user",
        }),
      ],
    });
  });

  it("replays a status reset onto a newer Reviewing target after a CAS conflict", async () => {
    const cwd = "/work/pending-status-cas";
    const server = new FakeNotesServer();
    const initial = pendingPlanApprovalDocument();
    server.snapshots.set(cwd, { projectKey: cwd, revision: 1, document: initial });
    const client = server.connect(cwd);
    client.deferSaves = true;
    const storage = new MemoryStorage();
    let id = 0;
    const hook = renderHook(() =>
      useProjectNotes(cwd, {
        ...hookOptions(client, storage),
        idFactory: () => `cas-reset-${++id}`,
      }),
    );
    await waitFor(() => expect(hook.result.current.authorityReady).toBe(true));

    let resultPromise!: ReturnType<typeof hook.result.current.resumeAutomaticStatus>;
    act(() => {
      resultPromise = hook.result.current.resumeAutomaticStatus("phase-planning");
    });
    await waitFor(() => expect(client.pendingSaves).toHaveLength(1));
    expect(client.pendingSaves[0]!.document.phases[0]!.status).toBe("in-progress");

    const remote = structuredClone(server.snapshots.get(cwd)!);
    remote.revision = 2;
    remote.document.updatedAt = "2026-07-25T12:02:00.000Z";
    remote.document.phases[0]!.updatedAt = "2026-07-25T12:02:00.000Z";
    remote.document.phases[0]!.pendingAutomaticLifecycleTransition = {
      status: "review",
      source: "agent",
      reason: "Autopilot review started",
      kind: "other",
      timestamp: "2026-07-25T12:02:00.000Z",
      expectedSession: { ...remote.document.phases[0]!.session! },
    };
    server.snapshots.set(cwd, remote);
    act(() => client.flushNextSave());
    await waitFor(() => expect(client.pendingSaves).toHaveLength(1));
    expect(client.pendingSaves[0]!.expectedRevision).toBe(2);
    expect(client.pendingSaves[0]!.document.phases[0]).toMatchObject({
      status: "review",
      pendingAutomaticLifecycleTransition: null,
    });

    act(() => client.flushNextSave());
    let result!: Awaited<typeof resultPromise>;
    await act(async () => {
      result = await resultPromise;
    });
    expect(result).toMatchObject({ status: "committed", resultingStatus: "review" });
    expect(server.snapshots.get(cwd)?.document.phases[0]).toMatchObject({
      status: "review",
      overrides: { status: null },
      pendingAutomaticLifecycleTransition: null,
      lifecycleEvents: [
        expect.objectContaining({ toStatus: "planning" }),
        expect.objectContaining({
          fromStatus: "planning",
          toStatus: "review",
          source: "agent",
          reason: "Autopilot review started",
          kind: "other",
        }),
      ],
    });
  });

  it("resumes status from the latest protected report and resets references without changing links", async () => {
    const storage = new MemoryStorage();
    const document = addPendingRoadmapProposal(notes("reset"), {
      statusOverride: true,
      referenceOverride: true,
      transition: "blocked",
    });
    document.references = [savedReference("existing-ref")];
    document.phases[0]!.referenceIds = ["existing-ref"];
    document.phases[0]!.overrides.referenceIds = {
      value: ["existing-ref"],
      source: "user",
      updatedAt: NOW,
    };
    seed(storage, "/work/reset", document);
    let id = 0;
    const hook = renderHook(() =>
      useProjectNotes("/work/reset", {
        storage,
        clock: testClock,
        idFactory: () => `generated-${++id}`,
      }),
    );

    const statusResult = await invokeMutation(() =>
      hook.result.current.resumeAutomaticStatus("phase-roadmap"),
    );
    expect(statusResult).toEqual({
      status: "committed",
      phaseId: "phase-roadmap",
      resultingStatus: "needs-attention",
    });

    const referencesResult = await invokeMutation(() =>
      hook.result.current.resumeAutomaticReferences("phase-roadmap"),
    );
    expect(referencesResult).toEqual({
      status: "committed",
      phaseId: "phase-roadmap",
    });
    await waitFor(() =>
      expect(hook.result.current.document.phases[0]!.overrides.referenceIds).toBeNull(),
    );
    expect(hook.result.current.document.phases[0]).toMatchObject({
      status: "needs-attention",
      attentionReason: "Waiting for CI",
      referenceIds: ["existing-ref"],
      overrides: { status: null, referenceIds: null },
    });
    expect(
      hook.result.current.document.phases[0]!.roadmapEvents.filter(
        (event) => event.type === "override-reset",
      ),
    ).toHaveLength(2);
  });
});
