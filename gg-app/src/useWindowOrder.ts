import { useState, useEffect, type RefObject } from "react";
import { onWindowOrder, windowLabel } from "./agent";
import { refocusesComposer } from "./composer-refocus";
import { playSound } from "./sounds";

export function useWindowOrder(inputRef: RefObject<HTMLTextAreaElement | null>) {
  // Position in the multi-window reading order (e.g. window 2 of 4), plus
  // whether this window is the focused one. Driven by the Rust `window-order`
  // broadcast so the label updates automatically when windows move/close.
  const [windowIndex, setWindowIndex] = useState<number | null>(null);
  const [windowTotal, setWindowTotal] = useState(1);
  const [isThisFocused, setIsThisFocused] = useState(true);

  // Focus the chat input whenever this window gains focus (or clicked anywhere),
  // so switching between project windows lands the cursor in the input without
  // a second click. Skips when the user is selecting text or focused elsewhere
  // intentionally (e.g. a menu button), and always on iPhone (composer-refocus.ts).
  useEffect(() => {
    const focusInput = (): void => {
      // Nor into a composer that isn't on screen (a goal's Workers view hides
      // the chat): keys would go into a box nobody can see, and macOS draws its
      // caret marker where the box was. Hidden (display: none anywhere above
      // it) means it has no boxes.
      const input = inputRef.current;
      if (!input || input.getClientRects().length === 0) return;
      if (refocusesComposer(document, input)) input.focus();
    };
    window.addEventListener("focus", focusInput);
    window.addEventListener("mouseup", focusInput);
    return () => {
      window.removeEventListener("focus", focusInput);
      window.removeEventListener("mouseup", focusInput);
    };
  }, [inputRef]);

  // Subscribe to the reading-order broadcast from Rust so each window knows its
  // position (e.g. "1/4") and whether it's focused. Updates automatically when
  // windows are arranged, moved (debounced), created, closed, or focused.
  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    void onWindowOrder((e) => {
      const idx = e.order.indexOf(windowLabel);
      setWindowIndex(idx >= 0 ? idx + 1 : null);
      setWindowTotal(e.order.length);
      setIsThisFocused(e.focused === windowLabel);
    }).then((fn) => {
      // Unmounted before listen() resolved: drop the listener at once.
      if (disposed) fn();
      else un = fn;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  // Global UI click sound — plays only when an actual interactive element is
  // clicked (buttons, links, role=button, options, labels), never bare
  // background/text. Capture phase so it fires even when a handler stops
  // propagation; left button only.
  useEffect(() => {
    const INTERACTIVE = "button, a, [role='button'], [role='option'], label, summary, select";
    const onClick = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      const target = e.target as Element | null;
      const el = target?.closest?.(INTERACTIVE);
      if (!el) return;
      if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return;
      // The autopilot toggle plays its own dedicated sound (only when turning
      // on) instead of the generic click, so skip it here to avoid a double cue.
      if (el.closest("[data-suppress-click-sound]")) return;
      playSound("click");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return { windowIndex, windowTotal, isThisFocused };
}
