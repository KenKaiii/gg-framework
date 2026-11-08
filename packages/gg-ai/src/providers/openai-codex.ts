import os from "node:os";
import * as zstd from "@bokuweb/zstd-wasm";
import type {
  Message,
  StreamEvent,
  StreamOptions,
  StreamResponse,
  Tool,
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
} from "./transform.js";
import { readSseStream } from "../utils/sse.js";
import { providerFetch } from "../utils/provider-fetch.js";
import { extractRequestIdFromMessage } from "../utils/request-id.js";
import {
  consumeResponsesEvents,
  isEncryptedReasoning,
  toResponsesInput,
} from "./responses-stream.js";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
// Advertised Codex client version. The ChatGPT backend gates models on it, and
// the live gate can be stricter than the bundled catalog's
// `minimal_client_version`: GPT-6.1 Sol is listed at 0.153.0 there, but the
// server only serves it from 0.159.0 (GET /codex/models?client_version=...,
// 2026-09-30). Below the gate it answers "The '<model>' model is not supported
// when using Codex with a ChatGPT account". Track the latest openai/codex
// `rust-v*` release when adding a model, and check that model's live listing.
const CODEX_CLIENT_VERSION = "0.159.1";
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
  const { system, input } = toResponsesInput(downgraded, {
    supportsImages: options.supportsImages,
    mapId: remapCodexId,
    // Stamped reasoning belongs to another transport (e.g. Grok's) and would
    // be rejected here; Codex's own items are never stamped.
    keepReasoning: (part) => part.origin === undefined,
  });

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
  // Codex Fast mode: the Codex CLI sends `priority` on the wire (its
  // ServiceTier::Fast request value); the ChatGPT backend rejects "fast".
  if (options.speed === "fast") {
    body.service_tier = "priority";
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

  const response = await providerFetch(url, {
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

  return yield* consumeResponsesEvents(parseSSE(response.body), {
    provider: "openai",
    label: "Codex",
    diagPrefix: "codex",
    thinking: !!options.thinking,
    errorChunk: (errorObj, requestId) => codexUsageLimitError(errorObj, undefined, requestId),
  });
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
