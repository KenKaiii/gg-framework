// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PANE_DRAG_MIME, PaneDropOverlay, hasPaneDragMarker } from "./PaneDropOverlay";

function transfer(types = [PANE_DRAG_MIME]): DataTransfer {
  return { types, dropEffect: "none" } as unknown as DataTransfer;
}

function renderOverlay(overrides: Partial<React.ComponentProps<typeof PaneDropOverlay>> = {}) {
  const props: React.ComponentProps<typeof PaneDropOverlay> = {
    enabled: true,
    sourcePaneId: "pane-2",
    targetPaneId: "pane-1",
    hoveredPlacement: null,
    onHover: vi.fn(),
    onDrop: vi.fn(),
    onReject: vi.fn(),
    ...overrides,
  };
  return { props, view: render(<PaneDropOverlay {...props} />) };
}

describe("PaneDropOverlay", () => {
  it.each(["left", "right", "up", "down"] as const)(
    "dispatches one pane-neutral move from the %s zone",
    (placement) => {
      const { props, view } = renderOverlay();
      const zone = view.container.querySelector(`[data-placement="${placement}"]`)!;

      fireEvent.drop(zone, { dataTransfer: transfer() });

      expect(props.onDrop).toHaveBeenCalledOnce();
      expect(props.onDrop).toHaveBeenCalledWith({
        sourcePaneId: "pane-2",
        targetPaneId: "pane-1",
        placement,
      });
    },
  );

  it("accepts marked pane drags on hover and advertises move semantics", () => {
    const { props, view } = renderOverlay();
    const zone = view.container.querySelector('[data-placement="right"]')!;
    const dataTransfer = transfer();

    expect(fireEvent.dragOver(zone, { dataTransfer })).toBe(false);

    expect(dataTransfer.dropEffect).toBe("move");
    expect(props.onHover).toHaveBeenCalledWith("pane-1", "right");
  });

  it("filters external MIME payloads without consuming them", () => {
    const { props, view } = renderOverlay();
    const zone = view.container.querySelector('[data-placement="left"]')!;

    expect(fireEvent.dragOver(zone, { dataTransfer: transfer(["Files"]) })).toBe(true);
    expect(fireEvent.drop(zone, { dataTransfer: transfer(["Files"]) })).toBe(true);

    expect(props.onHover).not.toHaveBeenCalled();
    expect(props.onDrop).not.toHaveBeenCalled();
    expect(props.onReject).not.toHaveBeenCalled();
  });

  it("rejects marked self drops", () => {
    const { props, view } = renderOverlay({ sourcePaneId: "pane-1" });
    const zone = view.container.querySelector('[data-placement="left"]')!;

    expect(fireEvent.drop(zone, { dataTransfer: transfer() })).toBe(false);

    expect(props.onDrop).not.toHaveBeenCalled();
    expect(props.onReject).toHaveBeenCalledOnce();
  });

  it("recognizes only the pane drag MIME marker", () => {
    expect(hasPaneDragMarker(transfer())).toBe(true);
    expect(hasPaneDragMarker(transfer(["text/plain", "Files"]))).toBe(false);
  });
});
