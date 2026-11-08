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
 * Record answers for the band `itemId`. When that completes it, the answered
 * band leaves its spot and is re-added at the END of the conversation under a
 * fresh id, so the answer lands below everything the agent said meanwhile, the
 * way a sent prompt does (it rendered where the question was asked, often far
 * above the view, so it looked as if nothing was sent). The fresh id makes it a
 * new row: it dissolves in like any other. `answeredLive` tells the band it
 * mounted already answered because it was answered just now (its shimmer marks
 * that), not because it was restored. Returns the complete answers when this
 * call completed the band, so the caller can send them.
 */
export function answerAskItem<
  T extends {
    kind: string;
    id: number;
    sent?: boolean;
    answers?: AskAnswers;
    answeredLive?: boolean;
    prompt?: unknown;
  },
>(
  items: readonly T[],
  itemId: number,
  delta: AskAnswers,
  questionsOf: (item: T) => readonly AskQuestion[],
  nextId: () => number,
): { items: T[]; completed: AskAnswers | null } {
  const index = items.findIndex((it) => it.kind === "ask" && it.id === itemId && !it.sent);
  const item = items[index];
  if (index < 0 || item === undefined) return { items: [...items], completed: null };
  const { answers, complete } = mergeAskAnswers(item.answers, delta, questionsOf(item));
  if (!complete) {
    const next = [...items];
    next[index] = { ...item, answers };
    return { items: next, completed: null };
  }
  const rest = items.filter((_, i) => i !== index);
  return {
    items: [...rest, { ...item, id: nextId(), answers, sent: true, answeredLive: true }],
    completed: answers,
  };
}

/** The oldest question band still waiting on an answer, if any. */
export function firstOpenAskId<
  T extends { kind: string; id: number; sent?: boolean; cancelled?: boolean },
>(items: readonly T[]): number | null {
  return items.find((it) => it.kind === "ask" && !it.sent && !it.cancelled)?.id ?? null;
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
 * On (re)connect: close every open question the sidecar can no longer take an
 * answer to (`open` is its list). After a daemon restart the old run is gone,
 * so its cards would otherwise stay up as buttons that reach no one.
 */
export function closeAsksNotIn<T extends AskItem>(
  items: readonly T[],
  open: readonly string[],
): T[] {
  const live = new Set(open);
  const stale = new Set<string>();
  for (const it of items) {
    if (it.kind !== "ask" || it.sent === true || it.cancelled === true) continue;
    const id = (it.prompt as { id?: unknown } | undefined)?.id;
    if (typeof id === "string" && !live.has(id)) stale.add(id);
  }
  return stale.size === 0 ? [...items] : closeAsks(items, [...stale]);
}

/** An open question as the sidecar lists it on (re)connect. */
export interface OpenAskPrompt {
  prompt: AskUserPrompt;
  deferred: boolean;
}

/** The sidecar's `openAskPrompts` list, dropping anything malformed. */
export function parseOpenAskPrompts(data: unknown): OpenAskPrompt[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { prompt, deferred } = entry as { prompt?: unknown; deferred?: unknown };
    return isAskUserPrompt(prompt) ? [{ prompt, deferred: deferred === true }] : [];
  });
}

/**
 * Show the cards for questions still waiting on the user that the transcript
 * has no card for. A reloaded window rebuilds its transcript from history,
 * which keeps the tool call but not the card, so the agent sat waiting on a
 * question nobody could see.
 */
export function withOpenAsks<T>(
  items: readonly T[],
  open: readonly OpenAskPrompt[],
  makeItem: (ask: OpenAskPrompt) => T,
): T[] {
  const shown = new Set<string>();
  for (const it of items as readonly AskItem[]) {
    if (it.kind !== "ask" || typeof it.prompt !== "object" || it.prompt === null) continue;
    const id = (it.prompt as { id?: unknown }).id;
    if (typeof id === "string") shown.add(id);
  }
  const missing = open.filter((ask) => !shown.has(ask.prompt.id));
  return missing.length === 0 ? [...items] : [...items, ...missing.map(makeItem)];
}

/** A transcript card for an open question listed by the sidecar. */
export function askItemFor(
  ask: OpenAskPrompt,
  id: number,
): { kind: "ask"; id: number; prompt: AskUserPrompt; deferred?: true } {
  return { kind: "ask", id, prompt: ask.prompt, ...(ask.deferred ? { deferred: true } : {}) };
}

/**
 * The sidecar closed questions nobody is waiting on any more (a newer question
 * or a new session superseded them). Their buttons would reach no one.
 */
export function closeAsks<T extends AskItem>(items: readonly T[], ids: readonly string[]): T[] {
  const closed = new Set(ids);
  return items.map((it) => (isOpenAsk(it, closed) ? { ...it, cancelled: true } : it));
}
