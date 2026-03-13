import os from "node:os";
import type {
  ContentPart,
  Message,
  StreamOptions,
  StreamResponse,
  Tool,
  ToolCall,
} from "../types.js";
import { ProviderError } from "../errors.js";
import { StreamResult } from "../utils/event-stream.js";
import { sanitizeJsonSchema } from "../utils/sanitize-schema.js";
import { zodToJsonSchema } from "../utils/zod-to-json-schema.js";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";

export function streamOpenAICodex(options: StreamOptions): StreamResult {
  const result = new StreamResult();
  runStream(options, result).catch((err) => result.abort(toError(err)));
  return result;
}

async function runStream(options: StreamOptions, result: StreamResult): Promise<void> {
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/codex/responses`;

  const { system, input } = toCodexInput(options.messages);

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
    let message = `Codex API error (${response.status}): ${text}`;

    // Add helpful context for common errors
    if (response.status === 400 && text.includes("not supported")) {
      message +=
        `\n\nHint: Codex models require a ChatGPT Plus ($20/mo) or Pro ($200/mo) subscription. ` +
        `The "codex-spark" variants require ChatGPT Pro. ` +
        `Ensure your account has an active subscription at https://chatgpt.com/settings`;
    }

    throw new ProviderError("openai", message, {
      statusCode: response.status,
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
      const msg = (event.message as string) || JSON.stringify(event);
      throw new ProviderError("openai", `Codex error: ${msg}`);
    }

    if (type === "response.failed") {
      const msg =
        ((event.error as Record<string, unknown>)?.message as string) || "Codex response failed";
      throw new ProviderError("openai", msg);
    }

    // Text delta
    if (type === "response.output_text.delta") {
      const delta = event.delta as string;
      textAccum += delta;
      result.push({ type: "text_delta", text: delta });
    }

    // Thinking delta
    if (type === "response.reasoning_summary_text.delta") {
      const delta = event.delta as string;
      result.push({ type: "thinking_delta", text: delta });
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
          result.push({
            type: "toolcall_delta",
            id: tc.id,
            name: tc.name,
            argsJson: delta,
          });
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
          result.push({
            type: "toolcall_done",
            id: tc.id,
            name: tc.name,
            args,
          });
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

  result.push({ type: "done", stopReason });
  result.complete(streamResponse);
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

function toCodexInput(messages: Message[]): { system: string | undefined; input: unknown[] } {
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
      for (const result of msg.content) {
        const [callId] = result.toolCallId.includes("|")
          ? result.toolCallId.split("|", 2)
          : [result.toolCallId];
        input.push({
          type: "function_call_output",
          call_id: remapCodexId(callId, idMap),
          output: result.content,
        });
      }
    }
  }

  return { system, input };
}

// ── Tool Conversion ────────────────────────────────────────

/**
 * Recursively fix object schemas missing "properties" (required by OpenAI).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeJsonSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  const copy = { ...schema };
  if (copy.type === "object" && !copy.properties) {
    copy.properties = {};
  }
  if (copy.properties && typeof copy.properties === "object") {
    const props = { ...copy.properties };
    for (const key of Object.keys(props)) {
      props[key] = sanitizeJsonSchema(props[key]);
    }
    copy.properties = props;
  }
  if (copy.items) copy.items = sanitizeJsonSchema(copy.items);
  if (Array.isArray(copy.anyOf)) copy.anyOf = copy.anyOf.map(sanitizeJsonSchema);
  if (Array.isArray(copy.oneOf)) copy.oneOf = copy.oneOf.map(sanitizeJsonSchema);
  if (Array.isArray(copy.allOf)) copy.allOf = copy.allOf.map(sanitizeJsonSchema);
  if (copy.additionalProperties && typeof copy.additionalProperties === "object") {
    copy.additionalProperties = sanitizeJsonSchema(copy.additionalProperties);
  }
  return copy;
}

function toCodexTools(tools: Tool[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: sanitizeJsonSchema(tool.rawInputSchema ?? zodToJsonSchema(tool.parameters)),
    strict: null,
  }));
}

// ── Error Handling ─────────────────────────────────────────

function toError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Error) {
    return new ProviderError("openai", err.message, { cause: err });
  }
  return new ProviderError("openai", String(err));
}
