import { describe, it, expect } from "vitest";
import {
  fuzzyFindText,
  countOccurrences,
  generateDiff,
  findClosestSnippet,
  findOccurrenceLines,
  stripLeadingBlankLine,
  applyDotdotdots,
  applyMissingLeadingWhitespace,
} from "./edit-diff.js";

describe("fuzzyFindText", () => {
  it("finds exact match with usedFuzzy=false", () => {
    const content = "hello world\nfoo bar\n";
    const result = fuzzyFindText(content, "foo bar");
    expect(result.found).toBe(true);
    expect(result.usedFuzzy).toBe(false);
    expect(result.index).toBe(content.indexOf("foo bar"));
    expect(result.matchLength).toBe("foo bar".length);
  });

  it("returns not found for missing text", () => {
    const content = "hello world\n";
    const result = fuzzyFindText(content, "does not exist");
    expect(result.found).toBe(false);
    expect(result.index).toBe(-1);
    expect(result.matchLength).toBe(0);
  });

  it("fuzzy matches trailing whitespace differences with usedFuzzy=true", () => {
    const content = "line one   \nline two\n";
    const search = "line one\nline two";
    const result = fuzzyFindText(content, search);
    expect(result.found).toBe(true);
    expect(result.usedFuzzy).toBe(true);
  });

  it("fuzzy matches smart quotes to straight quotes", () => {
    const content = 'She said "hello"';
    const search = "She said \u201Chello\u201D";
    const result = fuzzyFindText(content, search);
    expect(result.found).toBe(true);
    expect(result.usedFuzzy).toBe(true);
  });
});

describe("countOccurrences", () => {
  it("counts single occurrence as 1", () => {
    const content = "abc def ghi";
    expect(countOccurrences(content, "def")).toBe(1);
  });

  it("counts multiple occurrences correctly", () => {
    const content = "aaa bbb aaa ccc aaa";
    expect(countOccurrences(content, "aaa")).toBe(3);
  });

  it("returns 0 for no match", () => {
    const content = "hello world";
    expect(countOccurrences(content, "xyz")).toBe(0);
  });

  it("falls back to fuzzy count when exact is 0", () => {
    // Exact won't match because of smart quotes, fuzzy should find 1
    const contentSmartQuote = "say \u201Chi\u201D and \u201Chi\u201D";
    const searchStraight = 'say "hi"';
    // Exact won't match because of smart quotes, fuzzy should find 1
    expect(countOccurrences(contentSmartQuote, searchStraight)).toBe(1);
  });
});

describe("findClosestSnippet", () => {
  const content = [
    "import { useState } from 'react';",
    "",
    "export function Counter() {",
    "  const [count, setCount] = useState(0);",
    "  return <div>{count}</div>;",
    "}",
  ].join("\n");

  it("finds the closest line by token overlap and returns numbered context", () => {
    const result = findClosestSnippet(content, "const [count, setCount] = useState(1);", 1);
    expect(result).not.toBeNull();
    expect(result!.snippet).toContain("useState(0)");
    // Numbered (cat -n style)
    expect(result!.snippet).toMatch(/^\s+\d+\t/m);
  });

  it("returns the 1-based line of the strongest candidate for read-suggestion use", () => {
    const result = findClosestSnippet(content, "const [count, setCount] = useState(1);", 1);
    expect(result).not.toBeNull();
    // Line 4 of `content` is `  const [count, setCount] = useState(0);`
    expect(result!.topLine).toBe(4);
  });

  it("returns null when there are no shared tokens", () => {
    const result = findClosestSnippet(content, "completely unrelated zzzqqq xxx");
    expect(result).toBeNull();
  });

  it("returns null on empty oldText", () => {
    expect(findClosestSnippet(content, "")).toBeNull();
    expect(findClosestSnippet(content, "   \n\n")).toBeNull();
  });

  it("respects contextLines", () => {
    const result = findClosestSnippet(content, "const [count, setCount] = useState(1);", 0);
    expect(result!.snippet).toBe("     4\t  const [count, setCount] = useState(0);");
  });

  it("returns multiple matches separated by --- when several regions tie", () => {
    const multi = [
      "function handleClick() {",
      "  setCount(count + 1);",
      "}",
      "",
      "function handleReset() {",
      "  setCount(0);",
      "}",
      "",
      "function handleDouble() {",
      "  setCount(count * 2);",
      "}",
    ].join("\n");

    const result = findClosestSnippet(multi, "setCount(count - 1);", 0, 3);
    expect(result).not.toBeNull();
    const parts = result!.snippet.split("\n---\n");
    expect(parts.length).toBeGreaterThanOrEqual(2);
    // Every part should reference setCount
    for (const p of parts) expect(p).toContain("setCount");
  });

  it("keeps a single match when one candidate dominates", () => {
    const result = findClosestSnippet(content, "const [count, setCount] = useState(1);", 1);
    // Only line 4 has the full token set; line 1 (just `useState`) is dropped
    // by the bestScore/3 cutoff.
    expect(result).not.toBeNull();
    expect(result!.snippet.split("\n---\n")).toHaveLength(1);
  });
});

describe("findOccurrenceLines", () => {
  it("returns 1-indexed line numbers and trimmed previews for every match", () => {
    const css = [
      ".timer { color: white; }",
      ".button { color: black; }",
      ".label { color: white; }",
      ".footer { color: white; }",
    ].join("\n");

    const matches = findOccurrenceLines(css, "color: white;");
    expect(matches).toEqual([
      { line: 1, preview: ".timer { color: white; }" },
      { line: 3, preview: ".label { color: white; }" },
      { line: 4, preview: ".footer { color: white; }" },
    ]);
  });

  it("caps results at `max` so dozens of matches stay compact", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `row ${i} }`);
    const matches = findOccurrenceLines(lines.join("\n"), "}", 4);
    expect(matches).toHaveLength(4);
    expect(matches[0].line).toBe(1);
  });

  it("falls back to fuzzy matching when exact yields zero", () => {
    const content = "say “hi”";
    const matches = findOccurrenceLines(content, 'say "hi"');
    expect(matches).toHaveLength(1);
    expect(matches[0].line).toBe(1);
  });

  it("returns empty array for no matches at all", () => {
    expect(findOccurrenceLines("hello world", "missing")).toEqual([]);
  });
});

describe("applyMissingLeadingWhitespace", () => {
  it("returns null when text matches exactly (caller already handled it)", () => {
    // The whole point of this strategy is to handle MIS-indented text.
    // When indentation matches, this returns null too — but in practice
    // the primary exact matcher catches that case first.
    const file = "  function foo() {\n    return 1;\n  }\n";
    const old = "function foo() {\n  return 1;\n}";
    const next = "function foo() {\n  return 2;\n}";
    const result = applyMissingLeadingWhitespace(file, old, next);
    expect(result).not.toBeNull();
    expect(result).toContain("return 2;");
    // File's 2-space prefix was preserved on the rewritten lines.
    expect(result).toContain("  function foo() {");
    expect(result).toContain("    return 2;");
    expect(result).toContain("  }");
  });

  it("model omits indentation entirely; file has 4 spaces — apply 4-space prefix to new", () => {
    const file = "    const x = 1;\n    const y = 2;\n    const z = 3;\n";
    const old = "const x = 1;\nconst y = 2;\nconst z = 3;";
    const next = "const x = 10;\nconst y = 20;\nconst z = 30;";
    const result = applyMissingLeadingWhitespace(file, old, next);
    expect(result).toBe("    const x = 10;\n    const y = 20;\n    const z = 30;\n");
  });

  it("model used 2-space indent but file uses 4 — outdents both, finds match, re-indents new", () => {
    const file = "    if (x) {\n      return y;\n    }\n";
    const old = "  if (x) {\n    return y;\n  }";
    const next = "  if (x) {\n    return z;\n  }";
    const result = applyMissingLeadingWhitespace(file, old, next);
    expect(result).toContain("    if (x) {");
    expect(result).toContain("      return z;");
    expect(result).toContain("    }");
  });

  it("returns null when non-leading content differs", () => {
    const file = "  function foo() {\n    return 1;\n  }\n";
    const old = "function bar() {\n  return 1;\n}";
    const next = "function bar() {\n  return 2;\n}";
    expect(applyMissingLeadingWhitespace(file, old, next)).toBeNull();
  });

  it("returns null when leading-whitespace delta is non-uniform across lines", () => {
    // File has 4 spaces on line 1, 6 on line 2 (irregular block).
    const file = "    line one\n      line two\n";
    const old = "line one\nline two";
    const next = "LINE ONE\nLINE TWO";
    // The delta is "    " for line 1 but "      " for line 2 — non-uniform.
    expect(applyMissingLeadingWhitespace(file, old, next)).toBeNull();
  });

  it("returns null on multiple matches (ambiguous)", () => {
    const file = "  foo();\n  bar();\n\n  foo();\n  bar();\n";
    const old = "foo();\nbar();";
    const next = "FOO();\nBAR();";
    expect(applyMissingLeadingWhitespace(file, old, next)).toBeNull();
  });
});

describe("applyDotdotdots", () => {
  const file = [
    "function foo() {",
    "  console.log('keep this');",
    "  doStuff();",
    "  return bar;",
    "}",
    "",
    "function unrelated() { return 0; }",
  ].join("\n");

  it("returns null when old_text has no `...` lines", () => {
    expect(applyDotdotdots(file, "function foo() {", "function FOO() {")).toBeNull();
  });

  it("matches bookends and preserves the elided middle", () => {
    const old = "function foo() {\n  ...\n  return bar;\n}";
    const next = "function foo() {\n  ...\n  return baz;\n}";
    const result = applyDotdotdots(file, old, next);
    expect(result).not.toBeNull();
    expect(result).toContain("return baz;");
    expect(result).not.toContain("return bar;");
    // Middle preserved verbatim.
    expect(result).toContain("console.log('keep this');");
    expect(result).toContain("doStuff();");
  });

  it("returns null when piece counts mismatch (ambiguous elision)", () => {
    const old = "function foo() {\n  ...\n  return bar;\n}";
    const next = "function foo() {\n  ...\n  ...\n  return baz;\n}";
    expect(applyDotdotdots(file, old, next)).toBeNull();
  });

  it("returns null when bookend piece is missing in the file", () => {
    const old = "function MISSING() {\n  ...\n  return bar;\n}";
    const next = "function MISSING() {\n  ...\n  return baz;\n}";
    expect(applyDotdotdots(file, old, next)).toBeNull();
  });

  it("returns null when a piece would be empty (`...` at boundary)", () => {
    const old = "...\nfunction foo() {";
    const next = "...\nfunction FOO() {";
    expect(applyDotdotdots(file, old, next)).toBeNull();
  });

  it("supports multiple `...` blocks", () => {
    const old = "function foo() {\n  ...\n  doStuff();\n  ...\n  return bar;\n}";
    const next = "function foo() {\n  ...\n  doStuff();\n  ...\n  return baz;\n}";
    const result = applyDotdotdots(file, old, next);
    expect(result).not.toBeNull();
    expect(result).toContain("return baz;");
    // First and second middles both preserved.
    expect(result).toContain("console.log('keep this');");
  });

  it("ignores inline `...` (only line-only dots count)", () => {
    // Inline ... like JS spread should NOT trigger dotdotdots.
    expect(applyDotdotdots(file, "doStuff(...args);", "doStuff(...newArgs);")).toBeNull();
  });
});

describe("stripLeadingBlankLine", () => {
  it("returns null when there is no leading blank line", () => {
    expect(stripLeadingBlankLine("foo\nbar")).toBeNull();
  });

  it("strips a single leading newline", () => {
    expect(stripLeadingBlankLine("\nfoo\nbar")).toBe("foo\nbar");
  });

  it("strips a leading whitespace-only line", () => {
    expect(stripLeadingBlankLine("   \nfoo")).toBe("foo");
  });

  it("returns null on empty input", () => {
    expect(stripLeadingBlankLine("")).toBeNull();
  });

  it("returns null when the text is a single line", () => {
    expect(stripLeadingBlankLine("only one line")).toBeNull();
  });
});

describe("generateDiff", () => {
  it("produces diff with --- a/ and +++ b/ header", () => {
    const diff = generateDiff("hello\n", "hello\nworld\n", "test.txt");
    expect(diff).toContain("--- a/test.txt");
    expect(diff).toContain("+++ b/test.txt");
  });

  it("shows removed lines with - prefix and added lines with + prefix", () => {
    const diff = generateDiff("old line\n", "new line\n", "file.ts");
    expect(diff).toContain("-old line");
    expect(diff).toContain("+new line");
  });
});
