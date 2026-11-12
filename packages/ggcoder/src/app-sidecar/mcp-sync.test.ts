import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../core/agent-session.js";
import { addServer } from "../core/mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { effectiveMcpServer, syncMcpServerAcross } from "./mcp-sync.js";

let restoreHome: (() => void) | undefined;
let home: string;
let project: string;
let settingsFile: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-sync-home-"));
  project = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-sync-project-"));
  restoreHome = useFakeHome(home);
  settingsFile = path.join(home, "settings.json");
});

afterEach(async () => {
  restoreHome?.();
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(project, { recursive: true, force: true });
});

describe("effectiveMcpServer", () => {
  it("prefers the project entry, but only in a trusted project", async () => {
    await addServer({ name: "s", url: "https://global.dev/mcp" }, "global", project);
    await addServer({ name: "s", command: "npx", args: ["proj"] }, "project", project);

    // Untrusted: the project file is ignored entirely, including its override.
    expect(await effectiveMcpServer("s", project, settingsFile)).toBeUndefined();

    await fs.writeFile(settingsFile, JSON.stringify({ trustedProjects: [path.resolve(project)] }));
    expect(await effectiveMcpServer("s", project, settingsFile)).toMatchObject({
      command: "npx",
    });
    expect(await effectiveMcpServer("missing", project, settingsFile)).toBeUndefined();
  });
});

describe("syncMcpServerAcross", () => {
  it("applies the change to each session and survives one failing", async () => {
    await addServer({ name: "g", url: "https://g.dev/mcp" }, "global", project);
    const ok = { applyMcpServerChange: vi.fn(async () => null) };
    const bad = {
      applyMcpServerChange: vi.fn(async () => {
        throw new Error("nope");
      }),
    };
    const results = await syncMcpServerAcross(
      [
        { id: "a", cwd: project, session: ok as unknown as AgentSession },
        { id: "b", cwd: project, session: bad as unknown as AgentSession },
      ],
      "g",
      settingsFile,
    );
    expect(ok.applyMcpServerChange).toHaveBeenCalledWith(
      "g",
      expect.objectContaining({ url: "https://g.dev/mcp" }),
    );
    expect([...results]).toEqual([
      ["a", null],
      ["b", null],
    ]);
  });
});
