import { GGAIError } from "../errors.js";
import type { ContentPart, ImageContent, Message, Tool, ToolChoice } from "../types.js";
import { resolveToolSchema } from "../utils/zod-to-json-schema.js";
import { readSseStream } from "../utils/sse.js";
import { toolResultText } from "./transform.js";

/** Provider-neutral shape shared by public and private Responses SSE transports. */
export type ResponsesEvent = Record<string, unknown>;

export interface ResponsesUsagePayload {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
}

export interface ResponsesCompletedPayload extends ResponsesEvent {
  usage?: ResponsesUsagePayload;
}

export interface EncryptedReasoningItem extends Record<string, unknown> {
  type: "reasoning";
  id: string;
  encrypted_content: string;
  summary?: unknown;
}

/** Validate a standard encrypted Responses reasoning item before stateless replay. */
export function isEncryptedReasoningItem(
  data: Record<string, unknown>,
): data is EncryptedReasoningItem {
  return (
    data.type === "reasoning" &&
    typeof data.id === "string" &&
    data.id.length > 0 &&
    typeof data.encrypted_content === "string" &&
    data.encrypted_content.length > 0
  );
}

/** Serialize only validated provider-returned reasoning items. */
export function serializeEncryptedReasoningItem(
  data: Record<string, unknown>,
): EncryptedReasoningItem | undefined {
  return isEncryptedReasoningItem(data) ? data : undefined;
}

/** Preserve an encrypted reasoning item as the framework's raw content part. */
export function parseEncryptedReasoningPart(
  item: Record<string, unknown>,
): ContentPart | undefined {
  if (!isEncryptedReasoningItem(item)) return undefined;
  return {
    type: "raw",
    data: { ...item, summary: Array.isArray(item.summary) ? item.summary : [] },
  };
}

export interface ResponsesToolChoiceOptions {
  transportName: string;
  supportsNamedTool: boolean;
}

/** Convert and validate the framework tool policy for a standard Responses request. */
export function serializeResponsesToolChoice(
  choice: ToolChoice | undefined,
  tools: Tool[] | undefined,
  options: ResponsesToolChoiceOptions,
): string | { type: "function"; name: string } {
  const resolved = choice ?? "auto";
  if (typeof resolved === "object") {
    if (!options.supportsNamedTool) {
      throw new GGAIError(
        `${options.transportName} does not support selecting the named tool \`${resolved.name}\`; use auto, none, or required.`,
        { source: "capability" },
      );
    }
    return { type: "function", name: resolved.name };
  }
  if (resolved === "required" && !tools?.length) {
    throw new GGAIError(
      `${options.transportName} cannot require a tool call when no tools are configured.`,
      { source: "capability" },
    );
  }
  return resolved;
}

export interface ResponsesSseParseDiagnostic {
  stage: "json_parse";
  causeKind: "syntax_error" | "error" | "non_error";
}

export interface ParseResponsesSseOptions {
  /**
   * Providers choose their existing malformed-frame policy at the transport edge.
   * Omitting this callback preserves the Codex behavior of ignoring malformed JSON.
   */
  onMalformedJson?: (diagnostic: ResponsesSseParseDiagnostic) => never;
}

/**
 * Decode the provider-neutral SSE envelope used by Responses APIs.
 *
 * Endpoint, terminal-event, error, and malformed-frame policy remain transport
 * concerns so extracting this parser cannot change either provider's behavior.
 */
export async function* parseResponsesSse(
  body: ReadableStream<Uint8Array>,
  options: ParseResponsesSseOptions = {},
): AsyncGenerator<ResponsesEvent> {
  for await (const event of readSseStream(body)) {
    const data = event.data.trim();
    if (!data || data === "[DONE]") continue;

    try {
      yield JSON.parse(data) as ResponsesEvent;
    } catch (cause) {
      options.onMalformedJson?.(toResponsesSseParseDiagnostic(cause));
    }
  }
}

function toResponsesSseParseDiagnostic(cause: unknown): ResponsesSseParseDiagnostic {
  return {
    stage: "json_parse",
    causeKind:
      cause instanceof SyntaxError
        ? "syntax_error"
        : cause instanceof Error
          ? "error"
          : "non_error",
  };
}

export interface ResponsesInputAdapter {
  encodeToolCallId?: (id: string) => { callId: string; itemId: string };
  encodeToolResultId?: (id: string) => string;
  serializeRawAssistantPart?: (data: Record<string, unknown>) => unknown | undefined;
  includeToolResultImages?: boolean;
}

export interface SerializedResponsesInput {
  system: string | undefined;
  input: unknown[];
}

/** Serialize framework messages into the standard structured Responses input shape. */
export function serializeResponsesInput(
  messages: Message[],
  adapter: ResponsesInputAdapter = {},
): SerializedResponsesInput {
  let system: string | undefined;
  const input: unknown[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      system = message.content;
      continue;
    }

    if (message.role === "user") {
      const content =
        typeof message.content === "string"
          ? [{ type: "input_text", text: message.content }]
          : message.content.map((part) =>
              part.type === "text"
                ? { type: "input_text", text: part.text }
                : {
                    type: "input_image",
                    detail: "auto",
                    image_url: `data:${part.mediaType};base64,${part.data}`,
                  },
            );
      input.push({ role: "user", content });
      continue;
    }

    if (message.role === "assistant") {
      if (typeof message.content === "string") {
        input.push(assistantTextItem(message.content));
        continue;
      }

      for (const part of message.content) {
        if (part.type === "raw") {
          const serialized = adapter.serializeRawAssistantPart?.(part.data);
          if (serialized !== undefined) input.push(serialized);
        } else if (part.type === "text") {
          input.push(assistantTextItem(part.text));
        } else if (part.type === "tool_call") {
          const encodedIds = adapter.encodeToolCallId?.(part.id);
          const itemId = part.itemId ?? encodedIds?.itemId;
          input.push({
            type: "function_call",
            ...(itemId ? { id: itemId } : {}),
            call_id: encodedIds?.callId ?? part.id,
            name: part.name,
            arguments: JSON.stringify(part.args),
          });
        }
      }
      continue;
    }

    const toolImages: ImageContent[] = [];
    for (const result of message.content) {
      const output = toolResultText(result.content);
      input.push({
        type: "function_call_output",
        call_id: adapter.encodeToolResultId?.(result.toolCallId) ?? result.toolCallId,
        output: output.length > 0 ? output : "(see attached image)",
      });
      if (adapter.includeToolResultImages && Array.isArray(result.content)) {
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
          ...toolImages.map((image) => ({
            type: "input_image",
            detail: "auto",
            image_url: `data:${image.mediaType};base64,${image.data}`,
          })),
        ],
      });
    }
  }

  return { system, input };
}

function assistantTextItem(text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
    status: "completed",
  };
}

/** Serialize framework function tools without applying transport request policy. */
export function serializeResponsesTools(
  tools: Tool[],
  options: { strict: boolean | null },
): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: resolveToolSchema(tool),
    strict: options.strict,
  }));
}
