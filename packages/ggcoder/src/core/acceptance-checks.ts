import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ReceiptCall } from "./subagent-receipt.js";

/**
 * Parent-set acceptance checks for a helper agent's task.
 *
 * A helper's report says "done, tests pass" in prose. The receipt shows what
 * it really did, but the parent still has to read it and decide whether that
 * meets the bar. Acceptance checks let the parent state the bar up front ("this
 * file exists", "the helper changed this file", "this command passed") and
 * have code decide each one from the filesystem and the helper's own recorded
 * tool calls — no model call, nothing the helper can write or forge. A check
 * the evidence cannot settle is reported UNVERIFIED, never guessed.
 */

export const MAX_ACCEPTANCE_CHECKS = 10;

export const AcceptanceCheckSchema = z.object({
  type: z.enum(["file_exists", "file_changed", "command_passed"]),
  target: z.string().min(1).max(500).describe("Path or exact command"),
});

export const AcceptanceChecksParam = z
  .array(AcceptanceCheckSchema)
  .max(MAX_ACCEPTANCE_CHECKS)
  .optional()
  .describe("Verified by code on finish");

export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>;

export type CheckStatus = "PASS" | "FAIL" | "UNVERIFIED";

export interface CheckResult {
  check: AcceptanceCheck;
  status: CheckStatus;
  reason: string;
}

const MUTATING_TOOLS = new Set(["write", "edit"]);

/**
 * Parse checks arriving over a process boundary (the worker's stdin). Invalid
 * input yields no checks rather than failing the helper's whole turn.
 */
export function parseAcceptanceChecks(value: unknown): AcceptanceCheck[] {
  const parsed = z.array(AcceptanceCheckSchema).max(MAX_ACCEPTANCE_CHECKS).safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** Whitespace-collapsed command with output-only plumbing stripped. */
function normalizeCommand(command: string): string {
  let text = command.trim().replace(/\s+/g, " ");
  // `cmd 2>&1 | tail -20` reports cmd's own exit code (the bash tool runs with
  // pipefail), so the limiter does not change what "it passed" means.
  for (;;) {
    const stripped = text
      .replace(/\s*\|\s*(?:tail|head)(?:\s+-n)?(?:\s+-?\d+)?\s*$/, "")
      .replace(/\s*2>&1\s*$/, "");
    if (stripped === text) return text;
    text = stripped;
  }
}

function verifyFileExists(target: string, cwd: string): CheckResult["status"] {
  return fs.existsSync(path.resolve(cwd, target)) ? "PASS" : "FAIL";
}

function verifyFileChanged(
  check: AcceptanceCheck,
  calls: readonly ReceiptCall[],
  cwd: string,
): CheckResult {
  const wanted = path.resolve(cwd, check.target);
  const writes = calls.filter(
    (call) => MUTATING_TOOLS.has(call.name) && path.resolve(cwd, call.target) === wanted,
  );
  if (writes.some((call) => call.outcome === "ok")) {
    return { check, status: "PASS", reason: "the helper wrote or edited it" };
  }
  if (writes.length > 0) {
    return { check, status: "FAIL", reason: "every write or edit of it failed" };
  }
  // A shell command can change a file (sed, codegen, git checkout) and the
  // receipt cannot see which files it touched.
  if (calls.some((call) => call.name === "bash")) {
    return {
      check,
      status: "UNVERIFIED",
      reason: "not written or edited directly; a shell command may have changed it",
    };
  }
  return { check, status: "FAIL", reason: "the helper never wrote or edited it" };
}

function verifyCommandPassed(check: AcceptanceCheck, calls: readonly ReceiptCall[]): CheckResult {
  const wanted = normalizeCommand(check.target);
  let lastIndex = -1;
  calls.forEach((call, index) => {
    if (call.name === "bash" && normalizeCommand(call.target) === wanted) lastIndex = index;
  });
  const last = calls[lastIndex];
  if (!last) return { check, status: "UNVERIFIED", reason: "the helper never ran it" };
  if (last.exitCode === undefined) {
    return {
      check,
      status: "UNVERIFIED",
      reason: "its last run reported no exit code (still running, backgrounded or timed out)",
    };
  }
  if (last.exitCode !== "0") {
    return { check, status: "FAIL", reason: `its last run exited ${last.exitCode}` };
  }
  const editedAfter = calls
    .slice(lastIndex + 1)
    .some((call) => MUTATING_TOOLS.has(call.name) && call.outcome === "ok");
  if (editedAfter) {
    return {
      check,
      status: "UNVERIFIED",
      reason: "it passed, but the helper changed files after that run",
    };
  }
  return { check, status: "PASS", reason: "its last run exited 0" };
}

/** Decide every check from the helper's recorded calls and the filesystem. */
export function verifyAcceptanceChecks(
  checks: readonly AcceptanceCheck[],
  calls: readonly ReceiptCall[],
  cwd: string,
): CheckResult[] {
  return checks.map((check) => {
    switch (check.type) {
      case "file_exists": {
        const status = verifyFileExists(check.target, cwd);
        return { check, status, reason: status === "PASS" ? "it exists" : "it does not exist" };
      }
      case "file_changed":
        return verifyFileChanged(check, calls, cwd);
      case "command_passed":
        return verifyCommandPassed(check, calls);
    }
  });
}

/** `2/3 passed, 1 unverified` — for the one-line completion notice. */
export function summarizeCheckResults(results: readonly CheckResult[]): string {
  const count = (status: CheckStatus) => results.filter((r) => r.status === status).length;
  const parts = [`${count("PASS")}/${results.length} passed`];
  if (count("FAIL") > 0) parts.push(`${count("FAIL")} failed`);
  if (count("UNVERIFIED") > 0) parts.push(`${count("UNVERIFIED")} unverified`);
  return parts.join(", ");
}

/** Block appended under the helper's receipt. Empty when no checks were set. */
export function formatCheckResults(results: readonly CheckResult[]): string {
  if (results.length === 0) return "";
  const lines = results.map(({ check, status, reason }) => {
    const target = check.type === "command_passed" ? `\`${check.target}\`` : check.target;
    return `- ${status} ${check.type} ${target}: ${reason}`;
  });
  return [`Acceptance checks (${summarizeCheckResults(results)}):`, ...lines].join("\n");
}
