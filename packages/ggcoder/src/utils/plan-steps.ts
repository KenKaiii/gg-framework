/**
 * Plan step extraction and [DONE:n] progress tracking.
 *
 * The agent outputs [DONE:n] markers in its text to signal that step n
 * of the approved plan has been completed.  The UI parses these markers
 * and renders a progress widget.
 */

export interface PlanStep {
  /** 1-based step number */
  step: number;
  /** Short description extracted from the plan */
  text: string;
  completed: boolean;
}

/**
 * Extract numbered steps from a plan markdown string.
 *
 * Steps are ONLY read from a dedicated step-section heading (`## Steps` or a
 * close synonym — see STEP_SECTION_HEADING). If the plan has no such section,
 * this returns an empty array — progress tracking is opt-in.
 *
 * The previous behaviour scanned the entire document for any top-level
 * numbered list when no step section was present, which scraped phantom
 * "steps" out of unrelated prose (design decisions, Q&A bullets, rejected
 * alternatives). The post-approval prompt then pushed the model to march
 * through those non-tasks and emit `[DONE:n]` markers for them, deadlocking
 * a model that correctly refused to fabricate completion. Requiring an
 * explicit step-section heading keeps the progress contract honest.
 *
 * Looks for lines like:
 *   1. Do something
 *   2) Do something else
 *   3. **Bold step**
 */
export function extractPlanSteps(planContent: string): PlanStep[] {
  // Steps are read ONLY from a recognised step-section heading (see
  // STEP_SECTION_HEADING). No such section means no tracked steps — never fall
  // back to scanning the whole document.
  const source = extractStepsSection(planContent);
  if (source === undefined) return [];

  const steps: PlanStep[] = [];
  // Only match non-indented numbered items (0-2 spaces max) to skip sub-items
  const pattern = /^(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

  for (const match of source.matchAll(pattern)) {
    let text = match[2]
      .trim()
      .replace(/\*{1,2}$/, "")
      .trim();
    // Skip very short items, code snippets, or sub-items
    if (text.length <= 5 || text.startsWith("`") || text.startsWith("/") || text.startsWith("-")) {
      continue;
    }
    // Truncate long step descriptions
    if (text.length > 80) {
      text = text.slice(0, 77) + "...";
    }
    steps.push({ step: steps.length + 1, text, completed: false });
  }

  return steps;
}

/**
 * Headings that mark a dedicated, ordered implementation-step section. The
 * canonical heading the plan-mode prompt asks for is `## Steps`, but models
 * routinely emit close synonyms (`## Implementation Steps`, `## Steps to
 * implement`, `## Tasks`, …). Recognising those keeps progress tracking working
 * without falling back to scanning arbitrary prose for numbered lists, which
 * scraped phantom steps out of design notes and Q&A bullets.
 *
 * Deliberately excludes broad container headings like `## Plan`: those often
 * hold sub-sections (design, risks, steps) and matching them would re-scrape
 * non-task numbered lists — the exact bug the `## Steps`-only rule fixed. The
 * heading must also be the keyword phrase ON ITS OWN, so an essay heading like
 * `## Step-by-step rationale for the design` won't match.
 */
const STEP_SECTION_HEADING =
  /^#{2,3}\s+(?:implementation\s+steps|steps(?:\s+to\s+implement)?|tasks|to-?dos?|todo)\s*:?\s*$/im;

/**
 * Extract the content under a recognised step-section heading, stopping at the
 * next heading of equal or higher level (or end of document).
 */
function extractStepsSection(planContent: string): string | undefined {
  const match = planContent.match(STEP_SECTION_HEADING);
  if (!match || match.index === undefined) return undefined;

  const start = match.index + match[0].length;
  // Find next heading of level 1-3 (or end of string)
  const rest = planContent.slice(start);
  const nextHeading = rest.match(/^#{1,3}\s/m);
  const sectionContent = nextHeading?.index !== undefined ? rest.slice(0, nextHeading.index) : rest;
  return sectionContent;
}

/**
 * Re-base a frozen step list onto a freshly extracted one.
 *
 * The progress widget captures `extractPlanSteps` once, at plan-approval time.
 * But the agent can rewrite or expand the approved plan while implementing it
 * (e.g. a 2-step plan becomes 12 steps). When that happens the frozen snapshot
 * goes stale: the total is wrong and `[DONE:n]` markers for the new steps can't
 * be matched. Re-extracting from the live plan and re-basing onto it keeps the
 * total in sync.
 *
 * Completion is carried over BY STEP NUMBER (not text), so a reworded step that
 * was already done stays done. New steps adopt the fresh text and start
 * incomplete. If the fresh plan has no steps (e.g. the step section was
 * temporarily removed mid-edit) the previous list is returned unchanged so we
 * never blow away real progress. The previous array reference is returned when
 * nothing meaningfully changed, so React state setters can no-op.
 */
export function rebasePlanSteps(previous: PlanStep[], fresh: PlanStep[]): PlanStep[] {
  if (fresh.length === 0) return previous;

  const completedByStep = new Set(previous.filter((s) => s.completed).map((s) => s.step));
  const rebased = fresh.map((s) =>
    completedByStep.has(s.step) && !s.completed ? { ...s, completed: true } : s,
  );

  const unchanged =
    rebased.length === previous.length &&
    rebased.every((s, i) => {
      const prev = previous[i];
      return (
        prev !== undefined &&
        prev.step === s.step &&
        prev.text === s.text &&
        prev.completed === s.completed
      );
    });
  return unchanged ? previous : rebased;
}

/**
 * Strip [DONE:n] markers from text for display purposes.
 * These markers are machine-readable signals for the progress widget,
 * not meant to be shown to the user.
 */
export function stripDoneMarkers(text: string): string {
  return (
    text
      // Also consume a single backtick directly wrapping the marker. Models
      // sometimes emit `[DONE:n]` as inline code; stripping just the bracketed
      // marker would leave an orphan backtick that renders as a stray ` bullet.
      .replace(/`?\s*\[DONE:\d+\]\s*`?/gi, " ")
      .replace(/  +/g, " ")
      .replace(/^ /, "")
      .replace(/ $/, "")
  );
}

/**
 * Whether a split text fragment has any renderable content. Fragments left
 * behind after splitting a backtick-wrapped [DONE:n] marker can be just a stray
 * backtick or punctuation, which should not become their own assistant bullet.
 */
function hasRenderableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Segment of an assistant turn's text after [DONE:N] markers are split
 * out for inline rendering. Used by the chat to render "✓ Step N: <desc>"
 * markers in the same temporal order the agent emitted them, instead of
 * stripping markers to invisible whitespace.
 */
export type DisplaySegment =
  { kind: "text"; text: string } | { kind: "done"; stepNum: number; description: string };

/**
 * Split text on [DONE:N] markers, returning an array of segments. Empty/
 * whitespace-only text segments are dropped. Step description is looked
 * up in `steps` (falls back to "" so the renderer can show just the step
 * number when the plan is no longer in scope, e.g. after onComplete
 * cleared planSteps).
 */
export function segmentDisplayText(text: string, steps: PlanStep[]): DisplaySegment[] {
  const segments: DisplaySegment[] = [];
  // Consume a single backtick directly wrapping the marker so an orphan
  // backtick from `[DONE:n]` doesn't survive as its own text fragment.
  const pattern = /`?\[DONE:(\d+)\]`?/gi;
  let lastIdx = 0;
  for (const match of text.matchAll(pattern)) {
    const matchIdx = match.index ?? 0;
    const before = text.slice(lastIdx, matchIdx);
    if (hasRenderableText(before)) {
      segments.push({ kind: "text", text: before });
    }
    const stepNum = parseInt(match[1], 10);
    const step = steps.find((s) => s.step === stepNum);
    segments.push({
      kind: "done",
      stepNum,
      description: step?.text ?? "",
    });
    lastIdx = matchIdx + match[0].length;
  }
  const after = text.slice(lastIdx);
  if (hasRenderableText(after)) {
    segments.push({ kind: "text", text: after });
  }
  return segments;
}

/**
 * Scan text for [DONE:n] markers and return the set of completed step numbers.
 */
export function findCompletedMarkers(text: string): Set<number> {
  const completed = new Set<number>();
  const pattern = /\[DONE:(\d+)\]/gi;
  for (const match of text.matchAll(pattern)) {
    completed.add(parseInt(match[1], 10));
  }
  return completed;
}

/**
 * Apply completed markers to a steps array (immutable — returns new array).
 */
export function markStepsCompleted(steps: PlanStep[], completed: Set<number>): PlanStep[] {
  let changed = false;
  const result = steps.map((s) => {
    if (completed.has(s.step) && !s.completed) {
      changed = true;
      return { ...s, completed: true };
    }
    return s;
  });
  return changed ? result : steps;
}

// Steps run in order, so `[DONE:n]` also covers earlier steps the model forgot
// to mark; counting only the markers left progress stuck behind (3/15 at step 9).
export function stepsDoneThrough(markers: Iterable<number>, total: number): number[] {
  let highest = 0;
  for (const step of markers) {
    if (Number.isInteger(step) && step <= total && step > highest) highest = step;
  }
  return Array.from({ length: highest }, (_, index) => index + 1);
}
