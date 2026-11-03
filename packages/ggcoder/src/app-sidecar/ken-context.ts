import type { AgentSession } from "../core/agent-session.js";
import type { WorkflowCommandSpec } from "../core/autopilot-gate.js";
import { buildKenDigest } from "../core/ken-context.js";

/** Ken's read-only tool allow-list. Excludes every mutating tool (write/edit/
 *  bash/tasks/subagent/generate_image/enter_plan/exit_plan/task_*) so the mentor
 *  agent can research + see, but never change the repo. */
export const KEN_ALLOWED_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "source_path",
  "web_fetch",
  "web_search",
  "screenshot",
  // Local corpus of real repos: lets Ken verify against code that ships
  // instead of assuming — core to how he's meant to work. Read-only.
  "steroids",
];

/** Extract the plain text of the most recent assistant message (Ken's reply).
 *  Strips tool-call / image blocks, returning just the prose Ken streamed. */
export function lastAssistantText(messages: ReturnType<AgentSession["getMessages"]>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    return m.content
      .map((c) => (c.type === "text" && "text" in c && typeof c.text === "string" ? c.text : ""))
      .join("");
  }
  return "";
}

/**
 * Assemble Ken's context digest for one `@Ken` question: git/env + the build
 * session's compaction summary + recent activity. Prepended to the user's
 * question as Ken's prompt body each turn. Project docs (CLAUDE.md/AGENTS.md)
 * are NOT here — they're folded into Ken's cached system prompt once per
 * session instead (see ken-prompt.ts), so they hit the provider prompt cache
 * instead of being re-sent uncached on every question. Workflow commands +
 * autopilot-injected prompts are passed through so the digest labels them as
 * what they are instead of user-authored asks.
 */
export function buildKenContext(
  buildSession: AgentSession,
  cwd: string,
  gitBranch: string | null,
  question: string,
  workflowCommands: readonly WorkflowCommandSpec[],
  injectedPrompts: readonly string[],
): string {
  return buildKenDigest({
    question,
    cwd,
    gitBranch,
    messages: buildSession.getMessages(),
    verificationEvidence: buildSession.getVerificationEvidence(),
    verificationProblem: buildSession.getVerificationProblem(),
    workflowCommands,
    injectedPrompts,
  });
}
