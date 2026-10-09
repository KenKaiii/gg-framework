/**
 * Parser for the `/schedule` composer command.
 *
 * Grammar (pipe-separated):
 *
 *   /schedule <prompt> | <every> [| <times>]
 *   /schedule check the railway logs and fix any issues | 15m
 *   /schedule run the full test suite | 1h30m | 10
 *
 * Segments are resolved RIGHT-TO-LEFT, which is the whole reason this is a
 * module and not a `text.split("|")` at the call site: a coding prompt very
 * often contains a pipe (`ps aux | grep node`). Splitting on the FIRST bar
 * would truncate that prompt to "ps aux". Reading from the end instead means
 * only the trailing one or two segments are ever claimed as arguments and every
 * remaining bar stays part of the prompt.
 *
 * Disambiguating the tail:
 *  - The run count is only claimed when there are 3+ segments AND the last one
 *    is a bare integer. With exactly two segments the tail is always the
 *    interval slot, so `... | 5` reports "5 needs a unit" rather than silently
 *    reading as "5 runs, no interval" (a count without an interval is
 *    meaningless anyway).
 *  - `ps aux | grep node | 15m` therefore parses as prompt `ps aux | grep node`
 *    + interval `15m`, because `15m` is not a bare integer.
 *
 * Errors carry the character range of the offending segment, indexed into the
 * ORIGINAL raw string (command token included), so the composer can underline
 * exactly the bad part without re-deriving offsets.
 *
 * Pure and UI-free: no React, no clocks, no scheduling. Turning an interval
 * into actual fire times is a later step's job.
 */

/** Command tokens that may lead the raw input. Stripped before parsing. */
const COMMAND_TOKENS = ["/schedule", "/sched"];

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * `Xh`, `Xm`, or `XhYm`. Internal whitespace is tolerated (`1h 30m`) since it
 * reads naturally and is unambiguous, but the units themselves are strict:
 * seconds and spelled-out words are rejected on purpose. A schedule measured in
 * seconds would re-fire faster than a coding turn can finish.
 */
const INTERVAL_RE = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/i;

/** A bare positive integer, the only shape accepted for the run count. */
const COUNT_RE = /^\d+$/;

export interface ParsedSchedule {
  /** Prompt text, sliced from the original input so inner pipes survive intact. */
  prompt: string;
  /** Interval between runs, in milliseconds. Always > 0. */
  intervalMs: number;
  /** How many times to run, or `null` for "run until stopped". */
  runCount: number | null;
}

export type ScheduleErrorCode =
  | "empty"
  | "missing-interval"
  | "empty-prompt"
  | "invalid-interval"
  | "invalid-count"
  | "empty-count";

export interface ScheduleParseError {
  code: ScheduleErrorCode;
  /** Short, user-facing explanation. Safe to render verbatim. */
  message: string;
  /** Inclusive start offset into the raw input. */
  start: number;
  /** Exclusive end offset into the raw input. */
  end: number;
}

export type ScheduleParseResult =
  { ok: true; value: ParsedSchedule } | { ok: false; error: ScheduleParseError };

interface Segment {
  /** Trimmed segment text. */
  text: string;
  /** Offsets into the raw input, covering the trimmed text where there is any. */
  start: number;
  end: number;
  /** Offsets covering the segment INCLUDING its surrounding whitespace. Used for
   *  caret hit-testing, so a caret sitting in the padding still resolves to the
   *  segment the user is visually inside. */
  rawStart: number;
  rawEnd: number;
}

function fail(
  code: ScheduleErrorCode,
  message: string,
  start: number,
  end: number,
): ScheduleParseResult {
  return { ok: false, error: { code, message, start, end } };
}

/**
 * Build a segment, recording offsets for the TRIMMED content so a highlight
 * lands on the text rather than on the padding around it. Whitespace-only
 * segments keep their full raw span instead, otherwise start === end and there
 * would be nothing for the UI to underline.
 */
function makeSegment(raw: string, rawStart: number): Segment {
  const rawEnd = rawStart + raw.length;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { text: "", start: rawStart, end: rawEnd, rawStart, rawEnd };
  }
  const start = rawStart + (raw.length - raw.trimStart().length);
  return { text: trimmed, start, end: start + trimmed.length, rawStart, rawEnd };
}

/** Split on every `|`, carrying absolute offsets through. */
function splitSegments(body: string, bodyStart: number): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (;;) {
    const bar = body.indexOf("|", cursor);
    const raw = bar === -1 ? body.slice(cursor) : body.slice(cursor, bar);
    segments.push(makeSegment(raw, bodyStart + cursor));
    if (bar === -1) return segments;
    cursor = bar + 1;
  }
}

/** Parse `Xh` / `Xm` / `XhYm` into milliseconds. `null` when malformed or zero. */
function parseIntervalMs(text: string): number | null {
  const match = INTERVAL_RE.exec(text);
  if (!match) return null;
  const [, hours, minutes] = match;
  // Both groups optional means the empty string matches; require at least one.
  if (hours === undefined && minutes === undefined) return null;
  const ms = Number(hours ?? 0) * HOUR_MS + Number(minutes ?? 0) * MINUTE_MS;
  return ms > 0 ? ms : null;
}

/**
 * Strip a leading `/schedule` (or `/sched`) token, returning the remaining body
 * and its absolute offset. Input without the token parses the same way, which
 * keeps the function usable for validating a draft mid-typing.
 */
function stripCommand(raw: string): { body: string; bodyStart: number } {
  const leading = raw.length - raw.trimStart().length;
  const rest = raw.slice(leading);
  const lower = rest.toLowerCase();
  for (const token of COMMAND_TOKENS) {
    if (!lower.startsWith(token)) continue;
    const after = rest.charAt(token.length);
    // Require a boundary so `/scheduler` is not read as `/schedule` + "r".
    if (after !== "" && !/\s/.test(after)) continue;
    const start = leading + token.length;
    return { body: raw.slice(start), bodyStart: start };
  }
  return { body: rest, bodyStart: leading };
}

/**
 * Parse a raw `/schedule ...` string.
 *
 * @param raw Composer text, with or without the leading command token.
 */
export function parseScheduleCommand(raw: string): ScheduleParseResult {
  const { body, bodyStart } = stripCommand(raw);

  if (body.trim().length === 0) {
    return fail(
      "empty",
      "Add a prompt and an interval, for example: check the logs | 15m",
      bodyStart,
      bodyStart + body.length,
    );
  }

  const segments = splitSegments(body, bodyStart);

  if (segments.length === 1) {
    const only = segments[0]!;
    return fail(
      "missing-interval",
      "Add an interval, for example: | 15m or | 1h30m",
      only.start,
      only.end,
    );
  }

  const last = segments[segments.length - 1]!;
  const secondLast = segments[segments.length - 2]!;

  // A trailing empty segment at 3+ segments means "user typed the second pipe and
  // is about to type a count". Reporting that as a broken interval would be
  // actively misleading mid-typing, so it gets its own message and the interval
  // is still read from the segment before it.
  if (segments.length >= 3 && last.text.length === 0) {
    return fail(
      "empty-count",
      "Add a run count, for example: 10 — or remove the | to run until stopped.",
      last.start,
      last.end,
    );
  }

  // Claim the tail as a run count only when a segment remains for the interval
  // AND at least one for the prompt, i.e. 3+ segments total.
  const hasCount = segments.length >= 3 && COUNT_RE.test(last.text);
  const intervalSeg = hasCount ? secondLast : last;
  const promptSegs = segments.slice(0, hasCount ? -2 : -1);

  let runCount: number | null = null;
  if (hasCount) {
    const parsed = Number(last.text);
    if (parsed < 1) {
      return fail(
        "invalid-count",
        "Run count must be at least 1. Leave it out to run until stopped.",
        last.start,
        last.end,
      );
    }
    runCount = parsed;
  }

  const intervalMs = parseIntervalMs(intervalSeg.text);
  if (intervalMs === null) {
    // A zero-valued but well-formed interval gets its own wording: the shape is
    // right, the value is not, and "use 15m" would be confusing advice.
    const wellFormed = INTERVAL_RE.test(intervalSeg.text) && intervalSeg.text.length > 0;
    return fail(
      "invalid-interval",
      wellFormed
        ? "Interval must be greater than zero, for example: 15m"
        : `Use minutes or hours, for example: 15m, 2h or 1h30m${
            intervalSeg.text.length > 0 ? ` (got "${intervalSeg.text}")` : ""
          }`,
      intervalSeg.start,
      intervalSeg.end,
    );
  }

  const first = promptSegs[0];
  const lastPrompt = promptSegs[promptSegs.length - 1];
  // Slice from the original string rather than re-joining segments, so inner
  // pipes and the author's exact spacing come back byte-for-byte.
  const prompt = first && lastPrompt ? raw.slice(first.start, lastPrompt.end).trim() : "";

  if (prompt.length === 0) {
    // Point at the prompt region when there is one, else just before the pipe.
    const start = first ? first.start : bodyStart;
    const end = lastPrompt ? lastPrompt.end : intervalSeg.start;
    return fail(
      "empty-prompt",
      "Add a prompt to run on this schedule.",
      start,
      Math.max(start, end),
    );
  }

  return { ok: true, value: { prompt, intervalMs, runCount } };
}

/**
 * Human label for an interval, e.g. "15 min", "2 hours", "1 hr 30 min".
 *
 * Rendered back to the user as confirmation of what they typed, so it spells the
 * units out rather than echoing the shorthand — reading "every 90 min" after
 * typing `1h30m` is what catches a mistyped interval.
 */
export function formatInterval(ms: number): string {
  const totalMinutes = Math.round(ms / MINUTE_MS);
  // The parser cannot produce a sub-minute interval, but this is also called on
  // arbitrary durations (countdowns). Rounding those to "0 min" would render an
  // empty string and leave the UI reading "Every · until stopped".
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))} sec`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hr" : "hrs"}`);
  if (minutes > 0) parts.push(`${minutes} min`);
  return parts.join(" ");
}

/** One-line summary of a parsed schedule, for the confirmation row. */
export function describeSchedule(parsed: ParsedSchedule): string {
  const cadence = `Every ${formatInterval(parsed.intervalMs)}`;
  if (parsed.runCount === null) return `${cadence} \u00b7 until stopped`;
  return `${cadence} \u00b7 ${parsed.runCount} ${parsed.runCount === 1 ? "run" : "runs"}`;
}

/**
 * Replace (or append) the interval segment with `preset`, returning the new text
 * and where the caret should land.
 *
 * Mirrors the parser's right-to-left rule rather than counting bars: the tail is
 * only a run count when there are 3+ segments AND it is a bare integer. Counting
 * bars alone would treat a shell pipe in the prompt as the count separator, so
 * `ps aux | grep node | 15m` would overwrite `grep node` and leave the real
 * interval in place.
 */
export function withInterval(raw: string, preset: string): { text: string; caret: number } {
  const bars: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === "|") bars.push(i);
  }

  const lastBar = bars[bars.length - 1];
  const tailIsCount =
    bars.length >= 2 && lastBar !== undefined && COUNT_RE.test(raw.slice(lastBar + 1).trim());
  const intervalBar = tailIsCount ? bars[bars.length - 2]! : (lastBar ?? -1);

  const head = intervalBar === -1 ? `${raw.trimEnd()} |` : raw.slice(0, intervalBar + 1);
  const tail = tailIsCount && lastBar !== undefined ? raw.slice(lastBar).trimStart() : "";
  const filled = `${head} ${preset}`;
  return { text: tail ? `${filled} ${tail}` : filled, caret: filled.length };
}

/** The three argument slots, in the order they appear in the signature. */
export type ScheduleSlot = "prompt" | "every" | "times";

/**
 * True when the composer text is a `/schedule` invocation that has moved past
 * the command token, i.e. the trailing space has been typed.
 *
 * Deliberately requires that space: until it exists the input is still a plain
 * `/prefix` and belongs to the normal command palette, which filters on a token
 * with no space in it. This keeps the two menus mutually exclusive.
 */
export function isScheduleDraft(raw: string): boolean {
  const rest = raw.trimStart().toLowerCase();
  return COMMAND_TOKENS.some(
    (token) => rest.startsWith(token) && /\s/.test(rest.charAt(token.length)),
  );
}

/**
 * Which slot the caret currently sits in, for highlighting the signature.
 *
 * Mirrors the parser's right-to-left rule so the highlight never disagrees with
 * the error: the last segment is `times` only when a third segment exists,
 * otherwise the tail is the interval and everything before it is prompt.
 */
export function scheduleSlotAtCaret(raw: string, caret: number): ScheduleSlot {
  const { body, bodyStart } = stripCommand(raw);
  const segments = splitSegments(body, bodyStart);
  const clamped = Math.max(bodyStart, Math.min(caret, bodyStart + body.length));

  // Later segments win on a shared boundary: a caret immediately after a pipe
  // belongs to the segment being opened, not the one just closed.
  let index = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (clamped >= segment.rawStart && clamped <= segment.rawEnd) index = i;
  }

  const count = segments.length;
  if (count === 1) return "prompt";

  // Mirror the parser's rule exactly: a tail segment is only the run count when
  // a third segment exists AND it looks like one. `ps aux | grep node | 15m` has
  // three segments but no count, so its middle segment is still prompt — if this
  // disagreed with the parser the highlight would point at a slot the error
  // message contradicts. An empty tail counts as "typing the count", matching
  // the empty-count error.
  const last = segments[count - 1]!;
  const claimsCount = count >= 3 && (COUNT_RE.test(last.text) || last.text.length === 0);

  if (claimsCount) {
    if (index === count - 1) return "times";
    if (index === count - 2) return "every";
    return "prompt";
  }
  return index === count - 1 ? "every" : "prompt";
}
