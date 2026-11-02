// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { openUrl, openProjectPath, readChatImage } = vi.hoisted(() => ({
  openUrl: vi.fn(),
  openProjectPath: vi.fn(),
  readChatImage: vi.fn(),
}));
vi.mock("./agent", () => ({ openProjectPath, openUrl, readChatImage, sendPrompt: vi.fn() }));

import { Markdown } from "./Markdown";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("markdown images", () => {
  it("shows a local image path by reading the file through the app", async () => {
    readChatImage.mockResolvedValue(PNG);
    render(<Markdown>{"![transcript](/tmp/gg-shell-mock/transcript.png)"}</Markdown>);
    const img = await screen.findByRole("img", { name: "transcript" });
    expect(img.getAttribute("src")).toBe(PNG);
    expect(readChatImage).toHaveBeenCalledWith("/tmp/gg-shell-mock/transcript.png");
    fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
    expect(openProjectPath).toHaveBeenCalledWith("/tmp/gg-shell-mock/transcript.png");
  });

  it("keeps file:// sources instead of blanking them", async () => {
    readChatImage.mockResolvedValue(PNG);
    render(<Markdown>{"![shot](file:///tmp/shot.png)"}</Markdown>);
    await screen.findByRole("img", { name: "shot" });
    expect(readChatImage).toHaveBeenCalledWith("file:///tmp/shot.png");
  });

  it("shows a link to the file, not a broken image, when it can't be read", async () => {
    readChatImage.mockResolvedValue(null);
    render(<Markdown>{"![mock](/tmp/missing.png)"}</Markdown>);
    expect(await screen.findByText(/Couldn't show image/)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByText("mock"));
    expect(openProjectPath).toHaveBeenCalledWith("/tmp/missing.png");
  });

  it("falls back to a link for web images, which the app's CSP blocks", () => {
    render(<Markdown>{"![chart](https://example.com/chart.png)"}</Markdown>);
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByText("chart"));
    expect(openUrl).toHaveBeenCalledWith("https://example.com/chart.png");
    expect(readChatImage).not.toHaveBeenCalled();
  });

  it("renders data: images directly", () => {
    render(<Markdown>{`![dot](${PNG})`}</Markdown>);
    expect(screen.getByRole("img", { name: "dot" }).getAttribute("src")).toBe(PNG);
    expect(readChatImage).not.toHaveBeenCalled();
  });
});
