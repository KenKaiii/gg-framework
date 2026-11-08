// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { openUrl, openProjectPath } = vi.hoisted(() => ({
  openUrl: vi.fn(),
  openProjectPath: vi.fn(),
}));
vi.mock("./agent", () => ({ openProjectPath, openUrl, sendPrompt: vi.fn() }));

import { Markdown } from "./Markdown";
import { displayStreamingMarkdown } from "./streaming-markdown";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("markdown links", () => {
  it("renders a half-streamed link as a link that goes nowhere when clicked", () => {
    render(<Markdown>{displayStreamingMarkdown("see [the loader do")}</Markdown>);
    const link = screen.getByText("the loader do").closest("a");
    expect(link).not.toBeNull();
    // An empty href would reload the whole app window if followed.
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
    expect(openProjectPath).not.toHaveBeenCalled();
  });

  it("still opens a finished external link in the browser", () => {
    render(<Markdown>{"see [docs](https://example.com/loader)"}</Markdown>);
    fireEvent.click(screen.getByText("docs"));
    expect(openUrl).toHaveBeenCalledWith("https://example.com/loader");
  });
});
