import os from "node:os";
import * as zstd from "@bokuweb/zstd-wasm";
import type {
  ContentPart,
  ImageContent,
  Message,
  StreamEvent,
  StopReason,
  StreamOptions,
  StreamResponse,
  Tool,
  ToolCall,
  ToolChoice,
} from "../types.js";
import {
  GGAIError,
  ProviderError,
  isRawHtmlErrorEcho,
  providerHtmlErrorMessage,
  readHeader,
} from "../errors.js";
import { StreamResult } from "../utils/event-stream.js";
import { providerDiag } from "../utils/diag.js";
import { mergeProviderOptions } from "../utils/provider-options.js";
import { resolveToolSchema } from "../utils/zod-to-json-schema.js";
import { makeStrictToolSchema, UnsupportedStrictSchemaError } from "../utils/strict-tool-schema.js";
import { normalizePromptCacheKey } from "./prompt-cache-key.js";
import {
  downgradeUnsupportedImages,
  downgradeUnsupportedVideos,
  toCodexReasoningEffort,
  toolResultText,
} from "./transform.js";
import { parseToolArguments } from "../utils/json.js";
import { readSseStream } from "../utils/sse.js";
import { extractRequestIdFromMessage } from "../utils/request-id.js";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
// Advertised Codex client version. The ChatGPT backend gates models on it, and
// the live gate can be stricter than the bundled catalog's
// `minimal_client_version`: GPT-6.1 Sol is listed at 0.153.0 there, but the
// server only serves it from 0.159.0 (GET /codex/models?client_version=...,
// 2026-09-30). Below the gate it answers "The '<model>' model is not supported
// when using Codex with a ChatGPT account". Track the latest openai/codex
// `rust-v*` release when adding a model, and check that model's live listing.
// 0.161.0 = latest `rust-v0.161.0` release (2026-10-07).
const CODEX_CLIENT_VERSION = "0.161.0";
// OpenAI's Codex CLI enables zstd request compression by default. Keep tiny
// synthetic/API requests readable, but compress real agent payloads before they
// hit the backend's finite Envoy retry buffer.
const CODEX_REQUEST_COMPRESSION_MIN_BYTES = 16 * 1024;

let zstdInitPromise: Promise<void> | undefined;

interface EncodedCodexRequest {
  body: BodyInit;
  compressed: boolean;
  rawBytes: number;
  encodedBytes: number;
}

async function encodeCodexRequest(body: Record<string, unknown>): Promise<EncodedCodexRequest> {
  const json = JSON.stringify(body);
  const raw = new TextEncoder().encode(json);
  if (raw.byteLength < CODEX_REQUEST_COMPRESSION_MIN_BYTES) {
    return {
      body: json,
      compressed: false,
      rawBytes: raw.byteLength,
      encodedBytes: raw.byteLength,
    };
  }

  try {
    zstdInitPromise ??= zstd.init();
    await zstdInitPromise;
    const compressed = Uint8Array.from(zstd.compress(raw));
    if (compressed.byteLength >= raw.byteLength) {
      return {
        body: json,
        compressed: false,
        rawBytes: raw.byteLength,
        encodedBytes: raw.byteLength,
      };
    }
    return {
      body: compressed,
      compressed: true,
      rawBytes: raw.byteLength,
      encodedBytes: compressed.byteLength,
    };
  } catch (error) {
    // Compression is an optimization, not a reason to make the provider
    // unreachable if the WASM asset is missing in an unusual host.
    providerDiag("codex_request_compression_failed", {
      error: error instanceof Error ? error.message : String(error),
      rawBytes: raw.byteLength,
    });
    return {
      body: json,
      compressed: false,
      rawBytes: raw.byteLength,
      encodedBytes: raw.byteLength,
    };
  }
}

// GPT-6 point releases (gpt-6.1-sol) keep the dotted version in the id, so a
// bare `gpt-6-` prefix would miss them. This is the model family Codex CLI
// serves with Responses-Lite; it also owns the effort floor, verbosity and
// client identity, which stay on even when the lite request shape is turned off.
export function usesResponsesLite(model: string): boolean {
  return model.startsWith("gpt-5.6-") || model.startsWith("gpt-6-") || model.startsWith("gpt-6.");
}

function outputTextKey(itemId: string | undefined, contentIndex: number | undefined): string {
  return `${itemId ?? ""}:${contentIndex ?? 0}`;
}

function isVisibleOutputItem(itemType: string | undefined): boolean {
  return itemType === "message";
}

function toCodexToolChoice(choice: ToolChoice | undefined, tools: Tool[] | undefined): string {
  const resolved = choice ?? "auto";
  if (typeof resolved === "object") {
    throw new GGAIError(
      `OpenAI Codex does not support selecting the named tool \`${resolved.name}\`; use auto, none, or required.`,
      { source: "capability" },
    );
  }
  if (resolved === "required" && !tools?.length) {
    throw new GGAIError("OpenAI Codex cannot require a tool call when no tools are configured.", {
      source: "capability",
    });
  }
  return resolved;
}

export function streamOpenAICodex(options: StreamOptions): StreamResult {
  return new StreamResult(runStream(options), options.signal);
}

async function* runStream(
  options: StreamOptions,
  retriedWithoutReasoning = false,
): AsyncGenerator<StreamEvent, StreamResponse> {
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/codex/responses`;

  const downgradedImages = downgradeUnsupportedImages(options.messages, options.supportsImages);
  // Codex (GPT OAuth) has no video support — always strip video to a placeholder.
  const downgraded = downgradeUnsupportedVideos(downgradedImages, options.supportsVideo);
  const { system, input } = toCodexInput(downgraded, { supportsImages: options.supportsImages });

  const responsesLite = usesResponsesLite(options.model);
  // The lite request shape (header, single tool call per response, all-turns
  // reasoning context) is separately switchable: the server rejects
  // parallel_tool_calls under lite, so every tool call costs a model turn.
  const liteShape = options.responsesLite ?? responsesLite;
  const body: Record<string, unknown> = {
    model: options.model,
    store: false,
    stream: true,
    instructions: system,
    input,
    tool_choice: toCodexToolChoice(options.toolChoice, options.tools),
    parallel_tool_calls: !liteShape,
    include: ["reasoning.encrypted_content"],
  };

  if (options.tools?.length) {
    body.tools = toCodexTools(options.tools, options.strictTools ?? true);
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
    // GPT-5.6/6 require at least low; older models still support thinking off.
    // Apply the floor here for every caller, including one-off prompt rewrites.
    // `ultra` is a client orchestration preset, not a Codex API effort.
    effort: options.thinking
      ? toCodexReasoningEffort(options.thinking, options.model)
      : responsesLite
        ? "low"
        : "none",
    summary: "auto",
    ...(liteShape ? { context: "all_turns" } : {}),
  };
  // Catalog parity: every responses-lite model (gpt-6-astra, gpt-6.1-sol,
  // gpt-6-luna and the older gpt-6-sol and gpt-5.6-sol/terra/luna) declares
  // `support_verbosity: true` with `default_verbosity: "low"` in openai/codex
  // models.json, and the Codex CLI sends `text.verbosity` accordingly. Omitting
  // it leaves the server default in place, which produces noticeably longer
  // outputs — slower turns and heavier usage burn on exactly these
  // deep-reasoning models.
  if (responsesLite) {
    body.text = { verbosity: "low" };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${options.apiKey}`,
    "OpenAI-Beta": "responses=experimental",
    originator: responsesLite ? "codex_cli_rs" : "ggcoder",
    "User-Agent": responsesLite
      ? `codex_cli_rs/${CODEX_CLIENT_VERSION}`
      : `ggcoder (${os.platform()} ${os.release()}; ${os.arch()})`,
    ...(responsesLite ? { version: CODEX_CLIENT_VERSION } : {}),
    ...(liteShape ? { "X-OpenAI-Internal-Codex-Responses-Lite": "true" } : {}),
  };

  if (options.accountId) {
    headers["chatgpt-account-id"] = options.accountId;
  }

  // Match Codex CLI's identity split: prompt_cache_key controls cache routing,
  // while these headers identify the conversation. Sub-agents may deliberately
  // share a cache key when their static prefixes match, but each child keeps an
  // independent transport identity so sticky session state cannot bleed across.
  if (options.transportSessionId) {
    const transportSessionId = normalizePromptCacheKey(options.transportSessionId);
    headers["session_id"] = transportSessionId;
    headers["x-client-request-id"] = transportSessionId;
  }

  const encodedRequest = await encodeCodexRequest(
    mergeProviderOptions(body, options.providerOptions),
  );
  if (encodedRequest.compressed) headers["Content-Encoding"] = "zstd";
  providerDiag("codex_request_body", {
    rawBytes: encodedRequest.rawBytes,
    encodedBytes: encodedRequest.encodedBytes,
    compressed: encodedRequest.compressed,
  });

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: encodedRequest.body,
    signal: options.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const parsed = parseCodexErrorBody(text, response.status);
    const message = parsed.message ?? `Codex API returned HTTP ${response.status}.`;
    const requestId =
      parsed.requestId ??
      readHeader(response.headers, "x-request-id", "openai-request-id", "x-oai-request-id");

    // A rejected encrypted replay item poisons every ordinary retry. Retry once
    // with visible conversation/tool history only, before any output is emitted.
    // Never alter saved messages or bypass server verification of an opaque blob.
    if (
      !retriedWithoutReasoning &&
      !options.signal?.aborted &&
      response.status === 400 &&
      (parsed.errorObj?.code === "invalid_encrypted_content" ||
        /encrypted content.*could not be (?:verified|decrypted|parsed)/i.test(message)) &&
      options.messages.some(
        (msg) =>
          msg.role === "assistant" &&
          Array.isArray(msg.content) &&
          msg.content.some((part) => part.type === "raw" && isEncryptedReasoning(part.data)),
      )
    ) {
      providerDiag("codex_retry_without_encrypted_reasoning", { status: response.status });
      const messages = options.messages.map((msg): Message =>
        msg.role === "assistant" && Array.isArray(msg.content)
          ? {
              ...msg,
              content: msg.content.filter(
                (part) => !(part.type === "raw" && isEncryptedReasoning(part.data)),
              ),
            }
          : msg,
      );
      return yield* runStream({ ...options, messages }, true);
    }

    // ChatGPT-subscription usage-window exhaustion. The codex backend returns
    // HTTP 429 with a usage_limit_reached / usage_not_included / rate_limit_exceeded
    // code and a reset timestamp. Stop immediately with a clear message instead
    // of letting the agent loop retry a 429 it can't recover from.
    const usageLimit = codexUsageLimitError(parsed.errorObj, response.status, requestId);
    if (usageLimit) throw usageLimit;

    let hint: string | undefined;
    if (
      response.status === 400 &&
      message ===
        `The '${options.model}' model is not supported when using Codex with a ChatGPT account.`
    ) {
      hint =
        "This model is not available through your ChatGPT account. " +
        "Choose another available model using the model selector.";
    } else if (response.status === 404 && text.includes("does not exist")) {
      hint =
        "This model is not in OpenAI's current catalog for your ChatGPT account. " +
        "Choose another available model using the model selector.";
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
  // Tool calls whose arguments the server marked final (function_call_arguments.done
  // or output_item.done). Only these are safe to hand to the agent loop, which
  // executes every tool call in the final message.
  const finishedToolCalls = new Set<string>();
  // How the server ended the reply. A complete stream always ends with a
  // terminal response event; without one the body closed mid-reply.
  let terminal:
    { status: "completed" } | { status: "incomplete"; reason: string | undefined } | undefined;
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
  let cacheWrite = 0;
  // Whether any visible reasoning text has streamed yet — a section break is
  // only needed between sections, never before the first one.
  let thinkingTextEmitted = false;

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

    // Each reasoning summary section (Codex sends a short bold headline per
    // section) arrives as its own part with no separator in the text. Without a
    // break they render glued together — "**A****B**" — which also breaks the
    // markdown bold. Mirror the Codex CLI: a blank line between sections.
    if (type === "response.reasoning_summary_part.added") {
      if (options.thinking && thinkingTextEmitted) {
        yield { type: "thinking_delta", text: "\n\n" };
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
      if (options.thinking && delta) {
        thinkingTextEmitted = true;
        yield { type: "thinking_delta", text: delta };
      }
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
          finishedToolCalls.add(key);
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
          finishedToolCalls.add(id);
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

    // Response finished. `response.incomplete` (or a terminal payload whose
    // status is "incomplete") means the server stopped the reply early — at the
    // output-token limit or by content filtering — which must not read as a
    // clean end of turn.
    if (
      type === "response.completed" ||
      type === "response.done" ||
      type === "response.incomplete"
    ) {
      const resp = event.response as Record<string, unknown> | undefined;
      if (type === "response.incomplete" || resp?.status === "incomplete") {
        const details = resp?.incomplete_details as { reason?: unknown } | undefined;
        terminal = {
          status: "incomplete",
          reason: typeof details?.reason === "string" ? details.reason : undefined,
        };
      } else {
        terminal = { status: "completed" };
      }
      const usage = resp?.usage as
        | (Record<string, number> & {
            input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
          })
        | undefined;
      if (usage) {
        cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
        cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
        inputTokens = (usage.input_tokens ?? 0) - cacheRead - cacheWrite;
        outputTokens = usage.output_tokens ?? 0;
      }
    }
  }

  // Silent-partial guard (mirror of anthropic.ts and openai.ts): the body can
  // close cleanly mid-reply, and without a terminal event a cut-off reply —
  // including a tool call whose arguments were still streaming — would look
  // finished. Throw a 504 so the agent loop retries it as a transport failure.
  if (!terminal) {
    throw new ProviderError("openai", "Stream ended before completion (no response.completed).", {
      statusCode: 504,
    });
  }
  // A completed reply holding a tool call whose arguments were never marked
  // final may carry cut-off or mixed-up arguments. Refuse it rather than run a
  // guess. (An incomplete reply drops such calls below: the server already said
  // it stopped early.)
  const droppedToolCalls = [...toolCalls.keys()].filter((id) => !finishedToolCalls.has(id)).length;
  if (terminal.status === "completed") {
    for (const [id, tc] of toolCalls) {
      if (!finishedToolCalls.has(id)) {
        throw new ProviderError(
          "openai",
          `Codex reply completed with an unfinished tool call: ${tc.name} (${id}).`,
          { statusCode: 502 },
        );
      }
    }
  } else {
    providerDiag("codex_incomplete", { reason: terminal.reason ?? null, droppedToolCalls });
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

  // Tool calls finished by function_call_arguments.done alone (no
  // output_item.done) — finalize them in insertion order so none are lost.
  // Unfinished calls only reach this point on an incomplete reply, where their
  // arguments were cut off: drop them.
  for (const [id, tc] of toolCalls) {
    if (seenTool.has(id) || !finishedToolCalls.has(id)) continue;
    seenTool.add(id);
    contentParts.push({
      type: "tool_call",
      id: tc.id,
      name: tc.name,
      args: parseToolArguments(tc.argsJson),
    });
  }
  // The server cuts a reply off at its end, so a dropped call was its last
  // item and any reasoning now at the end of the message led only into it.
  // Drop that too: encrypted reasoning replays into the next request, which
  // expects an item after each reasoning item.
  if (droppedToolCalls > 0) {
    let last = contentParts.at(-1);
    while (last?.type === "raw" && isEncryptedReasoning(last.data)) {
      contentParts.pop();
      last = contentParts.at(-1);
    }
  }

  const hasToolCalls = contentParts.some((p) => p.type === "tool_call");
  const stopReason: StopReason =
    terminal.status === "incomplete"
      ? incompleteStopReason(terminal.reason)
      : hasToolCalls
        ? "tool_use"
        : "end_turn";

  const streamResponse: StreamResponse = {
    message: {
      role: "assistant",
      content: contentParts.length > 0 ? contentParts : textAccum || "",
    },
    stopReason,
    usage: {
      inputTokens,
      outputTokens,
      ...(cacheRead > 0 && { cacheRead }),
      ...(cacheWrite > 0 && { cacheWrite }),
    },
  };

  yield { type: "done", stopReason };
  return streamResponse;
}

/**
 * Map a Responses `incomplete_details.reason` to the stop reason the agent
 * loop acts on: an output-limit cut auto-continues, a content filter stops as a
 * refusal, and anything unrecognised is reported as a provider error rather
 * than passed off as a finished turn.
 */
function incompleteStopReason(reason: string | undefined): StopReason {
  if (reason === "max_output_tokens") return "max_tokens";
  if (reason === "content_filter") return "refusal";
  return "error";
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

function toCodexTools(tools: Tool[], strictTools: boolean): unknown[] {
  return tools.map((tool) => {
    let parameters = resolveToolSchema(tool);
    let strict: true | null = null;
    if (strictTools) {
      try {
        parameters = makeStrictToolSchema(parameters);
        strict = true;
      } catch (error) {
        if (!(error instanceof UnsupportedStrictSchemaError)) throw error;
      }
    }
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters,
      strict,
    };
  });
}

// HTTP error bodies may be JSON, useful plain text, or an HTML edge/proxy page.
// Extract a bounded message plus request ID while keeping raw JSON and markup out
// of every user-facing error path.
function parseCodexErrorBody(
  text: string,
  statusCode: number,
): {
  message?: string;
  requestId?: string;
  errorObj?: Record<string, unknown>;
} {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | undefined;
    const detail = parsed.detail as unknown;
    const rawMessage =
      (error?.message as string | undefined) ??
      (parsed.message as string | undefined) ??
      (typeof detail === "string" ? detail : undefined);
    const message =
      rawMessage && isRawHtmlErrorEcho(rawMessage)
        ? providerHtmlErrorMessage(statusCode)
        : rawMessage;
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
    const trimmed = text.trim();
    if (isRawHtmlErrorEcho(trimmed)) {
      return { message: providerHtmlErrorMessage(statusCode) };
    }
    // Preserve useful plain-text errors, capped to keep accidental proxy output bounded.
    const bounded = trimmed.slice(0, 240);
    return bounded ? { message: bounded } : {};
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
    { primary?: { resets_at?: number }; secondary?: { resets_at?: number } } | undefined;
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
    cause: errorObj,
    statusCode: statusCode ?? 429,
    ...(requestId ? { requestId } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  });
}
