import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { detectChecklist } from "./checklist-detection.js";
import { readChecklistSnapshot } from "./checklist-snapshot.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-checklist-detect-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function put(relative: string, content = ""): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

describe("checklist setup detection", () => {
  it("recognizes an initialized Git repository before its first commit, without recording a pass", async () => {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    await put(".gitignore", "node_modules\n");
    const result = await readChecklistSnapshot(root, new Date());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(23);
    expect(result.value.items.find((item) => item.id === "git-github")).toMatchObject({
      status: "not-run",
      checkedAt: null,
      result: null,
      detection: {
        summary: "Git initialized",
        facts: [".gitignore found", "Git repository initialized"],
      },
    });
    expect((await fs.readdir(root)).sort()).toEqual([".git", ".gitignore"]);
  });

  it("finds existing local setup without executing scripts or configuration", async () => {
    await put("AGENTS.md");
    await put("README.md");
    await put("LICENSE");
    await put("CONTEXT.md");
    await put("pnpm-lock.yaml");
    await put(".github/workflows/ci.yml", "unparsed workflow");
    await put(".gg/commands/commit.md");
    await put("eslint.config.js", "throw new Error('must not be imported');");
    await put(
      "packages/web/package.json",
      JSON.stringify({
        scripts: { lint: "do-not-run", test: "do-not-run", build: "do-not-run" },
        devDependencies: { prettier: "3", vitest: "4" },
      }),
    );
    const result = await detectChecklist(root);
    expect(result.items["agent-setup"]?.summary).toBe("Agent instructions found");
    expect(result.items.docs?.facts).toEqual(["Licence file found", "README found"]);
    expect(result.items["quality-tools"]?.facts).toContain("Lint configuration found");
    expect(result.items.tests?.facts).toContain("Test script found");
    expect(result.items.ci?.facts).toEqual(["GitHub workflow files found"]);
    expect(result.items["commit-gate"]).toBeDefined();
    expect(result.items.dependencies).toBeDefined();
    expect(result.items["build-release"]?.facts).toContain("Build script found");
    expect(result.items.security).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("do-not-run");
  });

  it("ignores symlinked package directories outside the project", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gg-checklist-outside-"));
    try {
      await fs.mkdir(path.join(outside, "private-package"));
      await fs.writeFile(
        path.join(outside, "private-package", "package.json"),
        JSON.stringify({ scripts: { test: "private-command" } }),
      );
      // Directory junctions also work without symlink privileges on Windows CI.
      await fs.symlink(outside, path.join(root, "packages"), "junction");
      const result = await detectChecklist(root);
      expect(result.items.tests).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("private-command");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it.each(["{not-json", "x".repeat(256 * 1024 + 1)])(
    "bounds and handles malformed manifests",
    async (content) => {
      await put("package.json", content);
      const result = await detectChecklist(root);
      expect(result.items.tests).toBeUndefined();
      expect(result.warnings.length).toBeGreaterThan(0);
    },
  );

  it("does not turn missing or unsupported setup into a failed audit", async () => {
    const result = await readChecklistSnapshot(root, new Date());
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(
        result.value.items.every((item) => item.status === "not-run" && item.detection === null),
      ).toBe(true);
  });

  it("retains recorded findings alongside automatic setup facts", async () => {
    await put("package.json", JSON.stringify({ scripts: { test: "vitest" } }));
    const now = new Date();
    await put(
      ".gg-checklist.json",
      JSON.stringify({
        version: 1,
        items: {
          tests: {
            checkedAt: now.toISOString(),
            commit: null,
            uncommittedChanges: false,
            result: "issues",
            summary: "A test failed",
            findings: ["test.ts:1"],
            evidence: ["Scope: app tests", "Not checked: deployment"],
          },
        },
      }),
    );
    const result = await readChecklistSnapshot(root, now);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.items.find((item) => item.id === "tests")).toMatchObject({
        status: "needs-work",
        findings: ["test.ts:1"],
        detection: { summary: "Test setup found" },
      });
  });
});
