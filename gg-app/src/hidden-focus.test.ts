// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { dropHiddenFocus } from "./hidden-focus";

/** A focused textarea; `shown` stands in for layout (jsdom has none). */
function focusedBox(shown: boolean): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  document.body.append(el);
  const rects = shown ? [new DOMRect(0, 0, 100, 20)] : [];
  vi.spyOn(el, "getClientRects").mockReturnValue(
    Object.assign(rects, { item: (i: number) => rects[i] ?? null }) as unknown as DOMRectList,
  );
  el.focus();
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("dropHiddenFocus", () => {
  it("takes focus off a box that's no longer on screen", () => {
    // Live bug: the composer autofocused, the Workers view hid it, and macOS
    // drew its caret marker over the farm.
    focusedBox(false);
    dropHiddenFocus();
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves a box on screen alone", () => {
    const el = focusedBox(true);
    dropHiddenFocus();
    expect(document.activeElement).toBe(el);
  });
});
