/**
 * Internal-only `session_stats` tool — NOT part of the public tool set.
 *
 * Registered by AgentSession exclusively when internal diagnostics are
 * enabled (env `GG_INTERNAL=1` or `~/.gg/internal.json` with
 * `diagnostics: true`). Gives the agent live visibility into its own
 * session — token spend, cache reuse, per-tool cost and errors, repeated
 * calls — plus an optional cross-session aggregate, so it can notice waste
 * and self-correct instead of spinning.
 */
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import {
  aggregateRecentDiagnostics,
  type SessionDiagnosticsRecorder,
} from "../core/internal-diagnostics.js";

const SessionStatsParams = z.object({
  recent_sessions: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe(
      "Also append an aggregate over the N most recent sessions (default: current session only)",
    ),
});

export interface SessionStatsSource {
  summary(): string;
}

/**
 * @param getCurrent Recorder for the live session, if internal mode is on and
 * the session has one. The lazy getter keeps tool creation decoupled from
 * recorder lifecycle (the recorder is created during session init).
 */
export function createSessionStatsTool(
  getCurrent: () => (SessionDiagnosticsRecorder & SessionStatsSource) | undefined,
): AgentTool<typeof SessionStatsParams> {
  return {
    name: "session_stats",
    description:
      "Read this session's live efficiency stats: token spend, cache reuse, per-tool time/errors, " +
      "repeated identical calls, compactions. Use it when you suspect you are looping, re-reading, " +
      "or burning tokens, and change approach based on what it shows.",
    parameters: SessionStatsParams,
    async execute({ recent_sessions }) {
      const current = getCurrent();
      const parts: string[] = [];
      if (current) {
        parts.push("=== Current session ===", current.summary());
      } else {
        parts.push(
          "No live recorder for this session (internal diagnostics disabled mid-session?).",
        );
      }
      if (recent_sessions) {
        const agg = aggregateRecentDiagnostics(recent_sessions);
        parts.push("", `=== Last ${agg.sessionCount} session(s) ===`, agg.report);
      }
      return parts.join("\n");
    },
  };
}
