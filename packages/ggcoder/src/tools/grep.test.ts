import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGrepTool } from "./grep.js";

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

    expect(result).toContain("a.txt:1:needle");
    expect(result).not.toContain("z.txt:1:needle");
    expect(result).toContain("[Truncated at 1 matches]");
  });

  it("accepts a leading (?i) as a case-insensitive regex flag", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-inline-flag-"));
    await fs.writeFile(path.join(tmpDir, "deploy.txt"), "Deploy to Railway\n");

    const result = await createGrepTool(tmpDir).execute(
      { pattern: "(?i)deploy|railway", include: "*.txt" },
      context(),
    );

    expect(result).toContain("deploy.txt:1:Deploy to Railway");
  });
});
