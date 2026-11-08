import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import { createGrepTool } from "./grep.js";

/** Grouped grep output back to flat `path:line:text` records (+ trailing notes). */
function flat(output: unknown): string {
  const s = String(output);
  const idx = s.search(/\n\n(?:\[Truncated|\d+ match)/);
  const body = idx >= 0 ? s.slice(0, idx) : s;
  const tail = idx >= 0 ? s.slice(idx) : "";
  const records: string[] = [];
  let file: string | undefined;
  for (const line of body.split("\n")) {
    if (!line) {
      file = undefined;
      continue;
    }
    if (file !== undefined && /^\d+:/.test(line)) records.push(`${file}:${line}`);
    else file = line;
  }
  return records.length > 0 ? records.join("\n") + tail : s;
}

function context() {
  return { signal: new AbortController().signal, toolCallId: "test" };
}

async function makeFixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-recall-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return dir;
}

/** Both scanner paths, so recall is asserted for whichever one a host uses. */
const scanners = [
  { label: "in-process", useExternalScanner: () => false },
  { label: "external", useExternalScanner: () => true },
] as const;

describe.each(scanners)("grep recall ($label)", ({ useExternalScanner }) => {
  const grep = (dir: string) => createGrepTool(dir, undefined, { useExternalScanner });

  it("searches dot-directories", async () => {
    const dir = await makeFixture({
      ".github/workflows/ci.yml": "jobs:\n  build:\n    runs-on: ubuntu-latest\n",
      "README.md": "no jobs here\n",
    });

    const result = await grep(dir).execute({ pattern: "runs-on" }, context());
    expect(flat(result)).toContain(path.join(".github", "workflows", "ci.yml") + ":3:");
  });

  it("skips files matched by .gitignore", async () => {
    const dir = await makeFixture({
      ".gitignore": "dist/\n*.log\n",
      "src/app.ts": "export const marker = 1;\n",
      "dist/app.js": "export const marker = 1;\n",
      "debug.log": "marker\n",
    });

    const result = await grep(dir).execute({ pattern: "marker" }, context());
    expect(flat(result)).toContain(path.join("src", "app.ts") + ":1:");
    expect(flat(result)).not.toContain("dist");
    expect(flat(result)).not.toContain("debug.log");
  });

  it("still searches an ignored directory when it is the explicit path", async () => {
    const dir = await makeFixture({
      ".gitignore": "dist/\n",
      "dist/app.js": "export const marker = 1;\n",
    });

    const result = await grep(dir).execute({ pattern: "marker", path: "dist" }, context());
    expect(flat(result)).toContain("app.js:1:");
  });

  it("never scans node_modules or .git", async () => {
    const dir = await makeFixture({
      "node_modules/dep/index.js": "marker\n",
      ".git/COMMIT_EDITMSG": "marker\n",
      "src/keep.ts": "marker\n",
    });

    const result = await grep(dir).execute({ pattern: "marker" }, context());
    expect(flat(result)).toContain(path.join("src", "keep.ts") + ":1:");
    expect(flat(result)).not.toContain("node_modules");
    expect(flat(result)).not.toContain(".git");
  });
});

describe("grep scan ordering", () => {
  it("matches a sequential scan over the same candidate list", async () => {
    const files: Record<string, string> = {};
    // Enough files to fill several scan waves, with matches spread across them.
    for (let i = 0; i < 50; i++) {
      files[`pkg${String(i).padStart(2, "0")}/mod.ts`] =
        `line one\nconst marker${i} = ${i};\nmarker tail\n`;
    }
    const dir = await makeFixture(files);

    const parallel = await createGrepTool(dir, undefined, {
      useExternalScanner: () => false,
    }).execute({ pattern: "marker", max_results: 500 }, context());

    const expected = await sequentialScan(dir, /marker/g);
    expect(flat(parallel).split("\n\n")[0]).toBe(expected.join("\n"));
  });
});

/**
 * Reference implementation: one file at a time, candidates in sorted order.
 *
 * fast-glob always yields POSIX-separated paths, while the tool reports
 * `path.relative` output — native separators, so backslashes on Windows.
 * Normalizing here keeps this test about ORDER and CONTENT; asserting the raw
 * glob strings instead silently made it a path-format test that only failed on
 * Windows.
 */
async function sequentialScan(dir: string, regex: RegExp): Promise<string[]> {
  const fg = await import("fast-glob");
  const entries = (
    await fg.default("**/*", { cwd: dir, dot: true, onlyFiles: true, suppressErrors: true })
  )
    .sort()
    .map((entry) => path.normalize(entry));

  const results: string[] = [];
  for (const entry of entries) {
    const rl = readline.createInterface({
      input: createReadStream(path.join(dir, entry), "utf-8"),
      crlfDelay: Infinity,
    });
    let lineNum = 0;
    for await (const line of rl) {
      lineNum++;
      regex.lastIndex = 0;
      if (regex.test(line)) results.push(`${entry}:${lineNum}:${line}`);
    }
    rl.close();
  }
  return results;
}
