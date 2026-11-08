import { describe, expect, it } from "vitest";
import { buildToolLineParts, safetyBlockSummary } from "./tool-format";

// Guards return their block as the tool's text, so isError is false (as live).
const block = (command: string, result: string) =>
  buildToolLineParts("bash", { command }, { done: true, isError: false, result });

describe("safety blocks on the step line", () => {
  it("leads with the block and its plain reason; the command trails, dimmed", () => {
    const parts = block(
      "npm install chalk@5.6.1",
      "Error: Blocked install (malicious-package): chalk@5.6.1 is flagged as malware (MAL-2025-46969); use chalk@5.6.0.",
    );
    expect(parts).toEqual([
      { text: "Blocked for safety", bold: true, warn: true },
      { text: " \u00b7 known malware", warn: true },
      { text: " \u00b7 npm install chalk@5.6.1", dim: true },
    ]);
  });

  it("covers shell and action checks; an unknown rule still reads as a safety block", () => {
    expect(safetyBlockSummary("Blocked by shell safety check (dns-exfil): ping …")).toBe(
      "would leak data",
    );
    expect(safetyBlockSummary("Blocked by action safety check (auto-run-config): …")).toBe(
      "turns on auto-run",
    );
    expect(safetyBlockSummary("Blocked by shell safety check (new-rule): …")).toBe("safety rule");
  });

  it("ordinary failures and the network allowlist keep the normal line", () => {
    expect(safetyBlockSummary("Exit code: 1")).toBeNull();
    expect(safetyBlockSummary("Blocked by the network allowlist: example.com")).toBeNull();
    const parts = buildToolLineParts(
      "bash",
      { command: "tsc" },
      { done: true, isError: true, result: "src/a.ts(1,1): error TS2304" },
    );
    expect(parts[0]?.text).toBe("Ran");
    expect(parts.some((p) => p.warn)).toBe(false);
  });
});
