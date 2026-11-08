import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
  argumentHints,
  capToolResults,
  isInterruptibleTool,
  markSteerInterrupted,
  PREEMPT_GRACE_MS,
  STEER_INTERRUPTED_TEXT,
  unknownToolMessage,
  type AgentEvent,
  type AgentOptions,
  type AgentTool,
  type ToolExecuteResult,
} from "@kenkaiiii/gg-agent";
import {
  environmentSecrets,
  redactValue,
  resolveToolSchema,
  type RedactionOptions,
  type ToolResult,
  type ToolResultContent,
} from "@kenkaiiii/gg-ai";
import { ZodError, prettifyError } from "zod";

export const CLAUDE_CODE_MCP_SERVER = "gg";
const TOOL_PREFIX = `mcp__${CLAUDE_CODE_MCP_SERVER}__`;
const DEFAULT_TOOL_TIMEOUT_MS = 300_000;
// Our own per-tool timeout must fire first so its specific message reaches the model.
const SERVER_TIMEOUT_MARGIN_MS = 60_000;
// How long a call that changed the tool list waits for Claude Code to re-list.
const RELIST_WAIT_MS = 3_000;

/** Name the model sees for one of our tools on the Claude Code route. */
export function claudeCodeToolName(name: string): string {
  return TOOL_PREFIX + name;
}

/** Our tool name from a Claude Code tool name (`mcp__gg__read` → `read`). */
export function stripClaudeCodeToolPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

export interface ToolBridgeOptions {
  /** Read on every `tools/list`, so tools pushed later are offered too. */
  tools: readonly AgentTool[];
  resolveTool?: AgentOptions["resolveTool"];
  signal?: AbortSignal;
  maxToolResultChars?: number;
  transformToolResult?: AgentOptions["transformToolResult"];
  onEvent: (event: AgentEvent) => void;
  /** A tool returned `endRun`; the loop should stop after this result. */
  onEndRun?: () => void;
  /** Wait for Claude Code's re-list after a promotion (default 3s). */
  relistWaitMs?: number;
}

export interface ToolBridge {
  config: McpSdkServerConfigWithInstance;
  /** The result exactly as the model received it, for our transcript. */
  takeResult(toolCallId: string): ToolResult | undefined;
  /** Re-point the run-scoped options (a long-lived Claude Code process serves many runs). */
  update(next: Partial<Omit<ToolBridgeOptions, "relistWaitMs">>): void;
  /** Tell Claude Code about tools added since it last listed them, and wait for its re-list. */
  syncToolList(): Promise<void>;
  /** The user sent a message: cut running interruptible tools short, as the agent loop does. */
  preempt(): void;
}

/** Run-scoped options a tool call reads when it starts. */
type RunScoped = Omit<ToolBridgeOptions, "relistWaitMs">;

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpTransport {
  start?(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close?(): Promise<void>;
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

type McpContent =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

let redaction: RedactionOptions | undefined;
function redactionOptions(): RedactionOptions {
  redaction ??= { secrets: environmentSecrets(process.env) };
  return redaction;
}

function stripNullArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullArguments);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== null) out[key] = stripNullArguments(entry);
    }
    return out;
  }
  return value;
}

function preview(content: ToolResultContent): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : `[${block.type} ${block.mediaType}]`))
    .join("\n");
}

export function toMcpContent(content: ToolResultContent): McpContent[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return content.map((block): McpContent => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image")
      return { type: "image", data: block.data, mimeType: block.mediaType };
    return { type: "text", text: `[${block.mediaType} video omitted: not supported here]` };
  });
}

const ABANDONED = Symbol("abandoned");

/** Resolves to ABANDONED once `signal` has been aborted for the grace period. */
function abandonAfterGrace(signal: AbortSignal): Promise<typeof ABANDONED> {
  return new Promise((resolve) => {
    const start = () => setTimeout(() => resolve(ABANDONED), PREEMPT_GRACE_MS).unref?.();
    if (signal.aborted) start();
    else signal.addEventListener("abort", start, { once: true });
  });
}

function normalize(raw: ToolExecuteResult): Exclude<ToolExecuteResult, string> {
  return typeof raw === "string" ? { content: raw } : raw;
}

/**
 * Serves our AgentTools to Claude Code as an in-process MCP server. The model
 * sees the same JSON schemas every other provider gets, and arguments are
 * parsed with our full Zod schemas (pipes and preprocessors included), so
 * nothing depends on the SDK's bundled zod converting our schemas.
 */
export function createToolBridge(initial: ToolBridgeOptions): ToolBridge {
  let options: RunScoped = initial;
  const results = new Map<string, ToolResult>();
  const invalidCounts = new Map<string, number>();
  const extraTools = new Map<string, AgentTool>();
  const preemptible = new Set<AbortController>();

  const listTools = (): AgentTool[] => {
    const byName = new Map<string, AgentTool>();
    for (const tool of options.tools) byName.set(tool.name, tool);
    for (const tool of extraTools.values()) if (!byName.has(tool.name)) byName.set(tool.name, tool);
    return [...byName.values()];
  };

  const runOptions = () => options;

  const findTool = (name: string): AgentTool | undefined => {
    const tool = listTools().find((t) => t.name === name) ?? options.resolveTool?.(name);
    if (tool) extraTools.set(tool.name, tool);
    return tool;
  };

  async function callTool(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
    cancel: AbortSignal,
  ): Promise<ToolResult> {
    // A call still finishing after Stop must report to its own run, not the next one.
    const options = runOptions();
    const startTime = Date.now();
    options.onEvent({ type: "tool_call_start", toolCallId, name, args });

    let content: ToolResultContent;
    let details: unknown;
    let isError = false;
    let endRun = false;
    let invalidArgAttempt: number | undefined;
    let preempt: AbortController | undefined;

    const tool = findTool(name);
    if (!tool) {
      content = unknownToolMessage(
        name,
        listTools().map((t) => t.name),
      );
      isError = true;
    } else {
      try {
        let parsed: unknown;
        try {
          parsed = tool.parameters.parse(args);
        } catch (originalError) {
          if (tool.rawInputSchema) throw originalError;
          try {
            parsed = tool.parameters.parse(stripNullArguments(args));
          } catch {
            throw originalError;
          }
        }
        const signals = [cancel, AbortSignal.timeout(tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS)];
        if (options.signal) signals.push(options.signal);
        if (isInterruptibleTool(tool, name)) {
          preempt = new AbortController();
          preemptible.add(preempt);
          signals.push(preempt.signal);
        }
        const execution = Promise.resolve(
          tool.execute(parsed, {
            signal: AbortSignal.any(signals),
            toolCallId,
            onUpdate: (update) => options.onEvent({ type: "tool_call_update", toolCallId, update }),
          }),
        );
        // A tool that ignores its signal is abandoned after the grace period.
        const raw = preempt
          ? await Promise.race([execution, abandonAfterGrace(preempt.signal)])
          : await execution;
        if (raw === ABANDONED) {
          execution.catch(() => {});
          throw new Error(STEER_INTERRUPTED_TEXT);
        }
        const normalized = normalize(raw);
        endRun = normalized.endRun === true;
        content = redactValue(normalized.content, redactionOptions());
        details = redactValue(normalized.details, redactionOptions());
        if (options.transformToolResult) {
          try {
            content = options.transformToolResult({ name, args }, content);
          } catch {
            // A faulty transform must never fail or alter the tool call.
          }
        }
        for (const key of invalidCounts.keys()) {
          if (key.startsWith(`${name}:`)) invalidCounts.delete(key);
        }
      } catch (err) {
        isError = true;
        if (err instanceof ZodError) {
          const pretty = prettifyError(err);
          const key = `${name}:${pretty}`;
          invalidArgAttempt = (invalidCounts.get(key) ?? 0) + 1;
          invalidCounts.set(key, invalidArgAttempt);
          const hints = argumentHints(tool, args);
          content =
            `Invalid arguments for tool \`${name}\`:\n${pretty}` +
            (hints ? `\n${hints}` : "") +
            "\nRe-issue the call with each field as the correct type.";
        } else {
          content = err instanceof Error ? err.message : String(err);
        }
      }
    }

    if (preempt) {
      preemptible.delete(preempt);
      if (preempt.signal.aborted) {
        const partial = content === STEER_INTERRUPTED_TEXT ? "" : content;
        ({ content, isError } = markSteerInterrupted({ toolCallId, content: partial, isError }));
        endRun = false;
      }
    }
    content = redactValue(content, redactionOptions());
    details = redactValue(details, redactionOptions());
    options.onEvent({
      type: "tool_call_end",
      toolCallId,
      result: preview(content),
      details,
      isError,
      durationMs: Date.now() - startTime,
      ...(invalidArgAttempt === undefined ? {} : { invalidArgAttempt }),
    });

    const result: ToolResult = { type: "tool_result", toolCallId, content, isError };
    capToolResults([result], options.maxToolResultChars);
    if (endRun && !isError) options.onEndRun?.();
    return result;
  }

  let callCount = 0;
  // Claude Code reads tools/list once; tell it when tool_search promotes more.
  let listedNames: string | undefined;
  // Calls waiting for Claude Code to re-read tools/list.
  let relistWaiters: (() => void)[] = [];
  const waitForRelist = (): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, initial.relistWaitMs ?? RELIST_WAIT_MS);
      relistWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  const toolNames = () =>
    listTools()
      .map((t) => t.name)
      .join("\n");
  let connected: McpTransport | undefined;
  /** Send list_changed when the list moved since Claude Code read it; resolves once it re-lists. */
  const announceToolList = (transport: McpTransport): Promise<void> | undefined => {
    if (listedNames === undefined || toolNames() === listedNames) return undefined;
    listedNames = toolNames();
    const relisted = waitForRelist();
    void transport
      .send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
      .catch(() => {});
    return relisted;
  };
  const instance = {
    async connect(transport: McpTransport): Promise<void> {
      connected = transport;
      const inFlight = new Map<string | number, AbortController>();
      const reply = (id: JsonRpcMessage["id"], body: Pick<JsonRpcMessage, "result" | "error">) =>
        void transport.send({ jsonrpc: "2.0", id, ...body }).catch(() => {});

      transport.onclose = () => {
        if (connected === transport) connected = undefined;
        for (const controller of inFlight.values()) controller.abort();
        inFlight.clear();
      };
      transport.onmessage = (message) => {
        const { id, method, params = {} } = message;
        if (method === "notifications/cancelled") {
          inFlight.get(params.requestId as string | number)?.abort();
          return;
        }
        if (id === undefined || id === null || !method) return;
        switch (method) {
          case "initialize":
            reply(id, {
              result: {
                protocolVersion: params.protocolVersion ?? "2025-11-25",
                capabilities: { tools: { listChanged: true } },
                serverInfo: { name: CLAUDE_CODE_MCP_SERVER, version: "1.0.0" },
              },
            });
            return;
          case "ping":
            reply(id, { result: {} });
            return;
          case "tools/list": {
            listedNames = toolNames();
            const tools = [];
            for (const tool of listTools()) {
              try {
                tools.push({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: resolveToolSchema(tool),
                  _meta: { "anthropic/alwaysLoad": true },
                });
              } catch {
                // A schema that can't be converted is left out, like on every other route.
              }
            }
            reply(id, { result: { tools } });
            const waiters = relistWaiters;
            relistWaiters = [];
            for (const done of waiters) done();
            return;
          }
          case "tools/call": {
            const controller = new AbortController();
            inFlight.set(id, controller);
            const meta = (params._meta ?? {}) as Record<string, unknown>;
            const toolCallId =
              typeof meta["claudecode/toolUseId"] === "string"
                ? meta["claudecode/toolUseId"]
                : `gg_call_${++callCount}`;
            const args = (params.arguments ?? {}) as Record<string, unknown>;
            void callTool(String(params.name), args, toolCallId, controller.signal)
              .then(async (result) => {
                results.set(toolCallId, result);
                // Hold this result until Claude Code has the new list: it
                // checks every call against its own copy, so the model's
                // next call to the promoted tool failed with "No such tool
                // available" when the result arrived first.
                await announceToolList(transport);
                reply(id, {
                  result: {
                    content: toMcpContent(result.content),
                    ...(result.isError ? { isError: true } : {}),
                  },
                });
              })
              .finally(() => inFlight.delete(id));
            return;
          }
          default:
            reply(id, { error: { code: -32601, message: `Method not found: ${method}` } });
        }
      };
      await transport.start?.();
    },
  };

  const longestTimeout = Math.max(
    DEFAULT_TOOL_TIMEOUT_MS,
    ...initial.tools.map((t) => t.timeoutMs ?? 0),
  );

  return {
    config: {
      type: "sdk",
      name: CLAUDE_CODE_MCP_SERVER,
      instance: instance as unknown as McpSdkServerConfigWithInstance["instance"],
      timeout: longestTimeout + SERVER_TIMEOUT_MARGIN_MS,
    } as McpSdkServerConfigWithInstance,
    takeResult(toolCallId) {
      const result = results.get(toolCallId);
      results.delete(toolCallId);
      return result;
    },
    update(next) {
      options = { ...options, ...next };
    },
    async syncToolList() {
      if (connected) await announceToolList(connected);
    },
    preempt() {
      for (const controller of preemptible) controller.abort();
    },
  };
}
