import type { ChatAgentId, PaneSessionTarget, WorkspaceMode } from "./agent";
import { PRIMARY_PANE_ID } from "./pane-routing";

export const WORKSPACE_LAYOUT_VERSION = 9;
export const DEFAULT_SPLIT_RATIO = 50;
export const MIN_SPLIT_RATIO = 10;
export const MAX_SPLIT_RATIO = 90;
export const MAX_WORKSPACE_PANES = 12;
export const MAX_WORKSPACE_LAYOUT_DEPTH = MAX_WORKSPACE_PANES;
const MAX_LEGACY_WORKSPACE_LAYOUT_LEAVES = 64;
const MAX_LEGACY_WORKSPACE_LAYOUT_DEPTH = 64;
const MAX_V6_WORKSPACE_LAYOUT_DEPTH = 4;
const MAX_WORKSPACE_PANE_ID_BYTES = 64;

export type WorkspacePaneId = string;
export type SplitDirection = "horizontal" | "vertical";
export type PanePlacement = "left" | "right" | "up" | "down";
export interface PaneMoveRequest {
  sourcePaneId: WorkspacePaneId;
  targetPaneId: WorkspacePaneId;
  placement: PanePlacement;
}
export interface LeafNode {
  type: "leaf";
  paneId: WorkspacePaneId;
}
export interface RatioSplitSize {
  type: "ratio";
  value: number;
}
export interface SplitNode {
  type: "split";
  direction: SplitDirection;
  ratio: number;
  size: RatioSplitSize;
  first: WorkspaceLayoutNode;
  second: WorkspaceLayoutNode;
}
export type WorkspaceLayoutNode = LeafNode | SplitNode;
export interface WorkspacePaneTarget extends PaneSessionTarget {
  mode: WorkspaceMode;
  cwd: string;
  sessionPath: string | null;
  chatAgent?: ChatAgentId;
}
export interface AgentPaneDescriptor extends WorkspacePaneTarget {
  kind: "agent";
}
export type WorkspacePaneValue = AgentPaneDescriptor | null;
export interface WorkspaceLayout {
  version: typeof WORKSPACE_LAYOUT_VERSION;
  root: WorkspaceLayoutNode;
  focusedPaneId: WorkspacePaneId;
  panes: Record<WorkspacePaneId, WorkspacePaneValue>;
}
export type WorkspaceLayoutSaveInput = WorkspaceLayout;
export type WorkspaceLayoutLoadStatus = "missing" | "valid" | "migrated" | "corrupt" | "load-error";
export interface WorkspaceLayoutLoadResult {
  layout: WorkspaceLayout;
  status: WorkspaceLayoutLoadStatus;
  rejectedRaw?: string;
  rejectedSource?: "legacy" | "recursive";
}
export interface WorkspaceTargetStatus {
  projectExists: boolean;
  sessionExists: boolean;
}
interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export function isValidWorkspacePaneId(value: unknown): value is WorkspacePaneId {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_WORKSPACE_PANE_ID_BYTES &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}
export function isPanePlacement(value: unknown): value is PanePlacement {
  return value === "left" || value === "right" || value === "up" || value === "down";
}
export function isPaneMoveRequest(value: unknown): value is PaneMoveRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    isValidWorkspacePaneId(record.sourcePaneId) &&
    isValidWorkspacePaneId(record.targetPaneId) &&
    isPanePlacement(record.placement)
  );
}
export function workspaceLayoutKey(windowLabel: string): string {
  return `gg-workspace-layout:${windowLabel}`;
}
export function recursiveWorkspaceLayoutKey(windowLabel: string): string {
  return `gg-workspace-layout-recursive:${windowLabel}`;
}
export function rejectedWorkspaceLayoutKey(windowLabel: string): string {
  return `gg-workspace-layout-rejected:${windowLabel}`;
}
export function rejectedRecursiveWorkspaceLayoutKey(windowLabel: string): string {
  return `gg-workspace-layout-recursive-rejected:${windowLabel}`;
}
export function clampStoredSplitRatio(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value))
    : DEFAULT_SPLIT_RATIO;
}
export function workspaceLayoutLeafIds(root: WorkspaceLayoutNode): WorkspacePaneId[] {
  return root.type === "leaf"
    ? [root.paneId]
    : [...workspaceLayoutLeafIds(root.first), ...workspaceLayoutLeafIds(root.second)];
}
export type WorkspaceLayoutPath = readonly ("first" | "second")[];
export interface WorkspaceLayoutLeafInfo {
  paneId: WorkspacePaneId;
  node: LeafNode;
  path: WorkspaceLayoutPath;
  descriptorKind: "agent";
}
export type WorkspaceLayoutHelperResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function isChatAgentId(value: unknown): value is ChatAgentId {
  return value === "general" || value === "therapist" || value === "research";
}
function parseTarget(
  value: unknown,
  allowMissingSessionPath = false,
  allowMissingMode = false,
): WorkspacePaneTarget | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.cwd !== "string" || !record.cwd.trim()) return undefined;
  if (
    record.sessionPath !== null &&
    record.sessionPath !== undefined &&
    typeof record.sessionPath !== "string"
  )
    return undefined;
  if (record.sessionPath === undefined && !allowMissingSessionPath) return undefined;
  const mode = record.mode === undefined && allowMissingMode ? "code" : record.mode;
  if (mode !== "code" && mode !== "chat") return undefined;
  if (record.chatAgent !== undefined && !isChatAgentId(record.chatAgent)) return undefined;
  if (mode === "code" && record.chatAgent !== undefined) return undefined;
  return {
    mode,
    cwd: record.cwd,
    sessionPath:
      typeof record.sessionPath === "string" && record.sessionPath ? record.sessionPath : null,
    ...(mode === "chat" ? { chatAgent: record.chatAgent ?? "general" } : {}),
  };
}
function parseAgent(value: unknown, requireKind: boolean): WorkspacePaneValue | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    (requireKind && record.kind !== "agent") ||
    (!requireKind && record.kind !== undefined && record.kind !== "agent")
  )
    return undefined;
  const allowed =
    record.kind === "agent"
      ? ["kind", "mode", "chatAgent", "cwd", "sessionPath"]
      : ["mode", "chatAgent", "cwd", "sessionPath"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) return undefined;
  const target = parseTarget(record);
  return target ? { kind: "agent", ...target } : undefined;
}
function ratioNode(
  direction: SplitDirection,
  ratio: number,
  first: WorkspaceLayoutNode,
  second: WorkspaceLayoutNode,
): SplitNode {
  const value = clampStoredSplitRatio(ratio);
  return { type: "split", direction, ratio: value, size: { type: "ratio", value }, first, second };
}
function normalizeLayout(
  root: WorkspaceLayoutNode,
  focusedPaneId: string,
  panes: Record<string, WorkspacePaneValue>,
): WorkspaceLayout {
  const visible = workspaceLayoutLeafIds(root);
  return {
    version: WORKSPACE_LAYOUT_VERSION,
    root,
    focusedPaneId: visible.includes(focusedPaneId)
      ? focusedPaneId
      : visible.includes(PRIMARY_PANE_ID)
        ? PRIMARY_PANE_ID
        : visible[0],
    panes,
  };
}
function freshWorkspaceLayout(): WorkspaceLayout {
  return normalizeLayout({ type: "leaf", paneId: PRIMARY_PANE_ID }, PRIMARY_PANE_ID, {
    primary: null,
  });
}
export function defaultWorkspaceLayout(): WorkspaceLayout {
  return normalizeLayout(
    ratioNode(
      "horizontal",
      50,
      { type: "leaf", paneId: "primary" },
      { type: "leaf", paneId: "secondary" },
    ),
    "primary",
    { primary: null, secondary: null },
  );
}

function parseNode(
  value: unknown,
  depth: number,
  ids: Set<string>,
  mode: "v6" | "legacy" | "v9",
): WorkspaceLayoutNode | null {
  const maxDepth =
    mode === "v6"
      ? MAX_V6_WORKSPACE_LAYOUT_DEPTH
      : mode === "legacy"
        ? MAX_LEGACY_WORKSPACE_LAYOUT_DEPTH
        : MAX_WORKSPACE_LAYOUT_DEPTH;
  const maxLeaves = mode === "legacy" ? MAX_LEGACY_WORKSPACE_LAYOUT_LEAVES : MAX_WORKSPACE_PANES;
  if (depth > maxDepth || typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "leaf") {
    if (
      (mode === "v9" && Object.keys(record).some((key) => !["type", "paneId"].includes(key))) ||
      !isValidWorkspacePaneId(record.paneId) ||
      ids.has(record.paneId)
    )
      return null;
    ids.add(record.paneId);
    return ids.size <= maxLeaves ? { type: "leaf", paneId: record.paneId } : null;
  }
  if (
    record.type !== "split" ||
    (record.direction !== "horizontal" && record.direction !== "vertical") ||
    (mode === "v9" &&
      Object.keys(record).some(
        (key) => !["type", "direction", "size", "first", "second"].includes(key),
      ))
  )
    return null;
  let ratio: number;
  if (mode === "v6") {
    if (typeof record.ratio !== "number" || !Number.isFinite(record.ratio)) return null;
    ratio = record.ratio;
  } else {
    if (typeof record.size !== "object" || record.size === null) return null;
    const size = record.size as Record<string, unknown>;
    if (
      size.type === "ratio" &&
      typeof size.value === "number" &&
      Number.isFinite(size.value) &&
      (mode !== "v9" || Object.keys(size).every((key) => ["type", "value"].includes(key)))
    )
      ratio = size.value;
    else if (
      mode === "legacy" &&
      size.type === "fixed-second" &&
      typeof size.pixels === "number" &&
      Number.isFinite(size.pixels)
    )
      ratio = DEFAULT_SPLIT_RATIO;
    else return null;
  }
  const first = parseNode(record.first, depth + 1, ids, mode);
  const second = parseNode(record.second, depth + 1, ids, mode);
  return first && second ? ratioNode(record.direction, ratio, first, second) : null;
}

export function validateWorkspaceLayoutCandidate(candidate: unknown): WorkspaceLayout | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const record = candidate as Record<string, unknown>;
  if (
    record.version !== WORKSPACE_LAYOUT_VERSION ||
    Object.keys(record).some((key) => !["version", "root", "focusedPaneId", "panes"].includes(key))
  )
    return null;
  const ids = new Set<string>();
  const root = parseNode(record.root, 1, ids, "v9");
  if (
    !root ||
    !ids.has(PRIMARY_PANE_ID) ||
    typeof record.focusedPaneId !== "string" ||
    !ids.has(record.focusedPaneId) ||
    typeof record.panes !== "object" ||
    record.panes === null
  )
    return null;
  const rawPanes = record.panes as Record<string, unknown>;
  const keys = Object.keys(rawPanes);
  if (keys.length !== ids.size || keys.some((key) => !ids.has(key))) return null;
  const panes: Record<string, WorkspacePaneValue> = {};
  for (const key of keys) {
    const pane = parseAgent(rawPanes[key], true);
    if (pane === undefined) return null;
    panes[key] = pane;
  }
  if (panes.primary !== null && panes.primary?.kind !== "agent") return null;
  return normalizeLayout(root, record.focusedPaneId, panes);
}

function parseLegacyAgent(value: unknown): WorkspacePaneValue | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== "agent") return undefined;
  const allowed = ["kind", "mode", "chatAgent", "cwd", "sessionPath"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) return undefined;
  const target = parseTarget(record, false, true);
  return target ? { kind: "agent", ...target } : undefined;
}

function migrateLegacyTree(record: Record<string, unknown>): WorkspaceLayout | null {
  const ids = new Set<string>();
  const root = parseNode(record.root, 1, ids, "legacy");
  if (!root || typeof record.panes !== "object" || record.panes === null) return null;
  const rawPanes = record.panes as Record<string, unknown>;
  const terminalIds = new Set<string>();
  const agents: Record<string, WorkspacePaneValue> = {};
  for (const id of ids) {
    const raw = rawPanes[id];
    if (
      typeof raw === "object" &&
      raw !== null &&
      (raw as Record<string, unknown>).kind === "terminal"
    ) {
      const terminal = raw as Record<string, unknown>;
      if (
        Object.keys(terminal).some(
          (key) => !["kind", "cwd", "sessionPath", "stopped"].includes(key),
        ) ||
        terminal.stopped !== true ||
        !parseTarget(terminal, false, true)
      )
        return null;
      terminalIds.add(id);
    } else {
      const agent = parseLegacyAgent(raw);
      if (agent === undefined) return null;
      agents[id] = agent;
    }
  }
  const prune = (node: WorkspaceLayoutNode): WorkspaceLayoutNode | null => {
    if (node.type === "leaf") return terminalIds.has(node.paneId) ? null : node;
    const first = prune(node.first),
      second = prune(node.second);
    if (!first) return second;
    if (!second) return first;
    return ratioNode(node.direction, node.size.value, first, second);
  };
  const surviving = prune(root);
  if (!surviving || !workspaceLayoutLeafIds(surviving).includes(PRIMARY_PANE_ID))
    return freshWorkspaceLayout();
  const survivingIds = workspaceLayoutLeafIds(surviving);
  if (survivingIds.length > MAX_WORKSPACE_PANES) return null;
  const panes = Object.fromEntries(survivingIds.map((id) => [id, agents[id] ?? null]));
  const focus =
    typeof record.focusedPaneId === "string" && survivingIds.includes(record.focusedPaneId)
      ? record.focusedPaneId
      : survivingIds.includes(PRIMARY_PANE_ID)
        ? PRIMARY_PANE_ID
        : survivingIds[0];
  return normalizeLayout(surviving, focus, panes);
}

function migrateV0ToV6(record: Record<string, unknown>): WorkspaceLayout | null {
  let root: WorkspaceLayoutNode;
  let rawPanes: Record<string, unknown>;
  let focused: string;
  if (record.version === 6) {
    const ids = new Set<string>();
    const parsed = parseNode(record.root, 1, ids, "v6");
    if (
      !parsed ||
      !ids.has(PRIMARY_PANE_ID) ||
      typeof record.panes !== "object" ||
      record.panes === null
    )
      return null;
    root = parsed;
    rawPanes = record.panes as Record<string, unknown>;
    if (
      Object.keys(rawPanes).length !== ids.size ||
      Object.keys(rawPanes).some((id) => !ids.has(id))
    )
      return null;
    focused = typeof record.focusedPaneId === "string" ? record.focusedPaneId : "primary";
  } else {
    let primary: WorkspacePaneTarget | null | undefined;
    let secondary: WorkspacePaneTarget | null | undefined;
    if (record.version === 0) {
      primary = parseTarget(record.primary ?? null, true, true);
      secondary = parseTarget(record.secondary ?? null, true, true);
    } else {
      if (typeof record.panes !== "object" || record.panes === null) return null;
      const p = record.panes as Record<string, unknown>;
      primary = parseTarget(p.primary, false, true);
      secondary = parseTarget(p.secondary, false, true);
    }
    if (primary === undefined || secondary === undefined) return null;
    const open =
      record.version === 0 || record.version === 1 ? true : record.secondaryOpen === true;
    root = open
      ? ratioNode(
          "horizontal",
          record.version === 0 ? (record.ratio as number) : (record.splitRatio as number),
          { type: "leaf", paneId: "primary" },
          { type: "leaf", paneId: "secondary" },
        )
      : { type: "leaf", paneId: "primary" };
    rawPanes = { primary, ...(open ? { secondary } : {}) };
    focused =
      record.version === 3 || record.version === 4 || record.version === 5
        ? String(record.focusedPaneId ?? "primary")
        : "primary";
  }
  const panes: Record<string, WorkspacePaneValue> = {};
  for (const id of workspaceLayoutLeafIds(root)) {
    const target = parseTarget(rawPanes[id], false, true);
    if (target === undefined) return null;
    panes[id] = target ? { kind: "agent", ...target } : null;
  }
  return normalizeLayout(root, focused, panes);
}

export function parseWorkspaceLayout(raw: string): WorkspaceLayoutLoadResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { layout: defaultWorkspaceLayout(), status: "corrupt" };
  }
  if (typeof value !== "object" || value === null)
    return { layout: defaultWorkspaceLayout(), status: "corrupt" };
  const record = value as Record<string, unknown>;
  if (record.version === WORKSPACE_LAYOUT_VERSION) {
    const layout = validateWorkspaceLayoutCandidate(record);
    return layout
      ? { layout, status: "valid" }
      : { layout: defaultWorkspaceLayout(), status: "corrupt" };
  }
  if (record.version === 7 || record.version === 8) {
    const layout = migrateLegacyTree(record);
    return layout
      ? { layout, status: "migrated" }
      : { layout: defaultWorkspaceLayout(), status: "corrupt" };
  }
  if ([0, 1, 2, 3, 4, 5, 6].includes(record.version as number)) {
    const layout = migrateV0ToV6(record);
    return layout
      ? { layout, status: "migrated" }
      : { layout: defaultWorkspaceLayout(), status: "corrupt" };
  }
  return { layout: defaultWorkspaceLayout(), status: "corrupt" };
}

export function loadWorkspaceLayout(
  storage: LayoutStorage,
  windowLabel: string,
): WorkspaceLayoutLoadResult {
  try {
    const recursiveRaw = storage.getItem(recursiveWorkspaceLayoutKey(windowLabel));
    if (recursiveRaw !== null) {
      const result = parseWorkspaceLayout(recursiveRaw);
      if (result.status !== "corrupt") return result;
      try {
        storage.setItem(rejectedRecursiveWorkspaceLayoutKey(windowLabel), recursiveRaw);
      } catch {
        // Rejected-byte preservation is best effort.
      }
      return { ...result, rejectedRaw: recursiveRaw, rejectedSource: "recursive" };
    }
    const raw = storage.getItem(workspaceLayoutKey(windowLabel));
    if (raw === null) return { layout: freshWorkspaceLayout(), status: "missing" };
    const result = parseWorkspaceLayout(raw);
    return result.status === "corrupt"
      ? { ...result, rejectedRaw: raw, rejectedSource: "legacy" }
      : result;
  } catch {
    return { layout: defaultWorkspaceLayout(), status: "load-error" };
  }
}
export function preserveRejectedWorkspaceLayout(
  storage: LayoutStorage,
  windowLabel: string,
  raw: string,
): boolean {
  try {
    storage.setItem(rejectedWorkspaceLayoutKey(windowLabel), raw);
    return true;
  } catch {
    return false;
  }
}
export function preserveRejectedRecursiveWorkspaceLayout(
  storage: LayoutStorage,
  windowLabel: string,
  raw: string,
): boolean {
  try {
    storage.setItem(rejectedRecursiveWorkspaceLayoutKey(windowLabel), raw);
    return true;
  } catch {
    return false;
  }
}
function canonicalRecord(layout: WorkspaceLayout) {
  const strip = (node: WorkspaceLayoutNode): unknown =>
    node.type === "leaf"
      ? { type: "leaf", paneId: node.paneId }
      : {
          type: "split",
          direction: node.direction,
          size: node.size,
          first: strip(node.first),
          second: strip(node.second),
        };
  return {
    version: WORKSPACE_LAYOUT_VERSION,
    root: strip(layout.root),
    focusedPaneId: layout.focusedPaneId,
    panes: Object.fromEntries(
      Object.entries(layout.panes).map(([id, pane]) => [
        id,
        pane
          ? {
              kind: "agent",
              mode: pane.mode,
              ...(pane.mode === "chat" ? { chatAgent: pane.chatAgent ?? "general" } : {}),
              cwd: pane.cwd,
              sessionPath: pane.sessionPath,
            }
          : null,
      ]),
    ),
  };
}
export function saveWorkspaceLayout(
  storage: LayoutStorage,
  windowLabel: string,
  input: WorkspaceLayoutSaveInput,
): boolean {
  try {
    const layout = validateWorkspaceLayoutCandidate(canonicalRecord(input));
    if (!layout) return false;
    storage.setItem(
      recursiveWorkspaceLayoutKey(windowLabel),
      JSON.stringify(canonicalRecord(layout)),
    );
    try {
      storage.removeItem?.(workspaceLayoutKey(windowLabel));
    } catch {
      // Removing the obsolete key is best effort after the canonical write.
    }
    return true;
  } catch {
    return false;
  }
}

export function findWorkspaceLayoutLeaf(
  root: WorkspaceLayoutNode,
  paneId: WorkspacePaneId,
  panes: Record<string, WorkspacePaneValue>,
  path: WorkspaceLayoutPath = [],
): WorkspaceLayoutLeafInfo | null {
  if (root.type === "leaf")
    return root.paneId === paneId && panes[root.paneId] !== undefined
      ? { paneId, node: root, path, descriptorKind: "agent" }
      : null;
  return (
    findWorkspaceLayoutLeaf(root.first, paneId, panes, [...path, "first"]) ??
    findWorkspaceLayoutLeaf(root.second, paneId, panes, [...path, "second"])
  );
}
export function isVisibleWorkspaceLeaf(layout: WorkspaceLayout, paneId: string): boolean {
  return findWorkspaceLayoutLeaf(layout.root, paneId, layout.panes) !== null;
}
export function removeWorkspaceLayoutLeafAndCollapse(
  root: WorkspaceLayoutNode,
  paneId: string,
  isRoot = true,
): WorkspaceLayoutHelperResult<{ root: WorkspaceLayoutNode; removed: LeafNode }> {
  if (root.type === "leaf")
    return root.paneId === paneId && isRoot
      ? { ok: false, reason: "cannot-remove-root-leaf" }
      : { ok: false, reason: "leaf-not-found" };
  if (root.first.type === "leaf" && root.first.paneId === paneId)
    return { ok: true, value: { root: root.second, removed: root.first } };
  if (root.second.type === "leaf" && root.second.paneId === paneId)
    return { ok: true, value: { root: root.first, removed: root.second } };
  const first = removeWorkspaceLayoutLeafAndCollapse(root.first, paneId, false);
  if (first.ok)
    return {
      ok: true,
      value: { root: { ...root, first: first.value.root }, removed: first.value.removed },
    };
  const second = removeWorkspaceLayoutLeafAndCollapse(root.second, paneId, false);
  return second.ok
    ? {
        ok: true,
        value: { root: { ...root, second: second.value.root }, removed: second.value.removed },
      }
    : second;
}
export function insertWorkspaceLayoutLeafNearTarget(
  root: WorkspaceLayoutNode,
  detachedLeaf: LeafNode,
  targetPaneId: string,
  placement: unknown,
): WorkspaceLayoutHelperResult<WorkspaceLayoutNode> {
  if (!isPanePlacement(placement)) return { ok: false, reason: "invalid-placement" };
  let inserted = false;
  const visit = (node: WorkspaceLayoutNode): WorkspaceLayoutNode => {
    if (node.type === "leaf") {
      if (node.paneId !== targetPaneId) return node;
      inserted = true;
      const direction = placement === "left" || placement === "right" ? "horizontal" : "vertical";
      return placement === "left" || placement === "up"
        ? ratioNode(direction, 50, detachedLeaf, node)
        : ratioNode(direction, 50, node, detachedLeaf);
    }
    const first = visit(node.first);
    if (inserted) return { ...node, first };
    return { ...node, second: visit(node.second) };
  };
  const value = visit(root);
  return inserted ? { ok: true, value } : { ok: false, reason: "target-not-found" };
}
export function prepareMoveWorkspacePaneCandidate(
  layout: WorkspaceLayout,
  request: unknown,
): WorkspaceLayoutHelperResult<WorkspaceLayout> {
  if (!isPaneMoveRequest(request)) return { ok: false, reason: "invalid-request" };
  if (request.sourcePaneId === request.targetPaneId)
    return { ok: false, reason: "same-source-target" };
  const removed = removeWorkspaceLayoutLeafAndCollapse(layout.root, request.sourcePaneId);
  if (!removed.ok) return removed;
  const inserted = insertWorkspaceLayoutLeafNearTarget(
    removed.value.root,
    removed.value.removed,
    request.targetPaneId,
    request.placement,
  );
  if (!inserted.ok) return inserted;
  const candidate = normalizeLayout(inserted.value, request.sourcePaneId, { ...layout.panes });
  return validateWorkspaceLayoutCandidate(canonicalRecord(candidate))
    ? { ok: true, value: candidate }
    : { ok: false, reason: "invalid-candidate" };
}
export function moveWorkspacePane(layout: WorkspaceLayout, request: unknown): WorkspaceLayout {
  const result = prepareMoveWorkspacePaneCandidate(layout, request);
  return result.ok ? result.value : layout;
}
export function allocateWorkspacePaneId(layout: WorkspaceLayout): string | null {
  if (workspaceLayoutLeafIds(layout.root).length >= MAX_WORKSPACE_PANES) return null;
  let highest = 0;
  for (const id of Object.keys(layout.panes)) {
    const match = /^pane-(\d+)$/.exec(id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `pane-${highest + 1}`;
}
export function splitWorkspacePane(
  layout: WorkspaceLayout,
  paneId: string,
  direction: SplitDirection,
  requestedPaneId?: string,
): WorkspaceLayout {
  if (direction !== "horizontal" && direction !== "vertical") return layout;
  if (workspaceLayoutLeafIds(layout.root).length >= MAX_WORKSPACE_PANES) return layout;
  const id = requestedPaneId ?? allocateWorkspacePaneId(layout);
  if (!id || !isValidWorkspacePaneId(id) || layout.panes[id] !== undefined) return layout;
  let changed = false;
  const visit = (node: WorkspaceLayoutNode): WorkspaceLayoutNode =>
    node.type === "leaf"
      ? node.paneId === paneId
        ? ((changed = true), ratioNode(direction, 50, node, { type: "leaf", paneId: id }))
        : node
      : { ...node, first: visit(node.first), second: visit(node.second) };
  const root = visit(layout.root);
  return changed ? normalizeLayout(root, id, { ...layout.panes, [id]: null }) : layout;
}
function updateAt(
  node: WorkspaceLayoutNode,
  path: WorkspaceLayoutPath,
  ratio: number,
  index = 0,
): WorkspaceLayoutNode | null {
  if (index === path.length)
    return node.type === "split" ? ratioNode(node.direction, ratio, node.first, node.second) : null;
  if (node.type !== "split") return null;
  const side = path[index];
  const child = updateAt(node[side], path, ratio, index + 1);
  return child ? { ...node, [side]: child } : null;
}
export function updateWorkspaceSplitRatio(
  layout: WorkspaceLayout,
  path: WorkspaceLayoutPath,
  ratio: number,
): WorkspaceLayout {
  const root = updateAt(layout.root, path, ratio);
  return root ? normalizeLayout(root, layout.focusedPaneId, layout.panes) : layout;
}
export function removeWorkspacePane(layout: WorkspaceLayout, paneId: string): WorkspaceLayout {
  if (paneId === PRIMARY_PANE_ID) return layout;
  const result = removeWorkspaceLayoutLeafAndCollapse(layout.root, paneId);
  if (!result.ok) return layout;
  const panes = { ...layout.panes };
  delete panes[paneId];
  return normalizeLayout(result.value.root, layout.focusedPaneId, panes);
}
export function focusWorkspacePane(layout: WorkspaceLayout, paneId: string): WorkspaceLayout {
  return isVisibleWorkspaceLeaf(layout, paneId) && paneId !== layout.focusedPaneId
    ? { ...layout, focusedPaneId: paneId }
    : layout;
}
export function setWorkspacePaneTarget(
  layout: WorkspaceLayout,
  paneId: string,
  target: WorkspacePaneTarget | null,
): WorkspaceLayout {
  if (!isVisibleWorkspaceLeaf(layout, paneId)) return layout;
  const parsed = target === null ? null : parseAgent({ kind: "agent", ...target }, true);
  if (parsed === undefined) return layout;
  return { ...layout, panes: { ...layout.panes, [paneId]: parsed } };
}
export async function resolveWorkspaceLayoutTargets(
  layout: WorkspaceLayout,
  validate: (target: WorkspacePaneTarget) => Promise<WorkspaceTargetStatus>,
): Promise<WorkspaceLayout> {
  const panes = { ...layout.panes };
  for (const [id, pane] of Object.entries(panes))
    if (pane)
      try {
        const status = await validate(pane);
        if (!status.projectExists) panes[id] = null;
        else if (pane.sessionPath && !status.sessionExists)
          panes[id] = { ...pane, sessionPath: null };
      } catch {
        panes[id] = null;
      }
  return normalizeLayout(layout.root, layout.focusedPaneId, panes);
}
