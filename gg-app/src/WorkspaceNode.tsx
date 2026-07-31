/* eslint-disable react-hooks/refs -- The stable lifecycle dispatcher reads its ref only when a child invokes it outside render. */
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CopyPlus, GripVertical, PanelBottom, PanelRight } from "lucide-react";
import { AgentPane, type AgentPaneProps } from "./AgentPane";
import { PaneDropOverlay, PANE_DRAG_MIME } from "./PaneDropOverlay";
import { PRIMARY_PANE_ID } from "./pane-routing";
import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  workspaceLayoutLeafIds,
  type PaneMoveRequest,
  type PanePlacement,
  type SplitDirection,
  type WorkspaceLayoutNode,
  type WorkspaceLayoutPath,
  type WorkspacePaneId,
  type WorkspacePaneValue,
} from "./workspace-layout";

const DIVIDER_SIZE_PX = 7;

interface LayoutLength {
  percent: number;
  pixels: number;
}

interface LayoutRect {
  left: LayoutLength;
  top: LayoutLength;
  width: LayoutLength;
  height: LayoutLength;
}

interface PaneGeometry {
  paneId: WorkspacePaneId;
  rect: LayoutRect;
}

interface DividerGeometry {
  key: string;
  path: WorkspaceLayoutPath;
  direction: SplitDirection;
  ratio: number;
  controlledPaneIds: WorkspacePaneId[];
  rect: LayoutRect;
}

export interface WorkspaceNodeProps {
  node: WorkspaceLayoutNode;
  path?: WorkspaceLayoutPath;
  focusedPaneId: WorkspacePaneId;
  panes: Record<string, WorkspacePaneValue>;
  windowFocused: boolean;
  canSplit: boolean;
  rearrangementEnabled: boolean;
  activePaneDragSourceId: WorkspacePaneId | null;
  hoveredPaneDrop: { targetPaneId: WorkspacePaneId; placement: PanePlacement } | null;
  dragInstructionsId: string;
  renderPane?: (props: AgentPaneProps) => React.ReactNode;
  onFocusPane: (paneId: WorkspacePaneId) => void;
  onSnapshot: NonNullable<AgentPaneProps["onSnapshot"]>;
  onLifecycleError: (paneId: WorkspacePaneId, error: unknown) => void;
  registerInput: NonNullable<AgentPaneProps["registerInput"]>;
  onSplitPane: (paneId: WorkspacePaneId, direction: SplitDirection) => void;
  onCopyPane: (paneId: WorkspacePaneId) => void;
  copyingPaneId: WorkspacePaneId | null;
  closingPaneIds: ReadonlySet<WorkspacePaneId>;
  onClosePane: (paneId: WorkspacePaneId) => void;
  onPaneDragStart: (paneId: WorkspacePaneId, handle: HTMLButtonElement) => void;
  onPaneDragEnd: (paneId: WorkspacePaneId) => void;
  onPaneDropHover: (targetPaneId: WorkspacePaneId, placement: PanePlacement | null) => void;
  onPaneDrop: (request: PaneMoveRequest) => void;
  onPaneDropReject: () => void;
  onResizeByKeyboard: (
    event: React.KeyboardEvent<HTMLDivElement>,
    path: WorkspaceLayoutPath,
    direction: SplitDirection,
    ratio: number,
  ) => void;
  onStartPointerResize: (
    event: React.PointerEvent<HTMLDivElement>,
    path: WorkspaceLayoutPath,
    direction: SplitDirection,
    ratio: number,
  ) => void;
}

function addLengths(first: LayoutLength, second: LayoutLength): LayoutLength {
  return { percent: first.percent + second.percent, pixels: first.pixels + second.pixels };
}

function scaleLength(length: LayoutLength, factor: number): LayoutLength {
  return { percent: length.percent * factor, pixels: length.pixels * factor };
}

function formatLength({ percent, pixels }: LayoutLength): string {
  if (pixels === 0) return `${percent}%`;
  if (percent === 0) return `${pixels}px`;
  return `calc(${percent}% ${pixels < 0 ? "-" : "+"} ${Math.abs(pixels)}px)`;
}

function rectStyle(rect: LayoutRect): CSSProperties {
  return {
    left: formatLength(rect.left),
    top: formatLength(rect.top),
    width: formatLength(rect.width),
    height: formatLength(rect.height),
  };
}

function collectGeometry(
  node: WorkspaceLayoutNode,
  rect: LayoutRect,
  path: WorkspaceLayoutPath,
  panes: Map<WorkspacePaneId, PaneGeometry>,
  dividers: DividerGeometry[],
): void {
  if (node.type === "leaf") {
    panes.set(node.paneId, { paneId: node.paneId, rect });
    return;
  }

  dividers.push({
    key: path.length === 0 ? "root" : path.join("/"),
    path,
    direction: node.direction,
    ratio: node.ratio,
    controlledPaneIds: workspaceLayoutLeafIds(node),
    rect,
  });

  const factor = node.ratio / 100;
  if (node.direction === "horizontal") {
    const usableWidth = { ...rect.width, pixels: rect.width.pixels - DIVIDER_SIZE_PX };
    const firstWidth = scaleLength(usableWidth, factor);
    const dividerLeft = addLengths(rect.left, firstWidth);
    const secondLeft = addLengths(dividerLeft, { percent: 0, pixels: DIVIDER_SIZE_PX });
    collectGeometry(
      node.first,
      { ...rect, width: firstWidth },
      [...path, "first"],
      panes,
      dividers,
    );
    collectGeometry(
      node.second,
      {
        ...rect,
        left: secondLeft,
        width: scaleLength(usableWidth, 1 - factor),
      },
      [...path, "second"],
      panes,
      dividers,
    );
    return;
  }

  const usableHeight = { ...rect.height, pixels: rect.height.pixels - DIVIDER_SIZE_PX };
  const firstHeight = scaleLength(usableHeight, factor);
  const dividerTop = addLengths(rect.top, firstHeight);
  const secondTop = addLengths(dividerTop, { percent: 0, pixels: DIVIDER_SIZE_PX });
  collectGeometry(
    node.first,
    { ...rect, height: firstHeight },
    [...path, "first"],
    panes,
    dividers,
  );
  collectGeometry(
    node.second,
    {
      ...rect,
      top: secondTop,
      height: scaleLength(usableHeight, 1 - factor),
    },
    [...path, "second"],
    panes,
    dividers,
  );
}

function dividerStyle(direction: SplitDirection, ratio: number): CSSProperties {
  const offset = (DIVIDER_SIZE_PX * ratio) / 100;
  return direction === "horizontal"
    ? {
        left: `calc(${ratio}% - ${offset}px)`,
        top: 0,
        bottom: 0,
        width: DIVIDER_SIZE_PX,
      }
    : {
        top: `calc(${ratio}% - ${offset}px)`,
        left: 0,
        right: 0,
        height: DIVIDER_SIZE_PX,
      };
}

function isPaneDragHandle(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".pane-drag-handle") !== null;
}

export function WorkspaceNode({ path = [], ...props }: WorkspaceNodeProps): React.ReactElement {
  const paneGeometry = new Map<WorkspacePaneId, PaneGeometry>();
  const dividerGeometry: DividerGeometry[] = [];
  collectGeometry(
    props.node,
    {
      left: { percent: 0, pixels: 0 },
      top: { percent: 0, pixels: 0 },
      width: { percent: 100, pixels: 0 },
      height: { percent: 100, pixels: 0 },
    },
    path,
    paneGeometry,
    dividerGeometry,
  );

  return (
    <>
      {Object.keys(props.panes).map((paneId) => {
        const geometry = paneGeometry.get(paneId);
        return geometry ? (
          <WorkspaceAgentLeaf
            key={`pane:${paneId}`}
            paneId={paneId}
            style={rectStyle(geometry.rect)}
            {...props}
          />
        ) : null;
      })}
      {dividerGeometry.map((divider) => {
        const horizontal = divider.direction === "horizontal";
        return (
          <div
            key={`divider:${divider.key}`}
            className={`workspace-split workspace-split-${divider.direction}`}
            data-direction={divider.direction}
            data-split-ratio={divider.ratio}
            style={rectStyle(divider.rect)}
          >
            <div
              aria-controls={divider.controlledPaneIds
                .map((paneId) => `workspace-pane-${paneId}`)
                .join(" ")}
              aria-label={`Resize ${divider.direction} workspace panes`}
              aria-orientation={horizontal ? "vertical" : "horizontal"}
              aria-valuemax={MAX_SPLIT_RATIO}
              aria-valuemin={MIN_SPLIT_RATIO}
              aria-valuenow={Math.round(divider.ratio)}
              className={`workspace-divider workspace-divider-${divider.direction}`}
              onKeyDown={(event) =>
                props.onResizeByKeyboard(event, divider.path, divider.direction, divider.ratio)
              }
              onPointerDown={(event) =>
                props.onStartPointerResize(event, divider.path, divider.direction, divider.ratio)
              }
              role="separator"
              style={dividerStyle(divider.direction, divider.ratio)}
              tabIndex={0}
            >
              <span className="workspace-divider-line" />
            </div>
          </div>
        );
      })}
    </>
  );
}

function WorkspaceAgentLeaf({
  paneId,
  style,
  focusedPaneId,
  panes,
  windowFocused,
  canSplit,
  rearrangementEnabled,
  activePaneDragSourceId,
  hoveredPaneDrop,
  dragInstructionsId,
  renderPane,
  onFocusPane,
  onSnapshot,
  onLifecycleError,
  registerInput,
  onSplitPane,
  onCopyPane,
  copyingPaneId,
  closingPaneIds,
  onClosePane,
  onPaneDragStart,
  onPaneDragEnd,
  onPaneDropHover,
  onPaneDrop,
  onPaneDropReject,
}: Omit<WorkspaceNodeProps, "node" | "path"> & {
  paneId: WorkspacePaneId;
  style: CSSProperties;
}): React.ReactElement {
  const focused = focusedPaneId === paneId;
  const lifecycleErrorContextRef = useRef({ paneId, onLifecycleError });
  useLayoutEffect(() => {
    lifecycleErrorContextRef.current = { paneId, onLifecycleError };
  }, [paneId, onLifecycleError]);
  const dispatchLifecycleError = useCallback((error: unknown): void => {
    const current = lifecycleErrorContextRef.current;
    current.onLifecycleError(current.paneId, error);
  }, []);
  const [initialTarget] = useState(() => {
    const descriptor = panes[paneId];
    if (!descriptor) return null;
    return {
      mode: descriptor.mode,
      cwd: descriptor.cwd,
      sessionPath: descriptor.sessionPath,
      ...(descriptor.mode === "chat" ? { chatAgent: descriptor.chatAgent ?? "general" } : {}),
    };
  });
  const paneProps: AgentPaneProps = {
    paneId,
    kind: paneId === PRIMARY_PANE_ID ? "primary" : "auxiliary",
    focused,
    windowFocused,
    initialTarget,
    onFocus: onFocusPane,
    onSnapshot,
    onLifecycleError: dispatchLifecycleError,
    workspaceOwnsSessionLifecycle: true,
    registerInput,
  };

  return (
    <section
      className={`workspace-pane-slot${focused ? " pane-focused" : ""}`}
      data-pane-id={paneId}
      id={`workspace-pane-${paneId}`}
      style={style}
      onPointerDownCapture={(event) => {
        if (!isPaneDragHandle(event.target)) onFocusPane(paneId);
      }}
      onFocusCapture={(event) => {
        if (!isPaneDragHandle(event.target)) onFocusPane(paneId);
      }}
    >
      <div className="workspace-pane-body">
        {renderPane ? renderPane(paneProps) : <AgentPane {...paneProps} />}
      </div>
      {rearrangementEnabled && (
        <button
          type="button"
          className="pane-drag-handle pane-drag-handle-agent"
          draggable
          data-pane-drag-handle={paneId}
          aria-label={`Move pane ${paneId}`}
          aria-describedby={dragInstructionsId}
          title="Drag to move this pane"
          onDragStart={(event) => {
            event.dataTransfer.setData(PANE_DRAG_MIME, paneId);
            event.dataTransfer.setData("text/plain", paneId);
            event.dataTransfer.effectAllowed = "move";
            onPaneDragStart(paneId, event.currentTarget);
          }}
          onDragEnd={() => onPaneDragEnd(paneId)}
        >
          <GripVertical size={15} aria-hidden="true" />
        </button>
      )}
      {activePaneDragSourceId && (
        <PaneDropOverlay
          enabled={rearrangementEnabled}
          sourcePaneId={activePaneDragSourceId}
          targetPaneId={paneId}
          hoveredPlacement={
            hoveredPaneDrop?.targetPaneId === paneId ? hoveredPaneDrop.placement : null
          }
          onHover={onPaneDropHover}
          onDrop={onPaneDrop}
          onReject={onPaneDropReject}
        />
      )}
      {focused && (
        <div className="workspace-pane-actions" aria-label="Pane actions">
          <button
            type="button"
            aria-label="Copy to New Window"
            title="Copy to New Window"
            disabled={copyingPaneId !== null}
            onClick={() => onCopyPane(paneId)}
          >
            <CopyPlus size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Split Right"
            title="Split Right"
            disabled={!canSplit}
            onClick={() => onSplitPane(paneId, "horizontal")}
          >
            <PanelRight size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Split Down"
            title="Split Down"
            disabled={!canSplit}
            onClick={() => onSplitPane(paneId, "vertical")}
          >
            <PanelBottom size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      {paneId !== PRIMARY_PANE_ID && (
        <button
          type="button"
          className="workspace-pane-close"
          aria-label={
            closingPaneIds.has(paneId) ? `Closing ${paneId} pane` : `Close ${paneId} pane`
          }
          title={closingPaneIds.has(paneId) ? `Closing ${paneId} pane` : `Close ${paneId} pane`}
          disabled={closingPaneIds.has(paneId)}
          onClick={() => onClosePane(paneId)}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </section>
  );
}
