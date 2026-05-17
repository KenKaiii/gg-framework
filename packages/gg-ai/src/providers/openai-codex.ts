import os from "node:os";
import type {
  ContentPart,
  ImageContent,
  Message,
  StreamEvent,
  StreamOptions,
  StreamResponse,
  TextContent,
  Tool,
  ToolCall,
  ToolResultContent,
} from "../types.js";
import { ProviderError } from "../errors.js";
import { StreamResult } from "../utils/event-stream.js";
import { providerDiag } from "../utils/diag.js";
import { zodToJsonSchema } from "../utils/zod-to-json-schema.js";
import { downgradeUnsupportedImages } from "./transform.js";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseToolArguments(argsJson: string): Record<string, unknown> {
  if (!argsJson) return {};
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    const unwrapped = typeof parsed === "string" ? (JSON.parse(parsed) as unknown) : parsed;
    return isJsonObject(unwrapped) ? unwrapped : {};
  } catch {
    return {};
  }
}

function outputTextKey(itemId: string | undefined, contentIndex: number | undefined): string {
  return `${itemId ?? ""}:${contentIndex ?? 0}`;
}

export function streamOpenAICodex(options: StreamOptions): StreamResult {
  return new StreamResult(runStream(options));
}

async function* runStream(options: StreamOptions): AsyncGenerator<StreamEvent, StreamResponse> {
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/codex/responses`;

  const downgraded = downgradeUnsupportedImages(options.messages, options.supportsImages);
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
  body.prompt_cache_key = options.promptCacheKey ?? "ggcoder";
  // Map cacheRetention to OpenAI's prompt_cache_retention. "long" pins the
  // cached prefix for up to 24h (vs the default 5–10 min in-memory window).
  if (options.cacheRetention === "long") {
    body.prompt_cache_retention = "24h";
  }
  if (options.temperature != null && !options.thinking) {
    body.temperature = options.temperature;
  }
  if (options.thinking) {
    body.reasoning = {
      effort: options.thinking,
      summary: "auto",
    };
  }

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
      response.headers.get("x-request-id") ??
      response.headers.get("openai-request-id") ??
      undefined;

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
  const outputItemTypes = new Map<string, string>();
  const outputTextByPart = new Map<string, string>();
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
      const requestId = extractCodexRequestId(message) ?? (event.request_id as string | undefined);
      throw new ProviderError("openai", message, {
        ...(requestId != null ? { requestId } : {}),
        ...(code === "server_error" ? { statusCode: 500 } : {}),
      });
    }

    if (type === "response.failed") {
      const nested = event.error as Record<string, unknown> | undefined;
      const message = (nested?.message as string | undefined) ?? "Codex response failed.";
      const requestId = extractCodexRequestId(message) ?? (event.request_id as string | undefined);
      throw new ProviderError("openai", message, {
        ...(requestId != null ? { requestId } : {}),
      });
    }

    // Text delta. Some Codex streams attach output_text deltas to a reasoning
    // item; route those through thinking_delta so model reasoning never leaks
    // into the assistant's visible text transcript.
    if (type === "response.output_text.delta") {
      const delta = event.delta as string;
      const itemId = event.item_id as string | undefined;
      const contentIndex = event.content_index as number | undefined;
      const key = outputTextKey(itemId, contentIndex);
      outputTextByPart.set(key, `${outputTextByPart.get(key) ?? ""}${delta}`);
      if (itemId && outputItemTypes.get(itemId) === "reasoning") {
        yield { type: "thinking_delta", text: delta };
      } else {
        textAccum += delta;
        yield { type: "text_delta", text: delta };
      }
    }

    // Text done. The final event can contain text not seen in deltas; emit only
    // the missing suffix so consumers don't see duplicate visible output.
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
          if (itemId && outputItemTypes.get(itemId) === "reasoning") {
            yield { type: "thinking_delta", text: missingText };
          } else {
            textAccum += missingText;
            yield { type: "text_delta", text: missingText };
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
      yield { type: "thinking_delta", text: delta };
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
      if (itemType === "reasoning") {
        yield { type: "thinking_delta", text: "" };
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

    // Item done — finalize tool call
    if (type === "response.output_item.done") {
      const item = event.item as Record<string, unknown>;
      if (item?.type === "function_call") {
        const callId = item.call_id as string;
        const itemId = item.id as string;
        const id = `${callId}|${itemId}`;
        const tc = toolCalls.get(id);
        if (tc) {
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

  // Finalize content parts
  if (textAccum) {
    contentParts.push({ type: "text", text: textAccum });
  }

  for (const [, tc] of toolCalls) {
    const args = parseToolArguments(tc.argsJson);
    const toolCall: ToolCall = {
      type: "tool_call",
      id: tc.id,
      name: tc.name,
      args,
    };
    contentParts.push(toolCall);
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
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const dataLines = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());

        if (dataLines.length > 0) {
          const data = dataLines.join("\n").trim();
          if (data && data !== "[DONE]") {
            try {
              yield JSON.parse(data) as Record<string, unknown>;
            } catch {
              // skip malformed JSON
            }
          }
        }
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Message Conversion ─────────────────────────────────────

/**
 * Remap tool call IDs that don't match Codex API's expected prefix.
 * Codex expects IDs starting with `fc_` — Anthropic uses `toolu_*` which gets rejected.
 */
function remapCodexId(id: string, idMap: Map<string, string>): string {
  if (id.startsWith("fc_") || id.startsWith("fc-")) return id;
  const existing = idMap.get(id);
  if (existing) return existing;
  const mapped = `fc_${id.replace(/^toolu_/, "")}`;
  idMap.set(id, mapped);
  return mapped;
}

function codexToolResultText(content: ToolResultContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
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
        if (part.type === "text") {
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
        // thinking parts are skipped for codex input
      }
      continue;
    }

    if (msg.role === "tool") {
      const toolImages: ImageContent[] = [];
      for (const result of msg.content) {
        const [callId] = result.toolCallId.includes("|")
          ? result.toolCallId.split("|", 2)
          : [result.toolCallId];
        const text = codexToolResultText(result.content);
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
    parameters: tool.rawInputSchema ?? zodToJsonSchema(tool.parameters),
    strict: null,
  }));
}

// OpenAI's server_error messages embed the request ID inline ("…request ID
// abc123 in your message"). Pull it out so we can surface it as a structured
// field rather than leaving it buried in the message.
function extractCodexRequestId(message: string): string | undefined {
  const match = message.match(/request ID ([a-z0-9-]{8,})/i);
  return match?.[1];
}

// HTTP error bodies come back as JSON or plain text. Try to extract a clean
// message string + request_id so we never spill the raw JSON into the UI.
function parseCodexErrorBody(text: string): { message?: string; requestId?: string } {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | undefined;
    const message =
      (error?.message as string | undefined) ?? (parsed.message as string | undefined);
    const requestId =
      (parsed.request_id as string | undefined) ??
      (error?.request_id as string | undefined) ??
      (message ? extractCodexRequestId(message) : undefined);
    return { ...(message ? { message } : {}), ...(requestId ? { requestId } : {}) };
  } catch {
    // Non-JSON body — return the trimmed text directly, capped so we never
    // splat a huge HTML error page.
    const trimmed = text.trim().slice(0, 240);
    return trimmed ? { message: trimmed } : {};
  }
}
