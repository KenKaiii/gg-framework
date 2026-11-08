import { describe, expect, it } from "vitest";
import {
  answerAskItem,
  appendPendingAsks,
  askItemFor,
  askNotificationText,
  closeAsksNotIn,
  closeSettledAsk,
  firstOpenAskId,
  isAskUserPrompt,
  parseOpenAskPrompts,
  withOpenAsks,
  type AskQuestion,
  type AskUserPrompt,
} from "./ask-user";

type Row = {
  kind: string;
  id: number;
  sent?: boolean;
  answeredLive?: boolean;
  cancelled?: boolean;
  answers?: Record<string, string | string[]>;
  questions?: AskQuestion[];
};

const q = (id: string): AskQuestion => ({
  id,
  kind: "choice",
  question: `${id}?`,
  options: [{ label: "Yes" }, { label: "No" }],
});

/** A question asked mid-reply, with the agent's later output below it. */
function chat(questions: AskQuestion[]): Row[] {
  return [
    { kind: "user", id: 1 },
    { kind: "assistant", id: 2 },
    { kind: "ask", id: 3, questions },
    { kind: "assistant", id: 4 },
    { kind: "tool", id: 5 },
  ];
}

function answer(
  rows: Row[],
  itemId: number,
  delta: Record<string, string | string[]>,
): { items: Row[]; completed: Record<string, string | string[]> | null } {
  let seq = 100;
  return answerAskItem(
    rows,
    itemId,
    delta,
    (it) => it.questions ?? [],
    () => ++seq,
  );
}

describe("answerAskItem", () => {
  it("moves a completed answer to the end of the conversation, as a new row", () => {
    const { items, completed } = answer(chat([q("ship")]), 3, { ship: "Yes" });
    expect(completed).toEqual({ ship: "Yes" });
    // Below everything the agent said after asking, like a sent prompt.
    expect(items.map((it) => it.kind)).toEqual(["user", "assistant", "assistant", "tool", "ask"]);
    const moved = items[items.length - 1];
    expect(moved).toMatchObject({
      kind: "ask",
      sent: true,
      answeredLive: true,
      answers: { ship: "Yes" },
    });
    // A fresh id: it is a new row, so it dissolves in rather than reusing a key.
    expect(moved?.id).toBe(101);
  });

  it("keeps a partly answered band where it was asked", () => {
    const rows = chat([q("ship"), q("notify")]);
    const { items, completed } = answer(rows, 3, { ship: "Yes" });
    expect(completed).toBeNull();
    expect(items.map((it) => it.id)).toEqual([1, 2, 3, 4, 5]);
    expect(items[2]).toMatchObject({ answers: { ship: "Yes" } });
    expect(items[2]?.sent).toBeUndefined();

    // The last answer completes it, and only then does it move.
    const done = answer(items, 3, { notify: "No" });
    expect(done.completed).toEqual({ ship: "Yes", notify: "No" });
    expect(done.items[done.items.length - 1]).toMatchObject({ kind: "ask", sent: true });
  });

  it("ignores a band that was already sent or doesn't exist", () => {
    const rows: Row[] = [{ kind: "ask", id: 3, sent: true, questions: [q("ship")] }];
    expect(answer(rows, 3, { ship: "No" })).toEqual({ items: rows, completed: null });
    expect(answer(rows, 9, { ship: "No" }).completed).toBeNull();
  });
});

describe("firstOpenAskId", () => {
  it("finds the oldest question still waiting on the user", () => {
    const rows: Row[] = [
      { kind: "ask", id: 1, sent: true },
      { kind: "ask", id: 2, cancelled: true },
      { kind: "assistant", id: 3 },
      { kind: "ask", id: 4 },
      { kind: "ask", id: 5 },
    ];
    expect(firstOpenAskId(rows)).toBe(4);
    expect(firstOpenAskId(rows.slice(0, 3))).toBeNull();
  });
});

describe("isAskUserPrompt", () => {
  it("accepts questions with and without options", () => {
    const prompt = {
      id: "ask-1",
      questions: [
        { id: "a", kind: "confirm", question: "Go?", options: [{ label: "Yes" }] },
        { id: "b", kind: "text", question: "Why?" },
      ],
    };
    expect(isAskUserPrompt(prompt)).toBe(true);
  });

  it("rejects a question whose options are not a list", () => {
    const prompt = {
      id: "ask-1",
      questions: [{ id: "a", kind: "confirm", question: "Go?", options: "[CIRCULAR]" }],
    };
    expect(isAskUserPrompt(prompt)).toBe(false);
  });
});

describe("pending/settled asks", () => {
  type It = {
    kind: string;
    id: number;
    prompt?: AskUserPrompt;
    sent?: boolean;
    cancelled?: boolean;
  };
  const p = (id: string): AskUserPrompt => ({
    id,
    questions: [{ id: "a", kind: "confirm", question: "Go?" }],
  });
  const make = (prompt: AskUserPrompt): It => ({ kind: "ask", id: 9, prompt });

  it("appends only valid asks the transcript does not already show", () => {
    const items: It[] = [{ kind: "ask", id: 1, prompt: p("ask-1") }];
    const out = appendPendingAsks(items, [p("ask-1"), p("ask-2"), { id: "bad" }], make);
    expect(out.map((i) => i.prompt?.id)).toEqual(["ask-1", "ask-2"]);
    expect(appendPendingAsks(items, undefined, make)).toEqual(items);
  });

  it("closes the open band for a settled ask, leaving sent bands alone", () => {
    const items: It[] = [
      { kind: "ask", id: 1, prompt: p("ask-1") },
      { kind: "ask", id: 2, prompt: p("ask-2"), sent: true },
    ];
    expect(closeSettledAsk(items, "ask-1")[0]?.cancelled).toBe(true);
    expect(closeSettledAsk(items, "ask-2")[1]).toEqual(items[1]);
  });
});

describe("askNotificationText", () => {
  it("titles the first question and lists its options", () => {
    expect(
      askNotificationText({
        id: "ask-1",
        questions: [
          {
            id: "s",
            kind: "choice",
            question: "Where should login sessions be stored?",
            options: [{ label: "Keep it simple (one file)" }, { label: "Use a real database" }],
          },
          { id: "t", kind: "confirm", question: "Ship?" },
        ],
      }),
    ).toEqual({
      title: "Where should login sessions be stored? (+1 more)",
      body: "Keep it simple (one file) · Use a real database",
    });
    expect(
      askNotificationText({ id: "a", questions: [{ id: "x", kind: "confirm", question: "Go?" }] })
        .body,
    ).toBe("Yes · No");
  });
});

describe("closeAsksNotIn", () => {
  it("closes cards the sidecar can no longer answer, and keeps live ones", () => {
    // Live bug: after a daemon restart a goal's "Start the goal now" card stayed
    // up; clicking it reached no one, and the goal never started.
    const ask = (id: string, extra: Partial<{ sent: boolean }> = {}) => ({
      kind: "ask",
      prompt: { id, questions: [] },
      ...extra,
    });
    const items = [ask("dead"), ask("live"), ask("done", { sent: true }), { kind: "user" }];
    const next = closeAsksNotIn(items, ["live"]);
    expect(next[0]).toMatchObject({ cancelled: true });
    expect(next[1]).toBe(items[1]);
    expect(next[2]).toBe(items[2]);
    expect(closeAsksNotIn(items.slice(1), ["live"])).toEqual(items.slice(1));
  });
});

describe("withOpenAsks", () => {
  it("puts back cards for questions the agent still waits on", () => {
    // Live bug: a reload rebuilt the transcript from history, which keeps the
    // tool call but not the card, so Kleio Goals sat waiting on a question
    // nobody could see.
    const open = parseOpenAskPrompts([
      { prompt: { id: "ask-1", questions: [q("tool")] }, deferred: false },
      { prompt: { id: "ask-0", questions: [q("old")] }, deferred: true },
      { prompt: { id: "bad" }, deferred: false },
      "junk",
    ]);
    expect(open.map((a) => a.prompt.id)).toEqual(["ask-1", "ask-0"]);

    let id = 100;
    const items: Array<{ kind: string; id: number; prompt?: unknown }> = [
      { kind: "user", id: 1 },
      { kind: "ask", id: 2, prompt: { id: "ask-0", questions: [q("old")] } },
    ];
    const next = withOpenAsks(items, open, (ask) => askItemFor(ask, ++id));
    expect(next.slice(0, 2)).toEqual(items);
    expect(next[2]).toEqual({ kind: "ask", id: 101, prompt: open[0]?.prompt });
    expect(next).toHaveLength(3);
    // Nothing missing: the same items, nothing added.
    expect(withOpenAsks(next, open, (ask) => askItemFor(ask, ++id))).toEqual(next);
    expect(askItemFor({ prompt: { id: "x", questions: [q("a")] }, deferred: true }, 7)).toEqual({
      kind: "ask",
      id: 7,
      prompt: { id: "x", questions: [q("a")] },
      deferred: true,
    });
  });
});
