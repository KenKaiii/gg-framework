import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DISPLAY_ITEM_CUSTOM_KIND, type SessionManager } from "../../core/session-manager.js";
import { compactHistory } from "../item-helpers.js";
import { trimFlushedItems } from "../live-item-flush.js";
import type { CompletedItem } from "../app-items.js";
import type { TerminalHistoryContext } from "../terminal-history.js";

interface TranscriptHistoryItem {
  id: string;
  kind: string;
}

interface SessionStoreLike<TItem extends TranscriptHistoryItem> {
  history?: TItem[];
  liveItems?: TItem[];
}

interface TranscriptHistoryPrinter<TItem extends TranscriptHistoryItem> {
  print(
    items: readonly TItem[],
    context: TerminalHistoryContext,
    options?: { force?: boolean; write?: (data: string) => void },
  ): void;
  clear(): void;
}

interface UseTranscriptHistoryOptions<TItem extends TranscriptHistoryItem> {
  terminalHistoryPrinter?: TranscriptHistoryPrinter<TItem>;
  terminalHistoryContext: TerminalHistoryContext;
  writeStdout: (data: string) => void;
  /**
   * Atomic scrollback enqueue (patched Ink `insertBeforeFrame`). Bytes passed
   * here are NOT written immediately — they are folded into the next Ink frame
   * write, so the live-frame shrink and the scrollback insert reach the
   * terminal in ONE write and the footer never jumps. Falls back to
   * `writeStdout` (erase frame → write → restore frame) when absent.
   */
  enqueueStdout?: (data: string) => void;
  sessionPathRef: React.RefObject<string | undefined>;
  sessionManagerRef: React.RefObject<SessionManager | null>;
  sessionStore?: SessionStoreLike<TItem>;
  history: readonly TItem[];
  setHistory: React.Dispatch<React.SetStateAction<TItem[]>>;
  setLiveItems: React.Dispatch<React.SetStateAction<TItem[]>>;
  compactHistoryItems?: (items: TItem[]) => TItem[];
  persistDisplayItem?: (item: TItem) => unknown;
  trimFlushItems?: (items: TItem[]) => TItem[];
}

export interface UseTranscriptHistoryResult<TItem extends TranscriptHistoryItem> {
  pendingHistoryFlushRef: React.RefObject<TItem[]>;
  streamedAssistantFlushRef: React.RefObject<{ flushedChars: number; text: string }>;
  printHistoryItems: (items: readonly TItem[], options?: { force?: boolean }) => void;
  queueFlush: (items: TItem[]) => void;
  finalizeSubmittedUserItem: (item: TItem, deferredLiveItems?: readonly TItem[]) => void;
  clearPendingHistory: () => void;
}

export function useTranscriptHistory<TItem extends TranscriptHistoryItem = CompletedItem>({
  terminalHistoryPrinter,
  terminalHistoryContext,
  writeStdout,
  enqueueStdout,
  sessionPathRef,
  sessionManagerRef,
  sessionStore,
  history,
  setHistory,
  setLiveItems,
  compactHistoryItems = (items) => compactHistory(items as CompletedItem[]) as TItem[],
  persistDisplayItem,
  trimFlushItems = (items) => trimFlushedItems(items as CompletedItem[]) as TItem[],
}: UseTranscriptHistoryOptions<TItem>): UseTranscriptHistoryResult<TItem> {
  const terminalHistoryContextRef = useRef<TerminalHistoryContext>(terminalHistoryContext);
  const pendingHistoryFlushRef = useRef<TItem[]>([]);
  const drainedHistoryFlushRef = useRef<TItem[]>([]);
  const persistedDisplayItemIdsRef = useRef<Set<string>>(new Set());
  const streamedAssistantFlushRef = useRef<{ flushedChars: number; text: string }>({
    flushedChars: 0,
    text: "",
  });
  const [historyFlushGeneration, setHistoryFlushGeneration] = useState(0);

  useEffect(() => {
    terminalHistoryContextRef.current = terminalHistoryContext;
  }, [terminalHistoryContext]);

  const printHistoryItems = useCallback(
    (items: readonly TItem[], options?: { force?: boolean }) => {
      if (!terminalHistoryPrinter || items.length === 0) return;
      terminalHistoryPrinter.print(items, terminalHistoryContextRef.current, {
        ...options,
        write: enqueueStdout ?? writeStdout,
      });
    },
    [enqueueStdout, terminalHistoryPrinter, writeStdout],
  );

  const queueFlush = useCallback(
    (items: TItem[]) => {
      const flushed = trimFlushItems(items);
      if (flushed.length === 0) return;
      pendingHistoryFlushRef.current = [...pendingHistoryFlushRef.current, ...flushed];
      // Render the rows to ANSI and enqueue the bytes NOW, before any state
      // update. With the patched `insertBeforeFrame` the enqueue is passive (no
      // terminal write), so the bytes ride the very next frame write — the one
      // produced by the batched setLiveItems/generation updates below, which is
      // also the write that shrinks the live frame. One write = no footer jump.
      printHistoryItems(flushed);
      const sessionPath = sessionPathRef.current;
      const sessionManager = sessionManagerRef.current;
      if (sessionPath && sessionManager) {
        for (const item of flushed) {
          if (persistedDisplayItemIdsRef.current.has(item.id)) continue;
          persistedDisplayItemIdsRef.current.add(item.id);
          void sessionManager.appendEntry(sessionPath, {
            type: "custom",
            kind: DISPLAY_ITEM_CUSTOM_KIND,
            data: { version: 1, item: persistDisplayItem ? persistDisplayItem(item) : item },
            id: `display-${item.id}`,
            parentId: null,
            timestamp: new Date().toISOString(),
          });
        }
      }
      if (sessionStore) {
        const queuedIds = new Set(items.map((item) => item.id));
        sessionStore.liveItems = (sessionStore.liveItems ?? []).filter(
          (item) => !queuedIds.has(item.id),
        );
        // Mirror the flushed rows into sessionStore.history SYNCHRONOUSLY.
        // The React-state fold-in below is deferred to effects, but the
        // patched ink's bottom-pinned repaint (slash menu close) can fire on
        // THIS very commit — e.g. submit finalizes deferred assistant rows +
        // the user prompt while the menu close shrinks the frame. Its
        // backfill serializes sessionStore.history; if these rows aren't in
        // it yet, the repaint redraws a stale screen and the just-finalized
        // messages visibly vanish into blank space.
        const knownIds = new Set((sessionStore.history ?? []).map((item) => item.id));
        const newItems = flushed.filter((item) => !knownIds.has(item.id));
        if (newItems.length > 0) {
          sessionStore.history = compactHistoryItems([
            ...(sessionStore.history ?? []),
            ...newItems,
          ]);
        }
      }
      // Remove the flushed rows from the live frame in the SAME React batch as
      // the generation bump. Ink emits one frame write per commit (throttled,
      // leading edge), so deferring this shrink to a later effect would split
      // enqueue and shrink across two writes — the second one (shrink without
      // compensating scrollback bytes) is exactly what strands the footer.
      const flushedIds = new Set(flushed.map((item) => item.id));
      setLiveItems((prev) => prev.filter((item) => !flushedIds.has(item.id)));
      setHistoryFlushGeneration((generation) => generation + 1);
    },
    [
      compactHistoryItems,
      persistDisplayItem,
      printHistoryItems,
      sessionManagerRef,
      sessionPathRef,
      sessionStore,
      setLiveItems,
      trimFlushItems,
    ],
  );

  useEffect(() => {
    printHistoryItems(history);
  }, [history, printHistoryItems]);

  useLayoutEffect(() => {
    // Printing and live-row removal already happened synchronously inside
    // queueFlush (they must batch into the commit that carries the enqueued
    // scrollback bytes). This effect only moves the queue along so the
    // follow-up effect below can fold the flushed rows into React history.
    const flushed = pendingHistoryFlushRef.current;
    if (flushed.length === 0) return;
    pendingHistoryFlushRef.current = [];
    drainedHistoryFlushRef.current = flushed;
  }, [historyFlushGeneration]);

  useEffect(() => {
    const flushed = drainedHistoryFlushRef.current;
    if (flushed.length === 0) return;
    drainedHistoryFlushRef.current = [];
    setHistory((prev) => {
      const existingIds = new Set(prev.map((item) => item.id));
      const nextItems = flushed.filter((item) => !existingIds.has(item.id));
      if (nextItems.length === 0) return prev;
      const next = compactHistoryItems([...prev, ...nextItems]);
      if (sessionStore) sessionStore.history = next;
      return next;
    });
  }, [historyFlushGeneration, printHistoryItems, sessionStore, setHistory]);

  const finalizeSubmittedUserItem = useCallback(
    (item: TItem, deferredLiveItems: readonly TItem[] = []) => {
      streamedAssistantFlushRef.current = { flushedChars: 0, text: "" };
      const priorLiveItems = trimFlushItems([...deferredLiveItems]);
      const finalizedItems = [...priorLiveItems, item];
      // queueFlush renders + enqueues the rows synchronously (the printer
      // dedupes by id), so the deferred final assistant output is anchored in
      // scrollback before the next prompt clears the live frame.
      queueFlush(finalizedItems);
      setLiveItems([]);
    },
    [queueFlush, setLiveItems, trimFlushItems],
  );

  const clearPendingHistory = useCallback(() => {
    pendingHistoryFlushRef.current = [];
    terminalHistoryPrinter?.clear();
  }, [terminalHistoryPrinter]);

  return {
    pendingHistoryFlushRef,
    streamedAssistantFlushRef,
    printHistoryItems,
    queueFlush,
    finalizeSubmittedUserItem,
    clearPendingHistory,
  };
}
