import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Message, Provider, Usage } from "@kenkaiiii/gg-ai";
import type { TransformContextOptions } from "@kenkaiiii/gg-agent";
import { compact, shouldCompact } from "../../core/compaction/compactor.js";
import { calculateActiveContextTokens } from "../../core/compaction/active-context.js";
import { pruneStaleToolResults } from "../../core/compaction/tool-result-pruner.js";
import { estimateConversationTokens } from "../../core/compaction/token-estimator.js";
import {
  getAuthStorageKeys,
  getContextWindow,
  type ContextWindowOptions,
} from "../../core/model-registry.js";
import { log } from "../../core/logger.js";
import type { AuthStorage } from "../../core/auth-storage.js";
import type { SettingsManager } from "../../core/settings-manager.js";
import type { CompletedItem, CompactedItem } from "../app-items.js";
import { toErrorItem } from "../error-item.js";

interface UseContextCompactionOptions {
  currentModel: string;
  currentProvider: Provider;
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
  persistCompactedSession: (compactedMessages: readonly Message[]) => Promise<void>;
}

export interface ContextCompaction {
  compactionAbortRef: MutableRefObject<AbortController | null>;
  compactConversation: (messages: Message[], signal?: AbortSignal) => Promise<Message[]>;
  transformContext: (messages: Message[], options: TransformContextOptions) => Promise<Message[]>;
  recordProviderUsage: (usage: Usage, messages: Message[]) => void;
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
  persistCompactedSession,
}: UseContextCompactionOptions): ContextCompaction {
  const compactionAbortRef = useRef<AbortController | null>(null);
  const lastCompactionTimeRef = useRef(0);
  const providerContextRef = useRef<{ usage: Usage; anchor: Message } | null>(null);
  const modelKey = `${currentProvider}:${currentModel}`;
  const providerContextModelKeyRef = useRef(modelKey);
  if (providerContextModelKeyRef.current !== modelKey) {
    providerContextModelKeyRef.current = modelKey;
    providerContextRef.current = null;
  }

  const rememberProviderUsage = useCallback(
    (usage: Usage, messages: Message[], pendingMessages: Message[]): void => {
      const anchorIndex = messages.length - pendingMessages.length - 1;
      const anchor = messages[anchorIndex];
      if (anchor?.role === "assistant") {
        providerContextRef.current = { usage: { ...usage }, anchor };
      }
    },
    [],
  );

  const recordProviderUsage = useCallback((usage: Usage, messages: Message[]): void => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const anchor = messages[index];
      if (anchor?.role === "assistant") {
        providerContextRef.current = { usage: { ...usage }, anchor };
        return;
      }
    }
  }, []);

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
          const creds = await authStorage.resolveCredentials(currentProvider, {
            storageKeys: getAuthStorageKeys(currentProvider, currentModel),
          });
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
          providerContextRef.current = null;
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
          // Nothing was actually compacted — remove spinner silently and keep
          // the original reference so the agent loop preserves its usage anchor.
          log("INFO", "compaction", `Compaction skipped: ${result.result.reason ?? "unknown"}`);
          setLiveItems((prev) => prev.filter((item) => item.id !== spinId));
          return messages;
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
    async (messages: Message[], options: TransformContextOptions): Promise<Message[]> => {
      if (options.usage) {
        rememberProviderUsage(options.usage, messages, options.pendingMessages);
      }

      const settings = settingsRef.current;
      const autoCompact = settings?.get("autoCompact") ?? true;
      const threshold = settings?.get("compactThreshold") ?? 0.8;

      // Force-compact on context overflow regardless of settings or cooldown.
      if (options.force) {
        const result = await compactConversation(messages);
        if (result !== messages) {
          messagesRef.current = result;
          await persistCompactedSession(result);
        }
        lastCompactionTimeRef.current = Date.now();
        return result;
      }

      if (!autoCompact) return messages;

      // Cheap stale-tool-output pruning before the expensive LLM compaction
      // check. In-place mutation preserves the usage anchor's identity; drop
      // the retained usage afterwards since it counted the pruned content.
      const pruneResult = pruneStaleToolResults(messages);
      if (pruneResult.pruned) {
        providerContextRef.current = null;
        log("INFO", "compaction", "Pruned stale tool outputs", {
          prunedResults: String(pruneResult.prunedResults),
          freedTokens: String(pruneResult.freedTokens),
        });
      }

      // Time-based cooldown: skip if compaction ran within the last 30 seconds.
      if (Date.now() - lastCompactionTimeRef.current < 30_000) {
        log("INFO", "compaction", `Skipping compaction — cooldown active`);
        return messages;
      }

      // The turn's own usage also counted the pruned content — after a prune,
      // fall back to estimating the (now smaller) history so the freed tokens
      // actually defer the LLM compaction.
      let usage = pruneResult.pruned ? undefined : options.usage;
      let pendingMessages = options.pendingMessages;
      if (!usage && providerContextRef.current) {
        const anchorIndex = messages.lastIndexOf(providerContextRef.current.anchor);
        if (anchorIndex >= 0) {
          usage = providerContextRef.current.usage;
          pendingMessages = messages.slice(anchorIndex + 1);
        } else {
          providerContextRef.current = null;
        }
      }

      const contextWindow = getContextWindow(currentModel, contextWindowOptions);
      const activeTokens = calculateActiveContextTokens(messages, { usage, pendingMessages });
      if (shouldCompact(messages, contextWindow, threshold, activeTokens)) {
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
      settingsRef,
      messagesRef,
      rememberProviderUsage,
    ],
  );

  return {
    compactionAbortRef,
    compactConversation,
    transformContext,
    recordProviderUsage,
  };
}
