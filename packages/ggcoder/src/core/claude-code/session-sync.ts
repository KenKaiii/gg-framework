import crypto from "node:crypto";
import type { Message } from "@kenkaiiii/gg-ai";

/** Session-file entry recording which Claude Code session has seen our history. */
export const CLAUDE_CODE_SESSION_KIND = "claude_code_session";

/** Largest transcript sent as text to a fresh Claude Code session (~100k tokens). */
export const CLAUDE_CODE_SEED_CHARS = 400_000;

export interface ClaudeCodeSessionState {
  sessionId: string;
  /** Non-system messages Claude Code has seen. */
  messageCount: number;
  /** The last of those messages; identity proves the history was not rewritten. */
  anchor: Message | undefined;
}

/**
 * The Claude Code session to resume, or undefined when our history no longer
 * matches it (a branch, our compaction, or turns from another provider) and a
 * fresh session must be seeded with the transcript instead.
 */
export function claudeCodeResumeId(
  state: ClaudeCodeSessionState | null,
  messages: readonly Message[],
): string | undefined {
  if (!state || state.messageCount === 0) return undefined;
  const history = messages.filter((m) => m.role !== "system");
  if (history.length < state.messageCount) return undefined;
  if (history[state.messageCount - 1] !== state.anchor) return undefined;
  // Only new user turns may follow; anything else came from another route.
  const after = history.slice(state.messageCount);
  return after.every((m) => m.role === "user") ? state.sessionId : undefined;
}

export function messageFingerprint(message: Message | undefined): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(message ?? null))
    .digest("hex")
    .slice(0, 32);
}

/** What the session file stores for {@link parseClaudeCodeSessionState}. */
export function claudeCodeSessionEntryData(state: ClaudeCodeSessionState) {
  return {
    version: 1,
    sessionId: state.sessionId,
    messageCount: state.messageCount,
    anchorHash: messageFingerprint(state.anchor),
  };
}

/** Rebuild the state from a saved entry; null when it belongs to another branch. */
export function parseClaudeCodeSessionState(
  data: unknown,
  restored: readonly Message[],
): ClaudeCodeSessionState | null {
  const d = data as {
    version?: unknown;
    sessionId?: unknown;
    messageCount?: unknown;
    anchorHash?: unknown;
  } | null;
  if (d?.version !== 1 || typeof d.sessionId !== "string" || typeof d.messageCount !== "number") {
    return null;
  }
  const history = restored.filter((m) => m.role !== "system");
  if (d.messageCount < 1 || d.messageCount > history.length) return null;
  const anchor = history[d.messageCount - 1];
  if (d.anchorHash !== messageFingerprint(anchor)) return null;
  return { sessionId: d.sessionId, messageCount: d.messageCount, anchor };
}
