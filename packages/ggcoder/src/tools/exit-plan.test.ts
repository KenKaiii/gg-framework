import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentLoop, type AgentEvent, type ToolExecuteResult } from "@kleio/agent";
import { stream, StreamResult, type Message, type StreamResponse } from "@kleio/ai";
import { createExitPlanTool } from "./exit-plan.js";
import { shouldStartAutopilotCycle } from "../core/autopilot-gate.js";
import { driveAutopilotCycle } from "../core/autopilot-cycle.js";

vi.mock("@kleio/ai", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@kleio/ai")>();
  return { ...actual, stream: vi.fn() };
});

function responseStream(response: StreamResponse): StreamResult {
  return new StreamResult(
    (async function* () {
      yield* [];
      return response;
    })(),
  );
}

const context = () => ({ signal: new AbortController().signal, toolCallId: "exit-plan-test" });

function asText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result) {
    const c = (result as { content: unknown }).content;
    if (typeof c === "string") return c;
  }
  return String(result);
}

describe("createExitPlanTool", () => {
  let cwd: string;
  let plansDir: string;

  beforeEach(async () => {
    vi.mocked(stream).mockReset();
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "exit-plan-test-"));
    plansDir = path.join(cwd, ".gg", "plans");
    await fs.mkdir(plansDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("passes a valid plan with a ## Steps section through to onExitPlan", async () => {
    const planPath = path.join(plansDir, "plan.md");
    await fs.writeFile(
      planPath,
      "# My Plan\n\nContext here.\n\n## Steps\n\n1. Implement the feature in src/a.ts\n2. Add tests for the feature\n",
    );
    const onExitPlan = vi.fn().mockResolvedValue("Plan submitted.");
    const tool = createExitPlanTool(cwd, onExitPlan);

    const result = await tool.execute({ plan_path: ".gg/plans/plan.md" }, context());

    expect(asText(result)).toBe("Plan submitted.");
    expect(onExitPlan).toHaveBeenCalledWith(planPath);
  });

  it.each([false, true])(
    "ends the research run and waits for review (autopilot=%s)",
    async (autopilot) => {
      await fs.writeFile(path.join(plansDir, "plan.md"), "# Plan\n\n## Steps\n\n1. Add tests\n");
      let pendingPlan = false;
      const onExitPlan = vi.fn(async (): Promise<string> => {
        pendingPlan = true;
        return "Plan submitted. Wait for approval.";
      });
      const usage = { inputTokens: 100, outputTokens: 10 };
      vi.mocked(stream)
        .mockImplementationOnce(() =>
          responseStream({
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_call",
                  id: "submit",
                  name: "exit_plan",
                  args: { plan_path: ".gg/plans/plan.md" },
                },
              ],
            },
            stopReason: "tool_use",
            usage,
          }),
        )
        // Replay the session failure: the model obeys "wait" and sends no text.
        .mockImplementation(() =>
          responseStream({
            message: { role: "assistant", content: [] },
            stopReason: "end_turn",
            usage,
          }),
        );
      const messages: Message[] = [{ role: "user", content: "Submit the plan for review." }];
      const events: AgentEvent[] = [];

      for await (const event of agentLoop(messages, {
        provider: "openai",
        model: "test",
        tools: [createExitPlanTool(cwd, onExitPlan)],
      })) {
        events.push(event);
      }

      expect(onExitPlan).toHaveBeenCalledOnce();
      expect(events.filter((event) => event.type === "truncated")).toEqual([]);
      expect(events.filter((event) => event.type === "retry")).toEqual([]);
      expect(stream).toHaveBeenCalledOnce();
      expect(events.at(-1)).toMatchObject({ type: "agent_done", totalTurns: 1 });
      expect(messages.at(-1)).toMatchObject({
        role: "tool",
        content: [{ toolCallId: "submit", content: "Plan submitted. Wait for approval." }],
      });
      expect(pendingPlan).toBe(true);

      // Exercise the same post-run gate/cycle used by the desktop. Submission
      // alone must never implement; only the chosen reviewer may approve it.
      const gate = shouldStartAutopilotCycle({
        enabled: autopilot,
        cancelled: false,
        planMode: false,
        planPending: pendingPlan,
        workflowCommand: false,
        assistantMessagesAdded: 1,
      });
      expect(gate).toEqual(
        autopilot ? { start: true, kind: "plan" } : { start: false, reason: "disabled" },
      );
      const reviewPlan = vi.fn(async () => ({ kind: "all_clear" as const }));
      const acceptPlan = vi.fn(async (): Promise<boolean> => {
        pendingPlan = false;
        return true;
      });
      const runImplement = vi.fn(async (): Promise<void> => {
        expect(pendingPlan).toBe(false);
        vi.mocked(stream).mockImplementation(() =>
          responseStream({
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Implementation complete." }],
            },
            stopReason: "end_turn",
            usage,
          }),
        );
        const approvedMessages: Message[] = [
          { role: "user", content: "The plan has been approved. Implement it now." },
        ];
        for await (const event of agentLoop(approvedMessages, {
          provider: "openai",
          model: "test",
          tools: [createExitPlanTool(cwd, onExitPlan)],
        })) {
          expect(event.type).not.toBe("truncated");
        }
        expect(approvedMessages.at(-1)).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: "Implementation complete." }],
        });
      });
      if (gate.start) {
        await driveAutopilotCycle({
          maxRounds: 2,
          isCancelled: () => false,
          verificationProblem: () => null,
          isPlanMode: () => false,
          planPending: () => pendingPlan,
          resetReviewer: async (): Promise<void> => {},
          reviewPlan,
          acceptPlan,
          runImplement,
          review: async () => ({ kind: "all_clear" as const }),
          runPrompt: vi.fn(),
          onInjected: vi.fn(),
          emit: vi.fn(),
        });
      } else {
        expect(reviewPlan).not.toHaveBeenCalled();
        expect(acceptPlan).not.toHaveBeenCalled();
        expect(runImplement).not.toHaveBeenCalled();
        // Manual Accept starts a fresh implementation run, not a continuation
        // of the now-finished research run.
        await acceptPlan();
        await runImplement();
      }
      expect(reviewPlan).toHaveBeenCalledTimes(autopilot ? 1 : 0);
      expect(acceptPlan).toHaveBeenCalledOnce();
      expect(runImplement).toHaveBeenCalledOnce();
      expect(stream).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["inline approval", "invalid plan"])("continues the loop after %s", async (outcome) => {
    await fs.writeFile(
      path.join(plansDir, "plan.md"),
      outcome === "invalid plan"
        ? "# Plan\n\nNo steps yet."
        : "# Plan\n\n## Steps\n\n1. Add tests\n",
    );
    const onExitPlan = vi.fn(async (): Promise<ToolExecuteResult> => ({
      content: "Plan approved. Proceed with implementation.",
      endRun: false,
    }));
    const usage = { inputTokens: 100, outputTokens: 10 };
    vi.mocked(stream)
      .mockImplementationOnce(() =>
        responseStream({
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_call",
                id: "submit",
                name: "exit_plan",
                args: { plan_path: ".gg/plans/plan.md" },
              },
            ],
          },
          stopReason: "tool_use",
          usage,
        }),
      )
      .mockImplementationOnce(() =>
        responseStream({
          message: { role: "assistant", content: [{ type: "text", text: "Continuing." }] },
          stopReason: "end_turn",
          usage,
        }),
      );
    const events: AgentEvent[] = [];
    for await (const event of agentLoop([{ role: "user", content: "Review the plan." }], {
      provider: "openai",
      model: "test",
      tools: [createExitPlanTool(cwd, onExitPlan)],
    }))
      events.push(event);

    expect(onExitPlan).toHaveBeenCalledTimes(outcome === "invalid plan" ? 0 : 1);
    expect(stream).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: "agent_done", totalTurns: 2 });
  });

  it("rejects a step-less plan with the remediation message and never calls onExitPlan", async () => {
    await fs.writeFile(
      path.join(plansDir, "plan.md"),
      "# My Plan\n\nJust prose describing the approach with no step section.\n",
    );
    const onExitPlan = vi.fn();
    const tool = createExitPlanTool(cwd, onExitPlan);

    const result = await tool.execute({ plan_path: ".gg/plans/plan.md" }, context());

    expect(asText(result)).toContain("Plan rejected: no '## Steps' section");
    expect(asText(result)).toContain("call exit_plan again");
    expect(onExitPlan).not.toHaveBeenCalled();
  });

  it("rejects a plan whose ## Steps section has only prose bullets", async () => {
    await fs.writeFile(
      path.join(plansDir, "plan.md"),
      "# My Plan\n\n## Steps\n\n- do the first thing\n- do the second thing\n",
    );
    const onExitPlan = vi.fn();
    const tool = createExitPlanTool(cwd, onExitPlan);

    const result = await tool.execute({ plan_path: ".gg/plans/plan.md" }, context());

    expect(asText(result)).toContain("Plan rejected");
    expect(onExitPlan).not.toHaveBeenCalled();
  });

  it("rejects an empty plan file", async () => {
    await fs.writeFile(path.join(plansDir, "plan.md"), "   \n");
    const onExitPlan = vi.fn();
    const tool = createExitPlanTool(cwd, onExitPlan);

    const result = await tool.execute({ plan_path: ".gg/plans/plan.md" }, context());

    expect(asText(result)).toContain("Plan file is empty");
    expect(onExitPlan).not.toHaveBeenCalled();
  });

  it("still rejects paths outside .gg/plans/", async () => {
    const onExitPlan = vi.fn();
    const tool = createExitPlanTool(cwd, onExitPlan);

    for (const bad of ["plan.md", "../plan.md", ".gg/plans/../../etc/passwd"]) {
      const result = await tool.execute({ plan_path: bad }, context());
      expect(asText(result)).toContain("must be under .gg/plans/");
    }
    expect(onExitPlan).not.toHaveBeenCalled();
  });
});
