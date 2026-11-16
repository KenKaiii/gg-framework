// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main", setTitle: vi.fn() }),
}));

import { getLivePreviewStatus, startLivePreview, stopLivePreview } from "./agent";

afterEach(() => clearMocks());

describe("live preview wrappers", () => {
  it("waits for the session, then calls the live preview commands", async () => {
    const calls: Array<[string, unknown]> = [];
    mockIPC((command, args) => {
      calls.push([command, args]);
      if (command === "sidecar_port") return 1;
      return { running: command === "live_preview_start", url: null, target: null };
    });
    expect(await startLivePreview("localhost:3000")).toMatchObject({ running: true });
    await startLivePreview();
    await stopLivePreview();
    await getLivePreviewStatus();
    const commands = calls.filter(([c]) => c !== "sidecar_port");
    expect(commands.map(([c]) => c)).toEqual([
      "live_preview_start",
      "live_preview_start",
      "live_preview_stop",
      "live_preview_status",
    ]);
    expect(commands[0][1]).toMatchObject({ url: "localhost:3000" });
    expect(commands[1][1]).toMatchObject({ url: null });
    expect(calls[0][0]).toBe("sidecar_port");
  });
});
