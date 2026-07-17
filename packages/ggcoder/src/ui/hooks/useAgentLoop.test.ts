import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateLoopBreak, ToolCallProgressTracker } from "../../core/loop-breaker.js";
import { shouldRetainThinkingDelta, type AgentLoopOptions } from "./useAgentLoop.js";
import type { Message } from "@kenkaiiii/gg-ai";
import type { TransformContextOptions } from "@kenkaiiii/gg-agent";

describe("useAgentLoop context transforms", () => {
  it("adds missing read coverage to the initial Ideal review turn", () => {
    const source = readFileSync(new URL("./useAgentLoop.ts", import.meta.url), "utf8");

    expect(source).toMatch(
      /withReviewCoverageRequirements\(\s*idealReviewMessage,\s*coverage\.missing\s*\)/,
    );
  });

  it("passes the per-turn tool-result budget to the agent loop", () => {
    const source = readFileSync(new URL("./useAgentLoop.ts", import.meta.url), "utf8");

    expect(source).toMatch(
      /maxTurnToolResultChars:\s*resolveSessionTurnToolResultCharLimit\(\s*options\.model,\s*options\.provider,\s*accountId,?\s*\)/,
    );
  });

  it("accepts authoritative usage and pending messages in the transform contract", async () => {
    const seenOptions: TransformContextOptions[] = [];
    const transformContext: NonNullable<AgentLoopOptions["transformContext"]> = async (
      messages,
      options,
    ) => {
      seenOptions.push(options);
      return messages;
    };
    const messages: Message[] = [{ role: "user", content: "run the tool" }];
    const pendingMessage: Message = { role: "user", content: "steer the active run" };

    const result = await transformContext(messages, {
      usage: { inputTokens: 120, outputTokens: 30, cacheRead: 10, cacheWrite: 5 },
      pendingMessages: [pendingMessage],
    });

    expect(result).toBe(messages);
    expect(seenOptions).toEqual([
      {
        usage: { inputTokens: 120, outputTokens: 30, cacheRead: 10, cacheWrite: 5 },
        pendingMessages: [pendingMessage],
      },
    ]);
  });
});

describe("useAgentLoop thinking display", () => {
  it("does not retain provider reasoning in chat transcript state", () => {
    expect(shouldRetainThinkingDelta()).toBe(false);
  });
});

describe("useAgentLoop loop-break tracking", () => {
  it("does not flag repeated background polling", () => {
    const tracker = new ToolCallProgressTracker();
    let repeatedNoProgressCalls = 0;

    for (let i = 0; i < 5; i++) {
      repeatedNoProgressCalls = tracker.record(
        "task_output",
        { id: "running-job" },
        "Process running\n(no new output)",
        false,
      );
    }

    expect(
      evaluateLoopBreak({
        consecutiveFailures: 0,
        repeatedNoProgressCalls,
        textRepetitionDetected: false,
      }).shouldBreak,
    ).toBe(false);
  });

  it("does not flag successful iterative edits to one file", () => {
    const tracker = new ToolCallProgressTracker();
    let repeatedNoProgressCalls = 0;

    for (let i = 0; i < 6; i++) {
      repeatedNoProgressCalls = tracker.record(
        "edit",
        { file_path: "src/app.ts", old_text: `before-${i}`, new_text: `after-${i}` },
        `diff-${i}`,
        false,
      );
    }

    expect(
      evaluateLoopBreak({
        consecutiveFailures: 0,
        repeatedNoProgressCalls,
        textRepetitionDetected: false,
      }).shouldBreak,
    ).toBe(false);
  });
});
