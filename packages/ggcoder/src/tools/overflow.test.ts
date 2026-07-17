import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeOverflow, cleanupToolOutputs, getToolOutputRoot } from "./overflow.js";

let originalHome: string | undefined;
let tmpHome: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "overflow-home-"));
  process.env.HOME = tmpHome;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("writeOverflow", () => {
  it("writes full content under ~/.gg/tool-output/<yyyy-mm-dd>/", async () => {
    const content = "line one\nline two\nline three";
    const filePath = await writeOverflow(content, "bash");

    const day = new Date().toISOString().slice(0, 10);
    expect(filePath.startsWith(path.join(getToolOutputRoot(), day))).toBe(true);
    expect(path.basename(filePath)).toMatch(/^bash-[0-9a-f]{12}\.txt$/);
    expect(await fs.readFile(filePath, "utf-8")).toBe(content);
  });

  it("generates distinct paths for concurrent writes", async () => {
    const [a, b] = await Promise.all([writeOverflow("a", "read"), writeOverflow("b", "read")]);
    expect(a).not.toBe(b);
    expect(await fs.readFile(a, "utf-8")).toBe("a");
    expect(await fs.readFile(b, "utf-8")).toBe("b");
  });
});

describe("cleanupToolOutputs", () => {
  it("removes date folders older than the max age and keeps recent ones", async () => {
    const root = getToolOutputRoot();
    const oldDir = path.join(root, "2020-01-01");
    await fs.mkdir(oldDir, { recursive: true });
    await fs.writeFile(path.join(oldDir, "bash-stale.txt"), "stale");
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
    await fs.utimes(oldDir, old, old);

    const freshPath = await writeOverflow("fresh", "bash");

    await cleanupToolOutputs();

    await expect(fs.stat(oldDir)).rejects.toThrow();
    expect(await fs.readFile(freshPath, "utf-8")).toBe("fresh");
  });

  it("is a no-op when the tool-output folder does not exist", async () => {
    await expect(cleanupToolOutputs()).resolves.toBeUndefined();
  });

  it("ages non-date folders by mtime", async () => {
    const root = getToolOutputRoot();
    const weirdDir = path.join(root, "not-a-date");
    await fs.mkdir(weirdDir, { recursive: true });
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
    await fs.utimes(weirdDir, old, old);

    await cleanupToolOutputs();
    await expect(fs.stat(weirdDir)).rejects.toThrow();
  });
});
