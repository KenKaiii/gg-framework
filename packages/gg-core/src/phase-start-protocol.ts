import { isNotesSessionLink } from "./project-notes.js";

export const PHASE_START_STATUSES = ["accepted", "already-bound", "failed"] as const;

export type PhaseStartStatus = (typeof PHASE_START_STATUSES)[number];

/**
 * Closed wire-protocol set. Adding a code requires a coordinated producer/client
 * update; older clients intentionally reject unknown codes instead of guessing.
 */
export const PHASE_START_FAILURE_CODES = [
  "invalid-phase-id",
  "coding-mode-required",
  "session-busy",
  "session-mutation-in-progress",
  "reconciliation-in-progress",
  "phase-not-found",
  "phase-archived",
  "phase-inactive",
  "notes-missing",
  "notes-corrupt",
  "launch-failed",
] as const;

export type PhaseStartFailureCode = (typeof PHASE_START_FAILURE_CODES)[number];

export interface PhaseStartSession {
  sessionId: string;
  sessionPath: string | null;
}

export type PhaseStartResult =
  | {
      status: "accepted";
      operationId: string;
      session: PhaseStartSession;
      packageTokenCount: number;
    }
  | {
      status: "already-bound";
      operationId: string;
      session: PhaseStartSession;
      packageTokenCount: 0;
    }
  | {
      status: "failed";
      code: PhaseStartFailureCode;
      operationId: string | null;
      message: string;
    };

const PHASE_START_FAILURE_CODE_SET: ReadonlySet<string> = new Set(PHASE_START_FAILURE_CODES);

export function isPhaseStartFailureCode(value: unknown): value is PhaseStartFailureCode {
  return typeof value === "string" && PHASE_START_FAILURE_CODE_SET.has(value);
}

export function isPhaseStartSession(value: unknown): value is PhaseStartSession {
  return isNotesSessionLink(value);
}

export function isPhaseStartResult(value: unknown): value is PhaseStartResult {
  if (!isRecord(value)) return false;
  if (value.status === "accepted" || value.status === "already-bound") {
    return (
      hasExactKeys(value, ["status", "operationId", "session", "packageTokenCount"]) &&
      isNonEmptyString(value.operationId) &&
      isPhaseStartSession(value.session) &&
      Number.isInteger(value.packageTokenCount) &&
      (value.status === "accepted"
        ? (value.packageTokenCount as number) >= 0
        : value.packageTokenCount === 0)
    );
  }
  return (
    value.status === "failed" &&
    hasExactKeys(value, ["status", "code", "operationId", "message"]) &&
    isPhaseStartFailureCode(value.code) &&
    (value.operationId === null || isNonEmptyString(value.operationId)) &&
    isNonEmptyString(value.message)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
