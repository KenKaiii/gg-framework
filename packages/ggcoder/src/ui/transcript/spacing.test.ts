import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_SPACING_KINDS,
  getTranscriptItemMarginTop,
  isTranscriptSpacingKind,
  shouldSeparateTranscriptItems,
} from "./spacing.js";
import type { CompletedItem } from "../app-items.js";

function itemForKind(kind: CompletedItem["kind"], id: string = kind): CompletedItem {
  switch (kind) {
    case "user":
      return { kind, id, text: "user" };
    case "assistant":
      return { kind, id, text: "assistant" };
    case "ideal_hook":
      return { kind, id, text: "ideal hook" };
    case "queued":
      return { kind, id, text: "queued" };
    case "task":
      return { kind, id, title: "task" };
    case "tool_start":
      return { kind, id, toolCallId: id, name: "read", args: {}, startedAt: 0, animateUntil: 0 };
    case "tool_done":
      return { kind, id, name: "read", args: {}, result: "ok", isError: false, durationMs: 1 };
    case "tool_group":
      return { kind, id, tools: [] };
    case "server_tool_start":
      return {
        kind,
        id,
        serverToolCallId: id,
        name: "web_search",
        input: {},
        startedAt: 0,
        animateUntil: 0,
      };
    case "server_tool_done":
      return {
        kind,
        id,
        name: "web_search",
        input: {},
        resultType: "done",
        data: {},
        durationMs: 1,
      };
    case "subagent_group":
      return { kind, id, agents: [] };
    case "info":
      return { kind, id, text: "info" };
    case "error":
      return { kind, id, headline: "error", message: "message", guidance: "guidance" };
    case "stopped":
      return { kind, id, text: "stopped" };
    case "plan_transition":
      return { kind, id, text: "plan", active: true };
    case "model_transition":
      return { kind, id, modelName: "model" };
    case "theme_transition":
      return { kind, id, themeName: "dark" };
    case "plan_event":
      return { kind, id, event: "approved" };
    case "update_notice":
      return { kind, id, text: "update" };
    case "compacting":
      return { kind, id };
    case "compacted":
      return { kind, id, originalCount: 2, newCount: 1, tokensBefore: 10, tokensAfter: 5 };
    case "duration":
      return { kind, id, durationMs: 1, toolsUsed: [], verb: "Done" };
    case "step_done":
      return { kind, id, stepNum: 1, description: "step" };
    case "style_pack":
      return { kind, id, added: [], showSetupHint: false };
    case "setup_hint":
      return { kind, id };
    case "banner":
      return { kind, id };
    case "session_summary":
      return {
        kind,
        id,
        summary: {
          title: "Summary",
          provider: "anthropic",
          model: "model",
          cwd: "/tmp/project",
          wallDurationMs: 1,
          turns: 1,
          usage: { inputTokens: 1, outputTokens: 1 },
          tools: { totalCalls: 0, totalSuccess: 0, totalFail: 0, totalDurationMs: 0, byName: {} },
          serverToolCalls: 0,
          linesChanged: { added: 0, removed: 0 },
        },
      };
    case "tombstone":
      return { kind, id };
  }
}

describe("transcript spacing", () => {
  it("treats user messages as spaced transcript rows", () => {
    expect(isTranscriptSpacingKind("user")).toBe(true);
  });

  it("keeps every live transcript boundary aligned with the shared spacing contract", () => {
    for (const previousKind of TRANSCRIPT_SPACING_KINDS) {
      for (const currentKind of TRANSCRIPT_SPACING_KINDS) {
        const previous = itemForKind(previousKind, `previous-${previousKind}`);
        const current = itemForKind(currentKind, `current-${currentKind}`);
        const expected =
          currentKind === "plan_transition"
            ? 0
            : shouldSeparateTranscriptItems({ previousKind, currentKind })
              ? 1
              : 0;

        expect(
          getTranscriptItemMarginTop({
            item: current,
            previousLiveItem: previous,
          }),
          `${previousKind}→${currentKind}`,
        ).toBe(expected);
      }
    }
  });

  it("keeps a submitted user message separated after a plan transition", () => {
    const item: CompletedItem = { kind: "user", id: "user", text: "create a new plan" };
    const previous: CompletedItem = {
      kind: "plan_transition",
      id: "plan",
      text: "Plan mode ON",
      active: true,
    };

    expect(
      getTranscriptItemMarginTop({
        item,
        lastHistoryItem: previous,
      }),
    ).toBe(1);
  });

  it("does not add margin when a finalized assistant row replaces streaming after a user", () => {
    const item: CompletedItem = { kind: "assistant", id: "assistant", text: "Done." };
    const previous: CompletedItem = { kind: "user", id: "user", text: "Fix it." };

    expect(
      getTranscriptItemMarginTop({
        item,
        lastPendingHistoryItem: previous,
      }),
    ).toBe(0);
  });

  it("does not make prior assistant rows look padded when the next user row appears", () => {
    const item: CompletedItem = { kind: "user", id: "user", text: "Next prompt." };
    const previous: CompletedItem = {
      kind: "assistant",
      id: "assistant",
      text: "Previous answer.",
    };

    expect(
      getTranscriptItemMarginTop({
        item,
        lastHistoryItem: previous,
      }),
    ).toBe(0);
  });

  it("re-inserts the paragraph gap before a continuation assistant chunk", () => {
    // A response whose earlier paragraphs were flushed mid-stream commits its
    // trailing paragraph with continuation:true. assistant→assistant is
    // otherwise compact, but the original paragraphs were blank-line separated,
    // so the continuation chunk must get a 1-row top margin (and no dot).
    const item: CompletedItem = {
      kind: "assistant",
      id: "assistant-2",
      text: "final paragraph",
      continuation: true,
    };
    const previous: CompletedItem = {
      kind: "assistant",
      id: "assistant-1",
      text: "earlier paragraph",
    };

    expect(
      getTranscriptItemMarginTop({
        item,
        previousLiveItem: previous,
      }),
    ).toBe(1);
  });

  it("separates non-continuation stacked assistant rows with a blank line", () => {
    // Two separate responses (e.g. across tool turns) are distinct messages and
    // need a blank-line gap. Continuation paragraphs of one response are handled
    // earlier via the `continuation` flag and are unaffected.
    const item: CompletedItem = { kind: "assistant", id: "assistant-2", text: "second answer" };
    const previous: CompletedItem = { kind: "assistant", id: "assistant-1", text: "first answer" };

    expect(
      getTranscriptItemMarginTop({
        item,
        previousLiveItem: previous,
      }),
    ).toBe(1);
  });

  it("does not add a top gap to a queued placeholder immediately after its user row", () => {
    const item: CompletedItem = { kind: "queued", id: "queued", text: "Next prompt." };
    const previous: CompletedItem = { kind: "user", id: "user", text: "Next prompt." };

    expect(
      getTranscriptItemMarginTop({
        item,
        lastHistoryItem: previous,
      }),
    ).toBe(0);
  });
});
