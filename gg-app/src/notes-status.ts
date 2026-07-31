import type { NotesDocumentV3 } from "./notes-types";

export function getUnfinishedNotesTaskCount(document: NotesDocumentV3): number {
  return document.tasks.filter((task) => task.status === "todo" && task.archivedAt === null).length;
}

export function isNotesHandoffUnread(document: NotesDocumentV3): boolean {
  const { handoff } = document;
  if (handoff.text.trim().length === 0 || handoff.updatedAt === null) return false;
  if (handoff.readAt === null) return true;
  return Date.parse(handoff.readAt) < Date.parse(handoff.updatedAt);
}

function isActivePhase(status: NotesDocumentV3["phases"][number]["status"]): boolean {
  return status !== "done" && status !== "cancelled";
}

export function getActiveNotesPhaseCount(document: NotesDocumentV3): number {
  return document.phases.filter((phase) => phase.archivedAt === null && isActivePhase(phase.status))
    .length;
}

export function getActiveNotesReminderCount(document: NotesDocumentV3): number {
  return document.phases.filter(
    (phase) => phase.archivedAt === null && isActivePhase(phase.status) && phase.reminder !== null,
  ).length;
}

export function getDueNotesReminderCount(document: NotesDocumentV3): number {
  return document.phases.filter((phase) => {
    const reminder = phase.reminder;
    return (
      phase.archivedAt === null &&
      isActivePhase(phase.status) &&
      reminder !== null &&
      reminder.lastDelivery?.occurrenceKey === reminder.occurrenceKey
    );
  }).length;
}
