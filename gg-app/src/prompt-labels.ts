/**
 * App-button prompts: free-text instructions sent to the agent by UI buttons
 * (e.g. "Initialize Git"), shown live as a friendly shimmer chip via a `label`
 * while the full prompt goes to the agent.
 *
 * The label is a webview-only display string — it isn't persisted, so on resume
 * the raw expanded prompt would render instead of the chip. Each entry pairs the
 * stable opening of a prompt with its chip label so `recoverPromptLabel` can map
 * a restored history message back to the same chip the user saw live.
 *
 * Slash commands (`/commit`, `.gg/commands/*.md`) are handled separately by the
 * sidecar (it recovers `/name` from the expanded body); this registry only
 * covers app buttons that build free-text prompts with a webview label.
 */
import { INTRODUCE_LABEL, INTRODUCE_PREFIX } from "./kleio/introduce";

interface AppPromptLabel {
  /** Stable opening of the prompt body (dynamic args follow it). */
  prefix: string;
  /** Friendly shimmer chip shown in the transcript. */
  label: string;
}

const APP_PROMPT_LABELS: readonly AppPromptLabel[] = [
  {
    prefix: "Initialize git for this project and publish it to GitHub.",
    label: "Initializing Git\u2026",
  },
  // kleio: Setup's Brain card starts a chat with this (kleio/introduce.ts).
  { prefix: INTRODUCE_PREFIX, label: INTRODUCE_LABEL },
];

/**
 * Recover an app-button prompt's chip label from a restored message body.
 * Returns null for ordinary messages so the raw text renders as-is.
 */
export function recoverPromptLabel(text: string): string | null {
  const t = text.trimStart();
  // Checklist labels contain the item's title. Match the generated opening,
  // not an ordinary user-authored Markdown heading. Recovering from the body
  // also fixes sessions saved before checklist labels were restored.
  const checklistTitle = t
    .match(
      /^# Checklist: ([^\r\n]{1,200})\r?\n\r?\nCheck this project for one item of its health checklist and report in plain words\./,
    )?.[1]
    ?.trim();
  if (checklistTitle) return `Checking ${checklistTitle}`;
  for (const entry of APP_PROMPT_LABELS) {
    if (t.startsWith(entry.prefix)) return entry.label;
  }
  return null;
}
