import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as CompactorModule from "./compaction/compactor.js";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";
import { normalizeAppMarkersForHistory } from "./session-history.js";

const shouldCompactMock = vi.hoisted(() => vi.fn());
const compactMock = vi.hoisted(() => vi.fn());
const agentLoopMock = vi.hoisted(() => vi.fn());

vi.mock("./compaction/compactor.js", async () => {
  const actual = await vi.importActual<typeof CompactorModule>("./compaction/compactor.js");
  return {
    ...actual,
    shouldCompact: shouldCompactMock,
    compact: compactMock,
  };
});

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return {
    ...actual,
    agentLoop: agentLoopMock,
  };
});

vi.mock("./mcp/index.js", async () => {
  const actual = await vi.importActual<typeof McpModule>("./mcp/index.js");
  return {
    ...actual,
    MCPClientManager: vi.fn(function MCPClientManagerMock() {
      return {
        connectAll: vi.fn(async () => []),
        dispose: vi.fn(async () => {}),
      };
    }),
  };
});

let originalHome: string | undefined;
let tmpHome: string;
let tmpProject: string;

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

async function findSessionFile(): Promise<string> {
  const root = path.join(tmpHome, ".gg", "sessions");
  const found: string[] = [];
  for (const dir of await fs.readdir(root)) {
    for (const file of await fs.readdir(path.join(root, dir))) {
      if (file.endsWith(".jsonl")) found.push(path.join(root, dir, file));
    }
  }
  if (found.length !== 1) throw new Error(`expected 1 session file, found ${found.length}`);
  return found[0]!;
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "marker-anchor-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "marker-anchor-project-"));
  process.env.HOME = tmpHome;

  shouldCompactMock.mockReset().mockReturnValue(false);
  compactMock.mockReset();
  agentLoopMock.mockReset();

  await writeJson(path.join(tmpHome, ".gg", "auth.json"), {
    anthropic: {
      accessToken: "test" + "-access",
      refreshToken: "test-refresh",
      expiresAt: Date.now() + 3_600_000,
    },
  });
  await writeJson(path.join(tmpHome, ".gg", "settings.json"), {
    autoCompact: true,
    compactThreshold: 0.1,
  });
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("AgentSession transcript marker anchors", () => {
  it("anchors markers to the persisted prefix so a failed run's unpersisted messages cannot shift them to the bottom on resume", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
    });
    await session.initialize();

    // Successful first run: user + assistant persisted (2 non-system messages).
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "first reply" });
      yield { type: "agent_done" };
    });
    await session.prompt("first task");

    // Markers recorded while the session is settled: anchor = 2.
    await session.persistAppMarker("error", { headline: "mid error" });
    await session.persistKenTurn("question", "reply");
    await session.persistAutopilotMarker("done");

    // Failed second run: the loop appends partial messages in place, then
    // throws — they stay in memory but are NEVER persisted. The user message
    // itself IS persisted (prompt persists it before the loop), so the
    // persisted transcript is user1/assistant1/user2 = 3 non-system messages.
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push(
        { role: "assistant", content: "partial draft" },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "t1", content: "partial tool output" }],
        },
        { role: "assistant", content: "more partial work" },
      );
      yield { type: "text_delta", text: "partial" };
      throw new Error("provider melted down");
    });
    await expect(session.prompt("second task")).rejects.toThrow("provider melted down");

    // The in-memory list now runs 3 messages ahead of the file. Anchoring
    // against the full in-memory list (old behavior) records 6 — past the end
    // of the restored transcript. The persisted prefix gives 3: exactly where
    // the error appeared live.
    await session.persistAppMarker("error", { headline: "late error" });

    const markers = session.getAppMarkers().filter((m) => m.kind === "error");
    expect(markers.map((m) => m.afterMessageCount)).toEqual([2, 3]);
    expect(session.getKenTurns().map((t) => t.afterMessageCount)).toEqual([2]);
    expect(session.getAutopilotMarkers().map((m) => m.afterMessageCount)).toEqual([2]);
    await session.dispose();

    // Resume: a fresh session loads the file. The restored transcript has 3
    // non-system messages; both error markers must survive normalization at
    // their original positions (2 = mid-transcript, 3 = after the failed
    // turn's user bubble) instead of being dropped as out-of-range.
    const sessionFile = await findSessionFile();
    const resumed = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      sessionId: sessionFile,
    });
    await resumed.initialize();

    const restoredCount = resumed.getMessages().filter((m) => m.role !== "system").length;
    expect(restoredCount).toBe(3);

    const replayed = normalizeAppMarkersForHistory(resumed.getAppMarkers(), restoredCount).filter(
      (m) => m.kind === "error",
    );
    expect(replayed.map((m) => m.afterMessageCount)).toEqual([2, 3]);
    // Neither marker bunches at the bottom of the resumed transcript.
    expect(replayed.some((m) => m.afterMessageCount > restoredCount)).toBe(false);
    await resumed.dispose();
  }, 15_000);
});
