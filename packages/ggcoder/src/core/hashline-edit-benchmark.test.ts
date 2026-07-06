import { describe, it, expect } from "vitest";
import { lineHash, anchorFile } from "./hashline.js";
import {
  applyBaseline,
  applyHashline,
  applyLadder,
  checkAnchors,
  parseEnvelope,
  stripFence,
  genFile,
  genRepetitiveFile,
  buildTasks,
  type EditTask,
} from "./hashline-edit-benchmark.js";

/**
 * These tests prove the DETERMINISTIC half of the hashline benchmark — the
 * apply + grading logic that decides OK / FAIL / corruption. The live-model
 * numbers are only trustworthy if this logic is correct, so we exercise it from
 * every angle: anchor uniqueness, corruption-avoidance, multi-edit ordering,
 * malformed input, and the string-match baseline's ambiguity handling.
 */

/** Build a minimal EditTask around a hand-written file for precise assertions. */
function taskFor(
  file: string,
  mustContain: string[],
  mustPreserve: string[],
  validate?: (file: string) => boolean,
): EditTask {
  return {
    name: "t",
    approxLines: file.split("\n").length,
    file,
    instruction: "",
    mustContain,
    mustPreserve,
    validate,
  };
}

const FN_FILE = [
  "export function computeTimeout(cfg: Config): number {",
  "  return cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT;",
  "}",
].join("\n");

/** The anchor for a given 0-based line index of a file. */
function anchorAt(file: string, index: number): string {
  return lineHash(file.split("\n")[index]!, index);
}

describe("hashline anchoring", () => {
  it("1. folds line position into the hash so identical lines get distinct anchors", () => {
    // Two identical lines at different positions must NOT collide.
    expect(lineHash("  return x;", 3)).not.toBe(lineHash("  return x;", 9));
    // Same content + same position is stable (deterministic).
    expect(lineHash("  return x;", 3)).toBe(lineHash("  return x;", 3));
  });

  it("2. gives every line a unique resolvable anchor — even repeated blank lines", () => {
    const file = ["a", "", "b", "", "c"].join("\n"); // two blank lines
    const a = anchorFile(file);
    expect(a.ambiguous.size).toBe(0);
    expect(a.anchorToIndex.size).toBe(5);
    expect([...a.anchorToIndex.values()].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
  });

  it("3. renders as `anchor│line` and the line column reconstructs the file", () => {
    const a = anchorFile(FN_FILE);
    const stripped = a.rendered
      .split("\n")
      .map((l) => l.slice(l.indexOf("│") + 1))
      .join("\n");
    expect(stripped).toBe(FN_FILE);
  });
});

describe("applyHashline (proposed)", () => {
  it("4. applies a valid single-line edit and grades it correct", () => {
    const anchored = anchorFile(FN_FILE);
    const anchor = anchorAt(FN_FILE, 1); // the `return ...` line
    const raw = JSON.stringify({
      edits: [
        {
          from: anchor,
          to: anchor,
          lines: [
            "  return cfg.retries > 0 ? Math.min(cfg.timeoutMs * cfg.retries, 30000) : (cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT);",
          ],
        },
      ],
    });
    const task = taskFor(
      FN_FILE,
      ["cfg.timeoutMs * cfg.retries", "30000"],
      ["computeTimeout", "DEFAULT_TIMEOUT"],
    );
    const out = applyHashline(raw, task, anchored);
    expect(out.applied).toBe(true);
    expect(out.correct).toBe(true);
    expect(out.ambiguousEdits).toBe(0);
  });

  it("5. rejects an edit whose anchor is not in the file — never corrupts", () => {
    const anchored = anchorFile(FN_FILE);
    const raw = JSON.stringify({ edits: [{ from: "0000", to: "0000", lines: ["// hijacked"] }] });
    const task = taskFor(FN_FILE, [], ["computeTimeout"]);
    const out = applyHashline(raw, task, anchored);
    expect(out.applied).toBe(false);
    expect(out.correct).toBe(false);
    expect(out.ambiguousEdits).toBe(1);
  });

  it("6. rejects a reversed range (from after to)", () => {
    const anchored = anchorFile(FN_FILE);
    const raw = JSON.stringify({
      edits: [{ from: anchorAt(FN_FILE, 2), to: anchorAt(FN_FILE, 0), lines: ["x"] }],
    });
    const out = applyHashline(raw, taskFor(FN_FILE, [], []), anchored);
    expect(out.applied).toBe(false);
  });

  it("7. applies multiple edits bottom-up so earlier indices stay valid", () => {
    const file = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");
    const anchored = anchorFile(file);
    const raw = JSON.stringify({
      edits: [
        { from: anchorAt(file, 0), to: anchorAt(file, 0), lines: ["const a = 10;"] },
        { from: anchorAt(file, 2), to: anchorAt(file, 2), lines: ["const c = 30;"] },
      ],
    });
    const out = applyHashline(
      raw,
      taskFor(file, ["const a = 10;", "const c = 30;"], ["const b = 2;"]),
      anchored,
    );
    expect(out.applied).toBe(true);
    expect(out.correct).toBe(true);
  });

  it("8. returns a clean failure on malformed JSON instead of throwing", () => {
    const anchored = anchorFile(FN_FILE);
    expect(() => applyHashline("not json {", taskFor(FN_FILE, [], []), anchored)).not.toThrow();
    const out = applyHashline("not json {", taskFor(FN_FILE, [], []), anchored);
    expect(out.applied).toBe(false);
    expect(out.parsedEdits).toBe(0);
  });
});

describe("applyBaseline (current string-match) + helpers", () => {
  it("9. applies a unique old_text but rejects a non-unique one", () => {
    const unique = taskFor("const x = 1;\nconst y = 2;\n", ["const x = 100;"], ["const y = 2;"]);
    const okRaw = JSON.stringify({
      edits: [{ old_text: "const x = 1;", new_text: "const x = 100;" }],
    });
    expect(applyBaseline(okRaw, unique).applied).toBe(true);

    // Same literal appears twice → the real edit tool refuses; so must we.
    const dup = taskFor("const x = 1;\nconst y = 2;\nconst x = 1;\n", [], []);
    const dupRaw = JSON.stringify({
      edits: [{ old_text: "const x = 1;", new_text: "const x = 9;" }],
    });
    const out = applyBaseline(dupRaw, dup);
    expect(out.applied).toBe(false);
    expect(out.ambiguousEdits).toBe(1);
  });

  it("10. flags not-found old_text, strips code fences, and grades generated tasks", () => {
    // Paraphrased / drifted old_text that isn't in the file → rejected.
    const notFound = JSON.stringify({ edits: [{ old_text: "const z = 0;", new_text: "x" }] });
    expect(applyBaseline(notFound, taskFor("const a = 1;\n", [], [])).applied).toBe(false);

    // stripFence removes ```ts ... ``` wrappers the model sometimes adds.
    expect(stripFence('```ts\n{"edits":[]}\n```')).toBe('{"edits":[]}');

    // The generator + grader agree: a freshly generated file preserves its anchors.
    const task = buildTasks()[0]!;
    expect(genFile(task.approxLines)).toContain("computeTimeout");
    expect(checkAnchors(task.file, taskFor(task.file, [], task.mustPreserve))).toBe(true);
  });

  it("11. baseline gets fallback-ladder credit: indent-flex recovers dedented old_text", () => {
    const file = "function f() {\n  const x = 1;\n  return x;\n}\n";
    // Model omitted the two-space indentation — exact match fails, ladder recovers.
    const raw = JSON.stringify({
      edits: [{ old_text: "const x = 1;\nreturn x;", new_text: "return 2;" }],
    });
    const out = applyBaseline(raw, taskFor(file, ["return 2;"], ["function f()"]));
    expect(out.applied).toBe(true);
    expect(out.correct).toBe(true);
  });

  it("12. applyLadder: ambiguous does NOT fall through to fuzzy recovery", () => {
    const file = "a();\nb();\na();\n";
    expect(applyLadder(file, "a();", "c();")).toEqual({ ok: false, reason: "ambiguous" });
    // Unique match still applies.
    const ok = applyLadder(file, "b();", "c();");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.working).toBe("a();\nc();\na();\n");
  });
});

describe("parseEnvelope + task validators", () => {
  it("13. repairs literal newlines/tabs inside JSON string values (both strategies)", () => {
    // What sonnet actually emitted in run 1: raw newlines inside old_text/new_text.
    const raw = '{"edits":[{"old_text":"line1\nline2","new_text":"a\tb"}]}';
    const parsed = parseEnvelope<{ edits: Array<{ old_text: string; new_text: string }> }>(raw);
    expect(parsed?.edits[0]?.old_text).toBe("line1\nline2");
    expect(parsed?.edits[0]?.new_text).toBe("a\tb");
    // Already-valid JSON passes through untouched; garbage returns null.
    expect(parseEnvelope('{"edits":[]}')).toEqual({ edits: [] });
    expect(parseEnvelope("not json {")).toBeNull();
  });

  it("14. checkAnchors enforces the custom validator (repeat task: exactly one 422)", () => {
    const repeat = buildTasks().find((t) => t.name === "repeat")!;
    // Correct edit: only handleCase7's error(400) becomes error(422). Slice on
    // the handler boundaries instead of regex (lint bans countable spaces).
    const start = repeat.file.indexOf("export function handleCase7");
    const end = repeat.file.indexOf("export function handleCase8");
    const good =
      repeat.file.slice(0, start) +
      repeat.file.slice(start, end).replace("error(400)", "error(422)") +
      repeat.file.slice(end);
    expect(checkAnchors(good, repeat)).toBe(true);
    // Over-broad edit (all handlers changed) fails the validator even though
    // the substring checks alone would pass.
    const bad = repeat.file.replaceAll("error(400)", "error(422)");
    expect(checkAnchors(bad, repeat)).toBe(false);
    // Sanity: generator emits the requested number of near-identical blocks.
    expect(genRepetitiveFile(3)).toContain("handleCase2");
  });
});
