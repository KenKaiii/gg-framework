import { mkdtempSync } from "node:fs";
import { mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "./event-bus.js";
import type * as ConfigModule from "../config.js";

// Hoisted-mock indirection (same pattern as project-discovery.test.ts):
// vi.mock is hoisted above imports, so the mock reads `state` at call time.
const state = { agentDir: "" };

vi.mock("../config.js", async (orig) => {
  const actual = await orig<typeof ConfigModule>();
  return {
    ...actual,
    getAppPaths: () => ({ ...actual.getAppPaths(), agentDir: state.agentDir }),
  };
});
import {
  SessionDiagnosticsRecorder,
  aggregateRecentDiagnostics,
  createDiagnoseCommand,
  diagnosticsSessionsDir,
  isInternalDiagnosticsEnabled,
  resetInternalDiagnosticsCacheForTests,
} from "./internal-diagnostics.js";

// The sessions dir is env-overridable precisely so tests never touch the
// real ~/.gg. The flag file lives under getAppPaths().agentDir (real home),
// so flag tests use the env switch only, plus a direct file test via
// process.env.HOME pointing at a temp dir.
let tmpHome: string;
let tmpDir: string;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "ggdiag-home-"));
  state.agentDir = path.join(tmpHome, ".gg");
  tmpDir = path.join(tmpHome, "diag-sessions");
  process.env.GG_DIAGNOSTICS_DIR = tmpDir;
  process.env.GG_INTERNAL = "";
});

afterEach(async () => {
  delete process.env.GG_DIAGNOSTICS_DIR;
  delete process.env.GG_INTERNAL;
  await rm(tmpHome, { recursive: true, force: true });
});

describe("isInternalDiagnosticsEnabled", () => {
  it("is off by default", () => {
    resetInternalDiagnosticsCacheForTests();
    expect(isInternalDiagnosticsEnabled()).toBe(false);
  });

  it("turns on via GG_INTERNAL=1", () => {
    resetInternalDiagnosticsCacheForTests();
    process.env.GG_INTERNAL = "1";
    expect(isInternalDiagnosticsEnabled()).toBe(true);
  });

  it("turns on via ~/.gg/internal.json diagnostics:true, and nothing else", async () => {
    resetInternalDiagnosticsCacheForTests();
    await mkdir(path.join(tmpHome, ".gg"), { recursive: true });
    await writeFile(path.join(tmpHome, ".gg", "internal.json"), `{"diagnostics":true}`);
    expect(isInternalDiagnosticsEnabled()).toBe(true);

    resetInternalDiagnosticsCacheForTests();
    await writeFile(path.join(tmpHome, ".gg", "internal.json"), `{"diagnostics":false}`);
    expect(isInternalDiagnosticsEnabled()).toBe(false);
  });
});

describe("SessionDiagnosticsRecorder", () => {
  function recorder(): SessionDiagnosticsRecorder {
    return new SessionDiagnosticsRecorder({
      sessionId: "s1",
      cwd: "/tmp/proj",
      provider: "glm",
      model: "glm-5.3",
      dir: tmpDir,
    });
  }

  it("counts tool calls, errors, durations, and writes the record per turn", async () => {
    const bus = new EventBus();
    const rec = recorder();
    rec.attach(bus);

    bus.emit("tool_call_start", { toolCallId: "t1", name: "grep", args: { pattern: "foo" } });
    bus.emit("tool_call_end", {
      toolCallId: "t1",
      result: "src/a.ts:1:foo",
      isError: false,
      durationMs: 40,
    });
    bus.emit("tool_call_start", { toolCallId: "t2", name: "bash", args: { command: "ls" } });
    bus.emit("tool_call_end", {
      toolCallId: "t2",
      result: "Error: command failed with code N",
      isError: true,
      durationMs: 100,
    });
    rec.recordTurnMetric({
      turn: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50, cacheRead: 800 },
      timing: { providerDurationMs: 900, ttftMs: 300 },
    });
    await vi.waitFor(async () => {
      const files = await readdir(tmpDir);
      expect(files).toHaveLength(1);
    });

    const raw = await readFile(path.join(tmpDir, "s1.json"), "utf8");
    const record = JSON.parse(raw);
    expect(record.toolStats.grep).toMatchObject({ calls: 1, errors: 0, totalMs: 40, maxMs: 40 });
    expect(record.toolStats.bash).toMatchObject({ calls: 1, errors: 1, maxMs: 100 });
    expect(record.totals).toMatchObject({
      toolCalls: 2,
      toolErrors: 1,
      inputTokens: 100,
      cacheRead: 800,
    });
    expect(record.errorClusters[0].count).toBe(1);
    expect(record.errorClusters[0].digest).toContain("code N");
    expect(record.turns[0]).toMatchObject({ turn: 1, ttftMs: 300 });
  });

  it("clusters repeated identical errors and flags repeated identical calls", async () => {
    const bus = new EventBus();
    const rec = recorder();
    rec.attach(bus);

    for (let i = 0; i < 4; i++) {
      bus.emit("tool_call_start", { toolCallId: `r${i}`, name: "grep", args: { pattern: "same" } });
      bus.emit("tool_call_end", {
        toolCallId: `r${i}`,
        result: "Error: exit code 1",
        isError: true,
        durationMs: 10,
      });
    }
    await rec.finalize();

    expect(rec.repeatsForTests()).toEqual([
      { tool: "grep", argsDigest: expect.stringContaining("same"), count: 4 },
    ]);
    // 4 identical failures → ONE cluster row with count 4, not four rows
    expect(rec.errorClustersForTests()).toHaveLength(1);
    expect(rec.errorClustersForTests()[0].count).toBe(4);
  });

  it("records model switches, compactions, and truncations", async () => {
    const bus = new EventBus();
    const rec = recorder();
    rec.attach(bus);

    bus.emit("model_change", { provider: "openai", model: "gpt-5.5" });
    bus.emit("compaction_end", { compacted: true, originalCount: 40, newCount: 8 });
    bus.emit("truncated", { reason: "max_tokens", continued: true });
    await rec.finalize();

    const snapshot = rec.snapshotForTests();
    expect(snapshot.modelSwitches).toHaveLength(1);
    expect(snapshot.compactions).toEqual([{ originalCount: 40, newCount: 8 }]);
    expect(snapshot.truncations).toEqual([{ reason: "max_tokens", continued: true }]);
  });

  it("summary() is agent-readable and includes cache reuse", () => {
    const bus = new EventBus();
    const rec = recorder();
    rec.attach(bus);
    rec.recordTurnMetric({
      turn: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 10, cacheRead: 900 },
      timing: { providerDurationMs: 500 },
    });
    const text = rec.summary();
    expect(text).toContain("reuse");
    expect(text).toContain("90%"); // 900 / (900 + 100)
  });
});

describe("aggregateRecentDiagnostics + /diagnose", () => {
  it("ranks cross-session findings from persisted records", async () => {
    // Two sessions: one healthy, one leaky (repeats + errors + low cache).
    for (const [id, leaky] of [
      ["healthy", false],
      ["leaky", true],
    ] as const) {
      const bus = new EventBus();
      const rec = new SessionDiagnosticsRecorder({
        sessionId: id,
        cwd: "/tmp/proj",
        provider: "glm",
        model: "glm-5.3",
        dir: tmpDir,
      });
      rec.attach(bus);
      const errors = leaky ? 5 : 0;
      for (let i = 0; i < 6; i++) {
        bus.emit("tool_call_start", {
          toolCallId: `${id}-${i}`,
          name: "grep",
          args: { pattern: "x" },
        });
        bus.emit("tool_call_end", {
          toolCallId: `${id}-${i}`,
          result: i < errors ? "Error: exit code 1" : "ok",
          isError: i < errors,
          durationMs: leaky ? 900 : 50,
        });
      }
      rec.recordTurnMetric({
        turn: 1,
        stopReason: "end_turn",
        usage: leaky
          ? { inputTokens: 900, outputTokens: 50 }
          : { inputTokens: 100, outputTokens: 50, cacheRead: 900 },
        timing: { providerDurationMs: 500 },
      });
      await rec.finalize();
    }

    const { report, sessionCount } = aggregateRecentDiagnostics(10);
    expect(sessionCount).toBe(2);
    expect(report).toContain("grep");
    expect(report).toContain("5\u00d7"); // clustered error count surfaced
    expect(report.toLowerCase()).toContain("repeat");
  });

  it("/diagnose returns the aggregate report", async () => {
    const cmd = createDiagnoseCommand();
    expect(cmd.name).toBe("diagnose");
    const out = await cmd.execute("5", {} as never);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("handles an empty diagnostics dir without throwing", () => {
    const { report, sessionCount } = aggregateRecentDiagnostics(10);
    expect(sessionCount).toBe(0);
    expect(report.toLowerCase()).toContain("no session");
  });
});

describe("diagnosticsSessionsDir", () => {
  it("respects GG_DIAGNOSTICS_DIR", () => {
    expect(diagnosticsSessionsDir()).toBe(tmpDir);
  });
});
