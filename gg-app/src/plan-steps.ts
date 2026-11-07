// Plan-step [DONE:n] handling for the chat transcript. The agent emits
// `[DONE:n]` markers in its text as it completes approved-plan steps. We split
// assistant text on those markers so each renders as a "✓ Step n" completion
// row instead of leaking the raw marker into the prose. Ported from the TUI's
// utils/plan-steps.ts (segmentDisplayText).

export type DisplaySegment = { kind: "text"; text: string } | { kind: "done"; stepNum: number };

const MARKER_PATTERN = "`?\\[DONE:(\\d+)\\]`?";

function doneMarkerRegex(): RegExp {
  return new RegExp(MARKER_PATTERN, "gi");
}

function hasRenderableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Split text on `[DONE:n]` markers into ordered segments. Text fragments with
 * no letters/numbers (e.g. a stray backtick left by `[DONE:n]`) are dropped.
 * Returns a single text segment when there are no markers.
 */
export function segmentDoneMarkers(text: string): DisplaySegment[] {
  const segments: DisplaySegment[] = [];
  let lastIdx = 0;
  for (const match of text.matchAll(doneMarkerRegex())) {
    const idx = match.index ?? 0;
    const before = text.slice(lastIdx, idx);
    if (hasRenderableText(before)) segments.push({ kind: "text", text: before });
    segments.push({ kind: "done", stepNum: parseInt(match[1], 10) });
    lastIdx = idx + match[0].length;
  }
  const after = text.slice(lastIdx);
  if (hasRenderableText(after)) segments.push({ kind: "text", text: after });
  return segments;
}

/** True when the text contains at least one `[DONE:n]` marker. */
export function hasDoneMarker(text: string): boolean {
  return doneMarkerRegex().test(text);
}

// Steps run in order, so `[DONE:n]` also covers earlier steps the model forgot
// to mark (mirrors ggcoder's stepsDoneThrough).
export function stepsDoneThrough(markers: Iterable<number>, total: number): number[] {
  let highest = 0;
  for (const step of markers) {
    if (Number.isInteger(step) && step <= total && step > highest) highest = step;
  }
  return Array.from({ length: highest }, (_, index) => index + 1);
}

/** All step numbers marked complete via `[DONE:n]` in the given text. */
export function findCompletedSteps(text: string): number[] {
  const nums: number[] = [];
  for (const m of text.matchAll(/\[DONE:(\d+)\]/gi)) nums.push(parseInt(m[1], 10));
  return nums;
}

// Recognised step-section headings (mirrors the TUI's STEP_SECTION_HEADING):
// only count numbered items under a dedicated steps/tasks heading, never
// arbitrary numbered lists elsewhere in the plan.
const STEP_SECTION_HEADING =
  /^#{2,3}\s+(?:implementation\s+steps|steps(?:\s+to\s+implement)?|tasks|to-?dos?|todo)\s*:?\s*$/im;

/**
 * Count the implementation steps in a plan's markdown — numbered items (0–2
 * leading spaces) under a recognised steps/tasks heading. Returns 0 when the
 * plan has no such section (progress tracking is opt-in, matching the TUI).
 */
export function countPlanSteps(planContent: string): number {
  const match = planContent.match(STEP_SECTION_HEADING);
  if (!match || match.index === undefined) return 0;
  const start = match.index + match[0].length;
  const rest = planContent.slice(start);
  const nextHeading = rest.match(/^#{1,3}\s/m);
  const section = nextHeading?.index !== undefined ? rest.slice(0, nextHeading.index) : rest;

  let count = 0;
  for (const m of section.matchAll(/^(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm)) {
    const text = m[2]
      .trim()
      .replace(/\*{1,2}$/, "")
      .trim();
    if (text.length <= 5 || text.startsWith("`") || text.startsWith("/") || text.startsWith("-")) {
      continue;
    }
    count++;
  }
  return count;
}
