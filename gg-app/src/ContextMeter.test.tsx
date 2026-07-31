// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContextMeter, getContextPercent } from "./ContextMeter";
import { theme } from "./theme";

function cssColor(color: string): string {
  const element = document.createElement("span");
  element.style.color = color;
  return element.style.color;
}

describe("ContextMeter", () => {
  it("renders Azure context usage of 12,806 in a 1,050,000-token window as 1%", () => {
    const pct = getContextPercent(12_806, 1_050_000);

    render(<ContextMeter pct={pct} />);

    const meter = screen.getByText("1%");
    expect(meter.getAttribute("title")).toBe("Context used: 1%");
    expect((meter as HTMLElement).style.color).toBe(cssColor(theme.success));
  });

  it("scales the footer label and pressure color for higher context usage", () => {
    const pct = getContextPercent(766_500, 1_050_000);

    render(<ContextMeter pct={pct} />);

    const meter = screen.getByText("73%");
    expect(meter.getAttribute("title")).toBe("Context used: 73%");
    expect((meter as HTMLElement).style.color).toBe(cssColor(theme.warning));
  });
});
