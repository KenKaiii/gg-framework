import type {
  ContentPart,
  Message,
  StreamEvent,
  StreamOptions,
  StreamResponse,
  Tool,
  ToolCall,
  ToolChoice,
  ToolResultContent,
} from "../types.js";
import { ProviderError } from "../errors.js";
import { StreamResult } from "../utils/event-stream.js";
import { downgradeUnsupportedImages, downgradeUnsupportedVideos } from "./transform.js";
import { resolveToolSchema } from "../utils/zod-to-json-schema.js";
import { isJsonObject } from "../utils/json.js";
import { readSseStream } from "../utils/sse.js";
import { providerFetch } from "../utils/provider-fetch.js";
import { mergeProviderOptions } from "../utils/provider-options.js";

/** The public Gemini API, reached with a Google AI Studio key. */
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const NON_STREAMING_RETRIES = 3;
const NON_STREAMING_RETRY_DELAY_MS = 1_000;
const SYNTHETIC_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
interface GeminiTextPart {
  text: string;
  thought?: boolean;
  thoughtSignature?: string;
}

interface GeminiInlineDataPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

interface GeminiFunctionCallPart {
  functionCall: {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
  };
  thoughtSignature?: string;
}

interface GeminiFunctionResponsePart {
  functionResponse: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
}

type GeminiPart =
  GeminiTextPart | GeminiInlineDataPart | GeminiFunctionCallPart | GeminiFunctionResponsePart;

interface GeminiContent {
  role?: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiTool {
  functionDeclarations: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
}

interface GeminiGenerationConfig {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  thinkingConfig?: {
    includeThoughts?: boolean;
    thinkingBudget?: number;
    thinkingLevel?: "LOW" | "MEDIUM" | "HIGH";
  };
}

interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  systemInstruction?: GeminiContent;
  tools?: GeminiTool[];
  toolConfig?: {
    functionCallingConfig: {
      mode: "AUTO" | "NONE" | "ANY";
      allowedFunctionNames?: string[];
    };
  };
  generationConfig?: GeminiGenerationConfig;
  session_id?: string;
}

interface GeminiRequestPlan {
  url: URL;
  headers: Record<string, string>;
  body: GeminiGenerateContentRequest;
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

interface GeminiGenerateResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

/**
 * Google rejects a bad AI Studio key with 400 INVALID_ARGUMENT and reason
 * API_KEY_INVALID (verified live, 2026-10-16). Detected by the structured reason.
 */
function isInvalidGeminiApiKey(status: number, body: string): boolean {
  if (status !== 400 && status !== 401 && status !== 403) return false;
  return /"reason"\s*:\s*"API_KEY_INVALID"/.test(body) || /API key not valid/i.test(body);
}

const INVALID_API_KEY_MESSAGE = "Google rejected the Gemini API key: it is not valid.";
const INVALID_API_KEY_HINT =
  "Create a key at aistudio.google.com/apikey and add it again under Gemini in Providers (or `ggcoder login`).";

function formatErrorMessage(status: number, body: string): string {
  return `Gemini API error (${status}): ${body}`;
}

/**
 * Gemini answers HTTP 429 with status `RESOURCE_EXHAUSTED` for two distinct
 * conditions that must be handled differently:
 *
 *  - **Transient per-minute throttle** — the body carries a `RetryInfo` detail
 *    with a short `retryDelay` (e.g. "18s"). Retrying after that delay clears it.
 *  - **Hard quota exhaustion** — daily cap, disabled billing, or an
 *    unprovisioned preview model. No `retryDelay`, and the message says the
 *    capacity/quota is exhausted. Retrying just burns the backoff budget and
 *    misleads the user with "Rate limited — retrying", so the agent loop must
 *    surface it immediately.
 *
 * This returns the parsed signal so the caller can stamp `resetsAt` (transient)
 * onto the ProviderError, or mark it a hard quota error (non-retriable).
 */
interface GeminiQuotaSignal {
  /** Hard exhaustion — the loop should surface immediately, not retry. */
  exhausted: boolean;
  /** Seconds until the throttle clears, parsed from RetryInfo.retryDelay. */
  retryDelaySeconds?: number;
}

function parseRetryDelaySeconds(body: string): number | undefined {
  // RetryInfo.retryDelay is a protobuf Duration string like "18s" or "1.5s".
  const match = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function parseGeminiQuota(status: number, body: string): GeminiQuotaSignal | null {
  if (status !== 429) return null;
  const lower = body.toLowerCase();
  if (!lower.includes("resource_exhausted") && !lower.includes("quota")) return null;
  // The presence of a `RetryInfo.retryDelay` is Gemini's authoritative signal
  // that the 429 is a recoverable throttle: it tells us exactly how long to
  // wait. Its absence means a hard stop (daily cap, disabled billing, or an
  // unprovisioned preview model) that won't clear with a quick retry. We rely
  // on this delay rather than sniffing message wording, since per-minute and
  // per-day quota IDs both appear in the body regardless of which limit fired.
  const retryDelaySeconds = parseRetryDelaySeconds(body);
  const exhausted = retryDelaySeconds === undefined;
  return { exhausted, retryDelaySeconds };
}

function toSystemAndContents(messages: Message[]): {
  systemInstruction?: GeminiContent;
  contents: GeminiContent[];
} {
  let systemText = "";
  const contents: GeminiContent[] = [];
  const toolNamesById = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === "system") {
      systemText = systemText ? `${systemText}\n\n${msg.content}` : msg.content;
      continue;
    }

    if (msg.role === "user") {
      contents.push({
        role: "user",
        parts:
          typeof msg.content === "string"
            ? [{ text: msg.content }]
            : msg.content.map((part): GeminiPart => {
                if (part.type === "text") return { text: part.text };
                // Both image and video ride Gemini's inlineData part shape.
                return { inlineData: { mimeType: part.mediaType, data: part.data } };
              }),
      });
      continue;
    }

    if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      const source = msg.content;
      if (typeof source === "string") {
        if (source) parts.push({ text: source });
      } else {
        for (const part of source) {
          if (part.type === "text" && part.text) {
            parts.push({ text: part.text });
          } else if (part.type === "thinking" && part.text) {
            parts.push({ text: part.text });
          } else if (part.type === "tool_call") {
            toolNamesById.set(part.id, part.name);
            parts.push({
              functionCall: { id: part.id, name: part.name, args: part.args },
              thoughtSignature: SYNTHETIC_THOUGHT_SIGNATURE,
            });
          }
        }
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }

    if (msg.role === "tool") {
      const parts: GeminiPart[] = [];
      for (const result of msg.content) {
        const name = toolNamesById.get(result.toolCallId) ?? result.toolCallId;
        const content =
          typeof result.content === "string"
            ? result.content
            : stringifyToolContent(result.content);
        parts.push({
          functionResponse: {
            id: result.toolCallId,
            name,
            response: {
              content,
              ...(result.isError ? { isError: true } : {}),
            },
          },
        });
        // functionResponse can't carry media, so a tool that returned video
        // (e.g. read on a .mp4) gets its clips appended as inlineData parts the
        // model actually watches. stringifyToolContent left a text marker above.
        if (typeof result.content !== "string") {
          for (const block of result.content) {
            if (block.type === "video") {
              parts.push({ inlineData: { mimeType: block.mediaType, data: block.data } });
            }
          }
        }
      }
      if (parts.length > 0) contents.push({ role: "user", parts });
    }
  }

  return {
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    contents,
  };
}

function stringifyToolContent(content: Exclude<ToolResultContent, string>): string {
  return content
    .map((part) => (part.type === "text" ? part.text : `[image ${part.mediaType}]`))
    .join("\n");
}

function toGeminiTools(tools: Tool[] | undefined): GeminiTool[] | undefined {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: sanitizeSchema(resolveToolSchema(tool)),
      })),
    },
  ];
}

function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  stripUnsupportedSchemaFields(clone);
  return clone;
}

function stripUnsupportedSchemaFields(value: unknown): void {
  if (!isJsonObject(value)) {
    if (Array.isArray(value)) {
      for (const item of value) stripUnsupportedSchemaFields(item);
    }
    return;
  }

  delete value.$schema;
  delete value.additionalProperties;
  // Gemini's schema subset has inclusive minimum/maximum only; an exclusive
  // bound (zod .positive()/.lt()) 400s the whole request. Integers keep the
  // exact bound (n+1 / n-1); numbers widen to inclusive, and the tool's own
  // zod schema still rejects the boundary value at execution.
  for (const [key, target, step] of [
    ["exclusiveMinimum", "minimum", 1],
    ["exclusiveMaximum", "maximum", -1],
  ] as const) {
    const bound = value[key];
    if (bound === undefined) continue;
    delete value[key];
    if (typeof bound === "number" && value[target] === undefined) {
      value[target] = value.type === "integer" ? bound + step : bound;
    }
  }

  for (const item of Object.values(value)) {
    if (isJsonObject(item) || Array.isArray(item)) {
      stripUnsupportedSchemaFields(item);
    }
  }
}

function toGeminiToolConfig(
  choice: ToolChoice | undefined,
  tools: Tool[] | undefined,
): GeminiGenerateContentRequest["toolConfig"] | undefined {
  if (!choice || !tools?.length) return undefined;
  if (choice === "auto") return { functionCallingConfig: { mode: "AUTO" } };
  if (choice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.name] } };
}

function isGemini3Model(model: string): boolean {
  return /^gemini-3(?:\.|-|$)/.test(model);
}

function toGemini3ThinkingLevel(
  level: NonNullable<StreamOptions["thinking"]>,
): "LOW" | "MEDIUM" | "HIGH" {
  switch (level) {
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    case "high":
    case "xhigh":
    case "max":
    case "ultra":
      return "HIGH";
  }
}

function toThinkingBudget(level: NonNullable<StreamOptions["thinking"]>): number {
  switch (level) {
    case "low":
      return 1_024;
    case "medium":
      return 8_192;
    case "high":
    case "xhigh":
    case "max":
    case "ultra":
      return 8_192;
  }
}

function toThinkingConfig(
  model: string,
  level: StreamOptions["thinking"],
): GeminiGenerationConfig["thinkingConfig"] | undefined {
  if (!level) return undefined;
  if (isGemini3Model(model)) {
    return {
      includeThoughts: true,
      thinkingLevel: toGemini3ThinkingLevel(level),
    };
  }
  return {
    includeThoughts: true,
    thinkingBudget: toThinkingBudget(level),
  };
}

function buildGenerateRequest(options: StreamOptions): GeminiGenerateContentRequest {
  const downgradedImages = downgradeUnsupportedImages(options.messages, options.supportsImages);
  const downgradedMessages = downgradeUnsupportedVideos(downgradedImages, options.supportsVideo);
  const { systemInstruction, contents } = toSystemAndContents(downgradedMessages);
  const tools = toGeminiTools(options.tools);
  const toolConfig = toGeminiToolConfig(options.toolChoice, options.tools);
  const thinkingConfig = toThinkingConfig(options.model, options.thinking);
  const generationConfig: GeminiGenerationConfig = {
    ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
    ...(options.temperature != null && !options.thinking
      ? { temperature: options.temperature }
      : {}),
    ...(options.topP != null ? { topP: options.topP } : {}),
    ...(options.stop ? { stopSequences: options.stop } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };

  return {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(tools ? { tools } : {}),
    ...(toolConfig ? { toolConfig } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };
}

/** The registry keeps the `gemini-3-flash` id for 3.5 Flash; the public API calls it `gemini-3.5-flash`. */
const API_KEY_MODEL_IDS: Readonly<Record<string, string>> = {
  "gemini-3-flash": "gemini-3.5-flash",
};

function buildRequestPlan(options: StreamOptions, method: string): GeminiRequestPlan {
  const request = mergeProviderOptions(buildGenerateRequest(options), options.providerOptions);
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return {
    url: new URL(
      `${base}/models/${encodeURIComponent(API_KEY_MODEL_IDS[options.model] ?? options.model)}:${method}`,
    ),
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": options.apiKey ?? "",
    },
    body: request,
  };
}

function normalizeGeminiStopReason(reason: string | undefined): StreamResponse["stopReason"] {
  switch (reason) {
    case "MAX_TOKENS":
      return "max_tokens";
    case "STOP":
      return "stop_sequence";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "refusal";
    default:
      return "end_turn";
  }
}

async function* streamSse(response: Response): AsyncGenerator<GeminiGenerateResponse> {
  if (!response.body) return;
  for await (const event of readSseStream(response.body)) {
    if (event.data === "[DONE]") continue;
    yield JSON.parse(event.data) as GeminiGenerateResponse;
  }
}

function candidatesFromResponse(response: GeminiGenerateResponse): GeminiCandidate[] | undefined {
  return response.candidates;
}

function usageFromResponse(response: GeminiGenerateResponse): GeminiUsageMetadata | undefined {
  return response.usageMetadata;
}

function partsFromResponse(response: GeminiGenerateResponse): GeminiPart[] {
  return candidatesFromResponse(response)?.[0]?.content?.parts ?? [];
}

function finishReasonFromResponse(response: GeminiGenerateResponse): string | undefined {
  return candidatesFromResponse(response)?.[0]?.finishReason;
}

function readTextPart(part: GeminiPart): { text: string; thought: boolean } | undefined {
  return "text" in part ? { text: part.text, thought: part.thought === true } : undefined;
}

function readFunctionCallPart(
  part: GeminiPart,
): { id?: string; name: string; args: Record<string, unknown> } | undefined {
  if (!("functionCall" in part)) return undefined;
  return {
    ...(part.functionCall.id ? { id: part.functionCall.id } : {}),
    name: part.functionCall.name,
    args: isJsonObject(part.functionCall.args) ? part.functionCall.args : {},
  };
}

function makeToolCallId(index: number, providerId?: string): string {
  return providerId ?? `gemini_call_${index}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status === 499 || (status >= 500 && status <= 599);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function fetchGemini(plan: GeminiRequestPlan, options: StreamOptions): Promise<Response> {
  try {
    const response = await providerFetch(plan.url, {
      method: "POST",
      headers: plan.headers,
      body: JSON.stringify(plan.body),
      signal: options.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const quota = parseGeminiQuota(response.status, text);
      const invalidKey = isInvalidGeminiApiKey(response.status, text);
      let message = invalidKey
        ? INVALID_API_KEY_MESSAGE
        : formatErrorMessage(response.status, text);
      let resetsAt: number | undefined;
      if (quota?.exhausted) {
        // Stamp the canonical phrase the agent loop matches on so this hard
        // 429 is surfaced immediately instead of retried for minutes.
        message = `Gemini quota exhausted — usage limit reached. ${message}`;
      } else if (quota?.retryDelaySeconds !== undefined) {
        resetsAt = Math.floor(Date.now() / 1000) + Math.ceil(quota.retryDelaySeconds);
      }
      throw new ProviderError("gemini", message, {
        statusCode: response.status,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(invalidKey ? { hint: INVALID_API_KEY_HINT, source: "auth" as const } : {}),
      });
    }

    return response;
  } catch (err) {
    throw toError(err);
  }
}

async function fetchGeminiWithRetry(
  plan: GeminiRequestPlan,
  options: StreamOptions,
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= NON_STREAMING_RETRIES; attempt++) {
    try {
      return await fetchGemini(plan, options);
    } catch (err) {
      const error = toError(err);
      const statusCode = error instanceof ProviderError ? error.statusCode : undefined;
      if (
        options.signal?.aborted ||
        isAbortError(error) ||
        attempt === NON_STREAMING_RETRIES ||
        (statusCode != null && !shouldRetryStatus(statusCode))
      ) {
        throw error;
      }
      lastError = error;
    }

    try {
      await sleep(NON_STREAMING_RETRY_DELAY_MS, options.signal);
    } catch (err) {
      throw toError(err);
    }
  }

  throw lastError ?? new ProviderError("gemini", "Gemini request failed.");
}

export function streamGemini(options: StreamOptions): StreamResult {
  return new StreamResult(runStream(options), options.signal);
}

async function* runStream(options: StreamOptions): AsyncGenerator<StreamEvent, StreamResponse> {
  const useStreaming = options.streaming !== false;
  const method = useStreaming ? "streamGenerateContent" : "generateContent";
  const plan = buildRequestPlan(options, method);
  if (useStreaming) plan.url.searchParams.set("alt", "sse");

  const response = useStreaming
    ? await fetchGemini(plan, options)
    : await fetchGeminiWithRetry(plan, options);

  const contentParts: ContentPart[] = [];
  const pendingToolCalls: ToolCall[] = [];
  let textAccum = "";
  let thinkingAccum = "";
  let stopReason: StreamResponse["stopReason"] = "end_turn";
  let inputTokens = 0;
  let candidateTokens = 0;
  let reasoningTokens = 0;
  let cacheRead = 0;
  let toolIndex = 0;

  const handleResponse = function* (chunk: GeminiGenerateResponse): Generator<StreamEvent> {
    const usage = usageFromResponse(chunk);
    if (usage) {
      inputTokens = usage.promptTokenCount ?? inputTokens;
      candidateTokens = usage.candidatesTokenCount ?? candidateTokens;
      reasoningTokens = usage.thoughtsTokenCount ?? reasoningTokens;
      cacheRead = usage.cachedContentTokenCount ?? cacheRead;
    }

    const reason = finishReasonFromResponse(chunk);
    if (reason) stopReason = normalizeGeminiStopReason(reason);

    for (const part of partsFromResponse(chunk)) {
      const textPart = readTextPart(part);
      if (textPart) {
        if (textPart.thought) {
          thinkingAccum += textPart.text;
          yield { type: "thinking_delta", text: textPart.text };
        } else {
          textAccum += textPart.text;
          yield { type: "text_delta", text: textPart.text };
        }
        continue;
      }

      const functionCall = readFunctionCallPart(part);
      if (functionCall) {
        const id = makeToolCallId(toolIndex++, functionCall.id);
        const argsJson = JSON.stringify(functionCall.args);
        pendingToolCalls.push({
          type: "tool_call",
          id,
          name: functionCall.name,
          args: functionCall.args,
        });
        yield { type: "toolcall_delta", id, name: functionCall.name, argsJson };
      }
    }
  };

  try {
    if (useStreaming) {
      for await (const chunk of streamSse(response)) {
        yield* handleResponse(chunk);
      }
    } else {
      const chunk = (await response.json()) as GeminiGenerateResponse;
      yield* handleResponse(chunk);
    }
  } catch (err) {
    throw toError(err);
  }

  if (thinkingAccum) contentParts.push({ type: "thinking", text: thinkingAccum });
  if (textAccum) contentParts.push({ type: "text", text: textAccum });

  for (const toolCall of pendingToolCalls) {
    contentParts.push(toolCall);
    yield {
      type: "toolcall_done",
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.args,
    };
  }

  if (pendingToolCalls.length > 0) stopReason = "tool_use";

  const adjustedInputTokens = Math.max(0, inputTokens - cacheRead);
  // Gemini reports thoughts separately from candidate output, but both are billed
  // output. Keep the subset for diagnostics while making outputTokens the cost-safe total.
  const outputTokens = candidateTokens + reasoningTokens;
  const streamResponse: StreamResponse = {
    message: {
      role: "assistant",
      content: contentParts.length > 0 ? contentParts : textAccum,
    },
    stopReason,
    usage: {
      inputTokens: adjustedInputTokens,
      outputTokens,
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      ...(cacheRead > 0 ? { cacheRead } : {}),
    },
  };

  yield { type: "done", stopReason };
  return streamResponse;
}

function toError(err: unknown): Error {
  if (err instanceof ProviderError) return err;
  if (err instanceof Error) return new ProviderError("gemini", err.message, { cause: err });
  return new ProviderError("gemini", String(err));
}
