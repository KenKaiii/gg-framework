import { describe, expect, it } from "vitest";
import { dockStepped, nextDockHeight } from "./dock-height";

/** A dock at `layout` CSS px whose viewport rect is scaled by the page zoom. */
function dock(
  layout: number,
  zoom = 1,
): { offsetHeight: number; getBoundingClientRect: () => { height: number } } {
  return { offsetHeight: layout, getBoundingClientRect: () => ({ height: layout * zoom }) };
}

describe("nextDockHeight", () => {
  it("writes a new height", () => {
    expect(nextDockHeight(dock(172), "160px")).toBe("172px");
  });

  it("leaves an unchanged height alone", () => {
    expect(nextDockHeight(dock(160), "160px")).toBeNull();
  });

  it("keeps the last height while the dock is hidden (measures 0)", () => {
    expect(nextDockHeight(dock(0), "160px")).toBeNull();
  });

  // Regression: the zoomed viewport rect was written back as a CSS length and
  // zoomed again, so zooming out left the transcript under the composer.
  it("uses layout pixels, not the zoomed viewport rect", () => {
    expect(nextDockHeight(dock(150, 0.8), "0px")).toBe("150px");
    expect(nextDockHeight(dock(150, 1.2), "150px")).toBeNull();
  });
});

describe("dockStepped", () => {
  // Regression: opening a Deck panel or deleting a draft moved every message
  // the whole way in one frame, because the observer only ever followed.
  it("calls a jump of a panel or a wrapped draft a step", () => {
    expect(dockStepped("133px", "188px")).toBe(true);
    expect(dockStepped("236px", "133px")).toBe(true);
  });

  it("follows the small frames of a strip easing open", () => {
    expect(dockStepped("133px", "141px")).toBe(false);
    expect(dockStepped("141px", "162px")).toBe(false);
  });

  it("does not glide in from the first measurement", () => {
    expect(dockStepped("", "133px")).toBe(false);
  });
});
