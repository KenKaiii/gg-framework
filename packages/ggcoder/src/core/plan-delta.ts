import type { Message } from "@kenkaiiii/gg-ai";
import { renderApprovedPlanSection, renderPlanModeSection } from "../system-prompt.js";

/**
 * Plan-mode state changes mid-conversation without re-rendering the cached
 * system prompt.
 *
 * The Plan Mode / Approved Plan sections sit inside the cached prefix, so
 * rebuilding the prompt on every toggle or approval re-sent the whole history
 * uncached (30–80k tokens each). Once a conversation exists, the change is
 * instead appended as one hidden message — the same pattern as env-delta.ts.
 * Tool restrictions never depended on the prompt: they read the shared plan
 * mode ref, so they apply immediately either way.
 */
export interface PlanPromptState {
  planMode: boolean;
  approvedPlanPath: string | undefined;
}

export function samePlanState(a: PlanPromptState, b: PlanPromptState): boolean {
  return a.planMode === b.planMode && a.approvedPlanPath === b.approvedPlanPath;
}

/**
 * A self-contained statement of the CURRENT plan state, or null when it matches
 * what the model already knows (`known`). Self-contained so the latest notice
 * alone is correct even after earlier notices were compacted away.
 */
export async function buildPlanStateMessage(
  known: PlanPromptState,
  current: PlanPromptState,
): Promise<Message | null> {
  if (samePlanState(known, current)) return null;
  const parts: string[] = [];
  if (current.planMode) {
    parts.push(renderPlanModeSection());
  } else {
    parts.push(
      "## Plan Mode (OFF)\n\nPlan mode has ended: ignore any earlier Plan Mode instructions; normal edits and tools are allowed again.",
    );
  }
  const approved = await renderApprovedPlanSection(current.approvedPlanPath);
  if (approved) {
    parts.push(approved);
  } else if (known.approvedPlanPath) {
    parts.push("## Approved Plan\n\nThe previously approved plan no longer applies.");
  }
  return {
    role: "user",
    provenance: { source: "runtime", kind: "notification", visibility: "hidden" },
    content:
      "Plan state update. These instructions changed after your system prompt was written and " +
      "supersede it and any earlier plan update:\n\n" +
      parts.join("\n\n") +
      "\n\nDo not restate this note; just proceed.",
  };
}
