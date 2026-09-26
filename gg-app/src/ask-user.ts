/**
 * Shape of the sidecar's `ask_user` frame, kept free of Tauri imports so the
 * event machine (and its tests) can validate a frame without booting a webview.
 * The IPC call that answers one lives in `agent.ts`.
 */

/** One selectable answer. `value` is what the agent gets back; `label` is UI. */
export interface AskOption {
  label: string;
  value?: string;
  hint?: string;
  recommended?: boolean;
}

export interface AskQuestion {
  id: string;
  question: string;
  kind: "confirm" | "choice" | "multi" | "text";
  detail?: string;
  options?: AskOption[];
  allowOther?: boolean;
}

/** The `ask_user` frame: the turn stays blocked until this is answered. */
export interface AskUserPrompt {
  id: string;
  questions: AskQuestion[];
}

export type AskAnswers = Record<string, string | string[]>;

/**
 * Merge newly answered questions into a band's answers, and report whether the
 * band is now complete.
 *
 * The band is the unit of answer: the parked tool call settles only once EVERY
 * question in it has one, so a half-filled form never lands on the agent. An
 * answer can arrive from a click or from the composer, which is why this rule
 * lives outside the band component.
 */
export function mergeAskAnswers(
  current: AskAnswers | undefined,
  delta: AskAnswers,
  questions: readonly AskQuestion[],
): { answers: AskAnswers; complete: boolean } {
  const answers = { ...current, ...delta };
  return { answers, complete: questions.every((q) => answers[q.id] !== undefined) };
}

/**
 * Drop the question bands a freshly sent prompt supersedes.
 *
 * Sending a message of your own IS the answer: the sidecar releases the parked
 * tool call the moment that prompt arrives, so an open band is left pointing at
 * a question nobody is waiting on — its buttons would silently do nothing. A
 * band that already reached the agent (`sent`) or was closed by a cancelled run
 * (`cancelled`) is transcript history and stays put.
 */
export function dropSupersededAsks<T extends { kind: string; sent?: boolean; cancelled?: boolean }>(
  items: readonly T[],
): T[] {
  return items.filter((it) => !(it.kind === "ask" && it.sent !== true && it.cancelled !== true));
}

export function isAskUserPrompt(data: unknown): data is AskUserPrompt {
  if (typeof data !== "object" || data === null) return false;
  const { id, questions } = data as { id?: unknown; questions?: unknown };
  return (
    typeof id === "string" &&
    Array.isArray(questions) &&
    questions.length > 0 &&
    questions.every(
      (q) =>
        typeof q === "object" &&
        q !== null &&
        typeof (q as AskQuestion).id === "string" &&
        typeof (q as AskQuestion).question === "string" &&
        // The band maps over `options`; a non-array here (e.g. a "[CIRCULAR]"
        // marker from the sidecar's redactor) threw during render and blanked
        // the whole window.
        ((q as { options?: unknown }).options === undefined ||
          Array.isArray((q as { options?: unknown }).options)),
    )
  );
}
