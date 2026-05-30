import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type {
  CacheRetention,
  ContentPart,
  ImageContent,
  Message,
  StopReason,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
  Tool,
  ToolChoice,
  ToolResultContent,
} from "../types.js";
import { zodToJsonSchema } from "../utils/zod-to-json-schema.js";

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
  if (part.type === "raw") return part.data as unknown as Anthropic.ContentBlockParam;
  // Unknown content type (e.g. image in assistant message) — drop it.
  return null;
}

/**
 * Build an assistant message's Anthropic content blocks.
 *
 * Anthropic only validates thinking-block integrity in the LATEST assistant
 * message. For every earlier turn, keeping signed thinking just makes the
 * history fragile — any later edit, compaction, or reorder invalidates the
 * signature and triggers "thinking ... blocks cannot be modified". So thinking
 * and redacted_thinking are stripped from all but the latest turn (tool_use and
 * text survive). On the latest turn they are preserved byte-identical (signed)
 * or downgraded to text (unsigned). This mirrors the AutoGPT / hermes-agent fix.
 */
function toAnthropicAssistantContent(
  content: ContentPart[],
  isLatest: boolean,
  idMap: Map<string, string>,
): Anthropic.ContentBlockParam[] {
  if (!isLatest) {
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

  // Latest assistant turn: thinking/redacted_thinking blocks are byte-identical
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

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

/** Replace image blocks with a text placeholder (deduping consecutive placeholders). */
function stripImages(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
  const out: TextContent[] = [];
  let lastWasPlaceholder = false;
  for (const block of content) {
    if (block.type === "image") {
      if (!lastWasPlaceholder) out.push({ type: "text", text: placeholder });
      lastWasPlaceholder = true;
      continue;
    }
    out.push(block);
    lastWasPlaceholder = block.text === placeholder;
  }
  return out;
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
function toolResultText(content: ToolResultContent): string {
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
function toAnthropicToolResultContent(
  content: ToolResultContent,
):
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; source: AnthropicImageSource }> {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") return { type: "text" as const, text: block.text };
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
): {
  system: Anthropic.TextBlockParam[] | undefined;
  messages: Anthropic.MessageParam[];
} {
  let systemText: string | undefined;
  const out: Anthropic.MessageParam[] = [];
  const idMap = new Map<string, string>();

  // Only the latest assistant message has its thinking blocks validated by
  // Anthropic; thinking is stripped from all earlier turns (see
  // toAnthropicAssistantContent).
  const lastAssistantIdx = messages.reduce(
    (last, m, i) => (m.role === "assistant" ? i : last),
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
      out.push({
        role: "user",
        content:
          typeof msg.content === "string"
            ? msg.content
            : msg.content.map((part) => {
                if (part.type === "text") return { type: "text" as const, text: part.text };
                return {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: part.mediaType as
                      | "image/jpeg"
                      | "image/png"
                      | "image/gif"
                      | "image/webp",
                    data: part.data,
                  },
                };
              }),
      });
      continue;
    }
    if (msg.role === "assistant") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : toAnthropicAssistantContent(msg.content, msgIdx === lastAssistantIdx, idMap);
      // Skip assistant messages with no content blocks (can happen when all
      // blocks are filtered — e.g. thinking-only responses from non-Anthropic
      // providers where signature is missing and text is empty)
      if (Array.isArray(content) && content.length === 0) continue;
      out.push({ role: "assistant", content });
      continue;
    }
    if (msg.role === "tool") {
      out.push({
        role: "user",
        content: msg.content.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: remapAnthropicToolCallId(result.toolCallId, idMap),
          content: toAnthropicToolResultContent(result.content),
          is_error: result.isError,
        })),
      });
    }
  }

  // Add cache_control to the last user message to cache conversation history
  if (cacheControl && out.length > 0) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role === "user") {
        const content = out[i].content;
        if (typeof content === "string") {
          out[i] = {
            role: "user",
            content: [
              {
                type: "text",
                text: content,
                cache_control: cacheControl,
              } as Anthropic.TextBlockParam,
            ],
          };
        } else if (Array.isArray(content) && content.length > 0) {
          const last = content[content.length - 1];
          content[content.length - 1] = {
            ...last,
            cache_control: cacheControl,
          } as (typeof content)[number];
        }
        break;
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

function supportsAdaptiveThinking(model: string): boolean {
  return /opus-4-8|opus-4-7|opus-4-6|sonnet-4-6/.test(model);
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
  if (supportsAdaptiveThinking(model)) {
    // Adaptive thinking — model decides when/how much to think.
    // budget_tokens is deprecated on Opus 4.8 / Opus 4.7 / Opus 4.6 / Sonnet 4.6.
    // Anthropic's output_config.effort accepts low, medium, high, xhigh, and max.
    // xhigh is Opus 4.8/4.7-only; max is supported by Opus 4.8/4.7/4.6 and Sonnet 4.6.
    let effort: string = level;
    if (effort === "xhigh" && !/opus-4-8|opus-4-7/.test(model)) {
      effort = "high";
    }
    return {
      thinking: { type: "adaptive" } as unknown as Anthropic.ThinkingConfigParam,
      maxTokens,
      outputConfig: { effort },
    };
  }

  // Legacy budget-based thinking for older models ("xhigh"/"max" treated as "high")
  const effectiveLevel = level === "xhigh" || level === "max" ? "high" : level;
  const budgetMap: Record<"low" | "medium" | "high", number> = {
    low: Math.max(1024, Math.floor(maxTokens * 0.25)),
    medium: Math.max(2048, Math.floor(maxTokens * 0.5)),
    high: Math.max(4096, maxTokens),
  };
  const budget = budgetMap[effectiveLevel];
  return {
    thinking: { type: "enabled", budget_tokens: budget },
    maxTokens: maxTokens + budget,
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
  const mapped = `call_${id.slice(5)}`;
  idMap.set(id, mapped);
  return mapped;
}

export function toOpenAIMessages(
  messages: Message[],
  options?: { provider?: string; thinking?: boolean; supportsImages?: boolean },
): OpenAI.ChatCompletionMessageParam[] {
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
              .map(
                (tc): OpenAI.ChatCompletionMessageToolCall => ({
                  id: remapToolCallId(tc.id, idMap),
                  type: "function",
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                }),
              )
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
        (assistantMsg as unknown as Record<string, unknown>).reasoning_content = thinkingParts;
      } else if (options?.thinking && hasToolCalls && options.provider !== "glm") {
        (assistantMsg as unknown as Record<string, unknown>).reasoning_content = " ";
      }
      out.push(assistantMsg);
      continue;
    }
    if (msg.role === "tool") {
      // OpenAI's `tool` role only accepts text. Emit the tool message with the
      // text content, then (if any tool results carried images and the model
      // supports vision) a follow-up `user` message carrying image_url blocks.
      const imageBlocks: OpenAI.ChatCompletionContentPartImage[] = [];
      for (const result of msg.content) {
        const text = toolResultText(result.content);
        const images = toolResultImages(result.content);
        const hasText = text.length > 0;
        out.push({
          role: "tool",
          tool_call_id: remapToolCallId(result.toolCallId, idMap),
          content: hasText ? text : "(see attached image)",
        });
        if (images.length > 0 && options?.supportsImages !== false) {
          for (const img of images) {
            imageBlocks.push({
              type: "image_url",
              image_url: { url: `data:${img.mediaType};base64,${img.data}` },
            });
          }
        }
      }
      if (imageBlocks.length > 0) {
        out.push({
          role: "user",
          content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...imageBlocks],
        });
      }
    }
  }

  return out;
}

export function toOpenAITools(tools: Tool[]): OpenAI.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.rawInputSchema ?? zodToJsonSchema(tool.parameters),
    },
  }));
}

export function toOpenAIToolChoice(choice: ToolChoice): OpenAI.ChatCompletionToolChoiceOption {
  if (choice === "auto") return "auto";
  if (choice === "none") return "none";
  if (choice === "required") return "required";
  return { type: "function", function: { name: choice.name } };
}

export function toOpenAIReasoningEffort(
  level: ThinkingLevel,
  _model: string,
): "low" | "medium" | "high" | "xhigh" {
  return level === "max" ? "xhigh" : level;
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
