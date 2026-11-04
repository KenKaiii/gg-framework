import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import type { AgentDefinition } from "../core/agents.js";
import { getSupportedThinkingLevels } from "../core/thinking-level.js";
import { createSubAgentTool, subAgentDescription } from "./subagent.js";
import {
  MAX_BLOCKING_SUBAGENT_DEPTH,
  SUB_AGENT_DEPTH_ENV,
  SUB_AGENT_TIMEOUT_MS,
} from "./subagent-shared.js";

class MockChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

const owl: AgentDefinition = {
  name: "owl",
  description: "Read-only scout",
  tools: ["read"],
  // Legacy `fast` now behaves exactly like `inherit`.
  model: "fast",
  systemPrompt: "Inspect code and report findings.",
  source: "bundled",
};

// An agent pinned to its own model id is the only way a child leaves the
// parent's model — which is what arms the unavailable-model fallback below.
const pinned: AgentDefinition = {
  name: "pinned",
  description: "Agent pinned to its own model",
  tools: ["read"],
  model: "gpt-6-luna",
  systemPrompt: "Inspect code and report findings.",
  source: "project",
};

function spawnedFlag(flag: string): (string | undefined)[] {
  return spawnMock.mock.calls.map(([, rawArgs]) => {
    const args = rawArgs as string[];
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  });
}

function spawnedModels(): (string | undefined)[] {
  return spawnedFlag("--model");
}

function spawnedCacheKeys(): string[] {
  return spawnMock.mock.calls.map(([, rawArgs]) => {
    const args = rawArgs as string[];
    return args[args.indexOf("--prompt-cache-key") + 1]!;
  });
}

function mockExit(
  stderr: string,
  code: number,
  stdout = "",
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheRead?: number;
    cacheWrite?: number;
  },
): MockChildProcess {
  const child = new MockChildProcess();
  setImmediate(() => {
    if (stdout) child.stdout.write(`${JSON.stringify({ type: "text_delta", text: stdout })}\n`);
    if (usage) child.stdout.write(`${JSON.stringify({ type: "turn_end", usage })}\n`);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code);
  });
  return child;
}

/**
 * A child killed by a signal reports `code === null` and writes no stderr —
 * exactly the shape the desktop hang produced once the parent gave up on it.
 */
function mockSignalDeath(stdout = ""): MockChildProcess {
  const child = new MockChildProcess();
  setImmediate(() => {
    if (stdout) child.stdout.write(`${JSON.stringify({ type: "text_delta", text: stdout })}\n`);
    child.stdout.end();
    child.stderr.end();
  });
  return child;
}

function owlTool() {
  return createSubAgentTool(
    process.cwd(),
    [owl, pinned],
    () => "openai",
    () => "gpt-6.1-sol",
    () => "parent-cache",
    undefined,
    () => "ultra",
  );
}

async function runAgent(agent?: string) {
  return owlTool().execute(
    { ...(agent ? { agent } : {}), task: "Inspect the registry." },
    { signal: new AbortController().signal, toolCallId: "test-call" },
  );
}

async function runOwl() {
  return runAgent("owl");
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe("createSubAgentTool model and thinking routing", () => {
  it.each(["owl", undefined])(
    "runs the %s child on the parent model with inherited Ultra",
    async (agent) => {
      // Blocking and persistent children must use the same inherited effort.
      spawnMock.mockImplementationOnce(() => mockExit("", 0, "done"));

      await runAgent(agent);

      expect(spawnedModels()).toEqual(["gpt-6.1-sol"]);
      expect(spawnedFlag("--thinking")).toEqual(["ultra"]);
    },
  );

  it("respawns with the parent model when a pinned model is unavailable", async () => {
    spawnMock
      .mockImplementationOnce(() =>
        mockExit("OpenAI does not recognize the requested model (not).", 1),
      )
      .mockImplementationOnce(() => mockExit("", 0, "fallback succeeded"));

    await expect(runAgent("pinned")).resolves.toMatchObject({
      content: "fallback succeeded\n\nReceipt (0 calls): no tool calls",
    });
    expect(spawnedModels()).toEqual(["gpt-6-luna", "gpt-6.1-sol"]);
    // The pinned model caps Ultra, but fallback restores the parent selection.
    expect(spawnedFlag("--thinking")).toEqual(["max", "ultra"]);
    expect(spawnedCacheKeys()).toEqual([
      "parent-cache:subagent:gpt-6-luna:pinned",
      "parent-cache:subagent:gpt-6-luna:pinned",
    ]);
  });

  it("reads the current OpenAI selection on every blocking call, including off", async () => {
    let thinking: "high" | undefined = "high";
    const tool = createSubAgentTool(
      process.cwd(),
      [],
      () => "openai",
      () => "gpt-6.1-sol",
      undefined,
      undefined,
      () => thinking,
    );
    spawnMock.mockImplementation(() => mockExit("", 0, "done"));
    await tool.execute(
      { task: "first" },
      { signal: new AbortController().signal, toolCallId: "first" },
    );
    thinking = undefined;
    await tool.execute(
      { task: "second" },
      { signal: new AbortController().signal, toolCallId: "second" },
    );
    expect(spawnedFlag("--thinking")).toEqual(["high", undefined]);
  });

  it("re-resolves the lowest thinking level for the parent model on a retry", async () => {
    // A retired, unregistered model's ladder bottoms out at "high", Opus's at "low": the retry must
    // not carry the pinned model's rung over to the parent model.
    const pinnedLowest = getSupportedThinkingLevels("anthropic", "claude-retired-model")[0];
    const opusLowest = getSupportedThinkingLevels("anthropic", "claude-opus-5-5")[0];
    expect(pinnedLowest).not.toBe(opusLowest);
    spawnMock
      .mockImplementationOnce(() => mockExit("model not found: claude-retired-model", 1))
      .mockImplementationOnce(() => mockExit("", 0, "fallback succeeded"));

    await createSubAgentTool(
      process.cwd(),
      [{ ...pinned, model: "claude-retired-model" }],
      () => "anthropic",
      () => "claude-opus-5-5",
    ).execute(
      { agent: "pinned", task: "Inspect the registry." },
      { signal: new AbortController().signal, toolCallId: "test-call" },
    );

    expect(spawnedModels()).toEqual(["claude-retired-model", "claude-opus-5-5"]);
    expect(spawnedFlag("--thinking")).toEqual([pinnedLowest, opusLowest]);
  });

  it("returns cache reads and writes with the normalized token totals", async () => {
    spawnMock.mockImplementationOnce(() =>
      mockExit("", 0, "done", {
        inputTokens: 10,
        outputTokens: 3,
        cacheRead: 20,
        cacheWrite: 5,
      }),
    );

    await expect(runOwl()).resolves.toMatchObject({
      content: "done\n\nReceipt (0 calls): no tool calls",
      details: {
        tokenUsage: { input: 10, output: 3, cacheRead: 20, cacheWrite: 5 },
      },
    });
  });

  it("does not retry unrelated child failures", async () => {
    spawnMock.mockImplementationOnce(() => mockExit("usage limit reached", 1));

    await expect(runAgent("pinned")).resolves.toMatchObject({
      content: "Sub-agent failed (exit 1): usage limit reached",
    });
    expect(spawnedModels()).toEqual(["gpt-6-luna"]);
  });

  it("does not mistake partial progress text for a successful final answer", async () => {
    // Real failure shape: the model narrates before its first tool call, then
    // the provider rate-limits the next turn and the child exits non-zero. The
    // old collector returned only "I'll start..." as a successful tool result,
    // hiding both the failure and the fact that no review/work was completed.
    spawnMock.mockImplementationOnce(() =>
      mockExit(
        "Rate limited by Anthropic. Wait a moment and try again.",
        1,
        "I'll read both files now.",
      ),
    );

    await expect(runOwl()).resolves.toMatchObject({
      content:
        "Sub-agent failed (exit 1): Rate limited by Anthropic. Wait a moment and try again.\n\n" +
        "Partial output before failure:\nI'll read both files now.\n\n" +
        "Receipt (0 calls): no tool calls",
    });
    expect(spawnedModels()).toEqual(["gpt-6.1-sol"]);
  });

  it("names the timeout instead of reporting a signal death as 'unknown error'", async () => {
    // Regression: every desktop sub-agent hung until the parent killed it, and
    // `close(null)` with empty stderr surfaced as "exit null: unknown error",
    // hiding both the cause and the fact that the child had already answered.
    const child = mockSignalDeath("CLEAR");
    spawnMock.mockImplementationOnce(() => child);
    const pending = runOwl();
    await new Promise((resolve) => setImmediate(resolve));

    child.emit("close", null, "SIGTERM");
    const result = (await pending) as { content: string };

    expect(result.content).not.toContain("unknown error");
    expect(result.content).toContain("SIGTERM");
    // Whatever the child did finish is still handed back for diagnosis.
    expect(result.content).toContain("CLEAR");
  });

  it("names parent cancellation when the caller's signal aborts the child", async () => {
    const child = mockSignalDeath();
    spawnMock.mockImplementationOnce(() => child);
    const controller = new AbortController();
    const pending = owlTool().execute(
      { agent: "owl", task: "Inspect the registry." },
      { signal: controller.signal, toolCallId: "test-call" },
    );
    await new Promise((resolve) => setImmediate(resolve));

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");

    const result = (await pending) as { content: string };
    expect(result.content).toContain("cancelled by the parent");
    expect(result.content).not.toContain("unknown error");
  });

  it("claims a loop timeout ceiling above its own sub-agent budget", () => {
    // The loop's default per-tool timeout is SHORTER than SUB_AGENT_TIMEOUT_MS,
    // so without this override the loop cancelled first and the tool's specific
    // "exceeded its time limit" message could never be produced.
    expect(owlTool().timeoutMs).toBeGreaterThan(SUB_AGENT_TIMEOUT_MS);
  });

  it("keeps the blocking contract while rejecting recursive process storms", async () => {
    const previousDepth = process.env[SUB_AGENT_DEPTH_ENV];
    process.env[SUB_AGENT_DEPTH_ENV] = String(MAX_BLOCKING_SUBAGENT_DEPTH);
    try {
      const tool = createSubAgentTool(
        process.cwd(),
        [owl],
        () => "openai",
        () => "gpt-6.1-sol",
      );
      await expect(
        tool.execute(
          { task: "Recurse again." },
          { signal: new AbortController().signal, toolCallId: "depth-test" },
        ),
      ).resolves.toMatchObject({ content: expect.stringContaining("nesting limit") });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      if (previousDepth === undefined) delete process.env[SUB_AGENT_DEPTH_ENV];
      else process.env[SUB_AGENT_DEPTH_ENV] = previousDepth;
    }
  });
});

describe("createSubAgentTool receipt", () => {
  function mockRun(lines: Array<Record<string, unknown>>, code = 0): MockChildProcess {
    const child = new MockChildProcess();
    setImmediate(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code);
    });
    return child;
  }
  const call = (
    id: string,
    name: string,
    args: Record<string, unknown>,
    result: string,
    isError = false,
  ) => [
    { type: "tool_call_start", toolCallId: id, name, args },
    { type: "tool_call_end", toolCallId: id, result, isError, durationMs: 1 },
  ];

  it("appends an engine-built receipt and flags paths the child never opened", async () => {
    spawnMock.mockImplementationOnce(() =>
      mockRun([
        ...call("1", "read", { file_path: "src/a.ts" }, "x"),
        ...call("2", "read", { file_path: "src/a.ts" }, "x"),
        ...call("3", "bash", { command: "npm test" }, "Exit code: 0\nok"),
        ...call("4", "edit", { file_path: "src/b.ts" }, "ok"),
        {
          type: "text_delta",
          text: "Fixed src/b.ts:3 after reading src/a.ts; src/ghost.ts is fine.",
        },
      ]),
    );
    const result = (await runOwl()) as { content: string };
    expect(result.content).toBe(
      "Fixed src/b.ts:3 after reading src/a.ts; src/ghost.ts is fine.\n\n" +
        "Receipt (4 calls): bash `npm test` → exit 0 · edit src/b.ts ✓ · read src/a.ts ×2\n" +
        "Not opened by this helper: src/ghost.ts",
    );
  });

  it("carries the receipt on a failed child that made tool calls", async () => {
    spawnMock.mockImplementationOnce(() =>
      mockRun([...call("1", "write", { file_path: "out.ts" }, "denied", true)], 1),
    );
    const result = (await runOwl()) as { content: string };
    expect(result.content).toBe(
      "Sub-agent failed (exit 1): unknown error\n\nReceipt (1 call): write out.ts ✗",
    );
  });
});

describe("subAgentDescription", () => {
  const owl = {
    name: "owl",
    description: "Traces call chains",
  } as AgentDefinition;

  it("carries the roster when it is the only delegation tool", () => {
    expect(subAgentDescription([owl], false)).toContain("- owl: Traces call chains");
  });

  it("points at spawn_agent's roster instead of repeating it", () => {
    const text = subAgentDescription([owl], true);
    expect(text).not.toContain("Traces call chains");
    expect(text).toContain("`spawn_agent`");
  });
});
