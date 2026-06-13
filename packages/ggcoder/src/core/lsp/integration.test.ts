import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LspManager } from "./manager.js";
import { findExecutable } from "./servers.js";

/**
 * Opt-in integration test against a REAL typescript-language-server:
 *
 *   GG_LSP_INTEGRATION=1 npx vitest run src/core/lsp/integration.test.ts
 *
 * Skipped in CI and normal runs. Self-contained: when the server binary isn't
 * already on PATH it is npm-installed into the throwaway temp project (this
 * is a local, explicitly opted-in test — the production runtime NEVER
 * installs anything).
 */
const enabled = process.env.GG_LSP_INTEGRATION === "1";

describe.skipIf(!enabled)("LspManager + real typescript-language-server", () => {
  let tmpDir: string;
  let manager: LspManager;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-integration-"));
    await fs.writeFile(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "esnext",
          moduleResolution: "bundler",
          target: "es2022",
        },
        include: ["src"],
      }),
    );
    await fs.mkdir(path.join(tmpDir, "src"));
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "lsp-it", private: true }),
    );

    const install = spawnSync(
      "npm",
      ["install", "--no-audit", "--no-fund", "typescript", "typescript-language-server"],
      { cwd: tmpDir, stdio: "pipe", timeout: 110_000 },
    );
    expect(install.status).toBe(0);
    expect(findExecutable("typescript-language-server", tmpDir)).not.toBeNull();

    manager = new LspManager(tmpDir, { firstBudgetMs: 30_000, warmBudgetMs: 10_000 });
  }, 120_000);

  afterAll(async () => {
    manager.shutdownAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reports a type error, clears on fix, and reports a re-break", async () => {
    const filePath = path.join(tmpDir, "src", "main.ts");

    const broken = 'export const n: number = "not a number";\n';
    await fs.writeFile(filePath, broken);
    const first = await manager.diagnosticsAfterWrite(filePath, broken);
    expect(first).toContain("Diagnostics in");
    expect(first).toMatch(/not assignable to type 'number'/);

    const fixed = "export const n: number = 42;\n";
    await fs.writeFile(filePath, fixed);
    expect(await manager.diagnosticsAfterWrite(filePath, fixed)).toBe("");

    const rebroken = "export const n: number = 42;\nexport const x = n.doesNotExist;\n";
    await fs.writeFile(filePath, rebroken);
    const third = await manager.diagnosticsAfterWrite(filePath, rebroken);
    expect(third).toMatch(/doesNotExist/);
  }, 60_000);
});
