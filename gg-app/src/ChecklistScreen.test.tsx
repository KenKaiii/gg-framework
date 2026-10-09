// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChecklistScreen, type ChecklistLoad } from "./ChecklistScreen";
import type { ChecklistEntry } from "./agent";
import { TooltipLayer } from "./TooltipLayer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function item(id: string, overrides: Partial<ChecklistEntry> = {}): ChecklistEntry {
  return {
    id,
    title: id === "git-github" ? "Git & GitHub" : id,
    group: "Foundations",
    description: "An example check",
    check: "Inspect the project",
    skill: null,
    setupCommand: null,
    status: "not-run",
    checkedAt: null,
    commit: null,
    uncommittedChanges: false,
    result: null,
    summary: null,
    findings: [],
    evidence: [],
    runPrompt: `Check ${id} without editing files`,
    ...overrides,
  };
}
function ready(items: ChecklistEntry[]): ChecklistLoad {
  return { kind: "ready", snapshot: { staleAfterDays: 30, items, detectionWarnings: [] } };
}
function props(load: ChecklistLoad) {
  return {
    load,
    running: false,
    activeId: null,
    notice: null,
    onRun: vi.fn(),
    onRetry: vi.fn(),
  };
}

describe("ChecklistScreen", () => {
  it("shows setup detection separately from an unrun review, with no health score or modal", () => {
    render(
      <ChecklistScreen
        {...props(
          ready([
            item("git-github", {
              group: "Source control",
              detection: { summary: "Git initialized", facts: ["Git repository initialized"] },
            }),
            item("tests", { group: "Code quality" }),
          ]),
        )}
      />,
    );
    expect(screen.getByRole("region", { name: "Project checklist" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Git initialized · Not reviewed")).toBeTruthy();
    expect(screen.getByText("Not reviewed")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Source control" })).toBeTruthy();
    expect(screen.queryByText(/up to date/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to chat" })).toBeNull();
  });
  it.each([
    ["not-run", "Not reviewed"],
    ["passed", "Checked 5 Oct 2026"],
    ["due", "Review due"],
    ["needs-work", "1 finding reported"],
    ["not-applicable", "Not applicable"],
  ] as const)("gives %s its own visual state without relying on color alone", (status, label) => {
    render(
      <ChecklistScreen
        {...props(
          ready([
            item("tests", {
              status,
              checkedAt: status === "not-run" ? null : "2026-10-05T09:00:00Z",
              result: status === "needs-work" ? "issues" : status === "not-run" ? null : "pass",
              findings: status === "needs-work" ? ["A finding"] : [],
            }),
          ]),
        )}
      />,
    );
    const info = screen.getByRole("group", { name: "tests" });
    expect(info.closest(".checklist-entry")?.getAttribute("data-state")).toBe(status);
    expect(within(info).getByText(label)).toBeTruthy();
    expect(info.querySelector(".checklist-entry-icon")?.getAttribute("aria-hidden")).toBe("true");
  });
  it("marks findings recorded before the code changed instead of showing them as current", () => {
    const findings: Partial<ChecklistEntry> = {
      status: "needs-work",
      checkedAt: "2026-10-05T09:00:00Z",
      result: "issues",
      findings: ["a.ts:1", "b.ts:2"],
    };
    render(
      <ChecklistScreen
        {...props(
          ready([
            item("tests", { ...findings, changedSinceCheck: true }),
            item("docs", { ...findings, changedSinceCheck: false }),
          ]),
        )}
      />,
    );
    const tests = screen.getByRole("group", { name: "tests" });
    const docs = screen.getByRole("group", { name: "docs" });
    expect(
      within(tests).getByText("2 findings reported · Code changed since, check again"),
    ).toBeTruthy();
    expect(within(docs).getByText("2 findings reported")).toBeTruthy();
  });
  it("notes findings the owner accepted on a passed item", () => {
    render(
      <ChecklistScreen
        {...props(
          ready([
            item("tests", {
              status: "passed",
              checkedAt: "2026-10-05T09:00:00Z",
              result: "pass",
              accepted: ["god files (deferred by owner)"],
            }),
          ]),
        )}
      />,
    );
    const tests = screen.getByRole("group", { name: "tests" });
    expect(within(tests).getByText("Checked 5 Oct 2026 · 1 accepted as is")).toBeTruthy();
  });

  it("overrides a previous pass while checking or displaying an unrecorded-run notice", () => {
    const p = props(
      ready([
        item("tests", { status: "passed", result: "pass", checkedAt: "2026-10-05T09:00:00Z" }),
      ]),
    );
    const view = render(<ChecklistScreen {...p} running activeId="tests" />);
    const info = screen.getByRole("group", { name: "tests" });
    expect(info.closest(".checklist-entry")?.getAttribute("data-state")).toBe("checking");
    expect(within(info).getByText("Checking…")).toBeTruthy();
    view.rerender(
      <ChecklistScreen
        {...p}
        notice={{ id: "tests", checkedAt: "2026-10-05T09:00:00Z", message: "No result recorded." }}
      />,
    );
    expect(info.closest(".checklist-entry")?.getAttribute("data-state")).toBe("needs-work");
    expect(within(info).getByText("No result recorded.")).toBeTruthy();
  });
  it("makes Agent setup's file-writing /init workflow explicit", () => {
    render(<ChecklistScreen {...props(ready([item("agent-setup"), item("tests")]))} />);
    expect(screen.getByRole("button", { name: "Check agent-setup" }).title).toBe(
      "Run /init to create or update project instructions",
    );
    expect(screen.getByRole("button", { name: "Check tests" }).title).toBe(
      "Check and report, then choose what to fix",
    );
  });
  it("keeps rows non-expanding and preserves the Check action and busy state", () => {
    const entry = item("tests");
    const onRun = vi.fn();
    const view = render(<ChecklistScreen {...props(ready([entry]))} onRun={onRun} />);
    const info = screen.getByRole("group", { name: "tests" });
    expect(info.title).toBe(entry.description);
    expect(info.hasAttribute("aria-expanded")).toBe(false);
    fireEvent.click(info);
    expect(document.querySelector(".checklist-entry-details")).toBeNull();
    expect(screen.queryByText(entry.description)).toBeNull();
    expect(onRun).not.toHaveBeenCalled();
    const check = screen.getByRole("button", { name: "Check tests" });
    fireEvent.click(check);
    expect(onRun).toHaveBeenCalledWith(entry);
    expect(screen.queryByText("An example check")).toBeNull();
    view.rerender(
      <ChecklistScreen {...props(ready([entry]))} onRun={onRun} running activeId="tests" />,
    );
    expect(screen.getByRole("button", { name: "Check tests" })).toBe(check);
    expect(check.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
    fireEvent.click(check);
    expect(onRun).toHaveBeenCalledTimes(1);
    view.rerender(
      <ChecklistScreen
        {...props(
          ready([
            item("tests", { status: "passed", result: "pass", checkedAt: "2026-10-05T09:00:00Z" }),
          ]),
        )}
      />,
    );
    expect(screen.getByText("Checked 5 Oct 2026")).toBeTruthy();
    expect(screen.queryByText("An example check")).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole("group", { name: "tests" }));
  });
  it("shows just the purpose hint on hover or keyboard focus, with Escape dismissal", () => {
    vi.useFakeTimers();
    const entry = item("security", {
      description: "I use this to look for security holes before shipping.",
      status: "needs-work",
      result: "issues",
      checkedAt: "2026-10-05T09:00:00Z",
      commit: "abc1234",
      uncommittedChanges: true,
      summary: "Login review",
      findings: ["auth.ts:4: missing check"],
      evidence: ["Scope: login", "Not checked: uploads", "Read auth.ts"],
    });
    render(
      <>
        <TooltipLayer />
        <ChecklistScreen {...props(ready([entry]))} />
      </>,
    );
    const info = screen.getByRole("group", { name: "security" });
    expect(info.tabIndex).toBe(0);
    expect(screen.getByText("1 finding reported")).toBeTruthy();
    fireEvent.pointerOver(info);
    fireEvent.pointerMove(info);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(450);
    });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toBe(entry.description);
    expect(info.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(screen.queryByText("Scope: login")).toBeNull();
    expect(screen.queryByText("Read auth.ts")).toBeNull();
    expect(document.querySelector(".checklist-entry-details")).toBeNull();

    fireEvent.keyDown(info, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.keyDown(document, { key: "Tab" });
    act(() => {
      info.focus();
    });
    expect(screen.getByRole("tooltip").textContent).toBe(entry.description);
    fireEvent.keyDown(info, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(document.activeElement).toBe(info);

    fireEvent.pointerDown(info);
    expect(document.activeElement).not.toBe(info);
  });
  it("uses Settings tabs with keyboard navigation, named panels and fresh scroll positions", () => {
    render(
      <ChecklistScreen
        {...props(
          ready([
            item("security", { status: "due", result: "issues", findings: ["a finding"] }),
            item("docs", { status: "passed", result: "pass" }),
          ]),
        )}
      />,
    );
    const tabs = screen.getByRole("tablist", { name: "Checklist views" });
    const all = within(tabs).getByRole("tab", { name: "All checks" });
    const review = within(tabs).getByRole("tab", { name: "Needs review" });
    const findings = within(tabs).getByRole("tab", { name: "Findings" });
    expect(all.getAttribute("aria-selected")).toBe("true");
    expect(tabs.querySelector(".settings-tabs-pill.is-placed")).not.toBeNull();
    const firstPanel = screen.getByRole("tabpanel", { name: "All checks" });
    expect(all.getAttribute("aria-controls")).toBe(firstPanel.id);
    expect(firstPanel.getAttribute("aria-labelledby")).toBe(all.id);
    expect(firstPanel.tabIndex).toBe(0);
    firstPanel.scrollTop = 240;

    fireEvent.keyDown(all, { key: "ArrowRight" });
    expect(document.activeElement).toBe(review);
    expect(review.getAttribute("aria-selected")).toBe("true");
    const reviewPanel = screen.getByRole("tabpanel", { name: "Needs review" });
    expect(reviewPanel).not.toBe(firstPanel);
    expect(reviewPanel.scrollTop).toBe(0);
    expect(screen.queryByRole("button", { name: "Check docs" })).toBeNull();
    expect(screen.queryByText("An example check")).toBeNull();

    fireEvent.keyDown(review, { key: "End" });
    expect(document.activeElement).toBe(findings);
    expect(screen.getByRole("tabpanel", { name: "Findings" })).toBeTruthy();
    fireEvent.keyDown(findings, { key: "ArrowRight" });
    expect(document.activeElement).toBe(all);
    expect(screen.getByRole("button", { name: "Check docs" })).toBeTruthy();
    expect(
      within(tabs)
        .getAllByRole("tab")
        .filter((tab) => tab.tabIndex === 0),
    ).toEqual([all]);
  });

  it("retains issues in the findings filter even when the review is due", () => {
    render(
      <ChecklistScreen
        {...props(
          ready([
            item("security", { status: "due", result: "issues", findings: ["a finding"] }),
            item("docs", { status: "passed", result: "pass" }),
          ]),
        )}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
    expect(screen.getByRole("button", { name: "Check security" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check docs" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Needs review" }));
    expect(screen.getByRole("button", { name: "Check security" })).toBeTruthy();
  });
  it("has loading, error/retry and no-findings states", () => {
    const p = props({ kind: "loading" });
    const view = render(<ChecklistScreen {...p} />);
    expect(screen.getByRole("status").textContent).toContain("Reading project setup");
    view.rerender(<ChecklistScreen {...p} load={{ kind: "error" }} />);
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Try again" }));
    expect(p.onRetry).toHaveBeenCalledOnce();
    view.rerender(<ChecklistScreen {...p} load={ready([item("docs")])} />);
    fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("No recorded findings.");
    expect(status.classList.contains("checklist-empty")).toBe(true);
    expect(status.closest(".checklist-page.is-empty")).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "All checks" }));
    expect(document.querySelector(".checklist-page.is-empty")).toBeNull();
    expect(screen.queryByText("No recorded findings.")).toBeNull();
  });
  it("does not mark an unrecorded run complete", () => {
    render(
      <ChecklistScreen
        {...props(ready([item("tests")]))}
        notice={{
          id: "tests",
          checkedAt: null,
          message: "No result recorded. View the conversation for details.",
        }}
      />,
    );
    expect(screen.getByText(/No result recorded/)).toBeTruthy();
    expect(screen.queryByText(/Checked /)).toBeNull();
  });
});
