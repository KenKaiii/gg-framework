import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GGAIError, type Message } from "@kleio/ai";
import type * as GgAgentModule from "@kleio/agent";
import type * as McpModule from "../core/mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";

/**
 * A sub-agent whose agent loop stops on an error must come back as FAILED.
 *
 * The loop ends some runs by emitting `error` and then returning normally
 * (three identical invalid tool calls, a stalled provider, a tool call that
 * never closes). Both sub-agent hosts used to treat the resolved prompt as
 * success, so the parent received the child's mid-task narration ("Let me
 * re-read key sections…") as its final report, and the durable turn record
 * said "completed".
 */

const agentLoopMock = vi.hoisted(() => vi.fn());

vi.mock("@kleio/agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kleio/agent");
  return { ...actual, agentLoop: agentLoopMock };
});

vi.mock("../core/mcp/index.js", async () => {
  const actual = await vi.importActual<typeof McpModule>("../core/mcp/index.js");
  return {
    ...actual,
    MCPClientManager: vi.fn(function MCPClientManagerMock() {
      return { connectAll: vi.fn(async () => []), dispose: vi.fn(async () => {}) };
    }),
  };
});

const usage = { inputTokens: 10, outputTokens: 5 };
const timing = { startedAt: 0, completedAt: 0, providerDurationMs: 1 };
const NARRATION = "Let me re-read key sections with correct line numbers:";
const FATAL =
  "The model repeatedly issued invalid arguments for tool `read`. This is usually an upstream " +
  "model/tool-calling bug. Your conversation is preserved; send another message or switch models to continue.";

/** The loop's real shape when the invalid-argument stop fires: `error`, then a normal return. */
async function* stopsOnInvalidToolArguments(messages: Message[]) {
  messages.push({ role: "assistant", content: NARRATION });
  yield { type: "text_delta", text: NARRATION };
  yield { type: "turn_end", turn: 1, stopReason: "tool_use", usage, timing };
  messages.push({
    role: "tool",
    content: [
      {
        type: "tool_result",
        toolCallId: "t1",
        content: "Invalid arguments for tool `read`",
        isError: true,
      },
    ],
  });
  yield { type: "checkpoint", turn: 1 };
  yield { type: "error", error: new GGAIError(FATAL, { source: "provider" }) };
  yield { type: "agent_done", totalTurns: 1, totalUsage: usage };
}

async function* answersCleanly(messages: Message[]) {
  messages.push({ role: "assistant", content: "Final report." });
  yield { type: "text_delta", text: "Final report." };
  yield { type: "turn_end", turn: 1, stopReason: "end_turn", usage, timing };
  yield { type: "agent_done", totalTurns: 1, totalUsage: usage };
}

const SALVAGED = "VERDICT: CLEAN\nThe files examined before time ran out match the request.";

/**
 * A child still working when its time limit runs out: it keeps reading until
 * the turn is aborted, and answers only in the tool-free recovery turn after.
 */
async function* worksUntilStopped(
  messages: Message[],
  options: { signal?: AbortSignal; tools?: readonly unknown[] },
) {
  if (options.tools?.length === 0) {
    messages.push({ role: "assistant", content: SALVAGED });
    yield { type: "text_delta", text: SALVAGED };
    yield { type: "turn_end", turn: 1, stopReason: "end_turn", usage, timing };
    yield { type: "agent_done", totalTurns: 1, totalUsage: usage };
    return;
  }
  yield { type: "text_delta", text: "Reading the changed files." };
  await new Promise<void>((resolve) => {
    if (options.signal?.aborted) resolve();
    else options.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  throw new Error("aborted");
}

async function* throwsMidRun(messages: Message[]) {
  // Same shape as a provider failure mid-stream: the throw surfaces while the
  // session is iterating the loop, not when the loop is created.
  if (messages.length > 0) throw new Error("provider exploded");
  yield { type: "agent_done", totalTurns: 0, totalUsage: usage };
}

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf-8");
}

/**
 * Collect everything written to a stream without letting it reach the real
 * one; `onWrite` sees each write as it happens.
 */
function captureWrites(stream: NodeJS.WriteStream, onWrite?: (text: string) => void): string[] {
  const chunks: string[] = [];
  vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    chunks.push(text);
    onWrite?.(text);
    return true;
  });
  return chunks;
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-subagent-loop-error-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-subagent-loop-error-project-"));
  restoreHome = useFakeHome(tmpHome);
  agentLoopMock.mockReset();
  await writeJson(path.join(tmpHome, ".gg", "auth.json"), {
    anthropic: {
      accessToken: "test-access",
      refreshToken: "test-refresh",
      expiresAt: Date.now() + 3_600_000,
    },
  });
  await writeJson(path.join(tmpHome, ".gg", "settings.json"), { autoCompact: false });
});

afterEach(async () => {
  vi.restoreAllMocks();
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
});

describe("promptSubAgent", () => {
  async function newSession() {
    const { AgentSession } = await import("../core/agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      transient: true,
    });
    await session.initialize();
    return session;
  }

  it("returns the error the loop stopped on, although prompt() resolved", async () => {
    agentLoopMock.mockImplementation(stopsOnInvalidToolArguments);
    const session = await newSession();
    const { promptSubAgent } = await import("../tools/subagent-shared.js");

    const stoppedOn = await promptSubAgent(session, "review the agent loop");

    expect(stoppedOn?.message).toBe(FATAL);
    await session.dispose();
  });

  it("returns nothing for a run that finished cleanly", async () => {
    agentLoopMock.mockImplementation(answersCleanly);
    const session = await newSession();
    const { promptSubAgent } = await import("../tools/subagent-shared.js");

    expect(await promptSubAgent(session, "review the agent loop")).toBeUndefined();
    await session.dispose();
  });

  it("does not carry one turn's error into a follow-up on the same session", async () => {
    agentLoopMock
      .mockImplementationOnce(stopsOnInvalidToolArguments)
      .mockImplementationOnce(answersCleanly);
    const session = await newSession();
    const { promptSubAgent } = await import("../tools/subagent-shared.js");

    expect(await promptSubAgent(session, "first task")).toBeDefined();
    expect(await promptSubAgent(session, "follow-up")).toBeUndefined();
    await session.dispose();
  });

  it("lets a thrown failure propagate", async () => {
    agentLoopMock.mockImplementation(throwsMidRun);
    const session = await newSession();
    const { promptSubAgent } = await import("../tools/subagent-shared.js");

    await expect(promptSubAgent(session, "review the agent loop")).rejects.toThrow(
      "provider exploded",
    );
    await session.dispose();
  });
});

describe("spawn_agent worker", () => {
  type Frame = Record<string, unknown>;

  async function runWorkerTurn(
    extraOptions: Frame = {},
  ): Promise<{ done: Frame; childSessionPath: string; recordedFirst: boolean[] }> {
    const stdin = new PassThrough();
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
    let childSessionPath = "";
    // Whether the turn record was already on disk as each turn_complete went out.
    const recordedFirst: boolean[] = [];
    const stdout = captureWrites(process.stdout, (text) => {
      if (text.includes('"type":"turn_complete"')) {
        recordedFirst.push(existsSync(`${childSessionPath}.turn.json`));
      }
    });
    const frames = (): Frame[] =>
      stdout
        .join("")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Frame);
    const send = (frame: Frame): void => {
      stdin.write(`${JSON.stringify(frame)}\n`);
    };

    const { runSubagentWorkerMode } = await import("./subagent-worker-mode.js");
    const worker = runSubagentWorkerMode();

    send({
      request_id: "init",
      command: "initialize",
      options: {
        provider: "anthropic",
        model: "claude-test",
        cwd: tmpProject,
        systemPrompt: "test system prompt",
        sessionRootDir: path.join(tmpHome, ".gg", "subagent-sessions"),
        ...extraOptions,
      },
    });
    const initialized = await vi.waitFor(
      () => {
        const ack = frames().find((f) => f.type === "ack" && f.request_id === "init");
        if (!ack) throw new Error("worker has not initialized yet");
        return ack;
      },
      { timeout: 10_000 },
    );
    expect(initialized.ok).toBe(true);
    childSessionPath = String(initialized.child_session_path);

    send({ request_id: "start", command: "start", task: "review the agent loop" });
    const done = await vi.waitFor(
      () => {
        const frame = frames().find((f) => f.type === "turn_complete");
        if (!frame) throw new Error("turn has not completed yet");
        return frame;
      },
      { timeout: 10_000 },
    );

    stdin.end();
    await worker;
    return { done, childSessionPath, recordedFirst };
  }

  it("fails the turn the loop stopped on and keeps the reason for the parent", async () => {
    agentLoopMock.mockImplementation(stopsOnInvalidToolArguments);

    const { done, childSessionPath, recordedFirst } = await runWorkerTurn();

    expect(done).toMatchObject({ status: "failed", error: FATAL });
    expect(String(done.output)).toContain(NARRATION);
    // What a parent that restarted mid-run adopts — it said "completed" before.
    expect(recordedFirst).toEqual([true]);
    const { readTurnRecord } = await import("../core/subagent-turn-record.js");
    expect(await readTurnRecord(childSessionPath)).toMatchObject({
      status: "failed",
      error: FATAL,
    });
  });

  it("writes the turn record before it announces the turn", async () => {
    // A parent that restarts adopts the record, so it is on disk before
    // turn_complete goes out; and the worker isn't done, nor its folder free
    // to clean up, while the record is still being written.
    agentLoopMock.mockImplementation(answersCleanly);

    const { recordedFirst } = await runWorkerTurn();

    expect(recordedFirst).toEqual([true]);
  });

  it("still completes a turn that finished cleanly", async () => {
    agentLoopMock.mockImplementation(answersCleanly);

    const { done } = await runWorkerTurn();

    expect(done).toMatchObject({ status: "completed", output: "Final report." });
    expect(done.error).toBeUndefined();
  });

  it("answers from what it gathered when its own time limit runs out", async () => {
    // The independent reviewer is spawned with a short time limit. Reaching it
    // must end in the tool-free recovery answer, not in an interrupt with no
    // verdict — which is how every large review used to end.
    agentLoopMock.mockImplementation(worksUntilStopped);

    const { done, recordedFirst } = await runWorkerTurn({ turnTimeoutMs: 50 });

    expect(done).toMatchObject({ status: "completed", recovered_after_timeout: true });
    expect(String(done.output)).toContain(`[Timeout recovery summary]\n${SALVAGED}`);
    expect(recordedFirst).toEqual([true]);
  });

  it("gives its time-limit answer at reduced thinking effort", async () => {
    // The recovery turn has 60 seconds to answer. At max effort one ran past
    // it still thinking, so ten minutes of work came back as nothing.
    agentLoopMock.mockImplementation(worksUntilStopped);

    await runWorkerTurn({ turnTimeoutMs: 50, thinkingLevel: "max" });

    const thinkingByCall = agentLoopMock.mock.calls.map(
      ([, options]) => (options as { thinking?: string }).thinking,
    );
    expect(thinkingByCall).toEqual(["max", "medium"]);
  });

  it("restores inherited OpenAI Ultra when a pinned model falls back to the parent", async () => {
    await writeJson(path.join(tmpHome, ".gg", "auth.json"), {
      openai: {
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 3_600_000,
      },
    });
    agentLoopMock
      .mockImplementationOnce(async function* rejectsPinnedModel(messages: Message[]) {
        if (messages.length > 0) throw new Error("model not found: gpt-6-luna");
        yield { type: "agent_done", totalTurns: 0, totalUsage: usage };
      })
      .mockImplementationOnce(answersCleanly);

    const { done } = await runWorkerTurn({
      provider: "openai",
      model: "gpt-6-luna",
      fallbackModel: "gpt-6.1-sol",
      thinkingLevel: "max",
      parentThinkingLevel: "ultra",
    });

    expect(done).toMatchObject({ status: "completed", output: "Final report." });
    expect(
      agentLoopMock.mock.calls.map(([, options]) => {
        const { model, thinking } = options as { model: string; thinking: string };
        return { model, thinking };
      }),
    ).toEqual([
      { model: "gpt-6-luna", thinking: "max" },
      { model: "gpt-6.1-sol", thinking: "ultra" },
    ]);
  });

  it("retries an unavailable pinned model on the parent model at the parent's lowest thinking level", async () => {
    // A retired, unregistered model's ladder bottoms out at "high", Opus's at "low". The retry used
    // to keep the pinned model's rung, so it would run Opus at "high".
    const { getSupportedThinkingLevels } = await import("../core/thinking-level.js");
    const pinnedLowest = getSupportedThinkingLevels("anthropic", "claude-retired-model")[0];
    const opusLowest = getSupportedThinkingLevels("anthropic", "claude-opus-5-5")[0];
    expect(pinnedLowest).not.toBe(opusLowest);
    agentLoopMock
      .mockImplementationOnce(async function* rejectsPinnedModel(messages: Message[]) {
        // Rejected before any output or tool call — the only case that may retry.
        if (messages.length > 0) throw new Error("model not found: claude-retired-model");
        yield { type: "agent_done", totalTurns: 0, totalUsage: usage };
      })
      .mockImplementationOnce(answersCleanly);

    const { done } = await runWorkerTurn({
      model: "claude-retired-model",
      fallbackModel: "claude-opus-5-5",
      thinkingLevel: pinnedLowest,
    });

    expect(done).toMatchObject({ status: "completed", output: "Final report." });
    const attempts = agentLoopMock.mock.calls.map(([, options]) => {
      const { model, thinking } = options as { model?: string; thinking?: string };
      return { model, thinking };
    });
    expect(attempts).toEqual([
      { model: "claude-retired-model", thinking: pinnedLowest },
      { model: "claude-opus-5-5", thinking: opusLowest },
    ]);
  });
});

describe("blocking subagent (JSON mode)", () => {
  async function runJsonTurn(): Promise<{ exitCode: unknown; stderr: string }> {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
    captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);

    const { runJsonMode } = await import("./json-mode.js");
    await runJsonMode({
      message: "review the agent loop",
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
    });
    // exitAfterFlush may wait for a stdout drain (bounded at 2s) before exiting.
    await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 5_000 });
    return { exitCode: exit.mock.calls[0]?.[0], stderr: stderr.join("") };
  }

  it("exits non-zero with the reason when the loop stopped on an error", async () => {
    agentLoopMock.mockImplementation(stopsOnInvalidToolArguments);

    const { exitCode, stderr } = await runJsonTurn();

    // The parent reports a non-zero exit as "Sub-agent failed (exit 1): <stderr>"
    // and labels the narration as partial output instead of passing it off as the answer.
    expect(exitCode).toBe(1);
    expect(stderr).toContain("repeatedly issued invalid arguments for tool `read`");
  });

  it("still exits 0 after a clean run", async () => {
    agentLoopMock.mockImplementation(answersCleanly);

    const { exitCode, stderr } = await runJsonTurn();

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });
});
