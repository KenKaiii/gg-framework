import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LspManager, type LspManagerOptions } from "./manager.js";
import { LspClientPool } from "./pool.js";
import type { LspServerSpec } from "./servers.js";
import { removeWhenReleased } from "./test-support.js";
import { setEditTelemetryPathForTests } from "./edit-telemetry.js";

const fixture = fileURLToPath(
  new URL("../../tools/__fixtures__/fake-lsp-server.mjs", import.meta.url),
);
let cwd: string;
let pool: LspClientPool;
const managers: LspManager[] = [];

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-async-diagnostics-"));
  await fs.writeFile(path.join(cwd, "fake-root.json"), "{}");
  pool = new LspClientPool();
  setEditTelemetryPathForTests(path.join(cwd, "edit-quality.jsonl"));
});
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.shutdownAll();
  pool.shutdownAll();
  setEditTelemetryPathForTests(undefined);
  await removeWhenReleased(cwd);
});

function server(args: string[] = []): LspServerSpec {
  return {
    id: "async-fake",
    extensions: [".fake"],
    rootMarkers: ["fake-root.json"],
    languageIdFor: () => "fake",
    resolveCommand: () => ({ command: process.execPath, args: [fixture, ...args] }),
  };
}

function manager(args: string[] = [], options: LspManagerOptions = {}) {
  const result = new LspManager(cwd, {
    pool,
    catalog: [server(args)],
    firstBudgetMs: 2000,
    warmBudgetMs: 1000,
    ...options,
  });
  managers.push(result);
  return result;
}

describe("asynchronous post-edit diagnostics", () => {
  it("serializes the same file across sessions sharing an unversioned server", async () => {
    const catalog = [server(["--delay-ms=100"])];
    const first = manager([], { catalog });
    const second = manager([], { catalog });
    first.queueDiagnosticsAfterWrite("a.fake", "clean first window");
    second.queueDiagnosticsAfterWrite("a.fake", "ERROR second window");
    await Promise.all([first.flushDiagnostics(), second.flushDiagnostics()]);
    expect(first.getLatestOutcome("a.fake")?.kind).toBe("clean");
    expect(second.getLatestOutcome("a.fake")?.kind).toBe("diagnostics");
    expect(second.drainDiagnostics()).toContain("fake error");
  });

  it("does not promote a late unversioned clean publish after timeout into verification", async () => {
    const lsp = manager(["--delay-ms=300"], { firstBudgetMs: 100, warmBudgetMs: 1000 });
    lsp.queueDiagnosticsAfterWrite("a.fake", "clean old edit");
    await lsp.flushDiagnostics();
    expect(lsp.getLatestOutcome("a.fake")?.kind).toBe("timeout");
    lsp.queueDiagnosticsAfterWrite("a.fake", "ERROR new edit");
    await lsp.flushDiagnostics();
    expect(lsp.getLatestOutcome("a.fake")?.kind).not.toBe("clean");
    expect(lsp.drainDiagnostics()).toContain("not verified");
  });

  it("retains timeout evidence without asking again after independent verification", async () => {
    const lsp = manager(["--silent"], { firstBudgetMs: 100 });
    lsp.queueDiagnosticsAfterWrite("a.fake", "clean");
    await lsp.flushDiagnostics();
    expect(lsp.drainDiagnostics(false)).toBe("");
    expect(lsp.getLatestOutcome("a.fake")?.kind).toBe("timeout");
  });

  it("batches silent-file timeouts at completion rather than interrupting each edit", async () => {
    const lsp = manager(["--silent"], { firstBudgetMs: 100, warmBudgetMs: 100 });
    lsp.queueDiagnosticsAfterWrite("a.fake", "clean first file");
    await lsp.flushDiagnostics();
    expect(lsp.drainDiagnostics(true, { deferUnverified: true })).toBe("");
    lsp.queueDiagnosticsAfterWrite("b.fake", "clean second file");
    await lsp.flushDiagnostics();
    expect(lsp.drainDiagnostics(true, { deferUnverified: true })).toBe("");
    const summary = lsp.drainDiagnostics();
    expect(summary).toContain("a.fake: diagnostics timeout; not verified");
    expect(summary).toContain("b.fake: diagnostics timeout; not verified");
    expect(lsp.drainDiagnostics()).toBe("");
  });

  it("clears deferred timeout notices after independent verification without claiming diagnostics passed", async () => {
    const lsp = manager(["--silent"], { firstBudgetMs: 100 });
    lsp.queueDiagnosticsAfterWrite("a.fake", "clean");
    await lsp.flushDiagnostics();
    expect(lsp.drainDiagnostics(true, { deferUnverified: true })).toBe("");
    expect(lsp.drainDiagnostics(false)).toBe("");
    expect(lsp.drainDiagnostics()).toBe("");
    expect(lsp.getLatestOutcome("a.fake")?.kind).toBe("timeout");
  });

  it("returns immediately, then exposes errors before completion, once", async () => {
    const lsp = manager(["--delay-ms=300"]);
    expect(lsp.queueDiagnosticsAfterWrite("a.fake", "ERROR")).toContain("queued");
    expect(lsp.drainDiagnostics()).toBe("");
    await lsp.flushDiagnostics();
    expect(lsp.drainDiagnostics()).toContain("fake error");
    expect(lsp.drainDiagnostics()).toBe("");
  });

  it("coalesces rapid edits and reports only the latest content", async () => {
    const lsp = manager(["--delay-ms=100"]);
    lsp.queueDiagnosticsAfterWrite("a.fake", "ERROR original");
    lsp.queueDiagnosticsAfterWrite("a.fake", "ERROR superseded");
    lsp.queueDiagnosticsAfterWrite("a.fake", "clean latest");
    await lsp.flushDiagnostics();
    expect(lsp.getLatestOutcome("a.fake")?.kind).toBe("clean");
    expect(lsp.drainDiagnostics()).toBe("");
  });

  it("does not let an earlier clean result hide the latest error", async () => {
    const lsp = manager(["--delay-ms=100"]);
    lsp.queueDiagnosticsAfterWrite("a.fake", "clean original");
    lsp.queueDiagnosticsAfterWrite("a.fake", "ERROR latest");
    await lsp.flushDiagnostics();
    expect(lsp.getLatestOutcome("a.fake")?.kind).toBe("diagnostics");
    expect(lsp.drainDiagnostics()).toContain("fake error");
  });

  it("rejects explicitly stale document versions", async () => {
    const lsp = manager(["--stale-version"], { firstBudgetMs: 250 });
    lsp.queueDiagnosticsAfterWrite("a.fake", "ERROR");
    await lsp.flushDiagnostics();
    expect(lsp.getLatestOutcome("a.fake")?.kind).toBe("timeout");
    expect(lsp.drainDiagnostics()).not.toContain("fake error");
  });

  it("keeps silence explicitly unverified, never clean", async () => {
    const lsp = manager(["--silent"], { firstBudgetMs: 250 });
    lsp.queueDiagnosticsAfterWrite("a.fake", "clean");
    await lsp.flushDiagnostics();
    expect(lsp.getLatestOutcome("a.fake")?.kind).toBe("timeout");
    expect(lsp.drainDiagnostics()).toContain("not verified");
  });

  it("cancels delivery and completion waits without stopping shared servers", async () => {
    const lsp = manager(["--delay-ms=500"]);
    lsp.queueDiagnosticsAfterWrite("a.fake", "ERROR");
    const controller = new AbortController();
    const waiting = lsp.flushDiagnostics(controller.signal);
    controller.abort();
    await waiting;
    lsp.clearPendingDiagnostics();
    expect(lsp.drainDiagnostics()).toBe("");
    lsp.queueDiagnosticsAfterWrite("a.fake", "clean new run");
    await lsp.flushDiagnostics();
    expect(lsp.drainDiagnostics()).toBe("");
    expect(lsp.getLatestOutcome("a.fake")?.kind).toBe("clean");
  });

  it("does not reuse a cancelled run's baseline when attributing a new edit", async () => {
    const lsp = manager(["--delay-ms=100"]);
    expect((await lsp.diagnosticsAfterWriteDetailed("a.fake", "clean baseline")).kind).toBe(
      "clean",
    );
    lsp.queueDiagnosticsAfterWrite("a.fake", "clean cancelled edit", "text");
    await Promise.resolve(); // Let the worker start before cancelling and reusing it.
    lsp.clearPendingDiagnostics();
    lsp.queueDiagnosticsAfterWrite("a.fake", "ERROR new run", "span");
    await lsp.flushDiagnostics();
    const output = lsp.drainDiagnostics();
    expect(output).toContain("fake error");
    expect(output).not.toContain("introduced");
    expect(await fs.readFile(path.join(cwd, "edit-quality.jsonl"), "utf8").catch(() => "")).toBe(
      "",
    );
  });

  it("still attributes an isolated edit with a known baseline", async () => {
    const lsp = manager();
    expect((await lsp.diagnosticsAfterWriteDetailed("a.fake", "clean baseline")).kind).toBe(
      "clean",
    );
    lsp.queueDiagnosticsAfterWrite("a.fake", "ERROR", "span");
    await lsp.flushDiagnostics();
    expect(lsp.drainDiagnostics()).toContain("introduced 1 error");
    expect(JSON.parse(await fs.readFile(path.join(cwd, "edit-quality.jsonl"), "utf8"))).toEqual(
      expect.objectContaining({ source: "span", before: 0, after: 1 }),
    );
  });

  it("bounds the queue and makes omitted checks explicit", async () => {
    const lsp = manager([], { snapshotLimit: 1 });
    lsp.queueDiagnosticsAfterWrite("a.fake", "clean");
    expect(lsp.queueDiagnosticsAfterWrite("b.fake", "ERROR")).toContain("not verified");
    await lsp.flushDiagnostics();
    expect(lsp.drainDiagnostics()).toContain("not verified");
  });
});
