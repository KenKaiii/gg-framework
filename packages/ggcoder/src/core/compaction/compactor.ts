import {
  stream,
  type Message,
  type Provider,
  type ContentPart,
  type ToolResult,
} from "@kenkaiiii/gg-ai";
import { estimateConversationTokens, estimateMessageTokens } from "./token-estimator.js";
import { getSummaryModel, getContextWindow } from "../model-registry.js";
import { log } from "../logger.js";

/** Max chars per tool result when preparing messages for the summarizer. */
const TOOL_RESULT_MAX_CHARS = 2000;

/** Max retries for empty LLM responses during summarization. */
const MAX_SUMMARY_RETRIES = 2;

/** Max output tokens for the summary response. */
const MAX_SUMMARY_OUTPUT_TOKENS = 4096;

const COMPACTION_SYSTEM_PROMPT =
  "You are a conversation compaction assistant. Your job is to create a concise summary of a conversation " +
  "between a user and an AI coding assistant.\n\n" +
  "This summary will replace older messages to keep the conversation within context limits while preserving " +
  "all important information needed to continue the work seamlessly.\n\n" +
  "Always output the summary — never refuse, never ask questions, never output empty responses.\n\n" +
  "## What to Include\n" +
  "- **User intent and goals** — what the user is trying to accomplish\n" +
  "- **What was done** — what was implemented, modified, or debugged, including technical approaches and outcomes\n" +
  "- **File operations** — all files created, modified, or referenced, with key changes\n" +
  "- **Tool call outcomes** — which tools were called and their key results\n" +
  "- **Key decisions** — important choices made and why\n" +
  "- **Solutions & troubleshooting** — problems encountered and how they were resolved\n\n" +
  "## What to Exclude\n" +
  "- Redundant or superseded information\n" +
  "- Full file contents (reference by path instead)\n" +
  "- Verbose tool output (summarize key results)\n" +
  "- Plans, next steps, or implementation instructions — do NOT carry forward action items or " +
  "plans from old conversation summaries. Summarize what HAPPENED, not what SHOULD happen next. " +
  "The recent messages (preserved separately) already contain the current context.\n\n" +
  "Focus on technical precision. Include specific identifiers (file paths, function names, etc.) " +
  "that would be essential for continuation. Write in third person and maintain an objective, technical tone.";

const COMPACTION_USER_PROMPT =
  "Summarize the conversation above into a concise summary following the instructions. Output only the summary, nothing else.";

export interface CompactionResult {
  /** Whether messages were actually reduced. */
  compacted: boolean;
  /** Why compaction was skipped (only set when compacted is false). */
  reason?: string;
  originalCount: number;
  newCount: number;
  tokensBeforeEstimate: number;
  tokensAfterEstimate: number;
}

/**
 * Default token reserve for compaction.
 * Leaves headroom for the model's next response + system overhead.
 * Matches the widely-used Pi / Grok-CLI default of 16 384 tokens.
 */
export const COMPACTION_RESERVE_TOKENS = 16_384;

/** Minimum messages before compaction is attempted (Mysti uses 4). */
const COMPACTION_MIN_MESSAGES = 4;

/**
 * Check if compaction should be triggered.
 *
 * Uses the reserve-based approach (contextWindow − reserveTokens) used by
 * Pi, Grok-CLI, OpenClaw, BrowserOS, and most real-world agent frameworks.
 * A percentage-based threshold is still supported: when both are supplied the
 * more conservative (lower) limit wins.
 */
export function shouldCompact(
  messages: Message[],
  contextWindow: number,
  threshold = 0.8,
  /** Actual API-reported token count — preferred over char-based estimate when available. */
  actualTokens?: number,
  /** Fixed token reserve subtracted from contextWindow. Defaults to 16 384. */
  reserveTokens = COMPACTION_RESERVE_TOKENS,
): boolean {
  // Don't attempt compaction with too few messages — compact() would bail
  // anyway (middleMessages <= 2), but this avoids the spinner + LLM auth dance.
  // Skip the guard when actualTokens is provided (force-compact / overflow paths
  // where the caller has precise token info regardless of message count).
  if (actualTokens == null && messages.length < COMPACTION_MIN_MESSAGES) {
    log("INFO", "compaction", `Context check: skipping — only ${messages.length} messages`);
    return false;
  }
  const estimated = actualTokens ?? estimateConversationTokens(messages);
  const percentageLimit = contextWindow * threshold;
  // Only apply the fixed reserve when the context window is large enough
  // that the reserve is meaningful (< 50% of the window).
  const limit =
    reserveTokens > 0 && reserveTokens < contextWindow * 0.5
      ? Math.min(percentageLimit, contextWindow - reserveTokens)
      : percentageLimit;
  const source = actualTokens != null ? "actual" : "estimated";
  log("INFO", "compaction", `Context check: ${estimated} ${source} tokens, threshold ${limit}`);
  return estimated > limit;
}

/**
 * Find the index where recent messages should start, given a token budget.
 * Walks backward from the end, accumulating token estimates, and returns the
 * first index that fits within the budget. Never cuts at index 0 (system message).
 * Avoids splitting tool_call / tool_result pairs.
 */
export function findRecentCutPoint(messages: Message[], tokenBudget: number): number {
  if (messages.length <= 1) return messages.length;

  let accumulated = 0;
  let cutIndex = messages.length;

  // Walk backwards from the last message
  for (let i = messages.length - 1; i >= 1; i--) {
    const tokens = estimateMessageTokens(messages[i]);
    if (accumulated + tokens > tokenBudget) {
      break;
    }
    accumulated += tokens;
    cutIndex = i;
  }

  // Don't split tool_call and tool_result pairs:
  // If cut lands on a tool result message, back up past all consecutive tool
  // messages and the preceding assistant message that triggered them.
  while (cutIndex > 1 && cutIndex < messages.length && messages[cutIndex].role === "tool") {
    cutIndex--;
  }

  // Never cut before index 1 (preserve system message at 0)
  cutIndex = Math.max(1, cutIndex);

  // Always keep at least the last user→assistant exchange so that compaction
  // never produces an empty recentMessages array. Without this, the trailing-
  // assistant-pop can strip the compaction ack, leaving only the summary and
  // making `ggcoder continue` restore just 1 message.
  if (cutIndex >= messages.length && messages.length > 2) {
    // Find the last user message and keep everything from there onward
    for (let i = messages.length - 1; i >= 1; i--) {
      if (messages[i].role === "user") {
        cutIndex = i;
        break;
      }
    }
    // Fallback: at minimum keep the last 2 messages
    cutIndex = Math.min(cutIndex, messages.length - 2);
    cutIndex = Math.max(1, cutIndex);
  }

  return cutIndex;
}

/**
 * Truncate a string, appending a note about how much was removed.
 */
function truncateString(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * Extract file paths from tool calls in assistant messages for tracking.
 */
function extractFileOperations(messages: Message[]): { read: Set<string>; modified: Set<string> } {
  const read = new Set<string>();
  const modified = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") continue;
    if (!Array.isArray(msg.content)) continue;

    for (const part of msg.content as ContentPart[]) {
      if (!("type" in part) || part.type !== "tool_call") continue;
      const tc = part as ContentPart & {
        type: "tool_call";
        name: string;
        args: Record<string, unknown>;
      };
      const filePath = tc.args.file_path ?? tc.args.path ?? tc.args.file;
      if (typeof filePath !== "string") continue;

      if (tc.name === "read" || tc.name === "grep" || tc.name === "find") {
        read.add(filePath);
      } else if (tc.name === "write" || tc.name === "edit") {
        modified.add(filePath);
      }
    }
  }

  return { read, modified };
}

/**
 * Convert a tool_call ContentPart to a text representation so the summarizer
 * can see tool usage without requiring tool_use/tool_result pairing.
 */
function toolCallToText(
  tc: ContentPart & { type: "tool_call"; name: string; args: Record<string, unknown> },
): string {
  const argsStr = Object.entries(tc.args)
    .map(([k, v]) => `${k}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`)
    .join("\n");
  return `[Tool Call: ${tc.name}]\n${argsStr}`;
}

/**
 * Convert a ToolResult to a text representation.
 */
function toolResultToText(tr: ToolResult): string {
  const prefix = tr.isError ? "[Tool Error]" : "[Tool Result]";
  return `${prefix}\n${truncateString(tr.content, TOOL_RESULT_MAX_CHARS)}`;
}

/**
 * Prepare conversation messages for the summarizer by converting tool_call and
 * tool_result blocks to plain text, stripping thinking blocks, and truncating
 * large content. Converting tool blocks to text eliminates the tool_use/tool_result
 * pairing constraint entirely — the summarizer sees only user/assistant text messages.
 * Returns lightweight copies — the originals are not mutated.
 */
export function prepareMessagesForSummary(msgs: Message[]): Message[] {
  const converted = msgs.map((msg): Message => {
    // Tool result messages — convert to user text message
    if (msg.role === "tool") {
      const results = msg.content as ToolResult[];
      const text = results.map((tr) => toolResultToText(tr)).join("\n\n");
      return { role: "user", content: text };
    }

    // Assistant messages with ContentPart[] — convert tool_calls to text, strip thinking
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const parts = (msg.content as ContentPart[])
        .filter((p) => p.type !== "thinking") // strip thinking blocks
        .map((p): ContentPart => {
          if (p.type === "text") {
            return { ...p, text: truncateString(p.text, TOOL_RESULT_MAX_CHARS) };
          }
          if (p.type === "tool_call") {
            return {
              type: "text",
              text: toolCallToText(
                p as ContentPart & {
                  type: "tool_call";
                  name: string;
                  args: Record<string, unknown>;
                },
              ),
            };
          }
          return p;
        });
      return { role: "assistant", content: parts.length > 0 ? parts : "" };
    }

    // User string messages — truncate very long prompts
    if (msg.role === "user" && typeof msg.content === "string") {
      return { role: "user", content: truncateString(msg.content, TOOL_RESULT_MAX_CHARS) };
    }

    return msg;
  });

  // Merge consecutive same-role messages that can appear after tool→user conversion
  // (e.g., assistant with tool_call followed by tool→user then real user).
  return mergeConsecutiveSameRole(converted);
}

/**
 * Merge consecutive messages with the same role into a single message.
 * This handles cases where tool→user conversion creates adjacent user messages,
 * which would violate the alternating user/assistant API requirement.
 */
function mergeConsecutiveSameRole(msgs: Message[]): Message[] {
  if (msgs.length === 0) return msgs;
  const merged: Message[] = [msgs[0]];

  for (let i = 1; i < msgs.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = msgs[i];
    if (prev.role === curr.role && (prev.role === "user" || prev.role === "assistant")) {
      // Merge into the previous message as a string
      const prevText = messageToString(prev);
      const currText = messageToString(curr);
      merged[merged.length - 1] = { role: prev.role, content: prevText + "\n\n" + currText };
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

/**
 * Extract string content from a message for merging purposes.
 */
function messageToString(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as ContentPart[])
      .filter((p): p is ContentPart & { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
  }
  return "";
}

/**
 * Check whether a message is an assistant message that contains tool_call blocks.
 */
function hasToolCalls(msg: Message): boolean {
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return false;
  return (msg.content as ContentPart[]).some((p) => p.type === "tool_call");
}

/**
 * Collect all tool_call IDs from an assistant message.
 */
function getToolCallIds(msg: Message): Set<string> {
  const ids = new Set<string>();
  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    for (const p of msg.content as ContentPart[]) {
      if (p.type === "tool_call")
        ids.add((p as ContentPart & { type: "tool_call"; id: string }).id);
    }
  }
  return ids;
}

/**
 * Collect all tool_result IDs (toolCallId) from a tool message.
 */
function getToolResultIds(msg: Message): Set<string> {
  const ids = new Set<string>();
  if (msg.role === "tool" && Array.isArray(msg.content)) {
    for (const tr of msg.content as ToolResult[]) {
      ids.add(tr.toolCallId);
    }
  }
  return ids;
}

/**
 * Repair tool_use / tool_result pairing in a message array (mutates in place).
 *
 * Two repair strategies matching real-world patterns (Roo-Code, openclaw):
 * 1. Strip orphaned tool_call blocks from assistant messages when the next
 *    message doesn't contain their matching tool_result.
 * 2. Remove orphaned tool messages whose tool_use assistant was dropped.
 */
function repairToolPairing(msgs: Message[]): void {
  // Build a set of all tool_call IDs and tool_result IDs in the conversation
  const allToolCallIds = new Set<string>();
  const allToolResultIds = new Set<string>();
  for (const msg of msgs) {
    for (const id of getToolCallIds(msg)) allToolCallIds.add(id);
    for (const id of getToolResultIds(msg)) allToolResultIds.add(id);
  }

  // Walk through and fix mismatches
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];

    // Remove tool messages whose tool_call IDs have no matching assistant
    if (msg.role === "tool" && Array.isArray(msg.content)) {
      const results = msg.content as ToolResult[];
      const kept = results.filter((tr) => allToolCallIds.has(tr.toolCallId));
      if (kept.length === 0) {
        msgs.splice(i, 1);
        continue;
      }
      if (kept.length < results.length) {
        (msgs[i] as { content: ToolResult[] }).content = kept;
      }
    }

    // Strip tool_call blocks from assistant messages that have no matching tool_result
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const parts = msg.content as ContentPart[];
      const hasOrphans = parts.some(
        (p) =>
          p.type === "tool_call" &&
          !allToolResultIds.has((p as ContentPart & { type: "tool_call"; id: string }).id),
      );
      if (hasOrphans) {
        const kept = parts.filter(
          (p) =>
            p.type !== "tool_call" ||
            allToolResultIds.has((p as ContentPart & { type: "tool_call"; id: string }).id),
        );
        if (kept.length === 0) {
          (msgs[i] as { content: string | ContentPart[] }).content = "";
        } else {
          (msgs[i] as { content: ContentPart[] }).content = kept;
        }
      }
    }
  }
}

/**
 * Select messages that fit within a token budget for the summary LLM call.
 * Walks forward from the start, accumulating messages until the budget is
 * exceeded. Ensures tool_use / tool_result pairs are never split: if the last
 * selected message is an assistant with tool_call blocks, it is removed so the
 * API never sees an orphaned tool_use without a matching tool_result.
 */
export function selectMessagesInBudget(msgs: Message[], tokenBudget: number): Message[] {
  let accumulated = 0;
  const selected: Message[] = [];

  for (const msg of msgs) {
    const tokens = estimateMessageTokens(msg);
    if (accumulated + tokens > tokenBudget) break;
    accumulated += tokens;
    selected.push(msg);
  }

  // Drop trailing assistant messages that have tool_call blocks without
  // their corresponding tool_result (which was cut by the budget).
  while (selected.length > 0 && hasToolCalls(selected[selected.length - 1])) {
    selected.pop();
  }

  return selected;
}

/**
 * Build a fallback summary from file operations and message roles when the
 * LLM summary call fails or returns empty.
 */
export function buildFallbackSummary(
  middleMessages: Message[],
  fileOps: { read: Set<string>; modified: Set<string> },
): string {
  const userMessages = middleMessages.filter((m) => m.role === "user");
  const toolCalls = middleMessages.filter((m) => m.role === "tool");

  const lines: string[] = [];
  lines.push("## Goal");
  if (userMessages.length > 0) {
    const firstContent =
      typeof userMessages[0].content === "string" ? userMessages[0].content : "(complex content)";
    lines.push(truncateString(firstContent, 500));
  } else {
    lines.push("(could not determine — no user messages in summarized segment)");
  }

  lines.push("");
  lines.push("## Progress");
  lines.push(
    `${middleMessages.length} messages exchanged, ${toolCalls.length} tool calls executed.`,
  );

  if (fileOps.read.size > 0) {
    lines.push("");
    lines.push("## Files Read");
    for (const f of fileOps.read) lines.push(`- ${f}`);
  }
  if (fileOps.modified.size > 0) {
    lines.push("");
    lines.push("## Files Modified");
    for (const f of fileOps.modified) lines.push(`- ${f}`);
  }

  return lines.join("\n");
}

/**
 * Extract summary text from an LLM response.
 */
export function extractSummaryText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");
}

/** Budget of recent tokens to keep un-summarized (~20K tokens). */
const KEEP_RECENT_TOKENS = 20_000;

/**
 * Compact a conversation by summarizing older messages via LLM.
 *
 * Follows the pattern used by Continue and Nao: sends the actual conversation
 * messages to the summarizer (not a serialized string), bookended by a system
 * prompt and a "summarize this" user prompt. This lets the LLM see the real
 * message structure — roles, tool calls, tool results — and produce a much
 * better summary.
 *
 * - Keeps the system message (index 0) intact.
 * - Keeps the most recent ~20K tokens of conversation intact.
 * - Summarizes everything in between using an appropriate model.
 * - Tool results are truncated and thinking blocks stripped in the summary call.
 * - Messages are token-budgeted to avoid overflowing the summarizer's context.
 * - Retries on empty responses, falls back to extractive summary if all fail.
 */
export async function compact(
  messages: Message[],
  options: {
    provider: Provider;
    model: string;
    apiKey?: string;
    contextWindow: number;
    signal?: AbortSignal;
    approvedPlanPath?: string;
  },
): Promise<{ messages: Message[]; result: CompactionResult }> {
  const originalCount = messages.length;
  const tokensBeforeEstimate = estimateConversationTokens(messages);

  log("INFO", "compaction", `Starting compaction`, {
    messageCount: String(originalCount),
    estimatedTokens: String(tokensBeforeEstimate),
    contextWindow: String(options.contextWindow),
  });

  // Find the cut point — keep ~20K tokens of recent conversation
  const systemMessage = messages[0];
  const recentStart = findRecentCutPoint(messages, KEEP_RECENT_TOKENS);
  const recentMessages = messages.slice(recentStart);
  const middleMessages = messages.slice(1, recentStart);

  log("INFO", "compaction", `Cut point analysis`, {
    recentStart: String(recentStart),
    totalMessages: String(messages.length),
    middleMessages: String(middleMessages.length),
    recentMessages: String(recentMessages.length),
    middleRoles: middleMessages.map((m) => m.role).join(","),
    recentRoles: recentMessages.map((m) => m.role).join(","),
  });

  // If there's nothing to compact, return as-is
  if (middleMessages.length <= 2) {
    log("INFO", "compaction", `Skipping compaction — too few messages to summarize`, {
      middleMessages: String(middleMessages.length),
      recentStart: String(recentStart),
      totalMessages: String(messages.length),
    });
    return {
      messages: [...messages],
      result: {
        compacted: false,
        reason: "too_few_messages",
        originalCount,
        newCount: messages.length,
        tokensBeforeEstimate,
        tokensAfterEstimate: tokensBeforeEstimate,
      },
    };
  }

  // Track file operations from the messages being summarized
  const fileOps = extractFileOperations(middleMessages);

  // Build file tracking section
  let fileTrackingSection = "";
  if (fileOps.read.size > 0 || fileOps.modified.size > 0) {
    const parts: string[] = [];
    if (fileOps.read.size > 0) {
      parts.push(`<read-files>\n${[...fileOps.read].join("\n")}\n</read-files>`);
    }
    if (fileOps.modified.size > 0) {
      parts.push(`<modified-files>\n${[...fileOps.modified].join("\n")}\n</modified-files>`);
    }
    fileTrackingSection = "\n\n" + parts.join("\n");
  }

  // Pick the appropriate model for summarization
  const summaryModel = getSummaryModel(options.provider, options.model);
  const summaryContextWindow = getContextWindow(summaryModel.id);

  // Prepare messages: truncate tool results, strip thinking blocks
  const preparedMessages = prepareMessagesForSummary(middleMessages);

  // Budget: summary model context - output tokens - system/user prompt overhead (~1K)
  const promptOverhead = 1000;
  const tokenBudget = summaryContextWindow - MAX_SUMMARY_OUTPUT_TOKENS - promptOverhead;
  const selectedMessages = selectMessagesInBudget(preparedMessages, tokenBudget);

  log("INFO", "compaction", `Summarizing ${middleMessages.length} messages`, {
    summaryModel: summaryModel.id,
    summaryContextWindow: String(summaryContextWindow),
    tokenBudget: String(tokenBudget),
    preparedMessages: String(preparedMessages.length),
    selectedMessages: String(selectedMessages.length),
    droppedMessages: String(preparedMessages.length - selectedMessages.length),
    filesRead: String(fileOps.read.size),
    filesModified: String(fileOps.modified.size),
    recentKept: String(recentMessages.length),
  });

  // Build the summary messages array following the Nao pattern:
  // [system, ...actual conversation messages, user prompt to summarize]
  // Add plan preservation instruction if an approved plan is active
  const planPreservation = options.approvedPlanPath
    ? `\n\n### APPROVED PLAN PRESERVATION\n` +
      `An approved implementation plan exists at: ${options.approvedPlanPath}\n` +
      `You MUST preserve all references to this plan and its approval status in the summary. ` +
      `The agent is following this plan for implementation — do not lose this context.`
    : "";

  const summaryMessages: Message[] = [
    { role: "system", content: COMPACTION_SYSTEM_PROMPT + planPreservation },
    ...selectedMessages,
    { role: "user", content: COMPACTION_USER_PROMPT },
  ];

  log("INFO", "compaction", `Calling summary LLM`, {
    provider: options.provider,
    model: summaryModel.id,
    messageCount: String(summaryMessages.length),
    hasApiKey: String(!!options.apiKey),
    apiKeyPrefix: options.apiKey ? options.apiKey.slice(0, 15) + "..." : "none",
  });

  // Call LLM with retries on empty responses
  let summaryText = "";
  for (let attempt = 0; attempt <= MAX_SUMMARY_RETRIES; attempt++) {
    try {
      const result = stream({
        provider: options.provider,
        model: summaryModel.id,
        messages: summaryMessages,
        maxTokens: MAX_SUMMARY_OUTPUT_TOKENS,
        apiKey: options.apiKey,
        signal: options.signal,
      });

      const response = await result.response;

      log("INFO", "compaction", `Summary LLM response received`, {
        attempt: String(attempt),
        stopReason: response.stopReason,
        inputTokens: String(response.usage.inputTokens),
        outputTokens: String(response.usage.outputTokens),
        contentType: typeof response.message.content,
        contentIsArray: String(Array.isArray(response.message.content)),
        contentLength:
          typeof response.message.content === "string"
            ? String(response.message.content.length)
            : String((response.message.content as ContentPart[]).length),
        contentPartTypes: Array.isArray(response.message.content)
          ? (response.message.content as ContentPart[]).map((p) => p.type).join(",")
          : "n/a",
      });

      summaryText = extractSummaryText(response.message.content);

      if (summaryText.length > 0) {
        log("INFO", "compaction", `Summary text extracted`, {
          summaryChars: String(summaryText.length),
          summaryPreview: summaryText.slice(0, 300),
        });
        break;
      }

      log("WARN", "compaction", `Summary LLM returned empty response`, {
        attempt: String(attempt),
        maxRetries: String(MAX_SUMMARY_RETRIES),
        outputTokens: String(response.usage.outputTokens),
      });
    } catch (err) {
      log(
        "WARN",
        "compaction",
        `Summary LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
        { attempt: String(attempt) },
      );
    }
  }

  // Fallback: build an extractive summary from message metadata
  if (summaryText.length === 0) {
    log("WARN", "compaction", `All summary attempts failed — using fallback extractive summary`);
    summaryText = buildFallbackSummary(middleMessages, fileOps);
  }

  // Build new messages array
  const summaryMessage: Message = {
    role: "user",
    content: `[Previous conversation summary]\n\n${summaryText}${fileTrackingSection}`,
  };

  // Skip the assistant ack when recentMessages starts with an assistant message
  // to prevent consecutive assistant messages that the Anthropic API rejects.
  // This happens when findRecentCutPoint backs up from a tool to an assistant.
  const skipAck = recentMessages.length > 0 && recentMessages[0].role === "assistant";

  const newMessages: Message[] = [
    systemMessage,
    summaryMessage,
    ...(skipAck
      ? []
      : [
          {
            role: "assistant" as const,
            content: "Understood — I have the context from what was discussed earlier.",
          },
        ]),
    ...recentMessages,
  ];

  // Repair tool_use / tool_result pairing in the final message array.
  // Despite cut-point logic, edge cases (e.g., the trailing-assistant pop
  // below, or future code paths) could leave orphaned blocks.
  repairToolPairing(newMessages);

  // Ensure the conversation doesn't end with an assistant message.
  // Some models reject "assistant prefill" — the conversation must end
  // with a user (or tool) message so the LLM can generate a fresh response.
  // Never pop below the base messages (system + summary [+ ack]) — removing
  // those would leave only the summary, causing `ggcoder continue`
  // to restore just 1 message instead of the full session.
  const minMessages = skipAck ? 2 : 3;
  while (
    newMessages.length > minMessages &&
    newMessages[newMessages.length - 1].role === "assistant"
  ) {
    newMessages.pop();
  }

  const tokensAfterEstimate = estimateConversationTokens(newMessages);
  const reduction = Math.round((1 - tokensAfterEstimate / tokensBeforeEstimate) * 100);

  log("INFO", "compaction", `Compaction complete`, {
    originalMessages: String(originalCount),
    newMessages: String(newMessages.length),
    tokensBefore: String(tokensBeforeEstimate),
    tokensAfter: String(tokensAfterEstimate),
    reduction: `${reduction}%`,
    newMessageRoles: newMessages.map((m) => m.role).join(","),
    summaryMessagePreview:
      typeof summaryMessage.content === "string"
        ? summaryMessage.content.slice(0, 300)
        : "(non-string)",
  });

  return {
    messages: newMessages,
    result: {
      compacted: true,
      originalCount,
      newCount: newMessages.length,
      tokensBeforeEstimate,
      tokensAfterEstimate,
    },
  };
}
