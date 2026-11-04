// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { focusesComposerOnOpen, refocusesComposer } from "./composer-refocus";

/** Put the chat box on screen, plus whatever else a case needs. */
function showComposer(extra = ""): HTMLTextAreaElement {
  document.body.innerHTML = `<textarea id="composer"></textarea>${extra}`;
  const input = document.getElementById("composer");
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("composer missing");
  return input;
}

function focus(selector: string | null): void {
  if (!selector) return;
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) throw new Error(`${selector} missing`);
  el.focus();
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

describe("refocusesComposer on the desktop", () => {
  it.each([
    { when: "nothing else has focus", extra: "", focused: null, expected: true },
    { when: "the chat box already has focus", extra: "", focused: "#composer", expected: true },
    {
      when: "a button has focus",
      extra: "<button>Menu</button>",
      focused: "button",
      expected: false,
    },
    {
      when: "another field has focus",
      extra: "<input id='other' />",
      focused: "#other",
      expected: false,
    },
    {
      when: "a dialog is open",
      extra: "<div class='modal-backdrop'></div>",
      focused: null,
      expected: false,
    },
    {
      when: "the checklist hides the chat box",
      extra: "<section data-hides-composer></section>",
      focused: null,
      expected: false,
    },
  ])("$when → $expected", ({ extra, focused, expected }) => {
    const input = showComposer(extra);
    focus(focused);

    expect(refocusesComposer(document, input)).toBe(expected);
  });

  it("leaves a text selection alone", () => {
    const input = showComposer("<p id='said'>the agent said this</p>");
    const range = document.createRange();
    const said = document.getElementById("said");
    if (!said) throw new Error("text missing");
    range.selectNodeContents(said);
    document.getSelection()?.addRange(range);

    expect(refocusesComposer(document, input)).toBe(false);
  });
});

describe("refocusesComposer on iPhone", () => {
  it("never moves the cursor to the chat box, which would raise the keyboard", () => {
    document.documentElement.classList.add("platform-ios");
    const input = showComposer();

    expect(refocusesComposer(document, input)).toBe(false);
  });
});

describe("focusesComposerOnOpen", () => {
  it("puts the cursor in the chat box when a chat opens on the desktop", () => {
    expect(focusesComposerOnOpen(document)).toBe(true);
  });

  it("leaves the keyboard down when a chat opens on iPhone", () => {
    document.documentElement.classList.add("platform-ios");

    expect(focusesComposerOnOpen(document)).toBe(false);
  });
});
