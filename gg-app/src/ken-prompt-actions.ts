export const KEN_PROMPT_TITLE_MAX_LENGTH = 80;
export const KEN_PROMPT_FALLBACK_TITLE = "Saved Ken prompt";

export interface KenPromptSaveDestination {
  phaseId: string;
  title: string;
  sourcePrompt: string;
}

export interface KenPromptSavePreview {
  prompt: string;
  suggestedTitle: string;
  destinations: KenPromptSaveDestination[];
}

export type KenPromptSaveTarget =
  | { kind: "new-draft"; title: string }
  | {
      kind: "existing-phase";
      phaseId: string;
      title: string;
      expectedSourcePrompt: string;
    };

export type KenPromptAction =
  | { type: "send-current"; prompt: string }
  | { type: "send-fresh"; prompt: string }
  | { type: "prepare-save"; prompt: string }
  | { type: "commit-save"; prompt: string; target: KenPromptSaveTarget };

export type KenPromptActionResult =
  | { status: "sent"; session: "current" | "fresh" }
  | { status: "preview"; preview: KenPromptSavePreview }
  | { status: "saved"; phaseId: string; title: string }
  | {
      status: "failed";
      action: KenPromptAction["type"];
      message: string;
      recoverPrompt?: string;
    };

export interface KenPromptActionDispatcher {
  dispatch(action: KenPromptAction): Promise<KenPromptActionResult>;
  blockedReason?(action: KenPromptAction["type"]): string | null;
}

/** Normalize a fenced prompt exactly once before it crosses an action boundary. */
export function normalizeKenPrompt(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

/** Derive a stable Notes draft title from the first meaningful prompt line. */
export function deriveKenPromptTitle(value: string): string {
  const firstMeaningfulLine = normalizeKenPrompt(value)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstMeaningfulLine) return KEN_PROMPT_FALLBACK_TITLE;

  const withoutMarkdownPrefix = firstMeaningfulLine
    .replace(/^(?:#{1,6}|[-*+] |\d+[.)] )\s*/, "")
    .replace(/^\[.\]\s*/, "")
    .trim();
  const compact = (withoutMarkdownPrefix || firstMeaningfulLine).replace(/\s+/g, " ");
  if (compact.length <= KEN_PROMPT_TITLE_MAX_LENGTH) return compact;

  const bounded = compact.slice(0, KEN_PROMPT_TITLE_MAX_LENGTH + 1);
  const lastSpace = bounded.lastIndexOf(" ");
  return bounded.slice(0, lastSpace >= 40 ? lastSpace : KEN_PROMPT_TITLE_MAX_LENGTH).trimEnd();
}
