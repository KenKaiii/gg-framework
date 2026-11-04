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

/**
 * Notification text for a question: title = the first question (+N more),
 * body = its options joined with " · " (Yes · No for a bare confirm). Mirrors
 * the host's push (packages/kleio-host/src/ask-push.ts).
 */
export function askNotificationText(prompt: AskUserPrompt): { title: string; body: string } {
  const [first] = prompt.questions;
  const more = prompt.questions.length > 1 ? ` (+${prompt.questions.length - 1} more)` : "";
  const labels =
    first?.options?.map((o) => o.label).filter((l) => l.trim() !== "") ??
    (first?.kind === "confirm" ? ["Yes", "No"] : []);
  return {
    title: `${first?.question ?? "Kleio has a question"}${more}`,
    body: labels.length ? labels.join(" · ") : "Click to answer.",
  };
}

type AskItem = { kind: string; prompt?: unknown; sent?: boolean; cancelled?: boolean };

const askIdOf = (it: AskItem): string | null =>
  it.kind === "ask" && isAskUserPrompt(it.prompt) ? it.prompt.id : null;

/**
 * Add a band for each question still parked on the user (`/state`'s
 * `pendingAsks`, or a live/replayed `ask_user` frame) that the transcript does
 * not already show. A session opened late — from a push — re-shows the band.
 */
export function appendPendingAsks<T extends AskItem>(
  items: readonly T[],
  pending: readonly unknown[] | undefined,
  makeItem: (prompt: AskUserPrompt) => T,
): T[] {
  const shown = new Set(items.map(askIdOf).filter((id): id is string => id !== null));
  const fresh = (pending ?? []).filter(
    (p): p is AskUserPrompt => isAskUserPrompt(p) && !shown.has(p.id),
  );
  return fresh.length ? [...items, ...fresh.map(makeItem)] : [...items];
}

/**
 * Close the open band for a question the sidecar settled (`ask_user_done`):
 * answered on another device, dismissed, or timed out. A band this window
 * already sent stays as history.
 */
export function closeSettledAsk<T extends AskItem>(items: readonly T[], id: string): T[] {
  return items.map((it) =>
    askIdOf(it) === id && it.sent !== true && it.cancelled !== true
      ? { ...it, cancelled: true }
      : it,
  );
}

/**
 * Free text is offered everywhere except when the model opts out. There is no
 * button for it: a `text` question hands straight over to the composer, and on
 * any other question typing a character does the same.
 */
export const allowsText = (q: AskQuestion): boolean => q.kind === "text" || q.allowOther !== false;

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

/** An unresolved question band whose prompt id is in `ids`. */
function isOpenAsk(it: AskItem, ids: ReadonlySet<string>): boolean {
  if (it.kind !== "ask" || it.sent === true || it.cancelled === true) return false;
  const prompt = it.prompt;
  if (typeof prompt !== "object" || prompt === null) return false;
  const id = (prompt as { id?: unknown }).id;
  return typeof id === "string" && ids.has(id);
}

/**
 * The question's soft deadline passed: the agent continued on its best guess,
 * but the band stays answerable — a later answer is sent as a message.
 */
export function markAskDeferred<T extends AskItem>(items: readonly T[], promptId: string): T[] {
  const ids = new Set([promptId]);
  return items.map((it) => (isOpenAsk(it, ids) ? { ...it, deferred: true } : it));
}

/**
 * The sidecar closed questions nobody is waiting on any more (a newer question
 * or a new session superseded them). Their buttons would reach no one.
 */
export function closeAsks<T extends AskItem>(items: readonly T[], ids: readonly string[]): T[] {
  const closed = new Set(ids);
  return items.map((it) => (isOpenAsk(it, closed) ? { ...it, cancelled: true } : it));
}
