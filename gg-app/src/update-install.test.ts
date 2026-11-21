import { describe, expect, it, vi } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { installUpdate } from "./update-install";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (event: unknown) => void = () => {};
  },
}));

describe("installUpdate", () => {
  it("installs an .rpm build through the app's own installer, not the plugin's", async () => {
    const update = { downloadAndInstall: vi.fn() };
    const events: DownloadEvent[] = [];
    const call = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "update_installs_rpm") return true;
      const channel = args?.onEvent as { onmessage: (e: DownloadEvent) => void };
      channel.onmessage({ event: "Started", data: { contentLength: 8 } });
      channel.onmessage({ event: "Finished" });
      return undefined;
    });
    await installUpdate(update, (e) => events.push(e), call as never);
    expect(call).toHaveBeenCalledWith("install_rpm_update", expect.anything());
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(events.map((e) => e.event)).toEqual(["Started", "Finished"]);
  });

  it.each([
    ["any other build", async () => false],
    ["a build that can't say", async () => Promise.reject(new Error("no command"))],
  ])("uses the plugin for %s", async (_name, probe) => {
    const update = { downloadAndInstall: vi.fn(async () => {}) };
    const call = vi.fn(probe);
    await installUpdate(update, () => {}, call as never);
    expect(update.downloadAndInstall).toHaveBeenCalledOnce();
    expect(call).not.toHaveBeenCalledWith("install_rpm_update", expect.anything());
  });

  it("passes the installer's failure on to the banner", async () => {
    const call = vi.fn(async (cmd: string) => {
      if (cmd === "update_installs_rpm") return true;
      throw "The update needs your password to install. Try again and approve the prompt.";
    });
    await expect(
      installUpdate({ downloadAndInstall: vi.fn() }, () => {}, call as never),
    ).rejects.toMatch(/password/);
  });
});
