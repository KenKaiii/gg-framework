// @vitest-environment jsdom
// Ready and installing render the same 44px bar in a real browser (App.css
// sizes .update-banner, and the XP readout reserves 100%'s columns). jsdom has
// no layout, so that is checked in the browser, not here.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.1.0") }));
const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./agent", () => ({ openUrl }));

import { UpdateBanner } from "./UpdateBanner";
import type { UpdatePhase } from "./update";

const update = (phase: UpdatePhase, progress: number | null = null) => ({
  phase,
  version: "1.2.0",
  progress,
  error: null as string | null,
  install: vi.fn(async () => {}),
});

afterEach(cleanup);

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("UpdateBanner", () => {
  it("renders nothing until an update is ready", () => {
    for (const phase of ["idle", "checking"] as const) {
      const { container } = render(<UpdateBanner appUpdate={update(phase)} />);
      expect(container.innerHTML).toBe("");
      cleanup();
    }
  });

  it("offers your version to the new one, and installs when the bar is pressed", async () => {
    const appUpdate = update("available");
    render(<UpdateBanner appUpdate={appUpdate} />);
    await settle();
    const button = screen.getByRole("button", {
      name: "Update to 1.2.0. Installs and restarts the app.",
    });

    expect(button.textContent).toContain("v1.1.0");
    expect(button.textContent).toContain("v1.2.0");
    // The pixel words and the INSTALL key are art; the name says it all.
    expect(button.querySelector(".ub-row")?.getAttribute("aria-hidden")).toBe("true");
    expect(button.querySelector(".ub-key")).not.toBeNull();
    fireEvent.click(button);
    expect(appUpdate.install).toHaveBeenCalledTimes(1);
  });

  it("keeps the same slot from ready to installing, so the entrance never replays", async () => {
    const { rerender } = render(<UpdateBanner appUpdate={update("available")} />);
    await settle();
    const slot = document.querySelector(".update-banner-slot");
    rerender(<UpdateBanner appUpdate={update("installing", 42)} />);
    expect(document.querySelector(".update-banner-slot")).toBe(slot);
    const bar = screen.getByRole("progressbar", { name: "Downloading update" });
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(bar.querySelector<HTMLElement>(".lvl-fill")?.style.width).toBe("42%");
    // The builder runs at the front of the fill.
    expect(bar.querySelector<HTMLElement>(".lvl-meter")?.style.getPropertyValue("--pct")).toBe(
      "42",
    );
  });

  it("reads Updated! and bursts at 100%", async () => {
    render(<UpdateBanner appUpdate={update("installing", 100)} />);
    await settle();
    const bar = screen.getByRole("progressbar", { name: "Update installed. Restarting." });

    expect(bar.classList.contains("is-done")).toBe(true);
    expect(bar.querySelectorAll(".lvl-burst i").length).toBeGreaterThan(0);
    expect(bar.querySelector(".lvl-meter")).toBeNull();
  });

  it("says when the install failed, and offers retry and a manual download", () => {
    const appUpdate = { ...update("error"), error: "Permission denied" };
    render(<UpdateBanner appUpdate={appUpdate} />);
    const alert = screen.getByRole("alert");

    expect(alert.textContent).toContain("Update failed");
    expect(alert.textContent).not.toContain("Permission denied");
    expect(alert.querySelector(".ub-error-text")?.getAttribute("title")).toBe("Permission denied");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(appUpdate.install).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Download manually" }));
    expect(openUrl).toHaveBeenCalledWith(
      "https://github.com/KenKaiii/gg-framework/releases/latest",
    );
  });
});
