// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AskQuestion, AskUserPrompt } from "./ask-user";
import { AskBand } from "./AskBand";
import { closeAsks, dropSupersededAsks, markAskDeferred, mergeAskAnswers } from "./ask-user";

const prompt = (...questions: AskQuestion[]): AskUserPrompt => ({ id: "ask-1", questions });

const onTypeInstead = vi.fn();

afterEach(() => {
  cleanup();
  onTypeInstead.mockClear();
});

describe("AskBand", () => {
  it("answers a confirm with one click", () => {
    const onAnswer = vi.fn();
    render(
      <AskBand
        prompt={prompt({
          id: "flag",
          question: "Flip the flag for everyone now?",
          kind: "confirm",
          options: [
            { label: "Yes, flip it", value: "yes", recommended: true },
            { label: "Not yet", value: "no" },
          ],
        })}
        onAnswer={onAnswer}
        onTypeInstead={onTypeInstead}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Yes, flip it/ }));
    expect(onAnswer).toHaveBeenCalledWith({ flag: "yes" });
  });

  it("marks the recommendation without preselecting it", () => {
    render(
      <AskBand
        prompt={prompt({
          id: "store",
          question: "Which store for sessions?",
          kind: "choice",
          options: [{ label: "SQLite", recommended: true }, { label: "Postgres" }],
        })}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    // Tagged, but nothing is chosen for the user — no pressed/checked state.
    expect(screen.getByText("Recommended")).toBeTruthy();
    expect(document.querySelector('[aria-pressed="true"]')).toBeNull();
  });

  it("returns the option's value, not its label", () => {
    const onAnswer = vi.fn();
    render(
      <AskBand
        prompt={prompt({
          id: "store",
          question: "Which store for sessions?",
          kind: "choice",
          options: [
            { label: "SQLite", value: "sqlite" },
            { label: "Postgres", value: "pg" },
          ],
        })}
        onAnswer={onAnswer}
        onTypeInstead={onTypeInstead}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Postgres/ }));
    expect(onAnswer).toHaveBeenCalledWith({ store: "pg" });
  });

  it("renders long labels as rows, with their hints", () => {
    render(
      <AskBand
        prompt={prompt({
          id: "land",
          question: "How do you want to land this?",
          kind: "choice",
          options: [
            {
              label: "Fix it first, then commit & push",
              hint: "Adds about a minute, keeps the branch green",
              recommended: true,
            },
            { label: "Commit & push anyway", hint: "Issue stays open in the log" },
          ],
        })}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    expect(document.querySelector(".ask-options")).toBeTruthy();
    // Options are the app's shared pill, never a bespoke one-off control.
    expect(document.querySelectorAll(".ask-options .btn.btn-ghost").length).toBe(2);
    expect(screen.getByText("Adds about a minute, keeps the branch green")).toBeTruthy();
  });

  it("gives a yes/no the same option treatment as every other question", () => {
    // A confirm used to render as inline chips — the one shape whose options had
    // no surface of their own, which made it look like a different component.
    render(
      <AskBand
        prompt={prompt({
          id: "flag",
          question: "Flip the flag?",
          kind: "confirm",
          options: [{ label: "Yes" }, { label: "No" }],
        })}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    // Same shared pill class as every other question's options, so one
    // stylesheet rule covers them all and they cannot drift apart again.
    expect(document.querySelectorAll(".ask-options .btn.btn-ghost").length).toBe(2);
  });

  it("lays every question out the same way, whatever its kind", () => {
    // A short yes/no next to a hinted choice: both stack as full-width rows.
    render(
      <AskBand
        prompt={prompt(
          {
            id: "sounds",
            question: "Drop the chimes?",
            kind: "choice",
            options: [
              { label: "Keep them", hint: "Only the text changes" },
              { label: "Drop them", hint: "Silent toggle" },
            ],
          },
          {
            id: "commit",
            question: "Commit to main?",
            kind: "confirm",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        )}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    const groups = document.querySelectorAll(".ask-options");
    expect(groups.length).toBe(2);
    // No layout variant survives: there is one shape and nothing opts out of it.
    expect(document.querySelectorAll(".ask-options.rows").length).toBe(0);
  });

  it("collects a multi-select and sends it as an array", () => {
    const onAnswer = vi.fn();
    render(
      <AskBand
        prompt={prompt({
          id: "steps",
          question: "Which steps should I run?",
          kind: "multi",
          options: [{ label: "Typecheck" }, { label: "Test suite" }, { label: "Windows smoke" }],
        })}
        onAnswer={onAnswer}
        onTypeInstead={onTypeInstead}
      />,
    );
    const send = screen.getByRole("button", { name: /Choose at least one/ });
    expect(send).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: /Typecheck/ }));
    fireEvent.click(screen.getByRole("button", { name: /Windows smoke/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm 2 selected/ }));
    expect(onAnswer).toHaveBeenCalledWith({ steps: ["Typecheck", "Windows smoke"] });
  });

  it("sends the user to the composer instead of a second input in the transcript", () => {
    render(
      <AskBand
        prompt={prompt({
          id: "flag",
          question: "Flip the flag for everyone now?",
          kind: "confirm",
          options: [{ label: "Yes" }, { label: "No" }],
        })}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    // Typing is the whole free-text path now — there is no button for it.
    fireEvent.keyDown(document, { key: "m" });
    expect(onTypeInstead).toHaveBeenCalledWith("flag", "m");
    // No competing text field is opened inside the band.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("routes a text-only question straight to the composer", () => {
    render(
      <AskBand
        prompt={prompt({ id: "name", question: "What should I call the flag?", kind: "text" })}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    expect(onTypeInstead).toHaveBeenCalledWith("name");
  });

  it("refuses free text when the agent opts out", () => {
    render(
      <AskBand
        prompt={prompt({
          id: "go",
          question: "Run the migration against prod?",
          kind: "confirm",
          options: [{ label: "Yes" }, { label: "No" }],
          allowOther: false,
        })}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    fireEvent.keyDown(document, { key: "m" });
    expect(onTypeInstead).not.toHaveBeenCalled();
  });

  it("accelerates with number keys, and carries a typed character to the composer", () => {
    const onAnswer = vi.fn();
    const { unmount } = render(
      <AskBand
        prompt={prompt({
          id: "flag",
          question: "Flip the flag?",
          kind: "confirm",
          options: [{ label: "Yes" }, { label: "No" }],
        })}
        onAnswer={onAnswer}
        onTypeInstead={onTypeInstead}
      />,
    );
    fireEvent.keyDown(document, { key: "2" });
    expect(onAnswer).toHaveBeenCalledWith({ flag: "No" });
    unmount();

    render(
      <AskBand
        prompt={prompt({
          id: "flag",
          question: "Flip the flag?",
          kind: "confirm",
          options: [{ label: "Yes" }, { label: "No" }],
        })}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    // A printed character means "I want to write my own answer" — it carries the
    // keystroke to the composer so the first letter is not swallowed.
    fireEvent.keyDown(document, { key: "m" });
    expect(onTypeInstead).toHaveBeenCalledWith("flag", "m");
  });

  it("never steals a keystroke meant for the composer", () => {
    const onAnswer = vi.fn();
    render(
      <>
        <textarea data-testid="composer" />
        <AskBand
          prompt={prompt({
            id: "flag",
            question: "Flip the flag?",
            kind: "confirm",
            options: [{ label: "Yes" }, { label: "No" }],
          })}
          onAnswer={onAnswer}
          onTypeInstead={onTypeInstead}
        />
      </>,
    );
    fireEvent.keyDown(screen.getByTestId("composer"), { key: "1" });
    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: /Your answer/ })).toBeNull();
  });

  it("reports each answered question, and only reads complete once all are in", () => {
    const onAnswer = vi.fn();
    // Controlled exactly as App drives it: the band emits a delta, the owner
    // merges, and completion is decided by the shared merge rule.
    function Controlled(): React.ReactElement {
      const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
      const p = prompt(
        {
          id: "trial",
          question: "Trial length before the first charge?",
          kind: "choice",
          options: [{ label: "14 days", recommended: true }, { label: "No trial" }],
        },
        {
          id: "proration",
          question: "Proration on mid-cycle upgrade?",
          kind: "choice",
          options: [{ label: "Prorate", recommended: true }, { label: "Charge full" }],
        },
      );
      return (
        <AskBand
          prompt={p}
          answers={answers}
          onAnswer={(delta) => {
            onAnswer(delta);
            setAnswers((c) => mergeAskAnswers(c, delta, p.questions).answers);
          }}
          onTypeInstead={onTypeInstead}
        />
      );
    }
    render(<Controlled />);

    fireEvent.click(screen.getByRole("button", { name: /No trial/ }));
    expect(onAnswer).toHaveBeenLastCalledWith({ trial: "No trial" });
    // Still on screen and still changeable — the pick is the only filled row.
    expect(screen.getByRole("button", { name: /No trial/ })).toHaveProperty("ariaPressed", "true");
    expect(screen.getByRole("button", { name: /14 days/ })).toHaveProperty("ariaPressed", "false");

    fireEvent.click(screen.getByRole("button", { name: /Charge full/ }));
    expect(onAnswer).toHaveBeenLastCalledWith({ proration: "Charge full" });
  });

  it("keeps an answer changeable while the rest of the band is undecided", () => {
    const sent: Record<string, string | string[]>[] = [];
    function Controlled(): React.ReactElement {
      const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
      const p = prompt(
        {
          id: "trial",
          question: "Trial length before the first charge?",
          kind: "choice",
          options: [{ label: "14 days", recommended: true }, { label: "No trial" }],
        },
        {
          id: "proration",
          question: "Proration on mid-cycle upgrade?",
          kind: "choice",
          options: [{ label: "Prorate" }, { label: "Charge full" }],
        },
      );
      return (
        <AskBand
          prompt={p}
          answers={answers}
          onAnswer={(delta) => {
            const merged = mergeAskAnswers(answers, delta, p.questions);
            // Exactly what App does: the last answer commits the band.
            if (merged.complete) sent.push(merged.answers);
            setAnswers(merged.answers);
          }}
          onTypeInstead={onTypeInstead}
        />
      );
    }
    render(<Controlled />);

    fireEvent.click(screen.getByRole("button", { name: /No trial/ }));
    // The question does not collapse: both options stay on screen, and the pick
    // is the only one filled.
    expect(screen.getByRole("button", { name: /14 days/ })).toHaveProperty("ariaPressed", "false");
    const picked = screen.getByRole("button", { name: /No trial/ });
    expect(picked).toHaveProperty("ariaPressed", "true");
    expect(picked.classList.contains("btn-primary")).toBe(true);

    // Changed its mind, before anything reached the agent.
    fireEvent.click(screen.getByRole("button", { name: /14 days/ }));
    expect(screen.getByRole("button", { name: /14 days/ })).toHaveProperty("ariaPressed", "true");
    expect(screen.getByRole("button", { name: /No trial/ })).toHaveProperty("ariaPressed", "false");
    expect(sent).toEqual([]);

    // Answering the last open question is the send — no button in between.
    fireEvent.click(screen.getByRole("button", { name: /Charge full/ }));
    expect(sent).toEqual([{ trial: "14 days", proration: "Charge full" }]);
  });

  it("carries no band chrome — options and nothing else", () => {
    render(
      <AskBand
        prompt={prompt(
          {
            id: "a",
            question: "A?",
            kind: "choice",
            options: [{ label: "Yes", recommended: true }, { label: "No" }],
          },
          {
            id: "b",
            question: "B?",
            kind: "choice",
            options: [{ label: "Prorate", recommended: true }, { label: "Charge full" }],
          },
        )}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    for (const gone of [/Something else/, /Send answers/, /recommended answer/, /answered/]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    // Only the four options are clickable.
    expect(screen.getAllByRole("button").length).toBe(4);
  });

  it("shows an already-answered multi-select's picks instead of an empty list", () => {
    // Restored from history, or simply re-rendered while a neighbour question is
    // still open: local draft state is empty, so the committed answer has to be
    // what the rows read from.
    render(
      <AskBand
        prompt={prompt(
          {
            id: "checks",
            question: "Which checks?",
            kind: "multi",
            options: [{ label: "Typecheck" }, { label: "Tests" }, { label: "Build" }],
          },
          { id: "then", question: "Then what?", kind: "choice", options: [{ label: "Push" }] },
        )}
        answers={{ checks: ["Typecheck", "Build"] }}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    expect(screen.getByRole("button", { name: /Typecheck/ })).toHaveProperty("ariaPressed", "true");
    expect(screen.getByRole("button", { name: /Build/ })).toHaveProperty("ariaPressed", "true");
    expect(screen.getByRole("button", { name: /Tests/ })).toHaveProperty("ariaPressed", "false");
  });

  it("keeps a confirmed multi-select in step with the rows when it is changed again", () => {
    // The stale-commit bug: after confirming, toggling another box only moved
    // local state, so answering the LAST question committed the old selection
    // while the screen showed the new one.
    const onAnswer = vi.fn();
    render(
      <AskBand
        prompt={prompt(
          {
            id: "checks",
            question: "Which checks?",
            kind: "multi",
            options: [{ label: "Typecheck" }, { label: "Tests" }],
          },
          { id: "then", question: "Then what?", kind: "choice", options: [{ label: "Push" }] },
        )}
        answers={{ checks: ["Typecheck"] }}
        onAnswer={onAnswer}
        onTypeInstead={onTypeInstead}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Tests/ }));
    expect(onAnswer).toHaveBeenCalledWith({ checks: ["Typecheck", "Tests"] });
  });

  it("shows a typed answer for a question that has no options at all", () => {
    // A `text` question is optionless, so guarding the row stack on options
    // alone left it displaying nothing but its heading once answered.
    render(
      <AskBand
        prompt={prompt(
          { id: "name", question: "What should I call it?", kind: "text" },
          { id: "then", question: "Then what?", kind: "choice", options: [{ label: "Push" }] },
        )}
        answers={{ name: "yaatuber-web" }}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    expect(screen.getByRole("button", { name: "yaatuber-web" })).toBeTruthy();
  });

  it("holds a multi-select until it is confirmed, so it cannot commit half-picked", () => {
    const onAnswer = vi.fn();
    render(
      <AskBand
        prompt={prompt({
          id: "checks",
          question: "Which checks?",
          kind: "multi",
          options: [{ label: "Typecheck" }, { label: "Tests" }, { label: "Build" }],
        })}
        onAnswer={onAnswer}
        onTypeInstead={onTypeInstead}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Typecheck/ }));
    fireEvent.click(screen.getByRole("button", { name: /Build/ }));
    // Picking is not answering: nothing reaches the agent mid-selection.
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm 2 selected" }));
    expect(onAnswer).toHaveBeenCalledWith({ checks: ["Typecheck", "Build"] });
  });

  it("aims the number keys at the first question still unanswered", () => {
    const onAnswer = vi.fn();
    render(
      <AskBand
        prompt={prompt(
          {
            id: "trial",
            question: "Trial length?",
            kind: "choice",
            options: [{ label: "14 days" }, { label: "No trial" }],
          },
          {
            id: "proration",
            question: "Proration?",
            kind: "choice",
            options: [{ label: "Prorate" }, { label: "Charge full" }],
          },
        )}
        answers={{ trial: "14 days" }}
        onAnswer={onAnswer}
        onTypeInstead={onTypeInstead}
      />,
    );
    fireEvent.keyDown(document, { key: "2" });
    expect(onAnswer).toHaveBeenCalledWith({ proration: "Charge full" });
  });

  it("shows a typed answer as its own filled option", () => {
    render(
      <AskBand
        prompt={prompt(
          {
            id: "trial",
            question: "Trial length?",
            kind: "choice",
            options: [{ label: "14 days" }, { label: "No trial" }],
          },
          {
            id: "proration",
            question: "Proration?",
            kind: "choice",
            options: [{ label: "Prorate" }],
          },
        )}
        answers={{ trial: "30 days, then review" }}
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    const typedPill = screen.getByRole("button", { name: "30 days, then review" });
    expect(typedPill.classList.contains("btn-primary")).toBe(true);
    // And it is the way back to the composer to write a different one.
    fireEvent.click(typedPill);
    expect(onTypeInstead).toHaveBeenCalledWith("trial");
  });

  // The "Use every recommended answer" shortcut it used to test is gone with the
  // rest of the band chrome; "carries no band chrome" above asserts its absence.

  it("collapses in place once answered", () => {
    render(
      <AskBand
        prompt={prompt({
          id: "flag",
          question: "Flip the flag?",
          kind: "confirm",
          options: [{ label: "Yes" }, { label: "No" }],
        })}
        answers={{ flag: "Yes" }}
        sent
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    expect(document.querySelector(".ask-band.is-done")).toBeTruthy();
    // The reply is a message the user sent, so it renders as a user bubble on
    // the right, with the same shimmer as the "ideal?" hook.
    const bubble = document.querySelector(".ask-answered-bubble");
    expect(bubble).toBeTruthy();
    expect(bubble?.classList.contains("user-msg")).toBe(true);
    expect(bubble?.querySelector(".shimmer-text")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
    expect(screen.getByText("Yes")).toBeTruthy();
  });

  it("closes the band when the run ended before an answer", () => {
    render(
      <AskBand
        prompt={prompt({
          id: "flag",
          question: "Flip the flag?",
          kind: "confirm",
          options: [{ label: "Yes" }, { label: "No" }],
        })}
        cancelled
        onAnswer={vi.fn()}
        onTypeInstead={onTypeInstead}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/no longer needs an answer/)).toBeTruthy();
  });

  it("stays answerable after the deadline, with one line saying the agent moved on", () => {
    const onAnswer = vi.fn();
    const band = (deferred: boolean): React.ReactElement => (
      <AskBand
        prompt={prompt({
          id: "flag",
          question: "Flip the flag?",
          kind: "confirm",
          options: [{ label: "Yes" }, { label: "No" }],
        })}
        deferred={deferred}
        onAnswer={onAnswer}
        onTypeInstead={onTypeInstead}
      />
    );
    const { rerender } = render(band(false));
    expect(screen.queryByText(/best guess/)).toBeNull();
    rerender(band(true));
    expect(screen.getByRole("status").textContent).toBe(
      "Agent continued with its best guess — your answer will still be sent",
    );
    fireEvent.click(screen.getByRole("button", { name: /Yes/ }));
    expect(onAnswer).toHaveBeenCalledWith({ flag: "Yes" });
  });
});

describe("markAskDeferred / closeAsks", () => {
  type Row = {
    kind: string;
    id: string;
    prompt?: AskUserPrompt;
    sent?: boolean;
    deferred?: boolean;
    cancelled?: boolean;
  };
  const withId = (id: string, extra: { sent?: boolean } = {}): Row => ({
    kind: "ask",
    id: `row-${id}`,
    prompt: { id, questions: [] },
    ...extra,
  });

  it("flags only the matching open question as deferred", () => {
    const items = [withId("a"), withId("b"), withId("a", { sent: true })];
    const out = markAskDeferred(items, "a");
    expect(out.map((it) => it.deferred === true)).toEqual([true, false, false]);
  });

  it("closes the listed open questions and nothing else", () => {
    const items: Row[] = [withId("a"), withId("b"), { kind: "user", id: "u" }];
    const out = closeAsks(items, ["a"]);
    expect(out.map((it) => it.cancelled === true)).toEqual([true, false, false]);
  });
});

describe("mergeAskAnswers", () => {
  const questions: AskQuestion[] = [
    { id: "a", question: "A?", kind: "confirm" },
    { id: "b", question: "B?", kind: "confirm" },
  ];

  it("stays incomplete until every question in the band has an answer", () => {
    const first = mergeAskAnswers(undefined, { a: "yes" }, questions);
    expect(first).toEqual({ answers: { a: "yes" }, complete: false });
    // Only now may the parked tool call settle — a half-filled form never lands.
    expect(mergeAskAnswers(first.answers, { b: "no" }, questions)).toEqual({
      answers: { a: "yes", b: "no" },
      complete: true,
    });
  });

  it("lets a later answer replace an earlier one for the same question", () => {
    const merged = mergeAskAnswers({ a: "yes" }, { a: "no" }, [questions[0]!]);
    expect(merged).toEqual({ answers: { a: "no" }, complete: true });
  });

  it("treats a multi-select array as one answer", () => {
    expect(mergeAskAnswers(undefined, { a: ["x", "y"] }, [questions[0]!])).toEqual({
      answers: { a: ["x", "y"] },
      complete: true,
    });
  });
});

// What a send does to the transcript. The sidecar releases the parked tool call
// as soon as the prompt lands, so a still-open band is unanswerable from that
// moment on and must not stay on screen offering buttons that reach nobody.
describe("dropSupersededAsks", () => {
  const band = (
    id: number,
    extra: Partial<{ sent: boolean; cancelled: boolean }> = {},
  ): { kind: string; id: number; sent?: boolean; cancelled?: boolean } => ({
    kind: "ask",
    id,
    ...extra,
  });

  it("drops an unanswered band when the user sends a prompt instead", () => {
    expect(dropSupersededAsks([band(1)])).toEqual([]);
  });

  it("keeps answered and cancelled bands — they are history, not live questions", () => {
    const items = [band(1, { sent: true }), band(2, { cancelled: true }), band(3)];
    expect(dropSupersededAsks(items)).toEqual([
      band(1, { sent: true }),
      band(2, { cancelled: true }),
    ]);
  });

  it("leaves every other transcript row untouched", () => {
    const items = [band(1), { kind: "user", id: 2 }, { kind: "assistant", id: 3 }];
    expect(dropSupersededAsks(items)).toEqual([
      { kind: "user", id: 2 },
      { kind: "assistant", id: 3 },
    ]);
  });
});
