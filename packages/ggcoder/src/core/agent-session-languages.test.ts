import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: vi.fn(() => (async function* emptyLoop() {})()) };
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

let restoreHome: (() => void) | undefined;
let tempHome: string;
let tempProject: string;

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "packs-home-"));
  tempProject = await fs.mkdtemp(path.join(os.tmpdir(), "packs-project-"));
  restoreHome = useFakeHome(tempHome);
  await fs.mkdir(path.join(tempHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tempHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  );
});

afterEach(async () => {
  restoreHome?.();
  await Promise.all([
    fs.rm(tempHome, { recursive: true, force: true }),
    fs.rm(tempProject, { recursive: true, force: true }),
  ]);
  vi.clearAllMocks();
});

function systemPrompt(session: { getMessages: () => { role: string; content: unknown }[] }) {
  const first = session.getMessages()[0];
  expect(first?.role).toBe("system");
  return String(first?.content);
}

// The desktop app and every non-TUI mode build prompts through AgentSession
// alone. A detected language adds its verify commands, never a style pack.
describe("AgentSession language verify commands (shared/app path)", () => {
  it("adds verify commands for languages present, including ones created mid-session", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      cwd: tempProject,
      transient: true,
      projectCustomization: false,
      loadExtensions: false,
      orchestrationPrompt: false,
      selfCorrectionHooks: false,
    });
    await session.initialize();
    try {
      await session.prompt("hello");
      expect(systemPrompt(session)).not.toContain("## Verification");

      // A project scaffolded during a previous task gets its checks next turn.
      await fs.writeFile(path.join(tempProject, "tsconfig.json"), "{}");
      await session.prompt("next task");
      const prompt = systemPrompt(session);
      expect(prompt).toContain("## Verification");
      expect(prompt).toContain("tsc --noEmit");
      expect(prompt).not.toContain("Language Style Packs");
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("appends verify commands for a new language once the prompt is cached, without re-rendering it", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      cwd: tempProject,
      transient: true,
      projectCustomization: false,
      loadExtensions: false,
      orchestrationPrompt: false,
      selfCorrectionHooks: false,
    });
    await session.initialize();
    try {
      // A finished exchange means the system prompt is now a cached prefix.
      session
        .getMessages()
        .push({ role: "user", content: "hello" }, { role: "assistant", content: "hi" });
      const before = systemPrompt(session);

      await fs.writeFile(path.join(tempProject, "tsconfig.json"), "{}");
      await session.prompt("next task");

      expect(systemPrompt(session)).toBe(before);
      const updates = session
        .getMessages()
        .filter(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.includes("## Verification"),
        );
      expect(updates).toHaveLength(1);
      expect(String(updates[0]?.content)).toContain("tsc --noEmit");
      expect(String(updates[0]?.content)).not.toContain("Language Style Packs");
      // It sits just before the user's new request, so the request stays the
      // last thing the model reads.
      const messages = session.getMessages();
      const at = messages.indexOf(updates[0]!);
      expect(messages[at + 1]).toMatchObject({ role: "user", content: "next task" });

      // Announced once: the next turn adds nothing more.
      await session.prompt("third task");
      expect(
        session
          .getMessages()
          .filter((m) => typeof m.content === "string" && m.content.includes("## Verification")),
      ).toHaveLength(1);
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("gives verify commands to code-writing sub-agents but not to user-facing specialist agents", async () => {
    await fs.writeFile(path.join(tempProject, "tsconfig.json"), "{}");
    const { AgentSession } = await import("./agent-session.js");
    const base = {
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      cwd: tempProject,
      transient: true,
      projectCustomization: false,
      loadExtensions: false,
      orchestrationPrompt: false,
      selfCorrectionHooks: false,
    };
    const child = new AgentSession({ ...base, agentPrompt: "You implement one task." });
    const specialist = new AgentSession({
      ...base,
      agentPrompt: "You make videos.",
      agentRole: "primary",
      agentContext: "none",
    });
    await child.initialize();
    await specialist.initialize();
    try {
      expect(systemPrompt(child)).toContain("## Verification");
      expect(systemPrompt(child)).not.toContain("Language Style Packs");
      expect(systemPrompt(specialist)).not.toContain("## Verification");
    } finally {
      await child.dispose();
      await specialist.dispose();
    }
  }, 20_000);
});
