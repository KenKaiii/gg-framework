import { describe, expect, it } from "vitest";
import {
  getActiveNotesPhaseCount,
  getActiveNotesReminderCount,
  getDueNotesReminderCount,
  getUnfinishedNotesTaskCount,
  isNotesHandoffUnread,
} from "./notes-status";
import type { NotesDocumentV3, NotesPhase, NotesPhaseStatus } from "./notes-types";

const NOW = "2026-07-25T12:00:00.000Z";

function phase(status: NotesPhaseStatus, withReminder = false): NotesPhase {
  return {
    id: `phase-${status}`,
    title: status,
    goal: "Verify shell counts",
    doneWhen: ["Counts are correct"],
    order: 0,
    status,
    sourcePrompt: "Implement Phase 17",
    referenceIds: [],
    session: null,
    reminder: withReminder
      ? {
          id: `reminder-${status}`,
          occurrenceKey: `occurrence-${status}`,
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

function document(phases: NotesPhase[] = []): NotesDocumentV3 {
  return {
    version: 3,
    reference: "Reference",
    currentFocus: "Focus",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: NOW,
    legacyImportedAt: null,
    phases,
    references: [],
  };
}

describe("Notes status selectors", () => {
  it("keeps existing task and Handoff semantics", () => {
    const notes = document();
    notes.tasks = [
      {
        id: "todo",
        text: "Active task",
        status: "todo",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
      },
      {
        id: "archived",
        text: "Archived task",
        status: "todo",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: NOW,
      },
    ];
    notes.handoff = { text: "Unread", updatedAt: NOW, readAt: null };

    expect(getUnfinishedNotesTaskCount(notes)).toBe(1);
    expect(isNotesHandoffUnread(notes)).toBe(true);
  });

  it("counts every unsettled phase as active", () => {
    const activeStatuses: NotesPhaseStatus[] = [
      "not-started",
      "planning",
      "waiting-for-approval",
      "in-progress",
      "review",
      "needs-attention",
    ];
    const notes = document([
      ...activeStatuses.map((status) => phase(status)),
      phase("done"),
      phase("cancelled"),
    ]);

    expect(getActiveNotesPhaseCount(notes)).toBe(activeStatuses.length);
  });

  it("does not count done or cancelled phases", () => {
    expect(getActiveNotesPhaseCount(document([phase("done"), phase("cancelled")]))).toBe(0);
  });

  it("counts reminders only when attached to active phases", () => {
    const notes = document([
      phase("planning", true),
      phase("in-progress", false),
      phase("review", true),
      phase("done", true),
      phase("cancelled", true),
    ]);

    expect(getActiveNotesReminderCount(notes)).toBe(2);
  });

  it("counts only current delivered occurrences as due reminder actions", () => {
    const delivered = phase("in-progress", true);
    delivered.reminder!.lastDelivery = {
      occurrenceKey: delivered.reminder!.occurrenceKey,
      attemptedAt: NOW,
      channel: "in-app",
      permission: "not-required",
    };
    const priorOccurrence = phase("review", true);
    priorOccurrence.reminder!.lastDelivery = {
      occurrenceKey: "prior-occurrence",
      attemptedAt: NOW,
      channel: "native",
      permission: "granted",
    };

    expect(
      getDueNotesReminderCount(document([delivered, priorOccurrence, phase("done", true)])),
    ).toBe(1);
  });

  it("excludes archived active phases and their reminders", () => {
    const archived = { ...phase("in-progress", true), archivedAt: NOW };
    expect(getActiveNotesPhaseCount(document([archived]))).toBe(0);
    expect(getActiveNotesReminderCount(document([archived]))).toBe(0);
    expect(getDueNotesReminderCount(document([archived]))).toBe(0);
  });

  it("returns zero counts for an empty roadmap", () => {
    expect(getActiveNotesPhaseCount(document())).toBe(0);
    expect(getActiveNotesReminderCount(document())).toBe(0);
    expect(getDueNotesReminderCount(document())).toBe(0);
  });
});
