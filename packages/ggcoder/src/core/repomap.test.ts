import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REPO_MAP_MAX_CHARS,
  buildRepoMap,
  createRepoMapCache,
  extractFileFacts,
  rankRepoMapFiles,
  renderRepoMap,
  type RepoMapFile,
} from "./repomap.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("repomap", () => {
  it("extracts TypeScript imports, exports, and symbols", () => {
    const facts = extractFileFacts(
      "src/example.ts",
      `import path from "node:path";
import { helper } from "./helper";
export { helper as renamed } from "./helper";
export interface User { id: string }
export type UserId = string;
export class Service {}
export function run() {}
const internal = 1;
function localFn() {}
`,
    );

    expect(facts.imports).toEqual(["node:path", "./helper"]);
    expect(facts.exports).toEqual(["User", "UserId", "Service", "run", "helper"]);
    expect(facts.symbols).toContain("Service");
    expect(facts.symbols).toContain("localFn");
    expect(facts.signatures).toContain("export class Service");
    expect(facts.signatures).toContain("export function run()");
  });

  it("does not extract fake signatures from prompt template strings", () => {
    const facts = extractFileFacts(
      "src/prompts.ts",
      "export const prompt = `class Fake {}\\nfunction fake()`;\nexport function real() {}\n",
    );

    expect(facts.signatures).toEqual(["export function real()"]);
  });

  it("respects gitignore, build directories, and file size cap", async () => {
    const cwd = await makeFixture({
      ".gitignore": "ignored.ts\n",
      "src/keep.ts": "export const keep = true;\n",
      "ignored.ts": "export const ignored = true;\n",
      "dist/built.ts": "export const built = true;\n",
      "src/huge.ts": `export const huge = "${"x".repeat(210_000)}";`,
    });

    const { snapshot } = await buildRepoMap({ cwd, now: new Date("2026-01-01T00:00:00.000Z") });
    const paths = snapshot.files.map((file) => file.path);

    expect(paths).toContain("src/keep.ts");
    expect(paths).not.toContain("ignored.ts");
    expect(paths).not.toContain("dist/built.ts");
    expect(paths).not.toContain("src/huge.ts");
  });

  it("ranks changed and focused files above unrelated files", () => {
    const files: RepoMapFile[] = [
      file("src/unrelated.ts", ["alpha"]),
      file("docs/readme.md", []),
      file("src/repomap.ts", ["buildRepoMap"]),
      file("src/changed.ts", []),
    ];

    const ranked = rankRepoMapFiles(files, {
      changedFiles: ["src/changed.ts"],
      focusTerms: ["repomap"],
    });

    expect(ranked[0]?.path).toBe("src/changed.ts");
    expect(ranked[1]?.path).toBe("src/repomap.ts");
  });

  it("enforces max char budget and reports truncation", async () => {
    const cwd = await makeFixture({
      "src/a.ts": "export const alpha = 1;\nexport const beta = 2;\n",
      "src/b.ts": "export const gamma = 3;\nexport const delta = 4;\n",
    });

    const { snapshot, markdown } = await buildRepoMap({
      cwd,
      maxChars: 220,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(markdown.length).toBeLessThanOrEqual(220);
    expect(snapshot.stats.truncated).toBe(true);
    expect(markdown).toContain("truncated to repo map budget");
    expect(markdown).not.toMatch(/^- [^\n]*$/);
  });

  it("renders compact navigation context without redundant details", () => {
    const markdown = renderRepoMap(
      {
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        files: [file("src/index.ts", ["main"], { signatures: ["export function main(): void"] })],
        directories: [],
        changedFiles: ["src/index.ts"],
        readFiles: ["src/read.ts"],
        activeRoots: [],
        otherDirtyRoots: [],
        stats: {
          indexedFiles: 1,
          shownFiles: 1,
          totalSymbols: 1,
          renderedChars: 0,
          truncated: false,
        },
        truncated: false,
      },
      1000,
    );

    expect(markdown).toContain("<!-- gg-repomap -->");
    expect(markdown).toContain("## Repo Map");
    expect(markdown).not.toContain("indexedFiles=1");
    expect(markdown).not.toContain("Generated:");
    expect(markdown).not.toContain("exports:");
    expect(markdown).not.toContain("symbols:");
    expect(markdown).toContain("Changed: src/index.ts");
    expect(markdown).toContain("Already read: src/read.ts");
    expect(markdown).toContain("sig=export function main(): void");
    expect(markdown).toContain("Navigation-only map");
  });

  it("keeps default rendered map under the injection budget", async () => {
    const cwd = await makeFixture(
      Object.fromEntries(
        Array.from({ length: 120 }, (_, index) => [
          `src/file-${index}.ts`,
          `export const symbol${index} = ${index};\n`,
        ]),
      ),
    );

    const { markdown, snapshot } = await buildRepoMap({
      cwd,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(markdown.length).toBeLessThanOrEqual(DEFAULT_REPO_MAP_MAX_CHARS);
    expect(snapshot.stats.renderedChars).toBeLessThanOrEqual(DEFAULT_REPO_MAP_MAX_CHARS);
  });

  it("shows changed files after mutation callbacks record them", async () => {
    const cwd = await makeFixture({
      "src/changed.ts": "export const changed = true;\n",
      "src/other.ts": "export const other = true;\n",
    });

    const { markdown, snapshot } = await buildRepoMap({
      cwd,
      changedFiles: [path.join(cwd, "src/changed.ts")],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(snapshot.changedFiles).toEqual(["src/changed.ts"]);
    expect(markdown).toContain("Changed: src/changed.ts");
    expect(snapshot.files[0]?.path).toBe("src/changed.ts");
  });

  it("prioritizes dependency neighbors and avoids spending map budget on already-read files", async () => {
    const cwd = await makeFixture({
      "src/root.ts":
        "import { helper } from './helper';\nexport function root() { return helper(); }\n",
      "src/helper.ts": "export function helper() { return 'ok'; }\n",
      "src/consumer.ts":
        "import { root } from './root';\nexport function consumer() { return root(); }\n",
      "src/unrelated.ts": "export const unrelated = true;\n",
    });

    const { markdown, snapshot } = await buildRepoMap({
      cwd,
      readFiles: ["src/root.ts"],
      maxFiles: 3,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    const paths = snapshot.files.map((file) => file.path);

    expect(markdown).toContain("Already read: src/root.ts");
    expect(paths).toContain("src/helper.ts");
    expect(paths).toContain("src/consumer.ts");
    expect(paths).not.toContain("src/root.ts");
  });

  it("uses git dirty files as cold-start active package anchors", async () => {
    const cwd = await makeFixture({
      "packages/ggcoder/src/core/repomap.ts": "export function buildRepoMap() {}\n",
      "packages/ggcoder/src/core/agent-session.ts": "export class AgentSession {}\n",
      "packages/gg-editor/src/core/logger.ts": "export function logger() {}\n",
    });
    await touchFiles(cwd, ["packages/ggcoder/src/core/repomap.ts"], 2_000);
    await touchFiles(cwd, ["packages/gg-editor/src/core/logger.ts"], 1_000);

    const { markdown, snapshot } = await buildRepoMap({
      cwd,
      focusTerms: ["repo map"],
      maxFiles: 10,
      now: new Date("2026-01-01T00:00:00.000Z"),
      listGitChangedFiles: async () => [
        "packages/ggcoder/src/core/repomap.ts",
        "packages/gg-editor/src/core/logger.ts",
      ],
    });
    const paths = snapshot.files.map((file) => file.path);

    expect(markdown).toContain("Changed: packages/ggcoder/src/core/repomap.ts");
    expect(markdown).toContain("Other dirty packages: gg-editor(1)");
    expect(paths[0]).toBe("packages/ggcoder/src/core/repomap.ts");
    expect(paths.every((filePath) => filePath.startsWith("packages/ggcoder/"))).toBe(true);
  });

  it("prioritizes specific changed files over broad hubs on cold start", async () => {
    const cwd = await makeFixture({
      "packages/ggcoder/src/core/repomap.ts": "export function buildRepoMap() {}\n",
      "packages/ggcoder/src/core/repomap.test.ts": "export const tests = true;\n",
      "packages/ggcoder/scripts/verify-repomap-focus.js": "export async function main() {}\n",
      "packages/ggcoder/src/core/agent-session.ts": "export class AgentSession {}\n",
      "packages/ggcoder/src/tools/index.ts": "export function createTools() {}\n",
      "packages/ggcoder/src/ui/App.tsx": "export function App() { return null; }\n".repeat(4_000),
      "packages/ggcoder/src/cli.ts": "export function main() {}\n",
      "packages/gg-voice/src/dirty.ts": "export const voice = true;\n",
    });

    const { markdown, snapshot } = await buildRepoMap({
      cwd,
      focusTerms: ["repo map", "cold start", "fresh agent"],
      maxFiles: 8,
      now: new Date("2026-01-01T00:00:00.000Z"),
      listGitChangedFiles: async () => [
        "packages/ggcoder/src/core/repomap.ts",
        "packages/ggcoder/src/core/repomap.test.ts",
        "packages/ggcoder/scripts/verify-repomap-focus.js",
        "packages/ggcoder/src/core/agent-session.ts",
        "packages/ggcoder/src/tools/index.ts",
        "packages/ggcoder/src/ui/App.tsx",
        "packages/ggcoder/src/cli.ts",
        "packages/gg-voice/src/dirty.ts",
      ],
    });
    const paths = snapshot.files.map((file) => file.path);

    expect(markdown).not.toContain("Already read:");
    expect(new Set(paths.slice(0, 3))).toEqual(
      new Set([
        "packages/ggcoder/src/core/repomap.ts",
        "packages/ggcoder/src/core/repomap.test.ts",
        "packages/ggcoder/src/core/agent-session.ts",
      ]),
    );
    expect(paths.indexOf("packages/ggcoder/src/ui/App.tsx")).toBeGreaterThan(2);
    expect(paths.indexOf("packages/ggcoder/src/cli.ts")).toBeGreaterThan(2);
    expect(paths.every((filePath) => !filePath.startsWith("packages/gg-voice/"))).toBe(true);
  });

  it("prioritizes actively mutated read files over broad dirty files", async () => {
    const cwd = await makeFixture({
      "packages/ggcoder/src/core/repomap.ts": "export function buildRepoMap() {}\n",
      "packages/ggcoder/src/core/repomap.test.ts": "export const tests = true;\n",
      "packages/ggcoder/src/core/agent-session.ts": "export class AgentSession {}\n",
      "packages/ggcoder/src/core/repomap-context.ts": "export const context = true;\n",
      "packages/ggcoder/src/ui/App.tsx": "export function App() { return null; }\n",
      "packages/ggcoder/src/cli.ts": "export function main() {}\n",
    });

    const { snapshot } = await buildRepoMap({
      cwd,
      readFiles: [
        "packages/ggcoder/src/core/agent-session.ts",
        "packages/ggcoder/src/core/repomap.test.ts",
        "packages/ggcoder/src/core/repomap.ts",
      ],
      maxFiles: 6,
      now: new Date("2026-01-01T00:00:00.000Z"),
      listGitChangedFiles: async () => [
        "packages/ggcoder/src/core/repomap.ts",
        "packages/ggcoder/src/cli.ts",
        "packages/ggcoder/src/core/agent-session.ts",
        "packages/ggcoder/src/core/repomap-context.ts",
        "packages/ggcoder/src/core/repomap.test.ts",
        "packages/ggcoder/src/ui/App.tsx",
      ],
    });

    expect(new Set(snapshot.files.map((file) => file.path).slice(0, 3))).toEqual(
      new Set([
        "packages/ggcoder/src/core/agent-session.ts",
        "packages/ggcoder/src/core/repomap.test.ts",
        "packages/ggcoder/src/core/repomap.ts",
      ]),
    );
    expect(
      snapshot.files.findIndex((file) => file.path === "packages/ggcoder/src/ui/App.tsx"),
    ).toBeGreaterThan(2);
    expect(
      snapshot.files.findIndex((file) => file.path === "packages/ggcoder/src/cli.ts"),
    ).toBeGreaterThan(2);
  });

  it("prefers read-context package over larger unrelated dirty package", async () => {
    const cwd = await makeFixture({
      "packages/ggcoder/src/core/repomap.ts": "export function buildRepoMap() {}\n",
      "packages/ggcoder/src/ui/App.tsx": "export function App() { return null; }\n",
      "packages/gg-voice/src/index.ts": "export const voice = true;\n",
      "packages/gg-voice/src/session.ts": "export const session = true;\n",
      "packages/gg-voice/src/tools.ts": "export const tools = true;\n",
    });

    const { markdown, snapshot } = await buildRepoMap({
      cwd,
      readFiles: ["packages/ggcoder/src/core/repomap.ts", "packages/ggcoder/src/ui/App.tsx"],
      focusTerms: ["why is it focused on gg-voice"],
      maxFiles: 10,
      now: new Date("2026-01-01T00:00:00.000Z"),
      listGitChangedFiles: async () => [
        "packages/ggcoder/src/core/repomap.ts",
        "packages/gg-voice/src/index.ts",
        "packages/gg-voice/src/session.ts",
        "packages/gg-voice/src/tools.ts",
      ],
    });
    const paths = snapshot.files.map((file) => file.path);

    expect(snapshot.activeRoots).toEqual(["packages/ggcoder"]);
    expect(snapshot.changedFiles).toEqual(["packages/ggcoder/src/core/repomap.ts"]);
    expect(paths.every((filePath) => filePath.startsWith("packages/ggcoder/"))).toBe(true);
    expect(markdown).toContain("Changed: packages/ggcoder/src/core/repomap.ts");
    expect(markdown).toContain("Other dirty packages: gg-voice(3)");
    expect(markdown).not.toContain("Changed: packages/gg-voice/src/index.ts");
  });

  it("keeps active monorepo package files and summarizes unrelated packages", async () => {
    const cwd = await makeFixture({
      "packages/ggcoder/src/core/repomap.ts": "export function buildRepoMap() {}\n",
      "packages/ggcoder/src/ui/app.ts": "export const app = true;\n",
      "packages/gg-editor/src/core/logger.ts":
        "export function logger() {}\nexport function many() {}\n",
      "packages/gg-editor/src/core/other.ts": "export const other = true;\n",
      "packages/gg-boss/src/index.ts": "export const boss = true;\n",
    });

    const { markdown, snapshot } = await buildRepoMap({
      cwd,
      changedFiles: ["packages/ggcoder/src/core/repomap.ts"],
      readFiles: ["packages/ggcoder/src/ui/app.ts"],
      focusTerms: ["repomap"],
      maxFiles: 10,
      now: new Date("2026-01-01T00:00:00.000Z"),
      listGitChangedFiles: async () => [
        "packages/ggcoder/src/core/repomap.ts",
        "packages/gg-editor/src/core/logger.ts",
        "packages/gg-editor/src/core/other.ts",
        "packages/gg-boss/src/index.ts",
      ],
    });
    const paths = snapshot.files.map((file) => file.path);

    expect(paths[0]).toBe("packages/ggcoder/src/core/repomap.ts");
    expect(paths[1]).toBe("packages/ggcoder/src/ui/app.ts");
    expect(paths.every((filePath) => filePath.startsWith("packages/ggcoder/"))).toBe(true);
    expect(snapshot.changedFiles).toContain("packages/ggcoder/src/core/repomap.ts");
    expect(snapshot.changedFiles).not.toContain("packages/gg-editor/src/core/logger.ts");
    expect(markdown).toContain("Changed: packages/ggcoder/src/core/repomap.ts");
    expect(markdown).toContain("Other dirty packages: gg-editor(2),gg-boss(1)");
    expect(markdown).not.toContain("Changed: packages/gg-editor/src/core/logger.ts");
    expect(markdown).not.toContain("packages/gg-editor/src/(2)");
    expect(markdown).not.toContain("packages/gg-boss/src/(1)");
  });

  it("allows explicitly mentioned cross-package files into the map", async () => {
    const cwd = await makeFixture({
      "packages/ggcoder/src/core/repomap.ts": "export function buildRepoMap() {}\n",
      "packages/gg-editor/src/core/logger.ts": "export function logger() {}\n",
    });

    const { snapshot } = await buildRepoMap({
      cwd,
      readFiles: ["packages/ggcoder/src/core/repomap.ts"],
      focusTerms: ["gg-editor"],
      maxFiles: 10,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(snapshot.files.map((file) => file.path)).toContain(
      "packages/gg-editor/src/core/logger.ts",
    );
  });

  it("renders only active changed files when restored reads identify the active package", async () => {
    const markdown = renderRepoMap(
      {
        version: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
        files: [file("packages/ggcoder/src/core/repomap.ts", ["buildRepoMap"])],
        directories: [
          { path: "packages/ggcoder/scripts", files: 2 },
          { path: "packages/gg-ai/src", files: 4 },
        ],
        changedFiles: [
          "packages/gg-ai/src/types.ts",
          "packages/ggcoder/src/core/repomap.ts",
          "packages/gg-voice/src/index.ts",
        ],
        readFiles: ["packages/ggcoder/src/cli.ts"],
        activeRoots: ["packages/ggcoder"],
        otherDirtyRoots: [],
        stats: {
          indexedFiles: 3,
          shownFiles: 1,
          totalSymbols: 1,
          renderedChars: 0,
          truncated: false,
        },
        truncated: false,
      },
      1000,
    );

    expect(markdown).toContain("Changed: packages/ggcoder/src/core/repomap.ts");
    expect(markdown).toContain("Other dirty packages: gg-ai(1),gg-voice(1)");
    expect(markdown).toContain("Dirs: packages/ggcoder/scripts/(2)");
    expect(markdown).not.toContain("Changed: packages/gg-ai/src/types.ts");
    expect(markdown).not.toContain("packages/gg-ai/src/(4)");
  });

  it("renders directory summaries for omitted active-package neighborhoods", async () => {
    const cwd = await makeFixture({
      "packages/alpha/src/index.ts": "export const alpha = true;\n",
      "packages/alpha/src/extra.ts": "export const extra = true;\n",
      "packages/alpha/tools/cli.ts": "export const cli = true;\n",
      "packages/beta/src/index.ts": "export const beta = true;\n",
      "packages/beta/src/extra.ts": "export const extra = true;\n",
    });

    const { markdown } = await buildRepoMap({
      cwd,
      maxFiles: 1,
      readFiles: ["packages/alpha/src/index.ts"],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(markdown).toContain("Dirs:");
    expect(markdown).toContain("packages/alpha/tools/(1)");
    expect(markdown).not.toContain("packages/beta/src/(2)");
  });

  it("reuses cached file facts when files are unchanged", async () => {
    const cwd = await makeFixture({
      "src/a.ts": "export const alpha = 1;\n",
      "src/b.ts": "export const beta = 2;\n",
    });
    const cache = createRepoMapCache();
    const reads: string[] = [];
    const readFile = async (absolutePath: string): Promise<string> => {
      reads.push(path.relative(cwd, absolutePath).split(path.sep).join("/"));
      return fs.readFile(absolutePath, "utf-8");
    };

    await buildRepoMap({ cwd, cache, readFile, now: new Date("2026-01-01T00:00:00.000Z") });
    await buildRepoMap({ cwd, cache, readFile, now: new Date("2026-01-01T00:00:01.000Z") });

    expect(reads.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(cache.files.size).toBe(2);
  });

  it("re-reads only changed files when cache metadata changes", async () => {
    const cwd = await makeFixture({
      "src/a.ts": "export const alpha = 1;\n",
      "src/b.ts": "export const beta = 2;\n",
    });
    const cache = createRepoMapCache();
    const reads: string[] = [];
    const readFile = async (absolutePath: string): Promise<string> => {
      reads.push(path.relative(cwd, absolutePath).split(path.sep).join("/"));
      return fs.readFile(absolutePath, "utf-8");
    };

    await buildRepoMap({ cwd, cache, readFile, now: new Date("2026-01-01T00:00:00.000Z") });
    reads.length = 0;
    await fs.writeFile(
      path.join(cwd, "src/b.ts"),
      "export const beta = 3;\nexport const changed = true;\n",
    );
    const future = new Date(Date.now() + 5_000);
    await fs.utimes(path.join(cwd, "src/b.ts"), future, future);

    const { markdown } = await buildRepoMap({
      cwd,
      cache,
      readFile,
      now: new Date("2026-01-01T00:00:01.000Z"),
    });

    expect(reads).toEqual(["src/b.ts"]);
    expect(markdown).toContain("changed");
  });
});

async function makeFixture(files: Record<string, string>): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-repomap-"));
  tempDirs.push(cwd);
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const absolute = path.join(cwd, relativePath);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, "utf-8");
    }),
  );
  return cwd;
}

async function touchFiles(
  cwd: string,
  filePaths: readonly string[],
  timeMs: number,
): Promise<void> {
  const time = new Date(timeMs);
  await Promise.all(filePaths.map((filePath) => fs.utimes(path.join(cwd, filePath), time, time)));
}

function file(
  filePath: string,
  symbols: string[],
  overrides: Partial<Pick<RepoMapFile, "imports" | "signatures">> = {},
): RepoMapFile {
  return {
    path: filePath,
    language: "TypeScript",
    exports: symbols,
    symbols,
    imports: overrides.imports ?? [],
    signatures: overrides.signatures ?? [],
    mtimeMs: 1,
    size: 100,
  };
}
