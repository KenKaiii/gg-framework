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
import type { Message, ContentPart, ToolResult } from "@kleio/ai";
import { matchExpandedCommand, type WorkflowCommandSpec } from "./autopilot-gate.js";
import { AUTOPILOT_INJECTION_PREAMBLE } from "./autopilot-cycle.js";
import { collectVerificationEvidence, type VerificationEvidence } from "./verification-evidence.js";
import { editTargetPaths } from "../tools/edit-targets.js";

/** How many of the most recent build-session messages to inline verbatim. */
export const KEN_RECENT_MESSAGE_LIMIT = 20;

/** Marker the compactor prepends to its summary user-message. */
const COMPACTION_SUMMARY_MARKER = "[Previous conversation summary]";

/** Max chars of any single message's rendered text in the digest. */
const MESSAGE_CHAR_CAP = 1500;

/** Pinned requests get more room than activity; any truncation is explicit. */
const ORIGINAL_REQUEST_CAP = 4000;

/** Extra context preserves older user decisions, not old tool/assistant chatter. */
const EARLIER_REQUESTS_CAP = 8000;

/** Max paths listed in an autopilot digest's changed-files section. */
const CHANGED_FILES_LIMIT = 40;

/** Tools whose successful calls change the file named by their `file_path`. */
const FILE_CHANGING_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

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
  /** Authoritative current-revision results from the build session's gate. */
  verificationEvidence?: readonly VerificationEvidence[];
  /** null means the host gate is satisfied; undefined means no live host state. */
  verificationProblem?: string | null;
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

/** Make loss of intent-bearing context explicit, not just an ellipsis. */
function capContext(text: string, max: number, source: string): string {
  const rendered = cap(text, max);
  return text.length <= max
    ? rendered
    : `${rendered}\n[Context incomplete: ${source} was truncated. Recover missing requirements before approving dependent work; do not guess.]`;
}

function userText(msg: Message): string {
  if (msg.role !== "user") return "";
  return typeof msg.content === "string"
    ? msg.content
    : msg.content
        .map((p) => (p.type === "text" ? p.text : `[${p.type}]`))
        .join(" ")
        .trim();
}

function isInjected(text: string, opts: RenderMessageOptions): boolean {
  return (
    text.trimStart().startsWith(AUTOPILOT_INJECTION_PREAMBLE) ||
    opts.injectedPrompts.some((p) => p.trim() === text.trim())
  );
}

/** Summarize one tool call to a `name(arg)` one-liner. */
function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const primary =
    args.file_path ??
    editTargetPaths(args)[0] ??
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
function renderUserText(
  text: string,
  opts: RenderMessageOptions,
  max = MESSAGE_CHAR_CAP,
): string | null {
  if (!text.trim()) return null;
  if (isInjected(text, opts)) {
    return `${INJECTED_PROMPT_LABEL} ${cap(text)}`;
  }
  const expanded = matchExpandedCommand(text, opts.workflowCommands);
  if (expanded) {
    const head = `**User:** [ran workflow command /${expanded.command.name}]`;
    return expanded.args
      ? `${head} with instructions: ${capContext(expanded.args, max, "workflow instructions")}`
      : head;
  }
  return `**User:** ${capContext(text, max, "user message")}`;
}

/** Render one message's role-tagged text, stripping image/blob payloads and
 *  summarizing tool calls/results to short lines. Returns null for empty/noise
 *  messages (e.g. a tool result that was only an image). */
function renderMessage(msg: Message, opts: RenderMessageOptions): string | null {
  if (msg.role === "user") {
    const text = userText(msg);
    if (msg.provenance && msg.provenance.source !== "human") {
      if (!text.trim()) return null;
      if (isInjected(text, opts)) return `${INJECTED_PROMPT_LABEL} ${cap(text)}`;
      const label = msg.provenance.source === "runtime" ? "Runtime" : "Agent automation";
      return `**${label} (not a user request):** ${cap(text)}`;
    }
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

/** Paths named by successful edit/write calls, sorted. Failed calls changed
 *  nothing, so they are left out. */
function collectChangedFiles(messages: readonly Message[]): string[] {
  const failed = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const tr of m.content as ToolResult[]) if (tr.isError) failed.add(tr.toolCallId);
  }
  const files = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const p of m.content as ContentPart[]) {
      if (p.type !== "tool_call" || !FILE_CHANGING_TOOLS.has(p.name) || failed.has(p.id)) continue;
      const paths = p.name === "edit" ? editTargetPaths(p.args) : [p.args.file_path];
      for (const filePath of paths) {
        if (typeof filePath === "string" && filePath.trim()) files.add(filePath.trim());
      }
    }
  }
  return [...files].sort();
}

/**
 * The autopilot reviewer only sees a truncated tail of the transcript, so on a
 * long turn early edits scroll out. List every file the turn changed so he can
 * read them himself. The turn starts at the last human message carrying the
 * original request; when that message is gone (compacted mid-turn, or the
 * session was reset to implement an approved plan), every retained message
 * belongs to the turn, and the section says so.
 */
function renderChangedFiles(
  messages: readonly Message[],
  originalRequest: string,
  opts: RenderMessageOptions,
): string | null {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || (m.provenance && m.provenance.source !== "human")) continue;
    // Ken's own fix prompts may quote the request; they don't start the turn.
    const text = userText(m);
    if (!isInjected(text, opts) && text.includes(originalRequest)) {
      start = i;
      break;
    }
  }
  const files = collectChangedFiles(messages.slice(Math.max(start, 0)));
  // No section rather than "(none)": shell commands and subagents change files
  // without edit/write calls, and an empty list must not read as "no work done".
  if (files.length === 0) return null;
  const scope =
    start >= 0
      ? "since the original request"
      : "across the retained transcript (the original request message was compacted or reset away)";
  const listed = files.slice(0, CHANGED_FILES_LIMIT).map((f) => `- ${cap(f, 200)}`);
  if (files.length > CHANGED_FILES_LIMIT) {
    listed.push(`- […${files.length - CHANGED_FILES_LIMIT} more files]`);
  }
  return (
    "## Files changed by the work under review\n" +
    `Successful edit/write calls ${scope}. Shell commands and subagents can change files too, so this list may be incomplete. ` +
    "Read these with your tools when the truncated activity above does not show enough to judge.\n" +
    listed.join("\n")
  );
}

/** How a digest introduces itself and its trailing question. Chat Ken talks to
 *  a user; autopilot Ken reviews for a machine and must not be told otherwise. */
interface DigestFraming {
  intro: string;
  buildingHeading: string;
  questionHeading: string;
  /** Autopilot only: list the files the turn under review changed. */
  changedFiles: boolean;
}

const CHAT_FRAMING: DigestFraming = {
  intro:
    "## Who you are\nYou are Ken Kai, mentoring the user inside GG Coder. Your persona is in your system prompt. Below is what GG Coder and the user are working on.",
  buildingHeading: "## What they're building",
  questionHeading: "## They just asked you",
  changedFiles: false,
};

const AUTOPILOT_FRAMING: DigestFraming = {
  intro:
    "## Your role\nYou are Ken Kai in autopilot, reviewing GG Coder's just-finished turn. No user is in this conversation; a machine parses your reply. Below is the work under review.",
  buildingHeading: "## Project",
  questionHeading: "## Your task",
  changedFiles: true,
};

/**
 * Fixed instruction fed into the digest's `question` slot in autopilot mode.
 * Autopilot Ken doesn't answer a user — he reviews the just-finished GG Coder
 * turn against the user's original ask and replies with a verdict only. The
 * verdict format itself is taught by his system prompt; this just points him at
 * the transcript and demands the machine-parseable answer.
 */
export const AUTOPILOT_REVIEW_INSTRUCTION =
  "GG Coder just finished a turn. Review its work against the user's original " +
  "ask and genuine user corrections (including retained earlier decisions; the 'Original user request' section pins the current turn). Lines labeled 'Ken " +
  "autopilot (injected)' are your own earlier fix prompts, NOT user asks. " +
  "The activity above is truncated; when it does not show enough to judge a change, read the " +
  "changed files yourself. " +
  "Reply with your verdict ONLY: the first line must be the verdict keyword (PROMPT, " +
  "ALL_CLEAR, IGNORE, or HUMAN), with the payload after. If GG Coder ended by " +
  "asking the user a question or presenting options, use HUMAN only when the " +
  "answer requires an actual user-level decision: intent, preference, missing " +
  "product requirement, credential/secret, external access, budget/cost, or " +
  "destructive/irreversible approval. If the question is only permission to " +
  "continue work that is mechanically implied by the user's original ask and " +
  "safe for GG Coder to do without new information, use PROMPT with the next " +
  "concrete follow-up instead. No greetings, no mentorship prose.";

/** Inputs the sidecar gathers for an autopilot review digest (everything
 *  `buildKenDigest` needs except the fixed review instruction, which this helper
 *  supplies as the `question`). */
export type KenAutopilotContextInput = Omit<KenDigestInput, "question">;

/**
 * Build the autopilot-review digest: the normal Ken digest with autopilot
 * framing (no user, a changed-files list) and the fixed
 * {@link AUTOPILOT_REVIEW_INSTRUCTION} as the trailing task, so Ken reviews the
 * transcript instead of answering a user. Pure — no I/O.
 */
export function buildKenAutopilotContext(input: KenAutopilotContextInput): string {
  return renderDigest({ ...input, question: AUTOPILOT_REVIEW_INSTRUCTION }, AUTOPILOT_FRAMING);
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
 * decisions. IGNORE is not approval: the cycle stops rather than implementing.
 */
export const AUTOPILOT_PLAN_REVIEW_INSTRUCTION =
  "GG Coder submitted an implementation plan (the 'Plan under review' section " +
  "above). You are the reviewer — there is no user in the loop. Reply with " +
  "your verdict ONLY. The first line must be the verdict keyword: ALL_CLEAR (approve — the " +
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
  input: KenAutopilotContextInput & { planContent: string },
): string {
  const { planContent, ...rest } = input;
  const digest = renderDigest(
    { ...rest, question: AUTOPILOT_PLAN_REVIEW_INSTRUCTION },
    AUTOPILOT_FRAMING,
  );
  const planSection = `## Plan under review\n${capContext(planContent.trim(), PLAN_CONTENT_CAP, "plan")}`;
  // Insert the plan section right before the trailing task section (always
  // the last one renderDigest appends).
  const marker = `\n\n${AUTOPILOT_FRAMING.questionHeading}\n`;
  const idx = digest.lastIndexOf(marker);
  if (idx === -1) return `${digest}\n\n${planSection}`;
  return `${digest.slice(0, idx)}\n\n${planSection}${digest.slice(idx)}`;
}

/**
 * Build Ken's full context digest string for an `@Ken` chat question. Pure — no
 * I/O. The sidecar gathers the inputs (project context, git, messages) and
 * calls this.
 */
export function buildKenDigest(input: KenDigestInput): string {
  return renderDigest(input, CHAT_FRAMING);
}

function renderDigest(input: KenDigestInput, framing: DigestFraming): string {
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

  sections.push(framing.intro);

  const building: string[] = [];
  building.push(
    `- Working directory: ${input.cwd}`,
    `- Platform: ${platform}`,
    `- Git branch: ${input.gitBranch ?? "(not a git repo / unknown)"}`,
  );
  sections.push(`${framing.buildingHeading}\n${building.join("\n")}`);

  if (summaryText) {
    sections.push(
      `## Story so far\nCompacted conversation summary (not new user authorization):\n${capContext(summaryText, 4000, "conversation summary")}`,
    );
  }

  // Pinned so multi-round autopilot cycles can never lose the ask under review
  // to the rolling recent-activity window (the drift that made Ken judge his
  // own injected prompt as "the user's request").
  if (input.originalRequest?.trim()) {
    sections.push(
      `## Original user request (the turn under review)\n${capContext(
        input.originalRequest.trim(),
        ORIGINAL_REQUEST_CAP,
        "original request",
      )}`,
    );
  }

  // Keep older user-authored decisions outside the activity window. Skip known
  // automation and the already-pinned request; never promote agent prose to intent.
  const earlier: string[] = [];
  let remaining = EARLIER_REQUESTS_CAP;
  let omitted = false;
  for (let i = afterSummary.length - recent.length - 1; i >= 0; i--) {
    const message = afterSummary[i];
    // Legacy sessions lack provenance; explicit runtime/agent messages are not
    // human decisions and must not consume the retained-intent budget.
    if (message.provenance && message.provenance.source !== "human") continue;
    const text = userText(message);
    if (
      !text.trim() ||
      isInjected(text, renderOpts) ||
      text.trim() === input.originalRequest?.trim()
    )
      continue;
    const rendered = renderUserText(text, renderOpts, ORIGINAL_REQUEST_CAP);
    if (!rendered) continue;
    if (rendered.length + 2 > remaining) {
      omitted = true;
      continue;
    }
    earlier.push(rendered);
    remaining -= rendered.length + 2;
  }
  if (earlier.length > 0 || omitted) {
    sections.push(
      "## Earlier user requests and decisions\n" +
        "Retained from the conversation, oldest first. Apply relevant constraints; later genuine user corrections supersede earlier choices. These are not extra tasks to restart.\n" +
        (omitted
          ? "[Context incomplete: some earlier user messages exceed the context budget. Do not assume their requirements are satisfied.]\n"
          : "") +
        earlier.reverse().join("\n\n"),
    );
  }

  sections.push(
    `## Recent activity (GG Coder and user)\n${
      renderedRecent.length > 0 ? renderedRecent.join("\n\n") : "(no conversation yet)"
    }`,
  );

  const request = input.originalRequest?.trim();
  const changedFiles =
    framing.changedFiles && request ? renderChangedFiles(afterSummary, request, renderOpts) : null;
  if (changedFiles) sections.push(changedFiles);

  const verificationEvidence = (
    input.verificationEvidence ?? collectVerificationEvidence(afterSummary)
  ).slice(-12);
  if (verificationEvidence.length > 0 || input.verificationEvidence !== undefined) {
    const rows = verificationEvidence.map(
      (evidence) =>
        `- ${evidence.status.toUpperCase()}: \`${cap(evidence.command, 180)}\` — ${evidence.reason}`,
    );
    sections.push(
      "## Harness-classified verification evidence\n" +
        "Only PASSED entries below count as bounded verification evidence; model-authored claims do not.\n" +
        (input.verificationEvidence !== undefined
          ? "These are the completion gate's host-observed results, including completed background checks. " +
            "Do not reclassify them from launch text or demand foreground reruns. A build pass does not imply tests ran.\n"
          : "") +
        (input.verificationProblem !== undefined
          ? `Current host gate: ${input.verificationProblem ?? "satisfied; do not require reruns merely because older checks failed or named records were not retained across restart"}.\n`
          : "") +
        rows.join("\n"),
    );
  }

  sections.push(`${framing.questionHeading}\n${input.question.trim()}`);

  return sections.join("\n\n");
}
