import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SidecarEvent } from "./agent";
import type { Item } from "./App";
import { readChatError } from "./chat-error";

/**
 * Autopilot Ken (auto-reviewer) event handling, extracted from App.tsx and
 * modeled on useKenMentor.
 *
 * When autopilot is on, Ken silently reviews each finished GG Coder turn and the
 * sidecar drives a review→prompt→review loop. Ken never streams a chat bubble
 * here; instead the loop emits a small `autopilot_*` event family that this hook
 * turns into compact Ken-tinted transcript markers, plus an `autopilotReviewing`
 * flag for a "Ken reviewing…" spinner.
 *
 * Like useKenMentor, the hook owns no transcript array — it appends markers via
 * the App's shared `setItems` and mints ids with the App's `nextId`.
 */
export interface Autopilot {
  /** True while Ken is mid auto-review (drives the "Ken reviewing…" spinner). */
  autopilotReviewing: boolean;
  /**
   * Handle one `autopilot_*` SSE event. Returns true when the event belonged to
   * autopilot and was consumed, so the caller can early-return; false otherwise.
   */
  handleAutopilotEvent: (e: SidecarEvent) => boolean;
}

export function useAutopilot(opts: {
  setItems: Dispatch<SetStateAction<Item[]>>;
  nextId: () => number;
}): Autopilot {
  const { setItems, nextId } = opts;
  const [autopilotReviewing, setAutopilotReviewing] = useState(false);

  const pushMarker = useCallback(
    (
      phase: "prompted" | "done" | "human" | "capped",
      extra?: { reason?: string; body?: string; copySeed?: string },
    ) => {
      setItems((prev) => [
        ...prev,
        {
          kind: "autopilot",
          id: nextId(),
          phase,
          reason: extra?.reason,
          body: extra?.body,
          copySeed: extra?.copySeed,
        },
      ]);
    },
    [setItems, nextId],
  );

  const handleAutopilotEvent = useCallback(
    (e: SidecarEvent): boolean => {
      const d = e.data as Record<string, unknown>;
      switch (e.type) {
        case "autopilot_review_start":
          setAutopilotReviewing(true);
          return true;
        case "autopilot_prompted":
          // A review round decided GG Coder needs another pass. The spinner ends
          // here; the injected build run takes over as the live activity.
          setAutopilotReviewing(false);
          pushMarker("prompted", {
            body: typeof d.body === "string" ? d.body : undefined,
          });
          // Let useAgentEvents also see the frame so it can close a stale plan
          // modal when this prompt is Ken's plan-revision feedback.
          return false;
        case "autopilot_done":
          setAutopilotReviewing(false);
          // copySeed mirrors the persisted marker's seed so the live all-clear
          // wording is the SAME line a resumed session shows.
          pushMarker("done", {
            copySeed: typeof d.copySeed === "string" ? d.copySeed : undefined,
            reason: typeof d.reason === "string" ? d.reason : undefined,
          });
          return true;
        case "autopilot_ignored":
          // Nothing worth reviewing (small talk, a mechanical git op, etc.) —
          // stop the spinner and add NOTHING to the transcript. No marker, no
          // "all clear", zilch.
          setAutopilotReviewing(false);
          return true;
        case "autopilot_human":
          setAutopilotReviewing(false);
          pushMarker("human", {
            reason: typeof d.reason === "string" ? d.reason : undefined,
          });
          return true;
        case "autopilot_capped":
          setAutopilotReviewing(false);
          pushMarker("capped");
          return true;
        // Ken approved a submitted plan. The plan state (modal, step-count
        // seeding, the plan_approved marker) lives in useAgentEvents, so only
        // stop the spinner here and return false so the main handler still
        // processes the frame — same peek-and-pass-through as run_end below.
        case "autopilot_plan_accepted":
          setAutopilotReviewing(false);
          return false;
        // Not an autopilot event, but a cancel settles the build run WITHOUT a
        // terminal autopilot frame (AgentSession swallows the abort, so the
        // in-flight review just returns). Peek at a cancelled run_end to clear a
        // stuck "Ken reviewing…" spinner, then return false so the build handler
        // still processes run_end normally.
        case "run_end":
          if (d.cancelled === true) setAutopilotReviewing(false);
          return false;
        case "autopilot_error": {
          setAutopilotReviewing(false);
          setItems((prev) => [
            ...prev,
            { kind: "error", id: nextId(), ...readChatError(d, "autopilot_error") },
          ]);
          return true;
        }
        default:
          return false;
      }
    },
    [pushMarker, setItems, nextId],
  );

  return { autopilotReviewing, handleAutopilotEvent };
}
