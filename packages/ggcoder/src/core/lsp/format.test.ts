import { describe, it, expect } from "vitest";
import { formatDiagnostics } from "./format.js";
import type { LspDiagnostic } from "./client.js";

function diag(overrides: Partial<LspDiagnostic> & { message: string }): LspDiagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 1,
    ...overrides,
  };
}

describe("formatDiagnostics", () => {
  it("returns empty string for a clean file", () => {
    expect(formatDiagnostics("src/a.ts", [])).toBe("");
  });

  it("filters out warnings, info, and hints", () => {
    const diagnostics = [
      diag({ message: "warn", severity: 2 }),
      diag({ message: "info", severity: 3 }),
      diag({ message: "hint", severity: 4 }),
    ];
    expect(formatDiagnostics("src/a.ts", diagnostics)).toBe("");
  });

  it("renders errors with 1-based line:column, message, and source", () => {
    const diagnostics = [
      diag({
        message: "Type 'string' is not assignable to type 'number'.",
        range: { start: { line: 41, character: 6 }, end: { line: 41, character: 10 } },
        source: "typescript",
      }),
    ];

    const result = formatDiagnostics("src/a.ts", diagnostics);

    expect(result).toContain(
      "Diagnostics in src/a.ts (informational — may resolve after related edits):",
    );
    expect(result).toContain(
      "L42:7 Type 'string' is not assignable to type 'number'. (typescript)",
    );
    expect(result.startsWith("\n\n")).toBe(true);
  });

  it("treats missing severity as an error", () => {
    const result = formatDiagnostics("a.py", [diag({ message: "boom", severity: undefined })]);
    expect(result).toContain("L1:1 boom");
  });

  it("keeps only the first line of multi-line messages", () => {
    const result = formatDiagnostics("a.rs", [diag({ message: "first line\nsecond line" })]);
    expect(result).toContain("first line");
    expect(result).not.toContain("second line");
  });

  it("caps output at 5 errors and reports the overflow count", () => {
    const diagnostics = Array.from({ length: 8 }, (_, i) => diag({ message: `error ${i}` }));

    const result = formatDiagnostics("src/a.ts", diagnostics);

    expect(result).toContain("error 4");
    expect(result).not.toContain("error 5");
    expect(result).toContain("…and 3 more errors");
  });

  it("uses singular overflow wording for exactly one extra error", () => {
    const diagnostics = Array.from({ length: 6 }, (_, i) => diag({ message: `error ${i}` }));
    expect(formatDiagnostics("src/a.ts", diagnostics)).toContain("…and 1 more error");
  });
});
