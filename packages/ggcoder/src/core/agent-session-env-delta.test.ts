/**
 * The Environment section is written once into the cached system prompt, but
 * the network allowlist can be changed mid-session through settings with no
 * prompt rebuild. When that happens the model must be told — otherwise it
 * keeps reasoning from an allowlist that is no longer the real policy and
 * cannot explain why a fetch is blocked.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kleio/agent";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";

vi.mock("@kleio/agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kleio/agent");
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
let tmpHome: string;
let tmpProject: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "env-delta-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "env-delta-project-"));
  restoreHome = useFakeHome(tmpHome);
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "test-token",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  );
});

afterEach(async () => {
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** Reach the hook the agent loop drives through its options. */
interface SessionInternals {
  getHookSteeringMessages: () => Array<{ role: string; content: unknown }> | null;
  settingsManager: {
    set: (key: string, value: unknown) => Promise<void>;
  };
}

async function makeSession(custom?: { systemPrompt?: string }) {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-test",
    cwd: tmpProject,
    transient: true,
    projectCustomization: false,
    loadExtensions: false,
    orchestrationPrompt: false,
    selfCorrectionHooks: false,
    ...(custom?.systemPrompt ? { systemPrompt: custom.systemPrompt } : {}),
  });
  await session.initialize();
  return { session, internals: session as unknown as SessionInternals };
}

describe("AgentSession environment drift", () => {
  it("tells the model when the network allowlist changed after the prompt was written", async () => {
    const { session, internals } = await makeSession();
    try {
      // The prompt is already built and cached at this point.
      expect(internals.getHookSteeringMessages()).toBeNull();

      await internals.settingsManager.set("networkMode", "allowlist");
      await internals.settingsManager.set("networkAllow", ["api.internal.example"]);

      const messages = internals.getHookSteeringMessages();
      expect(messages).toHaveLength(1);
      expect(messages![0]!.content).toContain("api.internal.example");

      // Delivered once: a second poll must not re-inject the same correction.
      expect(internals.getHookSteeringMessages()).toBeNull();
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("leaves the cached system prompt untouched — the fix is append-only", async () => {
    const { session, internals } = await makeSession();
    try {
      const before = String(session.getMessages()[0]?.content ?? "");

      await internals.settingsManager.set("networkMode", "allowlist");
      await internals.settingsManager.set("networkAllow", ["api.internal.example"]);
      internals.getHookSteeringMessages();

      // Byte-identical: rewriting it would invalidate every cached token from
      // the Environment section onward.
      expect(String(session.getMessages()[0]?.content ?? "")).toBe(before);
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("stays silent when nothing about the environment moved", async () => {
    const { session, internals } = await makeSession();
    try {
      expect(internals.getHookSteeringMessages()).toBeNull();
      expect(internals.getHookSteeringMessages()).toBeNull();
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("does not fire for /add-dir before the conversation, which rebuilds the prompt", async () => {
    const { session, internals } = await makeSession();
    const sibling = await fs.mkdtemp(path.join(os.tmpdir(), "env-delta-sibling-"));
    try {
      expect(await session.addDirectory(sibling)).toMatchObject({ ok: true });

      // Nothing is cached after the prompt yet, so it names the root directly.
      expect(String(session.getMessages()[0]?.content ?? "")).toContain("Additional roots:");
      expect(internals.getHookSteeringMessages()).toBeNull();
    } finally {
      await session.dispose();
      await fs.rm(sibling, { recursive: true, force: true });
    }
  }, 20_000);

  it("tells the model about /add-dir mid-conversation instead of rewriting the prompt", async () => {
    const { session, internals } = await makeSession();
    const sibling = await fs.mkdtemp(path.join(os.tmpdir(), "env-delta-midrun-"));
    try {
      session.getMessages().push({ role: "user", content: "earlier turn" });
      const before = session.getMessages()[0]?.content;
      expect(await session.addDirectory(sibling)).toMatchObject({ ok: true });

      expect(session.getMessages()[0]?.content).toBe(before);
      const messages = internals.getHookSteeringMessages();
      expect(messages).toHaveLength(1);
      expect(messages?.[0]?.content).toContain(path.resolve(sibling));
    } finally {
      await session.dispose();
      await fs.rm(sibling, { recursive: true, force: true });
    }
  }, 20_000);

  it("tells a verbatim custom prompt about an added root, since its prompt never rebuilds", async () => {
    // Ken's sessions run a fixed prompt. `/add-dir` widens the write guard for
    // them like anyone else, so staying silent let Ken write into a folder it
    // had never been told existed. This note is their only channel.
    const { session, internals } = await makeSession({ systemPrompt: "verbatim prompt" });
    const sibling = await fs.mkdtemp(path.join(os.tmpdir(), "env-delta-custom-"));
    try {
      expect(internals.getHookSteeringMessages()).toBeNull();
      expect(await session.addDirectory(sibling)).toMatchObject({ ok: true });

      const messages = internals.getHookSteeringMessages();
      expect(messages).toHaveLength(1);
      expect(messages![0]!.content).toContain(path.resolve(sibling));

      // The custom prompt is still verbatim — the fix is append-only.
      expect(session.getMessages()[0]?.content).toBe("verbatim prompt");
      // And delivered once, not on every poll.
      expect(internals.getHookSteeringMessages()).toBeNull();
    } finally {
      await session.dispose();
      await fs.rm(sibling, { recursive: true, force: true });
    }
  }, 20_000);
});
