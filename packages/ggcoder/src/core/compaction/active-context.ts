import type { Message, Usage } from "@kenkaiiii/gg-ai";
import { estimateConversationTokens } from "./token-estimator.js";

export interface ActiveContextOptions {
  /** Latest provider-reported usage for history through its assistant response. */
  usage?: Usage;
  /** Messages appended after the provider usage sample. */
  pendingMessages?: Message[];
}

/**
 * Resolve the active context size before the next provider request.
 *
 * Provider usage is authoritative once available because it includes system
 * instructions and tool schemas. Only messages added after that sample are
 * estimated locally. Before the first response, the full message history is
 * estimated instead.
 */
export function calculateActiveContextTokens(
  messages: Message[],
  options: ActiveContextOptions = {},
): number {
  const { usage, pendingMessages = [] } = options;
  if (!usage) return estimateConversationTokens(messages);

  return (
    usage.inputTokens +
    (usage.cacheRead ?? 0) +
    (usage.cacheWrite ?? 0) +
    usage.outputTokens +
    estimateConversationTokens(pendingMessages)
  );
}
