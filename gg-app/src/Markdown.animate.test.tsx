// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

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

  it("renders no word spans once the stream has settled", () => {
    const { container } = render(<Markdown>{"finished reply"}</Markdown>);
    expect(container.querySelectorAll(".md-word")).toHaveLength(0);
  });
});
