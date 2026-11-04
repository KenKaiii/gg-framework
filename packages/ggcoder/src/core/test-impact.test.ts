import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isVerificationCommand } from "./verification-gate.js";
import { formatImpactForVerification, parseExports, TestImpactIndex } from "./test-impact.js";

let root: string;

async function put(rel: string, content: string): Promise<string> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

/** Simulate a tool write: snapshot, write, then ask for the note. */
async function toolWrite(index: TestImpactIndex, rel: string, content: string): Promise<string> {
  const abs = path.join(root, rel);
  await index.beforeWrite(abs);
  await fs.writeFile(abs, content);
  return index.noteAfterWrite(abs, content);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "test-impact-"));
  await put("package.json", JSON.stringify({ name: "root", private: true }));
  await put("pkg/package.json", JSON.stringify({ devDependencies: { vitest: "^3" } }));
  await put(
    "pkg/src/util.ts",
    "export function slug(s: string) { return s; }\nexport const KEEP = 1;\n",
  );
  await put(
    "pkg/src/service.ts",
    'import { slug } from "./util.js";\nexport const run = () => slug("x");\n',
  );
  await put(
    "pkg/src/api/handler.ts",
    'import { run } from "../service.js";\nexport default run;\n',
  );
  await put("pkg/test/handler.test.ts", 'import handler from "../src/api/handler";\n');
  await put("pkg/src/util.test.ts", 'import { slug, KEEP } from "./util.js";\n');
  await put("pkg/src/unrelated.test.ts", 'import { other } from "./other.js";\n');
  await put("pkg/src/other.ts", "export const other = 1;\n");
  await put("pkg/node_modules/dep/index.test.ts", 'import "../../src/util.js";\n');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("TestImpactIndex", () => {
  it("finds tests reaching a file through other files, with a command running exactly those", async () => {
    const impact = await new TestImpactIndex(root).impactFor(["pkg/src/util.ts"]);
    expect(impact.tests).toEqual(["pkg/src/util.test.ts", "pkg/test/handler.test.ts"]);
    expect(impact.commands).toEqual([
      "cd pkg && npx vitest run src/util.test.ts test/handler.test.ts",
    ]);
    expect(impact.commands.every(isVerificationCommand)).toBe(true);
  });

  it("notes reaching tests on the first edit of a file only", async () => {
    const index = new TestImpactIndex(root);
    const content =
      "export function slug(s: string) { return s.trim(); }\nexport const KEEP = 1;\n";
    const first = await toolWrite(index, "pkg/src/util.ts", content);
    expect(first).toContain("Nearest tests that import pkg/src/util.ts");
    expect(first).toContain("`cd pkg && npx vitest run src/util.test.ts test/handler.test.ts`");
    expect(await toolWrite(index, "pkg/src/util.ts", content)).toBe("");
  });

  it("flags importers still using an export the edit removed", async () => {
    const index = new TestImpactIndex(root);
    await index.impactFor([]); // warm the graph first, like a long session
    const note = await toolWrite(index, "pkg/src/util.ts", "export const KEEP = 1;\n");
    expect(note).toContain(
      "Possibly broken callers: this edit removed the export `slug`, still imported by " +
        "pkg/src/service.ts, pkg/src/util.test.ts.",
    );
    // Removing a default export is traced through default imports.
    const handlerNote = await toolWrite(index, "pkg/src/api/handler.ts", "export const x = 1;\n");
    expect(handlerNote).toContain(
      "removed the export `default`, still imported by pkg/test/handler.test.ts",
    );
  });

  it("picks up files changed outside the tools on the next rescan", async () => {
    let now = 0;
    const index = new TestImpactIndex(root, { now: () => now });
    expect((await index.impactFor(["pkg/src/other.ts"])).tests).toEqual([
      "pkg/src/unrelated.test.ts",
    ]);
    await put("pkg/src/other.test.ts", 'import { other } from "./other";\n');
    now += 60_000;
    expect((await index.impactFor(["pkg/src/other.ts"])).tests).toEqual([
      "pkg/src/other.test.ts",
      "pkg/src/unrelated.test.ts",
    ]);
  });

  it("stays silent for non-source files and files nothing tests", async () => {
    const index = new TestImpactIndex(root);
    expect(await toolWrite(index, "README.md", "# hi")).toBe("");
    expect(await toolWrite(index, "pkg/src/lonely.ts", "export const a = 1;\n")).toBe("");
  });

  it("stops at the nearest layer when a hub would pull in a large share of the suite", async () => {
    await put("pkg/src/leaf.ts", "export const leaf = 1;\n");
    await put("pkg/src/leaf.test.ts", 'import { leaf } from "./leaf";\n');
    await put("pkg/src/hub.ts", 'import { leaf } from "./leaf";\nexport const hub = leaf;\n');
    for (let i = 0; i < 25; i++) {
      await put(
        `pkg/src/hub-${String(i).padStart(2, "0")}.test.ts`,
        'import { hub } from "./hub";\n',
      );
    }
    const impact = await new TestImpactIndex(root).impactFor(["pkg/src/leaf.ts"]);
    expect(impact.tests).toEqual(["pkg/src/leaf.test.ts"]);
    expect(impact.fartherTests).toBe(25);
    expect(impact.commands).toEqual(["cd pkg && npx vitest run src/leaf.test.ts"]);
  });

  it("lists files through git when cwd is a checkout, honouring nested ignores", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await put("pkg/src/.gitignore", "generated/\n");
    await put("pkg/src/generated/gen.test.ts", 'import { slug } from "../util";\n');
    const impact = await new TestImpactIndex(root).impactFor(["pkg/src/util.ts"]);
    expect(impact.tests).toEqual(["pkg/src/util.test.ts", "pkg/test/handler.test.ts"]);
  });

  it("names no command when no test runner is declared", async () => {
    await put("plain/a.ts", "export const a = 1;\n");
    await put("plain/a.test.ts", 'import { a } from "./a";\n');
    const impact = await new TestImpactIndex(root).impactFor(["plain/a.ts"]);
    expect(impact.tests).toEqual(["plain/a.test.ts"]);
    expect(impact.commands).toEqual([]);
    expect(formatImpactForVerification(impact)).toBe("");
  });
});

describe("parseExports", () => {
  it("collects declarations, export lists with renames, and default", () => {
    const source = [
      "export async function a() {}",
      "export const b = 1;",
      "export interface C {}",
      "export type D = string;",
      "export { e, f as g };",
      "export default class {}",
      "// export const commented = 1;",
    ].join("\n");
    expect([...parseExports(source)].sort()).toEqual(
      ["C", "D", "a", "b", "default", "e", "g"].sort(),
    );
  });
});
