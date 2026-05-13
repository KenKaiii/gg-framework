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
import { zodToJsonSchema } from "../utils/zod-to-json-schema.js";
import { downgradeUnsupportedImages } from "./transform.js";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";

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
      hint =
        "Codex models require a ChatGPT Plus ($20/mo) or Pro ($200/mo) subscription. " +
        'The "codex-spark" variants require ChatGPT Pro. ' +
        "Check your subscription at https://chatgpt.com/settings.";
    } else if (response.status === 404 && text.includes("does not exist")) {
      hint =
        "codex-mini-latest requires an OpenAI Pro ($200/mo) or Max subscription. " +
        "GPT-5.4 and GPT-5.4 Mini work with any active ChatGPT plan.";
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
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of parseSSE(response.body)) {
    const type = event.type as string | undefined;
    if (!type) continue;

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

    // Text delta
    if (type === "response.output_text.delta") {
      const delta = event.delta as string;
      textAccum += delta;
      yield { type: "text_delta", text: delta };
    }

    // Thinking delta
    if (type === "response.reasoning_summary_text.delta") {
      const delta = event.delta as string;
      yield { type: "thinking_delta", text: delta };
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
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.argsJson) as Record<string, unknown>;
          } catch {
            /* malformed JSON */
          }
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
      const usage = resp?.usage as Record<string, number> | undefined;
      if (usage) {
        inputTokens = usage.input_tokens ?? 0;
        outputTokens = usage.output_tokens ?? 0;
      }
    }
  }

  // Finalize content parts
  if (textAccum) {
    contentParts.push({ type: "text", text: textAccum });
  }

  for (const [, tc] of toolCalls) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.argsJson) as Record<string, unknown>;
    } catch {
      /* malformed JSON */
    }
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
    usage: { inputTokens, outputTokens },
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
