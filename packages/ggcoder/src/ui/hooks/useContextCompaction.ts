import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Message, Provider } from "@kenkaiiii/gg-ai";
import {
  compact,
  shouldCompact,
  getCompactionReserveTokens,
} from "../../core/compaction/compactor.js";
import { estimateConversationTokens } from "../../core/compaction/token-estimator.js";
import { getContextWindow, type ContextWindowOptions } from "../../core/model-registry.js";
import { log } from "../../core/logger.js";
import type { AuthStorage } from "../../core/auth-storage.js";
import type { SettingsManager } from "../../core/settings-manager.js";
import type { CompletedItem, CompactedItem } from "../app-items.js";
import { toErrorItem } from "../error-item.js";

interface UseContextCompactionOptions {
  currentModel: string;
  currentProvider: Provider;
  maxTokens: number;
  authStorage?: AuthStorage;
  contextWindowOptions: ContextWindowOptions;
  activeApiKey: string | undefined;
  activeAccountId: string | undefined;
  activeProjectId: string | undefined;
  activeBaseUrl: string | undefined;
  setLiveItems: Dispatch<SetStateAction<CompletedItem[]>>;
  getId: () => string;
  approvedPlanPathRef: MutableRefObject<string | undefined>;
  settingsRef: MutableRefObject<SettingsManager | null>;
  messagesRef: MutableRefObject<Message[]>;
  lastActualTokensRef: MutableRefObject<number>;
  lastActualTokensTimestampRef: MutableRefObject<number>;
  persistCompactedSession: (compactedMessages: readonly Message[]) => Promise<void>;
}

export interface ContextCompaction {
  compactionAbortRef: MutableRefObject<AbortController | null>;
  compactConversation: (messages: Message[], signal?: AbortSignal) => Promise<Message[]>;
  transformContext: (messages: Message[], options?: { force?: boolean }) => Promise<Message[]>;
}

/**
 * Owns context compaction: the manual `compactConversation` flow (spinner +
 * credential resolution + abort handling) and the `transformContext` callback
 * the agent loop calls before each turn / on overflow. Extracted verbatim from
 * `App.tsx`.
 */
export function useContextCompaction({
  currentModel,
  currentProvider,
  maxTokens,
  authStorage,
  contextWindowOptions,
  activeApiKey,
  activeAccountId,
  activeProjectId,
  activeBaseUrl,
  setLiveItems,
  getId,
  approvedPlanPathRef,
  settingsRef,
  messagesRef,
  lastActualTokensRef,
  lastActualTokensTimestampRef,
  persistCompactedSession,
}: UseContextCompactionOptions): ContextCompaction {
  const compactionAbortRef = useRef<AbortController | null>(null);
  const lastCompactionTimeRef = useRef(0);

  const compactConversation = useCallback(
    async (messages: Message[], signal?: AbortSignal): Promise<Message[]> => {
      const contextWindow = getContextWindow(currentModel, contextWindowOptions);
      const tokensBefore = estimateConversationTokens(messages);
      const spinId = getId();
      log("INFO", "compaction", `Running compaction`, {
        messages: String(messages.length),
        estimatedTokens: String(tokensBefore),
        contextWindow: String(contextWindow),
      });

      // Show animated spinner
      setLiveItems((prev) => [...prev, { kind: "compacting", id: spinId }]);

      const ownedAbort = signal ? null : new AbortController();
      const compactionSignal = signal ?? ownedAbort?.signal;
      if (ownedAbort) compactionAbortRef.current = ownedAbort;

      try {
        // Resolve fresh credentials for compaction too
        let compactApiKey = activeApiKey;
        let compactAccountId = activeAccountId;
        let compactProjectId = activeProjectId;
        let compactBaseUrl = activeBaseUrl;
        if (authStorage) {
          const creds = await authStorage.resolveCredentials(currentProvider);
          compactApiKey = creds.accessToken;
          compactAccountId = creds.accountId;
          compactProjectId = creds.projectId;
          compactBaseUrl = creds.baseUrl ?? compactBaseUrl;
        }

        const result = await compact(messages, {
          provider: currentProvider,
          model: currentModel,
          apiKey: compactApiKey,
          accountId: compactAccountId,
          projectId: compactProjectId,
          baseUrl: compactBaseUrl,
          contextWindow,
          signal: compactionSignal,
          approvedPlanPath: approvedPlanPathRef.current,
        });

        if (result.result.compacted) {
          // Replace spinner with completed notice
          setLiveItems((prev) =>
            prev.map((item) =>
              item.id === spinId
                ? ({
                    kind: "compacted",
                    originalCount: result.result.originalCount,
                    newCount: result.result.newCount,
                    tokensBefore: result.result.tokensBeforeEstimate,
                    tokensAfter: result.result.tokensAfterEstimate,
                    id: spinId,
                  } as CompactedItem)
                : item,
            ),
          );
        } else {
          // Nothing was actually compacted — remove spinner silently
          log("INFO", "compaction", `Compaction skipped: ${result.result.reason ?? "unknown"}`);
          setLiveItems((prev) => prev.filter((item) => item.id !== spinId));
        }

        return result.messages;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isAbort =
          compactionSignal?.aborted || msg.includes("aborted") || msg.includes("abort");
        log(
          isAbort ? "WARN" : "ERROR",
          "compaction",
          isAbort ? "Compaction aborted" : `Compaction failed: ${msg}`,
        );
        setLiveItems((prev) =>
          isAbort
            ? prev.filter((item) => item.id !== spinId)
            : prev.map((item) =>
                item.id === spinId ? toErrorItem(err, spinId, "Compaction failed") : item,
              ),
        );
        return messages; // Return unchanged on failure/abort
      } finally {
        if (ownedAbort && compactionAbortRef.current === ownedAbort)
          compactionAbortRef.current = null;
      }
    },
    [
      currentModel,
      currentProvider,
      activeApiKey,
      activeAccountId,
      activeProjectId,
      activeBaseUrl,
      contextWindowOptions,
      authStorage,
      setLiveItems,
      getId,
      approvedPlanPathRef,
    ],
  );

  const transformContext = useCallback(
    async (messages: Message[], options?: { force?: boolean }): Promise<Message[]> => {
      const settings = settingsRef.current;
      const autoCompact = settings?.get("autoCompact") ?? true;
      const threshold = settings?.get("compactThreshold") ?? 0.8;

      // Force-compact on context overflow regardless of settings
      if (options?.force) {
        const result = await compactConversation(messages);
        if (result !== messages) {
          messagesRef.current = result;
          await persistCompactedSession(result);
        }
        lastCompactionTimeRef.current = Date.now();
        return result;
      }

      if (!autoCompact) return messages;

      // Time-based cooldown: skip if compaction ran within the last 30 seconds
      if (Date.now() - lastCompactionTimeRef.current < 30_000) {
        log("INFO", "compaction", `Skipping compaction — cooldown active`);
        return messages;
      }

      const contextWindow = getContextWindow(currentModel, contextWindowOptions);
      const reserveTokens = getCompactionReserveTokens(maxTokens);
      const tokensFresh = lastActualTokensTimestampRef.current > lastCompactionTimeRef.current;
      const actualTokens =
        lastActualTokensRef.current > 0 && tokensFresh ? lastActualTokensRef.current : undefined;
      if (shouldCompact(messages, contextWindow, threshold, actualTokens, reserveTokens)) {
        const result = await compactConversation(messages);
        if (result !== messages) {
          messagesRef.current = result;
          await persistCompactedSession(result);
        }
        lastCompactionTimeRef.current = Date.now();
        return result;
      }
      return messages;
    },
    [
      currentModel,
      compactConversation,
      contextWindowOptions,
      persistCompactedSession,
      maxTokens,
      settingsRef,
      messagesRef,
      lastActualTokensRef,
      lastActualTokensTimestampRef,
    ],
  );

  return { compactionAbortRef, compactConversation, transformContext };
}
