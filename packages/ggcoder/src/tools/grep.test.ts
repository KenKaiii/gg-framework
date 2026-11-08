import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGrepTool, groupByFile, requiredLiterals } from "./grep.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { disposeGrepWorkerPool, GrepWorkerPool } from "./grep-scan.js";

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

describe("createGrepTool", () => {
  it("stops after max_results before scanning later files", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-limit-"));
    await fs.writeFile(path.join(tmpDir, "a.txt"), "needle\n");
    await fs.writeFile(path.join(tmpDir, "z.txt"), "needle\n");

    const result = await createGrepTool(tmpDir).execute(
      { pattern: "needle", include: "*.txt", max_results: 1 },
      context(),
    );

    expect(flat(result)).toContain("a.txt:1:needle");
    expect(flat(result)).not.toContain("z.txt:1:needle");
    expect(flat(result)).toContain("[Truncated at 1 matches]");
  });

  it("accepts a leading (?i) as a case-insensitive regex flag", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-inline-flag-"));
    await fs.writeFile(path.join(tmpDir, "deploy.txt"), "Deploy to Railway\n");

    const result = await createGrepTool(tmpDir).execute(
      { pattern: "(?i)deploy|railway", include: "*.txt" },
      context(),
    );

    expect(flat(result)).toContain("deploy.txt:1:Deploy to Railway");
  });

  it.each(["(a+)+$", "(\\w+\\s?)*$", "(x*){2,}", "((ab)+)+"])(
    "rejects nested-quantifier pattern %s before touching the filesystem",
    async (pattern) => {
      let touched = false;
      const ops: ToolOperations = {
        ...localOperations,
        stat: (p) => {
          touched = true;
          return localOperations.stat(p);
        },
      };

      await expect(
        createGrepTool("/nonexistent-root", ops).execute({ pattern }, context()),
      ).rejects.toThrow(/nested quantifier/);
      expect(touched).toBe(false);
    },
  );

  it("allows a quantified group whose body has no quantifier", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-safe-quant-"));
    await fs.writeFile(path.join(tmpDir, "a.txt"), "abab\n");

    const result = await createGrepTool(tmpDir).execute(
      { pattern: "(ab)+", include: "*.txt" },
      context(),
    );

    expect(flat(result)).toContain("a.txt:1:abab");
  });

  it.each(["(?:ab)+", "(?:ab|ba)+", "(?:a|b)*b", "(\\d+)?ab", "(a+){1,3}"])(
    "allows benign pattern %s",
    async (pattern) => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-benign-"));
      await fs.writeFile(path.join(tmpDir, "a.txt"), "abab\n");

      const result = await createGrepTool(tmpDir).execute({ pattern, include: "*.txt" }, context());

      expect(flat(result)).toContain("a.txt:1:abab");
    },
  );

  it("rejects an oversize pattern", async () => {
    await expect(
      createGrepTool("/nonexistent-root").execute({ pattern: "a".repeat(1001) }, context()),
    ).rejects.toThrow(/exceeds the 1000-character limit/);
  });

  it("returns partial results plus a notice when the deadline expires", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-deadline-"));
    // More candidates than the scan pool is wide, so the files past the first
    // wave are genuinely never reached once the budget expires.
    const names = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`);
    for (const name of names) await fs.writeFile(path.join(tmpDir, name), "needle\n");

    // The grep's clock moves only when a file is read, so the budget always
    // runs out during the first wave of reads. With a real 300ms budget, the
    // setup before the scan (loading the glob library, listing the files)
    // sometimes used it all up on a loaded CI runner, and nothing was searched.
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const slowOps: ToolOperations = {
      ...localOperations,
      stat: async (p) => {
        const stat = await localOperations.stat(p);
        if (stat.isFile()) now += 400;
        return stat;
      },
    };

    try {
      const result = await createGrepTool(tmpDir, slowOps, { deadlineMs: 300 }).execute(
        { pattern: "needle", include: "*.txt", max_results: 100 },
        context(),
      );

      expect(flat(result)).toContain("f00.txt:1:needle");
      expect(flat(result)).not.toContain("f39.txt:1:needle");
      expect(flat(result)).toContain("Stopped after 0.3s");
    } finally {
      clock.mockRestore();
    }
  });

  it("reports the deadline notice when nothing matched", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-deadline-empty-"));
    await fs.writeFile(path.join(tmpDir, "a.txt"), "needle\n");

    const result = await createGrepTool(tmpDir, localOperations, { deadlineMs: 0 }).execute(
      { pattern: "needle", include: "*.txt" },
      context(),
    );

    expect(flat(result)).toContain("No matches found.");
    expect(flat(result)).toContain("narrow the pattern");
  });
});

describe("in-process fast path", () => {
  afterAll(() => disposeGrepWorkerPool());

  /** Line-ending, binary and blank-line shapes where a whole-file read could drift. */
  const files: Record<string, string> = {
    "crlf.txt": "alpha\r\nbeta  \r\n\r\nalpha end\r\n",
    "lone-cr.txt": "one\rtwo alpha\rthree\n",
    "blank-tail.txt": "alpha\n\n\n",
    "no-newline.txt": "last alpha",
    "nul.txt": "alpha first\nsecond\nbin\0ary alpha\nalpha after\n",
    "unicode.txt": "caf\u00e9 Alpha\n\u00c9LAN alpha\n",
    "cross.txt": "foo\nbar\n",
    // An astral character straddling the 500-char truncation point.
    "astral.txt": `${"x".repeat(499)}\u{1F600} alpha\n`,
  };
  const patterns = [
    { pattern: "alpha" },
    { pattern: "ALPHA", case_insensitive: true },
    { pattern: "^$" },
    { pattern: "\\s$" },
    { pattern: "^alpha" },
    { pattern: "alpha$" },
    { pattern: "caf\u00e9" },
    { pattern: "foo\\sbar" },
    { pattern: "foo[^x]bar" },
    { pattern: "alpha(?! end)" },
  ];

  it.each(patterns)("matches the streaming scan for $pattern", async (args) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-fast-"));
    for (const [name, body] of Object.entries(files)) {
      await fs.writeFile(path.join(tmpDir, name), body);
    }
    // A failing readFile sends every file down the original streaming path.
    const streamingOnly: ToolOperations = {
      ...localOperations,
      readFile: () => Promise.reject(new Error("streaming only")),
    };
    const query = { ...args, max_results: 500 };
    const fast = await createGrepTool(tmpDir, localOperations, {
      useExternalScanner: () => false,
    }).execute(query, context());
    const streamed = await createGrepTool(tmpDir, streamingOnly, {
      useExternalScanner: () => false,
    }).execute(query, context());
    const workers = await createGrepTool(tmpDir, localOperations, {
      useExternalScanner: () => false,
      workerMinFiles: 1,
    }).execute(query, context());

    expect(String(fast)).toBe(String(streamed));
    expect(String(workers)).toBe(String(streamed));
  });

  it("runs the search inside a worker thread, not only via main-thread fallback", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-pool-"));
    const file = path.join(tmpDir, "a.txt");
    await fs.writeFile(file, "one\nneedle two\n");
    const pool = new GrepWorkerPool(1, 1024);
    try {
      const outcome = await pool.run({
        files: [
          [file, "a.txt"],
          [path.join(tmpDir, "missing.txt"), "missing.txt"],
        ],
        options: {
          source: "needle",
          flags: "g",
          prefilter: true,
          maxResults: 50,
          expiresAt: Date.now() + 60_000,
          maxLineLength: 500,
          checkInterval: 512,
          sniffLines: 5,
        },
        literals: ["needle"],
        caseInsensitive: false,
        readLimit: 1024,
        stopAfter: 50,
      });
      // `null` = "scan this one on the main thread" (it could not be read).
      expect(outcome).toEqual({ results: [["a.txt:2:needle two"], null], expired: false });
    } finally {
      pool.dispose();
    }
  });

  it("returns the same first matches from workers as from one thread", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-workers-"));
    // Enough files for several chunks, so chunks finish out of order.
    for (let i = 0; i < 400; i++) {
      const name = `f${String(i).padStart(3, "0")}.txt`;
      const body = i % 7 === 0 ? "needle a\nskip\nneedle b\n" : "nothing here\n";
      await fs.writeFile(path.join(tmpDir, name), body);
    }
    // One file a worker cannot read whole goes back to the main thread.
    await fs.writeFile(path.join(tmpDir, "f003.big"), `needle big\n${"y".repeat(1_100_000)}\n`);

    for (const max_results of [1, 5, 40, 500]) {
      const query = { pattern: "needle", max_results };
      const single = await createGrepTool(tmpDir, localOperations, {
        useExternalScanner: () => false,
        workerMinFiles: Number.POSITIVE_INFINITY,
      }).execute(query, context());
      const workers = await createGrepTool(tmpDir, localOperations, {
        useExternalScanner: () => false,
        workerMinFiles: 1,
      }).execute(query, context());
      expect(String(workers)).toBe(String(single));
    }
  });

  it("prunes ignored directories without losing re-included files", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-prune-"));
    await fs.writeFile(
      path.join(tmpDir, ".gitignore"),
      "logs/*\n!logs/keep.txt\nout/\n!out/x.txt\n",
    );
    for (const rel of ["logs/keep.txt", "logs/drop.txt", "out/x.txt", "src/a.txt"]) {
      await fs.mkdir(path.dirname(path.join(tmpDir, rel)), { recursive: true });
      await fs.writeFile(path.join(tmpDir, rel), "needle\n");
    }

    const result = String(
      await createGrepTool(tmpDir, localOperations, { useExternalScanner: () => false }).execute(
        { pattern: "needle" },
        context(),
      ),
    );

    expect(flat(result)).toContain(`${path.join("logs", "keep.txt")}:1:needle`);
    expect(flat(result)).toContain(`${path.join("src", "a.txt")}:1:needle`);
    // git cannot re-include a file under an ignored directory.
    expect(flat(result)).not.toContain("drop.txt");
    expect(flat(result)).not.toContain(path.join("out", "x.txt"));
  });
});

describe("requiredLiterals", () => {
  it.each([
    ["foo", ["foo"]],
    ["TODO|FIXME", ["TODO", "FIXME"]],
    ["colou?r", ["colo"]],
    ["ab+c", ["ab"]],
    ["ab{0,2}c", ["a"]],
    ["(foo|bar)baz", ["baz"]],
    ["[abc]def\\b", ["def"]],
    ["\\.test\\(", [".test("]],
    ["caf\u00e9", ["caf"]],
    ["\u00e9t\u00e9", ["t"]],
  ])("finds the literals every match of %s contains", (pattern, expected) => {
    expect(requiredLiterals(pattern)).toEqual(expected);
  });

  it.each(["x*", "a|\\d+", "(foo)", "[abc]+", "\\w+\\s", "\u00e9\u00e8"])(
    "proves nothing for %s",
    (pattern) => {
      expect(requiredLiterals(pattern)).toBeUndefined();
    },
  );

  it("prints each file's path once, then its line:text rows", () => {
    expect(
      groupByFile([
        "src/a.ts:3:const x = 1;",
        "src/a.ts:9:x: 2:3",
        String.raw`D:\repo\b.ts:12:y`,
        "src/a.ts:40:again",
      ]),
    ).toBe(
      [
        "src/a.ts",
        "3:const x = 1;",
        "9:x: 2:3",
        "",
        String.raw`D:\repo\b.ts`,
        "12:y",
        "",
        "src/a.ts",
        "40:again",
      ].join("\n"),
    );
  });
});
