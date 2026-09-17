// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

vi.mock("./agent", () => ({ openProjectPath: vi.fn(), sendPrompt: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { Markdown } from "./Markdown";

describe("Markdown streaming animation", () => {
  it("wraps only the trailing block's words while animating", async () => {
    const { container } = render(<Markdown animate>{"first para\n\nsecond para"}</Markdown>);
    await waitFor(() => expect(container.querySelectorAll("p")).toHaveLength(2));
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs[0].querySelectorAll(".md-word")).toHaveLength(0);
    expect(paragraphs[1].querySelectorAll(".md-word")).toHaveLength(2);
  });

  it("renders no word spans once the stream has settled", async () => {
    const { container } = render(<Markdown>{"finished reply"}</Markdown>);
    await waitFor(() => expect(container.querySelector("p")?.textContent).toBe("finished reply"));
    expect(container.querySelectorAll(".md-word")).toHaveLength(0);
  });
});
