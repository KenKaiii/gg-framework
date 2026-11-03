import type { ToolDetail } from "../core/session-export.js";

// ── History reconstruction types ──────────────────────────
// Mirrors HistoryEntry in gg-app/src/agent.ts — the wire shape the webview
// receives from GET /history. Fields beyond role/text carry the transcript
// item kinds that are reconstructed from persisted session data.
export interface HistoryEntryForWire {
  role: "user" | "assistant";
  text: string;
  images?: string[];
  hook?: "ideal" | "loop_break" | "regrounding" | null;
  command?: boolean;
  compacted?: boolean;
  /** Persisted counts for a compacted row's "N → M messages" summary. */
  compactionCounts?: { originalCount: number; newCount: number };
  /** True when this entry is a Ken Kai (mentor) turn: a `user` row is the `@Ken`
   *  question, an `assistant` row is Ken's reply. The webview renders these in
   *  Ken's color (user bubble tinted; assistant as a Ken bubble). */
  ken?: boolean;
  /** Present when this entry is a persisted autopilot verdict marker (an
   *  `assistant` row with empty `text`). The webview renders it exactly like
   *  the live `autopilot` item — never the raw verdict keyword the model
   *  actually replied with (e.g. `ALL_CLEAR`). */
  autopilot?: {
    phase: "prompted" | "done" | "human" | "capped" | "plan_approved";
    reason?: string;
    body?: string;
    /** Stable seed derived from persisted marker data for deterministic all-clear copy. */
    copySeed?: string;
  };
  /** True when this user prompt came from a Ken "Send to GG Coder" button —
   *  the webview renders the shimmering label instead of the prompt body. */
  kenSent?: boolean;
  /** Enhancer highlight segments for this user prompt (unedited enhanced sends). */
  enhancements?: unknown[];
  /** Plan-mode entry banner (ASCII logo + reason), persisted at plan_enter. */
  plan?: { reason: string };
  /** Task header row (task title), persisted at task_start. */
  task?: { title: string };
  /** Error row (headline/message/guidance), persisted by broadcastError.
   *  `scope` selects the live prefix (ken_error → "Ken: ", autopilot_error →
   *  "Autopilot: "). */
  error?: { scope: string; headline: string; message?: string; guidance?: string };
  /** Webview-copy info row marker (e.g. the video-capability warning). */
  infoKind?: "video_warning";
  // Each image's preview (`src`), or with `?images=refs` its ref and its
  // preview's size, for the app to load as it's scrolled to.
  toolImages?: Array<
    { src: string; path?: string } | { ref: string; width?: number; height?: number; path?: string }
  >;
  subagentGroup?: Array<{
    agentName?: string;
    status: "done" | "error";
    toolUseCount: number;
  }>;
}

/**
 * Detect whether a restored user message is actually an injected self-correction
 * hook prompt, by its distinctive opening phrase. Returns the hook kind so the
 * webview can render the short notice line instead of the full prompt body.
 */
/** `?tools=` on /export. Anything unrecognised (including absent) falls back to
 *  the human-facing `summary` default rather than dumping every payload. */
export function parseToolDetail(value: string | null): ToolDetail {
  return value === "none" || value === "full" ? value : "summary";
}

export function detectHookKind(text: string): "ideal" | "loop_break" | "regrounding" | null {
  const t = text.trimStart();
  if (t.startsWith("Ideal? Review the actual work")) return "ideal";
  if (t.startsWith("Stuck? You've repeated essentially")) return "loop_break";
  if (t.startsWith("Re-ground. The conversation was just compacted")) return "regrounding";
  return null;
}
