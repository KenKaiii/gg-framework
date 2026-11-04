import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { LspManager } from "./manager.js";
import { removeWhenReleased } from "./test-support.js";
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

const SOURCE = "class Widget {\n  render() {}\n}\nconst widget = new Widget();\n";

describe("LspManager navigation", () => {
  let tmpDir: string;
  let managers: LspManager[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-nav-manager-"));
    await fs.writeFile(path.join(tmpDir, "fake-root.json"), "{}");
    managers = [];
  });

  afterEach(async () => {
    for (const manager of managers) manager.shutdownAll();
    await removeWhenReleased(tmpDir);
  });

  function makeManager(spec: LspServerSpec, budgets?: { warm?: number; first?: number }) {
    const manager = new LspManager(tmpDir, {
      catalog: [spec],
      warmBudgetMs: budgets?.warm ?? 5000,
      firstBudgetMs: budgets?.first ?? 5000,
    });
    managers.push(manager);
    return manager;
  }

  const file = () => path.join(tmpDir, "widget.fake");

  it("returns a definition location", async () => {
    const outcome = await makeManager(fakeSpec()).definition(file(), SOURCE, {
      line: 3,
      character: 6,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.serverId).toBe("fake");
    expect(outcome.value[0].range.start.line).toBe(0);
  });

  it("returns references", async () => {
    const outcome = await makeManager(fakeSpec()).references(file(), SOURCE, {
      line: 0,
      character: 6,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.value).toHaveLength(2);
  });

  it("returns document symbols", async () => {
    const outcome = await makeManager(fakeSpec()).documentSymbols(file(), SOURCE);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    // The manager passes the server's tree through untouched; trimming it to a
    // readable outline is the code_nav tool's job.
    expect(outcome.value.map((s) => s.name)).toEqual(["helper", "tmp", "i", "Widget", "render"]);
  });

  it("returns hover text", async () => {
    const outcome = await makeManager(fakeSpec()).hover(file(), SOURCE, { line: 3, character: 6 });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.value).toContain("const widget: Widget");
  });

  it("finds unopened JavaScript callers without a project config", async () => {
    const root = path.join(tmpDir, "javascript-project");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
    const declaration = "export function getUserById(id) { return { id }; }\n";
    const caller =
      "import { getUserById as lookup } from './src/db.js';\n" +
      "export const user = lookup('id');\n";
    await fs.writeFile(path.join(root, "src/db.js"), declaration);
    await fs.writeFile(path.join(root, "caller.js"), caller);
    const manager = new LspManager(root, { firstBudgetMs: 30_000, warmBudgetMs: 10_000 });
    managers.push(manager);

    const outcome = await manager.references(path.join(root, "src/db.js"), declaration, {
      line: 0,
      character: 16,
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uri: expect.stringContaining("/caller.js"),
          range: expect.objectContaining({ start: { line: 1, character: 20 } }),
        }),
      ]),
    );
    expect(outcome.warning).toBeUndefined();
    expect((await fs.readdir(root)).sort()).toEqual(["caller.js", "package.json", "src"]);

    await fs.writeFile(path.join(root, "added.js"), caller);
    const updated = await manager.references(path.join(root, "src/db.js"), declaration, {
      line: 0,
      character: 16,
    });
    expect(updated.kind).toBe("ok");
    if (updated.kind === "ok")
      expect(updated.value.some((location) => location.uri.endsWith("/added.js"))).toBe(true);
  }, 60_000);

  it("preserves a configured JavaScript project's excluded callers", async () => {
    await fs.writeFile(
      path.join(tmpDir, "jsconfig.json"),
      JSON.stringify({ compilerOptions: { allowJs: true }, files: ["db.js"] }),
    );
    const declaration = "export function getUserById(id) { return { id }; }\n";
    await fs.writeFile(path.join(tmpDir, "db.js"), declaration);
    await fs.writeFile(
      path.join(tmpDir, "excluded.js"),
      "import { getUserById } from './db.js'; getUserById('id');",
    );
    const manager = new LspManager(tmpDir, { firstBudgetMs: 30_000 });
    managers.push(manager);
    const outcome = await manager.references(path.join(tmpDir, "db.js"), declaration, {
      line: 0,
      character: 16,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.warning).toBeUndefined();
    expect(outcome.value.every((location) => location.uri.endsWith("/db.js"))).toBe(true);
  }, 60_000);

  it("finds unopened sibling-project callers without overriding exclusions", async () => {
    const declaration = "export function lookup(id: string) { return { id }; }\n";
    const caller = "import { lookup } from '../core/db';\nexport const user = lookup('id');\n";
    await fs.mkdir(path.join(tmpDir, "core"));
    await fs.mkdir(path.join(tmpDir, "app"));
    await fs.writeFile(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        files: [],
        references: [{ path: "./core" }, { path: "./app" }],
      }),
    );
    const compilerOptions = { composite: true, module: "esnext", moduleResolution: "bundler" };
    await fs.writeFile(
      path.join(tmpDir, "core/tsconfig.json"),
      JSON.stringify({ compilerOptions, include: ["*.ts"] }),
    );
    await fs.writeFile(
      path.join(tmpDir, "app/tsconfig.json"),
      JSON.stringify({
        compilerOptions,
        include: ["*.ts"],
        exclude: ["excluded.ts"],
        references: [{ path: "../core" }],
      }),
    );
    await fs.writeFile(path.join(tmpDir, "core/db.ts"), declaration);
    await fs.writeFile(path.join(tmpDir, "app/caller.ts"), caller);
    await fs.writeFile(path.join(tmpDir, "app/excluded.ts"), caller);
    const manager = new LspManager(tmpDir, { firstBudgetMs: 30_000, warmBudgetMs: 10_000 });
    managers.push(manager);

    const outcome = await manager.references(path.join(tmpDir, "core/db.ts"), declaration, {
      line: 0,
      character: 17,
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.warning).toBeUndefined();
    expect(outcome.value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uri: expect.stringContaining("/app/caller.ts"),
          range: expect.objectContaining({ start: { line: 1, character: 20 } }),
        }),
      ]),
    );
    expect(outcome.value.some((location) => location.uri.endsWith("/excluded.ts"))).toBe(false);
    const warm = await manager.references(path.join(tmpDir, "core/db.ts"), declaration, {
      line: 0,
      character: 17,
    });
    expect(warm.kind).toBe("ok");
    if (warm.kind === "ok") expect(warm.value).toEqual(outcome.value);
  }, 60_000);

  it("reports unsupported for a file no catalog server claims", async () => {
    const outcome = await makeManager(fakeSpec()).hover(path.join(tmpDir, "a.unknown"), "x", {
      line: 0,
      character: 0,
    });
    expect(outcome.kind).toBe("unsupported");
  });

  it("reports unsupported when the server lacks the capability", async () => {
    const outcome = await makeManager(fakeSpec(["--no-nav"])).definition(file(), SOURCE, {
      line: 0,
      character: 0,
    });
    expect(outcome.kind).toBe("unsupported");
    expect(outcome.serverId).toBe("fake");
  });

  it("reports timeout when the server never answers", async () => {
    const outcome = await makeManager(fakeSpec(["--nav-silent"]), {
      warm: 200,
      first: 200,
    }).references(file(), SOURCE, { line: 0, character: 0 });
    expect(outcome.kind).toBe("timeout");
  });

  it("reports unavailable when the server cannot be launched", async () => {
    const spec = fakeSpec();
    const outcome = await makeManager({ ...spec, resolveCommand: () => null }).hover(
      file(),
      SOURCE,
      { line: 0, character: 0 },
    );
    expect(outcome.kind).toBe("unavailable");
  });

  it("reports server_failed when the server dies on open", async () => {
    const outcome = await makeManager(fakeSpec(["--crash-on-open"]), {
      warm: 1000,
      first: 1000,
    }).hover(file(), SOURCE, { line: 0, character: 0 });
    expect(["server_failed", "timeout"]).toContain(outcome.kind);
  });

  it.each(["navigation", "diagnostics"])(
    "does not start a server when shut down during %s root discovery",
    async (operation) => {
      const spec = fakeSpec();
      const resolveCommand = vi.fn(spec.resolveCommand);
      const manager = makeManager({ ...spec, resolveCommand });
      const pending =
        operation === "navigation"
          ? manager.documentSymbols(file(), SOURCE)
          : manager.diagnosticsAfterWriteDetailed(file(), SOURCE);
      manager.shutdownAll();

      expect((await pending).kind).toBe("unavailable");
      expect(resolveCommand).not.toHaveBeenCalled();
    },
  );

  it("reports unavailable after shutdown", async () => {
    const manager = makeManager(fakeSpec());
    manager.shutdownAll();
    const outcome = await manager.documentSymbols(file(), SOURCE);
    expect(outcome.kind).toBe("unavailable");
  });
});
