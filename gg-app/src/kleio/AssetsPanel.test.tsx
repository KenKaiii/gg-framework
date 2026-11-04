// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { AssetsPanel, type Asset } from "./AssetsPanel";
import { FileViewerProvider } from "./FileViewerProvider";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// The panel's chrome (its radio button) and the viewer's Markdown reach the Tauri bridge on import.
vi.mock("../agent", () => ({ openProjectPath: vi.fn(), sendPrompt: vi.fn() }));

const OWNER = { kind: "blob", blobId: "b_1234abcd" } as const;
const ASSETS: readonly Asset[] = [
  { owner: OWNER, path: "out/findings.pdf", label: "The findings", by: "Chef" },
  { owner: OWNER, path: "site/index.html", label: "The menu site", by: "Chef" },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPanel(onError = vi.fn()): void {
  render(
    <FileViewerProvider>
      <AssetsPanel assets={ASSETS} onError={onError} />
    </FileViewerProvider>,
  );
}

describe("AssetsPanel", () => {
  it("opens a row's file in the viewer, asked of the host as the specialist's", async () => {
    // The host is still readying the show: the viewer says it's opening.
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Open The findings, shared by Chef" }));
    expect(await screen.findByRole("dialog", { name: "The findings" })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("kleio_api", {
      method: "POST",
      path: "/kleio/voice/show",
      body: { source: "specialist", id: "b_1234abcd", path: "out/findings.pdf" },
      session: null,
    });
  });

  it("opens a web page's row as a site, and words its errors as a site's", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("not found"));
    const onError = vi.fn();
    renderPanel(onError);
    fireEvent.click(screen.getByRole("button", { name: "Open The menu site, shared by Chef" }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("Your host needs an update to open sites."),
    );
    expect(invoke).toHaveBeenCalledWith("kleio_site_open", {
      owner: OWNER,
      path: "site/index.html",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
