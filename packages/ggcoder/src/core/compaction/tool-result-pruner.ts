import type { Message, ToolResult } from "@kenkaiiii/gg-ai";
import { estimateTokens } from "./token-estimator.js";

/**
 * Cheap context pruning for stale tool outputs (opencode-style, no LLM call).
 *
 * Two signals, one pass:
 * 1. Superseded reads — an old `read` of a file that was re-read later carries
 *    zero information; the newest read wins.
 * 2. Old tool-output overflow — walking backwards, the most recent
 *    `protectTokens` worth of tool output (plus everything in the last
 *    `protectTurns` user turns) is kept verbatim; anything older is stubbed.
 *
 * Cache stability: pruning mutates history, which invalidates the provider's
 * prompt-cache prefix once. To avoid churning the cache every turn, nothing is
 * pruned unless at least `minimumTokens` would be freed in one batch — so
 * prunes are rare, large, and the stubbed prefix is stable afterwards.
 * Stubs are idempotent (marked with a prefix) and never re-pruned.
 */

export const PRUNE_PROTECT_TOKENS = 40_000;
export const PRUNE_MINIMUM_TOKENS = 20_000;
export const PRUNE_PROTECT_TURNS = 2;

const PRUNE_MARKER = "[Pruned:";

export interface PruneOptions {
  /** Recent tool-output token budget kept verbatim. Default 40k. */
  protectTokens?: number;
  /** Minimum freed tokens required to apply a prune batch. Default 20k. */
  minimumTokens?: number;
  /** Number of most-recent user turns whose tool outputs are never pruned. Default 2. */
  protectTurns?: number;
}

export interface PruneResult {
  pruned: boolean;
  prunedResults: number;
  freedTokens: number;
}

interface Candidate {
  result: ToolResult;
  freedTokens: number;
  stub: string;
}

/** Mutates `messages` in place; message/array identity is preserved so usage
 *  anchors and React refs stay valid. Returns what was freed. */
export function pruneStaleToolResults(messages: Message[], opts: PruneOptions = {}): PruneResult {
  const protectTokens = opts.protectTokens ?? PRUNE_PROTECT_TOKENS;
  const minimumTokens = opts.minimumTokens ?? PRUNE_MINIMUM_TOKENS;
  const protectTurns = opts.protectTurns ?? PRUNE_PROTECT_TURNS;

  // toolCallId → tool name + args (for read-dedup path identification).
  const callInfo = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "tool_call") {
        callInfo.set(part.id, { name: part.name, args: part.args });
      }
    }
  }

  const seenReadPaths = new Set<string>();
  const candidates: Candidate[] = [];
  let userTurns = 0;
  let recentToolTokens = 0;

  for (let msgIndex = messages.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = messages[msgIndex];
    if (msg.role === "user") userTurns++;
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;

    for (let partIndex = msg.content.length - 1; partIndex >= 0; partIndex--) {
      const result = msg.content[partIndex];
      if (result.type !== "tool_result" || typeof result.content !== "string") continue;
      if (result.content.startsWith(PRUNE_MARKER)) continue;

      const info = callInfo.get(result.toolCallId);
      // Dedup key includes the range: a partial read (offset/limit) covers
      // different content than a full read or another range, so only an
      // identical path+range read supersedes an older one.
      const readPath =
        info?.name === "read" && typeof info.args.file_path === "string"
          ? info.args.file_path
          : undefined;
      const readKey =
        readPath !== undefined
          ? `${readPath}#${String(info?.args.offset ?? "")}:${String(info?.args.limit ?? "")}`
          : undefined;
      const protectedTurn = userTurns < protectTurns;

      // Newest read of each path+range wins — remember it even inside the
      // protect zone so an older duplicate outside the zone still counts as
      // superseded.
      if (readKey !== undefined) {
        if (seenReadPaths.has(readKey) && !protectedTurn) {
          candidates.push({
            result,
            freedTokens: estimateTokens(result.content),
            stub: `${PRUNE_MARKER} this read of ${readPath} was superseded by a newer read later in the conversation.]`,
          });
          continue;
        }
        seenReadPaths.add(readKey);
      }

      if (protectedTurn) continue;

      const resultTokens = estimateTokens(result.content);
      recentToolTokens += resultTokens;
      if (recentToolTokens <= protectTokens) continue;

      candidates.push({
        result,
        freedTokens: resultTokens,
        stub:
          `${PRUNE_MARKER} old tool output (${result.content.length} chars) removed to save ` +
          `context. Re-run the tool if this content is needed again.]`,
      });
    }
  }

  const freedTokens = candidates.reduce((sum, candidate) => sum + candidate.freedTokens, 0);
  if (freedTokens < minimumTokens) {
    return { pruned: false, prunedResults: 0, freedTokens: 0 };
  }

  for (const candidate of candidates) {
    candidate.result.content = candidate.stub;
  }
  return { pruned: true, prunedResults: candidates.length, freedTokens };
}
