import type { Message } from "@kleio/ai";
import { SUB_AGENT_TIMEOUT_RECOVERY_MS } from "../tools/subagent-shared.js";
import type { IdealReviewStats } from "./ideal-review.js";

/**
 * Independent pre-final review — the Codex Guardian pattern. The in-thread
 * Ideal review asks the acting model to audit its own work, armed with its own
 * justifications for why it is done; a fresh-context reviewer sees only the
 * request, the changed files and the outcome evidence, so it catches what
 * self-review rationalizes away.
 *
 * The reviewer is spawned as a read-only child agent on the session's ACTIVE
 * model (`model` is forced at spawn time, never a "fast" or review model).
 * Findings are injected as a follow-up the acting agent must address; a CLEAN
 * verdict injects nothing, so a passing review costs one bounded wait and no
 * extra turn. On spawn failure or timeout the in-thread review remains the
 * fallback — the feature degrades, never blocks.
 *
 * The reviewer's time is capped by its OWN worker, not by the harness killing
 * it: on reaching REVIEWER_TURN_TIMEOUT_MS it gets one tool-free turn to give
 * its verdict on what it has examined. Killing it from outside discarded all
 * of that — large reviews ended "Interrupted" with no verdict at all.
 */

/** Read-only toolset — the reviewer examines, it never repairs. */
export const REVIEWER_TOOLS = ["read", "grep", "find", "ls", "source_path"] as const;

/**
 * How long the reviewer may examine the work before it must give its verdict.
 * Reviews of large changes (a dozen or more files, ~1,000 changed lines) need
 * longer to read everything; a verdict on the most central files beats none.
 */
export const REVIEWER_TURN_TIMEOUT_MS = 120_000;

/**
 * Harness backstop: the reviewer's working time, its recovery turn, and
 * headroom for the result to arrive. Reached only if the child hangs.
 */
export const REVIEWER_WAIT_MS = REVIEWER_TURN_TIMEOUT_MS + SUB_AGENT_TIMEOUT_RECOVERY_MS + 20_000;

/**
 * Ideal review score at which the independent reviewer is worth its latency.
 * Below this the in-thread review alone is proportionate.
 */
export const INDEPENDENT_REVIEW_SCORE_THRESHOLD = 6;

export interface ReviewerTaskInput {
  originalRequest: string;
  changedFiles: readonly string[];
  stats: IdealReviewStats;
  triggerReasons: readonly string[];
}

export function buildReviewerTask(input: ReviewerTaskInput): string {
  const files = input.changedFiles
    .slice(0, 20)
    .map((f) => `- ${f}`)
    .join("\n");
  const reasons = input.triggerReasons.join(", ");
  return [
    "You are an independent code reviewer with fresh context. Another coding agent claims to have " +
      "completed the task below. Examine its work and report whether the claim holds.",
    "",
    `Task given to that agent: ${input.originalRequest.slice(0, 2000)}`,
    "",
    "Files it changed:",
    files,
    "",
    `Harness-observed activity: ${input.stats.changedLines} changed lines, ` +
      `${input.stats.toolCalls} tool calls (${input.stats.toolFailures} failed), ` +
      `${input.stats.turns} turns. Review triggered because: ${reasons}.`,
    "",
    "Read the changed files (and any sibling files needed to judge them). Check the work against " +
      "the task: correctness, completeness, obvious edge cases, over-editing beyond what the task " +
      "asked for, leftover TODOs or dead code, and changes that contradict each other.",
    "Judge the CONTENT of the changed files against the request. Do NOT report the surrounding " +
      "environment (missing package.json, tooling not installed, unrelated files) unless the request " +
      "itself demanded those.",
    "You are READ-ONLY: do not edit, write, or run commands. Judge only what is on disk.",
    "Your time is limited: examine the files most central to the task first. If time runs out " +
      "you will be asked for your verdict on what you have examined so far.",
    "",
    "BEGIN your reply with EXACTLY this format (elaborate only after it):",
    "VERDICT: CLEAN",
    "or",
    "VERDICT: ISSUES",
    "FINDINGS:",
    "- <one line per concrete finding, each naming the file>",
  ].join("\n");
}

export interface ReviewerFindings {
  clean: boolean;
  findings: string[];
}

/**
 * Parse the reviewer's terminal output. Returns null when the reply carries no
 * usable verdict marker — treated as a failed review, never as a pass.
 */
export function parseReviewerFindings(output: string): ReviewerFindings | null {
  const verdict = /VERDICT:\s*(CLEAN|ISSUES)\b/im.exec(output)?.[1]?.toUpperCase();
  if (!verdict) return null;
  const findingsBlock = /FINDINGS:\s*\n([\s\S]*)$/i.exec(output)?.[1] ?? "";
  const findings = findingsBlock
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line.length > 0 && line.toUpperCase() !== "NONE")
    .slice(0, 10);
  if (verdict === "CLEAN") return { clean: true, findings: [] };
  if (findings.length === 0)
    return {
      clean: false,
      findings: [
        "The reviewer flagged issues but did not list them — re-examine the changed files yourself.",
      ],
    };
  return { clean: false, findings };
}

export function buildIndependentReviewMessage(findings: readonly string[]): Message {
  return {
    role: "user",
    provenance: { source: "runtime", kind: "review_follow_up", visibility: "hidden" },
    content:
      "An independent reviewer (fresh context, no knowledge of your reasoning) examined the changed " +
      "files against the original request and disagrees that the work is complete:\n" +
      findings.map((finding) => `- ${finding}`).join("\n") +
      "\nAddress each finding now — fix what is real, and if a finding is wrong, verify why before " +
      "dismissing it. Then give your final response.",
  };
}
