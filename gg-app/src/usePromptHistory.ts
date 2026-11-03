import type { Dispatch, SetStateAction, RefObject } from "react";

export function usePromptHistory({
  setInput,
  promptHistoryRef,
  historyIndex,
  setHistoryIndex,
  historyDraftRef,
  inputRef,
}: {
  setInput: Dispatch<SetStateAction<string>>;
  promptHistoryRef: RefObject<string[]>;
  historyIndex: number | null;
  setHistoryIndex: Dispatch<SetStateAction<number | null>>;
  historyDraftRef: RefObject<string>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  // Record a sent prompt for ↑/↓ recall (skips consecutive duplicates, capped).
  function recordHistory(text: string): void {
    const h = promptHistoryRef.current;
    if (text && h[h.length - 1] !== text) h.push(text);
    if (h.length > 200) h.shift();
    setHistoryIndex(null);
    historyDraftRef.current = "";
  }

  // Replace the input with a recalled history entry and park the caret at the end.
  function applyHistory(text: string): void {
    setInput(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.selectionStart = el.selectionEnd = el.value.length;
    });
  }

  // Walk prompt history with ↑ (dir -1, older) / ↓ (dir +1, newer). Returns true
  // when it consumed the key. Only triggers when the caret is on the first line
  // (↑) or last line (↓) so multi-line editing still moves the cursor normally.
  function navigateHistory(dir: -1 | 1, el: HTMLTextAreaElement): boolean {
    const hist = promptHistoryRef.current;
    if (hist.length === 0) return false;
    const collapsed = el.selectionStart === el.selectionEnd;
    const caret = el.selectionStart ?? 0;
    if (dir === -1) {
      const onFirstLine = collapsed && !el.value.slice(0, caret).includes("\n");
      if (!onFirstLine) return false;
      if (historyIndex === null) {
        historyDraftRef.current = el.value;
        const idx = hist.length - 1;
        setHistoryIndex(idx);
        applyHistory(hist[idx]);
      } else if (historyIndex > 0) {
        const idx = historyIndex - 1;
        setHistoryIndex(idx);
        applyHistory(hist[idx]);
      }
      return true; // consume even at the oldest entry
    }
    if (historyIndex === null) return false; // not navigating — let ↓ move the caret
    const onLastLine = collapsed && !el.value.slice(caret).includes("\n");
    if (!onLastLine) return false;
    if (historyIndex < hist.length - 1) {
      const idx = historyIndex + 1;
      setHistoryIndex(idx);
      applyHistory(hist[idx]);
    } else {
      setHistoryIndex(null);
      applyHistory(historyDraftRef.current);
    }
    return true;
  }
  return { recordHistory, navigateHistory };
}
