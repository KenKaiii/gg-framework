import React, { useEffect, useRef } from "react";
import { render, Text } from "ink";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type { ClaudeCodeLoopOptions } from "../../core/claude-code/loop.js";
import { ScreenRecorder, makeRecordingStdout } from "../testing/screen-recorder.js";
import { useAgentLoop, type UseAgentLoopReturn } from "./useAgentLoop.js";

const agentLoopMock = vi.hoisted(() => vi.fn());
const claudeCodeLoopMock = vi.hoisted(() => vi.fn());
vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: agentLoopMock };
});
vi.mock("../../core/claude-code/loop.js", () => ({ claudeCodeLoop: claudeCodeLoopMock }));

const usage = { inputTokens: 10, outputTokens: 5 };
const timing = { startedAt: 0, completedAt: 1, providerDurationMs: 1 };
const process = { executable: "/fake/claude", cwd: "/tmp/project", env: {} };

function Harness({ onReady }: { onReady: (loop: UseAgentLoopReturn) => void }) {
  const messages = useRef<Message[]>([{ role: "system", content: "sys" }]);
  const loop = useAgentLoop(messages, {
    provider: "anthropic",
    model: "claude-sonnet-5",
    tools: [],
    maxTokens: 1000,
    resolveCredentials: () => Promise.reject(new Error("no token on this route")),
    resolveClaudeCode: async () => process,
  });
  useEffect(() => onReady(loop));
  return <Text>harness</Text>;
}

describe("useAgentLoop on a Claude subscription", () => {
  it("runs Claude Code instead of agentLoop, resumes it, and wakes it for queued messages", async () => {
    let woken = 0;
    claudeCodeLoopMock.mockImplementation(async function* (
      messages: Message[],
      opts: ClaudeCodeLoopOptions,
    ) {
      opts.onSteeringAvailable?.(() => woken++);
      opts.claudeCode.onSessionId?.("cc-tui");
      messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
      yield { type: "turn_end", turn: 1, stopReason: "end_turn", usage, timing };
      yield { type: "agent_done", totalTurns: 1, totalUsage: usage };
    });

    let loop: UseAgentLoopReturn | undefined;
    const recorder = new ScreenRecorder({ columns: 80, rows: 24 });
    const app = render(<Harness onReady={(l) => (loop = l)} />, {
      stdout: makeRecordingStdout(recorder),
      patchConsole: false,
    });
    try {
      await vi.waitFor(() => expect(loop).toBeDefined());
      await loop!.run("first");
      await loop!.run("second");
    } finally {
      app.unmount();
    }

    expect(agentLoopMock).not.toHaveBeenCalled();
    const calls = claudeCodeLoopMock.mock.calls as [Message[], ClaudeCodeLoopOptions][];
    expect(calls).toHaveLength(2);
    expect(calls[0][1].claudeCode).toMatchObject(process);
    expect(calls[0][1].claudeCode.resume).toBeUndefined();
    expect(calls[0][1].transformContext).toBeUndefined();
    expect(calls[1][1].claudeCode.resume).toBe("cc-tui");

    loop!.queueMessage("steer");
    expect(woken).toBeGreaterThan(0);
  });
});
