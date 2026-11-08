// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PlanDecision } from "../transcript-item";
import { PlanDecisionNotice, describePlanDecision } from "./PlanDecisionNotice";

afterEach(cleanup);

describe("describePlanDecision", () => {
  it.each<[PlanDecision, RegExp]>([
    ["accepted", /accepted.*implementing/i],
    ["feedback", /feedback.*revising/i],
    ["rejected", /rejected/i],
  ])("gives %s its line", (decision, pattern) => {
    expect(describePlanDecision(decision)).toMatch(pattern);
  });
});

describe("PlanDecisionNotice", () => {
  it("marks an accepted plan as work in progress", () => {
    render(<PlanDecisionNotice decision="accepted" />);
    expect(screen.getByRole("status").textContent).toContain("Plan accepted");
    expect(screen.getByRole("img", { name: "Working" })).toBeTruthy();
  });

  it("marks a rejected plan as stopped", () => {
    render(<PlanDecisionNotice decision="rejected" />);
    expect(screen.getByRole("img", { name: "Stopped" })).toBeTruthy();
    expect(screen.getByText("Plan rejected. Nothing was built.").className).toBe(
      "placeholder-muted",
    );
  });
});
