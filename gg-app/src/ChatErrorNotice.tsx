import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useAnimatedHeight } from "./animated-height";
import { viewportScale } from "./motion-geometry";
import { prefersReducedMotion } from "./transcript-motion";
import { usePresenceList } from "./usePresenceList";
import { openUrl } from "./agent";
import { CHATGPT_USAGE_URL, chatErrorCopy, chatErrorTone, type ChatErrorData } from "./chat-error";
import "./ChatErrorNotice.css";

/** How long to keep the notice in view after Details: the fold, plus a frame. */
const DETAILS_FOLLOW_MS = 260;

/**
 * Scroll the transcript just enough that `el`'s bottom edge clears the deck,
 * which floats over the transcript's bottom (its height is --dock-h). Never
 * scrolls up, and never further than needed.
 */
function keepBottomInView(el: HTMLElement | null): void {
  const scroller = el?.closest<HTMLElement>(".transcript");
  if (!el || !scroller) return;
  const frame = scroller.closest<HTMLElement>(".transcript-frame");
  const dock = frame ? parseFloat(getComputedStyle(frame).getPropertyValue("--dock-h")) || 0 : 0;
  // --dock-h and the 12px are layout pixels; the rects are zoomed viewport
  // pixels under the app's CSS zoom, so scale the former into rect space.
  const view = scroller.getBoundingClientRect();
  const visibleBottom = view.bottom - (dock + 12) * viewportScale(scroller, view);
  const overflow = el.getBoundingClientRect().bottom - visibleBottom;
  if (overflow > 0) scroller.scrollTop += overflow;
}

// Matches --dur-row and useAnimatedHeight; retain content through the fold.
const DETAILS_EXIT_MS = 220;
const OPEN_DETAILS = ["details"] as const;
const CLOSED_DETAILS = [] as const;

export function ChatErrorNotice({
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
  const detailsRef = useRef<HTMLDivElement>(null);
  const capture = useAnimatedHeight(detailsRef, expanded, error);
  const immediate = prefersReducedMotion() || typeof Element.prototype.animate !== "function";
  const details = usePresenceList(
    expanded ? OPEN_DETAILS : CLOSED_DETAILS,
    (key) => key,
    immediate ? 0 : DETAILS_EXIT_MS,
  );
  const detailsLeaving = details[0]?.leaving ?? false;
  const [now, setNow] = useState(Date.now);
  const detailsId = useId();
  const tone = chatErrorTone(error, active);
  const copy = chatErrorCopy(error, active, now);
  const canChooseModel =
    active &&
    !error.historical &&
    error.reason != null &&
    ["usage_limit", "model_access", "capability", "update"].includes(error.reason);

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

  // Keep the notice in view as its details open or close. The details grow
  // over ~200ms (useAnimatedHeight); following them frame by frame means the
  // last line ends just above the deck, rather than below it out of sight.
  // At the end of the chat the chat simply follows the bottom (onContentGrow);
  // higher up, the notice's own bottom edge is kept on screen.
  const rootRef = useRef<HTMLDivElement>(null);
  const firstToggle = useRef(true);
  useEffect(() => {
    if (firstToggle.current) {
      firstToggle.current = false;
      return;
    }
    const until = performance.now() + DETAILS_FOLLOW_MS;
    let frame = 0;
    const follow = (): void => {
      onContentGrow?.();
      if (expanded) keepBottomInView(rootRef.current);
      if (performance.now() < until) frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [expanded, onContentGrow]);

  return (
    <div ref={rootRef} className={`chat-error-notice chat-error-${tone}`}>
      <div
        className="chat-error-copy"
        role={active ? "status" : undefined}
        aria-atomic={active ? true : undefined}
      >
        <div className="chat-error-heading">
          <div className="chat-error-headline">{copy.headline}</div>
          <button
            type="button"
            className="chat-error-details-toggle"
            aria-label={expanded ? "Hide error details" : "Show error details"}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => {
              capture();
              setExpanded((value) => !value);
            }}
          >
            Details
          </button>
        </div>
        <div className="chat-error-recovery">
          <span>{copy.guidance}</span>
          {active && !error.historical && error.manageUsage === "chatgpt" && (
            <button
              type="button"
              className="chat-error-action"
              onClick={() => void openUrl(CHATGPT_USAGE_URL)}
            >
              Manage usage
            </button>
          )}
          {canChooseModel && modelPicker}
        </div>
      </div>
      <div
        id={detailsId}
        ref={detailsRef}
        className={`chat-error-details${detailsLeaving ? " leaving" : ""}`}
        style={{ height: expanded ? undefined : 0 }}
        hidden={!expanded && (immediate || details.length === 0)}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        {/* Padding stays inside the measured shell, including during exit. */}
        <div className="chat-error-details-body">
          <div className="chat-error-details-panel">
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
    </div>
  );
}
