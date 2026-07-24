import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type {
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

/**
 * Cap historical images before provider dispatch, removing the oldest first.
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
  let remainingToRemove = countContextImages(messages) - budget;
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
): {
  system: Anthropic.TextBlockParam[] | undefined;
  messages: Anthropic.MessageParam[];
} {
  let systemText: string | undefined;
  const out: Anthropic.MessageParam[] = [];
  const idMap = new Map<string, string>();

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
      // A settled assistant turn with string content "" bypasses the array
      // filter below and would reach the wire as an empty string — Anthropic
      // 400s on it just like an empty text block. Drop it (baseline #20 D).
      if (typeof msg.content === "string" && msg.content === "") continue;
      const content =
        typeof msg.content === "string"
          ? msg.content
          : toAnthropicAssistantContent(msg.content, msgIdx > trajectoryStartIdx, idMap);
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
        // Cast covers the video block (used by the Anthropic-compatible MiniMax
        // API), which isn't in the first-party Anthropic tool_result types.
        content: msg.content.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: remapAnthropicToolCallId(result.toolCallId, idMap),
          content: toAnthropicToolResultContent(result.content),
          is_error: result.isError,
        })) as unknown as Anthropic.ContentBlockParam[],
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

/**
 * Anthropic models with built-in adaptive thinking (Fable 5, Mythos 5,
 * Opus 5, Opus 4.8/4.7/4.6, Sonnet 5). Matches both dashed (`opus-4-8`) and
 * dotted (`opus-4.8`) forms so callers don't have to enumerate variants. These
 * models don't need the `interleaved-thinking` beta header — it's built in.
 * (`opus-5` can't false-match `claude-opus-4-5-…` — the `4-` breaks the literal.)
 */
export function isAdaptiveThinkingModel(model: string): boolean {
  return /opus-5|opus-4[-.]8|opus-4[-.]7|opus-4[-.]6|sonnet-5|fable-5|mythos-5/.test(model);
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
    // budget_tokens is deprecated on Opus 5 / 4.8 / 4.7 / 4.6 and Sonnet 5.
    // Anthropic's output_config.effort accepts low, medium, high, xhigh, and max.
    // xhigh is Opus 5 / 4.8 / 4.7-only; max is supported by every adaptive model.
    let effort: string = level;
    if (effort === "xhigh" && !/opus-5|opus-4-8|opus-4-7/.test(model)) {
      effort = "high";
    }
    return {
      thinking: { type: "adaptive" } as unknown as Anthropic.ThinkingConfigParam,
      maxTokens,
      outputConfig: { effort },
    };
  }

  // Legacy budget-based thinking for older models ("xhigh"/"max" treated as
  // "high"). `maxTokens` is the model's full output-token ceiling; for budget
  // thinking `max_tokens` is the TOTAL response envelope (thinking + visible
  // output), so it must stay ≤ the ceiling and `budget_tokens` must be strictly
  // less than it. The previous code returned `maxTokens + budget`, which blew
  // past the ceiling (e.g. Haiku 4.5: 64K + 64K = 128K) and could trip the
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
              if (part.type === "video") {
                // Moonshot/Kimi requires video uploaded to the file service and
                // referenced by `ms://<id>` — inline base64 is rejected. The
                // openai provider uploads first and caches `fileId` on the part.
                // Match Kimi's wire shape exactly: when uploaded, include both
                // `url` and `id`. Non-video models never reach here.
                const videoUrl = part.fileId
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

export function toOpenAITools(tools: Tool[]): OpenAI.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: resolveToolSchema(tool),
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
