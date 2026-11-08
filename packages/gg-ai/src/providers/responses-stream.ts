import type {
  ContentPart,
  ImageContent,
  Message,
  RawContent,
  StopReason,
  StreamEvent,
  StreamResponse,
  ToolCall,
} from "../types.js";
import { ProviderError } from "../errors.js";
import { providerDiag } from "../utils/diag.js";
import { parseToolArguments } from "../utils/json.js";
import { extractRequestIdFromMessage } from "../utils/request-id.js";
import { toolResultText } from "./transform.js";

/**
 * Consumer for the OpenAI Responses stream protocol (`response.output_text.*`,
 * `response.function_call_arguments.*`, `response.output_item.*`, reasoning
 * summaries, `response.completed`/`incomplete`), shared by every transport that
 * speaks it: the ChatGPT Codex backend and xAI's Responses API.
 */
export interface ResponsesStreamContext {
  /** Provider name stamped on errors. */
  provider: string;
  /** Human label used in error messages, e.g. "Codex". */
  label: string;
  /** Prefix for diagnostic event names, e.g. "codex". */
  diagPrefix: string;
  /** Whether reasoning is surfaced to the UI as thinking deltas. */
  thinking: boolean;
  /** Stamped on captured encrypted reasoning so it replays only where it is valid. */
  reasoningOrigin?: string;
  /** Provider-specific mapping of an in-stream error chunk to a hard error. */
  errorChunk?: (
    errorObj: Record<string, unknown>,
    requestId: string | undefined,
  ) => ProviderError | null;
}

/** A raw content part that holds an encrypted Responses reasoning item for round-trip. */
export function isEncryptedReasoning(
  data: Record<string, unknown>,
): data is { type: "reasoning"; id: string; encrypted_content: string; summary?: unknown } {
  return (
    data.type === "reasoning" &&
    typeof data.id === "string" &&
    typeof data.encrypted_content === "string"
  );
}

function outputTextKey(itemId: string | undefined, contentIndex: number | undefined): string {
  return `${itemId ?? ""}:${contentIndex ?? 0}`;
}

function isVisibleOutputItem(itemType: string | undefined): boolean {
  return itemType === "message";
}

export async function* consumeResponsesEvents(
  events: AsyncIterable<Record<string, unknown>>,
  ctx: ResponsesStreamContext,
): AsyncGenerator<StreamEvent, StreamResponse> {
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
  // timing, so we can see what the server sends during the pre-reasoning
  // window and decide whether earlier signals are available to drive the UI.
  const diagStart = Date.now();
  const diagSeen = new Set<string>();

  for await (const event of events) {
    const type = event.type as string | undefined;
    if (!type) continue;

    if (!diagSeen.has(type)) {
      diagSeen.add(type);
      providerDiag(`${ctx.diagPrefix}_event_first`, { type, sinceStartMs: Date.now() - diagStart });
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
        `${ctx.label} stream emitted an error chunk without a message.`;
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
      const usageLimit = ctx.errorChunk?.(nested ?? (event as Record<string, unknown>), requestId);
      if (usageLimit) throw usageLimit;
      throw new ProviderError(ctx.provider, message, {
        ...(requestId != null ? { requestId } : {}),
        ...(code === "server_error" ? { statusCode: 500 } : {}),
      });
    }

    if (type === "response.failed") {
      const nested = event.error as Record<string, unknown> | undefined;
      const message = (nested?.message as string | undefined) ?? `${ctx.label} response failed.`;
      const requestId =
        extractRequestIdFromMessage(message) ?? (event.request_id as string | undefined);
      throw new ProviderError(ctx.provider, message, {
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
      if (ctx.thinking && thinkingTextEmitted) {
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
      if (ctx.thinking && delta) {
        thinkingTextEmitted = true;
        yield { type: "thinking_delta", text: delta };
      } else if (delta) {
        // Hidden reasoning is still proof of life for the agent loop's watchdog.
        yield { type: "keepalive", reasoning: true };
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
      if (itemType === "reasoning") {
        yield ctx.thinking
          ? { type: "thinking_delta", text: "" }
          : { type: "keepalive", reasoning: true };
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
              ...(ctx.reasoningOrigin ? { origin: ctx.reasoningOrigin } : {}),
            },
          });
        }
      }
      if (item?.type === "function_call") {
        const callId = item.call_id as string;
        const itemId = item.id as string;
        const id = `${callId}|${itemId}`;
        // A call announced only by its final item (no output_item.added) is
        // still complete here: take name and arguments from the item itself.
        if (!toolCalls.has(id) && typeof item.name === "string") {
          toolCalls.set(id, {
            id,
            name: item.name,
            argsJson: typeof item.arguments === "string" ? item.arguments : "",
          });
        }
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
      // The terminal payload lists every output item with its type. Text held
      // back because its item was never announced as a message is released
      // now — only for items the server positively types as "message", so
      // reasoning text still can't leak.
      if (Array.isArray(resp?.output)) {
        for (const raw of resp.output as unknown[]) {
          const item = raw as { id?: unknown; type?: unknown } | null;
          if (typeof item?.id !== "string" || typeof item.type !== "string") continue;
          if (!outputItemTypes.has(item.id)) outputItemTypes.set(item.id, item.type);
        }
        const pending = [...pendingOutputTextByPart.entries()].sort(
          ([, a], [, b]) => a.contentIndex - b.contentIndex,
        );
        for (const [key, pendingPart] of pending) {
          if (!isVisibleOutputItem(outputItemTypes.get(pendingPart.itemId))) continue;
          pendingOutputTextByPart.delete(key);
          if (!pendingPart.text) continue;
          textAccum += pendingPart.text;
          yield { type: "text_delta", text: pendingPart.text };
        }
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
    throw new ProviderError(
      ctx.provider,
      "Stream ended before completion (no response.completed).",
      {
        statusCode: 504,
      },
    );
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
          ctx.provider,
          `${ctx.label} reply completed with an unfinished tool call: ${tc.name} (${id}).`,
          { statusCode: 502 },
        );
      }
    }
  } else {
    providerDiag(`${ctx.diagPrefix}_incomplete`, {
      reason: terminal.reason ?? null,
      droppedToolCalls,
    });
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

// ── Message Conversion ─────────────────────────────────────

export function toResponsesInput(
  messages: Message[],
  options: {
    supportsImages?: boolean;
    /** Rewrite a tool-call id into the server's id grammar; identity by default. */
    mapId?: (id: string, idMap: Map<string, string>) => string;
    /** Whether a captured encrypted reasoning part may be replayed to this server. */
    keepReasoning: (part: RawContent) => boolean;
    /**
     * Send assistant text and tool calls in the minimal documented input form:
     * `{ role, content }` messages, and a function_call `id` only when the
     * server itself issued it. For servers (xAI) whose acceptance of the full
     * output-item shape, or of foreign ids like `toolu_*`, isn't guaranteed.
     */
    minimalAssistantItems?: boolean;
  },
): { system: string | undefined; input: unknown[] } {
  const mapId = options.mapId ?? ((id: string) => id);
  const assistantText = (text: string): unknown =>
    options.minimalAssistantItems
      ? { role: "assistant", content: text }
      : {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
          status: "completed",
        };
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
        input.push(assistantText(msg.content));
        continue;
      }

      for (const part of msg.content) {
        if (part.type === "raw" && isEncryptedReasoning(part.data)) {
          if (!options.keepReasoning(part)) continue;
          // Re-emit the captured reasoning item verbatim in its original
          // position so it precedes the following function_call (requires
          // store:false + include reasoning.encrypted_content, both set on the
          // request).
          input.push(part.data);
        } else if (part.type === "text") {
          input.push(assistantText(part.text));
        } else if (part.type === "tool_call") {
          const native = part.id.includes("|");
          const [callId, itemId] = native ? part.id.split("|", 2) : [part.id, part.id];
          // In minimal mode only a server-issued item id (the `call|item` pair
          // this module records) goes back; a foreign id is left out.
          const sendItemId =
            !options.minimalAssistantItems || (native && !!itemId && itemId !== "undefined");
          input.push({
            type: "function_call",
            ...(sendItemId ? { id: mapId(itemId ?? callId, idMap) } : {}),
            call_id: mapId(callId, idMap),
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
          call_id: mapId(callId, idMap),
          output: text.length > 0 ? text : "(see attached image)",
        });
        if (options.supportsImages !== false && Array.isArray(result.content)) {
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
