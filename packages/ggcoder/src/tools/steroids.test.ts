import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSteroidsArgs, compactRepos, createSteroidsTool } from "./steroids.js";
import { createTools, type CreateToolsResult } from "./index.js";

const results: CreateToolsResult[] = [];
afterEach(async () => {
  await Promise.all(
    results.splice(0).map(async ({ processManager, lspManager }) => {
      await lspManager?.shutdownAll();
      processManager.shutdownAll();
    }),
  );
});

describe("buildSteroidsArgs", () => {
  it("puts flags first and positionals behind -- so a leading dash is never a flag", () => {
    expect(
      buildSteroidsArgs({
        action: "search",
        pattern: "-foo",
        fixed: true,
        repo: "a/b",
        perRepo: 1,
      }),
    ).toEqual(["search", "-F", "--repo", "a/b", "--per-repo", "1", "--", "-foo"]);
    expect(buildSteroidsArgs({ action: "show", repo: "a/b", path: "src/x.ts", from: 10 })).toEqual([
      "show",
      "--from",
      "10",
      "--",
      "a/b",
      "src/x.ts",
    ]);
    expect(buildSteroidsArgs({ action: "repos" })).toEqual(["repos", "--json"]);
  });

  it("asks for text on reads and JSON only where the wrapper reshapes it", () => {
    for (const action of ["search", "define", "show", "files"] as const) {
      const args = buildSteroidsArgs({ action, pattern: "x", symbol: "X", repo: "a/b", path: "p" });
      expect(args).not.toContain("--json");
    }
    for (const action of ["repos", "discover", "recent"] as const) {
      expect(buildSteroidsArgs({ action, query: "topic:x" })).toContain("--json");
    }
  });

  it("caps the output budget and narrows changes to matching items", () => {
    expect(
      buildSteroidsArgs({ action: "show", repo: "a/b", path: "x.js", maxTokens: 20000 }),
    ).toEqual(["show", "--max-tokens", "4000", "--", "a/b", "x.js"]);
    expect(buildSteroidsArgs({ action: "search", pattern: "x", maxTokens: 20000 })).toContain(
      "1500",
    );
    expect(buildSteroidsArgs({ action: "search", pattern: "x", maxTokens: 1200 })).toContain(
      "1200",
    );
    expect(
      buildSteroidsArgs({
        action: "changes",
        repo: "axios/axios",
        pattern: "form|param",
        full: true,
      }),
    ).toEqual(["changes", "--pattern", "form|param", "--", "axios/axios"]);
    expect(buildSteroidsArgs({ action: "changes", repo: "axios/axios", full: true })).toEqual([
      "changes",
      "--full",
      "--",
      "axios/axios",
    ]);
  });

  it("drops full on a range, where it only bypassed the outline", () => {
    expect(
      buildSteroidsArgs({
        action: "show",
        repo: "a/b",
        path: "x.js",
        from: 1,
        to: 340,
        full: true,
      }),
    ).toEqual(["show", "--from", "1", "--to", "340", "--", "a/b", "x.js"]);
  });

  it("passes changes, full and several define names through", () => {
    expect(
      buildSteroidsArgs({ action: "changes", repo: "axios/axios", version: "1.21.0" }),
    ).toEqual(["changes", "--version", "1.21.0", "--", "axios/axios"]);
    expect(() => buildSteroidsArgs({ action: "changes" })).toThrow(/repo/);
    expect(buildSteroidsArgs({ action: "show", repo: "a/b", path: "x.js", full: true })).toEqual([
      "show",
      "--full",
      "--",
      "a/b",
      "x.js",
    ]);
    expect(
      buildSteroidsArgs({ action: "define", symbol: "forEach,merge", repo: "axios/axios" }),
    ).toEqual(["define", "--repo", "axios/axios", "--", "forEach,merge"]);
  });

  it("scopes define to a repo and path so it returns bodies, not the corpus", () => {
    expect(
      buildSteroidsArgs({ action: "define", symbol: "forEach", repo: "axios/axios", path: "lib" }),
    ).toEqual(["define", "--repo", "axios/axios", "--path", "lib", "--", "forEach"]);
  });

  it("reads only what show is asked for", () => {
    expect(
      buildSteroidsArgs({
        action: "show",
        repo: "axios/axios",
        path: "lib/utils.js",
        symbols: ["forEach", " isPlainObject ", ""],
        from: 1,
        noComments: true,
        maxTokens: 1000,
      }),
    ).toEqual([
      "show",
      "--symbols",
      "forEach,isPlainObject",
      "--no-comments",
      "--max-tokens",
      "1000",
      "--",
      "axios/axios",
      "lib/utils.js",
    ]);
    expect(
      buildSteroidsArgs({ action: "show", repo: "a/b", path: "t.test.js", outline: true, to: 9 }),
    ).toEqual(["show", "--outline", "--to", "9", "--", "a/b", "t.test.js"]);
    expect(buildSteroidsArgs({ action: "files", repo: "a/b", path: "lib/helpers" })).toEqual([
      "files",
      "--path",
      "lib/helpers",
      "--",
      "a/b",
    ]);
    expect(buildSteroidsArgs({ action: "repos", repo: "axios" })).toEqual([
      "repos",
      "--json",
      "--",
      "axios",
    ]);
  });

  it("builds add from an owner/name list and refuses anything else", () => {
    expect(
      buildSteroidsArgs({ action: "add", repos: ["go-chi/chi", "tw93/Pake"], tag: "web" }),
    ).toEqual(["add", "--tag", "web", "--", "go-chi/chi", "tw93/Pake"]);
    expect(() => buildSteroidsArgs({ action: "add", repos: [] })).toThrow(/repos/);
    expect(() => buildSteroidsArgs({ action: "add", repos: ["--root=/etc"] })).toThrow(
      /owner\/name/,
    );
    expect(() => buildSteroidsArgs({ action: "add", repos: ["a/b/c"] })).toThrow(/owner\/name/);
  });

  it("rejects an action missing its required argument", () => {
    expect(() => buildSteroidsArgs({ action: "search" })).toThrow(/pattern/);
    expect(() => buildSteroidsArgs({ action: "show", repo: "a/b" })).toThrow(/path/);
  });
});

describe("compactRepos", () => {
  it("collapses repos --json to one line per repo", () => {
    const json = JSON.stringify({
      count: 2,
      repositories: [
        {
          repo: "a/b",
          version: "1.21.0",
          language: "go",
          files: 12,
          last_commit: "2026-09-01",
          tags: ["web"],
        },
        { repo: "c/d", language: "rust", files: 3, last_commit: "2026-08-30", tags: [] },
      ],
      shown: 2,
    });
    expect(compactRepos(json)).toBe(
      "2 repos indexed, 2 shown\na/b  v1.21.0  go  12 files  2026-09-01 [web]\nc/d  rust  3 files  2026-08-30",
    );
  });

  it("shows index age without telling the agent to refresh", () => {
    const now = Date.parse("2026-09-23T00:00:00Z");
    const json = JSON.stringify({
      count: 2,
      repositories: [
        {
          repo: "a/b",
          language: "go",
          files: 1,
          last_commit: "2026-09-20",
          indexed_at: "2026-09-21T00:00:00Z",
        },
        {
          repo: "c/d",
          language: "go",
          files: 1,
          last_commit: "2026-09-01",
          indexed_at: "2026-09-02T00:00:00Z",
        },
      ],
    });
    expect(compactRepos(json, now)).toBe(
      "2 repos indexed, 2 shown\n" +
        "a/b  go  1 files  2026-09-20  indexed 2d ago\n" +
        "c/d  go  1 files  2026-09-01  indexed 21d ago",
    );
  });

  it("passes non-JSON through untouched", () => {
    expect(compactRepos("not json")).toBe("not json");
  });

  it("summarises an unfiltered list too long to read", () => {
    const repositories = Array.from({ length: 45 }, (_, i) => ({
      repo: `o/r${i}`,
      language: i % 3 === 0 ? "go" : "rust",
      tags: i === 0 ? ["ref"] : [],
    }));
    const json = JSON.stringify({ count: 45, repositories });
    expect(compactRepos(json, 0, false)).toBe(
      "45 repos indexed; too many to list. Find one with repo='name' (part of a name works), or narrow with tag.\nlanguages: rust 30, go 15\ntags: ref 1",
    );
    expect(compactRepos(json, 0, true).split("\n")).toHaveLength(46);
  });
});

describe("steroids tool", () => {
  it("never refuses indexing on plan-mode grounds (corpus is not the workspace)", async () => {
    // A plan grounded in real code needs the corpus filled first; the user
    // approves the repo list via the prompt, so no plan-mode gate here.
    const tool = createSteroidsTool("/nonexistent/steroids");
    const out = await tool.execute({ action: "add", repos: ["go-chi/chi"] }, {
      signal: new AbortController().signal,
    } as never);
    expect(out).not.toMatch(/plan mode/);
    expect(out).toMatch(/^Error: steroids add failed/);
  });

  // A stand-in CLI: text on stdout, the files summary on stderr, and the
  // `Error: …` line anyhow prints on failure.
  it.skipIf(process.platform === "win32")(
    "returns the CLI's text for reads and its stderr message on failure",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "steroids-fake-"));
      const bin = join(dir, "steroids");
      writeFileSync(
        bin,
        [
          "#!/bin/sh",
          'case "$1" in',
          '  show) printf "# a/b/x.c\\n1\\tint main(void) {\\n" ;;',
          '  files) printf "x.c\\tc\\t10\\n"; echo "1 of 1 files shown for a/b at v1.0.0" >&2 ;;',
          '  *) echo "Error: not in corpus: ghost/repo" >&2; exit 1 ;;',
          "esac",
        ].join("\n"),
        { mode: 0o755 },
      );
      try {
        const tool = createSteroidsTool(bin);
        const ctx = { signal: new AbortController().signal } as never;
        expect(
          await tool.execute({ action: "show", repo: "a/b", path: "x.c", symbols: ["main"] }, ctx),
        ).toBe("# a/b/x.c\n1\tint main(void) {");
        expect(await tool.execute({ action: "files", repo: "a/b" }, ctx)).toBe(
          "x.c\tc\t10\n1 of 1 files shown for a/b at v1.0.0",
        );
        expect(await tool.execute({ action: "define", symbol: "Thing" }, ctx)).toBe(
          "Error: steroids define failed: not in corpus: ghost/repo",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // Helpers one read showed are sent back on the next, so they are named
  // rather than repeated; reads in one reply run in order to see each other.
  it.skipIf(process.platform === "win32")(
    "passes helpers already shown back as --skip-uses, per repo",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "steroids-uses-"));
      const bin = join(dir, "steroids");
      const log = join(dir, "argv.log");
      writeFileSync(
        bin,
        [
          "#!/bin/sh",
          `echo "$*" >> '${log}'`,
          'printf "# a/b/x.js\\n1\\tcode\\n\\n# uses: helpers\\n\\n## lib/utils.js forEach 7-12\\n7\\tfunction forEach() {\\n"',
        ].join("\n"),
        { mode: 0o755 },
      );
      try {
        const tool = createSteroidsTool(bin);
        const ctx = { signal: new AbortController().signal } as never;
        await Promise.all([
          tool.execute({ action: "show", repo: "A/B", path: "x.js" }, ctx),
          tool.execute({ action: "show", repo: "a/b", path: "y.js" }, ctx),
        ]);
        await tool.execute({ action: "show", repo: "c/d", path: "z.js" }, ctx);
        const calls = readFileSync(log, "utf8").trim().split("\n");
        expect(calls[0]).not.toContain("--skip-uses");
        expect(calls[1]).toContain("--skip-uses lib/utils.js:7 -- a/b y.js");
        expect(calls[2]).not.toContain("--skip-uses");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("reports a missing binary as a tool error, not a throw", async () => {
    const tool = createSteroidsTool("/nonexistent/steroids");
    const out = await tool.execute({ action: "repos" }, {
      signal: new AbortController().signal,
    } as never);
    expect(out).toMatch(/^Error: steroids repos failed/);
  });

  it("is omitted from createTools when no binary is found", async () => {
    const result = await createTools(process.cwd(), { lspDiagnostics: false, steroidsBin: null });
    results.push(result);
    expect(result.tools.map((t) => t.name)).not.toContain("steroids");
  });

  it("is registered when a binary path is supplied", async () => {
    const result = await createTools(process.cwd(), {
      lspDiagnostics: false,
      steroidsBin: "/nonexistent/steroids",
    });
    results.push(result);
    expect(result.tools.map((t) => t.name)).toContain("steroids");
  });
});
