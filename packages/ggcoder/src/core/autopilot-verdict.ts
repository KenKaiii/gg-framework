/**
 * Autopilot Ken's verdict contract.
 *
 * In autopilot mode Ken never talks to the user — he auto-reviews GG Coder's
 * work and replies with exactly one of four machine-parseable verdicts. The
 * first non-empty line carries the keyword; anything after is the payload.
 *
 *   PROMPT
 *   <runnable GG Coder prompt body, 1-3 lines>
 *
 *   ALL_CLEAR
 *   ACCEPT_VERIFICATION_EXCEPTION {"id":"<current exception ID>"}  // optional
 *   IGNORE
 *
 *   HUMAN
 *   <one short reason the human is needed>
 *
 * ALL_CLEAR and IGNORE both stop the cycle with nothing left to do, but they
 * mean different things to the UI: ALL_CLEAR is a verdict on real work ("GG
 * Coder built/changed something and it checks out") and renders a one-line Ken
 * marker. IGNORE means the turn was never worth reviewing in the first place
 * (small talk, a question, an ack, a mechanical operation with no code
 * changes) — it renders NOTHING, not even a marker, so trivial turns don't
 * spam the transcript with a Ken bubble that adds no information.
 *
 * Parsing is forgiving and safe-by-default: any reply we can't confidently map
 * to PROMPT, ALL_CLEAR, or IGNORE becomes a HUMAN stop, never a blind loop.
 *
 * Recovery order for prose-then-keyword drift (Ken writing commentary before
 * the verdict despite the contract): bare trailing ALL_CLEAR/IGNORE → buried
 * HUMAN → buried line-start PROMPT (uppercase, line-start only, so prose like
 * "prompt the user" can never match). HUMAN wins over PROMPT when both appear
 * — recovering a stop is always safe, recovering an action must lose ties.
 */

export type AutopilotVerdict =
  | { kind: "prompt"; body: string }
  | { kind: "all_clear"; acceptedVerificationExceptionId?: string }
  | { kind: "ignore" }
  | { kind: "human"; reason: string };

/** Cap on the raw-reply text we echo back as a HUMAN reason when Ken's output
 *  is unrecognized — keeps a garbage/huge reply from bloating the transcript. */
const RAW_REASON_CAP = 500;

const DEFAULT_HUMAN_REASON = "Ken flagged this for a human but gave no reason.";

/** Strip a leading/trailing ``` fence (optionally ```prompt) Ken may have wrapped
 *  the prompt body in out of chat habit. */
function stripPromptFence(body: string): string {
  const trimmed = body.trim();
  const fenceOpen = /^```[^\n]*\n?/;
  const fenceClose = /\n?```$/;
  if (fenceOpen.test(trimmed) && fenceClose.test(trimmed)) {
    return trimmed.replace(fenceOpen, "").replace(fenceClose, "").trim();
  }
  return trimmed;
}

/** Truncate long text and note how much was dropped. */
function cap(text: string, max = RAW_REASON_CAP): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} […${text.length - max} more chars]`;
}

/** Same keyword normalization as the primary line check: uppercase, drop a
 *  trailing colon/period, collapse "ALL CLEAR" → "ALL_CLEAR". */
function normalizeKeywordLine(line: string): string {
  return line
    .trim()
    .toUpperCase()
    .replace(/[:.]+\s*$/, "")
    .trim()
    .replace(/\s+/g, "_");
}

const EXCEPTION_ACCEPTANCE_PREFIX = "ACCEPT_VERIFICATION_EXCEPTION ";

/** Parse the one optional ALL_CLEAR payload. The JSON object keeps arbitrary
 *  persisted IDs unambiguous and rejects prose or partial acknowledgements. */
function parseVerificationExceptionAcceptance(payload: string): string | undefined {
  const lines = payload
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1 || !lines[0]!.startsWith(EXCEPTION_ACCEPTANCE_PREFIX)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(lines[0]!.slice(EXCEPTION_ACCEPTANCE_PREFIX.length));
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      value.id.length === 0
    ) {
      return undefined;
    }
    return value.id;
  } catch {
    return undefined;
  }
}

/**
 * Fallback for when Ken ignores the "keyword-first, nothing before it"
 * instruction and buries a bare ALL_CLEAR/IGNORE/SKIP line after a recap or
 * explanation. Returns the LAST such line so ALL_CLEAR's optional acceptance
 * payload can be re-parsed from the exact verdict boundary.
 */
function findTrailingBareVerdict(
  lines: string[],
): { kind: "all_clear" | "ignore"; index: number } | null {
  let found: { kind: "all_clear" | "ignore"; index: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const normalized = normalizeKeywordLine(lines[index]!);
    if (normalized === "ALL_CLEAR") found = { kind: "all_clear", index };
    else if (normalized === "IGNORE" || normalized === "SKIP") {
      found = { kind: "ignore", index };
    }
  }
  return found;
}

/**
 * Parse Autopilot Ken's raw reply into a verdict. Never throws.
 */
export function parseAutopilotVerdict(reply: string): AutopilotVerdict {
  const raw = (reply ?? "").trim();
  if (!raw) {
    return { kind: "human", reason: DEFAULT_HUMAN_REASON };
  }

  const lines = raw.split("\n");
  // First non-empty line holds the keyword.
  let keywordLineIdx = 0;
  while (keywordLineIdx < lines.length && lines[keywordLineIdx].trim() === "") {
    keywordLineIdx++;
  }
  const keywordLine = (lines[keywordLineIdx] ?? "").trim();
  // Normalize the leading keyword: uppercase, drop a trailing colon, collapse a
  // space between words so "ALL CLEAR" and "ALL_CLEAR" both match.
  const normalized = keywordLine
    .toUpperCase()
    .replace(/[:.]+\s*$/, "")
    .trim();
  const collapsed = normalized.replace(/\s+/g, "_");

  const rest = lines
    .slice(keywordLineIdx + 1)
    .join("\n")
    .trim();

  if (collapsed === "ALL_CLEAR" || collapsed.startsWith("ALL_CLEAR")) {
    const acceptedVerificationExceptionId = parseVerificationExceptionAcceptance(rest);
    return acceptedVerificationExceptionId
      ? { kind: "all_clear", acceptedVerificationExceptionId }
      : { kind: "all_clear" };
  }

  // IGNORE / SKIP: the turn wasn't real work — nothing to say, nothing to show.
  if (
    collapsed === "IGNORE" ||
    collapsed.startsWith("IGNORE") ||
    collapsed === "SKIP" ||
    collapsed.startsWith("SKIP")
  ) {
    return { kind: "ignore" };
  }

  if (collapsed === "PROMPT" || collapsed.startsWith("PROMPT")) {
    // Prefer the body on the following lines; if the keyword line itself carried
    // inline text after "PROMPT:", fall back to that.
    let body = stripPromptFence(rest);
    if (!body) {
      const inline = keywordLine.replace(/^prompt[:\s]*/i, "").trim();
      body = stripPromptFence(inline);
    }
    if (!body) {
      return { kind: "human", reason: "Ken said to continue but gave no prompt." };
    }
    return { kind: "prompt", body };
  }

  if (collapsed === "HUMAN" || collapsed.startsWith("HUMAN")) {
    let reason = rest;
    if (!reason) {
      const inline = keywordLine.replace(/^human[:\s]*/i, "").trim();
      reason = inline;
    }
    return { kind: "human", reason: cap(reason) || DEFAULT_HUMAN_REASON };
  }

  // Unrecognized first line → before giving up, check for a bare verdict Ken
  // buried later in the reply (prose-then-keyword drift). This is the exact
  // shape that used to leak raw commentary + "ALL_CLEAR" into a HUMAN bubble
  // instead of rendering the normal all-clear/ignore marker.
  const trailing = findTrailingBareVerdict(lines);
  if (trailing?.kind === "all_clear") {
    return parseAutopilotVerdict(lines.slice(trailing.index).join("\n"));
  }
  if (trailing?.kind === "ignore") return { kind: "ignore" };

  // A buried bare HUMAN line (Ken wrote his reasoning first, THEN the verdict).
  // Take the lines after the LAST exact-"HUMAN" line as the reason and drop the
  // leading prose. Safe to recover unlike a buried PROMPT: HUMAN stops the cycle
  // either way, so this can't trigger autonomous action — it only keeps Ken's
  // internal reasoning out of the human-facing reason bubble (the drift that
  // dumped his whole recap into the transcript alongside the real reason).
  for (let i = lines.length - 1; i >= 0; i--) {
    if (normalizeKeywordLine(lines[i]) === "HUMAN") {
      const reason = lines
        .slice(i + 1)
        .join("\n")
        .trim();
      return { kind: "human", reason: cap(reason) || DEFAULT_HUMAN_REASON };
    }
  }

  // Buried PROMPT (the drift that used to dump a valid runnable prompt into a
  // HUMAN bubble): recover a line that STARTS with the uppercase keyword and
  // re-parse from there, so both `PROMPT <inline body>` and `PROMPT\n<body>`
  // shapes work. Uppercase + line-start (never mid-line, never lowercase)
  // keeps prose like "prompt the user" or "a prompt for GG Coder" from ever
  // matching. Takes the LAST such line, and runs AFTER the HUMAN recovery so
  // a reply carrying both stops instead of acting.
  const BURIED_PROMPT_RE = /^PROMPT(?=$|[\s:.,])/;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (BURIED_PROMPT_RE.test(lines[i].trim())) {
      return parseAutopilotVerdict(lines.slice(i).join("\n"));
    }
  }

  // Truly unrecognized → stop and ask the human, echoing the raw reply for context.
  return { kind: "human", reason: cap(raw) };
}
