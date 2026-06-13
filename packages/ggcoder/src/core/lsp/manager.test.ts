import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { LspManager } from "./manager.js";
import type { LspServerSpec } from "./servers.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tools/__fixtures__/fake-lsp-server.mjs",
);

function fakeSpec(serverArgs: string[] = [], overrides?: Partial<LspServerSpec>): LspServerSpec {
  return {
    id: "fake",
    extensions: [".fake"],
    rootMarkers: ["fake-root.json"],
    languageIdFor: () => "fake",
    resolveCommand: () => ({ command: process.execPath, args: [FIXTURE, ...serverArgs] }),
    ...overrides,
  };
}

describe("LspManager", () => {
  let tmpDir: string;
  let managers: LspManager[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-manager-test-"));
    await fs.writeFile(path.join(tmpDir, "fake-root.json"), "{}");
    managers = [];
  });

  afterEach(async () => {
    for (const manager of managers) manager.shutdownAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeManager(
    spec: LspServerSpec,
    budgets?: { warm?: number; first?: number },
  ): LspManager {
    const manager = new LspManager(tmpDir, {
      catalog: [spec],
      warmBudgetMs: budgets?.warm ?? 5000,
      firstBudgetMs: budgets?.first ?? 5000,
    });
    managers.push(manager);
    return manager;
  }

  it("returns formatted diagnostics for broken content", async () => {
    const manager = makeManager(fakeSpec());
    const filePath = path.join(tmpDir, "broken.fake");

    const result = await manager.diagnosticsAfterWrite(filePath, "ok line\nhas ERROR here\n");

    expect(result).toContain("Diagnostics in broken.fake");
    expect(result).toContain("L2:5 fake error on line 2 (fake)");
  });

  it("returns empty string once a follow-up edit fixes the file", async () => {
    const manager = makeManager(fakeSpec());
    const filePath = path.join(tmpDir, "cycle.fake");

    const broken = await manager.diagnosticsAfterWrite(filePath, "ERROR\n");
    expect(broken).toContain("fake error on line 1");

    const fixed = await manager.diagnosticsAfterWrite(filePath, "all good\n");
    expect(fixed).toBe("");

    const rebroken = await manager.diagnosticsAfterWrite(filePath, "fine\nERROR again\n");
    expect(rebroken).toContain("fake error on line 2");
  });

  it("works with pull-diagnostics servers", async () => {
    const manager = makeManager(fakeSpec(["--pull"]));
    const filePath = path.join(tmpDir, "pull.fake");

    const result = await manager.diagnosticsAfterWrite(filePath, "ERROR\n");

    expect(result).toContain("fake error on line 1");
  });

  it("returns empty string for unsupported extensions without spawning", async () => {
    const manager = makeManager(fakeSpec());

    const result = await manager.diagnosticsAfterWrite(path.join(tmpDir, "readme.md"), "# hi");

    expect(result).toBe("");
  });

  it("returns empty string when the time budget is exceeded", async () => {
    const manager = makeManager(fakeSpec(["--delay-ms=2000"]), { warm: 300, first: 300 });
    const filePath = path.join(tmpDir, "slow.fake");

    const started = Date.now();
    const result = await manager.diagnosticsAfterWrite(filePath, "ERROR\n");

    expect(result).toBe("");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("marks a server broken after spawn failure and never retries", async () => {
    let resolveCalls = 0;
    const spec = fakeSpec([], {
      resolveCommand: () => {
        resolveCalls++;
        return { command: path.join(tmpDir, "does-not-exist-binary"), args: [] };
      },
    });
    const manager = makeManager(spec);
    const filePath = path.join(tmpDir, "broken-server.fake");

    expect(await manager.diagnosticsAfterWrite(filePath, "ERROR\n")).toBe("");
    expect(await manager.diagnosticsAfterWrite(filePath, "ERROR\n")).toBe("");
    expect(resolveCalls).toBe(1);
  });

  it("returns empty string when no server command resolves", async () => {
    const spec = fakeSpec([], { resolveCommand: () => null });
    const manager = makeManager(spec);

    const result = await manager.diagnosticsAfterWrite(path.join(tmpDir, "a.fake"), "ERROR\n");

    expect(result).toBe("");
  });

  it("performs the shutdown handshake on shutdownAll", async () => {
    const shutdownFile = path.join(tmpDir, "shutdown-marker");
    const manager = makeManager(fakeSpec([`--shutdown-file=${shutdownFile}`]));
    const filePath = path.join(tmpDir, "bye.fake");

    await manager.diagnosticsAfterWrite(filePath, "ok\n");
    manager.shutdownAll();

    // Poll for the marker the fixture writes when it receives `shutdown`.
    const deadline = Date.now() + 3000;
    let seen = false;
    while (Date.now() < deadline && !seen) {
      seen = await fs.access(shutdownFile).then(
        () => true,
        () => false,
      );
      if (!seen) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(seen).toBe(true);
  });

  it("returns empty string after shutdownAll", async () => {
    const manager = makeManager(fakeSpec());
    manager.shutdownAll();

    const result = await manager.diagnosticsAfterWrite(path.join(tmpDir, "a.fake"), "ERROR\n");

    expect(result).toBe("");
  });
});
