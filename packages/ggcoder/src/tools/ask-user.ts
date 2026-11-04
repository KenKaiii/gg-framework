import { z } from "zod";
import type { AgentTool } from "@kleio/agent";
import {
  ASK_USER_TIMEOUT_MS,
  formatAskResult,
  type AskQuestion,
  type AskUserRequest,
  type AskUserResult,
} from "../core/ask-user.js";

/** Ask the host to put the questions in front of the user and wait. */
export type AskUserHandler = (request: AskUserRequest) => Promise<AskUserResult>;

/** Beyond this the band stops being a question and becomes a form. */
const MAX_QUESTIONS = 5;
const MAX_OPTIONS = 6;

const Option = z.object({
  label: z.string().min(1),
  value: z.string().optional(),
  hint: z.string().optional(),
  recommended: z.boolean().optional().describe("Your pick; max one"),
});

const Question = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  kind: z.enum(["confirm", "choice", "multi", "text"]),
  detail: z.string().optional(),
  options: z.array(Option).max(MAX_OPTIONS).optional(),
  allowOther: z.boolean().optional(),
});

const AskUserParams = z.object({
  questions: z.array(Question).min(1).max(MAX_QUESTIONS),
});

/** Yes/No is implied by `confirm`, so the model never has to spell it out. */
const CONFIRM_OPTIONS = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
];

/**
 * Options that hand the decision straight back to the user.
 *
 * A click carries no payload beyond the option itself, so "Fix something
 * specific" reaches the agent as literally that — an instruction it cannot
 * act on. Catching it here turns a dead-end question into a tool error the
 * model can immediately correct, instead of a button that wastes a turn.
 */
const DEFERRING = [
  /\bsomething specific\b/i,
  /\bsomething else\b/i,
  /^(other|tell me more|you (choose|decide)|let me (specify|decide|explain))\b/i,
  /\b(specify|describe|clarify|choose|pick|select|name)\b.*\b(it|one|which|what|something|a file|the file)\b/i,
];

function defersBack(option: { label: string }): boolean {
  return DEFERRING.some((re) => re.test(option.label.trim()));
}

function normalize(question: z.infer<typeof Question>): AskQuestion {
  const options =
    question.kind === "confirm" && !question.options?.length ? CONFIRM_OPTIONS : question.options;
  return {
    id: question.id,
    question: question.question,
    kind: question.kind,
    ...(question.detail ? { detail: question.detail } : {}),
    ...(options ? { options } : {}),
    ...(question.allowOther !== undefined ? { allowOther: question.allowOther } : {}),
  };
}

/**
 * Ask the user a question and block the turn until they answer.
 *
 * Registered only by hosts that can actually render it (the gg-app sidecar).
 * A subagent, a headless run or the TUI has nobody to answer, so the tool is
 * simply absent there and the agent falls back to asking in prose.
 */
export function createAskUserTool(ask: AskUserHandler): AgentTool<typeof AskUserParams> {
  return {
    name: "ask_user",
    description:
      "Ask the user with clickable options instead of a prose question. Not for facts you can " +
      "look up. Plain words; each option a complete outcome (never 'Something else').",
    parameters: AskUserParams,
    // The turn is blocked on a human; nothing else in the batch may run first.
    executionMode: "sequential",
    // The host's soft deadline is the real bound (it returns "no answer yet"
    // and keeps the question open). Without this the loop's 5-min default
    // would abort the call while the user is still reading the question.
    timeoutMs: ASK_USER_TIMEOUT_MS + 30_000,
    async execute({ questions }) {
      const ids = new Set(questions.map((q) => q.id));
      if (ids.size !== questions.length) {
        return "Error: every question needs a unique `id`.";
      }
      const missing = questions.find(
        (q) => (q.kind === "choice" || q.kind === "multi") && (q.options?.length ?? 0) < 2,
      );
      if (missing) {
        return `Error: question "${missing.id}" is kind "${missing.kind}" and needs at least 2 options.`;
      }
      const deferring = questions.flatMap((q) => q.options ?? []).find(defersBack);
      if (deferring) {
        return (
          `Error: the option "${deferring.label}" asks the user to specify something, but a ` +
          "click sends only that option — they cannot type or elaborate. Replace it with the " +
          "actual choices, or find the specifics yourself first. (The free-text escape is " +
          "already built into the UI.)"
        );
      }
      const normalized = questions.map(normalize);
      return formatAskResult(normalized, await ask({ questions: normalized }));
    },
  };
}
