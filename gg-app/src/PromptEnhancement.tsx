import type { PromptSegment } from "./agent";

/**
 * The composer's enhancement state. `enhanced` is the enhancer's exact output
 * (the Enhance pill hides while the draft still equals it); `plain` is the
 * current draft and `segments` describe it, following the user's later edits.
 */
export interface DraftEnhancement {
  enhanced: string;
  plain: string;
  segments: PromptSegment[];
}

/**
 * Re-anchor corrected terms after the text changes from `previous` to `next`.
 * The change is treated as one contiguous replacement (the span between the
 * longest common prefix and suffix), which is what a single textarea edit,
 * paste, or deletion produces. Terms entirely before or after that span keep
 * their annotation (shifted as needed); terms the edit touches are dropped,
 * since their wording no longer matches the explanation. The returned
 * segments always concatenate to `next`. Returns null when the segments don't
 * describe `previous` or an edit leaves no corrected terms.
 */
export function rebaseSegments(
  segments: readonly PromptSegment[],
  previous: string,
  next: string,
): PromptSegment[] | null {
  if (segments.map((seg) => seg.text).join("") !== previous) return null;
  if (previous === next) return [...segments];
  const limit = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < limit && previous[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  const editEnd = previous.length - suffix;
  const shift = next.length - previous.length;
  const kept: { start: number; seg: PromptSegment }[] = [];
  let offset = 0;
  for (const seg of segments) {
    const start = offset;
    offset += seg.text.length;
    if (seg.kind !== "term") continue;
    if (offset <= prefix) kept.push({ start, seg });
    else if (start >= editEnd) kept.push({ start: start + shift, seg });
  }
  if (kept.length === 0) return null;
  const out: PromptSegment[] = [];
  let cursor = 0;
  for (const { start, seg } of kept) {
    if (start > cursor) out.push({ kind: "text", text: next.slice(cursor, start) });
    out.push(seg);
    cursor = start + seg.text.length;
  }
  if (cursor < next.length) out.push({ kind: "text", text: next.slice(cursor) });
  return out;
}

/**
 * Carry a draft enhancement through one edit of the composer text. Returns
 * null when the enhancement no longer describes `previous` (it went stale) or
 * the edit removed every corrected term.
 */
export function followDraftEdit(
  enhancement: DraftEnhancement | null,
  previous: string,
  next: string,
): DraftEnhancement | null {
  if (!enhancement || enhancement.plain !== previous) return null;
  if (previous === next) return enhancement;
  const segments = rebaseSegments(enhancement.segments, previous, next);
  return segments ? { ...enhancement, plain: next, segments } : null;
}

/**
 * Render a sequence of enhanced-prompt segments. Plain `text` segments render
 * verbatim; `term` segments are highlighted with a tooltip teaching what the
 * user originally said. Shared by the inline input overlay and the sent chat
 * bubble so the highlight styling is defined in exactly one place.
 */
export function EnhancedSegments({ segments }: { segments: PromptSegment[] }): React.ReactElement {
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "text") return <span key={i}>{seg.text}</span>;
        return (
          <span key={i} className="enh-term" tabIndex={0}>
            {seg.text}
            <span className="enh-tip" role="tooltip">
              <span className="enh-tip-said">
                you said: <span className="enh-tip-orig">&ldquo;{seg.original}&rdquo;</span>
              </span>
              {seg.note && <span className="enh-tip-note">{seg.note}</span>}
            </span>
          </span>
        );
      })}
    </>
  );
}
