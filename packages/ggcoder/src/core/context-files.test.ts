import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withContextFiles } from "./context-files.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "context-files-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("withContextFiles", () => {
  it("leaves a brief without files unchanged", async () => {
    expect(await withContextFiles("Do it.", [], dir)).toBe("Do it.");
  });

  it("hands over files the parent read, so the child doesn't read them again", async () => {
    // Live goal runs: Kleio Goals read every file to plan, then each worker read
    // them all again before it could start.
    await fs.writeFile(path.join(dir, "a.js"), "const a = 1;\n");
    const brief = await withContextFiles("Fix a.", ["a.js"], dir);
    expect(brief.startsWith("Fix a.")).toBe(true);
    expect(brief).toContain(`### ${path.join(dir, "a.js")}\n\`\`\`\nconst a = 1;\n\`\`\``);
  });

  it("names a missing or binary file instead of failing, and cuts long ones", async () => {
    await fs.writeFile(path.join(dir, "bin"), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(dir, "big.txt"), "x".repeat(30_000));
    const brief = await withContextFiles("T", ["gone.txt", "bin", "big.txt"], dir);
    expect(brief).toContain("gone.txt\n(not included: couldn't be read)");
    expect(brief).toContain("bin\n(not included: binary file)");
    expect(brief).toContain("(first 24000 of 30000 characters");
    expect(brief.length).toBeLessThan(26_000);
  });
});
