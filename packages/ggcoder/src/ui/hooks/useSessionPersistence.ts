import { useCallback, type MutableRefObject } from "react";
import type { Message, Provider } from "@kenkaiiii/gg-ai";
import {
  appendMessagesToSession as appendSessionMessages,
  createCompactedSessionCheckpoint,
} from "../../core/session-compaction.js";
import type { SessionManager, TurnMetricPayload } from "../../core/session-manager.js";
import { log } from "../../core/logger.js";
import { findUserSessionPrompt } from "../../core/session-preview.js";
import type { SessionStats } from "../session-summary.js";

/** Minimal session-store surface the persistence layer mirrors into. */
interface PersistenceSessionStore {
  messages: Message[];
  sessionPath?: string;
  sessionId?: string;
}

interface UseSessionPersistenceOptions {
  sessionManagerRef: MutableRefObject<SessionManager | null>;
  sessionPathRef: MutableRefObject<string | undefined>;
  sessionStatsRef: MutableRefObject<SessionStats>;
  persistedIndexRef: MutableRefObject<number>;
  messagesRef: MutableRefObject<Message[]>;
  turnMetricsRef: MutableRefObject<TurnMetricPayload[]>;
  cwdRef: MutableRefObject<string>;
  currentProvider: Provider;
  currentModel: string;
  sessionStore?: PersistenceSessionStore;
  onCompactedSession?: (sessionId: string) => Promise<void>;
}

export interface SessionPersistence {
  appendMessagesToSession: (
    sessionPath: string,
    messages: readonly Message[],
    startIndex: number,
  ) => Promise<void>;
  persistCompactedSession: (compactedMessages: readonly Message[]) => Promise<void>;
  persistNewMessages: () => Promise<void>;
}

/**
 * Owns session message persistence: appending new turn messages, persisting a
 * compacted checkpoint, and keeping `persistedIndexRef`/`sessionStatsRef`/the
 * session store in sync. Extracted verbatim from `App.tsx`.
 */
export function useSessionPersistence({
  sessionManagerRef,
  sessionPathRef,
  sessionStatsRef,
  persistedIndexRef,
  messagesRef,
  turnMetricsRef,
  cwdRef,
  currentProvider,
  currentModel,
  sessionStore,
  onCompactedSession,
}: UseSessionPersistenceOptions): SessionPersistence {
  const appendMessagesToSession = useCallback(
    async (sessionPath: string, messages: readonly Message[], startIndex: number) => {
      const sm = sessionManagerRef.current;
      if (!sm) return;
      await appendSessionMessages(sm, sessionPath, messages, startIndex);
    },
    [sessionManagerRef],
  );

  const persistCompactedSession = useCallback(
    async (compactedMessages: readonly Message[]): Promise<void> => {
      const sm = sessionManagerRef.current;
      if (!sm) return;
      const session = await createCompactedSessionCheckpoint(sm, {
        cwd: cwdRef.current,
        provider: currentProvider,
        model: currentModel,
        messages: compactedMessages,
        preview: findUserSessionPrompt(messagesRef.current),
      });
      sessionPathRef.current = session.path;
      sessionStatsRef.current.sessionId = session.id;
      for (const metric of turnMetricsRef.current) {
        await sm.appendTurnMetric(session.path, metric);
      }
      await onCompactedSession?.(session.id);
      persistedIndexRef.current = compactedMessages.length;
      if (sessionStore) {
        sessionStore.sessionPath = session.path;
        sessionStore.sessionId = session.id;
        sessionStore.messages = [...compactedMessages];
      }
      log("INFO", "compaction", "Persisted compacted session checkpoint", { path: session.path });
    },
    [
      currentModel,
      currentProvider,
      sessionStore,
      onCompactedSession,
      sessionManagerRef,
      sessionPathRef,
      sessionStatsRef,
      messagesRef,
      persistedIndexRef,
      cwdRef,
      turnMetricsRef,
    ],
  );

  const persistNewMessages = useCallback(async () => {
    const sp = sessionPathRef.current;
    if (!sp) return;
    const allMsgs = messagesRef.current;
    await appendMessagesToSession(sp, allMsgs, persistedIndexRef.current);
    persistedIndexRef.current = allMsgs.length;
    if (sessionStore) {
      sessionStore.messages = [...allMsgs];
      sessionStore.sessionPath = sp;
      sessionStore.sessionId = sessionStatsRef.current.sessionId;
    }
  }, [
    appendMessagesToSession,
    sessionStore,
    sessionPathRef,
    messagesRef,
    persistedIndexRef,
    sessionStatsRef,
  ]);

  return { appendMessagesToSession, persistCompactedSession, persistNewMessages };
}
