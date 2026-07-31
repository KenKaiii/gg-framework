import { ProviderError, readHeader } from "../errors.js";
import type {
  ContentPart,
  StreamEvent,
  StreamOptions,
  StreamResponse,
  ToolCall,
  Usage,
} from "../types.js";
import { StreamResult } from "../utils/event-stream.js";
import { isJsonObject } from "../utils/json.js";
import {
  parseEncryptedReasoningPart,
  parseResponsesSse,
  serializeEncryptedReasoningItem,
  serializeResponsesInput,
  serializeResponsesToolChoice,
  serializeResponsesTools,
  type ResponsesCompletedPayload,
  type ResponsesSseParseDiagnostic,
} from "./openai-responses-core.js";
import { normalizePromptCacheKey } from "./prompt-cache-key.js";

// eslint-disable-next-line no-control-regex -- Provider error text must not expose control characters.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface AzureErrorMetadata {
  requestId?: string;
  resetsAt?: number;
}

interface PendingAzureToolCall {
  id: string;
  itemId?: string;
  name: string;
  args?: Record<string, unknown>;
  argumentsDone: boolean;
}

interface AzureFunctionCallItem {
  id: string;
  itemId?: string;
  name: string;
  arguments?: string;
}

export type AzureMalformedStreamStage =
  | "json_parse"
  | "text_delta"
  | "reasoning_delta"
  | "output_item_done_reasoning"
  | "response_completed";

export interface AzureMalformedStreamDiagnostic {
  parserStage: AzureMalformedStreamStage;
  causeKind: "syntax_error" | "error" | "non_error" | "none";
}

export class AzureMalformedStreamDiagnosticError extends Error {
  readonly diagnostic: AzureMalformedStreamDiagnostic;

  constructor(diagnostic: AzureMalformedStreamDiagnostic, cause?: unknown) {
    super("Azure malformed stream diagnostic", { cause });
    this.name = "AzureMalformedStreamDiagnosticError";
    this.diagnostic = diagnostic;
  }
}

export function streamAzureOpenAIResponses(options: StreamOptions): StreamResult {
  const generator = options.streaming === false ? runNonStreaming(options) : runStream(options);
  return new StreamResult(generator, options.signal);
}

async function* runStream(options: StreamOptions): AsyncGenerator<StreamEvent, StreamResponse> {
  const apiKey = requireOption(options.apiKey, "apiKey");
  const model = requireOption(options.model, "model");
  const url = parseResponsesUrl(requireOption(options.baseUrl, "baseUrl"));
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const { system, input } = serializeResponsesInput(options.messages, {
    serializeRawAssistantPart: serializeEncryptedReasoningItem,
    includeToolResultImages: options.supportsImages === true,
  });
  const requestBody: Record<string, unknown> = { model, input, stream: true, store: false };
  if (system !== undefined) requestBody.instructions = system;
  if (options.maxTokens !== undefined) requestBody.max_output_tokens = options.maxTokens;
  if (options.promptCacheKey) {
    requestBody.prompt_cache_key = normalizePromptCacheKey(options.promptCacheKey);
  }
  if (options.tools?.length) {
    requestBody.tools = serializeResponsesTools(options.tools, { strict: null });
    requestBody.tool_choice = serializeResponsesToolChoice(options.toolChoice, options.tools, {
      transportName: "Azure OpenAI",
      supportsNamedTool: true,
    });
    requestBody.parallel_tool_calls = true;
  }
  if (options.thinking) {
    requestBody.reasoning = {
      effort: options.thinking === "ultra" ? "xhigh" : options.thinking,
      summary: "auto",
    };
    requestBody.include = ["reasoning.encrypted_content"];
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });
  } catch (cause) {
    throw new ProviderError("azure", "Azure OpenAI request failed.", { cause });
  }

  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw toHttpProviderError(response, responseText, apiKey, url);
  }

  const responseMetadata = azureErrorMetadata(response.headers, undefined, apiKey, url);
  if (!response.body) {
    throw new ProviderError("azure", "Azure OpenAI returned an empty response stream.");
  }

  let accumulatedText = "";
  let completedResponse: ResponsesCompletedPayload | undefined;
  let sawEvent = false;
  const toolCallsByOutputIndex = new Map<number, PendingAzureToolCall>();
  const toolCallsByItem = new Map<string, PendingAzureToolCall>();
  const toolCallOrder: PendingAzureToolCall[] = [];
  const orderedItems: Array<
    | { kind: "reasoning"; itemId?: string; part?: ContentPart }
    | { kind: "tool"; toolCall: PendingAzureToolCall }
  > = [];
  const reasoningItemsById = new Map<
    string,
    Extract<(typeof orderedItems)[number], { kind: "reasoning" }>
  >();

  try {
    for await (const event of parseResponsesSse(response.body, {
      onMalformedJson(diagnostic): never {
        throw malformedStreamError("json_parse", diagnostic);
      },
    })) {
      sawEvent = true;

      if (event.type === "response.output_text.delta") {
        if (typeof event.delta !== "string") throw malformedStreamError("text_delta");
        accumulatedText += event.delta;
        yield { type: "text_delta", text: event.delta };
      } else if (isReasoningDeltaEvent(event.type)) {
        if (typeof event.delta !== "string") throw malformedStreamError("reasoning_delta");
        if (options.thinking) yield { type: "thinking_delta", text: event.delta };
      } else if (event.type === "response.output_item.added") {
        const item = objectValue(event.item);
        if (item?.type === "reasoning") {
          const itemId = nonEmptyString(item.id) ? item.id : undefined;
          const pendingReasoning = { kind: "reasoning" as const, itemId };
          orderedItems.push(pendingReasoning);
          if (itemId) reasoningItemsById.set(itemId, pendingReasoning);
          if (options.thinking) yield { type: "thinking_delta", text: "" };
        } else if (item?.type === "function_call") {
          const outputIndex = parseOutputIndex(event.output_index);
          const parsedCall = parseFunctionCallItem(item, false);
          if (
            toolCallsByOutputIndex.has(outputIndex) ||
            toolCallOrder.some((toolCall) => toolCall.id === parsedCall.id)
          ) {
            throw malformedToolCallStreamError();
          }
          const toolCall: PendingAzureToolCall = {
            id: parsedCall.id,
            name: parsedCall.name,
            argumentsDone: false,
          };
          bindItemId(toolCall, parsedCall.itemId, toolCallsByItem);
          toolCallsByOutputIndex.set(outputIndex, toolCall);
          toolCallOrder.push(toolCall);
          orderedItems.push({ kind: "tool", toolCall });
        }
      } else if (event.type === "response.function_call_arguments.delta") {
        const toolCall = findToolCall(
          event.output_index,
          event.item_id,
          toolCallsByOutputIndex,
          toolCallsByItem,
        );
        if (typeof event.delta !== "string" || toolCall.argumentsDone || toolCall.args) {
          throw malformedToolCallStreamError();
        }
        yield {
          type: "toolcall_delta",
          id: toolCall.id,
          name: toolCall.name,
          argsJson: event.delta,
        };
      } else if (event.type === "response.function_call_arguments.done") {
        const toolCall = findToolCall(
          event.output_index,
          event.item_id,
          toolCallsByOutputIndex,
          toolCallsByItem,
        );
        if (typeof event.arguments !== "string" || toolCall.argumentsDone || toolCall.args) {
          throw malformedToolCallStreamError();
        }
        toolCall.argumentsDone = true;
      } else if (event.type === "response.output_item.done") {
        const item = objectValue(event.item);
        if (item?.type === "reasoning") {
          const part = parseEncryptedReasoningPart(item);
          if (!part) {
            if (!isNonReplayableTerminalReasoningItem(item)) {
              throw malformedStreamError("output_item_done_reasoning");
            }
            const pendingReasoning = reasoningItemsById.get(item.id);
            if (pendingReasoning) {
              reasoningItemsById.delete(item.id);
              orderedItems.splice(orderedItems.indexOf(pendingReasoning), 1);
            }
          } else {
            const pendingReasoning = reasoningItemsById.get(item.id as string);
            if (pendingReasoning) pendingReasoning.part = part;
            else orderedItems.push({ kind: "reasoning", itemId: item.id as string, part });
          }
        } else if (item?.type === "function_call") {
          const toolCall = findToolCall(
            event.output_index,
            item.id,
            toolCallsByOutputIndex,
            toolCallsByItem,
          );
          const completedCall = parseFunctionCallItem(item, true);
          if (
            toolCall.args ||
            toolCall.id !== completedCall.id ||
            toolCall.name !== completedCall.name
          ) {
            throw malformedToolCallStreamError();
          }
          const args = parseCompleteToolArguments(completedCall.arguments!);
          toolCall.args = args;
          yield toToolCallDoneEvent(toolCall, args);
        }
      } else if (event.type === "response.completed") {
        if (completedResponse) throw malformedStreamError("response_completed");
        assertAllToolCallsCompleted(toolCallOrder);
        if (orderedItems.some((item) => item.kind === "reasoning" && !item.part)) {
          throw malformedStreamError("response_completed");
        }
        completedResponse = asCompletedResponse(event.response);
      } else {
        const streamError = toStreamProviderError(event, apiKey, url, responseMetadata);
        if (streamError) throw streamError;
      }
    }
  } catch (cause) {
    if (cause instanceof ProviderError) throw cause;
    throw new ProviderError("azure", "Azure OpenAI response stream failed.", { cause });
  }

  if (!sawEvent) {
    throw new ProviderError("azure", "Azure OpenAI returned an empty response stream.");
  }
  if (!completedResponse) {
    throw new ProviderError(
      "azure",
      "Azure OpenAI response stream ended before response.completed.",
    );
  }

  const content: ContentPart[] = [];
  let textInserted = false;
  for (const item of orderedItems) {
    if (item.kind === "reasoning") {
      if (item.part) content.push(item.part);
      continue;
    }
    if (accumulatedText && !textInserted) {
      content.push({ type: "text", text: accumulatedText });
      textInserted = true;
    }
    const pending = item.toolCall;
    const toolCall: ToolCall = {
      type: "tool_call",
      id: pending.id,
      ...(pending.itemId ? { itemId: pending.itemId } : {}),
      name: pending.name,
      args: pending.args!,
    };
    content.push(toolCall);
  }
  if (accumulatedText && !textInserted) content.push({ type: "text", text: accumulatedText });
  const stopReason = toolCallOrder.length > 0 ? ("tool_use" as const) : ("end_turn" as const);
  const streamResponse: StreamResponse = {
    message: {
      role: "assistant",
      content: content.some((part) => part.type !== "text") ? content : accumulatedText,
    },
    stopReason,
    usage: toUsage(completedResponse.usage),
  };

  yield { type: "done", stopReason };
  return streamResponse;
}

async function* runNonStreaming(
  options: StreamOptions,
): AsyncGenerator<StreamEvent, StreamResponse> {
  const apiKey = requireOption(options.apiKey, "apiKey");
  const model = requireOption(options.model, "model");
  const url = parseResponsesUrl(requireOption(options.baseUrl, "baseUrl"));
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const { system, input } = serializeResponsesInput(options.messages, {
    serializeRawAssistantPart: serializeEncryptedReasoningItem,
    includeToolResultImages: options.supportsImages === true,
  });
  const requestBody: Record<string, unknown> = { model, input, stream: false, store: false };
  if (system !== undefined) requestBody.instructions = system;
  if (options.maxTokens !== undefined) requestBody.max_output_tokens = options.maxTokens;
  if (options.promptCacheKey) {
    requestBody.prompt_cache_key = normalizePromptCacheKey(options.promptCacheKey);
  }
  if (options.tools?.length) {
    requestBody.tools = serializeResponsesTools(options.tools, { strict: null });
    requestBody.tool_choice = serializeResponsesToolChoice(options.toolChoice, options.tools, {
      transportName: "Azure OpenAI",
      supportsNamedTool: true,
    });
    requestBody.parallel_tool_calls = true;
  }
  if (options.thinking) {
    requestBody.reasoning = {
      effort: options.thinking === "ultra" ? "xhigh" : options.thinking,
      summary: "auto",
    };
    requestBody.include = ["reasoning.encrypted_content"];
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });
  } catch (cause) {
    throw new ProviderError("azure", "Azure OpenAI request failed.", { cause });
  }

  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw toHttpProviderError(response, responseText, apiKey, url);
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch (cause) {
    throw malformedNonStreamingResponseError(cause);
  }
  const completedResponse = asNonStreamingResponse(value);
  const responseMetadata = azureErrorMetadata(response.headers, completedResponse, apiKey, url);
  const providerError = toNonStreamingProviderError(
    completedResponse,
    apiKey,
    url,
    responseMetadata,
  );
  if (providerError) throw providerError;

  const output = completedResponse.output;
  if (!Array.isArray(output)) throw malformedNonStreamingResponseError();

  let accumulatedText = "";
  const toolCallIds = new Set<string>();
  const orderedItems: Array<
    { kind: "reasoning"; part: ContentPart } | { kind: "tool"; toolCall: ToolCall }
  > = [];

  for (const outputValue of output) {
    const item = objectValue(outputValue);
    if (!item || typeof item.type !== "string") throw malformedNonStreamingResponseError();

    if (item.type === "reasoning") {
      const part = parseEncryptedReasoningPart(item);
      if (!part) throw malformedNonStreamingResponseError();
      orderedItems.push({ kind: "reasoning", part });
      if (options.thinking) {
        yield { type: "thinking_delta", text: "" };
        const summary = item.summary;
        if (summary !== undefined && !Array.isArray(summary)) {
          throw malformedNonStreamingResponseError();
        }
        for (const summaryValue of summary ?? []) {
          const summaryItem = objectValue(summaryValue);
          if (summaryItem?.type !== "summary_text" || typeof summaryItem.text !== "string") {
            throw malformedNonStreamingResponseError();
          }
          yield { type: "thinking_delta", text: summaryItem.text };
        }
      }
      continue;
    }

    if (item.type === "message") {
      if (!Array.isArray(item.content)) throw malformedNonStreamingResponseError();
      for (const contentValue of item.content) {
        const contentItem = objectValue(contentValue);
        if (contentItem?.type !== "output_text") continue;
        if (typeof contentItem.text !== "string") throw malformedNonStreamingResponseError();
        accumulatedText += contentItem.text;
        yield { type: "text_delta", text: contentItem.text };
      }
      continue;
    }

    if (item.type === "function_call") {
      const parsedCall = parseFunctionCallItem(item, true);
      if (toolCallIds.has(parsedCall.id)) throw malformedNonStreamingToolCallError();
      toolCallIds.add(parsedCall.id);
      const args = parseNonStreamingToolArguments(parsedCall.arguments!);
      const toolCall: ToolCall = {
        type: "tool_call",
        id: parsedCall.id,
        ...(parsedCall.itemId ? { itemId: parsedCall.itemId } : {}),
        name: parsedCall.name,
        args,
      };
      orderedItems.push({ kind: "tool", toolCall });
      yield {
        type: "toolcall_delta",
        id: parsedCall.id,
        name: parsedCall.name,
        argsJson: parsedCall.arguments!,
      };
      yield {
        type: "toolcall_done",
        id: parsedCall.id,
        ...(parsedCall.itemId ? { itemId: parsedCall.itemId } : {}),
        name: parsedCall.name,
        args,
      };
    }
  }

  const content: ContentPart[] = [];
  let textInserted = false;
  for (const item of orderedItems) {
    if (item.kind === "reasoning") {
      content.push(item.part);
      continue;
    }
    if (accumulatedText && !textInserted) {
      content.push({ type: "text", text: accumulatedText });
      textInserted = true;
    }
    content.push(item.toolCall);
  }
  if (accumulatedText && !textInserted) content.push({ type: "text", text: accumulatedText });

  const stopReason = toolCallIds.size > 0 ? ("tool_use" as const) : ("end_turn" as const);
  const streamResponse: StreamResponse = {
    message: {
      role: "assistant",
      content: content.some((part) => part.type !== "text") ? content : accumulatedText,
    },
    stopReason,
    usage: toUsage(completedResponse.usage),
  };

  yield { type: "done", stopReason };
  return streamResponse;
}

function isReasoningDeltaEvent(type: unknown): boolean {
  return (
    type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta"
  );
}

function requireOption(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new ProviderError("azure", `Azure OpenAI requires StreamOptions.${name}.`);
  }
  return value;
}

function parseResponsesUrl(value: string): string {
  const configurationError = () =>
    new ProviderError(
      "azure",
      "Azure OpenAI baseUrl must be a full HTTPS URL ending in /responses, without credentials or a fragment.",
    );

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError();
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !url.pathname.endsWith("/responses")
  ) {
    throw configurationError();
  }

  return url.toString();
}

function parseFunctionCallItem(
  item: Record<string, unknown>,
  requireArguments: boolean,
): AzureFunctionCallItem {
  if (
    !nonEmptyString(item.call_id) ||
    (item.id !== undefined && !nonEmptyString(item.id)) ||
    !nonEmptyString(item.name) ||
    (requireArguments && typeof item.arguments !== "string") ||
    (!requireArguments && item.arguments !== undefined && typeof item.arguments !== "string")
  ) {
    throw malformedToolCallStreamError();
  }
  return {
    id: item.call_id,
    ...(typeof item.id === "string" ? { itemId: item.id } : {}),
    name: item.name,
    ...(typeof item.arguments === "string" ? { arguments: item.arguments } : {}),
  };
}

function parseOutputIndex(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw malformedToolCallStreamError();
  return value as number;
}

function findToolCall(
  outputIndex: unknown,
  itemId: unknown,
  toolCallsByOutputIndex: Map<number, PendingAzureToolCall>,
  toolCallsByItem: Map<string, PendingAzureToolCall>,
): PendingAzureToolCall {
  const toolCall = toolCallsByOutputIndex.get(parseOutputIndex(outputIndex));
  if (!toolCall) throw malformedToolCallStreamError();
  bindItemId(toolCall, itemId, toolCallsByItem);
  return toolCall;
}

function bindItemId(
  toolCall: PendingAzureToolCall,
  itemId: unknown,
  toolCallsByItem: Map<string, PendingAzureToolCall>,
): void {
  if (itemId === undefined) return;
  if (!nonEmptyString(itemId)) throw malformedToolCallStreamError();
  const boundToolCall = toolCallsByItem.get(itemId);
  if (
    (toolCall.itemId && toolCall.itemId !== itemId) ||
    (boundToolCall && boundToolCall !== toolCall)
  ) {
    throw malformedToolCallStreamError();
  }
  toolCall.itemId = itemId;
  toolCallsByItem.set(itemId, toolCall);
}

function parseCompleteToolArguments(argsJson: string): Record<string, unknown> {
  try {
    const args = JSON.parse(argsJson) as unknown;
    if (isJsonObject(args)) return args;
  } catch {
    // Fall through to the deterministic public protocol error.
  }
  throw malformedToolCallStreamError();
}

function assertAllToolCallsCompleted(toolCalls: PendingAzureToolCall[]): void {
  if (toolCalls.some((toolCall) => !toolCall.args)) {
    throw incompleteToolCallStreamError();
  }
}

function toToolCallDoneEvent(
  toolCall: PendingAzureToolCall,
  args: Record<string, unknown>,
): Extract<StreamEvent, { type: "toolcall_done" }> {
  return {
    type: "toolcall_done",
    id: toolCall.id,
    ...(toolCall.itemId ? { itemId: toolCall.itemId } : {}),
    name: toolCall.name,
    args,
  };
}

function malformedToolCallStreamError(): ProviderError {
  return new ProviderError("azure", "Azure OpenAI returned a malformed tool-call stream.");
}

function incompleteToolCallStreamError(): ProviderError {
  return new ProviderError(
    "azure",
    "Azure OpenAI tool-call stream ended before all calls completed.",
  );
}

function malformedStreamError(
  parserStage: AzureMalformedStreamStage,
  parseDiagnostic?: ResponsesSseParseDiagnostic,
): ProviderError {
  const diagnostic = azureMalformedStreamDiagnostic(parserStage, parseDiagnostic);
  return new ProviderError("azure", "Azure OpenAI returned a malformed response stream.", {
    cause: new AzureMalformedStreamDiagnosticError(diagnostic),
  });
}

function azureMalformedStreamDiagnostic(
  parserStage: AzureMalformedStreamStage,
  parseDiagnostic: ResponsesSseParseDiagnostic | undefined,
): AzureMalformedStreamDiagnostic {
  return {
    parserStage,
    causeKind: parseDiagnostic?.causeKind ?? "none",
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonReplayableTerminalReasoningItem(
  item: Record<string, unknown>,
): item is Record<string, unknown> & { id: string } {
  return (
    nonEmptyString(item.id) &&
    (item.encrypted_content === undefined ||
      item.encrypted_content === null ||
      item.encrypted_content === "") &&
    (item.status === undefined || item.status === "incomplete" || item.status === "completed")
  );
}

function asNonStreamingResponse(
  value: unknown,
): ResponsesCompletedPayload & Record<string, unknown> {
  const response = objectValue(value);
  if (!response) throw malformedNonStreamingResponseError();
  return response as ResponsesCompletedPayload & Record<string, unknown>;
}

function toNonStreamingProviderError(
  response: ResponsesCompletedPayload & Record<string, unknown>,
  credential: string,
  endpoint: string,
  metadata: AzureErrorMetadata,
): ProviderError | undefined {
  if (response.status === "failed" || response.error !== undefined) {
    return toStreamProviderError(
      { type: "response.failed", response },
      credential,
      endpoint,
      metadata,
    );
  }
  if (response.status === "incomplete") {
    return toStreamProviderError(
      { type: "response.incomplete", response },
      credential,
      endpoint,
      metadata,
    );
  }
  if (response.status !== undefined && response.status !== "completed") {
    return malformedNonStreamingResponseError();
  }
  return undefined;
}

function parseNonStreamingToolArguments(argsJson: string): Record<string, unknown> {
  try {
    const args = JSON.parse(argsJson) as unknown;
    if (isJsonObject(args)) return args;
  } catch {
    // Fall through to the deterministic public protocol error.
  }
  throw malformedNonStreamingToolCallError();
}

function malformedNonStreamingToolCallError(): ProviderError {
  return new ProviderError("azure", "Azure OpenAI returned a malformed tool call.");
}

function malformedNonStreamingResponseError(cause?: unknown): ProviderError {
  return new ProviderError("azure", "Azure OpenAI returned a malformed response.", { cause });
}

function asCompletedResponse(value: unknown): ResponsesCompletedPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw malformedStreamError("response_completed");
  }
  return value as ResponsesCompletedPayload;
}

function toStreamProviderError(
  event: Record<string, unknown>,
  credential: string,
  endpoint: string,
  metadata: AzureErrorMetadata = {},
): ProviderError | undefined {
  if (event.type === "error") {
    const error = objectValue(event.error);
    const message = sanitizeErrorMessage(
      stringValue(error?.message) ?? stringValue(event.message),
      credential,
      endpoint,
    );
    const statusCode = streamErrorStatus(
      stringValue(error?.type) ?? stringValue(error?.code) ?? stringValue(event.code),
    );
    return new ProviderError("azure", message ?? "Azure OpenAI stream returned an error.", {
      ...(statusCode ? { statusCode } : {}),
      ...mergeAzureErrorMetadata(metadata, event, credential, endpoint),
    });
  }

  if (event.type === "response.failed") {
    const response = objectValue(event.response);
    const error = objectValue(response?.error);
    const message = sanitizeErrorMessage(stringValue(error?.message), credential, endpoint);
    const statusCode = streamErrorStatus(stringValue(error?.code));
    return new ProviderError("azure", message ?? "Azure OpenAI response failed.", {
      ...(statusCode ? { statusCode } : {}),
      ...mergeAzureErrorMetadata(metadata, response, credential, endpoint),
    });
  }

  if (event.type === "response.incomplete") {
    const response = objectValue(event.response);
    const details = objectValue(response?.incomplete_details);
    const reason = sanitizeErrorMessage(stringValue(details?.reason), credential, endpoint);
    return new ProviderError(
      "azure",
      reason
        ? `Azure OpenAI response was incomplete: ${reason}.`
        : "Azure OpenAI response was incomplete.",
      mergeAzureErrorMetadata(metadata, response, credential, endpoint),
    );
  }

  return undefined;
}

function streamErrorStatus(type: string | undefined): number | undefined {
  switch (type) {
    case "too_many_requests":
      return 429;
    case "forbidden":
      return 403;
    case "user_error":
      return 400;
    case "server_error":
      return 500;
    default:
      return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toUsage(usage: ResponsesCompletedPayload["usage"]): Usage {
  const cachedTokens = usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage?.input_tokens ?? 0) - cachedTokens),
    outputTokens: usage?.output_tokens ?? 0,
    ...(cachedTokens > 0 ? { cacheRead: cachedTokens } : {}),
  };
}

function toHttpProviderError(
  response: Response,
  body: string,
  credential: string,
  endpoint: string,
): ProviderError {
  const parsedBody = parseErrorBody(body);
  return new ProviderError(
    "azure",
    extractSafeErrorMessage(parsedBody, response.status, credential, endpoint),
    {
      statusCode: response.status,
      ...azureErrorMetadata(response.headers, parsedBody, credential, endpoint),
    },
  );
}

function extractSafeErrorMessage(
  parsedBody: Record<string, unknown> | undefined,
  status: number,
  credential: string,
  endpoint: string,
): string {
  const nested = objectValue(parsedBody?.error);
  const candidate = stringValue(nested?.message) ?? stringValue(parsedBody?.message);
  return (
    sanitizeErrorMessage(candidate, credential, endpoint) || `Azure OpenAI returned HTTP ${status}.`
  );
}

function sanitizeErrorMessage(
  value: string | undefined,
  credential: string,
  endpoint: string,
): string | undefined {
  if (!value || /^\s*[[{]/.test(value) || /\bheaders?\s*[:=]/i.test(value)) return undefined;
  const hostname = endpointHostname(endpoint);
  const escapedHostname = hostname ? escapeRegExp(hostname) : undefined;
  return value
    .replaceAll(credential, "[REDACTED]")
    .replace(/\b(authorization|api-key|cookie|set-cookie)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[REDACTED]")
    .replace(escapedHostname ? new RegExp(escapedHostname, "gi") : /$^/, "[REDACTED]")
    .replace(/<[^>]*>/g, " ")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function parseErrorBody(body: string): Record<string, unknown> | undefined {
  if (!body || body.length > 64 * 1024) return undefined;
  try {
    return objectValue(JSON.parse(body) as unknown);
  } catch {
    return undefined;
  }
}

function azureErrorMetadata(
  headers: unknown,
  payload: Record<string, unknown> | undefined,
  credential: string,
  endpoint: string,
): AzureErrorMetadata {
  const requestId = sanitizeRequestId(
    readHeader(headers, "apim-request-id", "x-request-id", "request-id", "x-ms-request-id") ??
      requestIdFromPayload(payload),
    credential,
    endpoint,
  );
  const resetsAt = retryResetAt(headers, payload);
  return {
    ...(requestId ? { requestId } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function mergeAzureErrorMetadata(
  metadata: AzureErrorMetadata,
  payload: Record<string, unknown> | undefined,
  credential: string,
  endpoint: string,
): AzureErrorMetadata {
  return {
    ...azureErrorMetadata(undefined, payload, credential, endpoint),
    ...metadata,
  };
}

function requestIdFromPayload(payload: Record<string, unknown> | undefined): string | undefined {
  const error = objectValue(payload?.error);
  const innerError = objectValue(error?.innererror) ?? objectValue(error?.inner_error);
  return (
    stringValue(payload?.request_id) ??
    stringValue(error?.request_id) ??
    stringValue(innerError?.request_id)
  );
}

function sanitizeRequestId(
  value: string | undefined,
  credential: string,
  endpoint: string,
): string | undefined {
  if (!value || value.includes(credential) || !SAFE_REQUEST_ID.test(value)) return undefined;
  const hostname = endpointHostname(endpoint);
  return hostname && value.toLowerCase().includes(hostname.toLowerCase()) ? undefined : value;
}

function retryResetAt(
  headers: unknown,
  payload: Record<string, unknown> | undefined,
): number | undefined {
  const error = objectValue(payload?.error);
  const retryAfter = readHeader(headers, "retry-after");
  const retryAfterMs = readHeader(headers, "retry-after-ms", "x-ms-retry-after-ms");
  const resetDuration = readHeader(
    headers,
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
  );
  const bodyDelaySeconds = error?.retry_after ?? payload?.retry_after;
  const bodyDelayMs = error?.retry_after_ms ?? payload?.retry_after_ms;
  const delayMs =
    parseRetryAfter(retryAfter) ??
    boundedDelayMs(retryAfterMs, 1) ??
    parseResetDuration(resetDuration) ??
    boundedDelayMs(bodyDelaySeconds, 1_000) ??
    boundedDelayMs(bodyDelayMs, 1);
  return delayMs === undefined
    ? undefined
    : Math.floor(Date.now() / 1000) + Math.ceil(delayMs / 1000);
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return boundedDelayMs(seconds, 1_000);
  const resetTime = Date.parse(value);
  return Number.isFinite(resetTime) ? boundedDelayMs(resetTime - Date.now(), 1) : undefined;
}

function parseResetDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  const parts = normalized.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)/gi);
  let totalMs = 0;
  let consumed = 0;
  let sawPart = false;
  for (const part of parts) {
    if (normalized.slice(consumed, part.index).trim()) return undefined;
    const unit = part[2]!.toLowerCase();
    const unitMs = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
    totalMs += Number(part[1]) * unitMs;
    consumed = part.index + part[0].length;
    sawPart = true;
  }
  if (!sawPart || normalized.slice(consumed).trim()) return undefined;
  return boundedDelayMs(totalMs, 1);
}

function boundedDelayMs(value: unknown, unitMs: number): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.min(Math.ceil(numeric * unitMs), MAX_RETRY_AFTER_MS);
}

function endpointHostname(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).hostname || undefined;
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
