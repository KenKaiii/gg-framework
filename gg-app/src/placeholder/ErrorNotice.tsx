import { useEffect, useId, useState, type ReactNode } from "react";
import { chatErrorCopy, chatErrorTone, type ChatErrorData } from "../chat-error";
import { StatusDot } from "./StatusDot";
import "./placeholder.css";

const MODEL_REASONS = new Set(["usage_limit", "model_access", "capability", "update"]);

/** One error row: headline and next step, raw report behind a details toggle. */
export function ErrorNotice({
  error,
  active,
  modelPicker,
  onContentGrow,
}: {
  error: ChatErrorData;
  active: boolean;
  modelPicker?: ReactNode;
  onContentGrow?: (() => void) | undefined;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now);
  const detailsId = useId();
  const tone = chatErrorTone(error, active);
  const copy = chatErrorCopy(error, active, now);
  const canChooseModel =
    active && !error.historical && error.reason != null && MODEL_REASONS.has(error.reason);

  // Only the current plan-limit row owns a single deadline timer, never a polling loop.
  useEffect(() => {
    if (!active || error.historical || error.reason !== "usage_limit" || error.resetsAt == null)
      return;
    const current = Date.now();
    setNow(current);
    const delay = error.resetsAt * 1000 - current;
    if (delay <= 0 || delay > 2_147_483_646) return;
    const timer = window.setTimeout(() => setNow(Date.now()), delay + 1);
    return () => window.clearTimeout(timer);
  }, [active, error.historical, error.reason, error.resetsAt]);

  useEffect(() => {
    if (expanded) onContentGrow?.();
  }, [expanded, onContentGrow]);

  return (
    <div className="placeholder-notice" data-tone={tone}>
      <StatusDot tone={tone} />
      <div className="placeholder-notice-body">
        <div role={active ? "status" : undefined} aria-atomic={active ? true : undefined}>
          <div className="placeholder-notice-headline">{copy.headline}</div>
          <div className="placeholder-muted">
            <span>{copy.guidance}</span> {canChooseModel && modelPicker}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-label={expanded ? "Hide error details" : "Show error details"}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((value) => !value)}
        >
          Details
        </button>
        <div id={detailsId} className="placeholder-muted" hidden={!expanded}>
          {!error.reason && error.headline && <p>{error.headline}</p>}
          {error.message || error.text ? (
            <p>{error.message ?? error.text}</p>
          ) : (
            <p>No additional detail was supplied.</p>
          )}
          {(tone === "history" || !error.reason) && error.guidance && <p>{error.guidance}</p>}
          {copy.resetLabel && <p>{copy.resetLabel}</p>}
          {error.provider && <p>Provider: {error.provider}</p>}
          {error.statusCode != null && <p>HTTP status: {error.statusCode}</p>}
          {error.requestId && <p>Request: {error.requestId}</p>}
          {error.occurredAt != null && (
            <p>Reported: {new Date(error.occurredAt).toLocaleString()}</p>
          )}
        </div>
      </div>
    </div>
  );
}
