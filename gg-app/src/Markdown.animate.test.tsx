// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act, render } from "@testing-library/react";

vi.mock("./agent", () => ({
  openProjectPath: vi.fn(),
  openUrl: vi.fn(),
  sendPrompt: vi.fn(),
}));

import { Markdown } from "./Markdown";

describe("Markdown streaming animation", () => {
  it("wraps only the trailing block's words while animating", () => {
    const { container } = render(<Markdown animate>{"first para\n\nsecond para"}</Markdown>);
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs[0].querySelectorAll(".md-word")).toHaveLength(0);
    expect(paragraphs[1].querySelectorAll(".md-word")).toHaveLength(2);
  });

  it("lets a finished block's last words finish fading before dropping its spans", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<Markdown animate>{"first para"}</Markdown>);
      // A new block starts below while the first is still fading in.
      rerender(<Markdown animate>{"first para\n\nsecond"}</Markdown>);
      const first = (): Element | undefined => container.querySelectorAll("p")[0];
      // Dropping the spans now would snap "para" solid mid-fade.
      expect(first()?.querySelectorAll(".md-word")).toHaveLength(2);

      act(() => {
        vi.advanceTimersByTime(500);
      });
      rerender(<Markdown animate>{"first para\n\nsecond para"}</Markdown>);
      expect(first()?.querySelectorAll(".md-word")).toHaveLength(0);
      expect(container.querySelectorAll("p")[1]?.querySelectorAll(".md-word")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders no word spans once the stream has settled", () => {
    const { container } = render(<Markdown>{"finished reply"}</Markdown>);
    expect(container.querySelectorAll(".md-word")).toHaveLength(0);
  });
});
