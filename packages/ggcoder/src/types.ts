import type { Message, Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";

// ── CLI Config ─────────────────────────────────────────────

export interface CliConfig {
  provider: Provider;
  model: string;
  baseUrl?: string;
  cwd: string;
  sessionId?: string;
  continueRecent?: boolean;
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  printMessage?: string;
  outputFormat?: "text" | "json";
}

// ── Foreground Execution ────────────────────────────────────

export type ForegroundExecutionReason =
  | "completed"
  | "nonZeroExit"
  | "timedOut"
  | "aborted"
  | "spawnError";

export interface ForegroundExecutionMetadata {
  executionId: string;
  command: string;
  cwd: string;
  startedAt: number;
  timeoutMs: number;
  pid: number | null;
  logPath: string;
}

export interface ForegroundExecutionOutcome {
  metadata: ForegroundExecutionMetadata;
  reason: ForegroundExecutionReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  error: Error | null;
}

/** Stable, serializable diagnostics exposed to hosts for foreground bash runs. */
export interface BashDiagnostics {
  executionId: string;
  pid: number | null;
  command: string;
  cwd: string;
  startedAt: number;
  timeoutMs: number;
  reason: ForegroundExecutionReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  logPath: string;
  tail: string;
  outputCapped: boolean;
  totalOutputBytes: number;
  retainedOutputBytes: number;
  droppedOutputBytes: number;
}

export interface BashToolResultDetails {
  bashDiagnostics: BashDiagnostics;
}

// ── Session Persistence ────────────────────────────────────

export interface SessionHeader {
  type: "session";
  version: 1;
  id: string;
  timestamp: string;
  cwd: string;
  provider: Provider;
  model: string;
}

export interface SessionMessageEntry {
  type: "message";
  timestamp: string;
  message: Message;
}

export type SessionEntry = SessionHeader | SessionMessageEntry;

export interface SessionInfo {
  id: string;
  path: string;
  timestamp: string;
  /** Timestamp of the most recent message (falls back to creation timestamp). */
  lastActivity: string;
  cwd: string;
  messageCount: number;
  /**
   * First user-authored prompt, for use as a human title. Filled during the
   * single pass the listing already makes over each file, so a caller that
   * needs titles does not have to reopen them all. Undefined when the session
   * has no user prompt of its own.
   */
  preview?: string;
}
