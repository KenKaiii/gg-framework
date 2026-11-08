/**
 * Soft deadline for an `ask_user` call when someone is likely watching (a
 * plain interactive run). Past it the tool stops blocking: the agent proceeds
 * on its best guess while the question stays answerable in the app.
 */
export const ASK_USER_INTERACTIVE_DEADLINE_MS = 10 * 60_000;

/**
 * Soft deadline when nobody is watching — autopilot (Ken), task run-all
 * sweeps and scheduled prompts. Short, so an unattended run does not stall.
 */
export const ASK_USER_UNATTENDED_DEADLINE_MS = 2 * 60_000;

/**
 * The longest an `ask_user` call can block (the largest soft deadline). The
 * tool's own execution timeout is derived from this.
 */
export const ASK_USER_TIMEOUT_MS = Math.max(
  ASK_USER_INTERACTIVE_DEADLINE_MS,
  ASK_USER_UNATTENDED_DEADLINE_MS,
);

/** Pick the soft deadline for a run, by whether a human is likely watching. */
export function askSoftDeadlineMs(unattended: boolean): number {
  return unattended ? ASK_USER_UNATTENDED_DEADLINE_MS : ASK_USER_INTERACTIVE_DEADLINE_MS;
}

/** One selectable answer. `value` is what the agent gets back; `label` is UI. */
export interface AskOption {
  label: string;
  value?: string;
  /** One short line under the label, for rows the user has to weigh up. */
  hint?: string;
  /** Marks the agent's recommendation. Tagged in the UI, never preselected. */
  recommended?: boolean;
}

export type AskQuestionKind = "confirm" | "choice" | "multi" | "text";

export interface AskQuestion {
  /** Stable key this question's answer is returned under. */
  id: string;
  question: string;
  kind: AskQuestionKind;
  /** Optional one-line elaboration shown under the question. */
  detail?: string;
  /** Choices for `choice`/`multi`. `confirm` defaults to Yes/No when omitted. */
  options?: AskOption[];
  /** Whether the free-text escape is offered (default true, forced on `text`). */
  allowOther?: boolean;
}

export interface AskUserRequest {
  questions: AskQuestion[];
}

/** The frame a host broadcasts so its UI can render the band. */
export interface AskUserPrompt extends AskUserRequest {
  id: string;
}

export type AskUserResult =
  | { action: "answer"; answers: Record<string, string | string[]> }
  /**
   * No answer. `superseded` means the user replied with a message of their own
   * instead of picking — the question is moot, but they are still talking.
   */
  | { action: "cancel"; superseded?: boolean }
  /**
   * The soft deadline passed with no answer. The question stays open; a later
   * answer is delivered to the agent as a message (see `onLateAnswer`).
   */
  | { action: "deferred" };

/** An answer that arrived after the tool call had already moved on. */
export interface LateAskAnswer {
  prompt: AskUserPrompt;
  answers: Record<string, string | string[]>;
}

/**
 * Questions parked on the user. A question is either *pending* (the tool call
 * is blocked on it) or *deferred* (its soft deadline passed, the agent moved
 * on, but the user can still answer it).
 */
export interface AskUserBridge {
  /** Park a question: broadcasts it, resolves on answer, cancel or soft deadline. */
  park: (request: AskUserRequest) => Promise<AskUserResult>;
  /**
   * Answer or dismiss an open question. A deferred question's answer goes to
   * `onLateAnswer`. False when the id is not open (settled, superseded, closed).
   */
  settle: (id: string, result: AskUserResult) => boolean;
  /**
   * Release every pending question with `result` (default: cancel) and close
   * every deferred one — for run abort, a superseding user message, teardown.
   */
  cancelAll: (result?: AskUserResult) => void;
  /** Close deferred questions without touching a pending one (session reset). */
  closeDeferred: () => void;
  /** Questions the turn is currently blocked on. */
  readonly pendingCount: number;
  /** Questions past their soft deadline that can still be answered. */
  readonly deferredCount: number;
  /**
   * Snapshot of every open question, oldest first: deferred ones (marked
   * `deferred: true`) before the ones the turn is blocked on.
   */
  pending: () => Array<AskUserPrompt & { deferred?: true }>;
  /** Ids of every question that can still be answered (pending or deferred). */
  readonly openIds: () => string[];
  /**
   * Every question that can still be answered, in the order asked, so a
   * reconnecting window can show the cards again (a reload lost them, leaving
   * the agent waiting on a question nobody could see).
   */
  readonly openPrompts: () => Array<{ prompt: AskUserPrompt; deferred: boolean }>;
}

export interface AskUserBridgeOptions {
  broadcast: (prompt: AskUserPrompt) => void;
  /** Soft deadline in ms, read when each question is parked. */
  timeoutMs?: number | (() => number);
  /** The soft deadline passed: the agent proceeds, the question stays open. */
  onTimeout?: (prompt: AskUserPrompt) => void;
  /** A deferred question was answered. Called at most once per question. */
  onLateAnswer?: (late: LateAskAnswer) => void;
  /** Deferred questions closed without an answer (superseded, cancelled, reset). */
  onClosed?: (ids: string[]) => void;
  /**
   * A question left the bridge for good: answered (on time or late), dismissed,
   * cancelled or closed. Not called at the soft deadline; the question stays open.
   */
  onSettle?: (id: string) => void;
}

export function createAskUserBridge(opts: AskUserBridgeOptions): AskUserBridge {
  const pending = new Map<
    string,
    {
      prompt: AskUserPrompt;
      resolve: (result: AskUserResult) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const deferred = new Map<string, AskUserPrompt>();
  let seq = 0;

  const deadline = (): number => {
    const t = opts.timeoutMs;
    if (typeof t === "function") return t();
    return t ?? ASK_USER_INTERACTIVE_DEADLINE_MS;
  };

  const release = (id: string, result: AskUserResult): boolean => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(result);
    if (result.action !== "deferred") opts.onSettle?.(id);
    return true;
  };

  const closeDeferred = (): void => {
    if (deferred.size === 0) return;
    const ids = [...deferred.keys()];
    deferred.clear();
    opts.onClosed?.(ids);
    for (const id of ids) opts.onSettle?.(id);
  };

  return {
    park: (request) =>
      new Promise<AskUserResult>((resolve) => {
        // A newer question supersedes any older one still waiting past its
        // deadline: the agent has moved on to a new decision point.
        closeDeferred();
        const prompt: AskUserPrompt = { ...request, id: `ask-${++seq}` };
        const timer = setTimeout(() => {
          if (!pending.has(prompt.id)) return;
          deferred.set(prompt.id, prompt);
          opts.onTimeout?.(prompt);
          release(prompt.id, { action: "deferred" });
        }, deadline());
        timer.unref?.();
        pending.set(prompt.id, { prompt, resolve, timer });
        opts.broadcast(prompt);
      }),
    settle: (id, result) => {
      if (release(id, result)) return true;
      const prompt = deferred.get(id);
      if (!prompt) return false;
      deferred.delete(id);
      if (result.action === "answer") opts.onLateAnswer?.({ prompt, answers: result.answers });
      opts.onSettle?.(id);
      return true;
    },
    cancelAll: (result) => {
      for (const id of [...pending.keys()]) release(id, result ?? { action: "cancel" });
      closeDeferred();
    },
    closeDeferred,
    get pendingCount() {
      return pending.size;
    },
    get deferredCount() {
      return deferred.size;
    },
    pending: () => [
      ...[...deferred.values()].map((prompt) => ({ ...prompt, deferred: true as const })),
      ...[...pending.values()].map((entry) => entry.prompt),
    ],
    openIds: () => [...pending.keys(), ...deferred.keys()],
    openPrompts: () => [
      ...[...deferred.values()].map((prompt) => ({ prompt, deferred: true })),
      ...[...pending.values()].map(({ prompt }) => ({ prompt, deferred: false })),
    ],
  };
}

/**
 * What the model reads when the soft deadline passes. Short on purpose; the
 * safety line is the part that matters — a guessed answer must never license
 * an action the user cannot take back.
 */
export const ASK_DEFERRED_RESULT =
  "No answer yet — the user has not responded. Do not wait and do not ask again: proceed " +
  "on your best judgment and state the assumption you made. The question stays open; a " +
  'later reply arrives as a message starting "Late answer to:". On a guessed answer do only ' +
  "safe, reversible work. Do NOT delete data, push, publish, deploy, pay, send messages or " +
  "take any other destructive, costly or externally visible action — leave those for the user.";

/**
 * Render the user's answers as the tool result the model reads.
 *
 * Questions are echoed alongside their answers so the model never has to
 * remember what `store` meant, and an unanswered question is stated as such
 * rather than silently missing.
 */
export function formatAskResult(questions: AskQuestion[], result: AskUserResult): string {
  if (result.action === "deferred") return ASK_DEFERRED_RESULT;
  if (result.action === "cancel") {
    if (result.superseded) {
      return (
        "The user ignored the question and sent their own message instead. " +
        "It arrives next — treat it as their answer and continue. Do not ask this again."
      );
    }
    return (
      "The user did not answer (they dismissed the question). Do not ask again — " +
      "state the assumption you are proceeding with, or stop and wait for them."
    );
  }
  const lines = questions.map((q) => {
    const answer = result.answers[q.id];
    const text = Array.isArray(answer) ? answer.join(", ") : answer;
    return `${q.question}\n→ ${text?.trim() ? text.trim() : "(no answer)"}`;
  });
  return `The user answered:\n\n${lines.join("\n\n")}`;
}

/**
 * Frame a late answer as a message to the agent. It names the question it
 * answers, because by now the agent has moved on and may have asked others.
 */
export function formatLateAnswer(late: LateAskAnswer): string {
  const body = late.prompt.questions
    .map((q) => {
      const answer = late.answers[q.id];
      const text = Array.isArray(answer) ? answer.join(", ") : answer;
      return `Late answer to: ${q.question}\n→ ${text?.trim() ? text.trim() : "(no answer)"}`;
    })
    .join("\n\n");
  return (
    `${body}\n\n` +
    "(You asked this earlier and continued on an assumption. If this answer differs, " +
    "adjust the affected work; if it matches, carry on.)"
  );
}

/** Where a late answer goes: the host's existing user-message queue. */
export interface LateAnswerSink {
  /** Queue a user message; drained as mid-run steering by a live run. */
  queueMessage: (text: string) => number;
  /** True while a run (or a run-owning cycle) can still drain the queue. */
  isBusy: () => boolean;
  /** The queue changed (so clients can refresh their queued strip). */
  onQueued?: () => void;
  /** No run is live: start one from the queue (the host's stranded-queue drain). */
  startIdleRun: () => void;
}

/**
 * Deliver a late answer through the existing queue rather than a new channel:
 * a live run drains it at its next steering boundary; an idle session runs it
 * as the next user turn.
 */
export function deliverLateAnswer(late: LateAskAnswer, sink: LateAnswerSink): void {
  sink.queueMessage(formatLateAnswer(late));
  sink.onQueued?.();
  if (!sink.isBusy()) sink.startIdleRun();
}
