/**
 * Autopilot gate — pure decision logic for whether Ken's auto-review cycle may
 * start after a finished GG Coder turn.
 *
 * Autopilot must NOT review every turn. The concrete leak cases this gate
 * closes (each has a matching unit test in autopilot-gate.test.ts):
 *
 * - Workflow slash commands (`/compare`, `/expand`, custom
 *   `.gg/commands/*.md`) end with reports or A/B/C choices that are reserved
 *   for the USER. Ken reviewing them reads "findings" as "something real is
 *   wrong" and injects fix prompts the user never approved.
 * - Registry commands (`/help`, `/session`, unknown `/foo`) and failed runs
 *   add no assistant work at all — a review would judge the PREVIOUS turn
 *   again (Ken's cycle memory is wiped per turn) and can flip a settled
 *   ALL_CLEAR into a fresh PROMPT.
 * - A turn that ended in plan mode has a pending Accept/Reject modal; Ken must
 *   never inject a prompt into a read-only plan-mode session.
 * - A turn whose ONLY tool calls were mechanical usage — a bash command that
 *   starts a background process (dev server, watcher), is read-only, or is a
 *   plain `git add`/`commit`/`push` workflow; a dedicated read-only tool
 *   (read/grep/find/ls/web_fetch/web_search/source_path/
 *   task_output/screenshot/skill); or NO tool calls at all (a plain-text
 *   answer with nothing built) — was always going to come back as Ken's
 *   IGNORE verdict (see the autopilot system prompt's "mechanical operation"
 *   / "plain question answered with no code touched" rules). Pre-filtering
 *   these skips the review API call entirely instead of paying for one whose
 *   answer is already known.
 *
 * Kept pure + dependency-light so it's unit-testable without booting the
 * sidecar (which runs `main()` at import time).
 */
import { isReadOnlyCommand } from "../tools/read-only-bash.js";
import { matchPromptCommand, LEGACY_COMMAND_ARGS_SEPARATOR } from "./prompt-command-expansion.js";

/** A workflow (prompt-template) command: built-in PROMPT_COMMANDS or a custom
 *  `.gg/commands/*.md` entry. `prompt` is the full template body the command
 *  expands to when run. */
export interface WorkflowCommandSpec {
  name: string;
  aliases?: readonly string[];
  prompt: string;
}

/** Retained for legacy transcript expansion compatibility. */
export const USER_INSTRUCTIONS_HEADER = LEGACY_COMMAND_ARGS_SEPARATOR;

/** Extract the `/name` token from raw input, or null when it isn't a slash
 *  invocation. */
function parseSlashName(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const name = trimmed.slice(1).split(/\s/, 1)[0]?.toLowerCase() ?? "";
  return name.length > 0 ? name : null;
}

/**
 * True when `text` invokes a known workflow command (first token, name or
 * alias, case-insensitive). Registry/UI commands and unknown `/foo` return
 * false — those add no assistant work and are caught by the
 * `no-assistant-output` gate instead.
 */
export function isWorkflowCommandText(
  text: string,
  commands: readonly WorkflowCommandSpec[],
): boolean {
  const name = parseSlashName(text);
  if (!name) return false;
  return commands.some(
    (c) => c.name.toLowerCase() === name || (c.aliases ?? []).some((a) => a.toLowerCase() === name),
  );
}

/**
 * Match a transcript user-message body back to the workflow command it was
 * expanded from. AgentSession stores the EXPANDED template as a plain user
 * message, so without this Ken's digest renders 400-line templates as
 * `**User:** …` and treats them as user-authored asks.
 *
 * Returns the matched command plus any trailing user args, or null.
 */
export function matchExpandedCommand(
  text: string,
  commands: readonly WorkflowCommandSpec[],
): { command: WorkflowCommandSpec; args: string | null } | null {
  return matchPromptCommand(text, commands);
}

/** Count assistant messages — the "did this run produce reviewable work"
 *  signal. Compared before/after a run by the sidecar. */
export function countAssistantMessages(messages: ReadonlyArray<{ role: string }>): number {
  let count = 0;
  for (const m of messages) if (m.role === "assistant") count++;
  return count;
}

/** Extract every tool call made by assistant messages from `startIndex`
 *  onward — i.e. the tool calls added during one turn, given the message
 *  array length captured before that turn ran. Used to feed
 *  isMechanicalOnlyTurn without the gate module depending on gg-ai's full
 *  Message type (kept structurally typed so it's easy to unit test). */
export function extractTurnToolCalls(
  messages: ReadonlyArray<{
    role: string;
    content:
      string | ReadonlyArray<{ type: string; name?: string; args?: Record<string, unknown> }>;
  }>,
  startIndex: number,
): TurnToolCall[] {
  const calls: TurnToolCall[] = [];
  for (const m of messages.slice(startIndex)) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const part of m.content) {
      if (part.type === "tool_call" && typeof part.name === "string") {
        calls.push({ name: part.name, args: part.args });
      }
    }
  }
  return calls;
}

export type AutopilotSkipReason =
  | "disabled"
  | "cancelled"
  | "plan-mode"
  | "workflow-command"
  | "mechanical-only"
  | "no-assistant-output";

export interface AutopilotGateInput {
  /** The window's autopilot toggle. */
  enabled: boolean;
  /** True when /cancel fired during the turn. */
  cancelled: boolean;
  /** True when the session ended the turn in plan mode (plan modal pending). */
  planMode: boolean;
  /** True when the turn SUBMITTED a plan (exit_plan fired — the sidecar's
   *  pendingPlanPath is set). Ken reviews the plan itself instead of the
   *  work. Optional so existing callers/tests default to false. */
  planPending?: boolean;
  /** True when the turn was a workflow slash command (see isWorkflowCommandText). */
  workflowCommand: boolean;
  /** Assistant messages ADDED by this turn (after minus before). */
  assistantMessagesAdded: number;
  /** True when every tool call this turn was mechanical bash usage (see
   *  isMechanicalOnlyTurn) — nothing for Ken to review. Optional so existing
   *  callers/tests that don't set it default to false (reviewable). */
  mechanicalOnly?: boolean;
}

export type AutopilotGateDecision =
  { start: true; kind: "work" | "plan" } | { start: false; reason: AutopilotSkipReason };

/**
 * Decide whether the autopilot cycle may start for a just-finished turn.
 * Checks are ordered cheapest/most-fundamental first; the reason is logged by
 * the sidecar so skips are debuggable from gg-app-sidecar.log.
 *
 * `planPending` beats the workflow/mechanical/no-output checks: a plan
 * submission via exit_plan flips plan mode OFF and often has only mechanical
 * tool calls, but it IS reviewable work — Ken reviews the plan itself
 * (kind: "plan") instead of skipping. `planMode` still wins over it: a turn
 * that ended INSIDE plan mode (enter without exit) has no submitted plan and
 * Ken must never prompt into a read-only session.
 */
export function shouldStartAutopilotCycle(input: AutopilotGateInput): AutopilotGateDecision {
  if (!input.enabled) return { start: false, reason: "disabled" };
  if (input.cancelled) return { start: false, reason: "cancelled" };
  if (input.planMode) return { start: false, reason: "plan-mode" };
  if (input.planPending) return { start: true, kind: "plan" };
  if (input.workflowCommand) return { start: false, reason: "workflow-command" };
  if (input.mechanicalOnly) return { start: false, reason: "mechanical-only" };
  if (input.assistantMessagesAdded <= 0) return { start: false, reason: "no-assistant-output" };
  return { start: true, kind: "work" };
}

/** A tool call made during a turn, as recorded on an assistant message's
 *  content parts. Mirrors gg-ai's `ToolCall` shape minus the fields the gate
 *  doesn't need (id). */
export interface TurnToolCall {
  name: string;
  args?: Record<string, unknown>;
}

/** Dedicated tools that can never touch the repo/filesystem in a way worth
 *  reviewing: pure lookups (read/grep/find/ls/source_path),
 *  network research (web_fetch/web_search), reading a background process's
 *  output (task_output), a UI screenshot, or loading a skill definition. Any
 *  call to one of these is mechanical regardless of its arguments — unlike
 *  bash, which needs isMechanicalBashCall to tell a read-only invocation from
 *  a mutating one. Deliberately excludes generate_image (produces a real
 *  artifact), subagent (can do anything internally), tasks/task_send/
 *  task_stop (mutate task/process state), and enter_plan/exit_plan (mode
 *  transitions already handled by the separate plan-mode gate check). */
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_fetch",
  "web_search",
  "source_path",
  "task_output",
  "screenshot",
  "skill",
]);

/** Leading git subcommands that are a plain add/commit/push workflow —
 *  mechanical for review purposes even though they mutate the repo (distinct
 *  from plan-mode's stricter read-only bar in read-only-bash.ts). */
const GIT_COMMIT_WORKFLOW = /^git\s+(add|commit|push)\b/i;

/**
 * True when a bash call is mechanical: starting a background process (a dev
 * server or watcher — nothing to review until it's stopped and its actual
 * code changes land in a later turn), a read-only command (reuses the same
 * conservative classifier plan mode trusts), or a plain git add/commit/push
 * chain. Conservative by construction: anything it can't prove mechanical
 * (including a chain mixing git with other commands) returns false, so the
 * turn still gets reviewed — false negatives are safe here, false positives
 * are not.
 */
function isMechanicalBashCall(args: Record<string, unknown> | undefined): boolean {
  if (!args) return false;
  if (args.run_in_background === true) return true;
  const command = typeof args.command === "string" ? args.command : "";
  if (!command.trim()) return false;
  if (isReadOnlyCommand(command)) return true;
  const segments = command
    .split(/&&|;|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return segments.length > 0 && segments.every((s) => GIT_COMMIT_WORKFLOW.test(s));
}

/**
 * True when the turn has nothing for Ken to review: either it made NO tool
 * calls at all (a plain-text answer — "a plain question that got answered
 * with no code touched" is IGNORE per the autopilot contract), or EVERY tool
 * call was mechanical (a dedicated read-only tool, or bash usage that starts
 * a background process / is read-only / is a plain git commit-push chain).
 * ANY non-mechanical call (edit, write, subagent, generate_image, or bash
 * outside these safe shapes) makes the whole turn reviewable — conservative
 * default: keep reviewing whenever it's unclear.
 */
export function isMechanicalOnlyTurn(toolCalls: readonly TurnToolCall[]): boolean {
  if (toolCalls.length === 0) return true;
  return toolCalls.every(
    (call) =>
      READ_ONLY_TOOL_NAMES.has(call.name) ||
      (call.name === "bash" && isMechanicalBashCall(call.args)),
  );
}
