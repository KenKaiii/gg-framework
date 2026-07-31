import type { DragEvent } from "react";
import type { PaneMoveRequest, PanePlacement } from "./workspace-layout";

export const PANE_DRAG_MIME = "application/x-gg-workspace-pane";

const PLACEMENTS: readonly PanePlacement[] = ["left", "right", "up", "down"];

export interface PaneDropOverlayProps {
  enabled: boolean;
  sourcePaneId: string;
  targetPaneId: string;
  hoveredPlacement: PanePlacement | null;
  onHover: (targetPaneId: string, placement: PanePlacement | null) => void;
  onDrop: (request: PaneMoveRequest) => void;
  onReject: () => void;
}

export function hasPaneDragMarker(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types ?? []).includes(PANE_DRAG_MIME);
}

export function PaneDropOverlay({
  enabled,
  sourcePaneId,
  targetPaneId,
  hoveredPlacement,
  onHover,
  onDrop,
  onReject,
}: PaneDropOverlayProps): React.ReactElement {
  const validTarget = enabled && sourcePaneId !== targetPaneId;

  const accepts = (event: DragEvent<HTMLElement>): boolean =>
    validTarget && hasPaneDragMarker(event.dataTransfer);

  const enter = (event: DragEvent<HTMLDivElement>, placement: PanePlacement): void => {
    if (!accepts(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    onHover(targetPaneId, placement);
  };

  const leave = (event: DragEvent<HTMLDivElement>, placement: PanePlacement): void => {
    if (!accepts(event)) return;
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    if (hoveredPlacement === placement) onHover(targetPaneId, null);
  };

  const drop = (event: DragEvent<HTMLDivElement>, placement: PanePlacement): void => {
    if (!accepts(event)) {
      if (hasPaneDragMarker(event.dataTransfer)) {
        event.preventDefault();
        event.stopPropagation();
        onReject();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onDrop({ sourcePaneId, targetPaneId, placement });
  };

  return (
    <div
      className={`pane-drop-overlay${validTarget ? "" : " pane-drop-overlay-inert"}`}
      data-hovered-placement={validTarget ? (hoveredPlacement ?? undefined) : undefined}
      aria-hidden="true"
    >
      {PLACEMENTS.map((placement) => (
        <div
          key={placement}
          className={`pane-drop-zone pane-drop-zone-${placement}`}
          data-placement={placement}
          onDragEnter={(event) => enter(event, placement)}
          onDragOver={(event) => enter(event, placement)}
          onDragLeave={(event) => leave(event, placement)}
          onDrop={(event) => drop(event, placement)}
        />
      ))}
    </div>
  );
}
