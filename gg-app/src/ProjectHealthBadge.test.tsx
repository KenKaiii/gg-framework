// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectHealthBadge } from "./ProjectHealthBadge";
import { parseProjectHealth, projectHealthTier, type ProjectHealth } from "./project-health";

const health: ProjectHealth = {
  score: 64,
  fixPrompt: "REVIEW ALL",
  cappedBy: null,
  truncated: false,
  categories: [
    {
      id: "files",
      label: "File size",
      score: 40,
      summary: "2 files over 800 lines",
      findings: ["src/App.tsx · 2,400 lines", "src/agent.ts · 1,100 lines"],
      fixPrompt: "REVIEW FILES",
    },
    {
      id: "debt",
      label: "Debt markers",
      score: null,
      summary: "No source files found",
      findings: [],
      fixPrompt: null,
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("projectHealthTier", () => {
  it.each([
    [0, "poor"],
    [49, "poor"],
    [50, "fair"],
    [79, "fair"],
    [80, "healthy"],
    [100, "healthy"],
  ] as const)("%i is %s", (score, tier) => {
    expect(projectHealthTier(score)).toBe(tier);
  });
});

describe("parseProjectHealth", () => {
  it("accepts a sidecar payload", () => {
    expect(parseProjectHealth(JSON.parse(JSON.stringify(health)))).toEqual(health);
  });

  it.each([
    ["null", null],
    ["score out of range", { ...health, score: 140 }],
    ["fractional score", { ...health, score: 64.5 }],
    ["unknown category", { ...health, categories: [{ ...health.categories[0], id: "vibes" }] }],
    [
      "retired checklist category",
      { ...health, categories: [{ ...health.categories[0], id: "checklist" }] },
    ],
    ["non-string finding", { ...health, categories: [{ ...health.categories[0], findings: [3] }] }],
    ["missing truncated", { score: 64, categories: [] }],
    ["oversized prompt", { ...health, fixPrompt: "x".repeat(40_001) }],
    ["missing cappedBy", { ...health, cappedBy: undefined }],
  ])("rejects %s", (_name, value) => {
    expect(parseProjectHealth(value)).toBeNull();
  });
});

describe("ProjectHealthBadge", () => {
  it("shows the colour-coded percentage and opens a breakdown", () => {
    render(<ProjectHealthBadge health={health} onReview={() => true} />);
    const badge = screen.getByRole("button", { name: /Project health 64%, Getting there/ });
    expect(badge.textContent).toBe("64%");
    expect(badge.getAttribute("data-tier")).toBe("fair");
    expect(badge.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(badge);
    const dialog = screen.getByRole("dialog", { name: "Project health: 64%" });
    expect(badge.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.textContent).toContain("2 files over 800 lines");
    expect(dialog.textContent).toContain("src/App.tsx");
    expect(dialog.textContent).toContain("2,400 lines");
    expect(dialog.textContent).toContain("Not scored");
    // Review all is the only footer action: the Checklist isn't part of health.
    expect(dialog.textContent).not.toContain("Checklist");
    const footer = dialog.querySelector("footer");
    expect(
      Array.from(footer?.querySelectorAll("button") ?? [], (button) => button.textContent),
    ).toEqual(["Review all"]);
  });

  it("sends a category or everything to the agent, and stays open if it can't", () => {
    const onReview = vi.fn<(prompt: string, label: string) => boolean>(() => true);
    render(<ProjectHealthBadge health={health} onReview={onReview} />);
    const badge = screen.getByRole("button", { name: /Project health/ });

    fireEvent.click(badge);
    // Only categories with something to fix get a button.
    expect(screen.queryByRole("button", { name: "Review Debt markers with the agent" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review File size with the agent" }));
    expect(onReview).toHaveBeenLastCalledWith("REVIEW FILES", "Reviewing File size");
    expect(badge.getAttribute("aria-expanded")).toBe("false");

    onReview.mockReturnValue(false);
    fireEvent.click(badge);
    fireEvent.click(screen.getByRole("button", { name: "Review all" }));
    expect(onReview).toHaveBeenLastCalledWith("REVIEW ALL", "Reviewing project health");
    expect(badge.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Agent not ready. Try again.");
  });

  it("explains a capped score", () => {
    render(
      <ProjectHealthBadge health={{ ...health, score: 40, cappedBy: "1 secret is committed" }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Project health 40%/ }));
    expect(screen.getByRole("dialog").textContent).toContain("Held at 40%: 1 secret is committed.");
  });

  it("closes on Escape and returns focus to the badge", () => {
    render(<ProjectHealthBadge health={health} />);
    const badge = screen.getByRole("button", { name: /Project health/ });
    fireEvent.click(badge);
    // No review handler, no review buttons.
    expect(screen.queryByRole("button", { name: /Review/ })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(badge);
  });
});
