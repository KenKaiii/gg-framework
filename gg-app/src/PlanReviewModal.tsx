import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUpIcon } from "@phosphor-icons/react";
import { useDialogFocus } from "./dialog-focus";
import { theme } from "./theme";
import { Markdown } from "./Markdown";
import { ShimmerText } from "./ShimmerText";
import { CritterLine } from "./CritterLine";
import { PlanCritters } from "./PlanCritters";
import { hashKey, pickCritter } from "./critter-sprites";
import { countPlanSteps } from "./plan-steps";
import { autosizeComposer } from "./composer-autosize";

interface Props {
  /** Plan markdown to review. */
  content: string;
  /** True while Autopilot Ken is reviewing this plan himself. The decision
   *  stays live: a manual Accept/Feedback/Reject always overrides Ken (the
   *  sidecar's generation guard discards his stale verdict). */
  kenReviewing?: boolean;
  onAccept: () => void;
  onFeedback: (feedback: string) => void;
  onReject: () => void;
  /** Injected for tests; defaults to Math.random (critter crew, terrain, intro). */
  random?: () => number;
}

/** Longest the exit dissolve may hold a decision if `animationend` never fires.
 *  Must stay longer than `--dur-plan-out` in App.css; scripts/motion-tokens.test.mjs enforces it. */
const EXIT_FALLBACK_MS = 420;

const INTRO_LINES = [
  "A critter drafted your plan. Have a read",
  "Fresh plan, hot off the critter press",
  "The critters sketched this out for you",
  "Here's the plan the critters put together",
] as const;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Full-window plan review shown on plan_exit. Laid out like the chat itself so
 * it reads as part of the workspace: a header strip, the plan where the
 * transcript sits, a critter crew above the deck, and the workspace deck with
 * the feedback box and the decision keys (Reject / Accept) beside send. It
 * dissolves in, and dissolves out before the chosen decision runs.
 */
export function PlanReviewModal({
  content,
  kenReviewing = false,
  onAccept,
  onFeedback,
  onReject,
  random = Math.random,
}: Props): React.ReactElement {
  const [feedback, setFeedback] = useState("");
  // The decision waiting for the exit dissolve to finish; null while open.
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const decidedRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // No Escape handler: every outcome here (accept, revise, reject) is a real
  // decision, so Escape must not quietly pick one.
  useDialogFocus(dialogRef);

  const [seed] = useState(() => Math.floor(random() * 0x7fffffff).toString(36));
  const critter = useMemo(() => pickCritter(undefined, `plan-review:${seed}`, new Set()), [seed]);
  const intro = INTRO_LINES[hashKey(seed) % INTRO_LINES.length] ?? INTRO_LINES[0];
  const steps = useMemo(() => countPlanSteps(content), [content]);
  const stepsLabel = steps > 0 ? `${steps} step${steps === 1 ? "" : "s"}` : null;

  useLayoutEffect(() => {
    autosizeComposer(inputRef.current, null);
  }, [feedback]);

  // Hold the decision until the dissolve lands; the fallback covers a skipped
  // animation (hidden window, animations disabled) so a choice never hangs.
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(leaving, EXIT_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  const decide = (run: () => void): void => {
    if (decidedRef.current) return;
    decidedRef.current = true;
    let ran = false;
    const once = (): void => {
      if (ran) return;
      ran = true;
      run();
    };
    if (prefersReducedMotion()) once();
    else setLeaving(() => once);
  };

  const trimmed = feedback.trim();
  const sendFeedback = (): void => {
    if (trimmed) decide(() => onFeedback(trimmed));
  };

  return (
    <div
      ref={dialogRef}
      className={`plan-review${leaving ? " leaving" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Review plan"
      tabIndex={-1}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && e.animationName === "plan-dissolve-out") leaving?.();
      }}
    >
      <header className="plan-review-head" data-tauri-drag-region>
        <span className="plan-review-title" data-tauri-drag-region>
          Plan review
        </span>
        {stepsLabel && (
          <span className="plan-review-steps" data-tauri-drag-region>
            {stepsLabel}
          </span>
        )}
      </header>

      <div className="plan-review-body" role="region" aria-label="Plan" tabIndex={0}>
        <div className="plan-review-intro">
          <CritterLine critter={critter} tone="working" color={theme.warning} text={intro} />
        </div>
        <div className="plan-review-doc">
          <Markdown>{content || "_(plan is empty)_"}</Markdown>
        </div>
      </div>

      {/* The workspace's own deck, plan-mode dashed, so the decision reads as
          the next step of the chat. Accept and Reject are keys beside send,
          where Enhance sits in the chat. */}
      <div className="plan-review-dock">
        <PlanCritters random={random} />
        <div className="deck plan-review-deck" data-plan-mode>
          <div className="deck-main">
            <div className="deck-status">
              <div className="task-activity" data-phase="attention">
                <div className="statusrow">
                  <div className="activity-summary">
                    <span
                      className="statusrow-left"
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      <span className="activity-label-reveal">
                        {kenReviewing ? (
                          <ShimmerText base={theme.ken} bright={theme.text}>
                            Ken is reviewing it. Your call still wins
                          </ShimmerText>
                        ) : (
                          <span style={{ color: theme.warning }}>Your call on the plan</span>
                        )}
                      </span>
                    </span>
                  </div>
                </div>
              </div>
              <span className="deck-flag">Plan mode</span>
            </div>
            <div className="deck-compose">
              <div className="inputwrap">
                <div className="inputrow">
                  <div className="input-stack">
                    {/* Initial focus: typing feedback is the likeliest next move, and an
                        Enter already in flight from the chat composer lands here, where
                        an empty draft does nothing, instead of on Accept. */}
                    <textarea
                      ref={inputRef}
                      className="input"
                      rows={1}
                      value={feedback}
                      aria-label="Feedback on the plan"
                      placeholder="Tell GG what to change in the plan…"
                      readOnly={leaving !== null}
                      data-modal-initial-focus
                      onChange={(e) => setFeedback(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          sendFeedback();
                        }
                      }}
                    />
                  </div>
                  <div className="inputactions-trailing">
                    <button
                      type="button"
                      className="key key-sm plan-review-reject"
                      disabled={leaving !== null}
                      onClick={() => decide(onReject)}
                    >
                      Reject
                    </button>
                    {/* One primary at a time: Accept leads until there is feedback
                        to send, then send does. */}
                    <button
                      type="button"
                      className={`key key-sm plan-review-accept${trimmed ? "" : " primary"}`}
                      disabled={leaving !== null}
                      onClick={() => decide(onAccept)}
                    >
                      Accept plan
                    </button>
                    <button
                      type="button"
                      className="icon-circle icon-circle-primary"
                      title="Send feedback (Enter)"
                      aria-label="Send feedback"
                      disabled={!trimmed || leaving !== null}
                      onClick={sendFeedback}
                    >
                      <ArrowUpIcon size={16} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
