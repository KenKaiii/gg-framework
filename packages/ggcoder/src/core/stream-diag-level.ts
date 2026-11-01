import type { LogLevel } from "@kenkaiiii/gg-core";

/**
 * Per-request step markers that fire on every model call and carry almost no
 * diagnostic value on their own (the stall/timeout phases carry the context).
 * They were ~12% of the sidecar log; they are DEBUG and only written when
 * GG_DEBUG_STREAM=1.
 */
const ROUTINE_PHASES = new Set([
  "transform_start",
  "transform_end",
  "stream_call",
  "stream_created",
]);

/** Log level for a stream diagnostic phase, or null to skip writing it. */
export function streamDiagLevel(
  phase: string,
  data: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): LogLevel | null {
  // A session stuck on the non-streaming fallback costs real money and real
  // latency; it does not belong in the INFO noise floor.
  if (phase === "non_streaming_session") return "WARN";
  const routine =
    ROUTINE_PHASES.has(phase) || (phase === "first_event" && data?.type === "keepalive");
  if (!routine) return "INFO";
  return env.GG_DEBUG_STREAM === "1" ? "DEBUG" : null;
}
