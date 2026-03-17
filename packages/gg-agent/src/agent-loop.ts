import {
  stream,
  EventStream,
  type Message,
  type ToolCall,
  type ToolResult,
  type Usage,
  type ContentPart,
  type AssistantMessage,
} from "@kenkaiiii/gg-ai";
import type {
  AgentEvent,
  AgentOptions,
  AgentResult,
  AgentTool,
  ToolContext,
  ToolExecuteResult,
  StructuredToolResult,
} from "./types.js";

const DEFAULT_MAX_TURNS = 100;

/**
 * Detect abort errors — user-initiated cancellation or AbortSignal.
 * These should be caught and handled gracefully, not re-thrown.
 */
export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  const msg = err.message.toLowerCase();
  return msg.includes("aborted") || msg.includes("abort");
}

/**
 * Detect context window overflow errors from LLM providers.
 * Anthropic: "prompt is too long: N tokens > M maximum"
 * OpenAI:    "context_length_exceeded" / "maximum context length"
 */
export function isContextOverflow(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("prompt is too long") ||
    msg.includes("context_length_exceeded") ||
    msg.includes("maximum context length") ||
    (msg.includes("token") && msg.includes("exceed"))
  );
}

/**
 * Detect billing/quota errors — these should NOT be retried.
 * GLM returns HTTP 429 with "Insufficient balance" for quota exhaustion.
 */
export function isBillingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("insufficient balance") ||
    msg.includes("no resource package") ||
    msg.includes("quota exceeded") ||
    msg.includes("billing") ||
    msg.includes("recharge")
  );
}

/**
 * Detect overloaded/rate-limit errors from LLM providers.
 * HTTP 429 (rate limit) or 529/503 (overloaded).
 * Excludes billing/quota errors which won't resolve with a retry.
 */
export function isOverloaded(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (isBillingError(err)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("overloaded") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("429") ||
    msg.includes("529")
  );
}

export async function* agentLoop(
  messages: Message[],
  options: AgentOptions,
): AsyncGenerator<AgentEvent, AgentResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxContinuations = options.maxContinuations ?? 5;
  const toolMap = new Map<string, AgentTool>((options.tools ?? []).map((t) => [t.name, t]));

  const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  let turn = 0;
  let consecutivePauses = 0;
  let overflowRetries = 0;
  let overloadRetries = 0;
  let emptyResponseRetries = 0;
  const MAX_OVERFLOW_RETRIES = 3;
  const MAX_OVERLOAD_RETRIES = 3;
  const MAX_EMPTY_RESPONSE_RETRIES = 3;
  const OVERLOAD_RETRY_DELAY_MS = 3_000;

  try {
    while (turn < maxTurns) {
      options.signal?.throwIfAborted();
      turn++;

      // ── Mid-loop context transform (compaction / truncation) ──
      if (options.transformContext) {
        const transformed = await options.transformContext(messages);
        if (transformed !== messages) {
          messages.length = 0;
          messages.push(...transformed);
        }
      }

      // ── Call LLM with overflow recovery ──
      let response;
      try {
        const result = stream({
          provider: options.provider,
          model: options.model,
          messages,
          tools: options.tools,
          serverTools: options.serverTools,
          webSearch: options.webSearch,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          thinking: options.thinking,
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          signal: options.signal,
          accountId: options.accountId,
          cacheRetention: options.cacheRetention,
          compaction: options.compaction,
        });

        // Suppress unhandled rejection if the iterator path throws first
        result.response.catch(() => {});

        // Forward streaming deltas
        for await (const event of result) {
          if (event.type === "text_delta") {
            yield { type: "text_delta" as const, text: event.text };
          } else if (event.type === "thinking_delta") {
            yield { type: "thinking_delta" as const, text: event.text };
          } else if (event.type === "server_toolcall") {
            yield {
              type: "server_tool_call" as const,
              id: event.id,
              name: event.name,
              input: event.input,
            };
          } else if (event.type === "server_toolresult") {
            yield {
              type: "server_tool_result" as const,
              toolUseId: event.toolUseId,
              resultType: event.resultType,
              data: event.data,
            };
          }
        }

        response = await result.response;
      } catch (err) {
        // Context overflow: force-compact via transformContext and retry (up to 3 times)
        if (
          overflowRetries < MAX_OVERFLOW_RETRIES &&
          isContextOverflow(err) &&
          options.transformContext
        ) {
          overflowRetries++;
          const transformed = await options.transformContext(messages, { force: true });
          if (transformed !== messages) {
            messages.length = 0;
            messages.push(...transformed);
          }
          turn--; // Don't count the failed turn
          continue;
        }
        // Overloaded / rate-limited: wait 3s and retry (up to 3 times)
        if (overloadRetries < MAX_OVERLOAD_RETRIES && isOverloaded(err)) {
          overloadRetries++;
          await new Promise((r) => setTimeout(r, OVERLOAD_RETRY_DELAY_MS));
          turn--; // Don't count the failed turn
          continue;
        }
        // Abort errors (user cancellation) — exit loop cleanly instead of
        // crashing the process with an unhandled rejection.
        if (isAbortError(err) || options.signal?.aborted) {
          break;
        }
        throw err;
      }

      // Reset retry counters after successful call
      overflowRetries = 0;
      overloadRetries = 0;

      // Detect empty/degenerate responses — the API occasionally returns 0 tokens
      // with no content (e.g. stream interruption, transient server issue).
      // Retry instead of treating as completion.
      if (
        response.usage.outputTokens === 0 &&
        (response.message.content === "" ||
          (Array.isArray(response.message.content) && response.message.content.length === 0))
      ) {
        if (emptyResponseRetries < MAX_EMPTY_RESPONSE_RETRIES) {
          emptyResponseRetries++;
          turn--; // Don't count the failed turn
          continue;
        }
        // Exhausted retries — fall through and let the agent finish
      }
      emptyResponseRetries = 0;

      // Accumulate usage
      totalUsage.inputTokens += response.usage.inputTokens;
      totalUsage.outputTokens += response.usage.outputTokens;
      if (response.usage.cacheRead) {
        totalUsage.cacheRead = (totalUsage.cacheRead ?? 0) + response.usage.cacheRead;
      }
      if (response.usage.cacheWrite) {
        totalUsage.cacheWrite = (totalUsage.cacheWrite ?? 0) + response.usage.cacheWrite;
      }

      // Append assistant message to conversation
      messages.push(response.message);

      yield {
        type: "turn_end" as const,
        turn,
        stopReason: response.stopReason,
        usage: response.usage,
      };

      // Server-side tool hit iteration limit — re-send to continue.
      // Do NOT add an extra user message; the API detects the trailing
      // server_tool_use block and resumes automatically.
      if (response.stopReason === "pause_turn") {
        consecutivePauses++;
        if (consecutivePauses >= maxContinuations) {
          break; // Safety limit — fall through to agent_done below
        }
        continue;
      }
      consecutivePauses = 0;

      // Extract tool calls — separate client-executed from provider built-in (e.g. Moonshot $web_search)
      const allToolCalls = extractToolCalls(response.message.content);

      // If no tool calls to execute, check for steering messages before stopping.
      // Check content (not just stopReason) because some providers (e.g. GLM)
      // return finish_reason="stop" even when tool calls are present.
      if (response.stopReason !== "tool_use" && allToolCalls.length === 0) {
        // Check for queued steering messages — if present, inject and continue
        // the loop instead of returning (follow-up pattern).
        if (options.getSteeringMessages) {
          const steering = await options.getSteeringMessages();
          if (steering && steering.length > 0) {
            for (const msg of steering) {
              yield { type: "steering_message" as const, content: msg.content };
              messages.push(msg);
            }
            continue; // Next iteration will call LLM with injected messages
          }
        }
        yield {
          type: "agent_done" as const,
          totalTurns: turn,
          totalUsage: { ...totalUsage },
        };
        return {
          message: response.message,
          totalTurns: turn,
          totalUsage: { ...totalUsage },
        };
      }
      const toolCalls: ToolCall[] = [];
      const toolResults: ToolResult[] = [];

      for (const tc of allToolCalls) {
        if (tc.name.startsWith("$")) {
          // Provider built-in tool (e.g. Moonshot $web_search) — not locally executed.
          // Still needs a tool_result for the message history round-trip.
          toolResults.push({
            type: "tool_result",
            toolCallId: tc.id,
            content: JSON.stringify(tc.args),
          });
        } else {
          toolCalls.push(tc);
        }
      }
      const eventStream = new EventStream<AgentEvent>();

      // Launch all tool calls in parallel
      const executions = toolCalls.map(async (toolCall) => {
        const startTime = Date.now();

        eventStream.push({
          type: "tool_call_start" as const,
          toolCallId: toolCall.id,
          name: toolCall.name,
          args: toolCall.args,
        });

        let resultContent: string;
        let details: unknown;
        let isError = false;

        const tool = toolMap.get(toolCall.name);
        if (!tool) {
          resultContent = `Unknown tool: ${toolCall.name}`;
          isError = true;
        } else {
          try {
            const parsed = tool.parameters.parse(toolCall.args);
            const ctx: ToolContext = {
              signal: options.signal ?? AbortSignal.timeout(300_000),
              toolCallId: toolCall.id,
              onUpdate: (update: unknown) => {
                eventStream.push({
                  type: "tool_call_update" as const,
                  toolCallId: toolCall.id,
                  update,
                });
              },
            };
            const raw = await tool.execute(parsed, ctx);
            const normalized = normalizeToolResult(raw);
            resultContent = normalized.content;
            details = normalized.details;
          } catch (err) {
            isError = true;
            resultContent = err instanceof Error ? err.message : String(err);
          }
        }

        const durationMs = Date.now() - startTime;

        eventStream.push({
          type: "tool_call_end" as const,
          toolCallId: toolCall.id,
          result: resultContent,
          details,
          isError,
          durationMs,
        });

        return { toolCallId: toolCall.id, content: resultContent, isError };
      });

      // Abort the tool event stream when the signal fires so Ctrl+C
      // doesn't hang waiting for long-running tools to finish.
      const abortHandler = () => eventStream.abort(new Error("aborted"));
      options.signal?.addEventListener("abort", abortHandler, { once: true });

      // Close event stream when all tools complete.
      // Track whether the finally block has already consumed toolResults
      // to prevent the race where .then() mutates toolResults after
      // messages.push() has already captured the array by reference.
      let toolResultsFinalized = false;

      Promise.all(executions)
        .then((results) => {
          if (toolResultsFinalized) return;
          const resultsMap = new Map(results.map((r) => [r.toolCallId, r]));
          for (const tc of toolCalls) {
            const r = resultsMap.get(tc.id)!;
            toolResults.push({
              type: "tool_result",
              toolCallId: tc.id,
              content: r.content,
              isError: r.isError || undefined,
            });
          }
          eventStream.close();
        })
        .catch((err) => eventStream.abort(err instanceof Error ? err : new Error(String(err))));

      // Yield events as they arrive from parallel tools
      let toolsAborted = false;
      try {
        for await (const event of eventStream) {
          yield event;
        }
      } catch (err) {
        // Tool event stream aborted (Ctrl+C) — don't propagate, just mark
        // so the finally block can clean up and the loop can exit.
        if (isAbortError(err) || options.signal?.aborted) {
          toolsAborted = true;
        } else {
          throw err;
        }
      } finally {
        options.signal?.removeEventListener("abort", abortHandler);

        // Prevent the Promise.all .then() from mutating toolResults after
        // we finalize and push them into messages.
        toolResultsFinalized = true;

        // Ensure every tool_use has a matching tool_result, even on abort.
        // Without this, an aborted turn leaves an orphaned tool_use in the
        // message history which causes Anthropic API 400 errors on the next
        // request.
        const resolvedIds = new Set(toolResults.map((r) => r.toolCallId));
        for (const tc of toolCalls) {
          if (!resolvedIds.has(tc.id)) {
            toolResults.push({
              type: "tool_result",
              toolCallId: tc.id,
              content: "Tool execution was aborted.",
              isError: true,
            });
          }
        }
        messages.push({ role: "tool", content: toolResults });
      }

      // Exit loop after cleaning up aborted tools
      if (toolsAborted) break;

      // ── Steering messages: inject user messages queued during tool execution ──
      // Polled after tools complete so the next LLM call sees them in context.
      if (options.getSteeringMessages) {
        const steering = await options.getSteeringMessages();
        if (steering && steering.length > 0) {
          for (const msg of steering) {
            yield { type: "steering_message" as const, content: msg.content };
            messages.push(msg);
          }
        }
      }
    }
  } finally {
    // Sanitize orphaned server_tool_use blocks on abort.
    // When a stream is aborted mid-server-tool (e.g. web_search), the
    // assistant message containing the server_tool_use may already be in
    // the messages array, but the corresponding web_search_tool_result
    // never arrived.  The API rejects the next request with a 400 if it
    // finds an unmatched server_tool_use, so we strip it here.
    sanitizeOrphanedServerTools(messages);
  }

  // Exceeded max turns — return last assistant message
  let lastAssistant: AssistantMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAssistant = messages[i] as AssistantMessage;
      break;
    }
  }

  yield {
    type: "agent_done" as const,
    totalTurns: turn,
    totalUsage: { ...totalUsage },
  };

  return {
    message: lastAssistant ?? { role: "assistant" as const, content: [] },
    totalTurns: turn,
    totalUsage: { ...totalUsage },
  };
}

function normalizeToolResult(raw: ToolExecuteResult): StructuredToolResult {
  return typeof raw === "string" ? { content: raw } : raw;
}

function extractToolCalls(content: string | ContentPart[]): ToolCall[] {
  if (typeof content === "string") return [];
  return content.filter((part): part is ToolCall => part.type === "tool_call");
}

/**
 * Remove orphaned server_tool_use blocks from the last assistant message.
 * When a stream is aborted mid-server-tool (e.g. web_search), the assistant
 * message may contain a server_tool_call without a matching server_tool_result.
 * The API rejects the next request if these are unmatched.
 */
function sanitizeOrphanedServerTools(messages: Message[]): void {
  // Find the last assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string" || !Array.isArray(msg.content)) break;

    // Collect server_tool_call ids and matched server_tool_result ids
    const serverToolIds = new Set<string>();
    const resultToolIds = new Set<string>();
    for (const part of msg.content) {
      if (part.type === "server_tool_call") serverToolIds.add(part.id);
      if (part.type === "server_tool_result") resultToolIds.add(part.toolUseId);
    }

    // Find unmatched server_tool_call blocks
    const orphanedIds = new Set<string>();
    for (const id of serverToolIds) {
      if (!resultToolIds.has(id)) orphanedIds.add(id);
    }

    if (orphanedIds.size === 0) break;

    // Strip orphaned server_tool_call blocks from the content
    const filtered = msg.content.filter(
      (part) => !(part.type === "server_tool_call" && orphanedIds.has(part.id)),
    );

    if (filtered.length === 0) {
      // Nothing left — remove the entire message
      messages.splice(i, 1);
    } else {
      (msg as { content: ContentPart[] }).content = filtered;
    }
    break;
  }
}
