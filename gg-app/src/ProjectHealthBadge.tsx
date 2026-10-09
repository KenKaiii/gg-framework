import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FloatingSurface } from "./FloatingSurface";
import { useAnchoredPopover, useScrollEdges } from "./popover";
import { critterById, PopCritter, type PopCritterPose } from "./PopCritter";
import {
  PROJECT_HEALTH_TIER_LABELS,
  projectHealthTier,
  type ProjectHealth,
  type ProjectHealthCategory,
  type ProjectHealthTier,
} from "./project-health";

/** "path · 1,200 lines" → main + meta, so the meta can sit right-aligned. */
function splitFinding(finding: string): { main: string; meta: string | null } {
  const at = finding.lastIndexOf(" · ");
  if (at <= 0) return { main: finding, meta: null };
  return { main: finding.slice(0, at), meta: finding.slice(at + 3) };
}

/** The owl does the inspecting: cheerful when healthy, worn out when poor. */
const HEALTH_CRITTER = critterById("owl");
const HEALTH_POSE: Readonly<Record<ProjectHealthTier, PopCritterPose>> = {
  healthy: "busy",
  fair: "idle",
  poor: "down",
};

/** Paths and file names (no spaces) read best in mono; prose stays in sans. */
function isPathLike(text: string): boolean {
  return !/\s/.test(text) && /[./]/.test(text);
}

function CategoryRow({
  category,
  index,
  onReview,
}: {
  category: ProjectHealthCategory;
  index: number;
  onReview: ((prompt: string, label: string) => void) | undefined;
}): React.ReactElement {
  const tier = category.score === null ? undefined : projectHealthTier(category.score);
  return (
    <li className="pop-row health-category" style={{ "--i": index } as React.CSSProperties}>
      <div className="health-stat">
        <span className="health-stat-label">{category.label}</span>
        <span className="health-meter" aria-hidden="true">
          {category.score !== null && (
            <span
              className="health-meter-fill"
              data-tier={tier}
              style={{ "--fill": category.score / 100 } as React.CSSProperties}
            />
          )}
        </span>
        {category.score === null ? (
          <span className="health-stat-none">Not scored</span>
        ) : (
          <b className="health-stat-value">
            {category.score}
            <i className="health-stat-goal">/ 100</i>
          </b>
        )}
      </div>
      <div className="health-category-sub">
        <p className="health-category-summary">{category.summary}</p>
        {onReview && category.fixPrompt && (
          <button
            type="button"
            className="health-category-fix"
            aria-label={`Review ${category.label} with the agent`}
            onClick={() => {
              if (category.fixPrompt) onReview(category.fixPrompt, `Reviewing ${category.label}`);
            }}
          >
            Review
          </button>
        )}
      </div>
      {category.findings.length > 0 && (
        <ul className="health-findings">
          {category.findings.map((finding) => {
            const { main, meta } = splitFinding(finding);
            return (
              <li key={finding} className="health-finding" title={finding}>
                <span className={`health-finding-main${isPathLike(main) ? " is-path" : ""}`}>
                  {main}
                </span>
                {meta && <span className="health-finding-meta">{meta}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/**
 * Title-bar Project Health percentage. Click opens a breakdown per category
 * with the worst offenders. "Review" hands findings to the agent, which
 * checks them and asks (with ask_user) what to fix.
 * `onReview` returns false when the prompt couldn't be sent (session not ready).
 *
 * The popover is portaled and `fixed` so the strip's overflow clipping and
 * drag region can't swallow it (same reason as BackgroundTasksButton).
 */
export function ProjectHealthBadge({
  health,
  onReview,
}: {
  health: ProjectHealth;
  onReview?: (prompt: string, label: string) => boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const { anchorRef, popoverRef, style } = useAnchoredPopover<HTMLButtonElement, HTMLDivElement>(
    open,
    () => setOpen(false),
    "below",
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollEdges(scrollRef, open);
  const popoverId = useId();
  const headingId = useId();
  const tier = projectHealthTier(health.score);
  const tierLabel = PROJECT_HEALTH_TIER_LABELS[tier];
  const [sendFailed, setSendFailed] = useState(false);
  useEffect(() => {
    if (!open) setSendFailed(false);
  }, [open]);
  const review = onReview
    ? (prompt: string, label: string): void => {
        if (onReview(prompt, label)) setOpen(false);
        else setSendFailed(true);
      }
    : undefined;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="chat-head-health chat-head-link"
        data-tier={tier}
        data-open={open || undefined}
        aria-label={`Project health ${health.score}%, ${tierLabel}. Show breakdown`}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        title={`Project health: ${health.score}% (${tierLabel})`}
        onClick={() => setOpen((value) => !value)}
      >
        {`${health.score}%`}
      </button>
      {createPortal(
        <FloatingSurface>
          {open && (
            <div
              ref={popoverRef}
              id={popoverId}
              className="pop-panel health-popover"
              data-side="below"
              role="dialog"
              aria-labelledby={headingId}
              style={style}
            >
              <header className="health-popover-head">
                <span className="health-score-num" aria-hidden="true">
                  {health.score}
                </span>
                <div className="health-score-meter">
                  <div className="health-score-row">
                    <h2 id={headingId} className="pop-title">
                      Project health
                      <span className="sr-only">{`: ${health.score}%`}</span>
                    </h2>
                    <span className="health-score-tier" data-tier={tier}>
                      {tierLabel}
                    </span>
                  </div>
                  <span className="health-meter is-lead" aria-hidden="true">
                    <span
                      className="health-meter-fill"
                      data-tier={tier}
                      style={{ "--fill": health.score / 100 } as React.CSSProperties}
                    />
                  </span>
                </div>
                <PopCritter critter={HEALTH_CRITTER} pose={HEALTH_POSE[tier]} size={28} />
              </header>
              {health.cappedBy && (
                <p className="health-capped" data-tier={tier}>
                  {`Held at ${health.score}%: ${health.cappedBy}.`}
                </p>
              )}
              <div
                ref={scrollRef}
                className="pop-scroll pop-body"
                tabIndex={0}
                data-pop-focus
                aria-label="Health breakdown"
                onScroll={onScroll}
              >
                <ul className="pop-list">
                  {health.categories.map((category, index) => (
                    <CategoryRow
                      key={category.id}
                      category={category}
                      index={index}
                      onReview={review}
                    />
                  ))}
                </ul>
              </div>
              <footer className="pop-foot">
                <span className="pop-note" role={sendFailed ? "alert" : undefined}>
                  {sendFailed
                    ? "Agent not ready. Try again."
                    : health.truncated
                      ? "Partly scanned (large project)"
                      : "Rescans every 2 min"}
                </span>
                {review && health.fixPrompt && (
                  <button
                    type="button"
                    className="modal-btn pop-action"
                    onClick={() => {
                      if (health.fixPrompt) review(health.fixPrompt, "Reviewing project health");
                    }}
                  >
                    Review all
                  </button>
                )}
              </footer>
            </div>
          )}
        </FloatingSurface>,
        document.body,
      )}
    </>
  );
}
