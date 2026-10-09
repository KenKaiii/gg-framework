import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type {
  AssistantMessage,
  CacheRetention,
  ContentPart,
  ImageContent,
  Message,
  Provider,
  StopReason,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
  VideoContent,
  Tool,
  ToolChoice,
  ToolResultContent,
} from "../types.js";
import { resolveToolSchema, zodToJsonSchema } from "../utils/zod-to-json-schema.js";
import { makeStrictToolSchema, UnsupportedStrictSchemaError } from "../utils/strict-tool-schema.js";
import { DEFAULT_REASONING_FIELD } from "./reasoning-field.js";

// ── Shared helpers ─────────────────────────────────────────

/**
 * A thinking block is only safe to round-trip to Anthropic as a real `thinking`
 * block when it carries a genuinely non-empty signature. Empty or whitespace-
 * only signatures (e.g. from an interrupted stream that never received its
 * `signature_delta`, or from non-Anthropic providers) would be rejected with
 * "thinking ... blocks cannot be modified", so they are downgraded to text.
 */
function hasValidThinkingSignature(part: ThinkingContent): boolean {
  return typeof part.signature === "string" && part.signature.trim().length > 0;
}

/** True for `raw` parts that wrap a thinking / redacted_thinking wire block. */
function isRawThinking(part: ContentPart): boolean {
  if (part.type !== "raw") return false;
  const t = part.data.type;
  return t === "thinking" || t === "redacted_thinking";
}

/**
 * Content block `type`s Anthropic accepts as message input. A `raw` part can
 * originate from another provider (e.g. the OpenAI Codex provider round-trips its
 * encrypted reasoning item as `{ type: "raw", data: { type: "reasoning", … } }`).
 * Switching such a session to an Anthropic model would otherwise forward that
 * foreign block verbatim and Anthropic rejects it ("Input tag 'reasoning' … does
 * not match any of the expected tags"). Raw blocks whose wire type isn't in this
 * set are dropped on the way out.
 */
const ANTHROPIC_INPUT_BLOCK_TYPES = new Set<string>([
  "bash_code_execution_tool_result",
  "code_execution_tool_result",
  "connector_text",
  "container_upload",
  "document",
  // Server-side refusal fallback marker. Only reaches the wire when the request
  // carries the server-side-fallback beta; otherwise applyServerFallbackReplay
  // strips it first (see toAnthropicMessages' `fallbackBlocks` option).
  "fallback",
  "image",
  "mid_conv_system",
  "redacted_thinking",
  "search_result",
  "server_tool_use",
  "text",
  "text_editor_code_execution_tool_result",
  "thinking",
  "tool_result",
  "tool_search_tool_result",
  "tool_use",
  "web_fetch_tool_result",
  "web_search_tool_result",
]);

/** True for a `raw` part Anthropic will accept as an input content block. */
function isAnthropicCompatibleRaw(part: Extract<ContentPart, { type: "raw" }>): boolean {
  return ANTHROPIC_INPUT_BLOCK_TYPES.has(part.data.type as string);
}

/**
 * True for content parts that Anthropic treats as position-sensitive reasoning
 * blocks in the latest assistant message: SIGNED `thinking` blocks and
 * `redacted_thinking` blocks (round-tripped as opaque `raw`). Unsigned thinking
 * (e.g. from GLM/OpenAI or an aborted stream) is excluded — it is converted to a
 * text block on the way out, so it carries no signature for Anthropic to validate
 * and imposes no positional constraint.
 */
function isPositionSensitiveThinking(part: ContentPart): boolean {
  if (part.type === "thinking") return hasValidThinkingSignature(part);
  return isRawThinking(part);
}

/** True for a round-tripped server-side refusal `fallback` block. */
export function isServerFallbackBlock(part: ContentPart): boolean {
  return part.type === "raw" && part.data.type === "fallback";
}

/**
 * Apply Anthropic's server-side-fallback replay rules to one assistant turn.
 *
 * After a mid-output fallback the turn holds blocks from the declining model,
 * then a `fallback` marker, then the serving model's output. Per the API's
 * replay table, blocks BEFORE the final `fallback` block are filtered:
 * thinking / redacted_thinking / connector_text and client `tool_use` are
 * dropped; `server_tool_use` is kept only when its result is present; text is
 * kept. Everything after the final marker is kept, and the markers themselves
 * stay exactly where they appeared (the API validates thinking blocks by their
 * position relative to them).
 *
 * `keepMarkers: false` is for routes that don't accept fallback blocks
 * (Bedrock/Vertex/proxies, or once the beta was rejected): the same filtering
 * still applies, so no thinking block from before the boundary survives, and
 * the markers are then removed. Ids of dropped client tool calls are added to
 * `droppedToolCallIds` so their tool_result blocks can be dropped too.
 *
 * Returns the input unchanged when the turn contains no fallback block, and an
 * empty array when nothing but fallback markers would remain.
 */
export function applyServerFallbackReplay(
  content: ContentPart[],
  keepMarkers: boolean,
  droppedToolCallIds?: Set<string>,
): ContentPart[] {
  let lastFallbackIdx = -1;
  content.forEach((part, idx) => {
    if (isServerFallbackBlock(part)) lastFallbackIdx = idx;
  });
  if (lastFallbackIdx === -1) return content;

  const resultIds = new Set<string>();
  for (const part of content) {
    if (part.type === "server_tool_result") resultIds.add(part.toolUseId);
    else if (part.type === "raw" && typeof part.data.tool_use_id === "string")
      resultIds.add(part.data.tool_use_id);
  }

  const out: ContentPart[] = [];
  content.forEach((part, idx) => {
    if (isServerFallbackBlock(part)) {
      if (keepMarkers) out.push(part);
      return;
    }
    if (idx < lastFallbackIdx) {
      if (part.type === "thinking" || isRawThinking(part)) return;
      if (part.type === "raw" && part.data.type === "connector_text") return;
      if (part.type === "tool_call") {
        droppedToolCallIds?.add(part.id);
        return;
      }
      if (part.type === "server_tool_call" && !resultIds.has(part.id)) return;
      if (
        part.type === "raw" &&
        part.data.type === "server_tool_use" &&
        !resultIds.has(String(part.data.id))
      )
        return;
    }
    out.push(part);
  });
  // Markers alone (e.g. every model in the chain declined) carry no output to
  // anchor; replaying a marker-only assistant turn would be an empty turn.
  return out.every(isServerFallbackBlock) ? [] : out;
}

/** Map a single assistant content part to its Anthropic wire block (or null to drop). */
function toAnthropicAssistantPart(
  part: ContentPart,
  idMap: Map<string, string>,
): Anthropic.ContentBlockParam | null {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "thinking") {
    // Signed thinking round-trips verbatim. Unsigned/invalid-signature thinking
    // (GLM/OpenAI, or an aborted Anthropic stream) has nothing for Anthropic to
    // validate and would be rejected as a thinking block, so preserve its
    // reasoning as a text block instead of discarding it.
    const sig = part.signature;
    return sig && sig.trim().length > 0
      ? { type: "thinking", thinking: part.text, signature: sig }
      : { type: "text", text: part.text };
  }
  if (part.type === "tool_call")
    return {
      type: "tool_use",
      id: remapAnthropicToolCallId(part.id, idMap),
      name: part.name,
      input: part.args,
    };
  if (part.type === "server_tool_call")
    return {
      type: "server_tool_use",
      id: part.id,
      name: part.name,
      input: part.input,
    } as unknown as Anthropic.ContentBlockParam;
  if (part.type === "server_tool_result")
    return part.data as unknown as Anthropic.ContentBlockParam;
  if (part.type === "raw")
    return isAnthropicCompatibleRaw(part)
      ? (part.data as unknown as Anthropic.ContentBlockParam)
      : null;
  // Unknown content type (e.g. image in assistant message) — drop it.
  return null;
}

/**
 * Build an assistant message's Anthropic content blocks.
 *
 * Anthropic requires thinking blocks to be preserved for the duration of the
 * ACTIVE trajectory — every assistant turn from the last real user message
 * forward (a multi-step tool loop has no user message between steps, so each
 * read/grep/edit turn is part of the same trajectory). The cookbook is explicit:
 * a final assistant message must start with a thinking block preceding the
 * lastmost tool_use/tool_result set, and previous-turn thinking should be kept.
 * Stripping reasoning from earlier in-trajectory turns leaves the model with a
 * bare tool_use → result chain and no reasoning anchor, which can degenerate the
 * next turn's leading token.
 *
 * For SETTLED turns (before the last user message), keeping signed thinking just
 * makes history fragile — any later edit, compaction, or reorder invalidates the
 * signature and triggers "thinking ... blocks cannot be modified". So thinking
 * and redacted_thinking are stripped there (tool_use and text survive). Within
 * the active trajectory they are preserved byte-identical (signed) or downgraded
 * to text (unsigned).
 */
function toAnthropicAssistantContent(
  content: ContentPart[],
  preserveThinking: boolean,
  idMap: Map<string, string>,
): Anthropic.ContentBlockParam[] {
  if (!preserveThinking) {
    return content
      .filter((part) => {
        if (part.type === "thinking" || isRawThinking(part)) return false;
        // Anthropic rejects empty text content blocks.
        if (part.type === "text" && !part.text) return false;
        return true;
      })
      .map((part) => toAnthropicAssistantPart(part, idMap))
      .filter((b): b is Anthropic.ContentBlockParam => b !== null);
  }

  // Active-trajectory assistant turn: thinking/redacted_thinking blocks are byte-identical
  // AND position-sensitive (interleaved-thinking-2025-05-14). Dropping a block
  // that PRECEDES a thinking block shifts that block's index, which the API
  // rejects, so empty text blocks before the last thinking block are kept;
  // empty text after it can be dropped safely.
  const lastThinkingIdx = content.reduce(
    (last, part, idx) => (isPositionSensitiveThinking(part) ? idx : last),
    -1 as number,
  );
  return content
    .filter((part, idx) => {
      // Drop empty, signature-less thinking blocks — nothing to preserve.
      if (part.type === "thinking" && !hasValidThinkingSignature(part) && !part.text) return false;
      if (part.type === "text" && !part.text && idx > lastThinkingIdx) return false;
      return true;
    })
    .map((part) => toAnthropicAssistantPart(part, idMap))
    .filter((b): b is Anthropic.ContentBlockParam => b !== null);
}

const PROVIDER_IMAGE_LIMIT_PLACEHOLDER = "[image omitted: provider image limit]";

const PROVIDER_IMAGE_BUDGETS: Partial<Record<Provider, number>> = {
  anthropic: 90,
  minimax: 90,
  openai: 200,
  gemini: 200,
  openrouter: 90,
};

function countContextImages(messages: Message[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role === "user" && Array.isArray(message.content)) {
      count += message.content.filter((part) => part.type === "image").length;
    } else if (message.role === "tool") {
      for (const result of message.content) {
        if (Array.isArray(result.content)) {
          count += result.content.filter((part) => part.type === "image").length;
        }
      }
    }
  }
  return count;
}

/** Largest batch of oldest images dropped together once a conversation is over budget. */
const IMAGE_DROP_BATCH = 30;

/**
 * Images to drop: the overflow rounded up to a whole batch. Dropping one image per new image
 * rewrote the start of the conversation on every request and broke the prompt cache: a
 * 125-image Motion session re-sent ~270k tokens on 7 of 16 turns. Rounded, the cut holds
 * still until a batch of new images arrives. Batches stay under a third of the budget.
 */
export function providerImageDropCount(imageCount: number, budget: number): number {
  const overflow = imageCount - budget;
  if (overflow <= 0) return 0;
  const batch = Math.max(1, Math.min(IMAGE_DROP_BATCH, Math.floor(budget / 3)));
  return Math.min(imageCount, Math.ceil(overflow / batch) * batch);
}

/**
 * Cap historical images before provider dispatch, removing the oldest first, in batches so the
 * cached conversation prefix stays byte-identical between requests.
 * The persisted/live conversation is never mutated; only modified messages and
 * tool results are cloned for the outgoing request.
 */
export function clampProviderContextImages(
  messages: Message[],
  provider: Provider,
  supportsImages: boolean | undefined,
): Message[] {
  if (supportsImages === false) return messages;
  const budget = PROVIDER_IMAGE_BUDGETS[provider] ?? 5;
  let remainingToRemove = providerImageDropCount(countContextImages(messages), budget);
  if (remainingToRemove <= 0) return messages;

  return messages.map((message): Message => {
    if (message.role === "user" && Array.isArray(message.content)) {
      const content = message.content.filter((part) => {
        if (part.type !== "image" || remainingToRemove <= 0) return true;
        remainingToRemove--;
        return false;
      });
      return {
        ...message,
        content:
          content.length > 0
            ? content
            : [{ type: "text" as const, text: PROVIDER_IMAGE_LIMIT_PLACEHOLDER }],
      };
    }
    if (message.role === "tool") {
      return {
        ...message,
        content: message.content.map((result) => {
          if (!Array.isArray(result.content)) return result;
          const content = result.content.filter((part) => {
            if (part.type !== "image" || remainingToRemove <= 0) return true;
            remainingToRemove--;
            return false;
          });
          return {
            ...result,
            content:
              content.length > 0
                ? content
                : [{ type: "text" as const, text: PROVIDER_IMAGE_LIMIT_PLACEHOLDER }],
          };
        }),
      };
    }
    return message;
  });
}

// ── Tool-call name sanitization ───────────────────────────

/**
 * What a provider accepts as a replayed tool-call name. `pattern` already
 * encodes the length limit where the provider documents one; `maxLength` is
 * checked separately so the generic rule can cap length without a charset.
 */
export interface ToolCallNameRule {
  /** Short identifier, for diagnostics and tests. */
  id: "anthropic" | "openai-chat" | "openai-responses" | "gemini" | "generic";
  maxLength: number;
  pattern?: RegExp;
}

/**
 * Per-transport tool-name rules. A legitimate call always carries the name of a
 * tool we declared, and tool declarations are validated against these same
 * rules, so only model-invented names (blank, invocation text stuffed into the
 * name slot, …) can fail them.
 */
export const TOOL_CALL_NAME_RULES: Record<ToolCallNameRule["id"], ToolCallNameRule> = {
  // Anthropic Messages API: tool / tool_use name `^[a-zA-Z0-9_-]{1,128}$`.
  anthropic: { id: "anthropic", maxLength: 128, pattern: /^[a-zA-Z0-9_-]{1,128}$/ },
  // OpenAI Chat Completions: function name a-z A-Z 0-9 _ -, max length 64.
  "openai-chat": { id: "openai-chat", maxLength: 64, pattern: /^[a-zA-Z0-9_-]{1,64}$/ },
  // OpenAI Responses (Codex): same charset; replayed `input[N].name` over 128
  // chars is rejected with `string_above_max_length`.
  "openai-responses": {
    id: "openai-responses",
    maxLength: 128,
    pattern: /^[a-zA-Z0-9_-]{1,128}$/,
  },
  // Gemini FunctionDeclaration name: starts with a letter or underscore, then
  // a-z A-Z 0-9 _ . : -, max length 128.
  gemini: { id: "gemini", maxLength: 128, pattern: /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,127}$/ },
  // OpenAI-compatible third parties (GLM, Kimi, DeepSeek, OpenRouter, xAI,
  // local servers, MiniMax, …) don't share one documented charset, so only
  // reject what no declared tool name can contain: blank, >128 chars, or any
  // whitespace / control character (the signature of invocation text).
  generic: { id: "generic", maxLength: 128 },
};

const TOOL_NAME_FORBIDDEN_CHARS = /[\s\p{Cc}]/u;

/** True when `name` is a tool-call name the provider described by `rule` will accept. */
export function isValidToolCallName(name: unknown, rule: ToolCallNameRule): boolean {
  if (typeof name !== "string" || name.trim().length === 0) return false;
  if (name.length > rule.maxLength) return false;
  if (TOOL_NAME_FORBIDDEN_CHARS.test(name)) return false;
  return rule.pattern ? rule.pattern.test(name) : true;
}

function isDefaultOrHost(baseUrl: string | undefined, host: string): boolean {
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).hostname === host;
  } catch {
    return false;
  }
}

/**
 * Pick the tool-name rule for the transport a request will actually use. Mirrors
 * the routing in `stream.ts`: `openai` with an `accountId` is the Codex
 * (Responses) endpoint, MiniMax rides the Anthropic transport but is a third
 * party, and an `openai` pointed at a custom baseUrl is an unknown compatible
 * server.
 */
export function toolCallNameRuleFor(
  provider: Provider | string,
  options?: { accountId?: string; baseUrl?: string },
): ToolCallNameRule {
  switch (provider) {
    case "anthropic":
      return TOOL_CALL_NAME_RULES.anthropic;
    case "openai":
      if (options?.accountId) return TOOL_CALL_NAME_RULES["openai-responses"];
      return isDefaultOrHost(options?.baseUrl, "api.openai.com")
        ? TOOL_CALL_NAME_RULES["openai-chat"]
        : TOOL_CALL_NAME_RULES.generic;
    case "gemini":
      return TOOL_CALL_NAME_RULES.gemini;
    default:
      return TOOL_CALL_NAME_RULES.generic;
  }
}

/** A blank tool-call id can't be paired or sent (Anthropic id pattern is `+`). */
function isValidToolCallId(id: unknown): boolean {
  return typeof id === "string" && id.trim().length > 0;
}

/** Raw OpenAI Responses reasoning item (round-tripped by the Codex provider). */
function isRawReasoning(part: ContentPart): boolean {
  return part.type === "raw" && part.data.type === "reasoning";
}

/**
 * A Responses reasoning item must be followed by the output item it produced;
 * replaying one with nothing after it (or straight into another reasoning item)
 * is rejected. True when the reasoning part at `idx` has no output after it.
 */
function isDanglingReasoning(parts: ContentPart[], idx: number): boolean {
  for (let i = idx + 1; i < parts.length; i++) {
    const next = parts[i]!;
    if (isRawReasoning(next)) return true;
    if (next.type === "text" || next.type === "tool_call") return false;
  }
  return true;
}

/**
 * Whether an assistant turn still has something a provider will replay.
 * Thinking / reasoning / fallback markers alone are not a turn: every converter
 * skips (or the API rejects) an assistant message made only of those.
 */
function hasReplayableAssistantContent(parts: ContentPart[]): boolean {
  return parts.some((part) => {
    if (part.type === "text") return part.text.length > 0;
    if (part.type === "thinking") return false;
    if (part.type === "raw") {
      const t = part.data.type;
      return !(
        t === "thinking" ||
        t === "redacted_thinking" ||
        t === "reasoning" ||
        t === "fallback"
      );
    }
    return true;
  });
}

/**
 * Drop assistant tool calls whose name (or id) the target provider rejects,
 * together with the tool results that answer them.
 *
 * One malformed call — a blank name, a whole invocation string written into the
 * name slot, a name over the provider's length limit — would otherwise sit in
 * history and 400 every later request (`tool_use.name: String should match
 * pattern`, `string_above_max_length`, …), wedging the session.
 *
 * Pairing is positional per window: each assistant turn opens a window, and its
 * results (role `tool`) are matched FIFO per id until the next assistant or user
 * message, so a reused id never consumes another turn's result. Valid sibling
 * calls, text and thinking are kept in place. An assistant turn left with
 * nothing replayable is removed whole, as is a tool message left empty — every
 * transport accepts the resulting adjacent user turns (the Anthropic API
 * combines consecutive same-role turns). A Codex reasoning item orphaned by the
 * drop is removed too. If the drop would leave the request ENDING on that
 * pruned assistant turn (its only call was the bad one, so no results follow),
 * the turn is removed as well: a trailing assistant message is an assistant
 * prefill, which current Claude models reject and other APIs treat as a
 * continuation rather than a fresh turn.
 *
 * Returns the input array untouched when nothing is malformed.
 */
export function dropInvalidToolCalls(messages: Message[], rule: ToolCallNameRule): Message[] {
  const isInvalid = (part: ContentPart): boolean =>
    part.type === "tool_call" &&
    (!isValidToolCallName(part.name, rule) || !isValidToolCallId(part.id));

  const hasInvalid = messages.some(
    (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some(isInvalid),
  );
  if (!hasInvalid) return messages;

  const out: Message[] = [];
  // id → FIFO of keep(true)/drop(false) for the calls of the current window.
  let pending = new Map<string, boolean[]>();
  let prunedAssistant: AssistantMessage | null = null;

  for (const msg of messages) {
    if (msg.role === "user" || msg.role === "system") {
      if (msg.role === "user") pending = new Map();
      out.push(msg);
      continue;
    }

    if (msg.role === "assistant") {
      pending = new Map();
      if (typeof msg.content === "string") {
        out.push(msg);
        continue;
      }
      const original = msg.content;
      let dropped = false;
      const kept: ContentPart[] = [];
      for (const part of original) {
        if (part.type === "tool_call") {
          const keep = !isInvalid(part);
          const queue = pending.get(part.id) ?? [];
          queue.push(keep);
          pending.set(part.id, queue);
          if (!keep) {
            dropped = true;
            continue;
          }
        }
        kept.push(part);
      }
      if (!dropped) {
        out.push(msg);
        continue;
      }
      // Remove only reasoning items the drop orphaned — never one that was
      // already dangling in the original (not ours to change).
      const content = kept.filter(
        (part, idx) =>
          !isRawReasoning(part) ||
          !isDanglingReasoning(kept, idx) ||
          isDanglingReasoning(original, original.indexOf(part)),
      );
      if (hasReplayableAssistantContent(content)) {
        const pruned: AssistantMessage = { ...msg, content };
        out.push(pruned);
        prunedAssistant = pruned;
      }
      continue;
    }

    // role === "tool"
    let changed = false;
    const results = msg.content.filter((result) => {
      const queue = pending.get(result.toolCallId);
      const keep = queue && queue.length > 0 ? queue.shift()! : true;
      if (!keep) changed = true;
      return keep;
    });
    if (!changed) out.push(msg);
    else if (results.length > 0) out.push({ ...msg, content: results });
  }

  if (prunedAssistant && out[out.length - 1] === prunedAssistant) out.pop();
  return out;
}

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
const NON_VIDEO_USER_PLACEHOLDER = "(video omitted: model does not support video)";

/** Replace image blocks with a text placeholder (deduping consecutive placeholders). */
function stripImages<T extends TextContent | ImageContent | VideoContent>(
  content: T[],
  placeholder: string,
): (Exclude<T, ImageContent> | TextContent)[] {
  const out: (Exclude<T, ImageContent> | TextContent)[] = [];
  let lastWasPlaceholder = false;
  for (const block of content) {
    if (block.type === "image") {
      if (!lastWasPlaceholder) out.push({ type: "text", text: placeholder });
      lastWasPlaceholder = true;
      continue;
    }
    out.push(block as Exclude<T, ImageContent>);
    lastWasPlaceholder = block.type === "text" && block.text === placeholder;
  }
  return out;
}

/** Replace video blocks with a text placeholder (deduping consecutive placeholders). */
function stripVideos(
  content: (TextContent | ImageContent | VideoContent)[],
  placeholder: string,
): (TextContent | ImageContent)[] {
  const out: (TextContent | ImageContent)[] = [];
  let lastWasPlaceholder = false;
  for (const block of content) {
    if (block.type === "video") {
      if (!lastWasPlaceholder) out.push({ type: "text", text: placeholder });
      lastWasPlaceholder = true;
      continue;
    }
    out.push(block);
    lastWasPlaceholder = block.type === "text" && block.text === placeholder;
  }
  return out;
}

/**
 * Pre-transform pass: when the target model doesn't support video, replace
 * video blocks in user messages with a text placeholder. Tool results never
 * carry video, so only user messages are scanned.
 */
export function downgradeUnsupportedVideos(
  messages: Message[],
  supportsVideo: boolean | undefined,
): Message[] {
  if (supportsVideo === true) return messages;
  return messages.map((msg) => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      return { ...msg, content: stripVideos(msg.content, NON_VIDEO_USER_PLACEHOLDER) };
    }
    return msg;
  });
}

/**
 * Pre-transform pass: when the target model doesn't support images, replace
 * image blocks in user messages and tool_result messages with a text placeholder.
 * Called before provider-specific transforms.
 */
export function downgradeUnsupportedImages(
  messages: Message[],
  supportsImages: boolean | undefined,
): Message[] {
  if (supportsImages !== false) return messages;
  return messages.map((msg) => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      return { ...msg, content: stripImages(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER) };
    }
    if (msg.role === "tool") {
      return {
        ...msg,
        content: msg.content.map((tr) =>
          Array.isArray(tr.content)
            ? {
                ...tr,
                content: stripImages(tr.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
              }
            : tr,
        ),
      };
    }
    return msg;
  });
}

/** Extract concatenated text from tool_result content (array or string). */
export function toolResultText(content: ToolResultContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Extract image blocks from tool_result content. Returns empty array for string content. */
function toolResultImages(content: ToolResultContent): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ImageContent => b.type === "image");
}

/** Extract video blocks from tool_result content. Returns empty array for string content. */
function toolResultVideos(content: ToolResultContent): VideoContent[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is VideoContent => b.type === "video");
}

// ── Anthropic Transforms ───────────────────────────────────

export function toAnthropicCacheControl(
  retention: CacheRetention | undefined,
  baseUrl: string | undefined,
): { type: "ephemeral"; ttl?: "1h" } | undefined {
  const resolved = retention ?? "short";
  if (resolved === "none") return undefined;
  const ttl =
    resolved === "long" && (!baseUrl || baseUrl.includes("api.anthropic.com")) ? "1h" : undefined;
  return { type: "ephemeral", ...(ttl && { ttl }) } as { type: "ephemeral"; ttl?: "1h" };
}

type AnthropicImageSource = {
  type: "base64";
  media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
};

/**
 * Convert tool_result content to Anthropic's wire format. Strings pass through;
 * arrays are mapped to Anthropic's (text | image) block format, which
 * tool_result.content accepts natively.
 */
type AnthropicToolResultBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AnthropicImageSource }
  | { type: "video"; source: { type: "base64"; media_type: string; data: string } };

function toAnthropicToolResultContent(
  content: ToolResultContent,
): string | AnthropicToolResultBlock[] {
  if (typeof content === "string") return content;
  return content.map((block): AnthropicToolResultBlock => {
    if (block.type === "text") return { type: "text" as const, text: block.text };
    // Video blocks (e.g. read on a .mp4 for MiniMax) use the same base64 video
    // shape as inline user content. Real Anthropic models are supportsVideo:false
    // so they never reach here; this serves the Anthropic-compatible MiniMax API.
    if (block.type === "video") {
      return {
        type: "video" as const,
        source: { type: "base64" as const, media_type: block.mediaType, data: block.data },
      };
    }
    return {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: block.mediaType as AnthropicImageSource["media_type"],
        data: block.data,
      },
    };
  });
}

/**
 * Anthropic requires tool_use IDs to match `^[a-zA-Z0-9_-]+$`. Codex tool IDs
 * are composite (`callId|itemId`) and other providers may include dots/colons.
 * Replace any disallowed characters with `_` and memoize so the assistant's
 * tool_use ID matches the corresponding tool_result.tool_use_id.
 */
function remapAnthropicToolCallId(id: string, idMap: Map<string, string>): string {
  if (/^[a-zA-Z0-9_-]+$/.test(id)) return id;
  const existing = idMap.get(id);
  if (existing) return existing;
  const mapped = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  idMap.set(id, mapped);
  return mapped;
}

export function toAnthropicMessages(
  messages: Message[],
  cacheControl?: { type: "ephemeral"; ttl?: "1h" },
  options?: {
    /** Replay server-side refusal `fallback` blocks in place. Only set when the
     * request carries the server-side-fallback beta; otherwise they are
     * stripped (after applying the replay rules). Default false. */
    fallbackBlocks?: boolean;
  },
): {
  system: Anthropic.TextBlockParam[] | undefined;
  messages: Anthropic.MessageParam[];
} {
  let systemText: string | undefined;
  const out: Anthropic.MessageParam[] = [];
  // `out` indices of real user messages (not tool results), for cache anchors.
  const userTurnIdx: number[] = [];
  const idMap = new Map<string, string>();
  const keepFallbackBlocks = options?.fallbackBlocks === true;
  // Client tool calls dropped by the fallback replay rules; their results go too.
  const droppedToolCallIds = new Set<string>();

  // Thinking is preserved across the ACTIVE trajectory: every assistant turn
  // after the last real user message (tool results are role "tool", not "user",
  // so this is simply the last role==="user" index). Earlier, settled turns have
  // thinking stripped to keep history robust against signature invalidation.
  const trajectoryStartIdx = messages.reduce(
    (last, m, i) => (m.role === "user" ? i : last),
    -1 as number,
  );

  let msgIdx = -1;
  for (const msg of messages) {
    msgIdx++;
    if (msg.role === "system") {
      systemText = msg.content;
      continue;
    }
    if (msg.role === "user") {
      // Drop empty-string text parts: Anthropic rejects empty text blocks with a
      // 400 ("text content blocks must be non-empty"). A string content of ""
      // and an all-empty content array are both degenerate — skip the whole
      // message rather than send a guaranteed-400 body. Whitespace-only text is
      // left intact (it is non-empty and the API accepts it). Baseline #20 A/B.
      if (typeof msg.content === "string") {
        if (msg.content === "") continue;
      } else if (!msg.content.some((p) => !(p.type === "text" && p.text === ""))) {
        continue;
      }
      userTurnIdx.push(out.length);
      out.push({
        role: "user",
        content:
          typeof msg.content === "string"
            ? msg.content
            : msg.content
                .filter((part) => !(part.type === "text" && part.text === ""))
                .map((part) => {
                  if (part.type === "text") return { type: "text" as const, text: part.text };
                  if (part.type === "video") {
                    // MiniMax-M3 rides the Anthropic transport and accepts native
                    // video blocks. Non-video models never reach here — video is
                    // downgraded to text by downgradeUnsupportedVideos first.
                    return {
                      type: "video" as const,
                      source: {
                        type: "base64" as const,
                        media_type: part.mediaType,
                        data: part.data,
                      },
                    } as unknown as Anthropic.ContentBlockParam;
                  }
                  return {
                    type: "image" as const,
                    source: {
                      type: "base64" as const,
                      media_type: part.mediaType as
                        "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                      data: part.data,
                    },
                  };
                }),
      });
      continue;
    }
    if (msg.role === "assistant") {
      // A settled assistant turn with string content "" bypasses the array
      // filter below and would reach the wire as an empty string — Anthropic
      // 400s on it just like an empty text block. Drop it (baseline #20 D).
      if (typeof msg.content === "string" && msg.content === "") continue;
      const content =
        typeof msg.content === "string"
          ? msg.content
          : toAnthropicAssistantContent(
              applyServerFallbackReplay(msg.content, keepFallbackBlocks, droppedToolCallIds),
              msgIdx > trajectoryStartIdx,
              idMap,
            );
      // Skip assistant messages with no content blocks (can happen when all
      // blocks are filtered — e.g. thinking-only responses from non-Anthropic
      // providers where signature is missing and text is empty)
      if (Array.isArray(content) && content.length === 0) continue;
      out.push({ role: "assistant", content });
      continue;
    }
    if (msg.role === "tool") {
      const results = droppedToolCallIds.size
        ? msg.content.filter((r) => !droppedToolCallIds.has(r.toolCallId))
        : msg.content;
      if (results.length === 0) continue;
      out.push({
        role: "user",
        // Cast covers the video block (used by the Anthropic-compatible MiniMax
        // API), which isn't in the first-party Anthropic tool_result types.
        content: results.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: remapAnthropicToolCallId(result.toolCallId, idMap),
          content: toAnthropicToolResultContent(result.content),
          is_error: result.isError,
        })) as unknown as Anthropic.ContentBlockParam[],
      });
    }
  }

  // Conversation cache breakpoints. The last user-role message (a real user
  // message or tool results) always gets one, so the history is cached.
  //
  // With a 1-h TTL, only entries ending at a real user message are worth the
  // 1-h write price: once the next user message arrives, the encoding above
  // strips thinking from every earlier assistant turn, so a finished turn's
  // tool-loop entries can never be read again (measured on Haiku 5.5: the next
  // turn reads up to the previous user message and re-writes the loop). So:
  //  - a request that opens a turn writes its user message at 1 h, and pins the
  //    previous turn's opening message too, so that 1-h entry is found even when
  //    the finished loop is longer than Anthropic's ~20-block cache lookback;
  //  - a tool-loop request pins its turn's opening message at 1 h (a read that
  //    refreshes it, so a >5 min tool run falls back to it) and writes the
  //    growing loop at the 5-min default, which the next request reads within
  //    seconds. Anthropic requires 1-h breakpoints before 5-min ones; this order
  //    holds. With tools and system that is at most 4 breakpoints, the API cap.
  if (cacheControl && out.length > 0) {
    let tail = out.length - 1;
    while (tail >= 0 && out[tail]?.role !== "user") tail--;
    if (tail !== -1) {
      if (cacheControl.ttl === "1h") {
        const anchor = userTurnIdx.at(-1);
        if (anchor === tail) {
          const previous = userTurnIdx.at(-2);
          if (previous !== undefined) markAnthropicCacheBreakpoint(out, previous, cacheControl);
          markAnthropicCacheBreakpoint(out, tail, cacheControl);
        } else {
          if (anchor !== undefined) markAnthropicCacheBreakpoint(out, anchor, cacheControl);
          markAnthropicCacheBreakpoint(out, tail, { type: "ephemeral" });
        }
      } else {
        markAnthropicCacheBreakpoint(out, tail, cacheControl);
      }
    }
  }

  // Anthropic supports block-level cache_control. GG Coder keeps reusable prompt
  // content before the "<!-- uncached -->" marker and volatile text (currently
  // the date) after it, so only the reusable prefix receives cache_control.
  let system: Anthropic.TextBlockParam[] | undefined;
  if (systemText) {
    const marker = "<!-- uncached -->";
    const markerIdx = systemText.indexOf(marker);
    if (markerIdx !== -1 && cacheControl) {
      const cachedPart = systemText.slice(0, markerIdx).trimEnd();
      const uncachedPart = systemText.slice(markerIdx + marker.length).trimStart();
      system = [
        { type: "text" as const, text: cachedPart, cache_control: cacheControl },
        ...(uncachedPart ? [{ type: "text" as const, text: uncachedPart }] : []),
      ];
    } else {
      system = [
        {
          type: "text" as const,
          text: systemText,
          ...(cacheControl && { cache_control: cacheControl }),
        },
      ];
    }
  }

  return { system, messages: out };
}

/** Put `cache_control` on the last content block of `out[index]` (a user-role message). */
function markAnthropicCacheBreakpoint(
  out: Anthropic.MessageParam[],
  index: number,
  cacheControl: { type: "ephemeral"; ttl?: "1h" },
): void {
  const message = out[index];
  if (!message) return;
  const content = message.content;
  if (typeof content === "string") {
    out[index] = {
      role: message.role,
      content: [
        { type: "text", text: content, cache_control: cacheControl } as Anthropic.TextBlockParam,
      ],
    };
  } else if (content.length > 0) {
    const last = content[content.length - 1];
    content[content.length - 1] = {
      ...last,
      cache_control: cacheControl,
    } as (typeof content)[number];
  }
}

export function toAnthropicTools(
  tools: Tool[],
  options?: {
    cacheControl?: { type: "ephemeral"; ttl?: "1h" };
    enableFineGrainedToolStreaming?: boolean;
  },
): Anthropic.Tool[] {
  return tools.map((tool, index) => {
    const anthropicTool: Anthropic.Tool & {
      cache_control?: { type: "ephemeral"; ttl?: "1h" };
      eager_input_streaming?: boolean;
    } = {
      name: tool.name,
      description: tool.description,
      input_schema: (tool.rawInputSchema ??
        zodToJsonSchema(tool.parameters)) as Anthropic.Tool["input_schema"],
      ...(options?.enableFineGrainedToolStreaming ? { eager_input_streaming: true } : {}),
    };
    if (options?.cacheControl && index === tools.length - 1) {
      anthropicTool.cache_control = options.cacheControl;
    }
    return anthropicTool;
  });
}

export function toAnthropicToolChoice(choice: ToolChoice): Anthropic.ToolChoice {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
}

/**
 * Anthropic models with built-in adaptive thinking (Fable 5.x, Mythos 5.x,
 * Opus 5.5/5, Opus 4.8/4.7/4.6, Sonnet 5.5/5, Haiku 5.5). Matches both dashed (`opus-4-8`) and
 * dotted (`opus-4.8`) forms so callers don't have to enumerate variants. These
 * models don't need the `interleaved-thinking` beta header — it's built in.
 * (`opus-5` can't false-match `claude-opus-4-5-…` — the `4-` breaks the literal;
 * it also covers `opus-5-5`; likewise `haiku-5` never matches `haiku-4-5`.)
 */
export function isAdaptiveThinkingModel(model: string): boolean {
  return /opus-5|opus-4[-.]8|opus-4[-.]7|opus-4[-.]6|sonnet-5|haiku-5|fable-5|mythos-5/.test(model);
}

export function toAnthropicThinking(
  level: ThinkingLevel,
  maxTokens: number,
  model: string,
): {
  thinking: Anthropic.ThinkingConfigParam;
  maxTokens: number;
  outputConfig?: { effort: string };
} {
  if (isAdaptiveThinkingModel(model)) {
    // Adaptive thinking — model decides when/how much to think.
    // budget_tokens is deprecated on Opus 5.x / 4.8 / 4.7 / 4.6 and Sonnet 5.
    // Anthropic's output_config.effort accepts low, medium, high, xhigh, and max.
    // xhigh is supported by Opus 5.x / 4.8 / 4.7, Sonnet 5.5 and Haiku 5.5;
    // all support max.
    let effort: string = level;
    if (effort === "xhigh" && !/opus-5|opus-4-8|opus-4-7|sonnet-5[-.]5|haiku-5[-.]5/.test(model)) {
      effort = "high";
    }
    return {
      // "omitted" (what Claude Code sends): the model still thinks, but
      // thinking blocks stream empty (signature only). The app never renders
      // reasoning text, and "summarized" costs speed on Haiku 5.5: bench/h2h
      // measured output tok/s over each whole request at 151 (summarized) vs
      // 191 (omitted); Claude Code 195. Sonnet/Opus 5.5 measured even either way.
      // The UI's "Thinking…" timer keys off the empty thinking_delta emitted
      // when a thinking block opens, so it is unaffected.
      thinking: { type: "adaptive", display: "omitted" },
      maxTokens,
      outputConfig: { effort },
    };
  }

  // Legacy budget-based thinking for older models ("xhigh"/"max" treated as
  // "high"). `maxTokens` is the model's full output-token ceiling; for budget
  // thinking `max_tokens` is the TOTAL response envelope (thinking + visible
  // output), so it must stay ≤ the ceiling and `budget_tokens` must be strictly
  // less than it. The previous code returned `maxTokens + budget`, which blew
  // past the ceiling (e.g. a 64K model: 64K + 64K = 128K) and could trip the
  // provider's `max_tokens > maximum allowed` rejection. Now the ceiling is the
  // envelope and the budget is a fraction of it with a reserved visible floor.
  const VISIBLE_FLOOR = 1024;
  const effectiveLevel = level === "xhigh" || level === "max" || level === "ultra" ? "high" : level;
  const budgetMap: Record<"low" | "medium" | "high", number> = {
    low: Math.max(1024, Math.floor(maxTokens * 0.2)),
    medium: Math.max(2048, Math.floor(maxTokens * 0.45)),
    high: Math.max(4096, Math.floor(maxTokens * 0.8)),
  };
  // Clamp the budget so a visible-output floor survives even at "high" on small
  // ceilings, and budget_tokens stays < max_tokens (Anthropic hard requirement).
  const budget = Math.max(0, Math.min(budgetMap[effectiveLevel], maxTokens - VISIBLE_FLOOR));
  return {
    thinking: { type: "enabled", budget_tokens: budget },
    maxTokens,
  };
}

// ── OpenAI Transforms ──────────────────────────────────────

/**
 * Remap Anthropic `toolu_*` tool call IDs to `call_*` so OpenAI accepts them.
 * Only Anthropic IDs need remapping — IDs from OpenAI-compatible providers
 * (Moonshot, GLM, Xiaomi, MiniMax) are passed through unchanged to avoid
 * breaking the provider's own ID validation.
 */
function remapToolCallId(id: string, idMap: Map<string, string>): string {
  if (!id.startsWith("toolu_")) return id;
  const existing = idMap.get(id);
  if (existing) return existing;
  // Strip the full `toolu_` prefix (6 chars). `slice(5)` left the trailing
  // underscore, producing `call__<id>` (double underscore) — lossy and not
  // identity-reversible. `slice(6)` yields a clean `call_<id>`. Pairing still
  // holds because both the tool_call and its result resolve through idMap.
  const mapped = `call_${id.slice(6)}`;
  idMap.set(id, mapped);
  return mapped;
}

export function toOpenAIMessages(
  messages: Message[],
  options?: {
    provider?: string;
    thinking?: boolean;
    supportsImages?: boolean;
    /** Wire name for reasoning on assistant messages. Defaults to `reasoning_content`. */
    reasoningField?: string;
  },
): OpenAI.ChatCompletionMessageParam[] {
  const reasoningField = options?.reasoningField || DEFAULT_REASONING_FIELD;
  const out: OpenAI.ChatCompletionMessageParam[] = [];
  const idMap = new Map<string, string>();
  // GLM drops reasoning_content when a user message follows tool results.
  // Merge user text into the last tool message to preserve thinking context.
  const mergeToolResultText = options?.provider === "glm";

  for (const msg of messages) {
    if (msg.role === "system") {
      // OpenAI-style APIs receive the system prompt literally. They may do
      // provider-side prefix/key caching, but there is no Anthropic-style
      // uncached block split here; the marker remains ordinary text.
      out.push({ role: "system", content: msg.content });
      continue;
    }
    if (msg.role === "user") {
      // For GLM: if the previous message is a tool result, merge text into it
      // to avoid a standalone user message that causes reasoning_content to be dropped.
      if (mergeToolResultText && out.length > 0 && out[out.length - 1]!.role === "tool") {
        const userText =
          typeof msg.content === "string"
            ? msg.content
            : msg.content
                .filter((p): p is TextContent => p.type === "text")
                .map((p) => p.text)
                .join("");
        if (userText) {
          // Append text to the last tool message's content
          const lastTool = out[out.length - 1] as OpenAI.ChatCompletionToolMessageParam;
          lastTool.content = (lastTool.content ?? "") + "\n\n" + userText;
          continue;
        }
      }
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content });
      } else {
        out.push({
          role: "user",
          content: msg.content.map(
            (
              part,
            ): OpenAI.ChatCompletionContentPartImage | OpenAI.ChatCompletionContentPartText => {
              if (part.type === "text") return { type: "text", text: part.text };
              if (part.type === "video") {
                // Moonshot/Kimi requires video uploaded to the file service and
                // referenced by `ms://<id>` — inline base64 is rejected. The
                // openai provider uploads first and caches `fileId` on the part.
                // Match Kimi's wire shape exactly: when uploaded, include both
                // `url` and `id`. Non-video models never reach here.
                const videoUrl =
                  options?.provider === "moonshot" && part.fileId
                    ? { url: `ms://${part.fileId}`, id: part.fileId }
                    : { url: `data:${part.mediaType};base64,${part.data}` };
                return {
                  type: "video_url",
                  video_url: videoUrl,
                } as unknown as OpenAI.ChatCompletionContentPartImage;
              }
              return {
                type: "image_url",
                image_url: {
                  url: `data:${part.mediaType};base64,${part.data}`,
                },
              };
            },
          ),
        });
      }
      continue;
    }
    if (msg.role === "assistant") {
      const parts = typeof msg.content === "string" ? msg.content : undefined;
      const toolCalls =
        typeof msg.content !== "string"
          ? msg.content
              .filter(
                (p): p is Extract<ContentPart, { type: "tool_call" }> => p.type === "tool_call",
              )
              .map((tc): OpenAI.ChatCompletionMessageToolCall => ({
                id: remapToolCallId(tc.id, idMap),
                type: "function",
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              }))
          : undefined;
      const textParts =
        typeof msg.content !== "string"
          ? msg.content
              .filter((p): p is TextContent => p.type === "text")
              .map((p) => p.text)
              .join("")
          : undefined;
      // Roundtrip thinking content as reasoning_content (GLM, Moonshot)
      const thinkingParts =
        typeof msg.content !== "string"
          ? msg.content
              .filter((p): p is ThinkingContent => p.type === "thinking")
              .map((p) => p.text)
              .join("")
          : undefined;

      const contentValue = parts || textParts || null;
      const hasToolCalls = toolCalls && toolCalls.length > 0;
      // Skip assistant messages with no content and no tool_calls (can happen
      // with thinking-only responses) — providers like Xiaomi reject these.
      if (!contentValue && !hasToolCalls) continue;

      const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: contentValue,
        ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
      };
      // Attach reasoning_content for multi-turn thinking coherence (non-standard field).
      // When thinking content exists, always include it for round-tripping.
      // When thinking is enabled but no content exists (e.g. after compaction),
      // Moonshot/Kimi requires reasoning_content on assistant tool_call messages —
      // default to empty string.  GLM silently hangs on empty values, so skip it there.
      if (thinkingParts) {
        (assistantMsg as unknown as Record<string, unknown>)[reasoningField] = thinkingParts;
      } else if (options?.thinking && hasToolCalls && options.provider !== "glm") {
        (assistantMsg as unknown as Record<string, unknown>)[reasoningField] = " ";
      }
      out.push(assistantMsg);
      continue;
    }
    if (msg.role === "tool") {
      // OpenAI's `tool` role only accepts text. Emit the tool message with the
      // text content, then (if any tool results carried images and the model
      // supports vision) a follow-up `user` message carrying image_url blocks.
      //
      // Moonshot/Kimi is the exception for VIDEO: its coding endpoint accepts a
      // `video_url` content part ONLY inside the tool message itself (not in a
      // user message). So for moonshot we emit the tool content as an array
      // `[{text}, {video_url}]` carrying the uploaded `ms://<id>` reference —
      // mirroring the official Kimi read-media tool. The provider uploads the
      // clip and stamps `fileId` before this transform runs.
      //
      // Every OTHER OpenAI-compatible video model (e.g. Xiaomi MiMo-V2.5)
      // rejects video inside a `tool` message ("`text` is not set", verified
      // against the live API) — it accepts `video_url` only in `user` content.
      // So those videos are carried out the same way images are: a follow-up
      // `user` message after the tool result. Tool results only ever carry
      // video when the active model is video-capable (the read tool returns
      // native video solely for such models, and `stream()` rejects stray video
      // for text-only models), so no extra capability guard is needed here.
      const isMoonshot = options?.provider === "moonshot";
      const followUpMediaBlocks: OpenAI.ChatCompletionContentPart[] = [];
      let followUpHasVideo = false;
      for (const result of msg.content) {
        const text = toolResultText(result.content);
        const images = toolResultImages(result.content);
        const videos = toolResultVideos(result.content);
        const hasText = text.length > 0;
        if (isMoonshot && videos.length > 0) {
          const parts: OpenAI.ChatCompletionContentPartText[] = [];
          if (hasText) parts.push({ type: "text", text });
          const videoParts = videos.map((v) => {
            const videoUrl = v.fileId
              ? { url: `ms://${v.fileId}`, id: v.fileId }
              : { url: `data:${v.mediaType};base64,${v.data}` };
            return { type: "video_url", video_url: videoUrl };
          });
          out.push({
            role: "tool",
            tool_call_id: remapToolCallId(result.toolCallId, idMap),
            content: [...parts, ...videoParts] as unknown as string,
          });
          continue;
        }
        out.push({
          role: "tool",
          tool_call_id: remapToolCallId(result.toolCallId, idMap),
          content: hasText ? text : "(see attached media)",
        });
        if (images.length > 0 && options?.supportsImages !== false) {
          for (const img of images) {
            followUpMediaBlocks.push({
              type: "image_url",
              image_url: { url: `data:${img.mediaType};base64,${img.data}` },
            });
          }
        }
        // Non-Moonshot video models: deliver the clip in a follow-up user
        // message as an inline base64 `video_url` (the shape MiMo accepts).
        if (!isMoonshot && videos.length > 0) {
          for (const v of videos) {
            followUpMediaBlocks.push({
              type: "video_url",
              video_url: { url: `data:${v.mediaType};base64,${v.data}` },
            } as unknown as OpenAI.ChatCompletionContentPart);
            followUpHasVideo = true;
          }
        }
      }
      if (followUpMediaBlocks.length > 0) {
        const label = followUpHasVideo
          ? "Attached media from tool result:"
          : "Attached image(s) from tool result:";
        out.push({
          role: "user",
          content: [{ type: "text", text: label }, ...followUpMediaBlocks],
        });
      }
    }
  }

  return out;
}

export function toOpenAITools(
  tools: Tool[],
  opts?: { strict?: boolean },
): OpenAI.ChatCompletionTool[] {
  return tools.map((tool) => {
    let parameters = resolveToolSchema(tool);
    let strict: true | undefined;
    if (opts?.strict) {
      // Prefer provider-guaranteed schema-conformant args; fall back per tool
      // when the schema cannot be expressed in the strict subset.
      try {
        parameters = makeStrictToolSchema(parameters);
        strict = true;
      } catch (error) {
        if (!(error instanceof UnsupportedStrictSchemaError)) throw error;
      }
    }
    return {
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters,
        ...(strict ? { strict } : {}),
      },
    };
  });
}

export function toOpenAIToolChoice(choice: ToolChoice): OpenAI.ChatCompletionToolChoiceOption {
  if (choice === "auto") return "auto";
  if (choice === "none") return "none";
  if (choice === "required") return "required";
  return { type: "function", function: { name: choice.name } };
}

/**
 * Reasoning effort for a locally hosted server (Ollama, LM Studio, llama.cpp,
 * vLLM). These spell the top rung **"max"**, not "xhigh" — Ollama 0.32 answers
 * `invalid reasoning value: 'xhigh' (must be "high", "medium", "low", "max", or
 * "none")`, so sending the OpenAI spelling is a hard 400. Like Kimi's `max`,
 * the value sits outside the OpenAI SDK's effort union, so the caller assigns
 * it through the usual escape hatch.
 */
export function toLocalReasoningEffort(level: ThinkingLevel): "low" | "medium" | "high" | "max" {
  if (level === "max" || level === "ultra" || level === "xhigh") return "max";
  return level;
}

/**
 * Reasoning effort for Z.AI's GLM endpoint. Its accepted set is declared by
 * the API itself — an unknown value 400s with `reasoning_effort must be one of:
 * none, minimal, low, medium, high, xhigh, max` (verified against glm-5.3) —
 * so every ThinkingLevel except `ultra` passes through unchanged. Crucially
 * `max` must NOT be remapped to `xhigh` the way {@link toOpenAIReasoningEffort}
 * does: GLM spells its top rung `max` and treats it as the default.
 */
export function toGlmReasoningEffort(
  level: ThinkingLevel,
): "low" | "medium" | "high" | "xhigh" | "max" {
  return level === "ultra" ? "max" : level;
}

/**
 * Codex Ultra is a local delegation preset. Astra/Sol declare xhigh as their
 * multi_agent_reasoning_effort; older catalogs without that override use max.
 * Source: openai/codex 4c9f42f4, models-manager/models.json and
 * protocol/src/openai_models/reasoning_effort.rs.
 */
export function toCodexReasoningEffort(
  level: ThinkingLevel,
  model: string,
): Exclude<ThinkingLevel, "ultra"> {
  if (level !== "ultra") return level;
  return model === "gpt-6-astra" || model === "gpt-6.1-sol" ? "xhigh" : "max";
}

export function toOpenAIReasoningEffort(
  level: ThinkingLevel,
  model: string,
): "low" | "medium" | "high" | "xhigh" {
  const effort = level === "max" || level === "ultra" ? "xhigh" : level;
  // Sakana Fugu models reject any effort other than "high"/"xhigh", so floor a
  // lower manual selection up to "high" rather than letting the API 400.
  if (model.startsWith("fugu") && (effort === "low" || effort === "medium")) {
    return "high";
  }
  return effort;
}

// ── Response Normalization ─────────────────────────────────

export function normalizeAnthropicStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "pause_turn":
      return "pause_turn";
    case "stop_sequence":
      return "stop_sequence";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

export function normalizeOpenAIStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}
