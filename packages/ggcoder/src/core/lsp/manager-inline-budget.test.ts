import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LspManager } from "./manager.js";
import { removeWhenReleased } from "./test-support.js";
import type { LspServerSpec } from "./servers.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tools/__fixtures__/fake-lsp-server.mjs",
);

/** A server that takes 1.5s to publish — slow, but inside the old 3s/8s budgets. */
const slowSpec: LspServerSpec = {
  id: "fake",
  extensions: [".fake"],
  rootMarkers: ["fake-root.json"],
  languageIdFor: () => "fake",
  resolveCommand: () => ({ command: process.execPath, args: [FIXTURE, "--delay-ms=1500"] }),
};

describe("LspManager.diagnosticsWithinBudget (current vs proposed)", () => {
  let tmpDir: string;
  let managers: LspManager[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-inline-budget-"));
    await fs.writeFile(path.join(tmpDir, "fake-root.json"), "{}");
    managers = [];
  });

  afterEach(async () => {
    for (const manager of managers) manager.shutdownAll();
    await removeWhenReleased(tmpDir);
  });

  function make(): LspManager {
    const manager = new LspManager(tmpDir, { catalog: [slowSpec], settleMs: 0 });
    managers.push(manager);
    return manager;
  }

  it("returns an edit within the inline budget and delivers the late error on the next write", async () => {
    const file = path.join(tmpDir, "a.fake");
    const other = path.join(tmpDir, "b.fake");

    // BEFORE: the synchronous path holds the edit until the slow publish lands.
    const current = make();
    let start = Date.now();
    const currentNote = await current.diagnosticsAfterWrite(file, "ok\nERROR here");
    const currentMs = Date.now() - start;
    expect(currentNote).toContain("fake error on line 2");

    // AFTER: the edit comes back within the budget…
    const proposed = make();
    start = Date.now();
    const first = await proposed.diagnosticsWithinBudget(file, "ok\nERROR here", undefined, 300);
    const proposedMs = Date.now() - start;
    expect(first).toBe("");
    // …and the error it could not wait for rides on the next write's result.
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    const next = await proposed.diagnosticsWithinBudget(other, "fine", undefined, 300);
    expect(next).toContain("fake error on line 2");

    console.log(
      `[AB #16] edit latency, 1.5s LSP: current ${currentMs}ms, proposed ${proposedMs}ms`,
    );
    expect(currentMs).toBeGreaterThanOrEqual(1_400);
    expect(proposedMs).toBeLessThan(1_000);
  }, 20_000);
});
