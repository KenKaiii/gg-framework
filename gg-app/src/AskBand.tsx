import { useEffect, useRef, useState } from "react";
import { Badge } from "./Badge";
import { theme } from "./theme";
import { allowsText, type AskOption, type AskQuestion, type AskUserPrompt } from "./ask-user";

/**
 * The in-thread question band (design-lab: ask-band-resolved.html).
 *
 * Sits inside the reply, full-bleed and tinted, so it scrolls with history and
 * owns no app chrome. Every question looks the same: one stack of full-width
 * option rows, whatever its kind. A yes/no confirm laid out as inline chips
 * read as a different component from a choice laid out as rows, so the chip
 * layout is gone — there is one shape, and two questions cannot disagree.
 *
 * The band is free of chrome too. It offers options and nothing else: no
 * "Something else" link, no send button, no counter. Typing any character still
 * routes to the composer (that is the free-text path, and it never needed a
 * button of its own), and answering the last open question commits the band.
 *
 * Until then every pick stays on screen as a filled row, so an answer given
 * early can still be changed while the rest are being decided.
 */

const Check = (): React.ReactElement => (
  <svg
    className="ask-check"
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const valueOf = (option: AskOption): string => option.value ?? option.label;

type Answers = Record<string, string | string[]>;

/**
 * An answered question, collapsed. Reuses the transcript's shimmer label (the
 * same treatment as the "ideal?" hook) so a resolved ask reads as one of the
 * app's own quiet status lines rather than a green form-validation tick.
 */
function AnsweredLine({ text }: { text: string }): React.ReactElement {
  return (
    <div className="ask-answered" aria-live="polite">
      <span className="user-msg ask-answered-bubble">
        <span className="shimmer-text">{text}</span>
      </span>
    </div>
  );
}

/** One question: a heading and its stack of option rows. */
function Question({
  question,
  index,
  numbered,
  answer,
  onAnswer,
  onTypeInstead,
}: {
  question: AskQuestion;
  /** 1-based accelerator offset across the whole band (0 = not accelerated). */
  index: number;
  numbered: boolean;
  answer: string | string[] | undefined;
  onAnswer: (value: string | string[]) => void;
  onTypeInstead: () => void;
}): React.ReactElement {
  const options = question.options ?? [];
  const multi = question.kind === "multi";
  const [draft, setDraft] = useState<string[]>();

  // A question that asks for information (a URL, a name) has nothing to click:
  // it gets its own field right under the question, so the answer is typed
  // where it's asked. It used to hand off to the chat composer, which in a
  // card of several questions left the user looking for where to type.
  const isText = question.kind === "text";
  const saved = typeof answer === "string" ? answer : "";
  // null until the user types, so a saved answer (from history, or given
  // already) shows in the field without being copied into local state.
  const [typedDraft, setTypedDraft] = useState<string | null>(null);
  const shown = typedDraft ?? saved;
  const submitTyped = (): void => {
    const value = shown.trim();
    if (value && value !== saved) onAnswer(value);
  };

  // A multi-select parks its picks locally: "two of these three" is not an
  // answer until the user says they are done, and nothing else in the band can
  // tell a half-made selection from a finished one. Every other kind answers on
  // the click itself, so its selection IS `answer`.
  //
  // `draft` starts undefined and only exists once the user touches a checkbox,
  // so an already-answered multi (restored from history, or re-rendered while
  // its neighbours are still open) shows the committed picks rather than an
  // empty list.
  const committed = Array.isArray(answer) ? answer : answer === undefined ? [] : [answer];
  const picked = multi ? (draft ?? committed) : committed;
  const isOn = (value: string): boolean => (multi ? picked.includes(value) : answer === value);
  const toggle = (value: string): void => {
    const next = picked.includes(value) ? picked.filter((v) => v !== value) : [...picked, value];
    setDraft(next);
    // Already confirmed once: keep the committed answer in step with what is on
    // screen, or a later question's answer would commit the band with the stale
    // selection while the rows show the new one.
    if (answer !== undefined && next.length > 0) onAnswer(next);
  };

  // Every option is the app's standard pill: ghost by default, primary only
  // when it is actually selected. The recommendation is marked with the shared
  // .badge, so color stays a data signal instead of decoration.
  const optionButton = (option: AskOption, position: number): React.ReactElement => {
    const value = valueOf(option);
    const on = isOn(value);
    const index = position <= 9 ? <span className="ask-num">{position}</span> : null;
    // Green: the recommendation is the one affirmative signal in the list, and
    // a neutral pill was indistinguishable from the row's own raised fill. On a
    // selected pill it switches to the fill's own ink — light green on the
    // periwinkle fill measures ~1.3:1, which is not a readable badge.
    const tag = option.recommended ? (
      <Badge color={on ? theme.onPrimary : theme.success}>Recommended</Badge>
    ) : null;
    return (
      <button
        key={option.label}
        type="button"
        className={`btn btn-sm ${on ? "btn-primary" : "btn-ghost"}`}
        aria-pressed={on}
        {...(multi ? {} : { "data-ask-option": true })}
        onClick={() => (multi ? toggle(value) : onAnswer(value))}
      >
        {multi ? on && <Check /> : index}
        {option.hint ? (
          <span className="ask-row-main">
            <span>{option.label}</span>
            <span className="ask-row-hint">{option.hint}</span>
          </span>
        ) : (
          <span>{option.label}</span>
        )}
        {tag}
      </button>
    );
  };

  // A typed answer matches no option, so it gets a row of its own rather than
  // leaving the question looking untouched. Pressing it reopens the composer,
  // which is also the only way back out of one.

  const typed =
    !isText &&
    typeof answer === "string" &&
    !options.some((option) => valueOf(option) === answer) ? (
      <button
        type="button"
        className="btn btn-sm btn-primary"
        aria-pressed="true"
        onClick={onTypeInstead}
      >
        <span>{answer}</span>
      </button>
    ) : null;

  return (
    <div
      className="ask-subq"
      data-ask-question={question.id}
      {...(answer !== undefined ? { "data-ask-answered": true } : {})}
    >
      <p className="ask-subq-q">
        {numbered && <span className="ask-subq-num">{index}</span>}
        {question.question}
      </p>
      {question.detail && <p className="ask-detail">{question.detail}</p>}
      {/* `typed` is checked too: a `text` question carries no options at all, so
          guarding on options alone left it showing nothing but its heading once
          answered. */}
      {(options.length > 0 || typed) && (
        <div className="ask-options" role="group" aria-label={question.question}>
          {options.map((option, i) => optionButton(option, i + 1))}
          {typed}
        </div>
      )}
      {isText && (
        <form
          className="ask-text"
          onSubmit={(e) => {
            e.preventDefault();
            submitTyped();
          }}
        >
          <input
            className="modal-input ask-text-input"
            aria-label={question.question}
            placeholder="Type your answer"
            value={shown}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTypedDraft(e.target.value)}
            // Typing here belongs to this field, not the band's number keys.
            onKeyDown={(e) => e.stopPropagation()}
          />
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={!shown.trim() || shown.trim() === saved}
          >
            {saved && shown.trim() === saved ? "Answered" : "Answer"}
          </button>
        </form>
      )}
      {/* The one control the band keeps. A multi-select is the only kind whose
          selection cannot commit itself: "Tests and Build" and "Tests, so far"
          look identical, so something has to mark the end of picking. Every
          other kind commits on the option click and needs no button. */}
      {multi && (
        <div className="ask-foot">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={picked.length === 0}
            onClick={() => onAnswer(picked)}
          >
            {picked.length === 0 ? "Choose at least one" : `Confirm ${picked.length} selected`}
          </button>
        </div>
      )}
    </div>
  );
}

export function AskBand({
  prompt,
  answers = {},
  sent,
  cancelled,
  deferred,
  onAnswer,
  onTypeInstead,
}: {
  prompt: AskUserPrompt;
  /**
   * Answers so far, owned by App. The band is deliberately controlled: a typed
   * answer arrives from the composer, outside this component, so local state
   * here would fork from the real one.
   */
  answers?: Answers;
  /** The answers have been sent to the blocked tool call — collapse the band. */
  sent?: boolean;
  /** The run ended without an answer — the question is dead, say so quietly. */
  cancelled?: boolean;
  /**
   * The soft deadline passed and the agent continued on its best guess. The
   * band stays fully answerable — a later answer is sent as a message.
   */
  deferred?: boolean;
  /** Report answered questions. App merges, then settles once none are left. */
  onAnswer: (delta: Answers) => void;
  /** The user wants to write their own answer: focus the composer, seeded. */
  onTypeInstead: (questionId: string, seed?: string) => void;
}): React.ReactElement {
  const bandRef = useRef<HTMLDivElement | null>(null);
  const questions = prompt.questions;
  const done = sent === true;

  // Number accelerators + type-to-open. Both are deliberately inert while the
  // user is typing anywhere else (the composer is a focused textarea), so the
  // band never steals a keystroke meant for the prompt box.
  useEffect(() => {
    if (done || cancelled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // The target is the document itself when nothing is focused, so this
      // cannot assume an Element.
      const target = e.target;
      // The app keeps the composer focused, so an EMPTY composer still lets
      // the number keys pick (live: "Press 1–2 to choose" never worked).
      // Once anything is typed there, digits are part of the message.
      const emptyComposer =
        target instanceof HTMLTextAreaElement &&
        target.hasAttribute("data-composer-input") &&
        target.value === "";
      if (
        target instanceof Element &&
        target.closest("input, textarea, [contenteditable='true']") &&
        !(emptyComposer && /^[1-9]$/.test(e.key))
      ) {
        return;
      }
      const band = bandRef.current;
      if (!band) return;
      // The first still-UNANSWERED question owns the keyboard: in a form every
      // question stays on screen after it is answered, so plain
      // `[data-ask-question]` would keep aiming the number keys at the first
      // one the user already settled.
      const open = band.querySelector<HTMLElement>("[data-ask-question]:not([data-ask-answered])");
      if (!open) return;
      if (/^[1-9]$/.test(e.key)) {
        const options = open.querySelectorAll<HTMLButtonElement>("[data-ask-option]");
        const button = options[Number(e.key) - 1];
        if (button) {
          e.preventDefault();
          button.click();
        }
        return;
      }
      // Any printed character means they want to write their own answer: send
      // them to the composer they already type in, carrying the keystroke,
      // rather than opening a second input inside the transcript. With the
      // "Something else" button gone this is the whole free-text path, so it has
      // to honour the opt-out the button used to enforce.
      if (e.key.length === 1 && e.key !== " ") {
        const id = open.dataset.askQuestion;
        const question = questions.find((q) => q.id === id);
        if (id && question && allowsText(question)) {
          e.preventDefault();
          onTypeInstead(id, e.key);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [done, cancelled, onTypeInstead, questions]);

  if (cancelled && !done) {
    return (
      <div className="ask-band is-closed">
        <span className="ask-closed">
          This question was cancelled, so it no longer needs an answer.
        </span>
      </div>
    );
  }

  if (done) {
    const text = questions
      .map((q) => {
        const value = answers[q.id];
        return Array.isArray(value) ? value.join(", ") : value;
      })
      .filter(Boolean)
      .join(" · ");
    return (
      <div className="ask-band is-done">
        <AnsweredLine text={text} />
      </div>
    );
  }

  // Several questions are numbered so the accelerator keys have something to
  // refer to; a lone question needs no "1.".
  const numbered = questions.length > 1;

  return (
    <div className="ask-band" ref={bandRef} role="group" aria-label="Kleio needs your answer">
      {/* A status note about the run, set apart from the question below it. */}
      {deferred && (
        <p role="status">Agent continued with its best guess — your answer will still be sent</p>
      )}
      {questions.map((q, i) => (
        <Question
          key={q.id}
          question={q}
          index={i + 1}
          numbered={numbered}
          answer={answers[q.id]}
          onAnswer={(value) => onAnswer({ [q.id]: value })}
          onTypeInstead={() => onTypeInstead(q.id)}
        />
      ))}
    </div>
  );
}
