import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    setTitle: vi.fn(),
    listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
      listeners.set(name, cb);
      return () => listeners.delete(name);
    }),
  }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));

import { createPaneAgentClient, getState, sendPrompt } from "./agent";

const target = {
  mode: "chat" as const,
  chatAgent: "therapist" as const,
  cwd: "/work",
  sessionPath: "/s",
};

describe("pane agent client", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (command: string) =>
      command === "agent_pane_status"
        ? { ready: true, error: null, generation: 1, sessionId: "session" }
        : {},
    );
  });

  it("routes the current IPC surface with the complete pane argument matrix", async () => {
    const c = createPaneAgentClient("right");
    await c.getState();
    await c.listMemories();
    await c.deleteMemory("m");
    await c.listJiwa();
    await c.deleteJiwa("j");
    await c.getProgress();
    await c.getSubscriptionUsage("openai");
    await c.enhancePrompt("e");
    await c.sendPrompt("p", [], { kenSent: true });
    await c.cancel();
    await c.sendKenPrompt("k");
    await c.cancelKen();
    await c.setAutopilot(true);
    await c.acceptPlan("plan");
    await c.listHistory();
    await c.authOAuthStart("openai");
    await c.authOAuthCode("code");
    await c.newSession();
    await c.getRadioState();
    await c.setRadio("lofi");
    await c.setRadioVolume(50);
    await c.listTasks();
    await c.runTask("t");
    await c.runAllTasks();
    await c.deleteTask("t");
    await c.killTask("bg");
    await c.cycleThinking();
    await c.listCommands();
    await c.listModels();
    await c.switchModel("m");
    await c.switchKenModel(null);
    await c.getSettings();
    await c.saveSettings("/projects");
    await c.listProjects();
    await c.searchFiles("q");
    await c.listSessions("/work", "all");
    await c.getTelegramStatus();
    await c.saveTelegramConfig("token", "1");
    await c.getServeStatus();
    await c.startServe();
    await c.stopServe();
    await c.listMcpServers("/work");
    await c.addMcpServer("cmd", "project", "/work");
    await c.loginMcpServer("mcp", "global");
    await c.removeMcpServer("mcp", "project", "/work");

    expect(invoke).toHaveBeenCalled();
    for (const [, args] of invoke.mock.calls) expect(args).toMatchObject({ paneId: "right" });
    expect(invoke).toHaveBeenCalledWith("agent_prompt", {
      paneId: "right",
      text: "p",
      attachments: [],
      meta: { kenSent: true },
    });
    expect(invoke).toHaveBeenCalledWith("agent_sessions", {
      paneId: "right",
      cwd: "/work",
      chatAgent: "all",
    });
  });

  it("keeps compatibility wrappers explicitly on primary", async () => {
    await getState();
    await sendPrompt("hello");
    expect(invoke).toHaveBeenNthCalledWith(1, "agent_state", { paneId: "primary" });
    expect(invoke).toHaveBeenNthCalledWith(2, "agent_prompt", {
      paneId: "primary",
      text: "hello",
      attachments: [],
      meta: null,
    });
  });

  it("preserves lifecycle generations and rejects stale pane events", async () => {
    const c = createPaneAgentClient("right");
    invoke.mockImplementation(async (command: string) =>
      command === "agent_pane_status"
        ? { ready: true, error: null, generation: 9, sessionId: "active" }
        : command === "agent_pane_create"
          ? 7
          : command === "agent_pane_restore"
            ? 8
            : undefined,
    );
    expect(await c.create(target)).toBe(7);
    expect(await c.restore(target)).toBe(8);
    await c.dispose(8);
    expect(invoke).toHaveBeenCalledWith("agent_pane_dispose", { paneId: "right", generation: 8 });

    const onEvent = vi.fn();
    c.subscribe(onEvent);
    await vi.waitFor(() => expect(listeners.has("agent-event")).toBe(true));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("agent_pane_status", { paneId: "right" }),
    );
    listeners.get("agent-event")!({
      payload: { paneId: "right", sessionId: "stale", type: "delta", data: 1 },
    });
    listeners.get("agent-event")!({
      payload: { paneId: "right", sessionId: "active", type: "delta", data: 2 },
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: "delta", data: 2 });
  });
});
