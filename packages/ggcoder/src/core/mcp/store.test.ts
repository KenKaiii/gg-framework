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

import {
  addServer,
  loadServers,
  removeServer,
  getServer,
  fromStoredEntry,
  toStoredEntry,
  globalMcpPath,
  projectMcpPath,
} from "./store.js";

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-proj-"));
  process.env.GG_TEST_HOME = tmpHome;
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  delete process.env.GG_TEST_HOME;
});

describe("mcp store", () => {
  it("round-trips an http server in global scope", async () => {
    const res = await addServer(
      { name: "notion", url: "https://mcp.notion.com/mcp" },
      "global",
      tmpProject,
    );
    expect(res.ok).toBe(true);

    const servers = await loadServers(tmpProject);
    expect(servers).toEqual([
      {
        config: { name: "notion", url: "https://mcp.notion.com/mcp", transport: "http" },
        scope: "global",
      },
    ]);

    // On-disk shape uses Claude's `type` field.
    const raw = JSON.parse(await fs.readFile(globalMcpPath(), "utf-8"));
    expect(raw.mcpServers.notion.type).toBe("http");
  });

  it("round-trips a stdio server with env in project scope", async () => {
    await addServer(
      {
        name: "airtable",
        command: "npx",
        args: ["-y", "airtable-mcp-server"],
        env: { AIRTABLE_API_KEY: "key" },
      },
      "project",
      tmpProject,
    );

    const servers = await loadServers(tmpProject);
    expect(servers[0]).toEqual({
      config: {
        name: "airtable",
        command: "npx",
        args: ["-y", "airtable-mcp-server"],
        env: { AIRTABLE_API_KEY: "key" },
      },
      scope: "project",
    });
    // Project file lives at ./.gg/mcp.json.
    await fs.access(projectMcpPath(tmpProject));
  });

  it("project overrides global on name collision", async () => {
    await addServer({ name: "dup", url: "https://global.example/mcp" }, "global", tmpProject);
    await addServer({ name: "dup", url: "https://project.example/mcp" }, "project", tmpProject);

    const servers = await loadServers(tmpProject);
    expect(servers).toHaveLength(1);
    expect(servers[0].scope).toBe("project");
    expect(servers[0].config.url).toBe("https://project.example/mcp");
  });

  it("rejects duplicate name in the same scope unless overwrite", async () => {
    await addServer({ name: "x", url: "https://a.example/mcp" }, "global", tmpProject);
    const dup = await addServer({ name: "x", url: "https://b.example/mcp" }, "global", tmpProject);
    expect(dup.ok).toBe(false);

    const ow = await addServer(
      { name: "x", url: "https://b.example/mcp" },
      "global",
      tmpProject,
      true,
    );
    expect(ow.ok).toBe(true);
    const found = await getServer("x", tmpProject);
    expect(found?.config.url).toBe("https://b.example/mcp");
  });

  it("removes a server", async () => {
    await addServer({ name: "gone", url: "https://x.example/mcp" }, "global", tmpProject);
    expect(await removeServer("gone", "global", tmpProject)).toBe(true);
    expect(await removeServer("gone", "global", tmpProject)).toBe(false);
    expect(await loadServers(tmpProject)).toEqual([]);
  });

  it("tolerates a malformed config file", async () => {
    await fs.mkdir(path.dirname(globalMcpPath()), { recursive: true });
    await fs.writeFile(globalMcpPath(), "{ not valid json", "utf-8");
    expect(await loadServers(tmpProject)).toEqual([]);
  });

  it("round-trips Claude's oauth field on http servers", () => {
    const config = fromStoredEntry("o", {
      type: "http",
      url: "https://o.dev/mcp",
      oauth: { clientId: "cid", callbackPort: 8080 },
    });
    expect(config.oauth).toEqual({ clientId: "cid", callbackPort: 8080 });
    expect(toStoredEntry(config)).toMatchObject({ oauth: { clientId: "cid", callbackPort: 8080 } });
  });

  it("parses Claude's .mcp.json type field for http and sse", () => {
    expect(fromStoredEntry("n", { type: "http", url: "https://x/mcp" })).toEqual({
      name: "n",
      url: "https://x/mcp",
      transport: "http",
    });
    expect(
      fromStoredEntry("s", {
        type: "sse",
        url: "https://x/sse",
        headers: { Authorization: "Bearer t" },
      }),
    ).toEqual({
      name: "s",
      url: "https://x/sse",
      headers: { Authorization: "Bearer t" },
      transport: "sse",
    });
  });
});
