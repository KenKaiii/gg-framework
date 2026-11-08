import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import type { QueuedMessage } from "./agent";
import { pinSize, usePresenceList } from "./usePresenceList";
import { useAnimatedHeight } from "./animated-height";
import { prefersReducedMotion } from "./transcript-motion";

const EMPTY: readonly QueuedMessage[] = [];

/**
 * Strip above the composer showing user messages waiting to be injected into the
 * running turn, each cancellable.
 *
 * Two shapes, because the affordance should match the cost of getting it wrong:
 *  - ONE pending message: show its text with an `x` right there. Cancelling is
 *    unambiguous, so it takes a single click and no disclosure.
 *  - SEVERAL: show the count with a toggle. An `x` on a collapsed multi-item bar
 *    would be a guess about WHICH message it cancels, so the list has to be
 *    visible before any individual cancel is offered.
 *
 * Wording note: queued messages land at the next TURN boundary (the agent's
 * mid-loop steering hook), not after the run finishes. The copy says "next turn"
 * because "after this run" implies a wait until the final response, which is
 * wrong and makes users cancel and re-send needlessly.
 */

/** Exit duration of `.queued-bar.leaving`: equal to `--dur-strip-out` in App.css; scripts/motion-tokens.test.mjs enforces it. */
const EXIT_MS = 220;

interface Props {
  messages: readonly QueuedMessage[];
  onCancel: (id: string) => void;
}

function preview(text: string): string {
  const firstLine = text.split("\n")[0] ?? text;
  return firstLine.length > 64 ? `${firstLine.slice(0, 63)}\u2026` : firstLine;
}

export function QueuedBar({ messages, onCancel }: Props): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const wasMultiple = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const expanded = open && messages.length > 1;
  const immediate = prefersReducedMotion() || typeof Element.prototype.animate !== "function";
  const list = usePresenceList(
    expanded ? messages : EMPTY,
    (message) => message.id,
    immediate ? 0 : EXIT_MS,
  );
  const capture = useAnimatedHeight(listRef, expanded, list);
  const shown = immediate && !expanded ? EMPTY : list;
  // Messages held one beat past the real queue emptying, so the bar can play
  // its exit animation instead of vanishing the instant the agent consumes the
  // last item. Without this the element unmounts immediately and there is
  // nothing left on screen to animate.
  const [visible, setVisible] = useState<readonly QueuedMessage[]>(messages);
  const [leaving, setLeaving] = useState(false);

  // Collapse once the queue is no longer multi-item, so an expanded list does
  // not linger as an empty or single-row panel after messages drain.
  useEffect(() => {
    if (messages.length <= 1 && wasMultiple.current) setOpen(false);
    wasMultiple.current = messages.length > 1;
  }, [messages.length]);

  useEffect(() => {
    if (messages.length > 0 || immediate) {
      setVisible(messages);
      setLeaving(false);
      return;
    }
    // Queue emptied: keep the last snapshot on screen, mark it leaving, and
    // unmount only after the exit transition has had time to run.
    setLeaving(true);
    const timer = setTimeout(() => {
      setVisible([]);
      setLeaving(false);
    }, EXIT_MS);
    return () => clearTimeout(timer);
  }, [messages, immediate]);

  const barRef = useRef<HTMLDivElement>(null);
  // Nonempty props join the parent's first layout transaction; visible only
  // supplies the retained snapshot after the queue empties.
  const currentQueue = messages.length > 0 ? messages : visible;
  const empty = currentQueue.length === 0 || (immediate && messages.length === 0);
  const exiting = leaving && messages.length === 0;
  // The retained exit folds from its actual size, never a guessed cap.
  useLayoutEffect(() => pinSize(barRef.current), [exiting, empty]);

  if (empty) return null;

  const single = currentQueue.length === 1 ? currentQueue[0] : null;
  const anyCancellable = currentQueue.some((m) => !m.delivering);

  return (
    <div
      ref={barRef}
      className={`queued-bar chat-queue${exiting ? " leaving" : ""}`}
      inert={exiting}
      aria-hidden={exiting}
      style={{ borderColor: theme.border, color: theme.textMuted }}
    >
      <div className="queued-bar-row">
        {single ? (
          <>
            <span className="queued-bar-text" title={single.text}>
              {preview(single.text)}
            </span>
            <span className="queued-bar-when">queued for the next turn</span>
            {!single.delivering && (
              <button
                className="queued-cancel"
                style={{ color: theme.textDim }}
                title="Cancel this queued message"
                aria-label="Cancel queued message"
                onClick={() => onCancel(single.id)}
              >
                <XIcon size={12} weight="bold" aria-hidden="true" />
              </button>
            )}
          </>
        ) : (
          <>
            <span className="queued-bar-text">
              {currentQueue.length} messages queued for the next turn
            </span>
            {anyCancellable && (
              <button
                className="queued-toggle"
                style={{ color: theme.textDim }}
                aria-expanded={expanded}
                onClick={() => {
                  capture();
                  setOpen((o) => !o);
                }}
              >
                {expanded ? "hide" : "cancel\u2026"}
              </button>
            )}
          </>
        )}
      </div>

      <div
        ref={listRef}
        className="queued-list-shell"
        style={{ height: expanded ? undefined : 0 }}
        inert={!expanded}
        aria-hidden={!expanded}
      >
        {shown.length > 0 && (
          <div className={`queued-list${expanded ? "" : " leaving"}`}>
            {list.map(({ item: m, leaving: rowLeaving }, i) => (
              <div
                key={m.id}
                className="queued-list-item"
                inert={rowLeaving}
                aria-hidden={rowLeaving}
              >
                <span className="queued-index" style={{ color: theme.textDim }}>
                  {i + 1}
                </span>
                <span className="queued-list-text" title={m.text}>
                  {preview(m.text)}
                </span>
                {!m.delivering && (
                  <button
                    className="queued-cancel"
                    style={{ color: theme.textDim }}
                    title="Cancel this queued message"
                    aria-label={`Cancel queued message ${i + 1}`}
                    onClick={() => onCancel(m.id)}
                  >
                    <XIcon size={12} weight="bold" aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
