import { describe, expect, it } from "vitest";
import type { ProjectHealthScan } from "./project-health-scan.js";
import { scoreProjectHealth } from "./project-health-score.js";

const clean: ProjectHealthScan = {
  truncated: false,
  sourceFiles: 40,
  sourceLines: 10_000,
  oversized: [],
  oversizedCount: 0,
  hotspotCount: 0,
  oversizedWeightedExcess: 0,
  secretFiles: [],
  largeFiles: [],
  largeFileCount: 0,
  hasGitignore: true,
  missingLockfile: false,
  hasTests: true,
  hasLint: true,
  hasFormat: true,
  hasTypecheck: true,
  hasCIWorkflow: true,
  debt: { todos: 0, suppressions: 0, anyTypes: 0, lines: 10_000 },
};

function category(scan: ProjectHealthScan, id: string) {
  return scoreProjectHealth(scan, null)?.categories.find((entry) => entry.id === id);
}

describe("scoreProjectHealth", () => {
  it("scores a clean project 100 from the four scanned categories", () => {
    const health = scoreProjectHealth(clean, null);
    expect(health?.score).toBe(100);
    expect(health?.categories.map((entry) => entry.id)).toEqual([
      "files",
      "hygiene",
      "safety",
      "debt",
    ]);
  });

  it("leaves file size and debt out when there are no source files", () => {
    const empty = {
      ...clean,
      sourceLines: 0,
      debt: { ...clean.debt, lines: 0 },
    };
    const health = scoreProjectHealth(empty, null);
    expect(health?.score).toBe(100);
    expect(
      health?.categories.filter((entry) => entry.score === null).map((entry) => entry.id),
    ).toEqual(["files", "debt"]);
  });

  it("penalizes oversized files by the share of code beyond the limit", () => {
    const files = category(
      {
        ...clean,
        oversized: [
          { path: "src/App.tsx", lines: 1800, changes: 9 },
          { path: "src/old.ts", lines: 900, changes: 0 },
        ],
        oversizedCount: 2,
        hotspotCount: 1,
        oversizedWeightedExcess: 2000,
      },
      "files",
    );
    expect(files).toMatchObject({
      score: 50,
      summary: "2 files over 800 lines, 1 changing often",
      findings: [
        "src/App.tsx · 1,800 lines, 9 changes",
        "src/old.ts · 900 lines, untouched lately",
      ],
    });
    expect(files?.fixPrompt).toContain('"src/App.tsx · 1,800 lines, 9 changes"');
  });

  it("holds the score red for a committed secret, whatever else is fine", () => {
    const health = scoreProjectHealth(
      { ...clean, secretFiles: [{ path: ".env", tracked: true, found: null, line: null }] },
      null,
    );
    expect(health).toMatchObject({ score: 40, cappedBy: "1 secret is committed" });
    // A key inside a source file caps the same way, and says where (never what).
    const inline = scoreProjectHealth(
      {
        ...clean,
        secretFiles: [{ path: "src/config.ts", tracked: true, found: "GitHub token", line: 12 }],
      },
      null,
    );
    expect(inline).toMatchObject({ score: 40, cappedBy: "1 secret is committed" });
    expect(inline?.categories.find((entry) => entry.id === "hygiene")?.findings).toEqual([
      "src/config.ts:12 · GitHub token, committed",
    ]);
    // Not ignored isn't committed: it lowers hygiene but doesn't cap.
    const unignored = scoreProjectHealth(
      { ...clean, secretFiles: [{ path: ".env", tracked: false, found: null, line: null }] },
      null,
    );
    expect(unignored?.cappedBy).toBeNull();
  });

  it("asks the agent to review, then ask before fixing, and quotes findings as data", () => {
    const health = scoreProjectHealth(
      { ...clean, debt: { todos: 20, suppressions: 0, anyTypes: 0, lines: 10_000 } },
      null,
    );
    const prompt = health?.fixPrompt ?? "";
    expect(prompt).toContain("Do not edit, create, delete, install or commit anything");
    expect(prompt).toContain("`ask_user`");
    expect(prompt).toContain("### Debt markers");
    // The agent learns what the score already ignores, so it doesn't re-flag it.
    expect(prompt).toContain("already leaves out tests and check/smoke/e2e scripts");
    expect(prompt).toContain('- "20 TODO/FIXME/HACK comments"');
    // Clean categories aren't sent.
    expect(prompt).not.toContain("### File size");
    expect(health?.categories.find((entry) => entry.id === "files")?.fixPrompt).toBeNull();
    expect(scoreProjectHealth(clean, null)?.fixPrompt).toBeNull();
  });

  it("puts a committed secret first and costs more than an unignored one", () => {
    const hygiene = category(
      {
        ...clean,
        secretFiles: [
          { path: ".env", tracked: true, found: null, line: null },
          { path: "id_rsa", tracked: false, found: null, line: null },
        ],
        largeFiles: [{ path: "video.mp4", bytes: 12 * 1024 * 1024 }],
        largeFileCount: 1,
      },
      "hygiene",
    );
    expect(hygiene?.score).toBe(30);
    expect(hygiene?.findings).toEqual([
      ".env looks like a secret and is committed",
      "id_rsa looks like a secret and isn't ignored",
      "video.mp4 · 12.0 MB, not in Git LFS",
    ]);
  });

  it("counts a failing CI run only when the project has a workflow", () => {
    const failed = {
      key: "k",
      url: "https://github.com/o/r/actions/runs/1",
      total: 2,
      completed: 2,
      failed: 1,
      active: false,
      conclusion: "failure" as const,
    };
    const withCIHealth = scoreProjectHealth(clean, failed);
    const withCI = withCIHealth?.categories.find((c) => c.id === "safety");
    expect(withCI).toMatchObject({ score: 90, findings: ["Latest CI run failed"] });
    // Everything else is clean, but a broken main branch can't read green.
    expect(withCIHealth).toMatchObject({ score: 70, cappedBy: "The latest CI run failed" });
    const noWorkflow = scoreProjectHealth({ ...clean, hasCIWorkflow: false }, failed);
    expect(noWorkflow?.cappedBy).toBeNull();
    const stale = scoreProjectHealth(clean, { ...failed, stale: true });
    expect(stale?.score).toBe(100);
  });

  it("weights debt by density", () => {
    const debt = category(
      { ...clean, debt: { todos: 20, suppressions: 5, anyTypes: 0, lines: 10_000 } },
      "debt",
    );
    expect(debt).toMatchObject({ score: 80, summary: "2.5 per 1,000 lines (25 markers)" });
  });
});
