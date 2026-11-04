import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHelperReceipt,
  extractReportPaths,
  findUnbackedPaths,
  formatReceipt,
  RECEIPT_MAX_CHARS,
  ReceiptRecorder,
  type ReceiptCall,
} from "./subagent-receipt.js";

const cwd = path.resolve("/repo");

function record(events: Array<[string, Record<string, unknown>, string, boolean?]>): ReceiptCall[] {
  const recorder = new ReceiptRecorder();
  events.forEach(([name, args, result, isError], index) => {
    recorder.start(`c${index}`, name, args);
    recorder.end(`c${index}`, result, isError ?? false);
  });
  return recorder.snapshot();
}

describe("formatReceipt", () => {
  it("groups by tool, collapses repeats, sorts, and shows outcomes", () => {
    const calls = record([
      ["read", { file_path: "/repo/src/b.ts" }, "x"],
      ["read", { file_path: "src/a.ts" }, "x"],
      ["read", { file_path: "src/a.ts" }, "x"],
      ["grep", { pattern: "fooBar" }, "x"],
      ["bash", { command: "npm test\necho done" }, "Exit code: 0\nok"],
      ["bash", { command: "npm run lint" }, "Exit code: 1\nbad"],
      ["edit", { file_path: "src/b.ts" }, "ok"],
      ["write", { file_path: "src/c.ts" }, "denied", true],
    ]);
    expect(formatReceipt(calls, cwd)).toBe(
      "Receipt (8 calls): bash `npm run lint` → exit 1, `npm test` → exit 0 · " +
        'edit src/b.ts ✓ · grep "fooBar" · read src/a.ts ×2, src/b.ts · write src/c.ts ✗',
    );
  });

  it("is deterministic regardless of call order", () => {
    const a = record([
      ["read", { file_path: "x.ts" }, ""],
      ["ls", { path: "src" }, ""],
    ]);
    const b = record([
      ["ls", { path: "src" }, ""],
      ["read", { file_path: "x.ts" }, ""],
    ]);
    expect(formatReceipt(a, cwd)).toBe(formatReceipt(b, cwd));
  });

  it("caps at RECEIPT_MAX_CHARS with +N more", () => {
    const calls = record(
      Array.from(
        { length: 80 },
        (_, i) =>
          ["read", { file_path: `src/file-${i}.ts` }, ""] as [
            string,
            Record<string, unknown>,
            string,
          ],
      ),
    );
    const line = formatReceipt(calls, cwd);
    expect(line.length).toBeLessThanOrEqual(RECEIPT_MAX_CHARS);
    expect(line).toMatch(/ · \+\d+ more$/);
    expect(line.startsWith("Receipt (80 calls): read ")).toBe(true);
  });

  it("marks unfinished calls and reports no calls", () => {
    const recorder = new ReceiptRecorder();
    recorder.start("1", "bash", { command: "sleep 100" });
    expect(formatReceipt(recorder.snapshot(), cwd)).toBe(
      "Receipt (1 call): bash `sleep 100` (unfinished)",
    );
    expect(formatReceipt([], cwd)).toBe("Receipt (0 calls): no tool calls");
  });
});

describe("findUnbackedPaths", () => {
  const calls = record([
    ["read", { file_path: "/repo/src/a.ts" }, ""],
    ["edit", { file_path: "src/b.ts" }, ""],
    ["grep", { pattern: "x", path: "lib" }, ""],
    ["read", { file_path: "missing.ts" }, "ENOENT", true],
  ]);

  it("flags only paths the helper never touched", () => {
    const report =
      "Fixed `src/a.ts:12` and ./src/b.ts:4:2; see /repo/src/a.ts. lib/deep/c.ts matches. " +
      "But src/never.ts and /repo/other/z.py and missing.ts were claimed too.";
    expect(findUnbackedPaths(report, calls, cwd)).toEqual([
      "/repo/other/z.py",
      "missing.ts",
      "src/never.ts",
    ]);
  });

  it("matches relative mentions against absolute reads and vice versa", () => {
    expect(findUnbackedPaths("see a.ts and src/a.ts", calls, cwd)).toEqual([]);
    expect(findUnbackedPaths("see /repo/src/b.ts", calls, cwd)).toEqual([]);
  });

  it("does not flag URLs, library names, or non-path prose", () => {
    const report =
      "Docs at https://example.com/src/x.ts. Uses Node.js and Next.js, e.g. version 1.2.3, i.e. fine.";
    expect(extractReportPaths(report)).toEqual([]);
  });

  it("treats a search root of cwd as covering everything under it", () => {
    const searched = record([["grep", { pattern: "foo" }, ""]]);
    expect(findUnbackedPaths("src/anything.ts", searched, cwd)).toEqual([]);
  });

  it("renders a capped 'Not opened' line", () => {
    const report = Array.from({ length: 7 }, (_, i) => `src/n${i}.ts`).join(" ");
    expect(buildHelperReceipt([], report, cwd)).toBe(
      "Receipt (0 calls): no tool calls\n" +
        "Not opened by this helper: src/n0.ts, src/n1.ts, src/n2.ts, src/n3.ts, src/n4.ts, +2 more",
    );
  });
});
