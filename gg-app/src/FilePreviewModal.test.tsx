// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { readPreviewFile, openProjectPath } = vi.hoisted(() => ({
  readPreviewFile: vi.fn(),
  openProjectPath: vi.fn(),
}));
vi.mock("./agent", () => ({
  readPreviewFile,
  openProjectPath,
  openUrl: vi.fn(),
  readChatImage: vi.fn(),
  sendPrompt: vi.fn(),
}));

import { FilePreviewHost } from "./FilePreviewModal";
import { autoPreviewEnabled, closeFilePreview, openFilePreview } from "./file-preview";

afterEach(() => {
  act(() => closeFilePreview());
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("FilePreviewHost", () => {
  it("renders nothing until a preview is requested", () => {
    const { container } = render(<FilePreviewHost />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a markdown document", async () => {
    readPreviewFile.mockResolvedValue({
      kind: "markdown",
      mediaType: "text/markdown",
      name: "report.md",
      path: "/p/report.md",
      text: "# Quarterly report\n\nAll good.",
    });
    render(<FilePreviewHost />);
    act(() => openFilePreview("/p/report.md"));
    expect(await screen.findByRole("heading", { name: "Quarterly report" })).toBeTruthy();
    expect(readPreviewFile).toHaveBeenCalledWith("/p/report.md");
    expect(screen.getByRole("dialog", { name: "report.md" })).toBeTruthy();
  });

  it("shows an image from its data", async () => {
    readPreviewFile.mockResolvedValue({
      kind: "image",
      mediaType: "image/png",
      name: "shot.png",
      path: "/p/shot.png",
      data: "iVBORw0KGgo=",
    });
    render(<FilePreviewHost />);
    act(() => openFilePreview("/p/shot.png"));
    const img = await screen.findByRole("img", { name: "shot.png" });
    expect(img.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("plays a video and shows a pdf from blob URLs, freeing them on close", async () => {
    const create = vi.fn(() => "blob:mock-1");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    readPreviewFile.mockResolvedValue({
      kind: "pdf",
      mediaType: "application/pdf",
      name: "doc.pdf",
      path: "/p/doc.pdf",
      data: btoa("%PDF-1.4"),
    });
    render(<FilePreviewHost />);
    act(() => openFilePreview("/p/doc.pdf"));
    const frame = await screen.findByTitle("doc.pdf");
    expect(frame.getAttribute("src")).toBe("blob:mock-1");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(revoke).toHaveBeenCalledWith("blob:mock-1");
  });

  it("explains a failure and offers the default app", async () => {
    readPreviewFile.mockRejectedValue(new Error("too large to preview (90 MB)"));
    render(<FilePreviewHost />);
    act(() => openFilePreview("/p/big.mp4"));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Couldn't preview this file: too large to preview (90 MB)",
    );
    fireEvent.click(screen.getByRole("button", { name: /Open in default app/ }));
    expect(openProjectPath).toHaveBeenCalledWith("/p/big.mp4");
  });

  it("lets the user turn off auto-open", async () => {
    readPreviewFile.mockRejectedValue(new Error("x"));
    render(<FilePreviewHost />);
    act(() => openFilePreview("/p/a.md"));
    const box = await screen.findByRole("checkbox", { name: /Open new documents automatically/ });
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    expect(autoPreviewEnabled()).toBe(false);
  });
});
