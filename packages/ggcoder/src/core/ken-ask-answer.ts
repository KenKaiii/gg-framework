/**
 * Autopilot Ken's reply to an `ask_user` card. While autopilot is on, Ken
 * answers GG Coder's questions in the user's place, or leaves them to the user:
 *
 *   ANSWER
 *   {"questionId": "value", "multiId": ["a", "b"]}
 *
 *   HUMAN
 *   <one short reason the user must decide>
 *
 * Safe by default: anything that is not a complete, valid answer to every
 * question becomes HUMAN, so the card stays with the user and the agent never
 * acts on a malformed answer.
 */
import type { AskOption, AskQuestion } from "./ask-user.js";

export type KenAskAnswer =
  | { kind: "answer"; answers: Record<string, string | string[]> }
  | { kind: "human"; reason: string };

const DEFAULT_HUMAN_REASON = "Ken left this for you without a reason.";
const INVALID_REASON = "Ken's answer didn't fit the question.";
const REASON_CAP = 300;

const CONFIRM_OPTIONS: AskOption[] = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
];

function optionsOf(q: AskQuestion): AskOption[] {
  if (q.options?.length) return q.options;
  return q.kind === "confirm" ? CONFIRM_OPTIONS : [];
}

const allowsText = (q: AskQuestion): boolean => q.kind === "text" || q.allowOther !== false;

/** One picked value: an option's value or label maps to `value ?? label`;
 *  free text passes only where the question accepts it. */
function resolveValue(q: AskQuestion, raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const text = raw.trim();
  const lower = text.toLowerCase();
  for (const option of optionsOf(q)) {
    const value = option.value ?? option.label;
    if (value.toLowerCase() === lower || option.label.toLowerCase() === lower) return value;
  }
  return allowsText(q) ? text : null;
}

function resolveAnswer(q: AskQuestion, raw: unknown): string | string[] | null {
  if (q.kind === "multi") {
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : null;
    if (!list || list.length === 0) return null;
    const values: string[] = [];
    for (const item of list) {
      const value = resolveValue(q, item);
      if (value === null) return null;
      if (!values.includes(value)) values.push(value);
    }
    return values;
  }
  return resolveValue(q, raw);
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function human(reason: string): KenAskAnswer {
  const text = reason.trim() || DEFAULT_HUMAN_REASON;
  return {
    kind: "human",
    reason: text.length > REASON_CAP ? `${text.slice(0, REASON_CAP)}…` : text,
  };
}

/** Parse Ken's raw reply against the questions he was shown. Never throws. */
export function parseKenAskAnswer(reply: string, questions: readonly AskQuestion[]): KenAskAnswer {
  const raw = (reply ?? "").trim();
  if (!raw) return human(DEFAULT_HUMAN_REASON);
  const newline = raw.indexOf("\n");
  const firstLine = (newline === -1 ? raw : raw.slice(0, newline)).trim();
  const rest = newline === -1 ? "" : raw.slice(newline + 1);
  const keyword = firstLine
    .toUpperCase()
    .replace(/[:.]+\s*$/, "")
    .trim();

  if (keyword.startsWith("HUMAN")) {
    const inline = firstLine.slice("HUMAN".length).replace(/^[:.\s-]+/, "");
    return human([inline, rest.trim()].filter(Boolean).join("\n"));
  }
  if (!keyword.startsWith("ANSWER")) return human(INVALID_REASON);

  const body = stripFence(`${firstLine.slice("ANSWER".length).replace(/^[:\s]+/, "")}\n${rest}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return human(INVALID_REASON);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return human(INVALID_REASON);
  }
  const given = parsed as Record<string, unknown>;
  const answers: Record<string, string | string[]> = {};
  for (const q of questions) {
    const answer = resolveAnswer(q, given[q.id]);
    if (answer === null) return human(INVALID_REASON);
    answers[q.id] = answer;
  }
  return { kind: "answer", answers };
}
