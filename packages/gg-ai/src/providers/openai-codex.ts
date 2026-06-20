import os from "node:os";
import type {
  ContentPart,
  ImageContent,
  Message,
  StreamEvent,
  StreamOptions,
  StreamResponse,
  Tool,
  ToolCall,
} from "../types.js";
import { ProviderError, readHeader } from "../errors.js";
import { StreamResult } from "../utils/event-stream.js";
import { providerDiag } from "../utils/diag.js";
import { resolveToolSchema } from "../utils/zod-to-json-schema.js";
import { normalizePromptCacheKey } from "./prompt-cache-key.js";
import {
  downgradeUnsupportedImages,
  downgradeUnsupportedVideos,
  toolResultText,
} from "./transform.js";
import { parseToolArguments } from "../utils/json.js";
import { readSseStream } from "../utils/sse.js";
import { extractRequestIdFromMessage } from "../utils/request-id.js";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";

function outputTextKey(itemId: string | undefined, contentIndex: number | undefined): string {
  return `${itemId ?? ""}:${contentIndex ?? 0}`;
}

function isVisibleOutputItem(itemType: string | undefined): boolean {
  return itemType === "message";
}

export function streamOpenAICodex(options: StreamOptions): StreamResult {
  return new StreamResult(runStream(options), options.signal);
}

async function* runStream(options: StreamOptions): AsyncGenerator<StreamEvent, StreamResponse> {
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/codex/responses`;

  const downgradedImages = downgradeUnsupportedImages(options.messages, options.supportsImages);
  // Codex (GPT OAuth) has no video support — always strip video to a placeholder.
  const downgraded = downgradeUnsupportedVideos(downgradedImages, options.supportsVideo);
  const { system, input } = toCodexInput(downgraded, { supportsImages: options.supportsImages });

  const body: Record<string, unknown> = {
    model: options.model,
    store: false,
    stream: true,
    instructions: system,
    input,
    tool_choice: "auto",
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
  };

  if (options.tools?.length) {
    body.tools = toCodexTools(options.tools);
  }
  // Always set a prompt_cache_key. OpenAI uses this key to route requests
  // with the same prefix to the same cache shard — without it, the codex
  // backend hashes only the request body, so cache hits for shared
  // system+tool prefixes across separate sub-agent processes are accidental
  // rather than guaranteed.
  body.prompt_cache_key = normalizePromptCacheKey(options.promptCacheKey ?? "ggcoder");
  // Note: prompt_cache_retention ("24h") is a Responses API param, not
  // accepted by the Codex backend — it returns 400 "Unsupported parameter".
  // Cache TTL on Codex is controlled server-side (~5-10 min in-memory).
  // The session_id + x-client-request-id headers below handle cache routing.
  if (options.temperature != null && !options.thinking) {
    body.temperature = options.temperature;
  }
  body.reasoning = {
    effort: options.thinking ?? "none",
    summary: "auto",
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${options.apiKey}`,
    "OpenAI-Beta": "responses=experimental",
    originator: "ggcoder",
    "User-Agent": `ggcoder (${os.platform()} ${os.release()}; ${os.arch()})`,
  };

  if (options.accountId) {
    headers["chatgpt-account-id"] = options.accountId;
  }

  // The chatgpt.com codex backend routes prompt cache lookups by header, not
  // body — `prompt_cache_key` in the body alone never produces a cache hit
  // here (verified against gpt-5.5 with a 22k-token shared prefix). Pinning
  // both `session_id` and `x-client-request-id` to the cache scope is what
  // makes consecutive requests hit the same cache shard.
  const cacheScopeId = body.prompt_cache_key as string | undefined;
  if (cacheScopeId) {
    headers["session_id"] = cacheScopeId;
    headers["x-client-request-id"] = cacheScopeId;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const parsed = parseCodexErrorBody(text);
    const message = parsed.message ?? `Codex API returned HTTP ${response.status}.`;
    const requestId =
      parsed.requestId ??
      readHeader(response.headers, "x-request-id", "openai-request-id", "x-oai-request-id");

    // ChatGPT-subscription usage-window exhaustion. The codex backend returns
    // HTTP 429 with a usage_limit_reached / usage_not_included / rate_limit_exceeded
    // code and a reset timestamp. Stop immediately with a clear message instead
    // of letting the agent loop retry a 429 it can't recover from.
    const usageLimit = codexUsageLimitError(parsed.errorObj, response.status, requestId);
    if (usageLimit) throw usageLimit;

    let hint: string | undefined;
    if (response.status === 400 && text.includes("not supported")) {
      if (options.model === "gpt-5.5-pro") {
        hint = "Use gpt-5.5 instead. OpenAI's Codex model catalog does not list gpt-5.5-pro.";
      } else {
        hint =
          "This model is not available through Codex for the authenticated account. " +
          "Run /model and choose a model listed for OpenAI Codex, or check your Codex model picker/usage limits.";
      }
    } else if (response.status === 404 && text.includes("does not exist")) {
      hint =
        "This model is not in the current OpenAI Codex catalog for this account. " +
        "Try gpt-5.5, gpt-5.4, gpt-5.4-mini, or gpt-5.3-codex.";
    }

    throw new ProviderError("openai", message, {
      statusCode: response.status,
      ...(requestId ? { requestId } : {}),
      ...(hint ? { hint } : {}),
    });
  }

  if (!response.body) {
    throw new ProviderError("openai", "No response body from Codex API");
  }

  const contentParts: ContentPart[] = [];
  let textAccum = "";
  const toolCalls = new Map<string, { id: string; name: string; argsJson: string }>();
  // Reasoning and tool-call items in true stream arrival order. Encrypted
  // reasoning items (store:false + include reasoning.encrypted_content) are
  // recorded inline so each one keeps its position relative to the function_call
  // it reasoned about — preserving the reasoning anchor even for parallel tool
  // calls (parallels the Anthropic thinking round-trip).
  const orderedItems: ({ kind: "reasoning"; part: ContentPart } | { kind: "tool"; id: string })[] =
    [];
  const outputItemTypes = new Map<string, string>();
  const outputTextByPart = new Map<string, string>();
  const pendingOutputTextByPart = new Map<
    string,
    { itemId: string; contentIndex: number; text: string }
  >();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;

  // ── Diagnostic: log the first occurrence of each raw SSE event type with
  // timing, so we can see what Codex sends during the pre-reasoning window
  // and decide whether earlier signals are available to drive the UI.
  const diagStart = Date.now();
  const diagSeen = new Set<string>();

  for await (const event of parseSSE(response.body)) {
    const type = event.type as string | undefined;
    if (!type) continue;

    if (!diagSeen.has(type)) {
      diagSeen.add(type);
      providerDiag("codex_event_first", { type, sinceStartMs: Date.now() - diagStart });
    }

    if (type === "error") {
      // Codex Responses streams two error shapes:
      //   { type:"error", error:{ type, code, message, param }, sequence_number }
      //   { type:"error", code, message, param, sequence_number }
      // Pick the first message field we find; fall back to the chunk code/type
      // rather than dumping the raw JSON at the user.
      const nested = (event.error as Record<string, unknown> | undefined) ?? undefined;
      const message =
        (nested?.message as string | undefined) ??
        (event.message as string | undefined) ??
        "Codex stream emitted an error chunk without a message.";
      const code =
        (nested?.code as string | undefined) ??
        (nested?.type as string | undefined) ??
        (event.code as string | undefined) ??
        "server_error";
      // OpenAI sometimes embeds the request ID inside the human-readable
      // message ("…request ID abc123 in your message"); fish it out so the
      // FormattedError can surface it on its own line.
      const requestId =
        extractRequestIdFromMessage(message) ?? (event.request_id as string | undefined);
      // ChatGPT-subscription usage-window exhaustion can arrive mid-stream as an
      // error chunk. Surface it as a hard usage-limit stop, not a retriable error.
      const usageLimit = codexUsageLimitError(
        nested ?? (event as Record<string, unknown>),
        undefined,
        requestId,
      );
      if (usageLimit) throw usageLimit;
      throw new ProviderError("openai", message, {
        ...(requestId != null ? { requestId } : {}),
        ...(code === "server_error" ? { statusCode: 500 } : {}),
      });
    }

    if (type === "response.failed") {
      const nested = event.error as Record<string, unknown> | undefined;
      const message = (nested?.message as string | undefined) ?? "Codex response failed.";
      const requestId =
        extractRequestIdFromMessage(message) ?? (event.request_id as string | undefined);
      throw new ProviderError("openai", message, {
        ...(requestId != null ? { requestId } : {}),
      });
    }

    // Text delta. OpenAI documents response.output_text.* as output content
    // text, while reasoning has separate response.reasoning*_text.delta events.
    // The ChatGPT Codex transport can occasionally attach output_text chunks to
    // reasoning or send text before item metadata. Never expose output_text unless
    // the item is positively identified as a visible assistant message.
    if (type === "response.output_text.delta") {
      const delta = event.delta as string;
      const itemId = event.item_id as string | undefined;
      const contentIndex = event.content_index as number | undefined;
      const key = outputTextKey(itemId, contentIndex);
      outputTextByPart.set(key, `${outputTextByPart.get(key) ?? ""}${delta}`);
      const itemType = itemId ? outputItemTypes.get(itemId) : undefined;
      if (itemId && isVisibleOutputItem(itemType)) {
        textAccum += delta;
        yield { type: "text_delta", text: delta };
      } else if (itemId && itemType == null) {
        const pending = pendingOutputTextByPart.get(key);
        pendingOutputTextByPart.set(key, {
          itemId,
          contentIndex: contentIndex ?? 0,
          text: `${pending?.text ?? ""}${delta}`,
        });
      }
    }

    // Text done. The final event can contain text not seen in deltas; emit only
    // the missing suffix so consumers don't see duplicate visible output, and
    // only after item metadata proves the part belongs to a message.
    if (type === "response.output_text.done") {
      const fullText = event.text as string | undefined;
      if (fullText) {
        const itemId = event.item_id as string | undefined;
        const contentIndex = event.content_index as number | undefined;
        const key = outputTextKey(itemId, contentIndex);
        const streamedText = outputTextByPart.get(key) ?? "";
        const missingText = streamedText ? fullText.slice(streamedText.length) : fullText;
        outputTextByPart.set(key, fullText);
        if (missingText && fullText.startsWith(streamedText)) {
          const itemType = itemId ? outputItemTypes.get(itemId) : undefined;
          if (itemId && isVisibleOutputItem(itemType)) {
            textAccum += missingText;
            yield { type: "text_delta", text: missingText };
          } else if (itemId && itemType == null) {
            const pending = pendingOutputTextByPart.get(key);
            pendingOutputTextByPart.set(key, {
              itemId,
              contentIndex: contentIndex ?? 0,
              text: `${pending?.text ?? ""}${missingText}`,
            });
          }
        }
      }
    }

    // Thinking delta
    if (
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_summary.delta" ||
      type === "response.reasoning_text.delta" ||
      type === "response.reasoning.delta"
    ) {
      const delta = event.delta as string;
      if (options.thinking) yield { type: "thinking_delta", text: delta };
    }

    // Reasoning item started — the model has begun reasoning on the server.
    // Surface this as an empty thinking_delta so the UI can flip to the
    // "thinking" phase ~3s before the summary text actually starts streaming.
    // (Codex emits this at ~1s vs reasoning_summary_text.delta at ~4–10s.)
    if (type === "response.output_item.added") {
      const item = event.item as Record<string, unknown>;
      const itemId = item?.id as string | undefined;
      const itemType = item?.type as string | undefined;
      if (itemId && itemType) {
        outputItemTypes.set(itemId, itemType);
      }
      if (itemType === "reasoning" && options.thinking) {
        yield { type: "thinking_delta", text: "" };
      }
      if (itemId && itemType) {
        const pending = [...pendingOutputTextByPart.entries()]
          .filter(([, pendingPart]) => pendingPart.itemId === itemId)
          .sort(([, a], [, b]) => a.contentIndex - b.contentIndex);
        for (const [key, pendingPart] of pending) {
          pendingOutputTextByPart.delete(key);
          if (!pendingPart.text) continue;
          if (isVisibleOutputItem(itemType)) {
            textAccum += pendingPart.text;
            yield { type: "text_delta", text: pendingPart.text };
          }
        }
      }
    }

    // Tool call started
    if (type === "response.output_item.added") {
      const item = event.item as Record<string, unknown>;
      if (item?.type === "function_call") {
        const callId = item.call_id as string;
        const itemId = item.id as string;
        const id = `${callId}|${itemId}`;
        const name = item.name as string;
        toolCalls.set(id, { id, name, argsJson: (item.arguments as string) || "" });
      }
    }

    // Tool call arguments delta
    if (type === "response.function_call_arguments.delta") {
      const delta = event.delta as string;
      const itemId = event.item_id as string;
      // Find the matching tool call
      for (const [key, tc] of toolCalls) {
        if (key.endsWith(`|${itemId}`)) {
          tc.argsJson += delta;
          yield {
            type: "toolcall_delta",
            id: tc.id,
            name: tc.name,
            argsJson: delta,
          };
          break;
        }
      }
    }

    // Tool call arguments done
    if (type === "response.function_call_arguments.done") {
      const itemId = event.item_id as string;
      const argsStr = event.arguments as string;
      for (const [key, tc] of toolCalls) {
        if (key.endsWith(`|${itemId}`)) {
          tc.argsJson = argsStr;
          break;
        }
      }
    }

    // Item done — capture encrypted reasoning (round-trips next request) and
    // finalize tool calls, recording both in stream arrival order.
    if (type === "response.output_item.done") {
      const item = event.item as Record<string, unknown>;
      if (item?.type === "reasoning") {
        const encrypted = item.encrypted_content as string | undefined;
        const reasoningId = item.id as string | undefined;
        if (encrypted && reasoningId) {
          // Preserve the entire reasoning item verbatim so it round-trips
          // byte-identical (summary defaulted to [] since the API requires an
          // array). Re-emitting the exact item OpenAI returned is what keeps
          // store:false replay valid — reconstructing a subset risks dropping
          // fields the API echoes back.
          orderedItems.push({
            kind: "reasoning",
            part: {
              type: "raw",
              data: { ...item, summary: Array.isArray(item.summary) ? item.summary : [] },
            },
          });
        }
      }
      if (item?.type === "function_call") {
        const callId = item.call_id as string;
        const itemId = item.id as string;
        const id = `${callId}|${itemId}`;
        const tc = toolCalls.get(id);
        if (tc) {
          orderedItems.push({ kind: "tool", id });
          const args = parseToolArguments(tc.argsJson);
          yield {
            type: "toolcall_done",
            id: tc.id,
            name: tc.name,
            args,
          };
        }
      }
    }

    // Response completed
    if (type === "response.completed" || type === "response.done") {
      const resp = event.response as Record<string, unknown> | undefined;
      const usage = resp?.usage as
        | (Record<string, number> & {
            input_tokens_details?: { cached_tokens?: number };
          })
        | undefined;
      if (usage) {
        cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
        inputTokens = (usage.input_tokens ?? 0) - cacheRead;
        outputTokens = usage.output_tokens ?? 0;
      }
    }
  }

  // Finalize content parts. Any encrypted reasoning that arrived before the
  // first tool call leads the message so it precedes the function_call it
  // reasoned about when round-tripped into input; visible answer text sits
  // between leading reasoning and the tool calls.
  const seenTool = new Set<string>();
  let textInserted = false;
  for (const entry of orderedItems) {
    if (entry.kind === "reasoning") {
      contentParts.push(entry.part);
      continue;
    }
    if (textAccum && !textInserted) {
      contentParts.push({ type: "text", text: textAccum });
      textInserted = true;
    }
    const tc = toolCalls.get(entry.id);
    if (!tc || seenTool.has(entry.id)) continue;
    seenTool.add(entry.id);
    const toolCall: ToolCall = {
      type: "tool_call",
      id: tc.id,
      name: tc.name,
      args: parseToolArguments(tc.argsJson),
    };
    contentParts.push(toolCall);
  }
  if (textAccum && !textInserted) {
    contentParts.push({ type: "text", text: textAccum });
  }

  // Tool calls whose output_item.done never arrived (defensive — finalize from
  // the toolCalls map in insertion order so none are dropped).
  for (const [id, tc] of toolCalls) {
    if (seenTool.has(id)) continue;
    seenTool.add(id);
    contentParts.push({
      type: "tool_call",
      id: tc.id,
      name: tc.name,
      args: parseToolArguments(tc.argsJson),
    });
  }

  const hasToolCalls = contentParts.some((p) => p.type === "tool_call");
  const stopReason = hasToolCalls ? "tool_use" : "end_turn";

  const streamResponse: StreamResponse = {
    message: {
      role: "assistant",
      content: contentParts.length > 0 ? contentParts : textAccum || "",
    },
    stopReason,
    usage: { inputTokens, outputTokens, ...(cacheRead > 0 && { cacheRead }) },
  };

  yield { type: "done", stopReason };
  return streamResponse;
}

// ── SSE Parser ─────────────────────────────────────────────

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  for await (const event of readSseStream(body)) {
    const data = event.data.trim();
    if (!data || data === "[DONE]") continue;
    try {
      yield JSON.parse(data) as Record<string, unknown>;
    } catch {
      // skip malformed JSON
    }
  }
}

// ── Message Conversion ─────────────────────────────────────

/**
 * Remap tool call IDs to Codex's stricter ID grammar.
 * Codex expects function-call IDs to start with `fc_`/`fc-` and contain only
 * letters, numbers, underscores, or dashes. Continued sessions can contain IDs
 * from other transports/tools such as `toolu_*` or `fc_tasks:153`.
 */
function remapCodexId(id: string, idMap: Map<string, string>): string {
  const existing = idMap.get(id);
  if (existing) return existing;

  const withPrefix =
    id.startsWith("fc_") || id.startsWith("fc-") ? id : `fc_${id.replace(/^toolu_/, "")}`;
  const sanitized = withPrefix.replace(/[^A-Za-z0-9_-]/g, "_");
  let mapped = sanitized;
  let suffix = 2;
  const used = new Set(idMap.values());
  while (used.has(mapped)) {
    mapped = `${sanitized}_${suffix++}`;
  }
  idMap.set(id, mapped);
  return mapped;
}

/** A raw content part that holds a Codex encrypted reasoning item for round-trip. */
function isEncryptedReasoning(
  data: Record<string, unknown>,
): data is { type: "reasoning"; id: string; encrypted_content: string; summary?: unknown } {
  return (
    data.type === "reasoning" &&
    typeof data.id === "string" &&
    typeof data.encrypted_content === "string"
  );
}

function toCodexInput(
  messages: Message[],
  options?: { supportsImages?: boolean },
): { system: string | undefined; input: unknown[] } {
  let system: string | undefined;
  const input: unknown[] = [];
  const idMap = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === "system") {
      system = msg.content;
      continue;
    }

    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? [{ type: "input_text", text: msg.content }]
          : msg.content.map((part) => {
              if (part.type === "text") return { type: "input_text", text: part.text };
              return {
                type: "input_image",
                detail: "auto",
                image_url: `data:${part.mediaType};base64,${part.data}`,
              };
            });
      input.push({ role: "user", content });
      continue;
    }

    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: msg.content, annotations: [] }],
          status: "completed",
        });
        continue;
      }

      for (const part of msg.content) {
        if (part.type === "raw" && isEncryptedReasoning(part.data)) {
          // Re-emit the captured reasoning item verbatim in its original
          // position so it precedes the following function_call (requires
          // store:false + include reasoning.encrypted_content, both set on the
          // request).
          input.push(part.data);
        } else if (part.type === "text") {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: part.text, annotations: [] }],
            status: "completed",
          });
        } else if (part.type === "tool_call") {
          const [callId, itemId] = part.id.includes("|")
            ? part.id.split("|", 2)
            : [part.id, part.id];
          input.push({
            type: "function_call",
            id: remapCodexId(itemId, idMap),
            call_id: remapCodexId(callId, idMap),
            name: part.name,
            arguments: JSON.stringify(part.args),
          });
        }
        // thinking parts (and non-reasoning raw parts) are skipped for codex input
      }
      continue;
    }

    if (msg.role === "tool") {
      const toolImages: ImageContent[] = [];
      for (const result of msg.content) {
        const [callId] = result.toolCallId.includes("|")
          ? result.toolCallId.split("|", 2)
          : [result.toolCallId];
        const text = toolResultText(result.content);
        input.push({
          type: "function_call_output",
          call_id: remapCodexId(callId, idMap),
          output: text.length > 0 ? text : "(see attached image)",
        });
        if (options?.supportsImages !== false && Array.isArray(result.content)) {
          for (const block of result.content) {
            if (block.type === "image") toolImages.push(block);
          }
        }
      }
      if (toolImages.length > 0) {
        input.push({
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Attached image(s) from tool result:" },
            ...toolImages.map((img) => ({
              type: "input_image",
              detail: "auto",
              image_url: `data:${img.mediaType};base64,${img.data}`,
            })),
          ],
        });
      }
    }
  }

  return { system, input };
}

// ── Tool Conversion ────────────────────────────────────────

function toCodexTools(tools: Tool[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: resolveToolSchema(tool),
    strict: null,
  }));
}

// HTTP error bodies come back as JSON or plain text. Try to extract a clean
// message string + request_id (and the raw error object) so we never spill the
// raw JSON into the UI.
function parseCodexErrorBody(text: string): {
  message?: string;
  requestId?: string;
  errorObj?: Record<string, unknown>;
} {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | undefined;
    const detail = parsed.detail as unknown;
    const message =
      (error?.message as string | undefined) ??
      (parsed.message as string | undefined) ??
      (typeof detail === "string" ? detail : undefined);
    const requestId =
      (parsed.request_id as string | undefined) ??
      (error?.request_id as string | undefined) ??
      (message ? extractRequestIdFromMessage(message) : undefined);
    // Some codex error payloads put the usage-limit fields at the top level
    // rather than under `error` — prefer the nested object but fall back to the
    // whole payload so resets_at / code are still visible.
    const errorObj = error ?? parsed;
    return {
      ...(message ? { message } : {}),
      ...(requestId ? { requestId } : {}),
      ...(errorObj ? { errorObj } : {}),
    };
  } catch {
    // Non-JSON body — return the trimmed text directly, capped so we never
    // splat a huge HTML error page.
    const trimmed = text.trim().slice(0, 240);
    return trimmed ? { message: trimmed } : {};
  }
}

const CODEX_USAGE_LIMIT_CODE = /usage_limit_reached|usage_not_included/i;
const CODEX_RATE_LIMIT_CODE = /rate_limit_exceeded/i;

/**
 * Detect a ChatGPT-subscription usage-window exhaustion from a Codex error
 * payload and build a canonical usage-limit ProviderError. The codex backend
 * returns HTTP 429 with an error `code`/`type` of usage_limit_reached /
 * usage_not_included (hard plan-window stop) or rate_limit_exceeded, plus a
 * `resets_at` (unix seconds) directly or nested under `rate_limits.primary` /
 * `.secondary` (or a `resets_in_seconds` countdown).
 *
 * Returns null for anything that isn't clearly a usage-window stop — a bare
 * transient 429 with no reset info still flows through the normal retry path.
 */
function codexUsageLimitError(
  errorObj: Record<string, unknown> | undefined,
  statusCode: number | undefined,
  requestId: string | undefined,
): ProviderError | null {
  const code = String(errorObj?.code ?? errorObj?.type ?? "");
  const rateLimits = errorObj?.rate_limits as
    | { primary?: { resets_at?: number }; secondary?: { resets_at?: number } }
    | undefined;
  const resetsAtRaw =
    (typeof errorObj?.resets_at === "number" ? (errorObj.resets_at as number) : undefined) ??
    rateLimits?.primary?.resets_at ??
    rateLimits?.secondary?.resets_at;
  const resetsInSeconds =
    typeof errorObj?.resets_in_seconds === "number"
      ? (errorObj.resets_in_seconds as number)
      : undefined;
  const resetsAt =
    typeof resetsAtRaw === "number" && resetsAtRaw > 0
      ? resetsAtRaw
      : resetsInSeconds != null && resetsInSeconds > 0
        ? Math.floor(Date.now() / 1000) + resetsInSeconds
        : undefined;

  const isHardUsage = CODEX_USAGE_LIMIT_CODE.test(code);
  const isRateOr429 = CODEX_RATE_LIMIT_CODE.test(code) || statusCode === 429;
  if (!isHardUsage && !(isRateOr429 && resetsAt != null)) return null;

  return new ProviderError("openai", "ChatGPT usage limit reached", {
    statusCode: statusCode ?? 429,
    ...(requestId ? { requestId } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  });
}
