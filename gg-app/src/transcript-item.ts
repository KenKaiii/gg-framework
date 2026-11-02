import type { AskUserPrompt, PromptSegment } from "./agent";
import type { ChatErrorItem } from "./chat-error";
import type { HookKind, VerificationReason } from "./HookNotice";
import type { PlanDecision } from "./PlanDecisionNotice";
import type { SubAgentLine } from "./SubAgentFeed";

// ── Transcript model ───────────────────────────────────────
// Tool activity lives in the pinned LiveToolPanel, never in the transcript.
// Exported (type-only) so the Ken mentor hook can produce/typecheck ken + error
// transcript items without a runtime import cycle.
export type Item =
  // `command` marks a workflow slash command — rendered as just the short
  // `/name` with a highlight + shimmer, never the expanded prompt body.
  // `label` overrides what's shown with a friendly shimmer phrase (e.g.
  // "Initializing Git…") while the full prompt still goes to the agent.
  | {
      kind: "user";
      id: number;
      text: string;
      command?: boolean;
      label?: string;
      images?: string[];
      files?: string[];
      // Corrected-term segments from the prompt enhancer, when this message was
      // sent unedited straight after an enhance. Drives the highlighted bubble.
      enhancements?: PromptSegment[];
      // True while this message is still waiting in the mid-run steering queue.
      // Rendered dimmed; cleared once the agent has consumed it.
      queued?: boolean;
      // Set for one animation beat as `queued` clears, so the bubble can morph
      // into a normal one (dim → solid, "queued" pill collapsing away) instead of
      // snapping. Cleared by a timer in useAgentEvents once the motion is done.
      promoted?: boolean;
      // True when this prompt was addressed to Ken (`@Ken …`). Renders the bubble
      // in Ken's color so the transcript shows it went to the mentor, not GG Coder.
      ken?: boolean;
      // True when this bubble came from clicking a "Send to GG Coder" button on
      // one of Ken's recommended prompts. Renders as a shimmering "Sent to GG
      // Coder" label in Ken's color (like a slash command shows `/name`), instead
      // of the full prompt body that was actually sent to GG Coder.
      kenSent?: boolean;
    }
  | { kind: "assistant"; id: number; text: string }
  // Ken Kai (mentor agent) reply — magenta-tinted bubble + "Ken Kai" badge,
  // streamed from the ken_* SSE events. Never mistaken for GG Coder.
  | { kind: "ken"; id: number; text: string }
  | { kind: "info"; id: number; text: string }
  // A safety guard blocked something (or found an infected installed package).
  | { kind: "security"; id: number; rule: string; target: string; count?: number }
  // Structured error (see gg-ai's formatError): headline always answers "is this
  // me or them", message is the raw detail (omitted when redundant with the
  // headline), guidance is the action line (retry / switch model / log in /
  // wait until a reset time). `text` is a legacy fallback for older items.
  | ChatErrorItem
  // Agent self-correction hook notice (ideal review / loop-break / re-grounding),
  // rendered as a working critter row with critter-themed wording.
  | { kind: "hook"; id: number; hook: HookKind; verificationReason?: VerificationReason }
  // Images produced by a tool (screenshot / read of an image file).
  | { kind: "images"; id: number; images: TranscriptImage[]; caption?: string }
  // Image generation in progress — a shimmering square placeholder that gets
  // replaced by the final image when the tool result arrives.
  | { kind: "generating_image"; id: number; prompt: string; toolCallId: string }
  // Plan-mode entry banner (ASCII logo + optional reason).
  | { kind: "plan"; id: number; reason: string }
  // What the user did with a reviewed plan: an amber critter row.
  | { kind: "plan_decision"; id: number; decision: PlanDecision }
  // A question from the `ask_user` tool — clickable options rendered in the
  // thread. The turn is blocked until the answers are sent, or until the run
  // ends without them (`cancelled`, which closes the band).
  | {
      kind: "ask";
      id: number;
      prompt: AskUserPrompt;
      /** Answers so far. Partial until every question in the band has one. */
      answers?: Record<string, string | string[]>;
      /** The complete set reached the blocked tool call. */
      sent?: boolean;
      /** Answered in this window just now (it moved to the end as a new row). */
      answeredLive?: boolean;
      cancelled?: boolean;
      /** Soft deadline passed: the agent went on; an answer is still delivered late. */
      deferred?: boolean;
    }
  // A command the user ran themselves (`!cmd`). Its output streams through the
  // live-text store while it runs; `output` holds it once finished.
  | ShellItem
  // A task kicked off from the Tasks modal (shown at the top of its session).
  | { kind: "task"; id: number; title: string }
  // Sub-agents delegated in a turn — a live, in-chat feed of each one's tools.
  | { kind: "subagent_group"; id: number; agents: SubAgentLine[]; aborted?: boolean }
  // Context compaction — a critter row: shimmering "A critter is munching…"
  // while running, then "A critter ate N messages and spat out M" when done.
  | {
      kind: "compaction";
      id: number;
      status: "running" | "done";
      originalCount?: number;
      newCount?: number;
    }
  // Autopilot Ken verdict — emitted by the auto-review loop and rendered like a
  // normal @Ken reply bubble (Ken dot + text), not a separate marker style.
  // `phase` selects the message: he prompted GG Coder (with the `body` he sent),
  // gave the all-clear, needs a human (with `reason`), or hit the round cap.
  | {
      kind: "autopilot";
      id: number;
      phase: "prompted" | "done" | "human" | "capped" | "plan_approved";
      reason?: string;
      body?: string;
      /** Stable seed from persisted marker data so resumed all-clear copy doesn't flicker. */
      copySeed?: string;
    };

export interface TranscriptImage {
  /** data: URL (base64) ready to drop into <img src>. */
  src: string;
  /** Source file path, shown as a caption + used as a stable key. */
  path?: string;
}

let idSeq = 0;
/** Next transcript item id (module-wide, monotonically increasing). */
export const nextId = (): number => ++idSeq;
/** The most recently issued transcript item id. */
export const lastIssuedId = (): number => idSeq;

export type ShellItem = {
  kind: "shell";
  id: number;
  runId: string;
  command: string;
  cwd: string;
  /** confirm: waiting for Run/Cancel. declined: the user said no. failed: never started. */
  status: "confirm" | "declined" | "running" | "done" | "failed";
  output: string;
  startedAt?: number;
  exitCode?: number | null;
  durationMs?: number;
  cancelled?: boolean;
  /** Live: output stopped showing past the cap. Restored: only the last lines were saved. */
  truncated?: boolean;
  /** Rebuilt from the saved session rather than run in this window. */
  restored?: boolean;
  error?: string;
  /** The output went to the agent with a message the user sent. */
  shared?: boolean;
};
