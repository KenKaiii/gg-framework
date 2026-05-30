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
        write: writeStdout,
      });
    },
    [terminalHistoryPrinter, writeStdout],
  );

  const queueFlush = useCallback(
    (items: TItem[]) => {
      const flushed = trimFlushItems(items);
      if (flushed.length === 0) return;
      pendingHistoryFlushRef.current = [...pendingHistoryFlushRef.current, ...flushed];
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
      }
      setHistoryFlushGeneration((generation) => generation + 1);
    },
    [persistDisplayItem, sessionManagerRef, sessionPathRef, sessionStore, trimFlushItems],
  );

  useEffect(() => {
    printHistoryItems(history);
  }, [history, printHistoryItems]);

  useLayoutEffect(() => {
    const flushed = pendingHistoryFlushRef.current;
    if (flushed.length === 0) return;
    // Keep the visible row continuous during finalization: write the completed
    // transcript into terminal history while Ink still knows about the current
    // live frame, then remove those live rows. Doing this in the opposite order
    // collapses the live frame to the controls first, so a large final history
    // write scrolls underneath the footer/input and visibly pushes them upward.
    pendingHistoryFlushRef.current = [];
    drainedHistoryFlushRef.current = flushed;
    printHistoryItems(flushed);
    const flushedIds = new Set(flushed.map((item) => item.id));
    setLiveItems((prev) => prev.filter((item) => !flushedIds.has(item.id)));
  }, [historyFlushGeneration, printHistoryItems, setLiveItems]);

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
      queueFlush(finalizedItems);
      // Print synchronously so deferred final assistant output is anchored in
      // scrollback before the next prompt clears the live frame. The queued flush
      // still persists and updates React history; the printer dedupes by id when
      // the effect drains the queue.
      printHistoryItems(finalizedItems);
      setLiveItems([]);
    },
    [printHistoryItems, queueFlush, setLiveItems, trimFlushItems],
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
