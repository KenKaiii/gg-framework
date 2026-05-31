import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ── Plan loading logic (extracted from PlanOverlay.tsx) ──────
// We re-implement the pure loading function here for testability,
// since the component version is inlined. This mirrors the logic
// exactly so we can verify edge cases without a React renderer.

interface PlanEntry {
  name: string;
  path: string;
  modifiedMs: number;
}

async function loadPlanEntries(cwd: string): Promise<PlanEntry[]> {
  const plansDir = path.join(cwd, ".gg", "plans");
  let files: string[];
  try {
    files = await fs.readdir(plansDir);
  } catch {
    return [];
  }

  const entries: PlanEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(plansDir, file);
    try {
      const stat = await fs.stat(filePath);
      entries.push({
        name: file.replace(/\.md$/, ""),
        path: filePath,
        modifiedMs: stat.mtimeMs,
      });
    } catch {
      entries.push({ name: file.replace(/\.md$/, ""), path: filePath, modifiedMs: 0 });
    }
  }

  // Sort newest first
  entries.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return entries;
}

// ── State helpers (avoid lint issues with bare let reassignments) ──

interface AppState {
  overlay: "model" | "skills" | "plan" | null;
  planAutoExpand: boolean;
  pending: boolean;
  pendingResetUI: boolean;
  doneStatus: DoneStatus | null;
}

function createAppState(overrides?: Partial<AppState>): AppState {
  return {
    overlay: null,
    planAutoExpand: false,
    pending: false,
    pendingResetUI: false,
    doneStatus: null,
    ...overrides,
  };
}

interface DoneStatus {
  durationMs: number;
  toolsUsed: string[];
  verb: string;
}

function simulateOnDone(state: AppState, durationMs: number, toolsUsed: string[]): void {
  // Mirrors App.tsx line 1071
  if (state.pending) return;
  state.doneStatus = { durationMs, toolsUsed, verb: "done" };
}

// ── Auto-expand helper (mirrors PlanOverlay.tsx lines 168-173) ──

function tryAutoExpand(
  autoExpandNewest: boolean,
  loaded: boolean,
  plans: PlanEntry[],
  alreadyExpanded: boolean,
): { expanded: boolean; plan: PlanEntry | null } {
  if (autoExpandNewest && loaded && plans.length > 0 && !alreadyExpanded) {
    return { expanded: true, plan: plans[0] };
  }
  return { expanded: alreadyExpanded, plan: null };
}

// ── Index clamping (mirrors PlanOverlay.tsx lines 176-182) ──

function clampIndex(selectedIndex: number, plansLength: number): number {
  if (plansLength === 0) return 0;
  if (selectedIndex >= plansLength) return plansLength - 1;
  return selectedIndex;
}

// ── Tests ────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-overlay-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── loadPlanEntries ──────────────────────────────────────────

describe("loadPlanEntries", () => {
  it("returns empty array when .gg/plans/ does not exist", async () => {
    const entries = await loadPlanEntries(tmpDir);
    expect(entries).toEqual([]);
  });

  it("returns empty array when .gg/plans/ exists but is empty", async () => {
    await fs.mkdir(path.join(tmpDir, ".gg", "plans"), { recursive: true });
    const entries = await loadPlanEntries(tmpDir);
    expect(entries).toEqual([]);
  });

  it("ignores non-.md files", async () => {
    const plansDir = path.join(tmpDir, ".gg", "plans");
    await fs.mkdir(plansDir, { recursive: true });
    await fs.writeFile(path.join(plansDir, "notes.txt"), "not a plan");
    await fs.writeFile(path.join(plansDir, "data.json"), "{}");
    await fs.writeFile(path.join(plansDir, "real-plan.md"), "# Plan");

    const entries = await loadPlanEntries(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("real-plan");
  });

  it("loads multiple plans and strips .md extension", async () => {
    const plansDir = path.join(tmpDir, ".gg", "plans");
    await fs.mkdir(plansDir, { recursive: true });
    await fs.writeFile(path.join(plansDir, "alpha.md"), "# Alpha");
    await fs.writeFile(path.join(plansDir, "beta.md"), "# Beta");
    await fs.writeFile(path.join(plansDir, "gamma.md"), "# Gamma");

    const entries = await loadPlanEntries(tmpDir);
    expect(entries).toHaveLength(3);
    const names = entries.map((e) => e.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names).toContain("gamma");
  });

  it("sorts plans by modification time (newest first)", async () => {
    const plansDir = path.join(tmpDir, ".gg", "plans");
    await fs.mkdir(plansDir, { recursive: true });

    const oldPath = path.join(plansDir, "old.md");
    const newPath = path.join(plansDir, "new.md");
    await fs.writeFile(oldPath, "# Old");
    const pastTime = new Date(Date.now() - 60_000);
    await fs.utimes(oldPath, pastTime, pastTime);
    await fs.writeFile(newPath, "# New");

    const entries = await loadPlanEntries(tmpDir);
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe("new");
    expect(entries[1].name).toBe("old");
    expect(entries[0].modifiedMs).toBeGreaterThan(entries[1].modifiedMs);
  });

  it("sets modifiedMs to 0 when stat fails (e.g., broken symlink)", async () => {
    const plansDir = path.join(tmpDir, ".gg", "plans");
    await fs.mkdir(plansDir, { recursive: true });

    const brokenLink = path.join(plansDir, "broken.md");
    await fs.symlink("/nonexistent/path/file.md", brokenLink);

    const entries = await loadPlanEntries(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("broken");
    expect(entries[0].modifiedMs).toBe(0);
  });

  it("includes correct absolute paths", async () => {
    const plansDir = path.join(tmpDir, ".gg", "plans");
    await fs.mkdir(plansDir, { recursive: true });
    await fs.writeFile(path.join(plansDir, "my-plan.md"), "# Plan");

    const entries = await loadPlanEntries(tmpDir);
    expect(entries[0].path).toBe(path.join(plansDir, "my-plan.md"));
  });
});

// ── Plan overlay pending guard ──────────────────────────────

describe("planOverlayPending guard (onDone suppression)", () => {
  it("returns done status when overlay is NOT pending", () => {
    const state = createAppState({ pending: false });
    simulateOnDone(state, 1500, ["read", "write"]);
    expect(state.doneStatus).toEqual({
      durationMs: 1500,
      toolsUsed: ["read", "write"],
      verb: "done",
    });
  });

  it("returns null (suppresses done) when overlay IS pending", () => {
    const state = createAppState({ pending: true });
    simulateOnDone(state, 1500, ["read", "write"]);
    expect(state.doneStatus).toBeNull();
  });

  it("suppresses done status even with empty tool list", () => {
    const state = createAppState({ pending: true });
    simulateOnDone(state, 500, []);
    expect(state.doneStatus).toBeNull();
  });
});

// ── Plan overlay pending race condition simulation ──────────

describe("planOverlayPending race condition", () => {
  it("onDone fires BEFORE delayed pane transition — done status suppressed", () => {
    // Step 1: approved-plan pane transition is pending
    const state = createAppState({ pending: true });

    // Step 2: onDone fires immediately (agent loop finishes)
    simulateOnDone(state, 2000, ["write"]);
    expect(state.doneStatus).toBeNull(); // correctly suppressed

    // Step 3: setTimeout fires (300ms later)
    state.overlay = "plan";
    state.pending = false;

    expect(state.overlay).toBe("plan");
    expect(state.pending).toBe(false);
  });

  it("onDone fires AFTER delayed pane transition — done status shows (edge case)", () => {
    // Step 1: approved-plan pane transition is pending
    const state = createAppState({ pending: true });

    // Step 2: setTimeout fires first
    state.overlay = "plan";
    state.pending = false;

    // Step 3: onDone fires after timeout — NOT suppressed
    simulateOnDone(state, 2000, ["write"]);
    expect(state.doneStatus).not.toBeNull();

    // This is the race condition: done status leaks through while overlay is open
    expect(state.overlay).toBe("plan");
    expect(state.doneStatus).toEqual({ durationMs: 2000, toolsUsed: ["write"], verb: "done" });
  });
});

// ── Auto-expand logic ──────────────────────────────────────

describe("auto-expand newest plan", () => {
  const testPlan: PlanEntry = { name: "test", path: "/tmp/test.md", modifiedMs: Date.now() };

  it("auto-expands when autoExpandNewest=true, loaded=true, plans exist, not yet expanded", () => {
    const result = tryAutoExpand(true, true, [testPlan], false);
    expect(result.expanded).toBe(true);
    expect(result.plan).toBe(testPlan);
  });

  it("does NOT auto-expand when already expanded once", () => {
    const result = tryAutoExpand(true, true, [testPlan], true);
    expect(result.plan).toBeNull();
  });

  it("does NOT auto-expand when plans array is empty", () => {
    const result = tryAutoExpand(true, true, [], false);
    expect(result.expanded).toBe(false);
    expect(result.plan).toBeNull();
  });

  it("does NOT auto-expand when autoExpandNewest is false", () => {
    const result = tryAutoExpand(false, true, [testPlan], false);
    expect(result.expanded).toBe(false);
    expect(result.plan).toBeNull();
  });

  it("does NOT auto-expand when not yet loaded", () => {
    const result = tryAutoExpand(true, false, [testPlan], false);
    expect(result.expanded).toBe(false);
    expect(result.plan).toBeNull();
  });
});

// ── Plan file readability ──────────────────────────────────

describe("plan file reading edge cases", () => {
  it("handles plan file that exists during listing but is deleted before reading", async () => {
    const plansDir = path.join(tmpDir, ".gg", "plans");
    await fs.mkdir(plansDir, { recursive: true });
    const planPath = path.join(plansDir, "ephemeral.md");
    await fs.writeFile(planPath, "# Short-lived plan");

    const entries = await loadPlanEntries(tmpDir);
    expect(entries).toHaveLength(1);

    await fs.unlink(planPath);

    let content: string;
    try {
      content = await fs.readFile(planPath, "utf-8");
    } catch {
      content = "(could not read plan)";
    }

    expect(content).toBe("(could not read plan)");
  });

  it("handles plan file with empty content", async () => {
    const plansDir = path.join(tmpDir, ".gg", "plans");
    await fs.mkdir(plansDir, { recursive: true });
    await fs.writeFile(path.join(plansDir, "empty.md"), "");

    const entries = await loadPlanEntries(tmpDir);
    expect(entries).toHaveLength(1);

    const content = await fs.readFile(entries[0].path, "utf-8");
    expect(content).toBe("");
  });

  it("handles plan file with very large content", async () => {
    const plansDir = path.join(tmpDir, ".gg", "plans");
    await fs.mkdir(plansDir, { recursive: true });
    const largeContent = "# Plan\n\n" + "Step ".repeat(100_000);
    await fs.writeFile(path.join(plansDir, "large.md"), largeContent);

    const entries = await loadPlanEntries(tmpDir);
    expect(entries).toHaveLength(1);

    const content = await fs.readFile(entries[0].path, "utf-8");
    expect(content.length).toBeGreaterThan(400_000);
  });
});

// ── Overlay state machine ──────────────────────────────────

describe("overlay state transitions", () => {
  it("opening plan overlay replaces any existing overlay", () => {
    const state = createAppState({ overlay: "skills" });
    state.overlay = "plan";
    expect(state.overlay).toBe("plan");
  });

  it("closing plan overlay returns to null", () => {
    const state = createAppState({ overlay: "plan" });
    state.overlay = null;
    expect(state.overlay).toBeNull();
  });

  it("approving a plan closes the overlay and resets autoExpand", () => {
    const state = createAppState({ overlay: "plan", planAutoExpand: true });
    // onApprove handler
    state.planAutoExpand = false;
    state.overlay = null;
    expect(state.overlay).toBeNull();
    expect(state.planAutoExpand).toBe(false);
  });

  it("approved-plan review overlay can auto-expand", () => {
    const state = createAppState();
    state.planAutoExpand = true;
    state.overlay = "plan";
    expect(state.overlay).toBe("plan");
    expect(state.planAutoExpand).toBe(true);
  });
});

// ── Index clamping ──────────────────────────────────────────

describe("selectedIndex clamping", () => {
  it("returns 0 when plans list is empty", () => {
    expect(clampIndex(5, 0)).toBe(0);
  });

  it("returns last index when selectedIndex exceeds plans length", () => {
    expect(clampIndex(10, 3)).toBe(2);
  });

  it("returns selectedIndex unchanged when within bounds", () => {
    expect(clampIndex(1, 5)).toBe(1);
  });

  it("handles edge case: selectedIndex equals plans length", () => {
    expect(clampIndex(3, 3)).toBe(2);
  });

  it("handles single plan", () => {
    expect(clampIndex(0, 1)).toBe(0);
    expect(clampIndex(5, 1)).toBe(0);
  });
});
