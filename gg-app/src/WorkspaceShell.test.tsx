// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPaneProps, PaneSnapshot } from "./AgentPane";
import { clampWorkspaceSplitRatio, mergePaneSnapshot, WorkspaceShell } from "./WorkspaceShell";

const bridge = vi.hoisted(() => ({
  copiedPaneRestoreTarget: vi.fn(() =>
    Promise.resolve(
      null as null | {
        mode: "code" | "chat";
        chatAgent?: "general" | "therapist" | "research";
        cwd: string;
        sessionPath: string | null;
      },
    ),
  ),
  copyPaneToNewWindow: vi.fn(() =>
    Promise.resolve({ windowLabel: "project-1", reusedWindow: false }),
  ),
  disposePaneSession: vi.fn(() => Promise.resolve()),
  arrangeAllWindows: vi.fn(() => Promise.resolve()),
  focusWindowByOffset: vi.fn(() => Promise.resolve()),
  newWindow: vi.fn(() => Promise.resolve()),
  setWindowTitle: vi.fn(),
  nativeDropHandler: null as
    | null
    | ((event: { payload: { type: string; paths: string[] } }) => void),
}));
const paneMounts = new Map<string, number>();
const paneUnmounts = new Map<string, number>();
const paneDrops = new Map<string, string[][]>();
const paneNativeDragStates = new Map<string, boolean[]>();
const activeWorkPanes = new Set<string>();
const failingRestorePanes = new Set<string>();
const lifecycleEffectExecutions = new Map<string, number>();
const lifecycleCallbacks = new Map<string, Array<AgentPaneProps["onLifecycleError"]>>();
const latestPaneProps = new Map<string, AgentPaneProps>();
const MAX_LIFECYCLE_EFFECT_EXECUTIONS = 8;

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(async (handler) => {
      bridge.nativeDropHandler = handler;
      return vi.fn();
    }),
  }),
}));

vi.mock("./agent", () => ({
  copiedPaneRestoreTarget: bridge.copiedPaneRestoreTarget,
  copyPaneToNewWindow: bridge.copyPaneToNewWindow,
  disposePaneSession: bridge.disposePaneSession,
  arrangeAllWindows: bridge.arrangeAllWindows,
  focusWindowByOffset: bridge.focusWindowByOffset,
  newWindow: bridge.newWindow,
  setWindowTitle: bridge.setWindowTitle,
  windowLabel: "main",
}));
vi.mock("./AgentPane", () => ({ AgentPane: () => null }));

function FakePane(props: AgentPaneProps): React.ReactElement {
  const { initialTarget, onLifecycleError, onSnapshot, paneId = "primary", registerInput } = props;
  const input = useRef<HTMLInputElement>(null);
  latestPaneProps.set(paneId, props);
  useEffect(() => {
    paneMounts.set(paneId, (paneMounts.get(paneId) ?? 0) + 1);
    return () => {
      paneUnmounts.set(paneId, (paneUnmounts.get(paneId) ?? 0) + 1);
    };
  }, [paneId]);
  useEffect(() => {
    const executionCount = (lifecycleEffectExecutions.get(paneId) ?? 0) + 1;
    lifecycleEffectExecutions.set(paneId, executionCount);
    lifecycleCallbacks.set(paneId, [...(lifecycleCallbacks.get(paneId) ?? []), onLifecycleError]);
    if (executionCount > MAX_LIFECYCLE_EFFECT_EXECUTIONS) {
      throw new Error(
        `Pane ${paneId} lifecycle effect exceeded ${MAX_LIFECYCLE_EFFECT_EXECUTIONS} executions; callback identity is churning`,
      );
    }
    registerInput?.(paneId, {
      focus: () => input.current?.focus(),
      setNativeFileDragOver: (dragging) => {
        paneNativeDragStates.set(paneId, [...(paneNativeDragStates.get(paneId) ?? []), dragging]);
      },
      handleNativeDrop: (paths) => {
        paneDrops.set(paneId, [...(paneDrops.get(paneId) ?? []), paths]);
      },
    });
    onSnapshot?.({
      paneId,
      mode: initialTarget?.mode ?? "code",
      chatAgent: initialTarget?.chatAgent,
      cwd: initialTarget?.cwd ?? null,
      sessionPath: initialTarget?.sessionPath ?? null,
      sessionTitle: initialTarget?.cwd ?? null,
      projectBound: initialTarget !== null,
      restoreChecked: true,
      activeWork: activeWorkPanes.has(paneId),
    });
    if (failingRestorePanes.has(paneId)) onLifecycleError?.(new Error("stale target"));
    return () => registerInput?.(paneId, null);
  }, [initialTarget, onLifecycleError, onSnapshot, paneId, registerInput]);
  return (
    <div
      data-testid={`pane-${paneId}`}
      data-focused={String(props.focused)}
      data-target={props.initialTarget?.cwd ?? "picker"}
    >
      <input ref={input} aria-label={`${props.paneId} input`} />
    </div>
  );
}

const renderPane = (props: AgentPaneProps): React.ReactNode => <FakePane {...props} />;

function emitPaneSnapshot(paneId: string, changes: Partial<Omit<PaneSnapshot, "paneId">>): void {
  const props = latestPaneProps.get(paneId);
  if (!props?.onSnapshot) throw new Error(`Pane ${paneId} has no captured snapshot callback`);
  props.onSnapshot({
    paneId,
    mode: props.initialTarget?.mode ?? "code",
    chatAgent: props.initialTarget?.chatAgent,
    cwd: props.initialTarget?.cwd ?? null,
    sessionPath: props.initialTarget?.sessionPath ?? null,
    sessionTitle: props.initialTarget?.cwd ?? null,
    projectBound: props.initialTarget !== null,
    restoreChecked: true,
    activeWork: false,
    ...changes,
  });
}

function dragTransfer(types = ["application/x-gg-workspace-pane"]): DataTransfer {
  return {
    types,
    effectAllowed: "none",
    dropEffect: "none",
    setData: vi.fn(),
    getData: vi.fn(),
  } as unknown as DataTransfer;
}

function saveTwoPaneLayout(): void {
  localStorage.setItem(
    "gg-workspace-layout-recursive:main",
    JSON.stringify({
      version: 9,
      root: {
        type: "split",
        direction: "horizontal",
        size: { type: "ratio", value: 50 },
        first: { type: "leaf", paneId: "primary" },
        second: { type: "leaf", paneId: "secondary" },
      },
      focusedPaneId: "primary",
      panes: {
        primary: { kind: "agent", mode: "code", cwd: "/one", sessionPath: "/one.jsonl" },
        secondary: { kind: "agent", mode: "code", cwd: "/two", sessionPath: "/two.jsonl" },
      },
    }),
  );
}

async function waitForInitialWorkspaceReady(): Promise<HTMLElement> {
  const secondaryPane = await screen.findByTestId("pane-secondary");
  await act(async () => {});
  await waitFor(() => {
    expect(lifecycleEffectExecutions.get("primary")).toBe(1);
    expect(lifecycleEffectExecutions.get("secondary")).toBe(1);
    expect(bridge.setWindowTitle).toHaveBeenLastCalledWith("/one");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "primary input" }));
  });
  return secondaryPane;
}

function saveFourPaneLayout(): void {
  localStorage.setItem(
    "gg-workspace-layout-recursive:main",
    JSON.stringify({
      version: 9,
      root: {
        type: "split",
        direction: "horizontal",
        size: { type: "ratio", value: 55 },
        first: {
          type: "split",
          direction: "vertical",
          size: { type: "ratio", value: 60 },
          first: { type: "leaf", paneId: "primary" },
          second: { type: "leaf", paneId: "pane-1" },
        },
        second: {
          type: "split",
          direction: "vertical",
          size: { type: "ratio", value: 40 },
          first: { type: "leaf", paneId: "pane-2" },
          second: { type: "leaf", paneId: "pane-3" },
        },
      },
      focusedPaneId: "primary",
      panes: {
        primary: { kind: "agent", mode: "code", cwd: "/primary", sessionPath: "/p.jsonl" },
        "pane-1": { kind: "agent", mode: "code", cwd: "/one", sessionPath: "/1.jsonl" },
        "pane-2": {
          kind: "agent",
          mode: "chat",
          chatAgent: "research",
          cwd: "/two",
          sessionPath: "/2.jsonl",
        },
        "pane-3": { kind: "agent", mode: "code", cwd: "/three", sessionPath: "/3.jsonl" },
      },
    }),
  );
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  localStorage.clear();
  paneMounts.clear();
  paneUnmounts.clear();
  paneDrops.clear();
  paneNativeDragStates.clear();
  activeWorkPanes.clear();
  failingRestorePanes.clear();
  lifecycleEffectExecutions.clear();
  lifecycleCallbacks.clear();
  latestPaneProps.clear();
  bridge.copiedPaneRestoreTarget.mockReset().mockResolvedValue(null);
  bridge.copyPaneToNewWindow
    .mockReset()
    .mockResolvedValue({ windowLabel: "project-1", reusedWindow: false });
  bridge.disposePaneSession.mockReset().mockResolvedValue(undefined);
  bridge.arrangeAllWindows.mockReset().mockResolvedValue(undefined);
  bridge.focusWindowByOffset.mockReset().mockResolvedValue(undefined);
  bridge.newWindow.mockReset().mockResolvedValue(undefined);
  bridge.setWindowTitle.mockReset();
  bridge.nativeDropHandler = null;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mergePaneSnapshot", () => {
  const baseSnapshot: PaneSnapshot = {
    paneId: "primary",
    generation: 1,
    mode: "code",
    cwd: "/project",
    sessionPath: "/project/session.jsonl",
    sessionTitle: "Project session",
    projectBound: true,
    restoreChecked: true,
    activeWork: false,
  };

  it("preserves the record for an equivalent workspace snapshot", () => {
    const snapshots = { primary: baseSnapshot };

    expect(mergePaneSnapshot(snapshots, { ...baseSnapshot, generation: 2 })).toBe(snapshots);
  });

  it("normalizes chat defaults and ignores code-mode chat-agent noise", () => {
    const chatSnapshot: PaneSnapshot = { ...baseSnapshot, mode: "chat", chatAgent: undefined };
    const chatSnapshots = { primary: chatSnapshot };
    expect(mergePaneSnapshot(chatSnapshots, { ...chatSnapshot, chatAgent: "general" })).toBe(
      chatSnapshots,
    );

    const noisyCodeSnapshot: PaneSnapshot = { ...baseSnapshot, chatAgent: "research" };
    const codeSnapshots = { primary: noisyCodeSnapshot };
    expect(mergePaneSnapshot(codeSnapshots, { ...baseSnapshot, chatAgent: undefined })).toBe(
      codeSnapshots,
    );
  });

  it.each([
    { field: "paneId", current: baseSnapshot, changes: { paneId: "secondary" } },
    {
      field: "mode",
      current: baseSnapshot,
      changes: { mode: "chat", chatAgent: "general" },
    },
    {
      field: "chatAgent",
      current: { ...baseSnapshot, mode: "chat" as const, chatAgent: "general" as const },
      changes: { chatAgent: "research" },
    },
    { field: "cwd", current: baseSnapshot, changes: { cwd: "/other" } },
    {
      field: "sessionPath",
      current: baseSnapshot,
      changes: { sessionPath: "/other/session.jsonl" },
    },
    {
      field: "sessionTitle",
      current: baseSnapshot,
      changes: { sessionTitle: "Other session" },
    },
    { field: "projectBound", current: baseSnapshot, changes: { projectBound: false } },
    { field: "restoreChecked", current: baseSnapshot, changes: { restoreChecked: false } },
    { field: "activeWork", current: baseSnapshot, changes: { activeWork: true } },
  ] as const)("allocates when $field changes", ({ current, changes }) => {
    const snapshots = { [current.paneId]: current };
    const incoming = { ...current, ...changes } as PaneSnapshot;

    const merged = mergePaneSnapshot(snapshots, incoming);

    expect(merged).not.toBe(snapshots);
    expect(merged[incoming.paneId]).toBe(incoming);
  });
});

describe("WorkspaceShell", () => {
  it("renders the agent-only workspace and splits right or down", async () => {
    render(<WorkspaceShell renderPane={renderPane} />);
    expect(await screen.findByTestId("pane-primary")).toBeTruthy();
    await waitFor(() =>
      expect(localStorage.getItem("gg-workspace-layout-recursive:main")).not.toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Split Right" }));
    expect(await screen.findByTestId("pane-pane-1")).toBeTruthy();
    expect(document.querySelector(".workspace-split-horizontal")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Split Down" }));
    expect(await screen.findByTestId("pane-pane-2")).toBeTruthy();
    expect(document.querySelector(".workspace-split-vertical")).toBeTruthy();
  });

  it("restores pane targets and persists canonical focus", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);

    const secondaryPane = await waitForInitialWorkspaceReady();
    expect(screen.getByTestId("pane-primary").dataset.target).toBe("/one");
    expect(secondaryPane.dataset.target).toBe("/two");
    fireEvent.pointerDown(secondaryPane);
    await waitFor(() => expect(secondaryPane.dataset.focused).toBe("true"));

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.focusedPaneId).toBe("secondary");
      expect(saved.panes.secondary.sessionPath).toBe("/two.jsonl");
    });
  });

  it("copies only the focused pane to a new window and preserves the source", async () => {
    let initialFocusFrame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      initialFocusFrame ??= callback;
      return 1;
    });
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    const source = await screen.findByTestId("pane-secondary");
    await act(async () => {});
    expect(initialFocusFrame).toBeTypeOf("function");

    fireEvent.focus(screen.getByRole("textbox", { name: "secondary input" }));
    act(() => initialFocusFrame?.(0));
    expect(source.dataset.focused).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Copy to New Window" }));

    await waitFor(() => expect(bridge.copyPaneToNewWindow).toHaveBeenCalledWith("secondary"));
    expect(screen.getByTestId("pane-secondary")).toBe(source);
    expect(screen.getByTestId("pane-primary")).toBeTruthy();
    expect(bridge.disposePaneSession).not.toHaveBeenCalled();
    expect(await screen.findByText("Pane secondary copied to window project-1.")).toBeTruthy();
  });

  it("reports copy failure with successful rollback and keeps the focused source", async () => {
    saveTwoPaneLayout();
    bridge.copyPaneToNewWindow.mockRejectedValueOnce({ rollbackSucceeded: true });
    render(<WorkspaceShell renderPane={renderPane} />);
    const source = await screen.findByTestId("pane-secondary");
    await act(async () => {});

    fireEvent.focus(screen.getByRole("textbox", { name: "secondary input" }));
    await waitFor(() => expect(source.dataset.focused).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Copy to New Window" }));

    expect(
      await screen.findByText("Could not copy pane secondary; the new window was rolled back."),
    ).toBeTruthy();
    expect(screen.getByTestId("pane-secondary")).toBe(source);
    expect(bridge.disposePaneSession).not.toHaveBeenCalled();
  });

  it("reports a reused destination window without altering the focused source", async () => {
    saveTwoPaneLayout();
    bridge.copyPaneToNewWindow.mockResolvedValueOnce({
      windowLabel: "project-4",
      reusedWindow: true,
    });
    render(<WorkspaceShell renderPane={renderPane} />);
    const source = await waitForInitialWorkspaceReady();
    fireEvent.focus(screen.getByRole("textbox", { name: "secondary input" }));
    await waitFor(() => expect(source.dataset.focused).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Copy to New Window" }));

    expect(
      await screen.findByText("Pane secondary is already copied in window project-4."),
    ).toBeTruthy();
    expect(screen.getByTestId("pane-secondary")).toBe(source);
  });

  it("hydrates a copied window as exactly one primary pane", async () => {
    bridge.copiedPaneRestoreTarget.mockResolvedValueOnce({
      mode: "chat",
      chatAgent: "research",
      cwd: "/copied",
      sessionPath: "/copied/session.jsonl",
    });
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);

    expect((await screen.findByTestId("pane-primary")).dataset.target).toBe("/copied");
    expect(screen.queryByTestId("pane-secondary")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("opts into accessible pane drag controls and moves without remounting or disposing", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    const secondaryPane = await screen.findByTestId("pane-secondary");
    expect(screen.queryByRole("button", { name: "Move pane secondary" })).toBeNull();

    const toggle = screen.getByRole("button", { name: "Rearrange panes" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    const handle = screen.getByRole("button", { name: "Move pane secondary" });
    const dataTransfer = dragTransfer();
    fireEvent.dragStart(handle, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      "application/x-gg-workspace-pane",
      "secondary",
    );
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "secondary");
    expect(dataTransfer.effectAllowed).toBe("move");
    const leftZone = document.querySelector('[data-pane-id="primary"] [data-placement="left"]')!;
    fireEvent.dragOver(leftZone, { dataTransfer });
    expect(
      document
        .querySelector('[data-pane-id="primary"] .pane-drop-overlay')
        ?.getAttribute("data-hovered-placement"),
    ).toBe("left");
    fireEvent.drop(leftZone, { dataTransfer });

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.root.first).toEqual({ type: "leaf", paneId: "secondary" });
      expect(saved.focusedPaneId).toBe("secondary");
    });
    expect(screen.getByTestId("pane-secondary")).toBe(secondaryPane);
    expect(paneMounts.get("secondary")).toBe(1);
    expect(paneUnmounts.get("secondary") ?? 0).toBe(0);
    expect(bridge.disposePaneSession).not.toHaveBeenCalled();
    expect(screen.getByText("Pane secondary moved left of primary.")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Move pane secondary" }),
    );
  });

  it("preserves every pane host across a nested cross-parent move", async () => {
    saveFourPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    const paneIds = ["primary", "pane-1", "pane-2", "pane-3"];
    const paneNodes = new Map(
      await Promise.all(
        paneIds.map(
          async (paneId) => [paneId, await screen.findByTestId(`pane-${paneId}`)] as const,
        ),
      ),
    );
    const movedPaneInput = screen.getByRole("textbox", {
      name: "pane-1 input",
    }) as HTMLInputElement;
    fireEvent.change(movedPaneInput, { target: { value: "draft survives move" } });

    fireEvent.click(screen.getByRole("button", { name: "Rearrange panes" }));
    const movedHandle = screen.getByRole("button", { name: "Move pane pane-1" });
    const dataTransfer = dragTransfer();
    fireEvent.dragStart(movedHandle, { dataTransfer });
    const downZone = document.querySelector('[data-pane-id="pane-3"] [data-placement="down"]')!;
    fireEvent.dragOver(downZone, { dataTransfer });
    fireEvent.drop(downZone, { dataTransfer });

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.root).toEqual({
        type: "split",
        direction: "horizontal",
        size: { type: "ratio", value: 55 },
        first: { type: "leaf", paneId: "primary" },
        second: {
          type: "split",
          direction: "vertical",
          size: { type: "ratio", value: 40 },
          first: { type: "leaf", paneId: "pane-2" },
          second: {
            type: "split",
            direction: "vertical",
            size: { type: "ratio", value: 50 },
            first: { type: "leaf", paneId: "pane-3" },
            second: { type: "leaf", paneId: "pane-1" },
          },
        },
      });
      expect(saved.focusedPaneId).toBe("pane-1");
      expect(saved.panes).toEqual({
        primary: { kind: "agent", mode: "code", cwd: "/primary", sessionPath: "/p.jsonl" },
        "pane-1": { kind: "agent", mode: "code", cwd: "/one", sessionPath: "/1.jsonl" },
        "pane-2": {
          kind: "agent",
          mode: "chat",
          chatAgent: "research",
          cwd: "/two",
          sessionPath: "/2.jsonl",
        },
        "pane-3": { kind: "agent", mode: "code", cwd: "/three", sessionPath: "/3.jsonl" },
      });
    });

    for (const paneId of paneIds) {
      expect(screen.getByTestId(`pane-${paneId}`)).toBe(paneNodes.get(paneId));
      expect(paneMounts.get(paneId)).toBe(1);
      expect(paneUnmounts.get(paneId) ?? 0).toBe(0);
    }
    expect(screen.getByRole("textbox", { name: "pane-1 input" })).toBe(movedPaneInput);
    expect(movedPaneInput.value).toBe("draft survives move");
    expect(bridge.disposePaneSession).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move pane pane-1" }));
  });

  it.each(["Escape", "pointercancel", "dragend", "blur", "outside drop"])(
    "cancels pane dragging through %s without changing the layout",
    async (path) => {
      saveTwoPaneLayout();
      render(<WorkspaceShell renderPane={renderPane} />);
      await screen.findByTestId("pane-secondary");
      fireEvent.click(screen.getByRole("button", { name: "Rearrange panes" }));
      const handle = screen.getByRole("button", { name: "Move pane secondary" });
      const dataTransfer = dragTransfer();
      fireEvent.dragStart(handle, { dataTransfer });

      if (path === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      else if (path === "pointercancel") fireEvent.pointerCancel(window);
      else if (path === "dragend") fireEvent.dragEnd(handle, { dataTransfer });
      else if (path === "blur") fireEvent.blur(window);
      else fireEvent.drop(window, { dataTransfer });

      await waitFor(() => expect(document.querySelector(".pane-drag-active")).toBeNull());
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.root.first.paneId).toBe("primary");
      expect(saved.root.second.paneId).toBe("secondary");
      expect(bridge.disposePaneSession).not.toHaveBeenCalled();
    },
  );

  it("focuses visible panes with Ctrl/Cmd+1..4 shortcuts", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await screen.findByTestId("pane-secondary");
    await act(async () => {});

    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "secondary input" }));
    expect(screen.getByTestId("pane-secondary").dataset.focused).toBe("true");
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "primary input" }));
  });

  it("keeps split, close, divider, and rearrangement controls discoverable by role and name", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await screen.findByTestId("pane-secondary");

    expect(screen.getByRole("button", { name: "Split Right" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Split Down" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close secondary pane" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rearrange panes" })).toBeTruthy();
    expect(
      screen.getByRole("separator", { name: "Resize horizontal workspace panes" }),
    ).toBeTruthy();
    expect(screen.getByRole("separator").getAttribute("aria-controls")).toBe(
      "workspace-pane-primary workspace-pane-secondary",
    );
  });

  it("resizes with pointer and keyboard and persists the ratio", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await waitForInitialWorkspaceReady();
    const divider = screen.getByRole("separator");
    vi.spyOn(divider.parentElement!, "getBoundingClientRect").mockReturnValue({
      width: 1000,
      height: 700,
    } as DOMRect);
    const addWindowListener = vi.spyOn(window, "addEventListener");

    const pointerDown = new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: 500,
      isPrimary: true,
      pointerId: 4,
      pointerType: "mouse",
    });
    expect([pointerDown.pointerId, pointerDown.clientX]).toEqual([4, 500]);
    act(() => fireEvent(divider, pointerDown));
    expect(addWindowListener.mock.calls.some(([type]) => type === "pointermove")).toBe(true);

    const pointerMove = new PointerEvent("pointermove", {
      bubbles: true,
      button: -1,
      buttons: 1,
      clientX: 600,
      isPrimary: true,
      pointerId: 4,
      pointerType: "mouse",
    });
    expect([pointerMove.pointerId, pointerMove.clientX]).toEqual([4, 600]);
    act(() => fireEvent(window, pointerMove));
    await waitFor(() => expect(divider.getAttribute("aria-valuenow")).toBe("60"));
    act(() =>
      fireEvent(
        window,
        new PointerEvent("pointerup", {
          bubbles: true,
          button: 0,
          buttons: 0,
          clientX: 600,
          isPrimary: true,
          pointerId: 4,
          pointerType: "mouse",
        }),
      ),
    );
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    await waitFor(() => expect(divider.getAttribute("aria-valuenow")).toBe("55"));

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.root.size.value).toBe(55);
    });
  });

  it("keeps pane lifecycle callbacks and effects stable across unrelated rerenders", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await waitForInitialWorkspaceReady();

    const initialCallback = latestPaneProps.get("primary")?.onLifecycleError;
    const initialExecutionCount = lifecycleEffectExecutions.get("primary");
    expect(initialCallback).toBeTypeOf("function");
    expect(initialExecutionCount).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Rearrange panes" }));

    expect(latestPaneProps.get("primary")?.onLifecycleError).toBe(initialCallback);
    expect(lifecycleEffectExecutions.get("primary")).toBe(initialExecutionCount);
    expect(lifecycleCallbacks.get("primary")).toEqual([initialCallback]);
  });

  it("routes lifecycle errors through the pane that reported them", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await screen.findByTestId("pane-secondary");

    latestPaneProps.get("secondary")?.onLifecycleError?.(new Error("secondary restore failed"));

    expect(
      await screen.findByText(/Pane secondary could not restore its saved session/),
    ).toBeTruthy();
    expect(screen.queryByText(/Pane primary could not restore its saved session/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  });

  it("updates the native title from a changed focused-pane snapshot", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await screen.findByTestId("pane-secondary");
    await waitFor(() => expect(bridge.setWindowTitle).toHaveBeenLastCalledWith("/one"));

    emitPaneSnapshot("primary", { sessionTitle: "Renamed session" });

    await waitFor(() => expect(bridge.setWindowTitle).toHaveBeenLastCalledWith("Renamed session"));
  });

  it("gates closure after active work changes in a pane snapshot", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await waitForInitialWorkspaceReady();

    const titleCallCount = bridge.setWindowTitle.mock.calls.length;
    emitPaneSnapshot("secondary", { activeWork: true });
    await waitFor(() =>
      expect(bridge.setWindowTitle.mock.calls.length).toBeGreaterThan(titleCallCount),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));

    expect(screen.getByText(/Pane secondary has active work/)).toBeTruthy();
    expect(bridge.disposePaneSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });

  it("ignores repeated code-mode chat-agent defaults during target synchronization", async () => {
    saveTwoPaneLayout();
    const persist = vi.spyOn(Storage.prototype, "setItem");
    render(<WorkspaceShell renderPane={renderPane} />);
    await screen.findByTestId("pane-secondary");
    await waitFor(() => expect(persist).toHaveBeenCalled());

    const persistenceCount = persist.mock.calls.length;
    await act(async () => {
      emitPaneSnapshot("primary", { chatAgent: "general" });
      emitPaneSnapshot("primary", { chatAgent: "general" });
    });

    expect(persist).toHaveBeenCalledTimes(persistenceCount);
    const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
    expect(saved.panes.primary).toEqual({
      kind: "agent",
      mode: "code",
      cwd: "/one",
      sessionPath: "/one.jsonl",
    });
  });

  it("persists changed pane target fields and project binding", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await screen.findByTestId("pane-secondary");
    await waitFor(() => expect(bridge.setWindowTitle).toHaveBeenLastCalledWith("/one"));

    await act(async () => {
      emitPaneSnapshot("primary", {
        mode: "chat",
        chatAgent: "research",
        cwd: "/changed",
        sessionPath: "/changed/session.jsonl",
        projectBound: true,
      });
    });

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.panes.primary).toEqual({
        kind: "agent",
        mode: "chat",
        chatAgent: "research",
        cwd: "/changed",
        sessionPath: "/changed/session.jsonl",
      });
    });

    await act(async () => {
      emitPaneSnapshot("primary", { cwd: null, sessionPath: null, projectBound: false });
    });
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.panes.primary).toBeNull();
    });
  });

  it("routes native drag feedback, drops, and titles through the focused pane", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await screen.findByTestId("pane-secondary");
    await waitFor(() => expect(bridge.nativeDropHandler).not.toBeNull());
    await waitFor(() => expect(bridge.setWindowTitle).toHaveBeenLastCalledWith("/one"));

    bridge.nativeDropHandler?.({ payload: { type: "enter", paths: [] } });
    expect(paneNativeDragStates.get("primary")).toEqual([true]);
    bridge.nativeDropHandler?.({ payload: { type: "drop", paths: ["/first"] } });
    expect(paneNativeDragStates.get("primary")).toEqual([true, false]);
    expect(paneDrops.get("primary")).toEqual([["/first"]]);
    expect(paneDrops.get("secondary")).toBeUndefined();

    fireEvent.focus(screen.getByRole("textbox", { name: "secondary input" }));
    await waitFor(() => expect(bridge.setWindowTitle).toHaveBeenLastCalledWith("/two"));
    bridge.nativeDropHandler?.({ payload: { type: "over", paths: [] } });
    bridge.nativeDropHandler?.({ payload: { type: "leave", paths: [] } });
    expect(paneNativeDragStates.get("secondary")).toEqual([true, false]);
    bridge.nativeDropHandler?.({ payload: { type: "drop", paths: ["/second"] } });
    expect(paneDrops.get("secondary")).toEqual([["/second"]]);
  });

  it("registers one global window shortcut action with multiple panes", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await waitForInitialWorkspaceReady();

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    await waitFor(() => expect(bridge.newWindow).toHaveBeenCalledOnce());
  });

  it("confirms autopilot-review active-work closure, awaits disposal once, then restores focus", async () => {
    activeWorkPanes.add("secondary");
    let acknowledgeDisposal: (() => void) | undefined;
    bridge.disposePaneSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledgeDisposal = resolve;
        }),
    );
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await waitForInitialWorkspaceReady();
    await act(async () => {
      emitPaneSnapshot("secondary", { generation: 12, activeWork: true });
    });

    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));
    expect(screen.getByText(/Pane secondary has active work/)).toBeTruthy();
    expect(bridge.disposePaneSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("pane-secondary")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));
    const confirmButton = screen.getByRole("button", { name: "Close Pane" });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    expect(bridge.disposePaneSession).toHaveBeenCalledTimes(1);
    expect(bridge.disposePaneSession).toHaveBeenCalledWith("secondary", 12);
    expect(screen.getByTestId("pane-secondary")).toBeTruthy();

    acknowledgeDisposal?.();
    await waitFor(() => expect(screen.queryByTestId("pane-secondary")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "primary input" }));
  });

  it("keeps the pane and retry surface when session disposal is rejected", async () => {
    activeWorkPanes.add("secondary");
    bridge.disposePaneSession.mockRejectedValueOnce(new Error("daemon unavailable"));
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await waitForInitialWorkspaceReady();

    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Pane" }));

    expect(
      await screen.findByText(
        "Pane secondary stayed open because its session could not be disposed. Try closing it again.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("pane-secondary")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Close Pane" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(bridge.disposePaneSession).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close Pane" }));
    await waitFor(() => expect(screen.queryByTestId("pane-secondary")).toBeNull());
    expect(bridge.disposePaneSession).toHaveBeenCalledTimes(2);
  });

  it("warns once for a stale pane restore target", async () => {
    failingRestorePanes.add("secondary");
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);

    expect(
      await screen.findByText(/Pane secondary could not restore its saved session/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rearrange panes" }));
    fireEvent.click(screen.getByRole("button", { name: "Rearrange panes" }));
    expect(screen.getAllByText(/Pane secondary could not restore its saved session/)).toHaveLength(
      1,
    );
    expect(lifecycleEffectExecutions.get("secondary")).toBe(1);
  });

  it("warns once when workspace storage cannot be read", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    render(<WorkspaceShell renderPane={renderPane} />);

    expect(await screen.findByText(/Workspace layout could not be read/)).toBeTruthy();
    expect(screen.getAllByText(/Workspace layout could not be read/)).toHaveLength(1);
  });

  it("warns once and preserves malformed workspace bytes", async () => {
    localStorage.setItem("gg-workspace-layout-recursive:main", "{malformed");
    render(<WorkspaceShell renderPane={renderPane} />);

    expect(await screen.findByText(/Workspace layout was malformed/)).toBeTruthy();
    expect(localStorage.getItem("gg-workspace-layout-recursive-rejected:main")).toBe("{malformed");
    expect(screen.getAllByText(/Workspace layout was malformed/)).toHaveLength(1);
  });

  it("clamps horizontal, vertical, and nested splits to pixel minima with narrow fallback", () => {
    const leaf = (paneId: string) => ({ type: "leaf" as const, paneId });
    const horizontal = {
      type: "split" as const,
      direction: "horizontal" as const,
      ratio: 50,
      size: { type: "ratio" as const, value: 50 },
      first: leaf("one"),
      second: leaf("two"),
    };
    expect(clampWorkspaceSplitRatio(horizontal, [], "horizontal", 5, 1024)).toBeCloseTo(
      (280 / 1017) * 100,
    );
    expect(clampWorkspaceSplitRatio(horizontal, [], "horizontal", 95, 500)).toBe(90);

    const nested = {
      ...horizontal,
      first: {
        type: "split" as const,
        direction: "horizontal" as const,
        ratio: 50,
        size: { type: "ratio" as const, value: 50 },
        first: leaf("one"),
        second: leaf("three"),
      },
    };
    expect(clampWorkspaceSplitRatio(nested, [], "horizontal", 10, 1200)).toBeCloseTo(
      (567 / 1193) * 100,
    );

    const vertical = { ...horizontal, direction: "vertical" as const };
    expect(clampWorkspaceSplitRatio(vertical, [], "vertical", 5, 800)).toBeCloseTo(
      (280 / 793) * 100,
    );
  });

  it("closes an auxiliary session, collapses the tree, and restores focus", async () => {
    saveTwoPaneLayout();
    render(<WorkspaceShell renderPane={renderPane} />);
    await screen.findByTestId("pane-secondary");
    fireEvent.click(screen.getByRole("button", { name: "Close secondary pane" }));

    await waitFor(() => expect(screen.queryByTestId("pane-secondary")).toBeNull());
    expect(bridge.disposePaneSession).toHaveBeenCalledWith("secondary");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "primary input" }));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("gg-workspace-layout-recursive:main")!);
      expect(saved.root).toEqual({ type: "leaf", paneId: "primary" });
      expect(saved.panes.secondary).toBeUndefined();
    });
  });
});
