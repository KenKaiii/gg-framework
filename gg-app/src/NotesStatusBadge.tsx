interface Props {
  unfinishedCount: number;
  dueReminderCount: number;
  handoffUnread: boolean;
}

export function notesStatusLabel({
  unfinishedCount,
  dueReminderCount,
  handoffUnread,
}: Props): string {
  const details: string[] = [];
  if (unfinishedCount > 0) {
    details.push(`${unfinishedCount} unfinished ${unfinishedCount === 1 ? "task" : "tasks"}`);
  }
  if (dueReminderCount > 0) {
    details.push(`${dueReminderCount} ${dueReminderCount === 1 ? "reminder" : "reminders"} due`);
  }
  if (handoffUnread) details.push("unread Handoff");
  return details.length === 0 ? "Notes" : `Notes, ${details.join(", ")}`;
}

export function NotesStatusBadge({
  unfinishedCount,
  dueReminderCount,
  handoffUnread,
}: Props): React.ReactElement {
  const actionCount = unfinishedCount + dueReminderCount;
  return (
    <span className="notes-status-badge" aria-hidden="true">
      <span>Notes{actionCount > 0 ? ` (${actionCount})` : ""}</span>
      {(dueReminderCount > 0 || handoffUnread) && <span className="notes-status-dot" />}
    </span>
  );
}
