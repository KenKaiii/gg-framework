// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const logError = vi.fn();
let emitReady: ((event: { payload: number }) => void) | undefined;

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: (...args: unknown[]) => logError(...args) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    setTitle: vi.fn().mockResolvedValue(undefined),
    listen: vi.fn((name: string, handler: (event: { payload: number }) => void) => {
      if (name === "sidecar-ready") emitReady = handler;
      return Promise.resolve(() => undefined);
    }),
  }),
}));

import { getRadioState, getSteroidsStatus, listProjects } from "./agent";

const state = {
  stations: [{ id: "lofi", name: "Lofi", description: "", url: "" }],
  current: null,
  volume: 40,
};

describe("getRadioState", () => {
  beforeEach(() => {
    invoke.mockReset();
    logError.mockReset();
    emitReady = undefined;
  });

  it("waits for the sidecar at launch instead of failing with daemon not ready", async () => {
    let port: number | null = null;
    invoke.mockImplementation((command: string) => {
      if (command === "sidecar_port") return Promise.resolve(port);
      if (command === "agent_radio_state") {
        return port === null ? Promise.reject("daemon not ready") : Promise.resolve(state);
      }
      return Promise.reject(new Error(`unexpected ${command}`));
    });

    const pending = getRadioState();
    await vi.waitFor(() => expect(emitReady).toBeDefined());
    expect(invoke).not.toHaveBeenCalledWith("agent_radio_state");

    port = 63312;
    emitReady?.({ payload: port });

    await expect(pending).resolves.toEqual(state);
    expect(logError).not.toHaveBeenCalled();
  });
});

describe("mount-time session calls", () => {
  beforeEach(() => {
    invoke.mockReset();
    logError.mockReset();
    emitReady = undefined;
  });

  it.each([
    ["agent_projects", () => listProjects(), { projects: [] }],
    ["agent_steroids_status", () => getSteroidsStatus(), { installed: true, connected: true }],
  ] as const)("%s waits for the window session first", async (command, call, reply) => {
    let port: number | null = null;
    invoke.mockImplementation((name: string) => {
      if (name === "sidecar_port") return Promise.resolve(port);
      if (name === command) return Promise.resolve(reply);
      return Promise.reject(new Error(`unexpected ${name}`));
    });

    const pending = call();
    await vi.waitFor(() => expect(emitReady).toBeDefined());
    expect(invoke).not.toHaveBeenCalledWith(command);

    port = 63312;
    emitReady?.({ payload: port });
    await pending;
    expect(invoke).toHaveBeenCalledWith(command);
  });
});
