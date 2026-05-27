import { useCallback, useEffect, useRef, useState } from "react";
import { DISPLAY_ITEM_CUSTOM_KIND, type SessionManager } from "../../core/session-manager.js";
import { compactHistory } from "../item-helpers.js";
import { trimFlushedItems } from "../live-item-flush.js";
import type { CompletedItem } from "../app-items.js";
import type { TerminalHistoryContext, TerminalHistoryPrinter } from "../terminal-history.js";

interface SessionStoreLike {
  history?: CompletedItem[];
  liveItems?: CompletedItem[];
}

interface UseTranscriptHistoryOptions {
  terminalHistoryPrinter?: TerminalHistoryPrinter;
  terminalHistoryContext: TerminalHistoryContext;
  writeStdout: (data: string) => void;
  sessionPathRef: React.RefObject<string | undefined>;
  sessionManagerRef: React.RefObject<SessionManager | null>;
  sessionStore?: SessionStoreLike;
  history: readonly CompletedItem[];
  setHistory: React.Dispatch<React.SetStateAction<CompletedItem[]>>;
  setLiveItems: React.Dispatch<React.SetStateAction<CompletedItem[]>>;
}

interface UseTranscriptHistoryResult {
  pendingHistoryFlushRef: React.RefObject<CompletedItem[]>;
  streamedAssistantFlushRef: React.RefObject<{ flushedChars: number; text: string }>;
  printHistoryItems: (items: readonly CompletedItem[], options?: { force?: boolean }) => void;
  queueFlush: (items: CompletedItem[]) => void;
  finalizeSubmittedUserItem: (item: CompletedItem) => void;
  clearPendingHistory: () => void;
}

export function useTranscriptHistory({
  terminalHistoryPrinter,
  terminalHistoryContext,
  writeStdout,
  sessionPathRef,
  sessionManagerRef,
  sessionStore,
  history,
  setHistory,
  setLiveItems,
}: UseTranscriptHistoryOptions): UseTranscriptHistoryResult {
  const terminalHistoryContextRef = useRef<TerminalHistoryContext>(terminalHistoryContext);
  const pendingHistoryFlushRef = useRef<CompletedItem[]>([]);
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
    (items: readonly CompletedItem[], options?: { force?: boolean }) => {
      if (!terminalHistoryPrinter || items.length === 0) return;
      terminalHistoryPrinter.print(items, terminalHistoryContextRef.current, {
        ...options,
        write: writeStdout,
      });
    },
    [terminalHistoryPrinter, writeStdout],
  );

  const queueFlush = useCallback(
    (items: CompletedItem[]) => {
      const flushed = trimFlushedItems(items);
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
            data: { version: 1, item },
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
    [sessionManagerRef, sessionPathRef, sessionStore],
  );

  useEffect(() => {
    printHistoryItems(history);
  }, [history, printHistoryItems]);

  useEffect(() => {
    const flushed = pendingHistoryFlushRef.current;
    if (flushed.length === 0) return;
    pendingHistoryFlushRef.current = [];
    printHistoryItems(flushed);
    const flushedIds = new Set(flushed.map((item) => item.id));
    setLiveItems((prev) => prev.filter((item) => !flushedIds.has(item.id)));
    setHistory((prev) => {
      const existingIds = new Set(prev.map((item) => item.id));
      const nextItems = flushed.filter((item) => !existingIds.has(item.id));
      if (nextItems.length === 0) return prev;
      const next = compactHistory([...prev, ...nextItems]);
      if (sessionStore) sessionStore.history = next;
      return next;
    });
  }, [historyFlushGeneration, printHistoryItems, sessionStore, setHistory, setLiveItems]);

  const finalizeSubmittedUserItem = useCallback(
    (item: CompletedItem) => {
      streamedAssistantFlushRef.current = { flushedChars: 0, text: "" };
      setLiveItems((prev) => {
        if (prev.length > 0) queueFlush(prev);
        return [item];
      });
    },
    [queueFlush, setLiveItems],
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
