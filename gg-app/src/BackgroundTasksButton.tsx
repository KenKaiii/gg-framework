import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GearSixIcon, StopIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import { killTask, type BackgroundTask } from "./agent";
import { toast } from "./toast";
import { FloatingSurface } from "./FloatingSurface";
import { useAnchoredPopover, useScrollEdges } from "./popover";
import { PopCritter } from "./PopCritter";
import { pickCritter } from "./critter-sprites";

/**
 * Footer indicator for background tasks (bash run_in_background) — mirrors the
 * ggcoder TUI's BackgroundTasksBar. Shows a running count; clicking opens an
 * upward popover listing each task with its command, status, and a stop button.
 * Hidden by the caller when nothing is running.
 *
 * The popover is rendered through a portal to `document.body` and positioned
 * `fixed` (anchored to the button's rect). This is required because the footer's
 * `.footer-left` both clips with `overflow: hidden` AND retains a non-`none`
 * `transform` from its reveal animation (fill-mode `both`) — a transformed
 * ancestor becomes the containing block for fixed descendants and re-applies its
 * overflow clipping, so an in-tree popover (absolute OR fixed) gets swallowed.
 * Portaling out of the footer escapes both.
 */
function shortCommand(cmd: string): string {
  const firstLine = cmd.split("\n")[0] ?? cmd;
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}\u2026` : firstLine;
}

export function BackgroundTasksButton({ tasks }: { tasks: BackgroundTask[] }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const { anchorRef, popoverRef, style } = useAnchoredPopover<HTMLButtonElement, HTMLDivElement>(
    open,
    () => setOpen(false),
    "above",
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollEdges(scrollRef, open);
  const headingId = useId();
  const popoverId = useId();

  const runningCount = tasks.filter((t) => t.exitCode === null).length;
  useEffect(() => {
    if (runningCount === 0) setOpen(false);
  }, [runningCount]);

  // Spinner color while anything runs; muted once all have exited.
  const accent = runningCount > 0 ? theme.warning : theme.textMuted;
  const finished = tasks.length - runningCount;

  return (
    <>
      {runningCount > 0 && (
        <span className="bgtasks">
          <button
            ref={anchorRef}
            className="bgtasks-button"
            style={{ color: accent, borderColor: theme.border }}
            title="Background tasks"
            aria-expanded={open}
            aria-controls={open ? popoverId : undefined}
            data-open={open || undefined}
            onClick={() => setOpen((o) => !o)}
          >
            <GearSixIcon className="bgtasks-icon" size={13} weight="bold" aria-hidden="true" />
            {runningCount} background task{runningCount === 1 ? "" : "s"}
          </button>
        </span>
      )}
      {createPortal(
        <FloatingSurface>
          {open && runningCount > 0 && (
            <div
              ref={popoverRef}
              id={popoverId}
              className="pop-panel bgtasks-menu"
              data-side="above"
              role="dialog"
              aria-labelledby={headingId}
              style={style}
            >
              <header className="pop-head">
                <h2 id={headingId} className="pop-title">
                  Background tasks
                </h2>
                <span className="pop-count">
                  {runningCount} running
                  {finished > 0 && ` \u00b7 ${finished} finished`}
                </span>
              </header>
              <div
                ref={scrollRef}
                className="pop-scroll pop-body"
                tabIndex={-1}
                data-pop-focus
                onScroll={onScroll}
              >
                <ul className="pop-list">
                  {tasks.map((t, index) => {
                    const running = t.exitCode === null;
                    return (
                      <li
                        key={t.id}
                        className="pop-row pop-item bgtasks-item"
                        style={{ "--i": index } as React.CSSProperties}
                      >
                        <PopCritter
                          critter={pickCritter(undefined, t.id, new Set())}
                          pose={running ? "busy" : t.exitCode === 0 ? "idle" : "down"}
                        />
                        <span className="pop-item-text">
                          <span className="pop-item-main is-code bgtasks-cmd" title={t.command}>
                            {shortCommand(t.command)}
                          </span>
                          <span className="pop-item-meta">
                            {running
                              ? `Running \u00b7 pid ${t.pid}`
                              : t.exitCode === 0
                                ? "Finished"
                                : `Exited with code ${t.exitCode}`}
                          </span>
                        </span>
                        {running && (
                          <button
                            type="button"
                            className="pop-item-action"
                            title="Stop task"
                            aria-label={`Stop ${shortCommand(t.command)}`}
                            onClick={() =>
                              void killTask(t.id).then((res) => {
                                if (!res.ok) toast(`Couldn't stop the task: ${res.error}`, "error");
                              })
                            }
                          >
                            <StopIcon size={12} weight="fill" aria-hidden="true" />
                            Stop
                          </button>
                        )}
                      </li>
                    );
                  })}
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
