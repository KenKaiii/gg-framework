import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { AgentSession } from "../core/agent-session.js";
import { isAbortError } from "@kenkaiiii/gg-agent";
import { formatUserError } from "../utils/error-handler.js";
import { closeLogger } from "../core/logger.js";
import { ensureGatewayCatalogLoaded } from "../core/gateway-catalog.js";
import { promptSubAgent, SUB_AGENT_MAX_TURN_EXTENSIONS } from "../tools/subagent-shared.js";

export interface JsonModeOptions {
  message: string;
  provider: Provider;
  model: string;
  baseUrl?: string;
  /** Replaces the whole system prompt. */
  systemPrompt?: string;
  /**
   * Agent definition body composed with the standard scaffolding (Tools,
   * project context, return contract, Environment) — the delegation path.
   */
  agentPrompt?: string;
  /** Whether the composed prompt includes project instruction files. */
  agentContext?: "project" | "none";
  cwd: string;
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  /**
   * Tool allow-list forwarded from an agent definition's `tools:` frontmatter.
   * When set, the sub-agent session registers ONLY these tool names, so a
   * read-only agent (e.g. `tools: read, grep`) physically cannot call
   * write/edit/bash. Empty/undefined → full toolset (backward compatible).
   */
  allowedTools?: string[];
  /**
   * MCP servers this sub-agent may connect, derived from the `mcp__<server>__*`
   * entries in its agent definition's `tools:` frontmatter. Only meaningful
   * alongside `allowedTools` — an allow-listed session otherwise skips MCP
   * entirely, so a research agent would silently lose live code search.
   */
  allowedMcpServers?: string[];
  /**
   * Stable prompt-cache routing key inherited from the parent ggcoder
   * process. Without this, each sub-agent session generates a unique
   * sessionId-derived cache key and starts with a cold cache on providers
   * that route caching by key (OpenAI Codex, OpenAI Chat, Moonshot).
   */
  promptCacheKey?: string;
}

function emitJson(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

/** Minimal surface of `process` that {@link exitAfterFlush} needs. */
export interface ExitHost {
  stdout: { writableLength: number; once(event: "drain", listener: () => void): unknown };
  exit(code: number): void;
  setTimeout?: (handler: () => void, ms: number) => { unref?: () => void };
}

/** Grace period before abandoning a stalled stdout pipe and exiting anyway. */
export const JSON_MODE_FLUSH_TIMEOUT_MS = 2000;

/**
 * End a finished one-shot JSON-mode run, flushing stdout first.
 *
 * Returning from `main()` is not enough. In the desktop build the sub-agent
 * worker entry IS the app-sidecar bundle (no `cli.js` ships in the app, so
 * `resolveSubAgentCliEntry` falls back to `process.argv[1]` — see
 * json-mode-flag-parity.test.ts), whose module graph installs long-lived
 * handles at import time. Those keep the event loop alive forever, so a child
 * that had already emitted `agent_done` sat idle until the parent's timeout
 * killed it, surfacing a COMPLETED run as "Sub-agent failed (exit null)".
 *
 * A JSON-mode process is one-shot by definition: once the final frame is
 * written there is nothing left to await, so exit deterministically.
 */
export function exitAfterFlush(code: number, host: ExitHost = process): void {
  const schedule: NonNullable<ExitHost["setTimeout"]> =
    host.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  // `stdout.write` is async for a pipe; exiting while bytes are still buffered
  // would truncate the NDJSON stream the parent is reading.
  if (host.stdout.writableLength === 0) {
    host.exit(code);
    return;
  }
  host.stdout.once("drain", () => host.exit(code));
  // Never hang on a stalled pipe: the work is done and already reported.
  schedule(() => host.exit(code), JSON_MODE_FLUSH_TIMEOUT_MS).unref?.();
}

export async function runJsonMode(options: JsonModeOptions): Promise<void> {
  // No logger in JSON mode — subagent events are forwarded to parent via NDJSON stdout.
  // Opening the shared log file here caused corruption from concurrent child process writes.

  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.on("SIGINT", onSigint);

  // This path returns before the CLI's main init block, so a synced gateway
  // model (`openrouter/<rawId>`) would look unknown here — losing the
  // endpoint's declared effort ladder.
  await ensureGatewayCatalogLoaded();

  const sessionOpts = {
    provider: options.provider,
    model: options.model,
    baseUrl: options.baseUrl,
    systemPrompt: options.systemPrompt,
    agentPrompt: options.agentPrompt,
    agentContext: options.agentContext,
    cwd: options.cwd,
    thinkingLevel: options.thinkingLevel,
    maxTurns: options.maxTurns,
    maxTurnExtensions: SUB_AGENT_MAX_TURN_EXTENSIONS,
    allowedTools: options.allowedTools,
    allowedMcpServers: options.allowedMcpServers,
    signal: ac.signal,
    // Subagent runs are one-shot, NDJSON-streamed to the parent over stdout,
    // and have no resumable identity. Skip writing a `.jsonl` so the spawn
    // doesn't show up in `ggcoder continue` for the parent project.
    transient: true,
    // Parent-supplied cache routing key. The spawner partitions it by model and
    // named-agent family, so children with the same static system+tool prefix
    // share cache routing without mixing unrelated prefixes under one hot key.
    promptCacheKey: options.promptCacheKey,
  };

  const session = new AgentSession(sessionOpts);

  // Forward all agent events as NDJSON to stdout
  session.eventBus.on("text_delta", (payload) => {
    emitJson({ type: "text_delta", ...payload });
  });
  session.eventBus.on("thinking_delta", (payload) => {
    emitJson({ type: "thinking_delta", ...payload });
  });
  session.eventBus.on("tool_call_start", (payload) => {
    emitJson({ type: "tool_call_start", ...payload });
  });
  session.eventBus.on("tool_call_update", (payload) => {
    emitJson({ type: "tool_call_update", ...payload });
  });
  session.eventBus.on("tool_call_end", (payload) => {
    emitJson({ type: "tool_call_end", ...payload });
  });
  session.eventBus.on("turn_end", (payload) => {
    emitJson({ type: "turn_end", ...payload });
  });
  session.eventBus.on("agent_done", (payload) => {
    emitJson({ type: "agent_done", ...payload });
  });
  session.eventBus.on("max_turns", (payload) => {
    emitJson({ type: "max_turns", ...payload });
  });
  session.eventBus.on("turn_budget_extended", (payload) => {
    emitJson({ type: "turn_budget_extended", ...payload });
  });
  session.eventBus.on("truncated", (payload) => {
    emitJson({ type: "truncated", ...payload });
  });
  session.eventBus.on("server_tool_call", (payload) => {
    emitJson({ type: "server_tool_call", ...payload });
  });
  session.eventBus.on("server_tool_result", (payload) => {
    emitJson({ type: "server_tool_result", ...payload });
  });
  session.eventBus.on("error", ({ error }) => {
    emitJson({ type: "error", message: error.message });
  });

  let loopError: Error | undefined;
  try {
    await session.initialize();
    loopError = await promptSubAgent(session, options.message);
  } catch (err) {
    if (isAbortError(err)) {
      emitJson({ type: "error", message: "Interrupted" });
      process.exit(130);
    }
    process.stderr.write(formatUserError(err) + "\n");
    process.exit(1);
  } finally {
    process.removeListener("SIGINT", onSigint);
    await session.dispose();
    closeLogger();
  }

  // The loop stopped on an error yet returned normally (see promptSubAgent).
  // Exit non-zero with the reason on stderr — the parent's failure path — so
  // the child's mid-task narration is never passed off as its answer.
  if (loopError) {
    process.stderr.write(formatUserError(loopError) + "\n");
    exitAfterFlush(1);
    return;
  }

  // Success path: dispose() released this session's own resources, but the host
  // bundle's import-time handles can still pin the event loop. See
  // exitAfterFlush — a one-shot child must not outlive its final frame.
  exitAfterFlush(0);
}
