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
import { getEnvironment } from "../utils/env.js";

const DEFAULT_CODE_ASSIST_BASE_URL = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_API_VERSION = "v1internal";
const GEMINI_CLI_USER_AGENT = "google-gemini-cli";
const GEMINI_CLI_API_CLIENT = "gemini-cli/0.0.0";
const CODE_ASSIST_NON_STREAMING_RETRIES = 3;
const CODE_ASSIST_NON_STREAMING_RETRY_DELAY_MS = 1_000;
const SYNTHETIC_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
const CODE_ASSIST_SUPPORTED_MODELS = new Set([
  "gemini-3-pro-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
]);

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
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

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

interface GeminiCodeAssistRequest {
  model: string;
  project?: string;
  user_prompt_id: string;
  request: GeminiGenerateContentRequest;
}

interface GeminiRequestPlan {
  url: URL;
  headers: Record<string, string>;
  body: GeminiCodeAssistRequest;
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
  traceId?: string;
  response?: {
    candidates?: GeminiCandidate[];
    usageMetadata?: GeminiUsageMetadata;
  };
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

function getGoogleProject(options: StreamOptions): string | undefined {
  const env = getEnvironment();
  return options.projectId ?? env?.GOOGLE_CLOUD_PROJECT ?? env?.GOOGLE_CLOUD_PROJECT_ID;
}

function getCodeAssistEndpoint(method: string): URL {
  const env = getEnvironment();
  const endpoint = env?.CODE_ASSIST_ENDPOINT ?? DEFAULT_CODE_ASSIST_BASE_URL;
  const version = env?.CODE_ASSIST_API_VERSION || CODE_ASSIST_API_VERSION;
  return new URL(`${endpoint}/${version}:${method}`);
}

function formatUnsupportedModelMessage(model: string): string {
  return `Gemini OAuth is configured to use the Gemini Code Assist subscription endpoint only. That endpoint does not currently expose model "${model}".`;
}

function formatErrorMessage(status: number, body: string, model: string): string {
  if (status === 404 && !CODE_ASSIST_SUPPORTED_MODELS.has(model)) {
    return `Gemini API error (404): ${body}\n\n${formatUnsupportedModelMessage(model)}`;
  }
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
    ...(options.promptCacheKey ? { session_id: options.promptCacheKey } : {}),
  };
}

function buildCodeAssistRequest(
  options: StreamOptions,
  request: GeminiGenerateContentRequest,
  projectId?: string,
): GeminiCodeAssistRequest {
  return {
    model: options.model,
    ...(projectId ? { project: projectId } : {}),
    user_prompt_id: crypto.randomUUID(),
    request,
  };
}

function buildRequestPlan(options: StreamOptions, method: string): GeminiRequestPlan {
  if (!CODE_ASSIST_SUPPORTED_MODELS.has(options.model)) {
    throw new ProviderError("gemini", formatUnsupportedModelMessage(options.model));
  }

  const projectId = getGoogleProject(options);
  const request = buildGenerateRequest(options);

  return {
    url: getCodeAssistEndpoint(method),
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": GEMINI_CLI_USER_AGENT,
      "X-Goog-Api-Client": GEMINI_CLI_API_CLIENT,
    },
    body: buildCodeAssistRequest(options, request, projectId),
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
  return response.response?.candidates ?? response.candidates;
}

function usageFromResponse(response: GeminiGenerateResponse): GeminiUsageMetadata | undefined {
  return response.response?.usageMetadata ?? response.usageMetadata;
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

function shouldRetryCodeAssistStatus(status: number): boolean {
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

async function fetchCodeAssist(plan: GeminiRequestPlan, options: StreamOptions): Promise<Response> {
  try {
    const response = await fetch(plan.url, {
      method: "POST",
      headers: plan.headers,
      body: JSON.stringify(plan.body),
      signal: options.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const quota = parseGeminiQuota(response.status, text);
      let message = formatErrorMessage(response.status, text, options.model);
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
      });
    }

    return response;
  } catch (err) {
    throw toError(err);
  }
}

async function fetchCodeAssistWithRetry(
  plan: GeminiRequestPlan,
  options: StreamOptions,
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= CODE_ASSIST_NON_STREAMING_RETRIES; attempt++) {
    try {
      return await fetchCodeAssist(plan, options);
    } catch (err) {
      const error = toError(err);
      const statusCode = error instanceof ProviderError ? error.statusCode : undefined;
      if (
        options.signal?.aborted ||
        isAbortError(error) ||
        attempt === CODE_ASSIST_NON_STREAMING_RETRIES ||
        (statusCode != null && !shouldRetryCodeAssistStatus(statusCode))
      ) {
        throw error;
      }
      lastError = error;
    }

    try {
      await sleep(CODE_ASSIST_NON_STREAMING_RETRY_DELAY_MS, options.signal);
    } catch (err) {
      throw toError(err);
    }
  }

  throw lastError ?? new ProviderError("gemini", "Gemini Code Assist request failed.");
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
    ? await fetchCodeAssist(plan, options)
    : await fetchCodeAssistWithRetry(plan, options);

  const contentParts: ContentPart[] = [];
  const pendingToolCalls: ToolCall[] = [];
  let textAccum = "";
  let thinkingAccum = "";
  let stopReason: StreamResponse["stopReason"] = "end_turn";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let toolIndex = 0;

  const handleResponse = function* (chunk: GeminiGenerateResponse): Generator<StreamEvent> {
    const usage = usageFromResponse(chunk);
    if (usage) {
      inputTokens = usage.promptTokenCount ?? inputTokens;
      outputTokens = usage.candidatesTokenCount ?? outputTokens;
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
  const streamResponse: StreamResponse = {
    message: {
      role: "assistant",
      content: contentParts.length > 0 ? contentParts : textAccum,
    },
    stopReason,
    usage: {
      inputTokens: adjustedInputTokens,
      outputTokens,
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
