// The file-writer logger core (open/log/rotate/close) now lives in
// @kenkaiiii/gg-core. This module keeps ggcoder's "ggcoder"-branded startup
// line and the EventBus bridge (`attachToEventBus`), which needs the gg-agent
// `EventBus` type and therefore must stay out of the UI-free core.
import { openLog, log, registerLogCleanup } from "@kenkaiiii/gg-core";
import type { EventBus } from "./event-bus.js";

export { log, getSessionId, closeLogger } from "@kenkaiiii/gg-core";

type LogLevel = "INFO" | "ERROR" | "WARN";

/**
 * Initialize the debug logger for ggcoder. Opens the shared log file in append
 * mode (via gg-core) and writes a one-time "ggcoder started …" line tagged with
 * the session id. No-op if already initialized.
 */
export function initLogger(
  filePath: string,
  meta?: { version?: string; provider?: string; model?: string; thinking?: string },
): void {
  if (!openLog(filePath, "ggcoder")) return;
  const parts = ["ggcoder"];
  if (meta?.version) parts[0] += ` v${meta.version}`;
  parts.push("started");
  if (meta?.provider) parts.push(`provider=${meta.provider}`);
  if (meta?.model) parts.push(`model=${meta.model}`);
  if (meta?.thinking) parts.push(`thinking=${meta.thinking}`);
  parts.push(`pid=${process.pid}`);
  log("INFO", "startup", parts.join(" "));
}

/**
 * Subscribe to EventBus events and log them. Used by print/json modes.
 */
export function attachToEventBus(bus: EventBus): void {
  registerLogCleanup(
    bus.on("tool_call_start", ({ toolCallId, name }) => {
      log("INFO", "tool", `Tool call started: ${name}`, { id: toolCallId });
    }),
  );

  registerLogCleanup(
    bus.on("tool_call_end", ({ toolCallId, result: _result, isError, durationMs }) => {
      const level: LogLevel = isError ? "ERROR" : "INFO";
      log(level, "tool", `Tool call ended`, {
        id: toolCallId,
        duration: `${durationMs}ms`,
        isError: String(isError),
      });
    }),
  );

  registerLogCleanup(
    bus.on("turn_end", ({ turn, stopReason, usage }) => {
      log("INFO", "turn", `Turn ${turn} ended`, {
        stopReason,
        inputTokens: String(usage.inputTokens),
        outputTokens: String(usage.outputTokens),
        ...(usage.cacheRead != null && { cacheRead: String(usage.cacheRead) }),
        ...(usage.cacheWrite != null && { cacheWrite: String(usage.cacheWrite) }),
      });
    }),
  );

  registerLogCleanup(
    bus.on("agent_done", ({ totalTurns, totalUsage }) => {
      log("INFO", "agent", `Agent done`, {
        totalTurns: String(totalTurns),
        inputTokens: String(totalUsage.inputTokens),
        outputTokens: String(totalUsage.outputTokens),
        ...(totalUsage.cacheRead != null && { cacheRead: String(totalUsage.cacheRead) }),
        ...(totalUsage.cacheWrite != null && { cacheWrite: String(totalUsage.cacheWrite) }),
      });
    }),
  );

  registerLogCleanup(
    bus.on("error", ({ error }) => {
      log("ERROR", "error", error.message);
    }),
  );

  registerLogCleanup(
    bus.on("session_start", ({ sessionId }) => {
      log("INFO", "session", `Session started`, { sessionId });
    }),
  );

  registerLogCleanup(
    bus.on("model_change", ({ provider, model }) => {
      log("INFO", "model", `Model changed`, { provider, model });
    }),
  );

  registerLogCleanup(
    bus.on("compaction_start", ({ messageCount }) => {
      log("INFO", "compaction", `Compaction started`, { messageCount: String(messageCount) });
    }),
  );

  registerLogCleanup(
    bus.on("compaction_end", ({ originalCount, newCount }) => {
      log("INFO", "compaction", `Compaction ended`, {
        originalCount: String(originalCount),
        newCount: String(newCount),
      });
    }),
  );

  registerLogCleanup(
    bus.on("user_input", ({ content }) => {
      const truncated = content.length > 100 ? content.slice(0, 100) + "..." : content;
      log("INFO", "input", `User input: ${truncated}`);
    }),
  );

  registerLogCleanup(
    bus.on("slash_command", ({ name, args }) => {
      log("INFO", "command", `Slash command: /${name}${args ? ` ${args}` : ""}`);
    }),
  );
}
