import type { ContentPart, Message, ToolResult } from "@kenkaiiii/gg-ai";
import { compactHistoricalToolCallArgs } from "./compactor.js";
import { estimateTokens } from "./token-estimator.js";

/**
 * Cheap context pruning for stale tool payloads (opencode-style, no LLM call).
 *
 * Three signals, one pass:
 * 1. Superseded reads — an old `read` of a file that was re-read later carries
 *    zero information; the newest read wins.
 * 2. Old tool-output overflow — walking backwards, the most recent
 *    `protectTokens` worth of tool output plus the last `protectToolBatches`
 *    provider tool batches are kept verbatim; anything older is stubbed.
 * 3. Large completed tool arguments — old write/edit payloads are capped once
 *    their result has returned; the files and tool result are the durable truth.
 *
 * `PROTECTED_TOOLS` output is never pruned: it is behavioural instruction rather
 * than reproducible data, so a "re-run the tool" stub is not recoverable — the
 * agent has no signal that it ever loaded the skill.
 *
 * Tool batches—not human turns—are the protection boundary. Autonomous research
 * can execute dozens of provider/tool cycles for one user prompt; protecting the
 * whole human turn lets reproducible reads refill the context immediately after
 * compaction.
 *
 * Cache stability: pruning mutates history, which invalidates the provider's
 * prompt-cache prefix. To limit churn, nothing is pruned unless at least
 * `minimumTokens` would be freed in one batch. Stubs and compacted arguments are
 * idempotent, so later passes leave the rewritten prefix stable.
 */

export const PRUNE_PROTECT_TOKENS = 40_000;
export const PRUNE_MINIMUM_TOKENS = 20_000;
export const PRUNE_PROTECT_TOOL_BATCHES = 2;

/**
 * Pruning starts once the active context reaches this share of the compaction
 * trigger. Below it the rewrite costs more than it saves: each prune re-sends
 * the whole history after the first stub uncached (a live goal paid ~70–100k
 * tokens per prune to free ~20k at 117k of a 1M window), and freed tokens only
 * matter once compaction is near.
 */
export const PRUNE_START_FRACTION = 0.5;

/** Whether stale tool output is worth pruning at this context size. */
export function shouldPruneToolResults(activeTokens: number, compactionTarget: number): boolean {
  return activeTokens >= compactionTarget * PRUNE_START_FRACTION;
}

/** Tools whose output is instruction, not reproducible data — never pruned. */
export const PRUNE_PROTECTED_TOOLS = new Set(["skill"]);

const PRUNE_MARKER = "[Pruned:";
/**
 * Prefix of the token-overflow stub specifically. Reaching one of these while
 * walking backwards proves the whole older prefix was already considered, which
 * a superseded-read stub does NOT prove — read dedup fires independently of the
 * token budget, so an older verbatim result can sit behind one.
 */
const PRUNE_OVERFLOW_MARKER = `${PRUNE_MARKER} old tool output`;

export interface PruneOptions {
  /** Recent tool-output token budget kept verbatim. Default 40k. */
  protectTokens?: number;
  /** Minimum freed tokens required to apply a prune batch. Default 20k. */
  minimumTokens?: number;
  /** Number of most-recent provider tool batches never pruned. Default 2. */
  protectToolBatches?: number;
}

export interface PruneResult {
  pruned: boolean;
  prunedResults: number;
  compactedToolCalls: number;
  freedTokens: number;
}

interface ResultCandidate {
  result: ToolResult;
  freedTokens: number;
  stub: string;
}

interface ToolArgCandidate {
  message: Message;
  content: Message["content"];
  compactedToolCalls: number;
  freedTokens: number;
}

/**
 * The newest user/tool message that no later prune can change, or undefined
 * when nothing has been pruned for size yet. A prune pass stops scanning at the
 * newest old-output stub (see `PRUNE_OVERFLOW_MARKER`), and stubs, superseded
 * reads and capped tool arguments are only ever applied to messages it scanned,
 * so every later pass edits strictly newer messages than that stub. Hosts pin the
 * provider's long-lived cache breakpoint here (`Message.cacheAnchor`) so the
 * next prune re-sends only what follows it instead of the whole run.
 */
export function stablePrefixEnd(messages: Message[]): Message | undefined {
  let stub = messages.length;
  while (--stub >= 0) {
    const msg = messages[stub];
    if (
      msg?.role === "tool" &&
      msg.content.some(
        (r) => typeof r.content === "string" && r.content.startsWith(PRUNE_OVERFLOW_MARKER),
      )
    ) {
      break;
    }
  }
  for (let i = stub - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "user" || msg?.role === "tool") return msg;
  }
  return undefined;
}

/** Mutates `messages` in place; message/array identity is preserved so usage
 *  anchors and React refs stay valid. Returns what was freed. */
export function pruneStaleToolResults(messages: Message[], opts: PruneOptions = {}): PruneResult {
  const protectTokens = opts.protectTokens ?? PRUNE_PROTECT_TOKENS;
  const minimumTokens = opts.minimumTokens ?? PRUNE_MINIMUM_TOKENS;
  const protectToolBatches = opts.protectToolBatches ?? PRUNE_PROTECT_TOOL_BATCHES;

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
  const resultCandidates: ResultCandidate[] = [];
  const toolBatchByCallId = new Map<string, number>();
  let recentToolBatches = 0;
  let recentToolTokens = 0;

  scan: for (let msgIndex = messages.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = messages[msgIndex];
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    recentToolBatches++;
    const protectedBatch = recentToolBatches <= protectToolBatches;
    for (let partIndex = msg.content.length - 1; partIndex >= 0; partIndex--) {
      const result = msg.content[partIndex];
      if (result.type !== "tool_result") continue;
      toolBatchByCallId.set(result.toolCallId, recentToolBatches);
      if (typeof result.content !== "string") continue;
      // An overflow stub outside the protect zone means an earlier pass blew
      // the token budget here and pruned every prunable result older than it in
      // that same batch. History only grows at the tail, so nothing older can
      // have become prunable since: stop instead of re-scanning the whole
      // transcript every turn. Other stub kinds prove nothing about what lies
      // behind them, so they are merely skipped.
      if (result.content.startsWith(PRUNE_MARKER)) {
        if (!protectedBatch && result.content.startsWith(PRUNE_OVERFLOW_MARKER)) break scan;
        continue;
      }

      const info = callInfo.get(result.toolCallId);
      if (info && PRUNE_PROTECTED_TOOLS.has(info.name)) continue;
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

      // Newest read of each path+range wins — remember it even inside the
      // protect zone so an older duplicate outside the zone still counts as
      // superseded.
      if (readKey !== undefined) {
        if (seenReadPaths.has(readKey) && !protectedBatch) {
          resultCandidates.push({
            result,
            freedTokens: estimateTokens(result.content),
            stub: `${PRUNE_MARKER} this read of ${readPath} was superseded by a newer read later in the conversation.]`,
          });
          continue;
        }
        seenReadPaths.add(readKey);
      }

      if (protectedBatch) continue;

      const resultTokens = estimateTokens(result.content);
      recentToolTokens += resultTokens;
      if (recentToolTokens <= protectTokens) continue;

      resultCandidates.push({
        result,
        freedTokens: resultTokens,
        stub:
          `${PRUNE_MARKER} old tool output (${result.content.length} chars) removed to save ` +
          `context. Re-run the tool if this content is needed again.]`,
      });
    }
  }

  // Completed write/edit-style calls can carry entire files in their arguments.
  // Once outside the protected batches, cap those payloads before they alone can
  // trigger an LLM compaction. Unresolved calls are deliberately left untouched.
  const toolArgCandidates: ToolArgCandidate[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const compactedMessage = compactHistoricalToolCallArgs([message], (toolCallId) => {
      const batch = toolBatchByCallId.get(toolCallId);
      return batch !== undefined && batch > protectToolBatches;
    })[0];
    if (compactedMessage === message) continue;

    const originalContent = message.content as ContentPart[];
    const compactedContent = compactedMessage.content as ContentPart[];
    const originalTokens = estimateTokens(JSON.stringify(originalContent));
    const compactedTokens = estimateTokens(JSON.stringify(compactedContent));
    const compactedToolCalls = compactedContent.filter(
      (part, index) => part !== originalContent[index],
    ).length;
    toolArgCandidates.push({
      message,
      content: compactedMessage.content,
      compactedToolCalls,
      freedTokens: Math.max(0, originalTokens - compactedTokens),
    });
  }

  const freedTokens = [...resultCandidates, ...toolArgCandidates].reduce(
    (sum, candidate) => sum + candidate.freedTokens,
    0,
  );
  if (freedTokens < minimumTokens) {
    return {
      pruned: false,
      prunedResults: 0,
      compactedToolCalls: 0,
      freedTokens: 0,
    };
  }

  for (const candidate of resultCandidates) {
    candidate.result.content = candidate.stub;
  }
  for (const candidate of toolArgCandidates) {
    candidate.message.content = candidate.content;
  }
  return {
    pruned: true,
    prunedResults: resultCandidates.length,
    compactedToolCalls: toolArgCandidates.reduce(
      (sum, candidate) => sum + candidate.compactedToolCalls,
      0,
    ),
    freedTokens,
  };
}
