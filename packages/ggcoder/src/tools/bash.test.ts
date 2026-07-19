import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool, renderBashOutput } from "./bash.js";
import { getToolOutputRoot } from "./overflow.js";
import { ProcessManager } from "../core/process-manager.js";

let originalHome: string | undefined;
let tmpHome: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "bash-output-home-"));
  process.env.HOME = tmpHome;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

async function listSavedOutputs(): Promise<string[]> {
  const root = getToolOutputRoot();
  try {
    const days = await fs.readdir(root);
    const files = await Promise.all(
      days.map(async (day) =>
        (await fs.readdir(path.join(root, day))).map((name) => path.join(root, day, name)),
      ),
    );
    return files.flat();
  } catch {
    return [];
  }
}

describe("renderBashOutput", () => {
  it("saves full output and returns a recovery pointer when output exceeds 50KB", async () => {
    const raw = Array.from(
      { length: 6_000 },
      (_, index) => `benchmark-line-${index.toString().padStart(5, "0")}: ${"x".repeat(40)}`,
    ).join("\n");

    const rendered = await renderBashOutput(raw);
    const saved = await listSavedOutputs();

    expect(saved).toHaveLength(1);
    expect(rendered).toContain(`Full output saved to ${saved[0]}`);
    expect(rendered).toContain("read it with offset/limit if needed");
    expect(await fs.readFile(saved[0], "utf-8")).toBe(raw);
    expect(rendered.length).toBeLessThan(raw.length);
  });

  it("does not create a pointer file for small output", async () => {
    const raw = "build passed\n12 tests passed";

    expect(await renderBashOutput(raw)).toBe(raw);
    expect(await listSavedOutputs()).toEqual([]);
  });

  it("does not offload line-count-only truncation below 50KB", async () => {
    const raw = Array.from({ length: 2_100 }, (_, index) => String(index)).join("\n");
    expect(Buffer.byteLength(raw, "utf-8")).toBeLessThan(50 * 1024);

    const rendered = await renderBashOutput(raw);

    expect(rendered).not.toContain("Full output saved");
    expect(await listSavedOutputs()).toEqual([]);
  });
});

describe("createBashTool shell snapshot", () => {
  it("describes cmd.exe semantics when resolution falls back to cmd", () => {
    const tool = createBashTool(tmpHome, new ProcessManager(), undefined, undefined, {
      platform: "win32",
      env: {},
      exists: () => false,
    });

    expect(tool.description).toContain("Windows cmd.exe");
    expect(tool.description).toContain("dir, findstr, type");
    expect(tool.description).toContain("will fail");
    expect(tool.description).not.toContain("Execute a bash command");
  });

  it("keeps the bash description byte-for-byte when a POSIX shell resolves", () => {
    const tool = createBashTool(tmpHome, new ProcessManager(), undefined, undefined, {
      platform: "darwin",
      env: {},
      exists: () => true,
    });

    expect(tool.description.startsWith("Execute a bash command.")).toBe(true);
    expect(tool.description).toContain("non-interactive bash shell with TERM=dumb");
    expect(tool.description).not.toContain("cmd.exe");
  });
});

describe("catastrophic-command guard", () => {
  it("refuses rm -rf / before any execution path runs", async () => {
    const processManager = new ProcessManager();
    const tool = createBashTool(tmpHome, processManager);

    const result = await tool.execute(
      { command: "rm -rf /" },
      { signal: new AbortController().signal, toolCallId: "guard-1" },
    );

    expect(String(result)).toContain("Refusing to run");
    expect(String(result)).toContain("user confirmation");
  });
});
