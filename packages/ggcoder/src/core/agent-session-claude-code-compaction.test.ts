import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as CompactorModule from "./compaction/compactor.js";
import type * as CompleteModule from "./claude-code/complete.js";
import type * as LiveSessionModule from "./claude-code/live-session.js";
import { useFakeHome } from "../test-support/fake-home.js";

const shouldCompactMock = vi.hoisted(() => vi.fn());
const compactMock = vi.hoisted(() => vi.fn());
const liveRunMock = vi.hoisted(() => vi.fn());

vi.mock("./compaction/compactor.js", async () => {
  const actual = await vi.importActual<typeof CompactorModule>("./compaction/compactor.js");
  return { ...actual, shouldCompact: shouldCompactMock, compact: compactMock };
});

vi.mock("./claude-code/complete.js", async () => {
  const actual = await vi.importActual<typeof CompleteModule>("./claude-code/complete.js");
  return {
    ...actual,
    resolveClaudeCodeProcess: vi.fn(async (_auth: unknown, _provider: string, cwd: string) => ({
      executable: "/fake/claude",
      cwd,
      env: {},
    })),
  };
});

vi.mock("./claude-code/live-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof LiveSessionModule>();
  class FakeLiveSession {
    alive = true;
    busy = false;
    sessionId: string | undefined;
    run(messages: Message[]) {
      return liveRunMock(messages);
    }
    close() {
      this.alive = false;
    }
    async setEffort() {
      return true;
    }
  }
  return { ...actual, ClaudeCodeLiveSession: FakeLiveSession };
});

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-cc-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-cc-project-"));
  restoreHome = useFakeHome(tmpHome);
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "settings.json"),
    JSON.stringify({ autoCompact: true, compactThreshold: 0.1 }),
  );
  liveRunMock.mockImplementation(async function* (messages: Message[]) {
    messages.push({ role: "assistant", content: "done" });
    yield { type: "agent_done" };
  });
});

afterEach(async () => {
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function newSession() {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-test",
    cwd: tmpProject,
    systemPrompt: "system prompt",
    transient: true,
  });
  await session.initialize();
  return session;
}

describe("AgentSession compaction on the Claude subscription route", () => {
  it("compacts with GG's policy before Claude Code runs, not Claude Code's own", async () => {
    shouldCompactMock.mockReturnValue(true);
    compactMock.mockImplementation(async () => {
      shouldCompactMock.mockReturnValue(false);
      return {
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "[compacted]\n\nnext" },
        ],
        result: {
          compacted: true,
          originalCount: 6,
          newCount: 2,
          tokensBeforeEstimate: 500_000,
          tokensAfterEstimate: 2_000,
        },
      };
    });

    const session = await newSession();
    await session.prompt("next");
    await session.dispose();

    expect(compactMock).toHaveBeenCalledTimes(1);
    expect(compactMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ provider: "anthropic", complete: expect.any(Function) }),
    );
    expect(liveRunMock).toHaveBeenCalledWith(
      expect.arrayContaining([{ role: "user", content: "[compacted]\n\nnext" }]),
    );
  });

  it("compacts after the final response once the run crosses the limit", async () => {
    let overLimit = false;
    shouldCompactMock.mockImplementation(() => overLimit);
    liveRunMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "big answer" });
      overLimit = true;
      yield { type: "agent_done" };
    });
    compactMock.mockImplementation(async (messages: Message[]) => {
      overLimit = false;
      return {
        messages: [messages[0], { role: "user", content: "[compacted]" }],
        result: {
          compacted: true,
          originalCount: messages.length,
          newCount: 2,
          tokensBeforeEstimate: 500_000,
          tokensAfterEstimate: 2_000,
        },
      };
    });

    const session = await newSession();
    await session.prompt("do it");
    await vi.waitFor(() => expect(compactMock).toHaveBeenCalledTimes(1));
    await session.dispose();
  });
});
