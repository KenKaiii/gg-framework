import { describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import { createAutopilotRunner, type AutopilotRunnerContext } from "./autopilot-runner.js";
import type { AskUserPrompt } from "../core/ask-user.js";

const prompt: AskUserPrompt = {
  id: "ask-1",
  questions: [{ id: "go", question: "Add the test?", kind: "confirm" }],
};

// A Ken session that replies from a script, one reply per prompt.
function harness(replies: string[]) {
  const ken = {
    messages: [] as Message[],
    prompts: [] as string[],
    concurrent: 0,
    maxConcurrent: 0,
    async prompt(text: string) {
      this.prompts.push(text);
      this.concurrent += 1;
      this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.messages.push({ role: "assistant", content: replies.shift() ?? "" });
      this.concurrent -= 1;
    },
    getMessages() {
      return this.messages;
    },
  };
  const ctx = {
    autopilot: true,
    autopilotReviewing: false,
    autopilotCancelled: false,
    cwd: "/project",
    gitBranch: "main",
    injectedAutopilotPrompts: [] as string[],
    pendingKenAutoModel: null as AutopilotRunnerContext["pendingKenAutoModel"],
    pendingPlanPath: null,
    session: {
      getMessages: () => [{ role: "user", content: "add a regression test" }] as Message[],
      getVerificationEvidence: () => [],
      getVerificationProblem: () => null,
    },
    broadcast: vi.fn(),
    broadcastError: vi.fn(),
    ensureKenAutoSession: async () => ken,
    loadWorkflowCommandSpecs: async () => [],
    syncKenAutoModel: vi.fn(async () => {}),
  };
  const runner = createAutopilotRunner(ctx as unknown as AutopilotRunnerContext);
  return { ctx, ken, runner };
}

describe("answerAskWithKen", () => {
  it("prompts Ken with the question and parses his answer", async () => {
    const { ctx, ken, runner } = harness(['ANSWER\n{"go":"yes"}']);
    const reviewing: boolean[] = [];
    ctx.ensureKenAutoSession = async () => {
      reviewing.push(ctx.autopilotReviewing);
      return ken;
    };
    expect(await runner.answerAskWithKen(prompt, () => true)).toEqual({
      kind: "answer",
      answers: { go: "yes" },
    });
    expect(ken.prompts[0]).toContain("## Question for you");
    expect(ken.prompts[0]).toContain("add a regression test");
    expect(reviewing).toEqual([true]);
    expect(ctx.autopilotReviewing).toBe(false);
  });

  it("answers one card at a time and reviews wait for an answer in flight", async () => {
    const { ctx, ken, runner } = harness([
      'ANSWER {"go":"yes"}',
      "HUMAN\nDestructive.",
      "ALL_CLEAR",
    ]);
    const second = { ...prompt, id: "ask-2" };
    const [a, b, review] = await Promise.all([
      runner.answerAskWithKen(prompt, () => true),
      runner.answerAskWithKen(second, () => true),
      runner.runAutopilotReview("add a regression test"),
    ]);
    expect(ken.maxConcurrent).toBe(1);
    expect(a).toMatchObject({ kind: "answer" });
    expect(b).toEqual({ kind: "human", reason: "Destructive." });
    expect(review).toEqual({ kind: "all_clear" });
    expect(ctx.broadcastError).not.toHaveBeenCalled();
  });

  it("skips a card that is no longer pending and applies a model switch afterwards", async () => {
    const { ctx, ken, runner } = harness(['ANSWER {"go":"no"}']);
    expect(await runner.answerAskWithKen(prompt, () => false)).toBeNull();
    expect(ken.prompts).toHaveLength(0);

    ctx.ensureKenAutoSession = async () => {
      ctx.pendingKenAutoModel = { provider: "anthropic", model: "m" };
      return ken;
    };
    await runner.answerAskWithKen(prompt, () => true);
    expect(ctx.syncKenAutoModel).toHaveBeenCalledWith("anthropic", "m");
  });
});
