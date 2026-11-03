import type { Dispatch, SetStateAction, RefObject } from "react";
import { type PromptSegment, enhancePrompt } from "./agent";
import { toast } from "./toast";

export function usePromptEnhance({
  input,
  setInput,
  setEnhancement,
  enhancing,
  setEnhancing,
  setEnhanceHintVisible,
  setEnhanceAnim,
  pendingEnhanceRef,
  inputRef,
}: {
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  setEnhancement: Dispatch<SetStateAction<{ plain: string; segments: PromptSegment[] } | null>>;
  enhancing: boolean;
  setEnhancing: Dispatch<SetStateAction<boolean>>;
  setEnhanceHintVisible: Dispatch<SetStateAction<boolean>>;
  setEnhanceAnim: Dispatch<SetStateAction<{ oldText: string; newText: string | null } | null>>;
  pendingEnhanceRef: RefObject<{ enhanced: string; segments: PromptSegment[] } | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  // Apply a finished enhancement to the input: fill the textarea with the plain
  // text, stash the highlighted segments (drives the inline highlight overlay +
  // sent bubble), and park the caret at the end.
  function applyEnhanceResult(r: { enhanced: string; segments: PromptSegment[] }): void {
    setInput(r.enhanced);
    setEnhancement({ plain: r.enhanced, segments: r.segments });
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    });
  }

  // Run the prompt enhancer: rewrite the current draft via the active model into
  // a tighter, terminology-correct prompt. The result plays in over the input as
  // a Matrix dissolve→decode animation (unless reduced-motion), then fills it.
  async function runEnhance(): Promise<void> {
    const draft = input.trim();
    if (!draft || enhancing) return;
    setEnhanceHintVisible(false);
    setEnhancing(true);

    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced) {
      try {
        applyEnhanceResult(await enhancePrompt(draft));
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "error");
      } finally {
        setEnhancing(false);
      }
      return;
    }

    // Start the dissolve immediately (newText null), then flip to decode when the
    // enhancer returns. applyEnhanceResult + cleanup run in the animation's
    // onDone so the text never pops in before the decode settles.
    setEnhanceAnim({ oldText: draft, newText: null });
    try {
      const r = await enhancePrompt(draft);
      pendingEnhanceRef.current = r;
      setEnhanceAnim((a) => (a ? { ...a, newText: r.enhanced } : null));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      setEnhanceAnim(null);
      setEnhancing(false);
    }
  }

  // The dissolve→decode animation finished: hand off to the real input WITHOUT a
  // flash. The decoded text lives in the .enh-diss overlay (on top); the textarea
  // sits hidden beneath it (.input-anim). If we removed the overlay and filled
  // the textarea in the same commit, you'd see the overlay text vanish and the
  // textarea text reflow/resize a frame later. So: fill the textarea FIRST (still
  // hidden under the overlay) and let useLayoutEffect size it, THEN drop the
  // overlay on the next frame — the sized text is already in place underneath.
  function onEnhanceAnimDone(): void {
    const r = pendingEnhanceRef.current;
    pendingEnhanceRef.current = null;
    if (r) {
      setInput(r.enhanced);
      setEnhancement({ plain: r.enhanced, segments: r.segments });
    }
    requestAnimationFrame(() => {
      setEnhanceAnim(null);
      setEnhancing(false);
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    });
  }
  return { runEnhance, onEnhanceAnimDone };
}
