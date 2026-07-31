import type { ReservedReminderOccurrence } from "./notes-types";

interface Props {
  delivery: ReservedReminderOccurrence;
  pending: boolean;
  error: string | null;
  onPrimary(): void;
  onSnooze(): void;
  onDismiss(): void;
}

export function RoadmapReminderAlert({
  delivery,
  pending,
  error,
  onPrimary,
  onSnooze,
  onDismiss,
}: Props): React.ReactElement {
  const titleId = `roadmap-reminder-${delivery.reminder.occurrenceKey}`;
  const primaryLabel = delivery.phase.session ? "Resume" : "Open phase";

  return (
    <section
      className="roadmap-reminder-alert"
      aria-labelledby={titleId}
      aria-describedby={error ? `${titleId}-status` : undefined}
    >
      <p className="sr-only" role="alert">
        Roadmap reminder due: {delivery.phase.title}
      </p>
      <div className="roadmap-reminder-alert-copy">
        <span className="notes-detail-label">Roadmap reminder due</span>
        <h2 id={titleId}>{delivery.phase.title}</h2>
        {delivery.reminder.note && <p>{delivery.reminder.note}</p>}
      </div>
      <div className="roadmap-reminder-alert-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={pending}
          onClick={onPrimary}
        >
          {pending ? "Working…" : primaryLabel}
        </button>
        <button type="button" className="btn btn-sm" disabled={pending} onClick={onSnooze}>
          Snooze 1 hour
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={pending}
          onClick={onDismiss}
        >
          Dismiss reminder
        </button>
      </div>
      <p
        id={`${titleId}-status`}
        className={`roadmap-reminder-alert-status${error ? " error" : ""}`}
        role="status"
        aria-live="polite"
      >
        {error ?? (pending ? "Saving reminder action…" : "")}
      </p>
    </section>
  );
}
