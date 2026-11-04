/**
 * Plan-step compaction must fire DURING the approved-plan run. `/plan/accept`
 * starts a fresh session with ONE "implement it now" prompt, so the whole plan
 * executes as a single agent run: a cost rule evaluated only after the run ends
 * would only ever see the last `[DONE:n]`, when compacting can save nothing.
 *
 * These tests drive a real AgentSession + the real agent loop + real tools
 * with a scripted provider stream; only the LLM summarizer inside compact() is
 * stubbed.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  stream,
  StreamResult,
  type Message,
  type StreamEvent,
  type StreamOptions,
  type StreamResponse,
} from "@kleio/ai";
import type * as CompactorModule from "./compaction/compactor.js";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";

vi.mock("@kleio/ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stream: vi.fn(),
}));

const compactMock = vi.hoisted(() => vi.fn());
vi.mock("./compaction/compactor.js", async () => {
  const actual = await vi.importActual<typeof CompactorModule>("./compaction/compactor.js");
  return { ...actual, compact: compactMock };
});

vi.mock("./mcp/index.js", async () => {
  const actual = await vi.importActual<typeof McpModule>("./mcp/index.js");
  return {
    ...actual,
    MCPClientManager: vi.fn(function MCPClientManagerMock() {
      return { connectAll: vi.fn(async () => []), dispose: vi.fn(async () => {}) };
    }),
  };
});

const SUMMARY = "[session compacted] Summary: step 1 done; parser module added.";

interface ScriptedTurn {
  text: string;
  /** Provider-reported prompt size for this request. */
  inputTokens: number;
  /** When set, the model asks to read this file (another tool-loop turn). */
  readFile?: string;
}

interface PlanStepInternals {
  planStepState: { doneSteps: Set<number>; compactions: number };
}

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;
let planPath: string;
/** Messages each provider request was sent, in order. */
let requests: Message[][];
/** History handed to each compaction, copied at call time (the loop reuses the array). */
let compactedHistories: Message[][];
/** Prompt tokens the stubbed summarizer removes, so later usage reflects the shrink. */
const SHRUNK_TOKENS = 55_000;

function scriptStream(turns: ScriptedTurn[]): void {
  let call = 0;
  vi.mocked(stream).mockImplementation((options: StreamOptions) => {
    requests.push(structuredClone(options.messages));
    const turn = turns[call++] ?? { text: "Done.", inputTokens: 1_000 };
    const compacted = JSON.stringify(options.messages).includes(SUMMARY);
    const inputTokens = compacted ? turn.inputTokens - SHRUNK_TOKENS : turn.inputTokens;
    const content: Extract<Message, { role: "assistant" }>["content"] = [
      { type: "text", text: turn.text },
      ...(turn.readFile
        ? [
            {
              type: "tool_call" as const,
              id: `call-${call}`,
              name: "read",
              args: { file_path: turn.readFile },
            },
          ]
        : []),
    ];
    return new StreamResult(
      (async function* (): AsyncGenerator<StreamEvent, StreamResponse> {
        yield { type: "text_delta", text: turn.text };
        return {
          message: { role: "assistant", content },
          stopReason: turn.readFile ? "tool_use" : "end_turn",
          usage: { inputTokens, outputTokens: 200 },
        };
      })(),
    );
  });
}

/** One run of an approved 4-step plan: step 1 ends on request 3, step 2 on request 5. */
function planRun(tokens: readonly number[]): ScriptedTurn[] {
  const texts = [
    "Starting step 1.",
    "Still on step 1.",
    "[DONE:1] Moving to step 2.",
    "Working on step 2.",
    "[DONE:2] Moving to step 3.",
  ];
  return [
    ...texts.map((text, i) => ({ text, inputTokens: tokens[i] ?? 1_000, readFile: "notes.md" })),
    { text: "[DONE:3] [DONE:4] All steps complete.", inputTokens: tokens[5] ?? 1_000 },
  ];
}

async function runApprovedPlan(): Promise<{ internals: PlanStepInternals }> {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "openai",
    model: "gpt-6.1-sol",
    cwd: tmpProject,
    systemPrompt: "test system prompt",
    transient: true,
    selfCorrectionHooks: false,
  });
  await session.initialize();
  await session.setApprovedPlan(planPath);
  await session.prompt("Implement the approved plan now.");
  await session.dispose();
  return { internals: session as unknown as PlanStepInternals };
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "plan-step-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "plan-step-project-"));
  restoreHome = useFakeHome(tmpHome);
  requests = [];
  compactedHistories = [];
  compactMock.mockReset();
  compactMock.mockImplementation(async (messages: Message[]) => {
    compactedHistories.push(structuredClone(messages));
    return {
      // Keep the system prompt and the newest tool exchange, as the real
      // compactor keeps a recent tail.
      messages: [messages[0], { role: "user", content: SUMMARY }, ...messages.slice(-2)],
      result: {
        compacted: true,
        originalCount: messages.length,
        newCount: 4,
        tokensBeforeEstimate: 60_000,
        tokensAfterEstimate: 2_000,
      },
    };
  });

  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      openai: {
        accessToken: "test-openai-token",
        refreshToken: "test-openai-refresh",
        expiresAt: Date.now() + 3_600_000,
        accountId: "chatgpt-account",
      },
    }),
  );
  await fs.writeFile(
    path.join(tmpHome, ".gg", "settings.json"),
    JSON.stringify({ autoCompact: true, idealReviewEnabled: false }),
  );
  await fs.writeFile(path.join(tmpProject, "notes.md"), "# Notes\nparser lives in src/parser.ts\n");
  planPath = path.join(tmpProject, "approved-plan.md");
  await fs.writeFile(
    planPath,
    [
      "# Plan",
      "",
      "## Steps",
      "",
      "1. Add the parser module",
      "2. Wire the parser into the CLI",
      "3. Write tests for the parser",
      "4. Document the parser flags",
      "",
    ].join("\n"),
  );
});

afterEach(async () => {
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("plan-step compaction inside one approved-plan run", () => {
  it("compacts mid-run at the step boundary when the cost rule says it pays", async () => {
    // Sol over ChatGPT OAuth: 272K window, size trigger at 231,200 — never reached here.
    scriptStream(planRun([20_000, 40_000, 60_000, 70_000, 80_000, 90_000]));

    const { internals } = await runApprovedPlan();

    expect(compactMock).toHaveBeenCalledTimes(1);
    const assistantTexts = (compactedHistories[0] ?? [])
      .filter((m) => m.role === "assistant")
      .map((m) => JSON.stringify(m.content));
    // Fired right after step 1 completed — before step 2's work was requested.
    expect(assistantTexts.at(-1)).toContain("[DONE:1]");
    expect(assistantTexts.join("\n")).not.toContain("Working on step 2.");
    // The remaining requests of the SAME run were sent the compacted context.
    expect(requests).toHaveLength(6);
    expect(JSON.stringify(requests[2])).not.toContain(SUMMARY);
    expect(JSON.stringify(requests[3])).toContain(SUMMARY);
    expect(JSON.stringify(requests[5])).toContain(SUMMARY);
    // Mid-run and post-turn observation never double-count steps or requests.
    expect([...internals.planStepState.doneSteps].sort()).toEqual([1, 2, 3, 4]);
    expect(internals.planStepState.compactions).toBe(1);
  });

  it("does not compact when the context is too small for a shrink to pay", async () => {
    scriptStream(planRun([2_000, 3_000, 4_000, 5_000, 6_000, 7_000]));

    const { internals } = await runApprovedPlan();

    expect(compactMock).not.toHaveBeenCalled();
    expect(requests).toHaveLength(6);
    for (const request of requests) expect(JSON.stringify(request)).not.toContain(SUMMARY);
    expect([...internals.planStepState.doneSteps].sort()).toEqual([1, 2, 3, 4]);
    expect(internals.planStepState.compactions).toBe(0);
  });
});
