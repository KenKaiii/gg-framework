/**
 * Ken's context digest — assembled fresh on each `@Ken` question.
 *
 * The build session (GG Coder) and Ken are two separate `AgentSession` objects.
 * Ken never appears in GG Coder's transcript; on each question we read GG
 * Coder's `getMessages()`, distill it into a cheap text digest, and prepend it
 * to the user's question as Ken's prompt body. Ken's read-only tools fill any
 * gap the digest misses (he can read the actual files or screenshot the UI).
 *
 * Kept pure + dependency-light so it's unit-testable without booting the sidecar
 * (which runs `main()` at import time).
 *
 * NOTE: static project docs (CLAUDE.md/AGENTS.md) are NOT part of this digest
 * — they're folded into Ken's cached system prompt once per session
 * (`buildKenSystemPrompt`/`buildKenAutopilotSystemPrompt` in ken-prompt.ts) so
 * they hit the provider prompt cache instead of being re-sent uncached on
 * every `@Ken` question and every autopilot review round.
 */
import type { Message, ContentPart, ToolResult } from "@kenkaiiii/gg-ai";
import { matchExpandedCommand, type WorkflowCommandSpec } from "./autopilot-gate.js";

/** How many of the most recent build-session messages to inline verbatim. */
export const KEN_RECENT_MESSAGE_LIMIT = 20;

/** Marker the compactor prepends to its summary user-message. */
const COMPACTION_SUMMARY_MARKER = "[Previous conversation summary]";

/** Max chars of any single message's rendered text in the digest. */
const MESSAGE_CHAR_CAP = 1500;

/** Softer cap for the pinned original-request section: the ask under review
 *  must never be judged against a mid-sentence truncation, so it gets far more
 *  room than a recent-activity line. */
const ORIGINAL_REQUEST_CAP = 4000;

/** Label for a user-role message that was actually injected by Autopilot Ken.
 *  Without it, multi-round cycles render Ken's own fix prompts as `**User:**`
 *  and he starts reviewing against his own last prompt instead of the user's
 *  original ask. Referenced by the autopilot system prompt — keep in sync. */
export const INJECTED_PROMPT_LABEL = "**Ken autopilot (injected):**";

export interface KenDigestInput {
  /** The user's `@Ken …` text (already stripped of the mention). */
  question: string;
  cwd: string;
  gitBranch: string | null;
  /** Build session messages (`buildSession.getMessages()`). */
  messages: Message[];
  /** Platform string (defaults to process.platform). */
  platform?: string;
  /** Override the recent-message cap (tests). */
  recentLimit?: number;
  /** The user prompt that started the turn under review (autopilot). Pinned in
   *  its own section so it can never scroll out of the rolling recent-activity
   *  window during multi-round cycles. */
  originalRequest?: string;
  /** Prompt bodies Autopilot Ken injected into the build session. Matching
   *  user messages render under {@link INJECTED_PROMPT_LABEL}, not `**User:**`. */
  injectedPrompts?: readonly string[];
  /** Known workflow commands (built-in + custom). Expanded template bodies in
   *  the transcript render as a short `[ran workflow command /name]` note
   *  instead of hundreds of template lines masquerading as a user ask. */
  workflowCommands?: readonly WorkflowCommandSpec[];
}

/** Truncate long text and note how much was dropped. */
function cap(text: string, max = MESSAGE_CHAR_CAP): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} […${text.length - max} more chars]`;
}

/** Summarize one tool call to a `name(arg)` one-liner. */
function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const primary =
    args.file_path ??
    args.path ??
    args.pattern ??
    args.query ??
    args.command ??
    args.url ??
    undefined;
  const arg = typeof primary === "string" ? cap(primary, 80) : "";
  return arg ? `${name}(${arg})` : `${name}()`;
}

/** Per-digest options threaded into message rendering. */
interface RenderMessageOptions {
  injectedPrompts: readonly string[];
  workflowCommands: readonly WorkflowCommandSpec[];
}

/** Render one user-role message body with provenance-aware labeling:
 *  autopilot-injected prompts and workflow-command expansions are labeled as
 *  what they ARE, so Ken never mistakes either for a user-authored ask. */
function renderUserText(text: string, opts: RenderMessageOptions): string | null {
  if (!text) return null;
  if (opts.injectedPrompts.some((p) => p.trim() === text.trim())) {
    return `${INJECTED_PROMPT_LABEL} ${cap(text)}`;
  }
  const expanded = matchExpandedCommand(text, opts.workflowCommands);
  if (expanded) {
    const head = `**User:** [ran workflow command /${expanded.command.name}]`;
    return expanded.args ? `${head} with instructions: ${cap(expanded.args, 400)}` : head;
  }
  return `**User:** ${cap(text)}`;
}

/** Render one message's role-tagged text, stripping image/blob payloads and
 *  summarizing tool calls/results to short lines. Returns null for empty/noise
 *  messages (e.g. a tool result that was only an image). */
function renderMessage(msg: Message, opts: RenderMessageOptions): string | null {
  if (msg.role === "user") {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .map((p) => (p.type === "text" ? p.text : `[${p.type}]`))
            .join(" ")
            .trim();
    return renderUserText(text, opts);
  }

  if (msg.role === "assistant") {
    if (typeof msg.content === "string") {
      return msg.content.trim() ? `**GG Coder:** ${cap(msg.content)}` : null;
    }
    const parts: string[] = [];
    const calls: string[] = [];
    for (const p of msg.content as ContentPart[]) {
      if (p.type === "text" && p.text.trim()) parts.push(p.text.trim());
      else if (p.type === "tool_call") calls.push(summarizeToolCall(p.name, p.args));
    }
    const segments: string[] = [];
    if (parts.length > 0) segments.push(cap(parts.join("\n")));
    if (calls.length > 0) segments.push(`[tools: ${calls.join(", ")}]`);
    return segments.length > 0 ? `**GG Coder:** ${segments.join(" ")}` : null;
  }

  if (msg.role === "tool") {
    const results = msg.content as ToolResult[];
    const texts: string[] = [];
    for (const tr of results) {
      if (typeof tr.content === "string") {
        if (tr.content.trim()) texts.push(tr.content.trim());
      } else {
        const t = tr.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .filter(Boolean)
          .join(" ")
          .trim();
        if (t) texts.push(t);
      }
    }
    if (texts.length === 0) return null;
    return `**Tool result:** ${cap(texts.join(" "), 400)}`;
  }

  return null;
}

/**
 * Fixed instruction fed into the digest's `question` slot in autopilot mode.
 * Autopilot Ken doesn't answer a user — he reviews the just-finished GG Coder
 * turn against the user's original ask and replies with a verdict only. The
 * verdict format itself is taught by his system prompt; this just points him at
 * the transcript and demands the machine-parseable answer.
 */
export const AUTOPILOT_REVIEW_INSTRUCTION =
  "GG Coder just finished a turn. Review its work against the user's original " +
  "ask (the 'Original user request' section above; lines labeled 'Ken " +
  "autopilot (injected)' are your own earlier fix prompts, NOT user asks). " +
  "Reply with your verdict ONLY — the first line must be exactly PROMPT, " +
  "ALL_CLEAR, IGNORE, or HUMAN, with the payload after. If a 'Verification " +
  "exception awaiting review' section exists, a bare ALL_CLEAR does not accept " +
  "it; use that section's exact machine-readable acceptance line only when you " +
  "explicitly accept the current exception. If GG Coder ended by asking the user " +
  "a question or presenting options, use HUMAN only when the answer requires an " +
  "actual user-level decision: intent, preference, missing product requirement, " +
  "credential/secret, external access, budget/cost, or destructive/irreversible " +
  "approval. If the question is only permission to continue work that is " +
  "mechanically implied by the user's original ask and safe for GG Coder to do " +
  "without new information, use PROMPT with the next concrete follow-up instead. " +
  "No greetings, no mentorship prose.";

/** A persisted typed verification exception shown to Autopilot Ken for an
 *  explicit, attributable acceptance decision. */
export interface KenVerificationException {
  id: string;
  requesterActor: string;
  reason: string | null;
  timestamp: string;
  evidence: readonly string[];
}

/** Inputs the sidecar gathers for an autopilot review digest (everything
 *  `buildKenDigest` needs except the fixed review instruction, which this helper
 *  supplies as the `question`). */
export type KenAutopilotContextInput = Omit<KenDigestInput, "question"> & {
  verificationException?: KenVerificationException | null;
};

/** Insert a review-only section immediately before the trailing instruction. */
function insertBeforeQuestion(digest: string, section: string): string {
  const marker = "\n\n## They just asked you\n";
  const index = digest.lastIndexOf(marker);
  if (index === -1) return `${digest}\n\n${section}`;
  return `${digest.slice(0, index)}\n\n${section}${digest.slice(index)}`;
}

function renderVerificationException(exception: KenVerificationException): string {
  const details = JSON.stringify(
    {
      id: exception.id,
      requesterActor: exception.requesterActor,
      reason: exception.reason,
      timestamp: exception.timestamp,
      evidence: exception.evidence,
    },
    null,
    2,
  );
  const acceptance = JSON.stringify({ id: exception.id });
  return (
    `## Verification exception awaiting review\n` +
    `The latest typed verification result is exception-requested. Judge this specific ` +
    `request from its reason and evidence; do not infer acceptance from ALL_CLEAR.\n\n` +
    `\`\`\`json\n${details}\n\`\`\`\n\n` +
    `A bare ALL_CLEAR leaves the phase in Review. To explicitly accept this exact ` +
    `exception, reply with these two lines:\nALL_CLEAR\n` +
    `ACCEPT_VERIFICATION_EXCEPTION ${acceptance}`
  );
}

/**
 * Build the autopilot-review digest: identical to a normal Ken digest but with
 * the fixed {@link AUTOPILOT_REVIEW_INSTRUCTION} as the trailing question, so
 * Ken reviews the transcript instead of answering a user. Pure — no I/O.
 */
export function buildKenAutopilotContext(input: KenAutopilotContextInput): string {
  const { verificationException, ...digestInput } = input;
  const digest = buildKenDigest({
    ...digestInput,
    question: AUTOPILOT_REVIEW_INSTRUCTION,
  });
  return verificationException
    ? insertBeforeQuestion(digest, renderVerificationException(verificationException))
    : digest;
}

/** Max chars of the inlined plan markdown in a plan-review digest. Plans are
 *  hand-written markdown, rarely near this; the cap only guards against a
 *  pathological plan blowing the reviewer's context. */
const PLAN_CONTENT_CAP = 8000;

/**
 * Fixed instruction fed into the digest's `question` slot for an autopilot
 * PLAN review. In autopilot there is no user in the loop: Ken himself is the
 * plan reviewer — ALL_CLEAR approves (auto-accept + implementation starts),
 * PROMPT sends revision feedback, HUMAN is reserved for genuine user-level
 * decisions. IGNORE is meaningless for a plan (the sidecar maps it to approve
 * defensively), so the instruction forbids it outright.
 */
export const AUTOPILOT_PLAN_REVIEW_INSTRUCTION =
  "GG Coder submitted an implementation plan (the 'Plan under review' section " +
  "above). You are the reviewer — there is no user in the loop. Reply with " +
  "your verdict ONLY — the first line must be exactly ALL_CLEAR (approve — the " +
  "plan is sound and implementation starts immediately), PROMPT + feedback " +
  "(send it back for revision), or HUMAN + reason (a real product/destructive " +
  "decision only the user can make). Never IGNORE a plan. No greetings, no " +
  "mentorship prose.";

/**
 * Build the autopilot PLAN-review digest: the normal autopilot digest plus a
 * `## Plan under review` section carrying the submitted plan's markdown, with
 * {@link AUTOPILOT_PLAN_REVIEW_INSTRUCTION} as the trailing question. Pure —
 * the sidecar reads the plan file and passes its content. The plan section is
 * spliced in before the trailing question so it sits closest to the
 * instruction that references it.
 */
export function buildKenAutopilotPlanContext(
  input: Omit<KenAutopilotContextInput, "verificationException"> & { planContent: string },
): string {
  const { planContent, ...rest } = input;
  const digest = buildKenDigest({ ...rest, question: AUTOPILOT_PLAN_REVIEW_INSTRUCTION });
  const planSection = `## Plan under review\n${cap(planContent.trim(), PLAN_CONTENT_CAP)}`;
  return insertBeforeQuestion(digest, planSection);
}

/**
 * Build Ken's full context digest string. Pure — no I/O. The sidecar gathers the
 * inputs (project context, git, messages) and calls this.
 */
export function buildKenDigest(input: KenDigestInput): string {
  const recentLimit = input.recentLimit ?? KEN_RECENT_MESSAGE_LIMIT;
  const platform = input.platform ?? process.platform;

  // Find the latest compaction summary; everything newer is "recent activity".
  const isSummary = (m: Message): boolean =>
    m.role === "user" &&
    typeof m.content === "string" &&
    m.content.startsWith(COMPACTION_SUMMARY_MARKER);

  let summaryText = "";
  let summaryIndex = -1;
  for (let i = input.messages.length - 1; i >= 0; i--) {
    if (isSummary(input.messages[i])) {
      summaryIndex = i;
      const c = input.messages[i].content;
      summaryText = typeof c === "string" ? c.slice(COMPACTION_SUMMARY_MARKER.length).trim() : "";
      break;
    }
  }

  // Recent conversation = messages after the summary (or the tail), skipping
  // the system message and the summary message itself.
  const renderOpts: RenderMessageOptions = {
    injectedPrompts: input.injectedPrompts ?? [],
    workflowCommands: input.workflowCommands ?? [],
  };
  const afterSummary = input.messages.slice(summaryIndex + 1).filter((m) => m.role !== "system");
  const recent = afterSummary.slice(-recentLimit);
  const renderedRecent = recent
    .map((m) => renderMessage(m, renderOpts))
    .filter((l): l is string => l !== null);

  const sections: string[] = [];

  sections.push(
    `## Who you are\nYou are Ken Kai, mentoring the user inside GG Coder. Your persona is in your system prompt. Below is what GG Coder and the user are working on.`,
  );

  const building: string[] = [];
  building.push(
    `- Working directory: ${input.cwd}`,
    `- Platform: ${platform}`,
    `- Git branch: ${input.gitBranch ?? "(not a git repo / unknown)"}`,
  );
  sections.push(`## What they're building\n${building.join("\n")}`);

  if (summaryText) {
    sections.push(`## Story so far\n${cap(summaryText, 4000)}`);
  }

  // Pinned so multi-round autopilot cycles can never lose the ask under review
  // to the rolling recent-activity window (the drift that made Ken judge his
  // own injected prompt as "the user's request").
  if (input.originalRequest?.trim()) {
    sections.push(
      `## Original user request (the turn under review)\n${cap(
        input.originalRequest.trim(),
        ORIGINAL_REQUEST_CAP,
      )}`,
    );
  }

  sections.push(
    `## Recent activity (GG Coder and user)\n${
      renderedRecent.length > 0 ? renderedRecent.join("\n\n") : "(no conversation yet)"
    }`,
  );

  sections.push(`## They just asked you\n${input.question.trim()}`);

  return sections.join("\n\n");
}
