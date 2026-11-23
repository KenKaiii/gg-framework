import type { Message } from "@kenkaiiii/gg-ai";

/**
 * Post-compaction re-grounding hook.
 *
 * Compaction summarizes earlier context, which is a known drift point: the
 * model can quietly lose the verbatim original ask or a subtle constraint.
 * After a compaction this run, inject the original request verbatim (the one
 * piece of ground truth the summary may have lossily rewritten) so the model
 * re-anchors before its next step. Fires at most once per compaction event.
 *
 * Per the "introspection alone fails" research, this injects concrete
 * evidence (the literal original request) rather than asking the model to
 * "think harder".
 */

export interface RegroundingState {
  /** A compaction/overflow-compaction happened during this run. */
  compactionOccurred: boolean;
  /** A re-grounding message was already injected for this compaction. */
  alreadyInjected: boolean;
}

/**
 * The text of a user message to pin as the original request. Messages with
 * attachments arrive as content parts; their text parts are the instructions,
 * and each image/video is noted by kind only — media payloads never enter the
 * prompt, and their content is not inferred.
 */
export function requestTextForRegrounding(message: Message | undefined): string {
  if (!message || message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const text: string[] = [];
  const media = { image: 0, video: 0 };
  for (const part of message.content) {
    if (part.type === "text") text.push(part.text);
    else if (part.type === "image" || part.type === "video") media[part.type]++;
  }
  const attached = (Object.entries(media) as [keyof typeof media, number][])
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}${count === 1 ? "" : "s"}`);
  const note = attached.length > 0 ? `[Attached: ${attached.join(", ")}]` : "";
  return [text.join("\n").trim(), note].filter(Boolean).join("\n\n");
}

export function shouldReground(state: RegroundingState): boolean {
  return state.compactionOccurred && !state.alreadyInjected;
}

const USER_ANSWERED = "The user answered:";
const USER_MESSAGE =
  /^The user skipped the question[\s\S]*?<user_message>\n?([\s\S]*?)\n?<\/user_message>/;
const MAX_DECISIONS = 5;
const MAX_DECISION_CHARS = 1_500;

/**
 * The user's own decision in an `ask_user` result, or null. Autopilot Ken's
 * answers, dismissals and deferrals are not the user's call, so they are never
 * recorded as scope.
 */
export function askUserDecision(result: string): string | null {
  const text = result.trim();
  if (text.startsWith(USER_ANSWERED)) {
    return text.slice(USER_ANSWERED.length).trim() || null;
  }
  return text.match(USER_MESSAGE)?.[1]?.trim() || null;
}

/** Append the decision in `result` (if any), keeping the last few, each capped. */
export function recordUserDecision(decisions: string[], result: string): string[] {
  const decision = askUserDecision(result);
  if (!decision) return decisions;
  const capped =
    decision.length > MAX_DECISION_CHARS
      ? `${decision.slice(0, MAX_DECISION_CHARS).trimEnd()}\u2026`
      : decision;
  return [...decisions, capped].slice(-MAX_DECISIONS);
}

export function buildRegroundingMessage(
  originalRequest: string,
  decisions: string[] = [],
): Message {
  const trimmed = originalRequest.trim();
  const pin =
    trimmed.length > 0
      ? `\n\nThe user's original request was:\n\n  ${trimmed}\n\n`
      : " The original request is in the earlier messages that remain. ";
  const answers = decisions.map((d) => d.trim()).filter(Boolean);
  const scope =
    answers.length > 0
      ? "Later in this run the user answered your questions. These answers are the current " +
        "scope and take precedence over the request's wording:\n\n" +
        answers.map((a) => `  - ${a.replace(/\n/g, "\n    ")}`).join("\n") +
        "\n\n"
      : "";
  const anchor =
    answers.length > 0
      ? "Re-anchor on that request as the user's later answers above scope it, and on the " +
        "specific objective you're working on right now; the user's later answers above are " +
        "not drift. "
      : "Re-anchor on that request and on the specific objective you're working on right now. " +
        "Verify your next step still serves it, not a version you reshaped yourself. ";
  return {
    role: "user",
    provenance: { source: "runtime", kind: "continuation", visibility: "hidden" },
    content:
      "Re-ground. The conversation was just compacted, so earlier detail is now a summary and " +
      "easy to drift from." +
      pin +
      scope +
      anchor +
      "If the summary dropped a constraint, file, or requirement you were tracking, recover it " +
      "from the messages that remain. Continue from the summary's Next Step. Re-read a file " +
      "only for the exact text you are about to edit, not to re-survey. Do not restate this " +
      "note; just proceed correctly.",
  };
}
