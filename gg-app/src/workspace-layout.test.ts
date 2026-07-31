import { describe, expect, it, vi } from "vitest";
import {
  MAX_WORKSPACE_PANES,
  WORKSPACE_LAYOUT_VERSION,
  defaultWorkspaceLayout,
  focusWorkspacePane,
  loadWorkspaceLayout,
  moveWorkspacePane,
  parseWorkspaceLayout,
  recursiveWorkspaceLayoutKey,
  rejectedRecursiveWorkspaceLayoutKey,
  removeWorkspacePane,
  resolveWorkspaceLayoutTargets,
  saveWorkspaceLayout,
  setWorkspacePaneTarget,
  splitWorkspacePane,
  updateWorkspaceSplitRatio,
  validateWorkspaceLayoutCandidate,
  workspaceLayoutKey,
  workspaceLayoutLeafIds,
  type WorkspaceLayoutNode,
} from "./workspace-layout";

const agent = (cwd: string, sessionPath: string | null = null) => ({
  kind: "agent" as const,
  mode: "code" as const,
  cwd,
  sessionPath,
});
const chatAgent = (cwd: string, chatAgent: "general" | "therapist" | "research" = "general") => ({
  kind: "agent" as const,
  mode: "chat" as const,
  chatAgent,
  cwd,
  sessionPath: null,
});
const terminal = (cwd: string) => ({ kind: "terminal", cwd, sessionPath: null, stopped: true });
const leaf = (paneId: string): WorkspaceLayoutNode => ({ type: "leaf", paneId });
const split = (
  first: WorkspaceLayoutNode,
  second: WorkspaceLayoutNode,
  ratio = 50,
): WorkspaceLayoutNode => ({
  type: "split",
  direction: "horizontal",
  ratio,
  size: { type: "ratio", value: ratio },
  first,
  second,
});
const dock = (first: WorkspaceLayoutNode, second: WorkspaceLayoutNode): unknown => ({
  type: "split",
  direction: "vertical",
  size: { type: "fixed-second", pixels: 260 },
  first,
  second,
});
const stored = (node: WorkspaceLayoutNode): unknown =>
  node.type === "leaf"
    ? node
    : {
        type: "split",
        direction: node.direction,
        size: node.size,
        first: stored(node.first),
        second: stored(node.second),
      };
const legacy = (
  version: 7 | 8,
  root: unknown,
  panes: Record<string, unknown>,
  focusedPaneId = "primary",
) =>
  JSON.stringify({
    version,
    root,
    focusedPaneId,
    panes,
    ...(version === 8 ? { defaultTerminalBootstrap: "complete" } : {}),
  });
const canonical = (
  root: WorkspaceLayoutNode,
  panes: Record<string, unknown>,
  focusedPaneId = "primary",
  extras = {},
) => ({ version: 9, root: stored(root), focusedPaneId, panes, ...extras });
const store = () => {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  };
};

describe("canonical agent-only v9 schema", () => {
  it("uses version 9 and only recursive ratio trees", () => {
    expect(WORKSPACE_LAYOUT_VERSION).toBe(9);
    const layout = defaultWorkspaceLayout();
    expect(layout.version).toBe(9);
    expect(workspaceLayoutLeafIds(layout.root)).toEqual(["primary", "secondary"]);
  });

  it("accepts PaneSessionTarget-compatible code and chat descriptors", () => {
    const value = canonical(split(leaf("primary"), leaf("chat")), {
      primary: agent("/code"),
      chat: chatAgent("/chat", "research"),
    });
    expect(validateWorkspaceLayoutCandidate(value)?.panes).toEqual(value.panes);
  });

  it("defaults missing legacy mode to code and missing chatAgent to general", () => {
    const oldCode = parseWorkspaceLayout(
      legacy(8, leaf("primary"), { primary: { kind: "agent", cwd: "/code", sessionPath: null } }),
    );
    expect(oldCode.layout.panes.primary).toEqual(agent("/code"));
    const oldChat = parseWorkspaceLayout(
      legacy(8, leaf("primary"), {
        primary: { kind: "agent", mode: "chat", cwd: "/chat", sessionPath: null },
      }),
    );
    expect(oldChat.layout.panes.primary).toEqual(chatAgent("/chat"));
  });

  it.each([
    { kind: "agent", mode: "chat", chatAgent: "invalid", cwd: "/a", sessionPath: null },
    { kind: "agent", mode: "code", chatAgent: "general", cwd: "/a", sessionPath: null },
    { kind: "agent", mode: "invalid", cwd: "/a", sessionPath: null },
  ])("rejects invalid current target %#", (descriptor) => {
    expect(
      validateWorkspaceLayoutCandidate(canonical(leaf("primary"), { primary: descriptor })),
    ).toBeNull();
  });

  it("strictly accepts exact v9 records", () => {
    const value = canonical(
      split(leaf("primary"), leaf("secondary"), 65),
      { primary: agent("/a"), secondary: null },
      "secondary",
    );
    const parsed = parseWorkspaceLayout(JSON.stringify(value));
    expect(parsed.status).toBe("valid");
    expect(parsed.layout).toMatchObject({
      version: 9,
      focusedPaneId: "secondary",
      panes: { primary: agent("/a"), secondary: null },
    });
  });

  it.each([
    ["terminal descriptor", canonical(leaf("primary"), { primary: terminal("/a") })],
    [
      "fixed-second split",
      canonical(dock(leaf("primary"), leaf("secondary")) as WorkspaceLayoutNode, {
        primary: agent("/a"),
        secondary: null,
      }),
    ],
    [
      "removed bootstrap metadata",
      canonical(leaf("primary"), { primary: null }, "primary", {
        defaultTerminalBootstrap: "complete",
      }),
    ],
    [
      "removed terminal metadata",
      canonical(leaf("primary"), { primary: null }, "primary", { terminal: { open: false } }),
    ],
    ["missing primary", canonical(leaf("secondary"), { secondary: null }, "secondary")],
    ["stale descriptor", canonical(leaf("primary"), { primary: null, stale: null })],
    [
      "kindless descriptor",
      canonical(leaf("primary"), { primary: { cwd: "/a", sessionPath: null } }),
    ],
  ])("rejects %s", (_name, value) => {
    expect(validateWorkspaceLayoutCandidate(value)).toBeNull();
    expect(parseWorkspaceLayout(JSON.stringify(value)).status).toBe("corrupt");
  });

  it("rejects invalid focus and extra nested node metadata", () => {
    const invalidFocus = canonical(leaf("primary"), { primary: null }, "missing");
    expect(validateWorkspaceLayoutCandidate(invalidFocus)).toBeNull();

    const rootWithExtraMetadata = {
      type: "split",
      direction: "horizontal",
      size: { type: "ratio", value: 50, pixels: 200 },
      first: { type: "leaf", paneId: "primary", stopped: true },
      second: leaf("secondary"),
      terminal: { open: false },
    };
    expect(
      validateWorkspaceLayoutCandidate({
        version: 9,
        root: rootWithExtraMetadata,
        focusedPaneId: "primary",
        panes: { primary: null, secondary: null },
      }),
    ).toBeNull();
  });

  it("enforces the 12-leaf policy", () => {
    let accepted = leaf("primary");
    const panes: Record<string, unknown> = { primary: null };
    for (let index = 1; index < MAX_WORKSPACE_PANES; index++) {
      accepted = split(accepted, leaf(`pane-${index}`));
      panes[`pane-${index}`] = null;
    }
    expect(validateWorkspaceLayoutCandidate(canonical(accepted, panes))).not.toBeNull();
    expect(
      validateWorkspaceLayoutCandidate(
        canonical(split(accepted, leaf("pane-12")), { ...panes, "pane-12": null }),
      ),
    ).toBeNull();
  });
});

describe("v7/v8 terminal pruning migration", () => {
  it.each([7, 8] as const)(
    "recursively prunes terminals and collapses split branches from v%s",
    (version) => {
      const root = {
        type: "split",
        direction: "horizontal",
        size: { type: "ratio", value: 60 },
        first: dock(leaf("primary"), leaf("terminal-1")),
        second: {
          type: "split",
          direction: "horizontal",
          size: { type: "ratio", value: 40 },
          first: leaf("terminal-2"),
          second: leaf("secondary"),
        },
      };
      const result = parseWorkspaceLayout(
        legacy(
          version,
          root,
          {
            primary: agent("/a"),
            "terminal-1": terminal("/a"),
            "terminal-2": terminal("/b"),
            secondary: agent("/b"),
            stale: agent("/stale"),
          },
          "terminal-1",
        ),
      );
      expect(result.status).toBe("migrated");
      expect(result.layout.root).toEqual(split(leaf("primary"), leaf("secondary"), 60));
      expect(result.layout.panes).toEqual({ primary: agent("/a"), secondary: agent("/b") });
      expect(result.layout.focusedPaneId).toBe("primary");
    },
  );

  it("preserves surviving focused agent and prunes unreferenced descriptors", () => {
    const result = parseWorkspaceLayout(
      legacy(
        8,
        stored(split(leaf("primary"), leaf("secondary"))),
        { primary: agent("/a"), secondary: agent("/b") },
        "secondary",
      ),
    );
    expect(result).toMatchObject({ status: "migrated", layout: { focusedPaneId: "secondary" } });
  });

  it("uses the old 64-leaf safety limit before pruning terminals", () => {
    let root: unknown = leaf("primary");
    const panes: Record<string, unknown> = { primary: agent("/a") };
    for (let index = 1; index <= 63; index += 1) {
      const paneId = `terminal-${index}`;
      root = {
        type: "split",
        direction: "horizontal",
        size: { type: "ratio", value: 50 },
        first: root,
        second: leaf(paneId),
      };
      panes[paneId] = terminal(`/terminal/${index}`);
    }

    const result = parseWorkspaceLayout(legacy(8, root, panes, "terminal-63"));
    expect(result.status).toBe("migrated");
    expect(result.layout).toMatchObject({
      root: leaf("primary"),
      focusedPaneId: "primary",
      panes: { primary: agent("/a") },
    });
  });

  it.each([7, 8] as const)(
    "replaces terminal-only v%s with the exact primary fallback",
    (version) => {
      const result = parseWorkspaceLayout(
        legacy(version, leaf("terminal-1"), { "terminal-1": terminal("/a") }, "terminal-1"),
      );
      expect(result.status).toBe("migrated");
      expect(result.layout).toMatchObject({
        version: 9,
        root: leaf("primary"),
        focusedPaneId: "primary",
        panes: { primary: null },
      });
      expect(Object.keys(result.layout.panes)).toEqual(["primary"]);
    },
  );
});

describe("v0-v6 migration", () => {
  it("preserves agent tree migration while ignoring terminal dock data", () => {
    const v6 = JSON.stringify({
      version: 6,
      root: {
        type: "split",
        direction: "horizontal",
        ratio: 65,
        first: leaf("primary"),
        second: leaf("secondary"),
      },
      focusedPaneId: "secondary",
      panes: {
        primary: { cwd: "/a", sessionPath: null },
        secondary: { cwd: "/b", sessionPath: null },
      },
      terminal: { open: true, ownerPaneId: "primary", dockHeightPx: 420 },
    });
    const result = parseWorkspaceLayout(v6);
    expect(result.status).toBe("migrated");
    expect(workspaceLayoutLeafIds(result.layout.root)).toEqual(["primary", "secondary"]);
    expect(result.layout.panes).toEqual({ primary: agent("/a"), secondary: agent("/b") });
    expect(JSON.stringify(result.layout)).not.toContain("terminal");
  });

  it.each([0, 1, 2, 3, 4, 5])("migrates v%s without projecting terminal data", (version) => {
    const value: Record<string, unknown> =
      version === 0
        ? { version, ratio: 55, primary: { cwd: "/a" }, secondary: null }
        : {
            version,
            splitRatio: 55,
            secondaryOpen: true,
            focusedPaneId: "secondary",
            panes: { primary: { cwd: "/a", sessionPath: null }, secondary: null },
            terminal: { open: true, ownerPaneId: "primary", dockHeightPx: 999 },
          };
    const result = parseWorkspaceLayout(JSON.stringify(value));
    expect(result.status).toBe("migrated");
    expect(workspaceLayoutLeafIds(result.layout.root)).toEqual(["primary", "secondary"]);
    expect(JSON.stringify(result.layout)).not.toContain("terminal");
  });
});

describe("storage cutover", () => {
  it("saves only canonical recursive v9 and removes the old active key", () => {
    const { storage, values } = store();
    values.set(workspaceLayoutKey("main"), "old");
    const layout = validateWorkspaceLayoutCandidate(
      canonical(leaf("primary"), { primary: agent("/a") }),
    )!;
    expect(saveWorkspaceLayout(storage, "main", layout)).toBe(true);
    expect(values.has(workspaceLayoutKey("main"))).toBe(false);
    expect(JSON.parse(values.get(recursiveWorkspaceLayoutKey("main"))!)).toEqual(
      canonical(leaf("primary"), { primary: agent("/a") }),
    );
  });

  it("treats obsolete-key removal as best effort after a successful write", () => {
    const setItem = vi.fn();
    expect(
      saveWorkspaceLayout(
        {
          getItem: () => null,
          setItem,
          removeItem: () => {
            throw new Error("remove");
          },
        },
        "main",
        validateWorkspaceLayoutCandidate(canonical(leaf("primary"), { primary: null }))!,
      ),
    ).toBe(true);
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("still reads old keys and preserves rejected recursive bytes", () => {
    const { storage, values } = store();
    values.set(workspaceLayoutKey("main"), legacy(7, leaf("primary"), { primary: agent("/a") }));
    expect(loadWorkspaceLayout(storage, "main").status).toBe("migrated");
    values.set(recursiveWorkspaceLayoutKey("bad"), "bad bytes");
    const bad = loadWorkspaceLayout(storage, "bad");
    expect(bad).toMatchObject({
      status: "corrupt",
      rejectedRaw: "bad bytes",
      rejectedSource: "recursive",
    });
    expect(values.get(rejectedRecursiveWorkspaceLayoutKey("bad"))).toBe("bad bytes");
  });
});

describe("agent-only reducers and target resolution", () => {
  it("refuses requested pane IDs after reaching the 12-agent limit", () => {
    let root = leaf("primary");
    const panes: Record<string, unknown> = { primary: null };
    for (let index = 1; index < MAX_WORKSPACE_PANES; index += 1) {
      root = split(root, leaf(`pane-${index}`));
      panes[`pane-${index}`] = null;
    }
    const layout = validateWorkspaceLayoutCandidate(canonical(root, panes))!;

    expect(splitWorkspacePane(layout, "primary", "horizontal", "pane-12")).toBe(layout);
  });

  it("removes, focuses, and updates targets immutably", () => {
    const layout = validateWorkspaceLayoutCandidate(
      canonical(split(leaf("primary"), leaf("secondary")), {
        primary: agent("/a"),
        secondary: null,
      }),
    )!;
    const focused = focusWorkspacePane(layout, "secondary");
    expect(focused.focusedPaneId).toBe("secondary");
    const targeted = setWorkspacePaneTarget(focused, "secondary", {
      mode: "chat",
      chatAgent: "therapist",
      cwd: "/chat",
      sessionPath: null,
    });
    expect(targeted.panes.secondary).toEqual(chatAgent("/chat", "therapist"));
    expect(layout.panes.secondary).toBeNull();
    const removed = removeWorkspacePane(targeted, "secondary");
    expect(removed.root).toEqual(leaf("primary"));
    expect(removed.focusedPaneId).toBe("primary");
  });

  describe("pane moves", () => {
    const twoPaneLayout = () =>
      validateWorkspaceLayoutCandidate(
        canonical(split(leaf("primary"), leaf("secondary")), {
          primary: agent("/primary", "/primary.jsonl"),
          secondary: chatAgent("/chat", "research"),
        }),
      )!;

    it.each([
      ["left", "horizontal", ["secondary", "primary"]],
      ["right", "horizontal", ["primary", "secondary"]],
      ["up", "vertical", ["secondary", "primary"]],
      ["down", "vertical", ["primary", "secondary"]],
    ] as const)("moves a pane %s of its target", (placement, direction, orderedPaneIds) => {
      const original = twoPaneLayout();
      const moved = moveWorkspacePane(original, {
        sourcePaneId: "secondary",
        targetPaneId: "primary",
        placement,
      });

      expect(moved).not.toBe(original);
      expect(moved.root).toMatchObject({ type: "split", direction });
      expect(workspaceLayoutLeafIds(moved.root)).toEqual(orderedPaneIds);
      expect(moved.focusedPaneId).toBe("secondary");
    });

    it("collapses a nested source branch and reinserts the same leaf by the nested target", () => {
      const root = split(
        split(leaf("primary"), leaf("pane-1"), 60),
        split(leaf("pane-2"), leaf("pane-3"), 40),
        55,
      );
      const layout = validateWorkspaceLayoutCandidate(
        canonical(root, {
          primary: agent("/primary"),
          "pane-1": agent("/one"),
          "pane-2": agent("/two"),
          "pane-3": agent("/three"),
        }),
      )!;

      const moved = moveWorkspacePane(layout, {
        sourcePaneId: "pane-1",
        targetPaneId: "pane-3",
        placement: "down",
      });

      expect(workspaceLayoutLeafIds(moved.root)).toEqual(["primary", "pane-2", "pane-3", "pane-1"]);
      expect(JSON.stringify(moved.root)).toContain('"direction":"vertical"');
      expect(moved.focusedPaneId).toBe("pane-1");
    });

    it("preserves descriptor identity and contains every pane exactly once", () => {
      const original = twoPaneLayout();
      const primaryDescriptor = original.panes.primary;
      const secondaryDescriptor = original.panes.secondary;

      const moved = moveWorkspacePane(original, {
        sourcePaneId: "secondary",
        targetPaneId: "primary",
        placement: "left",
      });

      expect(moved.panes).not.toBe(original.panes);
      expect(moved.panes.primary).toBe(primaryDescriptor);
      expect(moved.panes.secondary).toBe(secondaryDescriptor);
      expect(workspaceLayoutLeafIds(moved.root).sort()).toEqual(["primary", "secondary"]);
      expect(Object.keys(moved.panes).sort()).toEqual(["primary", "secondary"]);
      expect(original.root).toEqual(split(leaf("primary"), leaf("secondary")));
    });

    it.each([
      { sourcePaneId: "primary", targetPaneId: "primary", placement: "left" },
      { sourcePaneId: "missing", targetPaneId: "primary", placement: "left" },
      { sourcePaneId: "secondary", targetPaneId: "missing", placement: "left" },
      { sourcePaneId: "secondary", targetPaneId: "primary", placement: "center" },
      { sourcePaneId: "secondary", targetPaneId: "primary" },
      null,
    ])("returns the original layout for rejected request %#", (request) => {
      const original = twoPaneLayout();
      expect(moveWorkspacePane(original, request)).toBe(original);
    });
  });

  it("splits, resizes, moves, and validates targets", async () => {
    let layout = validateWorkspaceLayoutCandidate(
      canonical(split(leaf("primary"), leaf("secondary")), {
        primary: agent("/a"),
        secondary: agent("/b", "/stale"),
      }),
    )!;
    layout = splitWorkspacePane(layout, "primary", "vertical", "pane-1");
    expect(layout.panes["pane-1"]).toBeNull();
    layout = updateWorkspaceSplitRatio(layout, [], 80);
    layout = moveWorkspacePane(layout, {
      sourcePaneId: "secondary",
      targetPaneId: "primary",
      placement: "left",
    });
    expect(layout.focusedPaneId).toBe("secondary");
    const resolved = await resolveWorkspaceLayoutTargets(layout, async ({ cwd }) => ({
      projectExists: cwd !== "/a",
      sessionExists: false,
    }));
    expect(resolved.panes.primary).toBeNull();
    expect(resolved.panes.secondary).toEqual(agent("/b"));
  });
});
