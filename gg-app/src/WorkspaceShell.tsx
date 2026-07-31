import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  arrangeAllWindows,
  copiedPaneRestoreTarget,
  copyPaneToNewWindow,
  disposePaneSession,
  focusWindowByOffset,
  newWindow,
  setWindowTitle,
  windowLabel,
  type RestoreTarget,
} from "./agent";
import { type AgentPaneProps, type PaneInputActions, type PaneSnapshot } from "./AgentPane";
import { PANE_DRAG_MIME } from "./PaneDropOverlay";
import {
  focusWorkspacePane,
  loadWorkspaceLayout,
  MAX_WORKSPACE_PANES,
  moveWorkspacePane,
  preserveRejectedWorkspaceLayout,
  removeWorkspacePane,
  saveWorkspaceLayout,
  splitWorkspacePane,
  updateWorkspaceSplitRatio,
  workspaceLayoutLeafIds,
  WORKSPACE_LAYOUT_VERSION,
  type PaneMoveRequest,
  type PanePlacement,
  type SplitDirection,
  type WorkspaceLayout,
  type WorkspaceLayoutNode,
  type WorkspaceLayoutPath,
  type WorkspacePaneId,
} from "./workspace-layout";
import { PRODUCT_DISPLAY_NAME } from "./brand";
import { ConfirmModal } from "./ConfirmModal";
import { Toaster } from "./Toaster";
import { toast } from "./toast";
import { WorkspaceNode } from "./WorkspaceNode";

const KEYBOARD_RESIZE_STEP = 5;
const MIN_PANE_SIZE_PX = 280;
const DIVIDER_SIZE_PX = 7;
const PANE_DRAG_INSTRUCTIONS_ID = "pane-rearrangement-instructions";

function nodeAtPath(
  root: WorkspaceLayoutNode,
  path: WorkspaceLayoutPath,
): WorkspaceLayoutNode | null {
  let node = root;
  for (const side of path) {
    if (node.type !== "split") return null;
    node = node[side];
  }
  return node;
}

function minimumSubtreeSize(node: WorkspaceLayoutNode, direction: SplitDirection): number {
  if (node.type === "leaf") return MIN_PANE_SIZE_PX;
  const first = minimumSubtreeSize(node.first, direction);
  const second = minimumSubtreeSize(node.second, direction);
  return node.direction === direction ? first + DIVIDER_SIZE_PX + second : Math.max(first, second);
}

/** Clamp a split to usable pixel minima, falling back to the stored 10–90% safety range. */
export function clampWorkspaceSplitRatio(
  root: WorkspaceLayoutNode,
  path: WorkspaceLayoutPath,
  direction: SplitDirection,
  ratio: number,
  containerSize: number,
): number {
  const percentageFallback = Math.min(90, Math.max(10, ratio));
  const split = nodeAtPath(root, path);
  if (!split || split.type !== "split" || split.direction !== direction) return percentageFallback;
  const available = containerSize - DIVIDER_SIZE_PX;
  const firstMinimum = minimumSubtreeSize(split.first, direction);
  const secondMinimum = minimumSubtreeSize(split.second, direction);
  if (available <= 0 || available < firstMinimum + secondMinimum) return percentageFallback;
  const minimumRatio = Math.max(10, (firstMinimum / available) * 100);
  const maximumRatio = Math.min(90, 100 - (secondMinimum / available) * 100);
  return Math.min(maximumRatio, Math.max(minimumRatio, ratio));
}

interface ActivePaneDrag {
  sourcePaneId: WorkspacePaneId;
  handle: HTMLButtonElement;
  generation: number;
}

function sameWorkspaceSnapshot(current: PaneSnapshot, incoming: PaneSnapshot): boolean {
  return (
    current.paneId === incoming.paneId &&
    current.mode === incoming.mode &&
    (current.mode !== "chat" ||
      (current.chatAgent ?? "general") === (incoming.chatAgent ?? "general")) &&
    current.cwd === incoming.cwd &&
    current.sessionPath === incoming.sessionPath &&
    current.sessionTitle === incoming.sessionTitle &&
    current.projectBound === incoming.projectBound &&
    current.restoreChecked === incoming.restoreChecked &&
    current.activeWork === incoming.activeWork
  );
}

/** Merge a pane report without changing record identity when workspace state is equivalent. */
export function mergePaneSnapshot(
  snapshots: Record<string, PaneSnapshot>,
  incoming: PaneSnapshot,
): Record<string, PaneSnapshot> {
  const current = snapshots[incoming.paneId];
  return current && sameWorkspaceSnapshot(current, incoming)
    ? snapshots
    : { ...snapshots, [incoming.paneId]: incoming };
}

function sameSnapshotTarget(
  descriptor: WorkspaceLayout["panes"][string],
  snapshot: PaneSnapshot,
): boolean {
  if (!snapshot.projectBound || !snapshot.cwd) return descriptor === null;
  return Boolean(
    descriptor &&
    descriptor.mode === snapshot.mode &&
    (snapshot.mode !== "chat" ||
      (descriptor.chatAgent ?? "general") === (snapshot.chatAgent ?? "general")) &&
    descriptor.cwd === snapshot.cwd &&
    descriptor.sessionPath === snapshot.sessionPath,
  );
}

export interface WorkspaceShellProps {
  renderPane?: (props: AgentPaneProps) => React.ReactNode;
}

function copiedPaneLayout(target: RestoreTarget): WorkspaceLayout {
  return {
    version: WORKSPACE_LAYOUT_VERSION,
    root: { type: "leaf", paneId: "primary" },
    focusedPaneId: "primary",
    panes: {
      primary: {
        kind: "agent",
        mode: target.mode,
        ...(target.mode === "chat" ? { chatAgent: target.chatAgent ?? "general" } : {}),
        cwd: target.cwd,
        sessionPath: target.sessionPath,
      },
    },
  };
}

export function WorkspaceShell({ renderPane }: WorkspaceShellProps): React.ReactElement {
  const [initialLayout, setInitialLayout] = useState<WorkspaceLayout | null>(null);

  useEffect(() => {
    let active = true;
    void copiedPaneRestoreTarget().then((target) => {
      if (!active) return;
      if (target) {
        const copied = copiedPaneLayout(target);
        saveWorkspaceLayout(localStorage, windowLabel, copied);
        setInitialLayout(copied);
      } else {
        const result = loadWorkspaceLayout(localStorage, windowLabel);
        if (result.rejectedRaw && result.rejectedSource === "legacy") {
          preserveRejectedWorkspaceLayout(localStorage, windowLabel, result.rejectedRaw);
        }
        if (result.status === "corrupt") {
          toast(
            "Workspace layout was malformed. Restored a safe default and preserved the rejected layout.",
            "warning",
          );
        } else if (result.status === "load-error") {
          toast("Workspace layout could not be read. Restored a safe default.", "warning");
        }
        setInitialLayout(result.layout);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  if (!initialLayout)
    return (
      <main className="workspace-shell" aria-busy="true">
        <Toaster />
      </main>
    );
  return (
    <>
      <ReadyWorkspaceShell initialLayout={initialLayout} renderPane={renderPane} />
      <Toaster />
    </>
  );
}

interface ReadyWorkspaceShellProps extends WorkspaceShellProps {
  initialLayout: WorkspaceLayout;
}

function ReadyWorkspaceShell({
  initialLayout,
  renderPane,
}: ReadyWorkspaceShellProps): React.ReactElement {
  const [layout, setLayout] = useState<WorkspaceLayout>(initialLayout);
  const [snapshots, setSnapshots] = useState<Record<string, PaneSnapshot>>({});
  const [windowFocused, setWindowFocused] = useState(document.hasFocus());
  const [rearrangementEnabled, setRearrangementEnabled] = useState(false);
  const [activePaneDrag, setActivePaneDrag] = useState<ActivePaneDrag | null>(null);
  const [hoveredPaneDrop, setHoveredPaneDrop] = useState<{
    targetPaneId: WorkspacePaneId;
    placement: PanePlacement;
  } | null>(null);
  const [rearrangementAnnouncement, setRearrangementAnnouncement] = useState("");
  const [copyAnnouncement, setCopyAnnouncement] = useState("");
  const [copyingPaneId, setCopyingPaneId] = useState<WorkspacePaneId | null>(null);
  const [confirmPaneCloseId, setConfirmPaneCloseId] = useState<WorkspacePaneId | null>(null);
  const [closingPaneIds, setClosingPaneIds] = useState<ReadonlySet<WorkspacePaneId>>(
    () => new Set(),
  );
  const warnedRestorePanesRef = useRef(new Set<WorkspacePaneId>());
  const inputActionsRef = useRef(new Map<string, PaneInputActions>());
  const paneGenerationsRef = useRef(new Map<WorkspacePaneId, number>());
  const closingPaneIdsRef = useRef(new Set<WorkspacePaneId>());
  const nativeDragPaneRef = useRef<WorkspacePaneId | null>(null);
  const layoutRef = useRef(layout);
  const activePaneDragRef = useRef<ActivePaneDrag | null>(null);
  const dragGenerationRef = useRef(0);
  const paneToFocusAfterMoveRef = useRef<WorkspacePaneId | null>(null);
  const leafIds = useMemo(() => workspaceLayoutLeafIds(layout.root), [layout.root]);
  const focusPaneInput = useCallback((paneId: WorkspacePaneId): void => {
    const actions = inputActionsRef.current.get(paneId);
    if (actions) {
      actions.focus();
      return;
    }
    document
      .getElementById(`workspace-pane-${paneId}`)
      ?.querySelector<HTMLElement>("textarea, input, [contenteditable='true']")
      ?.focus();
  }, []);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    const focusedSnapshot = snapshots[layout.focusedPaneId];
    setWindowTitle(focusedSnapshot?.sessionTitle?.trim() || PRODUCT_DISPLAY_NAME);
  }, [layout.focusedPaneId, snapshots]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed) return;
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          const paneId = layoutRef.current.focusedPaneId;
          const previousPaneId = nativeDragPaneRef.current;
          if (previousPaneId && previousPaneId !== paneId) {
            inputActionsRef.current.get(previousPaneId)?.setNativeFileDragOver(false);
          }
          nativeDragPaneRef.current = paneId;
          inputActionsRef.current.get(paneId)?.setNativeFileDragOver(true);
          return;
        }
        const dragPaneId = nativeDragPaneRef.current;
        nativeDragPaneRef.current = null;
        if (dragPaneId) inputActionsRef.current.get(dragPaneId)?.setNativeFileDragOver(false);
        if (payload.type !== "drop" || payload.paths.length === 0) return;
        inputActionsRef.current
          .get(layoutRef.current.focusedPaneId)
          ?.handleNativeDrop(payload.paths);
      })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const focusPaneDragHandle = useCallback((paneId: WorkspacePaneId): void => {
    requestAnimationFrame(() => {
      const handle = Array.from(
        document.querySelectorAll<HTMLButtonElement>("[data-pane-drag-handle]"),
      ).find((candidate) => candidate.dataset.paneDragHandle === paneId);
      handle?.focus();
    });
  }, []);

  const clearPaneDrag = useCallback((): ActivePaneDrag | null => {
    const active = activePaneDragRef.current;
    activePaneDragRef.current = null;
    setActivePaneDrag(null);
    setHoveredPaneDrop(null);
    return active;
  }, []);

  const cancelPaneDrag = useCallback(
    (announce = true): void => {
      const active = clearPaneDrag();
      if (!active) return;
      if (announce) setRearrangementAnnouncement("Pane move cancelled.");
      requestAnimationFrame(() => {
        if (active.handle.isConnected) active.handle.focus();
        else focusPaneDragHandle(active.sourcePaneId);
      });
    },
    [clearPaneDrag, focusPaneDragHandle],
  );

  useEffect(() => {
    const onFocus = (): void => setWindowFocused(true);
    const onBlur = (): void => {
      setWindowFocused(false);
      cancelPaneDrag();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [cancelPaneDrag]);

  useEffect(() => {
    if (leafIds.some((paneId) => !snapshots[paneId]?.restoreChecked)) return;
    saveWorkspaceLayout(localStorage, windowLabel, layout);
  }, [layout, leafIds, snapshots]);

  useEffect(() => {
    const scheduledPaneId = layout.focusedPaneId;
    requestAnimationFrame(() => {
      if (layoutRef.current.focusedPaneId !== scheduledPaneId) return;
      if (paneToFocusAfterMoveRef.current === scheduledPaneId) {
        paneToFocusAfterMoveRef.current = null;
        focusPaneDragHandle(scheduledPaneId);
        return;
      }
      focusPaneInput(scheduledPaneId);
    });
  }, [focusPaneDragHandle, focusPaneInput, layout.focusedPaneId, leafIds]);

  const focusPane = useCallback((paneId: WorkspacePaneId): void => {
    const next = focusWorkspacePane(layoutRef.current, paneId);
    layoutRef.current = next;
    setLayout(next);
  }, []);

  const updateSnapshot = useCallback((snapshot: PaneSnapshot): void => {
    if (!workspaceLayoutLeafIds(layoutRef.current.root).includes(snapshot.paneId)) return;
    if (typeof snapshot.generation === "number") {
      paneGenerationsRef.current.set(snapshot.paneId, snapshot.generation);
    }
    setSnapshots((previous) => mergePaneSnapshot(previous, snapshot));
    if (!snapshot.restoreChecked) return;
    setLayout((previous) => {
      const descriptor = previous.panes[snapshot.paneId];
      if (sameSnapshotTarget(descriptor, snapshot)) return previous;
      const next: WorkspaceLayout = {
        ...previous,
        panes: {
          ...previous.panes,
          [snapshot.paneId]:
            snapshot.projectBound && snapshot.cwd
              ? {
                  kind: "agent",
                  mode: snapshot.mode,
                  ...(snapshot.mode === "chat"
                    ? { chatAgent: snapshot.chatAgent ?? "general" }
                    : {}),
                  cwd: snapshot.cwd,
                  sessionPath: snapshot.sessionPath,
                }
              : null,
        },
      };
      layoutRef.current = next;
      return next;
    });
  }, []);

  const registerInput = useCallback((paneId: string, actions: PaneInputActions | null): void => {
    if (actions) inputActionsRef.current.set(paneId, actions);
    else inputActionsRef.current.delete(paneId);
  }, []);

  const startPaneDrag = useCallback(
    (paneId: WorkspacePaneId, handle: HTMLButtonElement): void => {
      if (!rearrangementEnabled || !workspaceLayoutLeafIds(layoutRef.current.root).includes(paneId))
        return;
      cancelPaneDrag(false);
      const active = {
        sourcePaneId: paneId,
        handle,
        generation: ++dragGenerationRef.current,
      };
      activePaneDragRef.current = active;
      setActivePaneDrag(active);
      setHoveredPaneDrop(null);
      setRearrangementAnnouncement(`Moving pane ${paneId}. Choose a direction.`);
    },
    [cancelPaneDrag, rearrangementEnabled],
  );

  const finishPaneDrag = useCallback(
    (paneId: WorkspacePaneId): void => {
      const active = activePaneDragRef.current;
      if (active?.sourcePaneId === paneId && active.generation === dragGenerationRef.current)
        cancelPaneDrag();
    },
    [cancelPaneDrag],
  );

  const hoverPaneDrop = useCallback(
    (targetPaneId: WorkspacePaneId, placement: PanePlacement | null): void => {
      const active = activePaneDragRef.current;
      if (!active || !placement || targetPaneId === active.sourcePaneId) {
        setHoveredPaneDrop(null);
        return;
      }
      if (!workspaceLayoutLeafIds(layoutRef.current.root).includes(targetPaneId)) {
        cancelPaneDrag();
        return;
      }
      setHoveredPaneDrop({ targetPaneId, placement });
    },
    [cancelPaneDrag],
  );

  const commitPaneDrop = useCallback(
    (request: PaneMoveRequest): void => {
      const active = activePaneDragRef.current;
      if (
        !active ||
        active.generation !== dragGenerationRef.current ||
        active.sourcePaneId !== request.sourcePaneId ||
        request.sourcePaneId === request.targetPaneId
      ) {
        cancelPaneDrag();
        return;
      }
      const previous = layoutRef.current;
      const visible = new Set(workspaceLayoutLeafIds(previous.root));
      if (!visible.has(request.sourcePaneId) || !visible.has(request.targetPaneId)) {
        cancelPaneDrag();
        return;
      }
      const next = moveWorkspacePane(previous, request);
      if (next === previous) {
        cancelPaneDrag();
        return;
      }
      clearPaneDrag();
      paneToFocusAfterMoveRef.current = request.sourcePaneId;
      layoutRef.current = next;
      setLayout(next);
      saveWorkspaceLayout(localStorage, windowLabel, next);
      setRearrangementAnnouncement(
        `Pane ${request.sourcePaneId} moved ${request.placement} of ${request.targetPaneId}.`,
      );
      focusPaneDragHandle(request.sourcePaneId);
    },
    [cancelPaneDrag, clearPaneDrag, focusPaneDragHandle],
  );

  const toggleRearrangement = useCallback((): void => {
    const next = !rearrangementEnabled;
    if (!next) cancelPaneDrag();
    setRearrangementEnabled(next);
    setRearrangementAnnouncement(
      next ? "Pane rearrangement enabled." : "Pane rearrangement disabled.",
    );
  }, [cancelPaneDrag, rearrangementEnabled]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && activePaneDragRef.current) {
        event.preventDefault();
        cancelPaneDrag();
        return;
      }
      const meta = event.ctrlKey || event.metaKey;
      if (!meta || event.altKey) return;
      if (event.key.toLowerCase() === "n" && !event.shiftKey) {
        event.preventDefault();
        void newWindow();
        return;
      }
      if (event.code === "Backquote") {
        event.preventDefault();
        void focusWindowByOffset(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.shiftKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        void arrangeAllWindows();
        return;
      }
      if (event.shiftKey) return;
      const index = /^[1-4]$/.test(event.key) ? Number(event.key) - 1 : -1;
      const paneId = leafIds[index];
      if (!paneId) return;
      event.preventDefault();
      focusPane(paneId);
      focusPaneInput(paneId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelPaneDrag, focusPane, focusPaneInput, leafIds]);

  useEffect(() => {
    const onPointerCancel = (): void => cancelPaneDrag();
    const onOutsideDrop = (event: DragEvent): void => {
      if (
        activePaneDragRef.current &&
        event.dataTransfer &&
        Array.from(event.dataTransfer.types ?? []).includes(PANE_DRAG_MIME)
      ) {
        event.preventDefault();
        cancelPaneDrag();
      }
    };
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("drop", onOutsideDrop);
    return () => {
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("drop", onOutsideDrop);
    };
  }, [cancelPaneDrag]);

  useEffect(() => {
    const active = activePaneDragRef.current;
    if (!active) return;
    const visible = new Set(leafIds);
    if (
      !visible.has(active.sourcePaneId) ||
      (hoveredPaneDrop && !visible.has(hoveredPaneDrop.targetPaneId))
    )
      cancelPaneDrag();
  }, [cancelPaneDrag, hoveredPaneDrop, leafIds]);

  useEffect(() => {
    if (leafIds.length > 1 || !rearrangementEnabled) return;
    cancelPaneDrag();
    setRearrangementEnabled(false);
    setRearrangementAnnouncement("Pane rearrangement disabled.");
  }, [cancelPaneDrag, leafIds.length, rearrangementEnabled]);

  const splitPane = useCallback((paneId: WorkspacePaneId, direction: SplitDirection): void => {
    const next = splitWorkspacePane(layoutRef.current, paneId, direction);
    layoutRef.current = next;
    setLayout(next);
  }, []);

  const copyPane = useCallback(
    async (paneId: WorkspacePaneId): Promise<void> => {
      if (copyingPaneId || paneId !== layoutRef.current.focusedPaneId) return;
      const snapshot = snapshots[paneId];
      if (!snapshot?.projectBound || !snapshot.cwd) {
        setCopyAnnouncement("Choose a project before copying this pane.");
        return;
      }
      if (snapshot.activeWork) {
        setCopyAnnouncement("Wait for this pane to finish before copying it.");
        return;
      }
      setCopyingPaneId(paneId);
      setCopyAnnouncement(`Copying pane ${paneId} to a new window…`);
      try {
        const result = await copyPaneToNewWindow(paneId);
        setCopyAnnouncement(
          result.reusedWindow
            ? `Pane ${paneId} is already copied in window ${result.windowLabel}.`
            : `Pane ${paneId} copied to window ${result.windowLabel}.`,
        );
      } catch (error) {
        const rollback =
          typeof error === "object" &&
          error !== null &&
          "rollbackSucceeded" in error &&
          (error as { rollbackSucceeded: boolean }).rollbackSucceeded;
        setCopyAnnouncement(
          rollback
            ? `Could not copy pane ${paneId}; the new window was rolled back.`
            : `Could not copy pane ${paneId}.`,
        );
      } finally {
        setCopyingPaneId(null);
      }
    },
    [copyingPaneId, snapshots],
  );

  const performClosePane = useCallback(
    async (paneId: WorkspacePaneId): Promise<void> => {
      if (closingPaneIdsRef.current.has(paneId)) return;
      closingPaneIdsRef.current.add(paneId);
      setClosingPaneIds(new Set(closingPaneIdsRef.current));
      cancelPaneDrag(false);
      try {
        const generation = paneGenerationsRef.current.get(paneId);
        if (generation === undefined) await disposePaneSession(paneId);
        else await disposePaneSession(paneId, generation);
        setConfirmPaneCloseId((current) => (current === paneId ? null : current));
        warnedRestorePanesRef.current.delete(paneId);
        inputActionsRef.current.delete(paneId);
        paneGenerationsRef.current.delete(paneId);
        setSnapshots((previous) => {
          const nextSnapshots = { ...previous };
          delete nextSnapshots[paneId];
          return nextSnapshots;
        });
        const nextLayout = removeWorkspacePane(layoutRef.current, paneId);
        layoutRef.current = nextLayout;
        setLayout(nextLayout);
        requestAnimationFrame(() => focusPaneInput(nextLayout.focusedPaneId));
      } catch {
        toast(
          `Pane ${paneId} stayed open because its session could not be disposed. Try closing it again.`,
          "error",
        );
      } finally {
        closingPaneIdsRef.current.delete(paneId);
        setClosingPaneIds(new Set(closingPaneIdsRef.current));
      }
    },
    [cancelPaneDrag, focusPaneInput],
  );

  const closePane = useCallback(
    (paneId: WorkspacePaneId): void => {
      if (closingPaneIdsRef.current.has(paneId)) return;
      if (snapshots[paneId]?.activeWork) {
        setConfirmPaneCloseId(paneId);
        return;
      }
      void performClosePane(paneId);
    },
    [performClosePane, snapshots],
  );

  const handlePaneLifecycleError = useCallback((paneId: WorkspacePaneId): void => {
    if (warnedRestorePanesRef.current.has(paneId)) return;
    warnedRestorePanesRef.current.add(paneId);
    toast(
      `Pane ${paneId} could not restore its saved session. Choose a project or session to continue.`,
      "warning",
    );
  }, []);

  const resizeByKeyboard = useCallback(
    (
      event: React.KeyboardEvent<HTMLDivElement>,
      path: WorkspaceLayoutPath,
      direction: SplitDirection,
      ratio: number,
    ): void => {
      const negative = direction === "horizontal" ? "ArrowLeft" : "ArrowUp";
      const positive = direction === "horizontal" ? "ArrowRight" : "ArrowDown";
      let nextRatio: number | null = null;
      if (event.key === "Home") nextRatio = 10;
      else if (event.key === "End") nextRatio = 90;
      else if (event.key === negative) nextRatio = ratio - KEYBOARD_RESIZE_STEP;
      else if (event.key === positive) nextRatio = ratio + KEYBOARD_RESIZE_STEP;
      if (nextRatio === null) return;
      event.preventDefault();
      const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
      const size = direction === "horizontal" ? (bounds?.width ?? 0) : (bounds?.height ?? 0);
      setLayout((previous) => {
        const clampedRatio = clampWorkspaceSplitRatio(
          previous.root,
          path,
          direction,
          nextRatio!,
          size,
        );
        const next = updateWorkspaceSplitRatio(previous, path, clampedRatio);
        layoutRef.current = next;
        return next;
      });
    },
    [],
  );

  const startPointerResize = useCallback(
    (
      event: React.PointerEvent<HTMLDivElement>,
      path: WorkspaceLayoutPath,
      direction: SplitDirection,
      ratio: number,
    ): void => {
      if (event.button !== 0) return;
      event.preventDefault();
      const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
      const size = direction === "horizontal" ? (bounds?.width ?? 0) : (bounds?.height ?? 0);
      if (size <= 0) return;
      const start = direction === "horizontal" ? event.clientX : event.clientY;
      const pointerId = event.pointerId;
      const onMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) return;
        const current = direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY;
        const nextRatio = ratio + ((current - start) / size) * 100;
        setLayout((previous) => {
          const clampedRatio = clampWorkspaceSplitRatio(
            previous.root,
            path,
            direction,
            nextRatio,
            size,
          );
          const next = updateWorkspaceSplitRatio(previous, path, clampedRatio);
          layoutRef.current = next;
          return next;
        });
      };
      const stop = (endEvent: PointerEvent): void => {
        if (endEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [],
  );

  const canRearrange = leafIds.length > 1;

  return (
    <main className={`workspace-shell${activePaneDrag ? " pane-drag-active" : ""}`}>
      <div className="workspace-toolbar" data-tauri-drag-region>
        <button
          type="button"
          className="workspace-rearrangement-toggle"
          disabled={!canRearrange}
          aria-pressed={rearrangementEnabled}
          aria-label="Rearrange panes"
          title="Enable pane drag handles"
          onClick={toggleRearrangement}
        >
          Rearrange
        </button>
      </div>
      <p id={PANE_DRAG_INSTRUCTIONS_ID} className="visually-hidden">
        Drag this handle onto the left, right, top, or bottom edge of another workspace pane. Press
        Escape to cancel.
      </p>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {rearrangementAnnouncement}
      </div>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {copyAnnouncement}
      </div>
      <div className="workspace-grid" data-pane-count={leafIds.length}>
        <WorkspaceNode
          node={layout.root}
          focusedPaneId={layout.focusedPaneId}
          panes={layout.panes}
          windowFocused={windowFocused}
          canSplit={leafIds.length < MAX_WORKSPACE_PANES}
          rearrangementEnabled={rearrangementEnabled}
          activePaneDragSourceId={activePaneDrag?.sourcePaneId ?? null}
          hoveredPaneDrop={hoveredPaneDrop}
          dragInstructionsId={PANE_DRAG_INSTRUCTIONS_ID}
          renderPane={renderPane}
          onFocusPane={focusPane}
          onSnapshot={updateSnapshot}
          onLifecycleError={handlePaneLifecycleError}
          registerInput={registerInput}
          onSplitPane={splitPane}
          onCopyPane={(paneId) => void copyPane(paneId)}
          copyingPaneId={copyingPaneId}
          closingPaneIds={closingPaneIds}
          onClosePane={closePane}
          onPaneDragStart={startPaneDrag}
          onPaneDragEnd={finishPaneDrag}
          onPaneDropHover={hoverPaneDrop}
          onPaneDrop={commitPaneDrop}
          onPaneDropReject={cancelPaneDrag}
          onResizeByKeyboard={resizeByKeyboard}
          onStartPointerResize={startPointerResize}
        />
      </div>
      {confirmPaneCloseId && (
        <ConfirmModal
          title="Close Pane"
          message={`Pane ${confirmPaneCloseId} has active work. Closing it will stop that work and dispose its session.`}
          confirmLabel="Close Pane"
          busy={closingPaneIds.has(confirmPaneCloseId)}
          onConfirm={() => void performClosePane(confirmPaneCloseId)}
          onClose={() => {
            if (closingPaneIdsRef.current.has(confirmPaneCloseId)) return;
            const paneId = confirmPaneCloseId;
            setConfirmPaneCloseId(null);
            requestAnimationFrame(() => focusPaneInput(paneId));
          }}
        />
      )}
    </main>
  );
}
