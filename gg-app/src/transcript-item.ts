import type { PromptSegment, AskUserPrompt } from "./agent";
import type { HookKind } from "./useAgentEvents";
import type { SubAgentLine } from "./SubAgentFeed";
import type { ChatErrorItem } from "./chat-error";

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
  // Structured error (see gg-ai's formatChatError), validated by readChatError:
  // headline and guidance lead, the raw report sits behind details. `reason`
  // picks the recovery; `text` is a legacy fallback for older items.
  | ChatErrorItem
  // Agent self-correction hook notice (ideal review / loop-break / re-grounding),
  // rendered like the TUI: a shimmering tone-colored one-liner.
  | { kind: "hook"; id: number; hook: HookKind; verificationReason?: "recheck" | "check_review" }
  // Images produced by a tool (screenshot / read of an image file).
  | { kind: "images"; id: number; images: TranscriptImage[]; caption?: string }
  // Image generation in progress — a shimmering square placeholder that gets
  // replaced by the final image when the tool result arrives.
  | { kind: "generating_image"; id: number; prompt: string }
  // Plan-mode entry banner (ASCII logo + optional reason).
  | { kind: "plan"; id: number; reason: string }
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
      cancelled?: boolean;
      /** Soft deadline passed: the agent went on; an answer is still delivered late. */
      deferred?: boolean;
    }
  // A task kicked off from the Tasks modal (shown at the top of its session).
  | { kind: "task"; id: number; title: string }
  // Sub-agents delegated in a turn — a live, in-chat feed of each one's tools.
  | { kind: "subagent_group"; id: number; agents: SubAgentLine[]; aborted?: boolean }
  // Context compaction — shimmering "compacting…" while running, then a quiet
  // "compacted · N → M messages" summary when done.
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
  /** data: URL (base64) ready to drop into <img src>. Absent for a resumed
   *  chat's image listed by `ref`, which loads as it's scrolled to. */
  src?: string;
  /** The image's ref, to load its preview by (historyImages.tsx). */
  ref?: string;
  /** Its preview's size, so its box holds its place until it loads. */
  width?: number;
  height?: number;
  /** Source file path, shown as a caption + used as a stable key. */
  path?: string;
}

export let idSeq = 0;

export const nextId = (): number => ++idSeq;
