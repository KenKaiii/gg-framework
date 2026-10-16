import { useEffect } from "react";
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { enhancePrompt, type PromptSegment } from "./agent";
import type { DraftEnhancement } from "./PromptEnhancement";
import { toast } from "./toast";

type Enhancement = DraftEnhancement | null;
type EnhanceAnim = { oldText: string; newText: string | null } | null;

/**
 * Prompt enhancer: run, dissolve→decode animation hand-off, and the Enhance
 * pill visibility effect. App owns the state; handlers are rebuilt each render.
 * Extracted from App.tsx.
 */
export function usePromptEnhance({
  input,
  setInput,
  inputRef,
  enhancing,
  setEnhancing,
  setEnhanceHintVisible,
  setEnhanceAnim,
  pendingEnhanceRef,
  enhancement,
  setEnhancement,
  hydrated,
  slashOpen,
  mentionOpen,
  scheduleDraft,
}: {
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  enhancing: boolean;
  setEnhancing: Dispatch<SetStateAction<boolean>>;
  setEnhanceHintVisible: Dispatch<SetStateAction<boolean>>;
  setEnhanceAnim: Dispatch<SetStateAction<EnhanceAnim>>;
  pendingEnhanceRef: MutableRefObject<{ enhanced: string; segments: PromptSegment[] } | null>;
  enhancement: Enhancement;
  setEnhancement: Dispatch<SetStateAction<Enhancement>>;
  hydrated: boolean;
  slashOpen: boolean;
  mentionOpen: boolean;
  scheduleDraft: boolean;
}) {
  // Apply a finished enhancement to the input: fill the textarea with the plain
  // text, stash the highlighted segments (drives the inline highlight overlay +
  // sent bubble), and park the caret at the end.
  function applyEnhanceResult(r: { enhanced: string; segments: PromptSegment[] }): void {
    setInput(r.enhanced);
    setEnhancement({ enhanced: r.enhanced, plain: r.enhanced, segments: r.segments });
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
      setEnhancement({ enhanced: r.enhanced, plain: r.enhanced, segments: r.segments });
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

  // Show the corner "Enhance" pill whenever the input holds text — it stays put
  // (no debounce) and only hides when the box is empty. Shows even while the agent
  // is running, so a queued follow-up draft can be enhanced too: enhancePrompt is
  // a standalone one-shot call, independent of the agent loop. Still skipped mid-
  // enhance, with a menu open, or when the draft is already the current
  // enhancement (nothing left to improve).
  useEffect(() => {
    if (enhancing || !hydrated) return setEnhanceHintVisible(false);
    if (input.trim().length === 0) return setEnhanceHintVisible(false);
    if (slashOpen || mentionOpen) return setEnhanceHintVisible(false);
    // Never offer to rewrite a `/schedule` draft: the enhancer rewrites prose
    // and would happily mangle the `| 15m` argument tail into something the
    // parser rejects.
    if (scheduleDraft) return setEnhanceHintVisible(false);
    if (enhancement && enhancement.enhanced === input) return setEnhanceHintVisible(false);
    setEnhanceHintVisible(true);
  }, [
    input,
    enhancing,
    hydrated,
    slashOpen,
    mentionOpen,
    scheduleDraft,
    enhancement,
    setEnhanceHintVisible,
  ]);

  return { runEnhance, onEnhanceAnimDone };
}
