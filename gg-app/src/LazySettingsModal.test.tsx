// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { SettingsModal } from "./LazySettingsModal";

const native = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({ projectsRoot: "/synthetic/projects" })),
  saveSettings: vi.fn(async () => {}),
  getPermissionsStatus: vi.fn(async () => ({ applicable: false, granted: false })),
  waitForReady: vi.fn(async () => {}),
}));
const keepAwake = vi.hoisted(() => ({
  getKeepAwake: vi.fn(async () => true),
  setKeepAwake: vi.fn(async (enabled: boolean) => enabled),
}));
vi.mock("./agent", () => ({ ...native, openPermissionsSettings: vi.fn() }));
vi.mock("./kleio/keepAwake", () => keepAwake);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./toast", () => ({ toast: vi.fn() }));

// Transform the lazy chunk up front: on Windows CI one cold import of the
// settings module took over 5 s. Warming the module cache doesn't render or
// read anything, so the test still proves settings aren't read before opening.
beforeAll(async () => {
  await import("./SettingsModal");
}, 60_000);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("lazy settings", () => {
  it("loads only when opened, preserves saving, Escape and focus return", async () => {
    const onSaved = vi.fn();
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open settings</button>
          {open && <SettingsModal onClose={() => setOpen(false)} onSaved={onSaved} />}
        </>
      );
    }
    render(<Host />);
    expect(native.getSettings).not.toHaveBeenCalled();
    const trigger = screen.getByRole("button", { name: "Open settings" });
    trigger.focus();
    fireEvent.click(trigger);
    // The lazy chunk can take over a second to import under a full parallel run.
    const dialog = await screen.findByRole("dialog", { name: "Settings" }, { timeout: 5000 });
    const input = within(dialog).getByRole("textbox");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("/synthetic/projects"));
    fireEvent.change(input, { target: { value: "/synthetic/updated" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("/synthetic/updated"));
    expect(native.saveSettings).toHaveBeenCalledWith("/synthetic/updated");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Settings" }, { timeout: 5000 });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    // Each lazy-chunk wait above allows 5 s on its own, so the test as a whole
    // needs more than vitest's 5 s default (slow Windows runners hit it).
  }, 20_000);

  it("loads the keep-awake setting and saves a toggle through the sidecar", async () => {
    render(<SettingsModal onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "Settings" }, { timeout: 5000 });
    const toggle = within(dialog).getByRole("checkbox", {
      name: "Keep computer awake while the agent works",
    });
    // Disabled until the sidecar answers, so a click can't race the load.
    await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(keepAwake.setKeepAwake).toHaveBeenCalledWith(false));
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
  }, 20_000);
});
