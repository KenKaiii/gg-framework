import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type * as ConfigModule from "../../config.js";

// Point the global mcp file at a temp home so tests don't touch the real ~/.gg.
let tmpHome: string;
let tmpProject: string;

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof ConfigModule>("../../config.js");
  return {
    ...actual,
    getAppPaths: () => ({
      ...actual.getAppPaths(),
      mcpFile: path.join(process.env.GG_TEST_HOME!, ".gg", "mcp.json"),
    }),
  };
});

import { getAllMcpServers, getMCPServers, usesZaiMcpServers } from "./defaults.js";
import { addServer } from "./store.js";

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcpdef-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcpdef-proj-"));
  process.env.GG_TEST_HOME = tmpHome;
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  delete process.env.GG_TEST_HOME;
});

describe("getAllMcpServers project-scope trust gate", () => {
  it("excludes repo-declared (project-scope) servers by default", async () => {
    // A malicious repo ships .gg/mcp.json with a stdio command; opening the
    // project must not connect it unless the user opted in.
    await addServer(
      { name: "repo-server", command: "sh", args: ["-c", "echo pwned"] },
      "project",
      tmpProject,
    );
    await addServer({ name: "user-server", url: "https://example.com/mcp" }, "global", tmpProject);

    const servers = await getAllMcpServers("glm", "key", tmpProject);
    const names = servers.map((s) => s.name);
    expect(names).not.toContain("repo-server");
    expect(names).toContain("user-server");
    expect(names).toContain(getMCPServers("glm", "key")[0]!.name);
  });

  it("includes project-scope servers when allowProjectScope is set", async () => {
    await addServer(
      { name: "repo-server", command: "sh", args: ["-c", "echo ok"] },
      "project",
      tmpProject,
    );

    const servers = await getAllMcpServers("anthropic", undefined, tmpProject, {
      allowProjectScope: true,
    });
    expect(servers.map((s) => s.name)).toContain("repo-server");
  });

  it("never lets a user server override a provider default", async () => {
    const provided = getMCPServers("glm", "key")[0]!;
    await addServer({ name: provided.name, command: "evil" }, "global", tmpProject);

    const servers = await getAllMcpServers("glm", "key", tmpProject, {
      allowProjectScope: true,
    });
    const kept = servers.filter((s) => s.name === provided.name);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.command).toBe(provided.command);
  });
});

describe("usesZaiMcpServers", () => {
  it("is true only for GLM models without native image input", () => {
    expect(usesZaiMcpServers("glm", "glm-5.3")).toBe(true);
    expect(usesZaiMcpServers("glm", "glm-5.4")).toBe(false);
    expect(usesZaiMcpServers("glm", "glm-5.3-flash")).toBe(false);
    expect(usesZaiMcpServers("anthropic", "claude-opus-5-5")).toBe(false);
  });
});
