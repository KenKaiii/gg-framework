// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getSettings, saveSettings } from "./agent";
import { EmbeddedModal } from "./modal-embed";
import { SettingsModal } from "./SettingsModal";

vi.mock("./agent", () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  getPermissionsStatus: vi.fn(() => Promise.resolve({ applicable: false, granted: false })),
  openPermissionsSettings: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./SoundButton", () => ({ SoundButton: () => null }));
vi.mock("./AppearancePicker", () => ({ AppearancePicker: () => null }));
vi.mock("./HomeBackgroundButton", () => ({ HomeBackgroundButton: () => null }));
vi.mock("./KeepAwakeButton", () => ({ KeepAwakeButton: () => null }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderPage(): Promise<HTMLInputElement> {
  render(
    <EmbeddedModal>
      <SettingsModal onClose={vi.fn()} />
    </EmbeddedModal>,
  );
  const field = (await screen.findByDisplayValue("/Users/me/gg-projects")) as HTMLInputElement;
  return field;
}

describe("SettingsModal project folder", () => {
  it("saves the shown default folder when it was never saved (issue #125)", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      projectsRoot: "/Users/me/gg-projects",
      configured: false,
    });
    vi.mocked(saveSettings).mockResolvedValue();
    const field = await renderPage();
    expect(screen.getByText(/Not saved yet/)).toBeDefined();
    fireEvent.blur(field);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith("/Users/me/gg-projects"));
    await waitFor(() => expect(screen.getByText("Where new projects are created.")).toBeDefined());
  });

  it("doesn't re-save an unchanged folder that is already saved", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      projectsRoot: "/Users/me/gg-projects",
      configured: true,
    });
    const field = await renderPage();
    fireEvent.blur(field);
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
