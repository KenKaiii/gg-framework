import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentPart,
  ServerToolCall,
  ServerToolResult,
  StreamEvent,
  StreamOptions,
  StreamResponse,
  ToolCall,
} from "../types.js";
import { ProviderError } from "../errors.js";
import { StreamResult } from "../utils/event-stream.js";
import {
  normalizeAnthropicStopReason,
  toAnthropicCacheControl,
  toAnthropicMessages,
  toAnthropicThinking,
  toAnthropicToolChoice,
  toAnthropicTools,
} from "./transform.js";

export function streamAnthropic(options: StreamOptions): StreamResult {
  return new StreamResult(runStream(options));
}

async function* runStream(options: StreamOptions): AsyncGenerator<StreamEvent, StreamResponse> {
  const isOAuth = options.apiKey?.startsWith("sk-ant-oat");

  const client = new Anthropic({
    ...(isOAuth
      ? { apiKey: null as unknown as string, authToken: options.apiKey }
      : { apiKey: options.apiKey }),
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(isOAuth
      ? {
          defaultHeaders: {
            "user-agent": "claude-cli/2.1.75",
            "x-app": "cli",
          },
        }
      : {}),
  });

  const cacheControl = toAnthropicCacheControl(options.cacheRetention, options.baseUrl);
  const { system: rawSystem, messages } = toAnthropicMessages(options.messages, cacheControl);

  // OAuth tokens require Claude Code identity in the system prompt
  const system = isOAuth
    ? [
        {
          type: "text" as const,
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        },
        ...(rawSystem ?? []),
      ]
    : rawSystem;

  let maxTokens = options.maxTokens ?? 4096;
  let thinking: Anthropic.ThinkingConfigParam | undefined;
  let outputConfig: Record<string, unknown> | undefined;

  if (options.thinking) {
    const t = toAnthropicThinking(options.thinking, maxTokens, options.model);
    thinking = t.thinking;
    maxTokens = t.maxTokens;
    if (t.outputConfig) {
      outputConfig = t.outputConfig;
    }
  }

  const params: Anthropic.MessageCreateParams = {
    model: options.model,
    max_tokens: maxTokens,
    messages,
    ...(system ? { system: system as Anthropic.MessageCreateParams["system"] } : {}),
    ...(thinking ? { thinking } : {}),
    ...(outputConfig
      ? { output_config: outputConfig as unknown as Anthropic.MessageCreateParams["output_config"] }
      : {}),
    ...(options.temperature != null && !thinking ? { temperature: options.temperature } : {}),
    ...(options.topP != null ? { top_p: options.topP } : {}),
    ...(options.stop ? { stop_sequences: options.stop } : {}),
    ...(options.tools?.length || options.serverTools?.length || options.webSearch
      ? {
          tools: [
            ...(options.tools?.length ? toAnthropicTools(options.tools) : []),
            ...(options.serverTools ?? []),
            ...(options.webSearch ? [{ type: "web_search_20250305", name: "web_search" }] : []),
          ] as Anthropic.MessageCreateParams["tools"],
        }
      : {}),
    ...(options.toolChoice && options.tools?.length
      ? { tool_choice: toAnthropicToolChoice(options.toolChoice) }
      : {}),
    ...(() => {
      const contextEdits = [
        ...(options.compaction ? [{ type: "compact_20260112" }] : []),
        ...(options.clearToolUses ? [{ type: "clear_tool_uses_20250919" }] : []),
      ];
      return contextEdits.length ? { context_management: { edits: contextEdits } } : {};
    })(),
    stream: true,
  } as Anthropic.MessageCreateParams;

  const betaHeaders = [
    ...(isOAuth ? ["claude-code-20250219", "oauth-2025-04-20"] : []),
    ...(options.compaction ? ["compact-2026-01-12"] : []),
    ...(options.clearToolUses ? ["context-management-2025-06-27"] : []),
  ];

  const stream = client.messages.stream(params, {
    signal: options.signal ?? undefined,
    ...(betaHeaders.length ? { headers: { "anthropic-beta": betaHeaders.join(",") } } : {}),
  });

  // ── Accumulation state ──────────────────────────────────
  const contentParts: ContentPart[] = [];

  // Per-block accumulators indexed by content_block_start index
  const blocks = new Map<
    number,
    {
      type: string;
      text: string;
      thinking: string;
      signature: string;
      toolId: string;
      toolName: string;
      argsJson: string;
      input: unknown;
      raw: Record<string, unknown> | null;
    }
  >();

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  let stopReason: string | null = null;

  const keepalive = { type: "keepalive" as const };

  try {
    for await (const event of stream as AsyncIterable<Anthropic.MessageStreamEvent>) {
      switch (event.type) {
        case "message_start": {
          const usage = event.message.usage;
          inputTokens = usage.input_tokens;
          const usageAny = usage as unknown as Record<string, unknown>;
          if (usageAny.cache_read_input_tokens != null) {
            cacheRead = usageAny.cache_read_input_tokens as number;
          }
          if (usageAny.cache_creation_input_tokens != null) {
            cacheWrite = usageAny.cache_creation_input_tokens as number;
          }
          yield keepalive;
          break;
        }

        case "content_block_start": {
          const block = event.content_block;
          const idx = event.index;
          const accum = {
            type: block.type,
            text: "",
            thinking: "",
            signature: "",
            toolId: "",
            toolName: "",
            argsJson: "",
            input: undefined as unknown,
            raw: null as Record<string, unknown> | null,
          };

          if (block.type === "tool_use") {
            accum.toolId = block.id;
            accum.toolName = block.name;
          } else if (block.type === "server_tool_use") {
            accum.toolId = (block as unknown as { id: string }).id;
            accum.toolName = (block as unknown as { name: string }).name;
            accum.input = (block as unknown as { input: unknown }).input;
          } else if (block.type === "redacted_thinking") {
            // Encrypted thinking block — capture the raw data for round-tripping.
            // The API requires these to be sent back verbatim in multi-turn conversations.
            accum.raw = block as unknown as Record<string, unknown>;
          }

          blocks.set(idx, accum);
          yield keepalive;
          break;
        }

        case "content_block_delta": {
          const accum = blocks.get(event.index);
          if (!accum) break;

          const delta = event.delta as unknown as Record<string, unknown>;
          const deltaType = delta.type as string;

          if (deltaType === "text_delta") {
            const text = delta.text as string;
            accum.text += text;
            yield { type: "text_delta", text };
          } else if (deltaType === "thinking_delta") {
            const text = delta.thinking as string;
            accum.thinking += text;
            yield { type: "thinking_delta", text };
          } else if (deltaType === "input_json_delta") {
            const partialJson = delta.partial_json as string;
            accum.argsJson += partialJson;
            yield {
              type: "toolcall_delta",
              id: accum.toolId,
              name: accum.toolName,
              argsJson: partialJson,
            };
          } else if (deltaType === "signature_delta") {
            accum.signature = delta.signature as string;
          }
          break;
        }

        case "content_block_stop": {
          const accum = blocks.get(event.index);
          if (!accum) break;

          if (accum.type === "text") {
            contentParts.push({ type: "text", text: accum.text });
          } else if (accum.type === "thinking") {
            contentParts.push({
              type: "thinking",
              text: accum.thinking,
              signature: accum.signature,
            });
            yield keepalive;
          } else if (accum.type === "tool_use") {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(accum.argsJson) as Record<string, unknown>;
            } catch {
              // malformed JSON — keep empty
            }
            const tc: ToolCall = {
              type: "tool_call",
              id: accum.toolId,
              name: accum.toolName,
              args,
            };
            contentParts.push(tc);
            yield {
              type: "toolcall_done",
              id: tc.id,
              name: tc.name,
              args: tc.args,
            };
          } else if (accum.type === "server_tool_use") {
            const stc: ServerToolCall = {
              type: "server_tool_call",
              id: accum.toolId,
              name: accum.toolName,
              input: accum.input,
            };
            contentParts.push(stc);
            yield {
              type: "server_toolcall",
              id: stc.id,
              name: stc.name,
              input: stc.input,
            };
          } else if (accum.type === "redacted_thinking" && accum.raw) {
            // Preserve encrypted thinking block as raw content for round-tripping.
            // The Anthropic API requires redacted_thinking blocks to be sent back
            // verbatim in subsequent requests when thinking is enabled.
            contentParts.push({ type: "raw", data: accum.raw });
            yield keepalive;
          } else {
            // Retrieve the full block from the SDK's accumulated message
            // for block types we don't explicitly accumulate (e.g. web_search_tool_result)
            const msg = stream.currentMessage;
            const rawBlock = msg?.content[event.index] as unknown as
              | Record<string, unknown>
              | undefined;
            if (rawBlock) {
              const blockType = rawBlock.type as string;
              if (blockType === "web_search_tool_result") {
                const str: ServerToolResult = {
                  type: "server_tool_result",
                  toolUseId: rawBlock.tool_use_id as string,
                  resultType: blockType,
                  data: rawBlock,
                };
                contentParts.push(str);
                yield {
                  type: "server_toolresult",
                  toolUseId: str.toolUseId,
                  resultType: str.resultType,
                  data: str.data,
                };
              } else {
                // Preserve unknown blocks (e.g. compaction) for round-tripping
                contentParts.push({ type: "raw", data: rawBlock });
              }
            }
          }

          blocks.delete(event.index);
          break;
        }

        case "message_delta": {
          const delta = event.delta as unknown as Record<string, unknown>;
          if (delta.stop_reason) {
            stopReason = delta.stop_reason as string;
          }
          const usage = event.usage as unknown as Record<string, unknown> | undefined;
          if (usage?.output_tokens != null) {
            outputTokens = usage.output_tokens as number;
          }
          yield keepalive;
          break;
        }

        // message_stop — loop exits naturally

        default:
          // Unhandled event types (e.g. "ping" heartbeats) — yield keepalive
          // so the idle timer in the agent loop resets on any API activity.
          yield keepalive;
          break;
      }
    }
  } catch (err) {
    throw toError(err);
  }

  const normalizedStop = normalizeAnthropicStopReason(stopReason);

  const response: StreamResponse = {
    message: {
      role: "assistant",
      content: contentParts.length > 0 ? contentParts : "",
    },
    stopReason: normalizedStop,
    usage: {
      inputTokens,
      outputTokens,
      ...(cacheRead != null && { cacheRead }),
      ...(cacheWrite != null && { cacheWrite }),
    },
  };

  yield { type: "done", stopReason: normalizedStop };
  return response;
}

function toError(err: unknown): ProviderError {
  if (err instanceof Anthropic.APIError) {
    return new ProviderError("anthropic", err.message, {
      statusCode: err.status,
      cause: err,
    });
  }
  if (err instanceof Error) {
    return new ProviderError("anthropic", err.message, { cause: err });
  }
  return new ProviderError("anthropic", String(err));
}
