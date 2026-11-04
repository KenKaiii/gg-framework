import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findServerProjectRoot } from "./project-root.js";
import { LSP_SERVER_CATALOG } from "./servers.js";

const spec = LSP_SERVER_CATALOG.find((server) => server.id === "typescript");
if (!spec) throw new Error("TypeScript server missing from catalog");
const typescript = spec;

describe("solution-aware TypeScript root", () => {
  let root: string;
  let project: string;
  let file: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-lsp-solution-"));
    project = path.join(root, "core");
    file = path.join(project, "db.ts");
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "tsconfig.json"), "{}");
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    ["tsconfig.json", "./core"],
    ["tsconfig.json", "./core/tsconfig.json"],
    ["jsconfig.json", "./core"],
  ])("accepts JSONC solution %s referencing %s", async (configName, reference) => {
    await fs.writeFile(
      path.join(root, configName),
      `{// solution\n"files": [], "references": [{"path": "${reference}"},],}`,
    );
    expect(await findServerProjectRoot(file, typescript, root)).toBe(root);
  });

  it.each([
    "{}",
    '{"references": []}',
    '{"references": [{"path": "./other"}]}',
    '{"references": [{"path": 1}]}',
    "not json",
  ])("keeps the nearest root for an unrelated/invalid config: %s", async (config) => {
    await fs.writeFile(path.join(root, "tsconfig.json"), config);
    expect(await findServerProjectRoot(file, typescript, root)).toBe(project);
  });

  it("uses the outer solution through an intermediate referenced project", async () => {
    const nested = path.join(project, "nested");
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, "tsconfig.json"), "{}");
    await fs.writeFile(path.join(project, "tsconfig.json"), '{"references":[{"path":"./nested"}]}');
    await fs.writeFile(path.join(root, "tsconfig.json"), '{"references":[{"path":"./core"}]}');
    expect(await findServerProjectRoot(path.join(nested, "db.ts"), typescript, root)).toBe(root);
  });

  it("never widens beyond the session workspace or changes other languages", async () => {
    await fs.writeFile(path.join(root, "tsconfig.json"), '{"references":[{"path":"./core"}]}');
    expect(await findServerProjectRoot(file, typescript, project)).toBe(project);
    expect(await findServerProjectRoot(file, { ...typescript, id: "other" }, root)).toBe(project);
    expect(await findServerProjectRoot(file, typescript, path.join(root, "other"))).toBe(project);
  });

  it("bounds reads of oversized configs and respects cancellation", async () => {
    await fs.writeFile(path.join(root, "tsconfig.json"), " ".repeat(65 * 1024));
    expect(await findServerProjectRoot(file, typescript, root)).toBe(project);
    await fs.writeFile(path.join(root, "tsconfig.json"), '{"references":[{"path":"./core"}]}');
    expect(await findServerProjectRoot(file, typescript, root, AbortSignal.abort())).toBe(project);
  });
});
