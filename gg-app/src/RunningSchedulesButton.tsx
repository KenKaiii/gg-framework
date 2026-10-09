import { useEffect, useId, useRef, useState } from "react";
import { StopIcon } from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import { theme } from "./theme";
import { FloatingSurface } from "./FloatingSurface";
import { useAnchoredPopover, useScrollEdges } from "./popover";
import { PopCritter } from "./PopCritter";
import { pickCritter } from "./critter-sprites";
import { nextRunLabel } from "./schedule-labels";
import { describeSchedule, type ParsedSchedule } from "./scheduleCommand";

/**
 * Footer indicator for active schedules — the schedule-side twin of
 * `BackgroundTasksButton`. Shows a running count; clicking opens an upward
 * popover listing each schedule with its prompt, cadence, next fire time, and a
 * stop button. Hidden by the caller when nothing is scheduled.
 *
 * The popover is portalled to `document.body` and positioned `fixed` for the
 * same reason as the background-tasks one: `.footer-left` both clips with
 * `overflow: hidden` and retains a non-`none` `transform` from its reveal
 * animation, which makes it the containing block for fixed descendants and
 * re-applies the clip. Portaling escapes both. See BackgroundTasksButton.
 */

export interface ActiveSchedule extends ParsedSchedule {
  id: string;
  /** Epoch ms of the next planned run. */
  nextRunAt: number;
  /** Runs completed so far, for the `2/10` progress read. */
  runsCompleted: number;
}

function shortPrompt(prompt: string): string {
  const firstLine = prompt.split("\n")[0] ?? prompt;
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}\u2026` : firstLine;
}

interface Props {
  schedules: readonly ActiveSchedule[];
  onStop: (id: string) => void;
}

export function RunningSchedulesButton({ schedules, onStop }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Clamped into the viewport: anchoring naively to the button's left edge
  // pushes the popover off-screen in a narrow window, and with it the stop
  // buttons, which would leave a schedule with no way to cancel it.
  const { anchorRef, popoverRef, style } = useAnchoredPopover<HTMLButtonElement, HTMLDivElement>(
    open,
    () => setOpen(false),
    "above",
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollEdges(scrollRef, open);
  const headingId = useId();
  const popoverId = useId();

  // Only tick while the popover is open — a 1s interval behind a closed menu is
  // a pointless wakeup on a desktop app that may sit idle for hours.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);

  const count = schedules.length;
  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  return (
    <>
      {count > 0 && (
        <span className="bgtasks schedules">
          <button
            ref={anchorRef}
            className="bgtasks-button"
            style={{ color: theme.secondary, borderColor: theme.border }}
            title="Active schedules — run only while this window is open"
            aria-expanded={open}
            aria-controls={open ? popoverId : undefined}
            data-open={open || undefined}
            onClick={() => setOpen((o) => !o)}
          >
            {"\u25F7 "}
            {count} schedule{count === 1 ? "" : "s"}
          </button>
        </span>
      )}
      {createPortal(
        <FloatingSurface>
          {open && count > 0 && (
            <div
              ref={popoverRef}
              id={popoverId}
              className="pop-panel bgtasks-menu schedules-menu"
              data-side="above"
              role="dialog"
              aria-labelledby={headingId}
              style={style}
            >
              <header className="pop-head">
                <h2 id={headingId} className="pop-title">
                  Schedules
                </h2>
                <span className="pop-count">{count} active</span>
              </header>
              <div
                ref={scrollRef}
                className="pop-scroll pop-body"
                tabIndex={-1}
                data-pop-focus
                onScroll={onScroll}
              >
                <ul className="pop-list">
                  {schedules.map((s, index) => (
                    <li
                      key={s.id}
                      className="pop-row pop-item schedules-item"
                      style={{ "--i": index } as React.CSSProperties}
                    >
                      <PopCritter
                        critter={pickCritter(undefined, s.id, new Set())}
                        pose="waiting"
                      />
                      <span className="pop-item-text">
                        <span className="pop-item-main bgtasks-cmd" title={s.prompt}>
                          {shortPrompt(s.prompt)}
                        </span>
                        <span className="pop-item-meta">
                          <span className="schedules-cadence">
                            {describeSchedule(s)}
                            {s.runCount !== null && ` \u00b7 ${s.runsCompleted}/${s.runCount}`}
                          </span>
                          <span className="pop-item-when">{nextRunLabel(s.nextRunAt, now)}</span>
                        </span>
                      </span>
                      <button
                        type="button"
                        className="pop-item-action"
                        title="Stop this schedule"
                        aria-label={`Stop schedule: ${shortPrompt(s.prompt)}`}
                        onClick={() => onStop(s.id)}
                      >
                        <StopIcon size={12} weight="fill" aria-hidden="true" />
                        Stop
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </FloatingSurface>,
        document.body,
      )}
    </>
  );
}
