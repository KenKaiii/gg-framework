import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { AgentSession } from "../core/agent-session.js";
import { isAbortError } from "@kenkaiiii/gg-agent";
import { formatUserError } from "../utils/error-handler.js";
import { closeLogger } from "../core/logger.js";
import { captureSidecarError, flushSidecarErrors } from "../core/sidecar-error-reporter.js";

export interface JsonModeOptions {
  message: string;
  provider: Provider;
  model: string;
  baseUrl?: string;
  systemPrompt?: string;
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

export async function runJsonMode(options: JsonModeOptions): Promise<void> {
  // No logger in JSON mode — subagent events are forwarded to parent via NDJSON stdout.
  // Opening the shared log file here caused corruption from concurrent child process writes.

  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.on("SIGINT", onSigint);

  const sessionOpts = {
    provider: options.provider,
    model: options.model,
    baseUrl: options.baseUrl,
    systemPrompt: options.systemPrompt,
    cwd: options.cwd,
    thinkingLevel: options.thinkingLevel,
    maxTurns: options.maxTurns,
    allowedTools: options.allowedTools,
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
  session.eventBus.on("server_tool_call", (payload) => {
    emitJson({ type: "server_tool_call", ...payload });
  });
  session.eventBus.on("server_tool_result", (payload) => {
    emitJson({ type: "server_tool_result", ...payload });
  });
  session.eventBus.on("error", ({ error }) => {
    emitJson({ type: "error", message: error.message });
  });

  try {
    await session.initialize();
    await session.prompt(options.message);
  } catch (err) {
    if (isAbortError(err)) {
      emitJson({ type: "error", message: "Interrupted" });
      process.exit(130);
    }
    captureSidecarError(err, "json-mode.run", {
      provider: options.provider,
      model: options.model,
    });
    await flushSidecarErrors();
    process.stderr.write(formatUserError(err) + "\n");
    process.exit(1);
  } finally {
    process.removeListener("SIGINT", onSigint);
    await session.dispose();
    closeLogger();
  }
}
