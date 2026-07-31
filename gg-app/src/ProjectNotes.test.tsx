// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectNotes, type ProjectNotesPromptActions } from "./ProjectNotes";
import { dateToLocalInputValue } from "./roadmap-reminders";
import {
  NOTES_REFERENCE_METADATA_MAX_LENGTH,
  NOTES_REFERENCE_URL_MAX_LENGTH,
} from "./notes-reference";
import {
  canonicalProjectKey,
  createEmptyNotesDocument,
  legacyNotesKey,
  v3NotesKey,
} from "./notes-storage";
import type {
  NotesClient,
  NotesDocumentV3,
  NotesPhase,
  NotesPhaseStatus,
  NotesReference,
  NotesRoadmapEvent,
  NotesSidecarEvent,
  ProjectNotesMigrationOutcome,
  ProjectNotesReadOutcome,
  ProjectNotesSaveOutcome,
  ProjectNotesSnapshot,
  ReminderClaimOutcome,
  ReminderReserveOutcome,
} from "./notes-types";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: tauriMocks.logError }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const NOW = "2026-07-15T12:00:00.000Z";

function notes(reference: string, taskCount = 0): NotesDocumentV3 {
  return {
    ...createEmptyNotesDocument(NOW),
    reference,
    currentFocus: `Focus ${reference}`,
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `task-${index}`,
      text: `Task ${index + 1}`,
      status: "todo" as const,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null,
      archivedAt: null,
    })),
  };
}

function phase(id: string, status: NotesPhaseStatus, withReminder = false): NotesPhase {
  return {
    id,
    title: `Phase ${id}`,
    goal: "Verify the Notes shell",
    doneWhen: ["Shell evidence passes"],
    order: 0,
    status,
    sourcePrompt: "Implement Phase 17",
    referenceIds: [],
    session: null,
    reminder: withReminder
      ? {
          id: `reminder-${id}`,
          occurrenceKey: `occurrence-${id}`,
          dueAt: NOW,
          note: "Review",
          createdAt: NOW,
          lastDelivery: null,
        }
      : null,
    attentionReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: status === "done" || status === "cancelled" ? NOW : null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: [],
  };
}

type PhaseSessionFixture = "unbound" | "missing-path" | "path-present";

function phaseSession(fixture: PhaseSessionFixture): NotesPhase["session"] {
  if (fixture === "unbound") return null;
  return {
    sessionId: `session-${fixture}`,
    sessionPath: fixture === "missing-path" ? null : `/sessions/${fixture}.jsonl`,
  };
}

const PHASE_ACTION_MATRIX = [
  ["not-started", "unbound", "Start"],
  ["not-started", "missing-path", "Recover"],
  ["not-started", "path-present", "Resume"],
  ["planning", "unbound", "Start"],
  ["planning", "missing-path", "Recover"],
  ["planning", "path-present", "Resume"],
  ["waiting-for-approval", "unbound", "Start"],
  ["waiting-for-approval", "missing-path", "Recover"],
  ["waiting-for-approval", "path-present", "Resume"],
  ["in-progress", "unbound", "Start"],
  ["in-progress", "missing-path", "Recover"],
  ["in-progress", "path-present", "Resume"],
  ["review", "unbound", "Review"],
  ["review", "missing-path", "Review"],
  ["review", "path-present", "Review"],
  ["done", "unbound", "Review"],
  ["done", "missing-path", "Review"],
  ["done", "path-present", "Review"],
  ["needs-attention", "unbound", "Start"],
  ["needs-attention", "missing-path", "Recover"],
  ["needs-attention", "path-present", "Resume"],
  ["cancelled", "unbound", "Start"],
  ["cancelled", "missing-path", "Recover"],
  ["cancelled", "path-present", "Resume"],
] as const satisfies ReadonlyArray<
  readonly [NotesPhaseStatus, PhaseSessionFixture, "Start" | "Recover" | "Resume" | "Review"]
>;

function reminderReservation(selected: NotesPhase): ReminderReserveOutcome {
  if (!selected.reminder) throw new Error("Expected reminder");
  return {
    status: "reserved",
    leaseToken: `lease-${selected.reminder.occurrenceKey}`,
    expiresAt: "2026-07-29T12:00:15.000Z",
    phase: { id: selected.id, title: selected.title, session: selected.session },
    reminder: {
      id: selected.reminder.id,
      occurrenceKey: selected.reminder.occurrenceKey,
      dueAt: selected.reminder.dueAt,
      note: selected.reminder.note,
    },
  };
}

function implementationCheckpoint(
  completedPlanSteps: number[] = [1, 2],
  runOutcome: "succeeded" | "failed" | "cancelled" | "interrupted" = "succeeded",
): Extract<NotesRoadmapEvent, { type: "implementation-checkpoint" }> {
  return {
    type: "implementation-checkpoint",
    id: "checkpoint-ui",
    session: { sessionId: "session-ui", sessionPath: "/sessions/ui.jsonl" },
    planStepTotal: 2,
    completedPlanSteps,
    runOutcome,
    timestamp: NOW,
  };
}

function verificationReport(
  verification: "passed" | "failed" | "exception-requested",
  reason: string | null = verification === "passed" ? null : "Verification needs review.",
): Extract<NotesRoadmapEvent, { type: "status-update" }> {
  return {
    type: "status-update",
    id: `verification-ui-${verification}`,
    actor: "gg-coder",
    transition: verification === "failed" ? "blocked" : "review",
    progress: "Verification evidence recorded.",
    blocker: verification === "failed" ? reason : null,
    evidence: verification === "passed" ? ["pnpm test passed", "pnpm build passed"] : [],
    verification,
    verificationReason: reason,
    verificationSession: { sessionId: "session-ui", sessionPath: "/sessions/ui.jsonl" },
    statusOutcome: "same-status",
    proposedReferences: [],
    timestamp: "2026-07-15T12:01:00.000Z",
  };
}

function completionReview(
  options: Partial<Extract<NotesRoadmapEvent, { type: "completion-review" }>> = {},
): Extract<NotesRoadmapEvent, { type: "completion-review" }> {
  return {
    type: "completion-review",
    id: "completion-review-ui",
    reviewer: "ken-autopilot",
    decision: "accepted",
    evidence: ["Autopilot Ken reviewed the completion gates."],
    reason: null,
    implementationCheckpointId: "checkpoint-ui",
    verificationStatusUpdateId: "verification-ui-passed",
    acceptsVerificationException: false,
    gateOutcome: "done",
    unmetGateCodes: [],
    timestamp: "2026-07-15T12:02:00.000Z",
    ...options,
  };
}

function reference(
  id: string,
  owner = "owner",
  repo = "repo",
  path = "src/file.ts",
): NotesReference {
  return {
    id,
    provider: "github",
    tool: "search",
    canonicalUrl: `https://github.com/${owner}/${repo}/blob/main/${path}#L1-L2`,
    owner,
    repo,
    revision: "main",
    path,
    range: { startLine: 1, endLine: 2 },
    issue: null,
    pullRequest: null,
    query: "reference query",
    anchor: "L1-L2",
    relevance: `Evidence from ${owner}/${repo}`,
    capturedAt: NOW,
  };
}

function store(cwd: string, document: NotesDocumentV3): void {
  localStorage.setItem(v3NotesKey(cwd), JSON.stringify(document));
  localStorage.setItem(legacyNotesKey(cwd), document.reference);
}

function selectNotesTab(name: "Overview" | "Roadmap" | "Reference" | "Archive"): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

async function openRoadmapPhase(title: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
  selectNotesTab("Roadmap");
  fireEvent.click(screen.getByRole("button", { name: `Inspect phase: ${title}` }));
}

class FakeProjectNotesClient implements NotesClient {
  cwd: string;
  readonly snapshots = new Map<string, ProjectNotesSnapshot>();
  readonly listeners = new Set<(event: NotesSidecarEvent) => void>();
  migrations = 0;
  getOutcome: ProjectNotesReadOutcome | null = null;
  migrationError: unknown = null;
  saveOutcome: ProjectNotesSaveOutcome | null = null;
  beforeNextSave: (() => void) | null = null;
  readonly reserveCalls: boolean[] = [];
  readonly claimCalls: Array<{ leaseToken: string; channel: string; permission: string }> = [];
  readonly reserveOutcomes: ReminderReserveOutcome[] = [];
  claimOutcome: ReminderClaimOutcome | null = null;
  constructor(cwd: string) {
    this.cwd = cwd;
  }

  seed(cwd: string, document: NotesDocumentV3, revision = 1): void {
    const projectKey = canonicalProjectKey(cwd);
    this.snapshots.set(projectKey, { projectKey, revision, document });
  }

  async getNotes(): Promise<ProjectNotesReadOutcome> {
    if (this.getOutcome) return this.getOutcome;
    const snapshot = this.snapshots.get(canonicalProjectKey(this.cwd));
    return snapshot
      ? { status: "ok", snapshot, recoveredFromBackup: false }
      : { status: "missing" };
  }

  async migrateNotes(document: NotesDocumentV3): Promise<ProjectNotesMigrationOutcome> {
    if (this.migrationError) throw this.migrationError;
    const projectKey = canonicalProjectKey(this.cwd);
    const existing = this.snapshots.get(projectKey);
    if (existing) return { status: "ok", snapshot: existing, migrated: false };
    const snapshot = { projectKey, revision: 1, document };
    this.snapshots.set(projectKey, snapshot);
    this.migrations += 1;
    this.emit(snapshot);
    return { status: "ok", snapshot, migrated: true };
  }

  async saveNotes(
    expectedRevision: number,
    document: NotesDocumentV3,
  ): Promise<ProjectNotesSaveOutcome> {
    const beforeSave = this.beforeNextSave;
    this.beforeNextSave = null;
    beforeSave?.();
    if (this.saveOutcome) return this.saveOutcome;
    const projectKey = canonicalProjectKey(this.cwd);
    const current = this.snapshots.get(projectKey);
    if (!current) return { status: "missing" };
    if (current.revision !== expectedRevision) {
      return { status: "conflict", snapshot: current };
    }
    const snapshot = { projectKey, revision: expectedRevision + 1, document };
    this.snapshots.set(projectKey, snapshot);
    this.emit(snapshot);
    return { status: "ok", snapshot };
  }

  async reserveReminder(focused: boolean) {
    this.reserveCalls.push(focused);
    return this.reserveOutcomes.shift() ?? { status: "none" as const };
  }

  async claimReminder(
    leaseToken: string,
    channel: "in-app" | "native" | "in-app-fallback",
    permission: "not-required" | "granted" | "denied",
  ): Promise<ReminderClaimOutcome> {
    this.claimCalls.push({ leaseToken, channel, permission });
    if (this.claimOutcome) return this.claimOutcome;
    const projectKey = canonicalProjectKey(this.cwd);
    const current = this.snapshots.get(projectKey);
    const reservedOccurrence = leaseToken.replace(/^lease-/, "");
    const phase = current?.document.phases.find(
      (candidate) => candidate.reminder?.occurrenceKey === reservedOccurrence,
    );
    if (!current || !phase?.reminder) return { status: "stale-occurrence" };
    const document = structuredClone(current.document);
    const nextPhase = document.phases.find((candidate) => candidate.id === phase.id)!;
    nextPhase.reminder!.lastDelivery = {
      occurrenceKey: nextPhase.reminder!.occurrenceKey,
      attemptedAt: new Date().toISOString(),
      channel,
      permission,
    };
    const snapshot = { projectKey, revision: current.revision + 1, document };
    this.snapshots.set(projectKey, snapshot);
    this.emit(snapshot);
    return { status: "ok", snapshot, phase: nextPhase };
  }

  async releaseReminder() {
    return { status: "released" as const };
  }

  subscribe(listener: (event: NotesSidecarEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(cwd: string, document: NotesDocumentV3, revision: number): void {
    const projectKey = canonicalProjectKey(cwd);
    const snapshot = { projectKey, revision, document };
    this.snapshots.set(projectKey, snapshot);
    this.emit(snapshot);
  }

  private emit(snapshot: ProjectNotesSnapshot): void {
    for (const listener of this.listeners) listener({ type: "notes_change", data: snapshot });
  }
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  tauriMocks.invoke.mockReset();
  tauriMocks.logError.mockReset();
  vi.clearAllMocks();
});

describe("ProjectNotes", () => {
  it("refreshes queued reminder details and removes a stale occurrence after an authoritative snapshot", async () => {
    const cwd = "/work/reconciled-reminder";
    const client = new FakeProjectNotesClient(cwd);
    const initial = notes("reconciled reminder");
    const selected = phase("reconciled", "in-progress", true);
    initial.phases = [selected];
    client.seed(cwd, initial);
    client.reserveOutcomes.push(reminderReservation(selected), { status: "none" });

    render(<ProjectNotes cwd={cwd} client={client} />);
    expect(await screen.findByRole("region", { name: "Phase reconciled" })).toBeTruthy();

    const claimed = client.snapshots.get(canonicalProjectKey(cwd))!;
    const refreshed = structuredClone(claimed.document);
    refreshed.phases[0]!.title = "Authoritative title";
    refreshed.phases[0]!.session = {
      sessionId: "authoritative-session",
      sessionPath: "/sessions/authoritative",
    };
    refreshed.phases[0]!.reminder!.note = "Authoritative note";
    act(() => client.publish(cwd, refreshed, claimed.revision + 1));

    const refreshedAlert = await screen.findByRole("region", { name: "Authoritative title" });
    expect(refreshedAlert.textContent).toContain("Authoritative note");
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();

    const replaced = structuredClone(refreshed);
    replaced.phases[0]!.reminder!.occurrenceKey = "occurrence-replacement";
    replaced.phases[0]!.reminder!.note = "Replacement note";
    act(() => client.publish(cwd, replaced, claimed.revision + 2));

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Authoritative title" })).toBeNull(),
    );
    expect(screen.queryByText("Replacement note")).toBeNull();
  });

  it("queues alerts for two document-unique reminder occurrences without suppressing either", async () => {
    const cwd = "/work/two-reminder-alerts";
    const client = new FakeProjectNotesClient(cwd);
    const document = notes("two reminder alerts");
    const first = phase("first-alert", "in-progress", true);
    const second = phase("second-alert", "review", true);
    second.order = 1;
    second.reminder!.note = "Second alert note";
    document.phases = [first, second];
    client.seed(cwd, document);
    client.reserveOutcomes.push(reminderReservation(first), reminderReservation(second), {
      status: "none",
    });

    render(<ProjectNotes cwd={cwd} client={client} />);

    expect(await screen.findByRole("region", { name: "Phase first-alert" })).toBeTruthy();
    await waitFor(() => expect(client.claimCalls).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Open phase" }));

    const secondAlert = await screen.findByRole("region", { name: "Phase second-alert" });
    expect(secondAlert.textContent).toContain("Second alert note");
    expect(client.claimCalls.map((claim) => claim.leaseToken)).toEqual([
      "lease-occurrence-first-alert",
      "lease-occurrence-second-alert",
    ]);
  });

  it.each([
    { action: "Resume cleanup", buttonName: "Resume", withSession: true },
    { action: "Snooze", buttonName: "Snooze 1 hour", withSession: false },
    { action: "Dismiss", buttonName: "Dismiss reminder", withSession: false },
  ] as const)(
    "guards alert-originated $action when a conflict replaces the occurrence",
    async ({ action, buttonName, withSession }) => {
      const cwd = `/work/guarded-${action.toLowerCase().replace(/\s+/g, "-")}`;
      const client = new FakeProjectNotesClient(cwd);
      const initial = notes("guarded reminder");
      const selected = phase("guarded", "in-progress", true);
      if (withSession) {
        selected.session = { sessionId: "session-a", sessionPath: "/sessions/a" };
      }
      initial.phases = [selected];
      client.seed(cwd, initial);
      client.reserveOutcomes.push(reminderReservation(selected), { status: "none" });
      const onResumePhase = vi.fn(async () => undefined);

      render(<ProjectNotes cwd={cwd} client={client} onResumePhase={onResumePhase} />);
      expect(await screen.findByRole("region", { name: "Phase guarded" })).toBeTruthy();

      client.beforeNextSave = () => {
        const current = client.snapshots.get(canonicalProjectKey(cwd))!;
        const replacement = structuredClone(current.document);
        replacement.phases[0]!.reminder = {
          ...replacement.phases[0]!.reminder!,
          occurrenceKey: "occurrence-b",
          dueAt: "2026-08-01T12:00:00.000Z",
          note: "Newer reminder",
        };
        client.publish(cwd, replacement, current.revision + 1);
      };

      fireEvent.click(screen.getByRole("button", { name: buttonName }));

      await waitFor(() => expect(client.beforeNextSave).toBeNull());
      await waitFor(() =>
        expect(screen.queryByRole("region", { name: "Phase guarded" })).toBeNull(),
      );
      expect(client.snapshots.get(canonicalProjectKey(cwd))).toMatchObject({
        revision: 3,
        document: {
          phases: [
            {
              reminder: {
                occurrenceKey: "occurrence-b",
                dueAt: "2026-08-01T12:00:00.000Z",
                note: "Newer reminder",
              },
            },
          ],
        },
      });
      expect(onResumePhase).toHaveBeenCalledTimes(withSession ? 1 : 0);
    },
  );

  it.each([
    {
      action: "Resume cleanup",
      buttonName: "Resume phase",
      withSession: true,
      expectedMessage:
        "The phase resumed, but reminder cleanup did not complete. This reminder changed in another window. Review the latest reminder.",
    },
    {
      action: "Snooze",
      buttonName: "Snooze 1 hour",
      withSession: false,
      expectedMessage: "This reminder changed in another window. Review the latest reminder.",
    },
    {
      action: "Dismiss",
      buttonName: "Dismiss reminder",
      withSession: false,
      expectedMessage: "This reminder changed in another window. Review the latest reminder.",
    },
  ] as const)(
    "guards detail-originated $action when a conflict replaces the occurrence",
    async ({ action, buttonName, withSession, expectedMessage }) => {
      const cwd = `/work/guarded-detail-${action.toLowerCase().replace(/\s+/g, "-")}`;
      const client = new FakeProjectNotesClient(cwd);
      const initial = notes("guarded detail reminder");
      const selected = phase("guarded-detail", "in-progress", true);
      if (withSession) {
        selected.session = { sessionId: "session-a", sessionPath: "/sessions/a" };
      }
      initial.phases = [selected];
      client.seed(cwd, initial);
      const onResumePhase = vi.fn(async () => undefined);

      render(<ProjectNotes cwd={cwd} client={client} onResumePhase={onResumePhase} />);
      await openRoadmapPhase(selected.title);

      client.beforeNextSave = () => {
        const current = client.snapshots.get(canonicalProjectKey(cwd))!;
        const replacement = structuredClone(current.document);
        replacement.phases[0]!.reminder = {
          ...replacement.phases[0]!.reminder!,
          occurrenceKey: "occurrence-b",
          dueAt: "2026-08-01T12:00:00.000Z",
          note: "Newer reminder",
        };
        client.publish(cwd, replacement, current.revision + 1);
      };

      fireEvent.click(screen.getByRole("button", { name: buttonName }));

      expect((await screen.findByRole("alert")).textContent).toContain(expectedMessage);
      expect(client.snapshots.get(canonicalProjectKey(cwd))).toMatchObject({
        revision: 2,
        document: {
          phases: [
            {
              reminder: {
                occurrenceKey: "occurrence-b",
                dueAt: "2026-08-01T12:00:00.000Z",
                note: "Newer reminder",
              },
            },
          ],
        },
      });
      expect(onResumePhase).toHaveBeenCalledTimes(withSession ? 1 : 0);
    },
  );

  it("claims one focused reminder, announces it, and resumes before dismissing only the reminder", async () => {
    const cwd = "/work/focused-reminder";
    const client = new FakeProjectNotesClient(cwd);
    const document = notes("focused reminder");
    const selected = phase("focused", "in-progress", true);
    selected.session = { sessionId: "bound", sessionPath: "/sessions/bound" };
    document.phases = [selected];
    client.seed(cwd, document);
    client.reserveOutcomes.push(reminderReservation(selected), { status: "none" });
    const onResumePhase = vi.fn(async () => undefined);

    render(
      <ProjectNotes
        cwd={cwd}
        client={client}
        paneFocused={true}
        windowFocused={true}
        onResumePhase={onResumePhase}
      />,
    );

    const alert = await screen.findByRole("region", { name: "Phase focused" });
    expect(alert.textContent).toContain("Review");
    expect(client.claimCalls).toEqual([
      {
        leaseToken: `lease-${selected.reminder!.occurrenceKey}`,
        channel: "in-app",
        permission: "not-required",
      },
    ]);
    expect(await screen.findByRole("button", { name: "Notes, 1 reminder due" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(onResumePhase).toHaveBeenCalledWith("focused", selected.session));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Phase focused" })).toBeNull());
    expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.phases[0]).toMatchObject({
      status: "in-progress",
      reminder: null,
    });
  });

  it("keeps the alert active and identifies a resume-stage failure", async () => {
    const cwd = "/work/reminder-resume-failure";
    const client = new FakeProjectNotesClient(cwd);
    const document = notes("reminder resume failure");
    const selected = phase("resume-failure", "in-progress", true);
    selected.session = { sessionId: "bound", sessionPath: "/sessions/bound" };
    document.phases = [selected];
    client.seed(cwd, document);
    client.reserveOutcomes.push(reminderReservation(selected), { status: "none" });
    const onResumePhase = vi.fn(async () => {
      throw new Error("Session transport failed.");
    });

    render(<ProjectNotes cwd={cwd} client={client} onResumePhase={onResumePhase} />);
    const alert = await screen.findByRole("region", { name: "Phase resume-failure" });
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() =>
      expect(alert.textContent).toContain("Couldn’t resume this phase. Session transport failed."),
    );
    expect(onResumePhase).toHaveBeenCalledTimes(1);
    expect(
      client.snapshots.get(canonicalProjectKey(cwd))?.document.phases[0]?.reminder,
    ).not.toBeNull();
  });

  it("reports successful resume separately from typed reminder cleanup failure", async () => {
    const cwd = "/work/reminder-cleanup-failure";
    const client = new FakeProjectNotesClient(cwd);
    const document = notes("reminder cleanup failure");
    const selected = phase("cleanup-failure", "in-progress", true);
    selected.session = { sessionId: "bound", sessionPath: "/sessions/bound" };
    document.phases = [selected];
    client.seed(cwd, document);
    client.reserveOutcomes.push(reminderReservation(selected), { status: "none" });
    client.saveOutcome = {
      status: "invalid",
      error: { path: "phases[0].reminder", message: "Invalid reminder mutation" },
    };
    const onResumePhase = vi.fn(async () => undefined);

    render(<ProjectNotes cwd={cwd} client={client} onResumePhase={onResumePhase} />);
    const alert = await screen.findByRole("region", { name: "Phase cleanup-failure" });
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() =>
      expect(alert.textContent).toContain(
        "The phase resumed, but reminder cleanup did not complete. Project Notes rejected the reminder change. Review it and try again.",
      ),
    );
    expect(onResumePhase).toHaveBeenCalledTimes(1);
    expect(
      client.snapshots.get(canonicalProjectKey(cwd))?.document.phases[0]?.reminder,
    ).not.toBeNull();
  });

  it("opens an unbound reminder directly on its Roadmap detail without clearing the schedule", async () => {
    const cwd = "/work/open-reminder";
    const client = new FakeProjectNotesClient(cwd);
    const document = notes("open reminder");
    const selected = phase("open-target", "not-started", true);
    document.phases = [selected];
    client.seed(cwd, document);
    client.reserveOutcomes.push(reminderReservation(selected), { status: "none" });

    render(<ProjectNotes cwd={cwd} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open phase" }));

    expect(
      (await screen.findByRole("tab", { name: "Roadmap" })).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("heading", { name: "Phase open-target" })).toBeTruthy();
    expect(
      client.snapshots.get(canonicalProjectKey(cwd))?.document.phases[0]!.reminder,
    ).not.toBeNull();
  });

  it("schedules a preset, keeps invalid custom wall time in place, and explains local fallback delivery", async () => {
    const cwd = "/work/schedule-reminder";
    const client = new FakeProjectNotesClient(cwd);
    const document = notes("schedule reminder");
    document.phases = [phase("schedule", "planning")];
    client.seed(cwd, document);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    fireEvent.click(screen.getByRole("tab", { name: "Roadmap" }));
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Phase schedule" }));
    expect(screen.getByText(/Future reminders are recovered when GG Coder opens/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Tomorrow,/ }));
    await waitFor(() =>
      expect(
        client.snapshots.get(canonicalProjectKey(cwd))?.document.phases[0]!.reminder,
      ).not.toBeNull(),
    );

    const custom = screen.getByLabelText("Choose local date and time") as HTMLInputElement;
    fireEvent.change(custom, { target: { value: "2020-01-01T09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save custom time" }));
    expect(await screen.findByText("Choose a valid future local date and time.")).toBeTruthy();
    expect(custom.value).toBe("2020-01-01T09:00");
  });

  it("refreshes pristine phase fields and blocks dirty fields after an authoritative edit", async () => {
    const cwd = "/work/concurrent-phase-draft";
    const client = new FakeProjectNotesClient(cwd);
    const initial = notes("concurrent phase draft");
    const selected = phase("concurrent-draft", "planning");
    initial.phases = [selected];
    client.seed(cwd, initial);
    render(<ProjectNotes cwd={cwd} client={client} />);

    await openRoadmapPhase(selected.title);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const refreshed = structuredClone(initial);
    refreshed.phases[0]!.title = "Authoritative refreshed title";
    refreshed.phases[0]!.goal = "Authoritative refreshed goal";
    refreshed.phases[0]!.doneWhen = ["Authoritative refreshed criterion"];
    refreshed.phases[0]!.updatedAt = "2026-07-15T12:01:00.000Z";
    act(() => client.publish(cwd, refreshed, 2));

    await waitFor(() =>
      expect((screen.getByLabelText("Edit phase title") as HTMLInputElement).value).toBe(
        "Authoritative refreshed title",
      ),
    );
    expect((screen.getByLabelText("Edit goal") as HTMLTextAreaElement).value).toBe(
      "Authoritative refreshed goal",
    );
    expect((screen.getByLabelText("Edit Done when") as HTMLTextAreaElement).value).toBe(
      "Authoritative refreshed criterion",
    );
    expect(screen.queryByText(/This phase changed in another window/)).toBeNull();

    fireEvent.change(screen.getByLabelText("Edit phase title"), {
      target: { value: "Local draft title" },
    });
    fireEvent.change(screen.getByLabelText("Edit goal"), {
      target: { value: "Local draft goal" },
    });
    fireEvent.change(screen.getByLabelText("Edit Done when"), {
      target: { value: "Local draft criterion" },
    });

    const concurrent = structuredClone(refreshed);
    concurrent.phases[0]!.title = "Concurrent title";
    concurrent.phases[0]!.goal = "Concurrent goal";
    concurrent.phases[0]!.doneWhen = ["Concurrent criterion"];
    concurrent.phases[0]!.updatedAt = "2026-07-15T12:02:00.000Z";
    act(() => client.publish(cwd, concurrent, 3));

    expect(await screen.findByText(/This phase changed in another window/)).toBeTruthy();
    expect((screen.getByLabelText("Edit phase title") as HTMLInputElement).value).toBe(
      "Local draft title",
    );
    expect((screen.getByLabelText("Edit goal") as HTMLTextAreaElement).value).toBe(
      "Local draft goal",
    );
    expect((screen.getByLabelText("Edit Done when") as HTMLTextAreaElement).value).toBe(
      "Local draft criterion",
    );
    expect(
      (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.phases[0]).toMatchObject({
      title: "Concurrent title",
      goal: "Concurrent goal",
      doneWhen: ["Concurrent criterion"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Reload latest values" }));
    expect((screen.getByLabelText("Edit phase title") as HTMLInputElement).value).toBe(
      "Concurrent title",
    );
    expect((screen.getByLabelText("Edit goal") as HTMLTextAreaElement).value).toBe(
      "Concurrent goal",
    );
    expect((screen.getByLabelText("Edit Done when") as HTMLTextAreaElement).value).toBe(
      "Concurrent criterion",
    );
    expect(
      (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("refreshes pristine reminder fields and blocks dirty scheduling after replacement", async () => {
    const cwd = "/work/concurrent-reminder-draft";
    const client = new FakeProjectNotesClient(cwd);
    const initial = notes("concurrent reminder draft");
    const selected = phase("concurrent-reminder", "planning", true);
    initial.phases = [selected];
    client.seed(cwd, initial);
    render(<ProjectNotes cwd={cwd} client={client} />);

    await openRoadmapPhase(selected.title);
    const noteInput = screen.getByLabelText("Reminder note (optional)") as HTMLTextAreaElement;
    const timeInput = screen.getByLabelText("Choose local date and time") as HTMLInputElement;
    const refreshedDueAt = "2027-08-01T10:30:00.000Z";
    const refreshed = structuredClone(initial);
    refreshed.phases[0]!.updatedAt = "2026-07-15T12:01:00.000Z";
    refreshed.phases[0]!.reminder = {
      ...refreshed.phases[0]!.reminder!,
      occurrenceKey: "occurrence-refreshed",
      note: "Authoritative refreshed note",
      dueAt: refreshedDueAt,
    };
    act(() => client.publish(cwd, refreshed, 2));

    await waitFor(() => expect(noteInput.value).toBe("Authoritative refreshed note"));
    expect(timeInput.value).toBe(dateToLocalInputValue(new Date(refreshedDueAt)));
    expect(screen.queryByText(/This reminder changed in another window/)).toBeNull();

    fireEvent.change(noteInput, { target: { value: "Local reminder note" } });
    fireEvent.change(timeInput, { target: { value: "2027-09-02T09:45" } });

    const concurrentDueAt = "2027-10-03T14:15:00.000Z";
    const concurrent = structuredClone(refreshed);
    concurrent.phases[0]!.updatedAt = "2026-07-15T12:02:00.000Z";
    concurrent.phases[0]!.reminder = {
      ...concurrent.phases[0]!.reminder!,
      occurrenceKey: "occurrence-concurrent",
      note: "Concurrent reminder note",
      dueAt: concurrentDueAt,
    };
    act(() => client.publish(cwd, concurrent, 3));

    expect(await screen.findByText(/This reminder changed in another window/)).toBeTruthy();
    expect(noteInput.value).toBe("Local reminder note");
    expect(timeInput.value).toBe("2027-09-02T09:45");
    expect(
      (screen.getByRole("button", { name: "Save custom time" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      client.snapshots.get(canonicalProjectKey(cwd))?.document.phases[0]?.reminder,
    ).toMatchObject({
      occurrenceKey: "occurrence-concurrent",
      note: "Concurrent reminder note",
      dueAt: concurrentDueAt,
    });

    fireEvent.click(screen.getByRole("button", { name: "Reload latest reminder" }));
    expect(noteInput.value).toBe("Concurrent reminder note");
    expect(timeInput.value).toBe(dateToLocalInputValue(new Date(concurrentDueAt)));
    expect(
      (screen.getByRole("button", { name: "Save custom time" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("updates a mounted Roadmap row and detail when a future reminder becomes due", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    const cwd = "/work/mounted-reminder-boundary";
    const client = new FakeProjectNotesClient(cwd);
    const document = notes("mounted reminder boundary");
    const selected = phase("mounted-boundary", "in-progress", true);
    selected.reminder!.dueAt = "2026-07-15T12:00:30.000Z";
    document.phases = [selected];
    client.seed(cwd, document);

    render(<ProjectNotes cwd={cwd} client={client} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: `Inspect phase: ${selected.title}` }));

    const row = screen
      .getByRole("button", { name: `Inspect phase: ${selected.title}` })
      .closest("li");
    const reminderSection = screen.getByRole("heading", { name: "Reminder" }).closest("section");
    expect(row?.textContent).not.toContain("Due now");
    expect(reminderSection?.textContent).toContain("Scheduled for");
    expect(screen.queryByRole("button", { name: "Snooze 1 hour" })).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });

    expect(row?.textContent).toContain("Due now");
    expect(reminderSection?.textContent).toContain("Due now");
    expect(screen.getByRole("button", { name: "Snooze 1 hour" })).toBeTruthy();
  });

  it("describes a claimed in-app reminder as requested in due phase detail", async () => {
    const cwd = "/work/in-app-reminder-evidence";
    const client = new FakeProjectNotesClient(cwd);
    const document = notes("in-app reminder evidence");
    const selected = phase("in-app-evidence", "review", true);
    document.phases = [selected];
    client.seed(cwd, document);
    client.reserveOutcomes.push(reminderReservation(selected), { status: "none" });

    render(<ProjectNotes cwd={cwd} client={client} />);
    await waitFor(() =>
      expect(client.claimCalls).toEqual([
        {
          leaseToken: `lease-${selected.reminder!.occurrenceKey}`,
          channel: "in-app",
          permission: "not-required",
        },
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Notes, 1 reminder due" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Review phase: Phase in-app-evidence" }));
    expect(screen.getByText("An in-app reminder was requested in GG Coder.")).toBeTruthy();
  });

  it("keeps native evidence truthful after mocked dispatch failure", async () => {
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "roadmap_reminder_notification_permission") return "granted";
      if (command === "show_roadmap_reminder_notification") {
        throw new Error("native unavailable");
      }
      throw new Error(`Unexpected Tauri command: ${command}`);
    });
    const cwd = "/work/native-reminder-evidence";
    const client = new FakeProjectNotesClient(cwd);
    const document = notes("native reminder evidence");
    const selected = phase("native-evidence", "review", true);
    document.phases = [selected];
    client.seed(cwd, document);
    client.reserveOutcomes.push(reminderReservation(selected), { status: "none" });

    render(<ProjectNotes cwd={cwd} client={client} paneFocused={false} />);
    await waitFor(() =>
      expect(client.claimCalls).toEqual([
        {
          leaseToken: `lease-${selected.reminder!.occurrenceKey}`,
          channel: "native",
          permission: "granted",
        },
      ]),
    );
    await waitFor(() =>
      expect(tauriMocks.logError).toHaveBeenCalledWith(
        expect.stringContaining("native unavailable"),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Notes, 1 reminder due" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Review phase: Phase native-evidence" }));
    expect(screen.getByText("A private native notification was requested.")).toBeTruthy();
  });

  it("shows exact denied native fallback evidence in due phase detail", async () => {
    const cwd = "/work/denied-reminder";
    const client = new FakeProjectNotesClient(cwd);
    const document = notes("denied reminder");
    const selected = phase("denied", "review", true);
    selected.reminder!.lastDelivery = {
      occurrenceKey: selected.reminder!.occurrenceKey,
      attemptedAt: NOW,
      channel: "in-app-fallback",
      permission: "denied",
    };
    document.phases = [selected];
    client.seed(cwd, document);
    render(<ProjectNotes cwd={cwd} client={client} paneFocused={false} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes, 1 reminder due" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Review phase: Phase denied" }));
    expect(
      screen.getByText("Native notification permission was denied. Use the in-app actions here."),
    ).toBeTruthy();
  });

  it("renders four stable tabs with automatic keyboard navigation and one visible panel", async () => {
    const cwd = "/work/shell";
    const client = new FakeProjectNotesClient(cwd);
    client.seed(cwd, notes("reference"));
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Roadmap",
      "Reference",
      "Archive",
    ]);
    expect(screen.getAllByRole("tabpanel", { hidden: true })).toHaveLength(4);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);

    const overview = screen.getByRole("tab", { name: "Overview" });
    const roadmap = screen.getByRole("tab", { name: "Roadmap" });
    const reference = screen.getByRole("tab", { name: "Reference" });
    const archive = screen.getByRole("tab", { name: "Archive" });
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect(overview.getAttribute("aria-controls")).toBe("notes-panel-overview");
    expect(overview).toBe(document.activeElement);
    expect(roadmap.tabIndex).toBe(-1);
    expect(screen.queryByLabelText("Roadmap summary")).toBeNull();

    fireEvent.keyDown(overview, { key: "ArrowLeft" });
    expect(archive.getAttribute("aria-selected")).toBe("true");
    expect(archive).toBe(document.activeElement);

    fireEvent.keyDown(archive, { key: "ArrowRight" });
    expect(overview.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(overview, { key: "End" });
    expect(archive.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(archive, { key: "Home" });
    expect(overview.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(reference);
    expect(reference.getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    fireEvent.click(roadmap);
    expect(screen.getByText("No roadmap phases yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New phase" }));
    fireEvent.change(screen.getByLabelText("Phase title"), { target: { value: "First phase" } });
    fireEvent.click(screen.getByRole("button", { name: "Create phase" }));
    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.phases).toHaveLength(1),
    );
    expect(screen.getByRole("list", { name: "Roadmap phases" }).children).toHaveLength(1);
    expect(screen.queryByText("Selected phase")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New phase" }));
  });

  it("keeps an incoming Handoff unread until Overview is visible", async () => {
    const cwd = "/work/hidden-handoff";
    const client = new FakeProjectNotesClient(cwd);
    client.seed(cwd, notes("reference"));
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    const incoming = notes("reference");
    incoming.handoff = { text: "Continue from the new state", updatedAt: NOW, readAt: null };

    await act(async () => {
      client.publish(cwd, incoming, 2);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByRole("button", { name: "Notes, unread Handoff" })).toBeTruthy();
    expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.handoff.readAt).toBeNull();

    selectNotesTab("Overview");
    await waitFor(() =>
      expect(
        client.snapshots.get(canonicalProjectKey(cwd))?.document.handoff.readAt,
      ).not.toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Notes" })).toBeTruthy();
  });

  it("keeps active counts while exposing compact actions for active and settled phases", async () => {
    const cwd = "/work/roadmap-counts";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.phases = [
      phase("planning", "planning", true),
      phase("review", "review"),
      phase("done", "done", true),
      phase("cancelled", "cancelled", true),
    ].map((item, order) => ({ ...item, order }));
    client.seed(cwd, populated);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));

    const summary = screen.getByLabelText("Roadmap summary");
    expect(summary.textContent).toContain("2 active phases");
    expect(summary.textContent).toContain("1 active reminder");
    expect(screen.getByRole("tab", { name: "Roadmap" }).textContent).toBe("Roadmap2");

    selectNotesTab("Roadmap");
    expect(screen.getByRole("list", { name: "Roadmap phases" }).children).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Start phase: Phase planning" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review phase: Phase review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review phase: Phase done" })).toBeTruthy();
    expect(screen.queryByText("Selected phase")).toBeNull();

    const singular = notes("updated reference");
    singular.phases = [phase("attention", "needs-attention")];
    act(() => client.publish(cwd, singular, 2));
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Roadmap phases" }).children).toHaveLength(1),
    );
    expect(screen.getByRole("tab", { name: "Roadmap" }).getAttribute("aria-selected")).toBe("true");
  });

  it("renders the latest report, resolves a suggested reference, and exposes merged history", async () => {
    const cwd = "/work/roadmap-report";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("roadmap evidence");
    const selected = phase("report", "not-started");
    selected.title = "Roadmap reporting";
    selected.overrides.status = { value: "not-started", source: "user", updatedAt: NOW };
    selected.overrides.referenceIds = { value: [], source: "user", updatedAt: NOW };
    selected.roadmapEvents = [
      {
        type: "status-update",
        id: "update-report",
        actor: "ken-autopilot",
        transition: "blocked",
        progress: "Repository reconciliation is implemented.",
        blocker: "The release build is still running.",
        evidence: ["Focused repository tests passed."],
        verification: null,
        verificationReason: null,
        verificationSession: null,
        statusOutcome: "manual-override",
        proposedReferences: [
          {
            provider: "github",
            tool: "searchCode",
            canonicalUrl: "https://github.com/owner/repo/blob/main/src/roadmap.ts#L1-L20",
            owner: "owner",
            repo: "repo",
            revision: "main",
            path: "src/roadmap.ts",
            range: { startLine: 1, endLine: 20 },
            issue: null,
            pullRequest: null,
            query: null,
            anchor: "L1-L20",
            relevance: "Roadmap reconciliation source",
            id: "proposal-report",
            disposition: "pending",
            policyOutcome: "manual-review",
            referenceId: null,
          },
        ],
        timestamp: NOW,
      },
    ];
    populated.phases = [selected];
    client.seed(cwd, populated);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Roadmap reporting" }));

    expect(screen.getByRole("heading", { name: "Latest report" })).toBeTruthy();
    expect(screen.getAllByText("Autopilot Ken").length).toBeGreaterThan(0);
    expect(screen.getByText("Repository reconciliation is implemented.")).toBeTruthy();
    expect(
      screen.getAllByText("Blocker: The release build is still running.").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Focused repository tests passed.").length).toBeGreaterThan(0);
    expect(screen.getByText(/Status was protected by the active manual override/)).toBeTruthy();
    expect(screen.getByText("Suggested references are pending manual review.")).toBeTruthy();
    expect(
      screen.queryByText(/manual reference links were active when this report was recorded/),
    ).toBeNull();
    expect(screen.getByRole("heading", { name: "Suggested references" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reject" })).toBeNull());
    expect(screen.queryByText("Suggested references are pending manual review.")).toBeNull();

    const protectedAtReportTime = structuredClone(populated);
    protectedAtReportTime.phases[0]!.overrides.referenceIds = null;
    const protectedReport = protectedAtReportTime.phases[0]!.roadmapEvents[0];
    if (protectedReport?.type !== "status-update") throw new Error("Expected a status report");
    protectedReport.proposedReferences[0]!.policyOutcome = "reference-override-protected";
    act(() => client.publish(cwd, protectedAtReportTime, 3));
    await waitFor(() =>
      expect(
        screen.getByText(/manual reference links were active when this report was recorded/),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("Suggested references are pending manual review.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Accept" })).toBeNull());
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByText(/Activity history/));
    expect(screen.getByText(/Status outcome: manual-override/)).toBeTruthy();
    expect(screen.getByText("Reference proposal accepted.")).toBeTruthy();
  });

  it("explains a done-terminal latest report without requiring history expansion", async () => {
    const cwd = "/work/roadmap-done-terminal";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("done terminal evidence");
    const selected = phase("done-report", "done");
    selected.title = "Completed reconciliation";
    selected.roadmapEvents = [
      {
        type: "status-update",
        id: "update-done-terminal",
        actor: "gg-coder",
        transition: "in-progress",
        progress: "A follow-up report requested more implementation work.",
        blocker: null,
        evidence: [],
        verification: null,
        verificationReason: null,
        verificationSession: null,
        statusOutcome: "done-terminal",
        proposedReferences: [],
        timestamp: NOW,
      },
    ];
    populated.phases = [selected];
    client.seed(cwd, populated);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Review phase: Completed reconciliation" }));

    const latestReport = screen.getByRole("heading", { name: "Latest report" }).closest("section");
    expect(latestReport?.textContent).toContain(
      "Done remained terminal, so this report did not change the phase status. The report was retained in history.",
    );
    expect(
      (screen.getByText(/Activity history/).closest("details") as HTMLDetailsElement).open,
    ).toBe(false);
  });

  it("renders empty completion gates before the latest report", async () => {
    const cwd = "/work/completion-empty";
    const client = new FakeProjectNotesClient(cwd);
    const document = notes("empty completion evidence");
    const selected = phase("completion-empty", "review");
    document.phases = [selected];
    client.seed(cwd, document);
    render(<ProjectNotes cwd={cwd} client={client} />);

    await openRoadmapPhase(selected.title);

    const gates = screen.getByRole("heading", { name: "Completion gates" }).closest("section");
    expect(gates?.textContent).toContain("Completion evidence has not been recorded.");
    expect(gates?.textContent).toContain("Typed verification has not been recorded.");
    expect(gates?.textContent).toContain("Final review has not been recorded.");
    const latest = screen.getByRole("heading", { name: "Latest report" });
    expect(
      gates && latest.compareDocumentPosition(gates) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });

  it("explains partial implementation, failed verification, and rejected review", async () => {
    const cwd = "/work/completion-failed";
    const client = new FakeProjectNotesClient(cwd);
    const document = notes("failed completion evidence");
    const selected = phase("completion-failed", "needs-attention");
    selected.session = { sessionId: "session-ui", sessionPath: "/sessions/ui.jsonl" };
    const failedReason = "Typecheck failed in the production sidecar bundle.";
    selected.roadmapEvents = [
      implementationCheckpoint([1]),
      verificationReport("failed", failedReason),
      completionReview({
        decision: "rejected",
        evidence: [],
        reason: "Fix the sidecar bundle and rerun every check.",
        verificationStatusUpdateId: "verification-ui-failed",
        gateOutcome: "needs-attention",
        unmetGateCodes: ["incomplete-plan", "failed-verification"],
      }),
    ];
    document.phases = [selected];
    client.seed(cwd, document);
    render(<ProjectNotes cwd={cwd} client={client} />);

    await openRoadmapPhase(selected.title);

    const gates = screen.getByRole("heading", { name: "Completion gates" }).closest("section");
    expect(gates?.textContent).toContain("1 of 2 plan steps");
    expect(gates?.textContent).toContain("Failed");
    expect(gates?.textContent).toContain(failedReason);
    expect(gates?.textContent).toContain("Rejected by Autopilot Ken");
    expect(gates?.textContent).toContain(
      "The implementation checkpoint used by this final review does not complete every canonical plan step.",
    );
    expect(gates?.textContent).toContain("The verification used by this final review failed.");

    fireEvent.click(screen.getByText(/Activity history/));
    expect(screen.getByText(/Implementation checkpoint: 1 of 2 plan steps/)).toBeTruthy();
    expect(screen.getByText(/Final review rejected/)).toBeTruthy();
  });

  it("labels an accepted verification exception with requester and reviewer timestamps", async () => {
    const cwd = "/work/completion-exception";
    const client = new FakeProjectNotesClient(cwd);
    const document = notes("exception completion evidence");
    const selected = phase("completion-exception", "done");
    selected.session = { sessionId: "session-ui", sessionPath: "/sessions/ui.jsonl" };
    selected.roadmapEvents = [
      implementationCheckpoint(),
      verificationReport("exception-requested", "The native screen reader is unavailable in CI."),
      completionReview({
        verificationStatusUpdateId: "verification-ui-exception-requested",
        acceptsVerificationException: true,
      }),
    ];
    document.phases = [selected];
    client.seed(cwd, document);
    render(<ProjectNotes cwd={cwd} client={client} />);

    await openRoadmapPhase(selected.title);

    const gates = screen.getByRole("heading", { name: "Completion gates" }).closest("section");
    expect(gates?.textContent).toContain("Exception requested");
    expect(gates?.textContent).toContain("Reported by GG Coder");
    expect(gates?.textContent).toContain("The native screen reader is unavailable in CI.");
    expect(gates?.textContent).toContain("Exception accepted by Autopilot Ken");
    expect(gates?.querySelectorAll("time")).toHaveLength(4);
  });

  it("keeps reviewed evidence and recovery paired when newer evidence is appended", async () => {
    const cwd = "/work/completion-reviewed-evidence";
    const client = new FakeProjectNotesClient(cwd);
    const document = notes("reviewed completion evidence");
    const selected = phase("completion-reviewed-evidence", "needs-attention");
    selected.session = { sessionId: "session-ui", sessionPath: "/sessions/ui.jsonl" };
    const reviewedFailureReason = "The reviewed verification failed before the rerun.";
    selected.roadmapEvents = [
      implementationCheckpoint([1]),
      verificationReport("failed", reviewedFailureReason),
      completionReview({
        decision: "rejected",
        evidence: [],
        reason: "Complete the remaining step and rerun verification.",
        verificationStatusUpdateId: "verification-ui-failed",
        gateOutcome: "needs-attention",
        unmetGateCodes: ["incomplete-plan", "failed-verification"],
      }),
      {
        ...implementationCheckpoint([1, 2, 3]),
        id: "checkpoint-ui-newer",
        planStepTotal: 3,
        timestamp: "2026-07-15T12:03:00.000Z",
      },
      {
        ...verificationReport("passed"),
        id: "verification-ui-passed-newer",
        evidence: ["Newer verification was not reviewed."],
        statusOutcome: "same-status",
        timestamp: "2026-07-15T12:04:00.000Z",
      },
    ];
    document.phases = [selected];
    client.seed(cwd, document);
    render(<ProjectNotes cwd={cwd} client={client} />);

    await openRoadmapPhase(selected.title);

    const gates = screen.getByRole("heading", { name: "Completion gates" }).closest("section");
    const gateRows = gates?.querySelectorAll("dl > div");
    const implementationGate = gateRows?.item(0);
    const verificationGate = gateRows?.item(1);

    expect(implementationGate?.textContent).toContain("Evidence used by this final review.");
    expect(implementationGate?.textContent).toContain("1 of 2 plan steps");
    expect(implementationGate?.textContent).toContain("Newer unreviewed evidence");
    expect(implementationGate?.textContent).toContain("3 of 3 plan steps");
    expect(verificationGate?.textContent).toContain("Evidence used by this final review.");
    expect(verificationGate?.textContent).toContain("Failed");
    expect(verificationGate?.textContent).toContain(reviewedFailureReason);
    expect(verificationGate?.textContent).toContain("Newer unreviewed evidence");
    expect(verificationGate?.textContent).toContain("Passed");
    expect(verificationGate?.textContent).toContain("Newer verification was not reviewed.");
    expect(gates?.textContent).toContain("Rejected by Autopilot Ken");
    expect(gates?.textContent).toContain(
      "The implementation checkpoint used by this final review does not complete every canonical plan step.",
    );
    expect(gates?.textContent).toContain("The verification used by this final review failed.");
  });

  it("shows successful Done evidence while keeping archive separate", async () => {
    const cwd = "/work/completion-done";
    const client = new FakeProjectNotesClient(cwd);
    const document = notes("done completion evidence");
    const selected = phase("completion-done", "done");
    selected.session = { sessionId: "session-ui", sessionPath: "/sessions/ui.jsonl" };
    selected.roadmapEvents = [
      implementationCheckpoint(),
      verificationReport("passed"),
      completionReview(),
    ];
    document.phases = [selected];
    client.seed(cwd, document);
    render(<ProjectNotes cwd={cwd} client={client} />);

    await openRoadmapPhase(selected.title);

    const gates = screen.getByRole("heading", { name: "Completion gates" }).closest("section");
    expect(gates?.textContent).toContain("2 of 2 plan steps");
    expect(gates?.textContent).toContain("Passed");
    expect(gates?.textContent).toContain("Accepted by Autopilot Ken");
    expect(gates?.textContent).toContain("Done is complete. Archiving remains a separate action.");
    expect(screen.getByRole("button", { name: "Archive phase" })).toBeTruthy();
  });

  it("keeps a manual override authoritative with long localized completion evidence", async () => {
    const cwd = "/work/completion-override";
    const client = new FakeProjectNotesClient(cwd);
    const document = notes("override completion evidence");
    const selected = phase("completion-override", "review");
    selected.session = { sessionId: "session-ui", sessionPath: "/sessions/ui.jsonl" };
    selected.overrides.status = { value: "review", source: "user", updatedAt: NOW };
    const longReason =
      "Überprüfung ausstehend: 長いローカライズ済みの検証理由を折り返して表示します。".repeat(8);
    selected.roadmapEvents = [
      implementationCheckpoint(),
      verificationReport("exception-requested", longReason),
      completionReview({
        verificationStatusUpdateId: "verification-ui-exception-requested",
        gateOutcome: "manual-override",
        unmetGateCodes: ["verification-exception-not-accepted"],
      }),
    ];
    document.phases = [selected];
    client.seed(cwd, document);
    render(<ProjectNotes cwd={cwd} client={client} />);

    await openRoadmapPhase(selected.title);

    const gates = screen.getByRole("heading", { name: "Completion gates" }).closest("section");
    expect(gates?.textContent).toContain(longReason);
    expect(gates?.textContent).toContain(
      "The review is recorded, but the user status override remains authoritative.",
    );
    expect(gates?.textContent).toContain(
      "The verification exception still needs reviewer acceptance.",
    );
  });

  it("shows attached scope before Start, locks competing controls while pending, and closes on success", async () => {
    const cwd = "/work/phase-start";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("free-form notes must stay out of the phase package");
    const attached = reference("ref-start");
    populated.references = [attached];
    populated.phases = [
      {
        ...phase("start", "not-started"),
        title: "Start contract",
        referenceIds: [attached.id],
        sourcePrompt: "Saved phase-only prompt",
      },
    ];
    client.seed(cwd, populated);
    let resolveStart!: (result: {
      status: "accepted";
      operationId: string;
      session: { sessionId: string; sessionPath: string };
      packageTokenCount: number;
    }) => void;
    const onStartPhase = vi.fn(
      () =>
        new Promise<{
          status: "accepted";
          operationId: string;
          session: { sessionId: string; sessionPath: string };
          packageTokenCount: number;
        }>((resolve) => {
          resolveStart = resolve;
        }),
    );
    render(
      <ProjectNotes
        cwd={cwd}
        client={client}
        onStartPhase={onStartPhase}
        onResumePhase={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Start phase: Start contract" }));
    expect(onStartPhase).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Attached references" })).toBeTruthy();
    expect(screen.getAllByText("Evidence from owner/repo").length).toBeGreaterThan(0);
    expect(screen.getByText("Saved phase-only prompt")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start phase" }));
    expect(onStartPhase).toHaveBeenCalledExactlyOnceWith("start");
    expect((screen.getByRole("button", { name: "Starting…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Status override") as HTMLSelectElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Archive phase" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);

    await act(async () => {
      resolveStart({
        status: "accepted",
        operationId: "operation-1",
        session: { sessionId: "session-1", sessionPath: "/session-1.jsonl" },
        packageTokenCount: 120,
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("disables Start and Recover when coding mode is unavailable and keeps Resume available", async () => {
    const cwd = "/work/phase-mode-gate";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    const bound = { sessionId: "bound", sessionPath: "/bound.jsonl" };
    const recoverable = { sessionId: "recoverable", sessionPath: null };
    populated.phases = [
      { ...phase("start", "not-started"), title: "Start in code", order: 0 },
      {
        ...phase("recover", "needs-attention"),
        title: "Recover in code",
        order: 1,
        session: recoverable,
      },
      { ...phase("resume", "planning"), title: "Resume in code", order: 2, session: bound },
    ];
    client.seed(cwd, populated);
    const onStartPhase = vi.fn();
    const onResumePhase = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectNotes
        cwd={cwd}
        client={client}
        onStartPhase={onStartPhase}
        onResumePhase={onResumePhase}
        phaseStartUnavailableReason="Switch to coding mode to start this phase."
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Start phase: Start in code" }));
    const start = screen.getByRole("button", { name: "Start phase" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toBe("Switch to coding mode to start this phase.");
    expect(screen.getByText("Switch to coding mode to start this phase.")).toBeTruthy();
    fireEvent.click(start);
    expect(onStartPhase).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back to roadmap" }));
    fireEvent.click(screen.getByRole("button", { name: "Recover phase: Recover in code" }));
    const recover = screen.getByRole("button", { name: "Recover phase" }) as HTMLButtonElement;
    expect(recover.disabled).toBe(true);
    expect(recover.title).toBe("Switch to coding mode to start this phase.");
    fireEvent.click(recover);
    expect(onResumePhase).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back to roadmap" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume phase: Resume in code" }));
    const resume = screen.getByRole("button", { name: "Resume phase" }) as HTMLButtonElement;
    expect(resume.disabled).toBe(false);
    fireEvent.click(resume);
    await waitFor(() => expect(onResumePhase).toHaveBeenCalledExactlyOnceWith("resume", bound));
  });

  it("announces retryable failure, returns focus, and turns an already-bound race into Resume", async () => {
    const cwd = "/work/phase-recovery";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.phases = [
      {
        ...phase("recover", "needs-attention"),
        title: "Recover phase",
        attentionReason: "Previous prompt failed.",
      },
    ];
    client.seed(cwd, populated);
    const bound = { sessionId: "winner", sessionPath: "/winner.jsonl" };
    const onStartPhase = vi
      .fn()
      .mockResolvedValueOnce({
        status: "failed",
        code: "launch-failed",
        operationId: "operation-1",
        message: "Could not create the phase session. Retry.",
      })
      .mockResolvedValueOnce({
        status: "already-bound",
        operationId: "operation-2",
        session: bound,
        packageTokenCount: 0,
      });
    const onResumePhase = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectNotes
        cwd={cwd}
        client={client}
        onStartPhase={onStartPhase}
        onResumePhase={onResumePhase}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Start phase: Recover phase" }));
    expect(screen.getByText("Needs attention: Previous prompt failed.")).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start phase" });
    fireEvent.click(start);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not create the phase session. Retry.",
    );
    expect(screen.queryByText("Starting phase…")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(start));

    fireEvent.click(start);
    expect((await screen.findByRole("alert")).textContent).toContain("started in another window");
    expect(screen.queryByText("Starting phase…")).toBeNull();
    const resume = screen.getByRole("button", { name: "Resume phase" });
    fireEvent.click(resume);
    await waitFor(() => expect(onResumePhase).toHaveBeenCalledExactlyOnceWith("recover", bound));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it.each([
    ["not-started", "Not started"],
    ["needs-attention", "Needs attention"],
    ["cancelled", "Cancelled"],
  ] as const)(
    "routes a %s phase with a null-path binding through recovery",
    async (status, statusLabel) => {
      const cwd = `/work/null-path-${status}`;
      const client = new FakeProjectNotesClient(cwd);
      const populated = notes("reference");
      const link = { sessionId: "bound", sessionPath: null };
      populated.phases = [
        {
          ...phase(status, status),
          title: `${statusLabel} recovery`,
          session: link,
          attentionReason:
            status === "needs-attention" ? "The previous session lost its path." : null,
        },
      ];
      client.seed(cwd, populated);
      const onResumePhase = vi.fn().mockResolvedValue(undefined);
      render(<ProjectNotes cwd={cwd} client={client} onResumePhase={onResumePhase} />);

      fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
      selectNotesTab("Roadmap");
      fireEvent.click(
        screen.getByRole("button", { name: `Recover phase: ${statusLabel} recovery` }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Recover phase" }));

      await waitFor(() => expect(onResumePhase).toHaveBeenCalledExactlyOnceWith(status, link));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    },
  );

  it("saves an exact prompt through the imperative handle and renders it in phase detail", async () => {
    const cwd = "/work/saved-prompt";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.phases = [{ ...phase("target", "in-progress"), sourcePrompt: "" }];
    client.seed(cwd, populated);
    const actions = createRef<ProjectNotesPromptActions>();
    render(<ProjectNotes ref={actions} cwd={cwd} client={client} />);

    await waitFor(() => expect(actions.current?.listDestinations()).toHaveLength(1));
    expect(actions.current?.listDestinations()).toEqual([
      { phaseId: "target", title: "Phase target", sourcePrompt: "" },
    ]);

    const prompt = "Exact saved prompt\n  with indentation and symbols <>&";
    await act(async () => {
      await expect(
        actions.current!.savePrompt({
          kind: "existing-phase",
          phaseId: "target",
          prompt,
          expectedSourcePrompt: "",
        }),
      ).resolves.toEqual({ status: "committed", phaseId: "target", title: "Phase target" });
    });
    expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.phases[0]!.sourcePrompt).toBe(
      prompt,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Phase target" }));
    const heading = screen.getByRole("heading", { name: "Saved prompt" });
    expect(heading).toBeTruthy();
    expect(heading.nextElementSibling?.textContent).toBe(prompt);
  });

  it.each(PHASE_ACTION_MATRIX)(
    "routes a %s phase with %s linkage through %s",
    async (status, sessionFixture, expectedAction) => {
      const cwd = `/work/action-${status}-${sessionFixture}`;
      const client = new FakeProjectNotesClient(cwd);
      const document = notes("primary action matrix");
      const selected = phase(`${status}-${sessionFixture}`, status);
      selected.session = phaseSession(sessionFixture);
      document.phases = [selected];
      client.seed(cwd, document);
      const onStartPhase = vi.fn().mockResolvedValue({
        status: "accepted",
        operationId: "operation-matrix",
        session: { sessionId: "started", sessionPath: "/sessions/started.jsonl" },
        packageTokenCount: 1,
      });
      const onResumePhase = vi.fn().mockResolvedValue(undefined);
      render(
        <ProjectNotes
          cwd={cwd}
          client={client}
          onStartPhase={onStartPhase}
          onResumePhase={onResumePhase}
        />,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
      selectNotesTab("Roadmap");
      const rowAction = screen.getByRole("button", {
        name: `${expectedAction} phase: ${selected.title}`,
      }) as HTMLButtonElement;
      expect(rowAction.disabled).toBe(false);
      fireEvent.click(rowAction);

      if (expectedAction === "Review") {
        expect(screen.getByText("This phase is available for scope review only.")).toBeTruthy();
        expect(screen.queryByRole("button", { name: /^(Start|Recover|Resume) phase$/ })).toBeNull();
      } else {
        const detailAction = screen.getByRole("button", {
          name: `${expectedAction} phase`,
        }) as HTMLButtonElement;
        expect(detailAction.disabled).toBe(false);
        fireEvent.click(detailAction);
        if (expectedAction === "Start") {
          await waitFor(() => expect(onStartPhase).toHaveBeenCalledExactlyOnceWith(selected.id));
        } else {
          await waitFor(() =>
            expect(onResumePhase).toHaveBeenCalledExactlyOnceWith(selected.id, selected.session),
          );
        }
      }

      expect(onStartPhase).toHaveBeenCalledTimes(expectedAction === "Start" ? 1 : 0);
      expect(onResumePhase).toHaveBeenCalledTimes(
        expectedAction === "Recover" || expectedAction === "Resume" ? 1 : 0,
      );
    },
  );

  it.each(["unbound", "missing-path", "path-present"] as const)(
    "keeps a manually cancelled phase review-only with %s linkage",
    async (sessionFixture) => {
      const cwd = `/work/manual-cancelled-${sessionFixture}`;
      const client = new FakeProjectNotesClient(cwd);
      const document = notes("manual cancellation action");
      const selected = phase(`manual-cancelled-${sessionFixture}`, "cancelled");
      selected.session = phaseSession(sessionFixture);
      selected.overrides.status = { value: "cancelled", source: "user", updatedAt: NOW };
      document.phases = [selected];
      client.seed(cwd, document);
      const onStartPhase = vi.fn();
      const onResumePhase = vi.fn();
      render(
        <ProjectNotes
          cwd={cwd}
          client={client}
          onStartPhase={onStartPhase}
          onResumePhase={onResumePhase}
        />,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
      selectNotesTab("Roadmap");
      const rowAction = screen.getByRole("button", {
        name: `Review phase: ${selected.title}`,
      }) as HTMLButtonElement;
      expect(rowAction.disabled).toBe(false);
      fireEvent.click(rowAction);
      expect(screen.getByText("This phase is available for scope review only.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^(Start|Recover|Resume) phase$/ })).toBeNull();
      expect(onStartPhase).not.toHaveBeenCalled();
      expect(onResumePhase).not.toHaveBeenCalled();
    },
  );

  it("renders authoritative lifecycle labels and recovery actions without losing selection", async () => {
    const cwd = "/work/roadmap-lifecycle";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    const bound = { sessionId: "bound", sessionPath: "/bound.jsonl" };
    populated.phases = [
      { ...phase("not-started", "not-started"), title: "Not started phase", order: 0 },
      { ...phase("planning", "planning"), title: "Planning phase", order: 1 },
      {
        ...phase("waiting", "waiting-for-approval"),
        title: "Waiting phase",
        order: 2,
        session: bound,
      },
      { ...phase("progress", "in-progress"), title: "Progress phase", order: 3, session: bound },
      { ...phase("review", "review"), title: "Review phase", order: 4, session: bound },
      { ...phase("done", "done"), title: "Done phase", order: 5, session: bound },
      {
        ...phase("attention", "needs-attention"),
        title: "Attention phase",
        order: 6,
        attentionReason:
          "The provider failed while validating a very long localized implementation result that still needs recovery.",
      },
      {
        ...phase("attention-bound", "needs-attention"),
        title: "Bound attention phase",
        order: 7,
        session: bound,
        attentionReason: "Resume the bound phase.",
      },
      {
        ...phase("cancelled", "cancelled"),
        title: "Cancelled phase",
        order: 8,
        session: bound,
      },
      {
        ...phase("manual-cancelled", "cancelled"),
        title: "Manual cancellation",
        order: 9,
        session: bound,
        overrides: {
          status: { value: "cancelled", source: "user", updatedAt: NOW },
          referenceIds: null,
        },
        pendingAutomaticLifecycleTransition: {
          status: "review",
          source: "agent",
          reason: "Autopilot review started",
          kind: "other",
          timestamp: "2026-07-15T12:01:00.000Z",
          expectedSession: bound,
        },
      },
    ];
    client.seed(cwd, populated);
    const onResumePhase = vi.fn().mockResolvedValue(undefined);
    render(<ProjectNotes cwd={cwd} client={client} onResumePhase={onResumePhase} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    const expectedRows = [
      ["Not started phase", "Not started", "Start"],
      ["Planning phase", "Planning", "Start"],
      ["Waiting phase", "Waiting for approval", "Resume"],
      ["Progress phase", "In progress", "Resume"],
      ["Review phase", "Review", "Review"],
      ["Done phase", "Done", "Review"],
      ["Attention phase", "Needs attention", "Start"],
      ["Bound attention phase", "Needs attention", "Resume"],
      ["Cancelled phase", "Cancelled", "Resume"],
      ["Manual cancellation", "Cancelled", "Review"],
    ] as const;
    for (const [title, label, action] of expectedRows) {
      const button = screen.getByRole("button", { name: `${action} phase: ${title}` });
      expect(button.closest("li")?.textContent).toContain(label);
    }

    fireEvent.click(screen.getByRole("button", { name: "Start phase: Attention phase" }));
    expect(screen.getByText(/Needs attention: The provider failed/)).toBeTruthy();
    const statusSelect = screen.getByLabelText("Status override");
    const helpId = statusSelect.getAttribute("aria-describedby");
    expect(helpId).toBeTruthy();
    expect(document.getElementById(helpId!)?.textContent).toBe(
      "Choosing a status pauses automatic lifecycle updates for this phase.",
    );

    const refreshed = structuredClone(populated);
    refreshed.phases[6] = {
      ...refreshed.phases[6]!,
      status: "in-progress",
      session: bound,
      attentionReason: "Stale reason must stay hidden.",
      updatedAt: "2026-07-15T12:01:00.000Z",
    };
    act(() => client.publish(cwd, refreshed, 2));
    expect(await screen.findByRole("heading", { name: "Attention phase" })).toBeTruthy();
    expect(screen.queryByText(/Stale reason must stay hidden/)).toBeNull();
    expect(screen.getByRole("button", { name: "Resume phase" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back to roadmap" }));
    fireEvent.click(screen.getByRole("button", { name: "Review phase: Manual cancellation" }));
    const overriddenSelect = screen.getByLabelText("Status override");
    const overriddenHelpId = overriddenSelect.getAttribute("aria-describedby");
    expect(document.getElementById(overriddenHelpId!)?.textContent).toBe(
      "Automatic lifecycle updates are paused. Resuming will set status to Review.",
    );
    expect(screen.queryByRole("button", { name: "Resume phase" })).toBeNull();
  });

  it("keeps one selected phase open across authoritative snapshots", async () => {
    const cwd = "/work/roadmap-selection";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.phases = [{ ...phase("only", "done"), title: "Only phase" }];
    client.seed(cwd, populated);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    expect(screen.queryByText("Selected phase")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review phase: Only phase" }));
    expect(screen.getByRole("heading", { name: "Only phase" })).toBeTruthy();

    const refreshed = {
      ...populated,
      phases: [{ ...populated.phases[0]!, title: "Only phase refreshed", updatedAt: NOW }],
    };
    act(() => client.publish(cwd, refreshed, 2));

    expect(await screen.findByRole("heading", { name: "Only phase refreshed" })).toBeTruthy();
    expect(screen.getByText("Selected phase")).toBeTruthy();
  });

  it("creates, edits, reorders, overrides, cancels, archives, and restores phases", async () => {
    const cwd = "/work/roadmap-crud";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.phases = [
      { ...phase("alpha", "not-started"), title: "Alpha", order: 0 },
      { ...phase("beta", "in-progress"), title: "Beta", order: 1 },
    ];
    client.seed(cwd, populated);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    expect(screen.getByRole("button", { name: "Start phase: Alpha" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start phase: Beta" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New phase" }));
    fireEvent.change(screen.getByLabelText("Phase title"), { target: { value: "Gamma" } });
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Ship phase CRUD" } });
    fireEvent.change(screen.getByLabelText("Done when"), {
      target: { value: "Create persists\nArchive restores" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create phase" }));

    await waitFor(() => {
      const stored = client.snapshots.get(canonicalProjectKey(cwd))!.document.phases;
      expect(stored.map((item) => item.title)).toEqual(["Alpha", "Beta", "Gamma"]);
      expect(stored.map((item) => item.order)).toEqual([0, 1, 2]);
    });

    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Alpha" }));
    expect(screen.getByText("Verify the Notes shell")).toBeTruthy();
    expect(screen.getByText("Shell evidence passes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit phase title"), {
      target: { value: "Alpha edited" },
    });
    fireEvent.change(screen.getByLabelText("Edit goal"), { target: { value: "Edited goal" } });
    fireEvent.change(screen.getByLabelText("Edit Done when"), {
      target: { value: "First check\nSecond check" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.phases[0]).toMatchObject({
        title: "Alpha edited",
        goal: "Edited goal",
        doneWhen: ["First check", "Second check"],
      }),
    );

    fireEvent.change(screen.getByLabelText("Status override"), { target: { value: "done" } });
    await waitFor(() => {
      const stored = client.snapshots.get(canonicalProjectKey(cwd))!.document.phases[0]!;
      expect(stored.status).toBe("done");
      expect(stored.completedAt).not.toBeNull();
      expect(stored.overrides.status).toMatchObject({ value: "done", source: "user" });
      expect(stored.lifecycleEvents[stored.lifecycleEvents.length - 1]).toMatchObject({
        fromStatus: "not-started",
        toStatus: "done",
        source: "user",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Move up" }));
    await waitFor(() =>
      expect(
        client.snapshots.get(canonicalProjectKey(cwd))!.document.phases.map((item) => item.title),
      ).toEqual(["Beta", "Alpha edited", "Gamma"]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel phase" }));
    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.phases[0]!.status).toBe(
        "cancelled",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Archive phase" }));
    await waitFor(() =>
      expect(
        client.snapshots.get(canonicalProjectKey(cwd))!.document.phases[0]!.archivedAt,
      ).not.toBe(null),
    );
    expect(screen.queryByText("Selected phase")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Inspect phase: Alpha edited" }),
      ),
    );

    selectNotesTab("Archive");
    fireEvent.click(screen.getByRole("button", { name: "Restore phase: Beta" }));
    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.phases[0]!.archivedAt).toBe(
        null,
      ),
    );
    selectNotesTab("Roadmap");
    expect(screen.queryByText("Selected phase")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Beta" }));
    expect(screen.getByText("Selected phase")).toBeTruthy();
  });

  it("creates, validates, inspects, opens, edits, unlinks, and deletes one shared reference", async () => {
    const cwd = "/work/reference-crud";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("Free-form reference stays here");
    populated.phases = [{ ...phase("alpha", "in-progress"), title: "Phase alpha" }];
    client.seed(cwd, populated);
    const openSource = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    render(<ProjectNotes cwd={cwd} client={client} openSource={openSource} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
      "Free-form reference stays here",
    );
    expect(screen.getByText("No structured references yet")).toBeTruthy();
    expect(openSource).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "New reference" }));
    expect((screen.getByLabelText("Canonical URL (required)") as HTMLInputElement).maxLength).toBe(
      NOTES_REFERENCE_URL_MAX_LENGTH,
    );
    for (const label of [
      "Provider (required)",
      "Tool",
      "Repository owner (required)",
      "Repository name (required)",
      "Relevance note",
      "Revision",
      "Path",
      "Query",
      "Anchor",
    ]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).maxLength).toBe(
        NOTES_REFERENCE_METADATA_MAX_LENGTH,
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "Create reference" }));
    expect(await screen.findByText(/Fix 3 fields/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Canonical URL (required)"));

    fireEvent.change(screen.getByLabelText("Tool"), { target: { value: " github-search " } });
    fireEvent.change(screen.getByLabelText("Canonical URL (required)"), {
      target: { value: "HTTPS://GITHUB.COM:443/Owner/Repo/pull/44/" },
    });
    fireEvent.change(screen.getByLabelText("Repository owner (required)"), {
      target: { value: " Owner " },
    });
    fireEvent.change(screen.getByLabelText("Repository name (required)"), {
      target: { value: " Repo " },
    });
    fireEvent.change(screen.getByLabelText("Relevance note"), {
      target: { value: " Reviews the structured reference boundary " },
    });
    fireEvent.change(screen.getByLabelText("Revision"), { target: { value: " main " } });
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: " src/file.ts " } });
    fireEvent.change(screen.getByLabelText("Start line"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("End line"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Pull request number"), { target: { value: "44" } });
    fireEvent.change(screen.getByLabelText("Query"), { target: { value: " schema " } });
    fireEvent.change(screen.getByLabelText("Anchor"), { target: { value: " discussion_r44 " } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Phase alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Create reference" }));

    const inspect = await screen.findByRole("button", {
      name: "Inspect reference: Pull request #44 in Owner/Repo",
    });
    expect(openSource).not.toHaveBeenCalled();
    fireEvent.click(inspect);
    expect(screen.getByText("https://github.com/Owner/Repo/pull/44")).toBeTruthy();
    expect(screen.getAllByText("Reviews the structured reference boundary")).toHaveLength(2);
    expect(screen.getByText("10 to 20")).toBeTruthy();
    expect(openSource).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    await waitFor(() =>
      expect(openSource).toHaveBeenCalledExactlyOnceWith("https://github.com/Owner/Repo/pull/44"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Relevance note"), {
      target: { value: "Updated relevance" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findAllByText("Updated relevance")).toHaveLength(2);
    const storedAfterEdit = client.snapshots.get(canonicalProjectKey(cwd))!.document;
    expect(storedAfterEdit.references[0]).toMatchObject({
      id: expect.any(String),
      capturedAt: expect.any(String),
      owner: "Owner",
      repo: "Repo",
      revision: "main",
      path: "src/file.ts",
      range: { startLine: 10, endLine: 20 },
      pullRequest: 44,
      query: "schema",
      anchor: "discussion_r44",
      relevance: "Updated relevance",
    });
    expect(storedAfterEdit.phases[0]?.overrides.referenceIds).toMatchObject({ source: "user" });
    expect(
      screen.getByText(/Unlink this reference from Phase alpha before deleting it/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /Phase alpha/ }));
    await waitFor(() =>
      expect(
        client.snapshots.get(canonicalProjectKey(cwd))!.document.phases[0]!.referenceIds,
      ).toEqual([]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete reference" }));
    expect(screen.getByRole("group", { name: "Confirm delete reference" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.references).toEqual([]),
    );
    expect(screen.getByText("No structured references yet")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New reference" }));
  });

  it.each([
    ["username", "https://user@github.com/owner/repo"],
    ["password", "https://:secret@github.com/owner/repo"],
  ])(
    "rejects a reference URL containing a %s before component persistence",
    async (_credential, url) => {
      const cwd = "/work/reference-credentials";
      const client = new FakeProjectNotesClient(cwd);
      client.seed(cwd, notes("reference"));
      render(<ProjectNotes cwd={cwd} client={client} />);

      fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
      selectNotesTab("Reference");
      fireEvent.click(screen.getByRole("button", { name: "New reference" }));
      fireEvent.change(screen.getByLabelText("Canonical URL (required)"), {
        target: { value: url },
      });
      fireEvent.change(screen.getByLabelText("Repository owner (required)"), {
        target: { value: "owner" },
      });
      fireEvent.change(screen.getByLabelText("Repository name (required)"), {
        target: { value: "repo" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create reference" }));

      expect(
        await screen.findByText(
          "Enter an absolute HTTP or HTTPS URL without a username or password.",
        ),
      ).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByLabelText("Canonical URL (required)"));
      expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.references).toEqual([]);
    },
  );

  it("blocks a credential-bearing stored reference before invoking the system opener", async () => {
    const cwd = "/work/reference-open-credentials";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.references = [
      {
        ...reference("ref-credential"),
        canonicalUrl: "https://user:secret@github.com/owner/repo/blob/main/src/file.ts#L1-L2",
      },
    ];
    client.seed(cwd, populated);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect reference: src/file.ts:L1-L2 in owner/repo" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn’t open this source in the system browser. Try again.",
    );
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("reuses a duplicate, preserves selection snapshots, and surfaces opener failure", async () => {
    const cwd = "/work/reference-duplicate";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.references = [reference("ref-existing")];
    client.seed(cwd, populated);
    const openSource = vi
      .fn<(url: string) => Promise<void>>()
      .mockRejectedValue(new Error("blocked"));
    render(<ProjectNotes cwd={cwd} client={client} openSource={openSource} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect reference: src/file.ts:L1-L2 in owner/repo" }),
    );
    expect(openSource).not.toHaveBeenCalled();

    const refreshed = {
      ...populated,
      references: [{ ...populated.references[0]!, relevance: "Refreshed stored metadata" }],
    };
    act(() => client.publish(cwd, refreshed, 2));
    expect(await screen.findAllByText("Refreshed stored metadata")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Open source" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn’t open this source in the system browser. Try again.",
    );
    expect(openSource).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Back to references" }));
    fireEvent.click(screen.getByRole("button", { name: "New reference" }));
    fireEvent.change(screen.getByLabelText("Canonical URL (required)"), {
      target: { value: "https://github.com/owner/repo/blob/main/src/file.ts#L1-L2" },
    });
    fireEvent.change(screen.getByLabelText("Repository owner (required)"), {
      target: { value: "owner" },
    });
    fireEvent.change(screen.getByLabelText("Repository name (required)"), {
      target: { value: "repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create reference" }));

    expect(await screen.findByText(/Already saved: src\/file.ts:L1-L2/)).toBeTruthy();
    expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.references).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Open source" })).toBeTruthy();

    const removed = {
      ...client.snapshots.get(canonicalProjectKey(cwd))!.document,
      references: [],
    };
    act(() => client.publish(cwd, removed, 3));
    expect(await screen.findByText("No structured references yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open source" })).toBeNull();
  });

  it("keeps a stale edit open and reports a canonical collision after conflict replay", async () => {
    const cwd = "/work/reference-edit-collision";
    const client = new FakeProjectNotesClient(cwd);
    const initial = notes("reference");
    initial.references = [reference("ref-edited")];
    client.seed(cwd, initial);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect reference: src/file.ts:L1-L2 in owner/repo" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const winner = reference("ref-winner", "owner", "repo", "src/winner.ts");
    fireEvent.change(screen.getByLabelText("Canonical URL (required)"), {
      target: { value: winner.canonicalUrl },
    });
    client.beforeNextSave = () => {
      const authoritative = { ...initial, references: [initial.references[0]!, winner] };
      client.seed(cwd, authoritative, 2);
    };
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(/Couldn’t save: another reference now uses these source coordinates/),
    ).toBeTruthy();
    expect(screen.queryByText(/Updated reference:/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect((screen.getByLabelText("Canonical URL (required)") as HTMLInputElement).value).toBe(
      winner.canonicalUrl,
    );
    expect(
      client.snapshots
        .get(canonicalProjectKey(cwd))!
        .document.references.find((item) => item.id === "ref-edited")?.canonicalUrl,
    ).toBe(initial.references[0]!.canonicalUrl);
  });

  it("restores a delete selection when a concurrent phase link blocks replay", async () => {
    const cwd = "/work/reference-delete-linked";
    const client = new FakeProjectNotesClient(cwd);
    const initial = notes("reference");
    initial.references = [reference("ref-delete")];
    initial.phases = [{ ...phase("alpha", "in-progress"), title: "Phase alpha" }];
    client.seed(cwd, initial);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect reference: src/file.ts:L1-L2 in owner/repo" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete reference" }));
    client.beforeNextSave = () => {
      const authoritative = {
        ...initial,
        phases: [{ ...initial.phases[0]!, referenceIds: ["ref-delete"] }],
      };
      client.seed(cwd, authoritative, 2);
    };
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    expect(
      await screen.findByText(/Couldn’t delete: this reference was attached to a phase/),
    ).toBeTruthy();
    expect(screen.queryByText(/Deleted reference:/)).toBeNull();
    expect(screen.getByRole("heading", { name: "src/file.ts:L1-L2" })).toBeTruthy();
    expect(
      screen.getByText(/Unlink this reference from Phase alpha before deleting it/),
    ).toBeTruthy();
    expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.references).toHaveLength(1);
  });

  it("reports a phase that disappears while a roadmap attachment rebases", async () => {
    const cwd = "/work/reference-link-missing-phase";
    const client = new FakeProjectNotesClient(cwd);
    const initial = notes("reference");
    initial.references = [reference("ref-link")];
    initial.phases = [{ ...phase("alpha", "in-progress"), title: "Phase alpha" }];
    client.seed(cwd, initial);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Phase alpha" }));
    client.beforeNextSave = () => client.seed(cwd, { ...initial, phases: [] }, 2);
    fireEvent.click(screen.getByRole("checkbox", { name: /Evidence from owner\/repo/ }));

    expect(
      await screen.findByText("Couldn’t attach: the phase was removed in another window."),
    ).toBeTruthy();
    expect(screen.queryByText(/Attached src\/file.ts:L1-L2 to Phase alpha/)).toBeNull();
    expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.phases).toEqual([]);
  });

  it("reports a reference that disappears while an unlink rebases", async () => {
    const cwd = "/work/reference-unlink-missing-reference";
    const client = new FakeProjectNotesClient(cwd);
    const initial = notes("reference");
    initial.references = [reference("ref-unlink")];
    initial.phases = [
      { ...phase("alpha", "in-progress"), title: "Phase alpha", referenceIds: ["ref-unlink"] },
    ];
    client.seed(cwd, initial);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect reference: src/file.ts:L1-L2 in owner/repo" }),
    );
    client.beforeNextSave = () => {
      client.seed(
        cwd,
        {
          ...initial,
          references: [],
          phases: [{ ...initial.phases[0]!, referenceIds: [] }],
        },
        2,
      );
    };
    fireEvent.click(screen.getByRole("checkbox", { name: /Phase alpha/ }));

    expect(
      await screen.findByText("Couldn’t detach: the reference was removed in another window."),
    ).toBeTruthy();
    expect(screen.queryByText(/Detached reference from Phase alpha/)).toBeNull();
    expect(await screen.findByText("No structured references yet")).toBeTruthy();
  });

  it("keeps a reference edit open when the backend rejects the save", async () => {
    const cwd = "/work/reference-invalid-save";
    const client = new FakeProjectNotesClient(cwd);
    const initial = notes("reference");
    initial.references = [reference("ref-invalid")];
    client.seed(cwd, initial);
    client.saveOutcome = {
      status: "invalid",
      error: { path: "references[0].canonicalUrl", message: "invalid fixture" },
    };
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect reference: src/file.ts:L1-L2 in owner/repo" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Relevance note"), {
      target: { value: "Unsaved invalid edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(/Couldn’t save: Project Notes rejected the change/),
    ).toBeTruthy();
    expect(screen.queryByText(/Updated reference:/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect((screen.getByLabelText("Relevance note") as HTMLTextAreaElement).value).toBe(
      "Unsaved invalid edit",
    );
    expect(client.snapshots.get(canonicalProjectKey(cwd))!.document.references[0]!.relevance).toBe(
      "Evidence from owner/repo",
    );
    expect((await screen.findByLabelText("Notes storage status")).textContent).toContain(
      "Changes aren’t saved",
    );
  });

  it("opens reference creation from empty phase detail and renders fifty grouped rows", async () => {
    const cwd = "/work/reference-density";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.phases = [{ ...phase("empty", "not-started"), title: "Empty context phase" }];
    populated.references = Array.from({ length: 50 }, (_, index) =>
      reference(
        `ref-${index}`,
        index % 2 === 0 ? "alpha" : "beta",
        index % 2 === 0 ? "frontend" : "sidecar",
        `src/long/path/reference-${String(index).padStart(2, "0")}.ts`,
      ),
    );
    client.seed(cwd, populated);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Empty context phase" }));
    expect(screen.getByRole("heading", { name: "Attached references" })).toBeTruthy();
    expect(screen.getAllByRole("checkbox", { name: /Evidence from/ })).toHaveLength(50);

    selectNotesTab("Reference");
    expect(screen.getByText("50 references")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /alpha\/frontend/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /beta\/sidecar/ })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Inspect reference:/ })).toHaveLength(50);
    expect(document.querySelectorAll(".notes-reference-row button button")).toHaveLength(0);

    const empty = { ...populated, references: [] };
    act(() => client.publish(cwd, empty, 2));
    selectNotesTab("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Inspect phase: Empty context phase" }));
    fireEvent.click(screen.getByRole("button", { name: "Create a reference" }));
    expect(screen.getByRole("tab", { name: "Reference" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(await screen.findByRole("heading", { name: "New structured reference" })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Provider (required)")),
    );
  });

  it("renders a stable accessible list for fifty phases", async () => {
    const cwd = "/work/roadmap-density";
    const client = new FakeProjectNotesClient(cwd);
    const populated = notes("reference");
    populated.phases = Array.from({ length: 50 }, (_, order) => ({
      ...phase(`density-${order}`, order % 3 === 0 ? "review" : "not-started"),
      title: `Phase ${String(order + 1).padStart(2, "0")} with a deliberately long title`,
      order,
    }));
    client.seed(cwd, populated);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Roadmap");

    const list = screen.getByRole("list", { name: "Roadmap phases" });
    expect(list.children).toHaveLength(50);
    expect(list.querySelectorAll(".notes-roadmap-row")).toHaveLength(50);
    expect(screen.getAllByRole("button", { name: /phase: Phase/ })).toHaveLength(100);
  });

  it("preserves tab, task draft, edit mode, and Archive disclosure through rerenders", async () => {
    const cwd = "/work/mounted-panels";
    const client = new FakeProjectNotesClient(cwd);
    const original = notes("initial reference", 1);
    client.seed(cwd, original, 1);
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes, 1 unfinished task" }));
    fireEvent.change(screen.getByLabelText("Add a Notes task"), {
      target: { value: "Draft survives navigation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit task: Task 1" }));
    fireEvent.change(screen.getByLabelText("Edit task: Task 1"), {
      target: { value: "Uncommitted task edit" },
    });

    selectNotesTab("Archive");
    const archiveToggle = screen.getByRole("button", { name: "Show archived tasks (0)" });
    fireEvent.click(archiveToggle);
    expect(archiveToggle.getAttribute("aria-expanded")).toBe("true");
    selectNotesTab("Reference");

    const updated = { ...original, reference: "authoritative reference", updatedAt: NOW };
    act(() => client.publish(cwd, updated, 2));
    await waitFor(() =>
      expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
        "authoritative reference",
      ),
    );
    expect(screen.getByRole("tab", { name: "Reference" }).getAttribute("aria-selected")).toBe(
      "true",
    );

    selectNotesTab("Archive");
    expect(
      screen.getByRole("button", { name: "Hide archived tasks (0)" }).getAttribute("aria-expanded"),
    ).toBe("true");
    selectNotesTab("Overview");
    expect((screen.getByLabelText("Add a Notes task") as HTMLInputElement).value).toBe(
      "Draft survives navigation",
    );
    expect((screen.getByLabelText("Edit task: Task 1") as HTMLInputElement).value).toBe(
      "Uncommitted task edit",
    );
  });

  it("keeps create, edit, move, archive, and restore flows on the sidecar path", async () => {
    const cwd = "/work/task-actions";
    const client = new FakeProjectNotesClient(cwd);
    client.seed(cwd, notes("reference", 2));
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes, 2 unfinished tasks" }));
    fireEvent.change(screen.getByLabelText("Add a Notes task"), {
      target: { value: "Task 3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.tasks).toHaveLength(3),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit task: Task 1" }));
    fireEvent.change(screen.getByLabelText("Edit task: Task 1"), {
      target: { value: "Edited task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.tasks[0]?.text).toBe(
        "Edited task",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Move task up: Task 2" }));
    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.tasks[0]?.text).toBe(
        "Task 2",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Archive task: Edited task" }));
    await waitFor(() =>
      expect(
        client.snapshots
          .get(canonicalProjectKey(cwd))
          ?.document.tasks.find((task) => task.text === "Edited task")?.archivedAt,
      ).not.toBeNull(),
    );

    selectNotesTab("Archive");
    fireEvent.click(screen.getByRole("button", { name: "Show archived tasks (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore task: Edited task" }));
    await waitFor(() =>
      expect(
        client.snapshots
          .get(canonicalProjectKey(cwd))
          ?.document.tasks.find((task) => task.text === "Edited task")?.archivedAt,
      ).toBeNull(),
    );
  });
  it("renders sidecar state and saves edits without dual-writing browser storage", async () => {
    const cwd = "/work/project";
    const client = new FakeProjectNotesClient(cwd);
    client.seed(cwd, notes("sidecar reference", 2));
    store(cwd, notes("stale local"));
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes, 2 unfinished tasks" }));
    expect((screen.getByLabelText("Current focus") as HTMLInputElement).value).toBe(
      "Focus sidecar reference",
    );
    selectNotesTab("Reference");
    fireEvent.change(screen.getByLabelText("Reference notes"), {
      target: { value: "updated reference" },
    });

    await waitFor(() =>
      expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.reference).toBe(
        "updated reference",
      ),
    );
    expect(localStorage.getItem(legacyNotesKey(cwd))).toBe("stale local");
    expect(JSON.parse(localStorage.getItem(v3NotesKey(cwd))!).reference).toBe("stale local");
  });

  it("preserves focus, task lifecycle, and handoff behavior through sidecar saves", async () => {
    const cwd = "/work/structured";
    const client = new FakeProjectNotesClient(cwd);
    client.seed(cwd, notes("reference", 1));
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes, 1 unfinished task" }));
    fireEvent.change(screen.getByLabelText("Current focus"), {
      target: { value: "Finish the port" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Complete task: Task 1" }));
    fireEvent.change(screen.getByLabelText("Handoff notes"), {
      target: { value: "Review the uncommitted diff" },
    });

    await waitFor(() => {
      const persisted = client.snapshots.get(canonicalProjectKey(cwd))!.document;
      expect(persisted.currentFocus).toBe("Finish the port");
      expect(persisted.tasks[0]).toMatchObject({ status: "done" });
      expect(persisted.handoff.text).toBe("Review the uncommitted diff");
    });
    expect(await screen.findByRole("button", { name: "Notes" })).toBeTruthy();
  });

  it("closes an open modal and loads only the newly selected project's sidecar Notes", async () => {
    const cwdA = "C:\\work\\a";
    const cwdB = "C:\\work\\b";
    const client = new FakeProjectNotesClient(cwdA);
    client.seed(cwdA, notes("project A"));
    client.seed(cwdB, notes("project B", 1));
    const view = render(<ProjectNotes cwd={cwdA} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
      "project A",
    );

    client.cwd = cwdB;
    view.rerender(<ProjectNotes cwd={cwdB} client={client} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Notes, 1 unfinished task" }));
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect((screen.getByLabelText("Current focus") as HTMLInputElement).value).toBe(
      "Focus project B",
    );
    selectNotesTab("Reference");

    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
      "project B",
    );
  });

  it("migrates local content once and restores after localStorage is cleared", async () => {
    const cwd = "/work/migrate";
    const client = new FakeProjectNotesClient(cwd);
    store(cwd, notes("  migrated\r\nbytes 😀\n", 1));
    const first = render(<ProjectNotes cwd={cwd} client={client} />);

    expect(await screen.findByRole("button", { name: "Notes, 1 unfinished task" })).toBeTruthy();
    expect(client.migrations).toBe(1);
    first.unmount();
    localStorage.clear();

    render(<ProjectNotes cwd={cwd} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Notes, 1 unfinished task" }));
    selectNotesTab("Reference");
    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
      "  migrated\nbytes 😀\n",
    );
    expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.reference).toBe(
      "  migrated\r\nbytes 😀\n",
    );
    expect(client.migrations).toBe(1);
  });

  it("updates status and content from a newer sidecar event", async () => {
    const cwd = "C:\\Work\\Project";
    const client = new FakeProjectNotesClient(cwd);
    client.seed(cwd, notes("initial", 1), 1);
    render(<ProjectNotes cwd={cwd} client={client} />);
    expect(await screen.findByRole("button", { name: "Notes, 1 unfinished task" })).toBeTruthy();

    act(() => client.publish(cwd, notes("latest", 3), 2));

    const trigger = await screen.findByRole("button", { name: "Notes, 3 unfinished tasks" });
    fireEvent.click(trigger);
    selectNotesTab("Reference");
    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe("latest");
  });

  it("surfaces corrupt project Notes while keeping the local fallback editable", async () => {
    const cwd = "/work/corrupt";
    const client = new FakeProjectNotesClient(cwd);
    client.getOutcome = {
      status: "corrupt",
      primary: "malformed-json",
      backup: "invalid-envelope",
    };
    store(cwd, notes("local recovery copy"));
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));

    const storageStatus = await screen.findByLabelText("Notes storage status");
    expect(storageStatus.getAttribute("role")).toBe("alert");
    expect(storageStatus.textContent).toContain("Project Notes are unreadable");
    expect(storageStatus.textContent).toContain("local fallback");
    selectNotesTab("Reference");
    await waitFor(() =>
      expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
        "local recovery copy",
      ),
    );
  });

  it("explains migration failure and local fallback without leaking the raw error", async () => {
    const cwd = "/work/migration-failure";
    const client = new FakeProjectNotesClient(cwd);
    client.migrationError = new Error("C:\\Users\\private\\notes.json could not be written");
    store(cwd, notes("recoverable local notes"));
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));

    const storageStatus = await screen.findByLabelText("Notes storage status");
    await waitFor(() =>
      expect(storageStatus.textContent).toContain("Couldn’t move Notes to project storage"),
    );
    expect(storageStatus.textContent).toContain("local fallback");
    expect(storageStatus.textContent).not.toContain("private");
    selectNotesTab("Reference");
    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
      "recoverable local notes",
    );
  });

  it("shows a failed sidecar save while retaining the optimistic edit", async () => {
    const cwd = "/work/save-failure";
    const client = new FakeProjectNotesClient(cwd);
    client.seed(cwd, notes("saved reference"));
    client.saveOutcome = {
      status: "invalid",
      error: { path: "document", message: "invalid fixture" },
    };
    render(<ProjectNotes cwd={cwd} client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    selectNotesTab("Reference");
    const reference = screen.getByLabelText("Reference notes") as HTMLTextAreaElement;
    await waitFor(() => expect(reference.value).toBe("saved reference"));
    fireEvent.change(reference, { target: { value: "optimistic edit" } });

    const storageStatus = await screen.findByLabelText("Notes storage status");
    await waitFor(() => expect(storageStatus.textContent).toContain("Changes aren’t saved"));
    expect(storageStatus.getAttribute("role")).toBe("alert");
    expect(reference.value).toBe("optimistic edit");
    expect(client.snapshots.get(canonicalProjectKey(cwd))?.document.reference).toBe(
      "saved reference",
    );
  });
});
