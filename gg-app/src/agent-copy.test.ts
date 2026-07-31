import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    setTitle: vi.fn(),
    listen: vi.fn(async () => vi.fn()),
  }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));

import { copyPaneToNewWindow, PaneCopyError } from "./agent";

describe("copyPaneToNewWindow", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("runs the typed prepare and startup flow", async () => {
    invoke
      .mockResolvedValueOnce({
        copyId: "11111111-1111-4111-8111-111111111111",
        windowLabel: "project-1",
        reusedWindow: false,
      })
      .mockResolvedValueOnce({ windowLabel: "project-1", reusedWindow: false });

    await expect(copyPaneToNewWindow("pane-2")).resolves.toEqual({
      windowLabel: "project-1",
      reusedWindow: false,
    });
    expect(invoke).toHaveBeenNthCalledWith(1, "agent_pane_copy", {
      paneId: "pane-2",
      copyId: "11111111-1111-4111-8111-111111111111",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "agent_pane_copy_startup", {
      copyId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("rolls back a prepared copy when startup fails", async () => {
    invoke
      .mockResolvedValueOnce({
        copyId: "11111111-1111-4111-8111-111111111111",
        windowLabel: "project-1",
        reusedWindow: false,
      })
      .mockRejectedValueOnce(new Error("startup failed"))
      .mockResolvedValueOnce(undefined);

    const error = await copyPaneToNewWindow("primary").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PaneCopyError);
    expect((error as PaneCopyError).rollbackSucceeded).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("agent_pane_copy_rollback", {
      copyId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("does not report rollback when preparation fails before reserving a window", async () => {
    invoke.mockRejectedValueOnce(new Error("prepare failed"));

    const error = await copyPaneToNewWindow("primary").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PaneCopyError);
    expect((error as PaneCopyError).rollbackSucceeded).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
