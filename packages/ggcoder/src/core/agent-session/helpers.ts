import type { Message, Provider } from "@kleio/ai";
import { getContextWindow, getToolResultCharLimit } from "../model-registry.js";
import os from "node:os";
import path from "node:path";

/**
 * A run whose tool calls fail more often than this is thrashing, not
 * progressing — refuse to extend its turn budget.
 */
export const TURN_EXTENSION_MAX_FAILURE_RATIO = 0.5;

// ── Tool-result policy ─────────────────────────────────────

/** Resolve the per-result cap passed to the agent loop for the active transport. */
export function resolveSessionToolResultCharLimit(
  model: string,
  provider: Provider,
  accountId?: string,
): number {
  return (
    getToolResultCharLimit(model, { provider, accountId }) ??
    Math.floor(getContextWindow(model, { provider, accountId }) * 3.5 * 0.3)
  );
}

/**
 * Aggregate budget for ALL tool results produced in one assistant turn.
 * Individual results are already capped, but wide parallel fan-outs (GPT-5.6's
 * signature behavior) were observed injecting 100k+ uncached tokens in a single
 * turn. ~15% of the context window in chars (1 token ≈ 3.5 chars), floored at
 * 100KB so small windows still fit two full-size reads, ceilinged at 240KB so
 * 1M-context models don't waive the budget entirely.
 */
export function resolveSessionTurnToolResultCharLimit(
  model: string,
  provider: Provider,
  accountId?: string,
): number {
  const contextChars = getContextWindow(model, { provider, accountId }) * 3.5;
  return Math.max(100_000, Math.min(Math.floor(contextChars * 0.15), 240_000));
}

/** Marker the compactor prepends to the summary message it injects. */
/**
 * True when an assistant message ends a turn with tool calls still awaiting
 * their results. Inserting a user message there would orphan the tool_use
 * blocks and the provider rejects the next request.
 */
export function hasUnresolvedToolCalls(message: Message): boolean {
  if (typeof message.content === "string" || !Array.isArray(message.content)) return false;
  return message.content.some((part) => part.type === "tool_call");
}

/** Expand a leading `~` so `/import ~/.codex/...` works from any shell. */
export function resolveHomePath(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}
