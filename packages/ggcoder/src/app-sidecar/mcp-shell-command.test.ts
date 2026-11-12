import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadServers } from "../core/mcp/index.js";
import {
  isMcpShellCommand,
  maskMcpCommand,
  runMcpShellCommand,
  type McpShellDeps,
} from "./mcp-shell-command.js";
import { stripStderrMarks } from "./shell-runs.js";

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-shell-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

function deps(over: Partial<McpShellDeps> = {}): McpShellDeps {
  return {
    cwd,
    listRows: vi.fn(async () => []),
    probe: vi.fn(async () => ({ ok: true, toolCount: 3 })),
    clearOAuth: vi.fn(async () => {}),
    trustProject: vi.fn(async () => {}),
    onAdded: vi.fn(),
    saveOAuthClient: vi.fn(async () => {}),
    sync: vi.fn(async (name: string) => ({
      here: { name, removed: false, connected: true, toolCount: 3 },
      others: 1,
    })),
    ...over,
  };
}

describe("isMcpShellCommand", () => {
  it("matches claude/ggcoder mcp lines only", () => {
    expect(isMcpShellCommand("claude mcp add x -- npx y")).toBe(true);
    expect(isMcpShellCommand("ggcoder mcp list")).toBe(true);
    expect(isMcpShellCommand("claude mcp")).toBe(true);
    expect(isMcpShellCommand("claude --version")).toBe(false);
    expect(isMcpShellCommand("command claude mcp list")).toBe(false);
    expect(isMcpShellCommand("claude mcpx")).toBe(false);
  });
});

describe("runMcpShellCommand", () => {
  it("adds a server to this project, then lists and removes it", async () => {
    const d = deps();
    const added = await runMcpShellCommand("claude mcp add airtable -- npx -y airtable-mcp", d);
    expect(added.exitCode).toBe(0);
    expect(added.output).toContain('Added "airtable" to project scope');
    expect(added.output).toContain("3 tools, loaded into this session");
    expect(added.output).toContain("Also loaded in 1 other open window");
    expect(d.sync).toHaveBeenCalledWith("airtable");
    expect(d.trustProject).toHaveBeenCalledWith(cwd);
    expect(d.onAdded).toHaveBeenCalled();
    const saved = await loadServers(cwd);
    expect(saved.find((s) => s.config.name === "airtable")).toMatchObject({
      scope: "project",
      config: { command: "npx", args: ["-y", "airtable-mcp"] },
    });

    const again = await runMcpShellCommand("claude mcp add airtable -- npx other", d);
    expect(again.exitCode).toBe(1);

    const removed = await runMcpShellCommand("claude mcp remove airtable", d);
    expect(removed.exitCode).toBe(0);
    expect(d.sync).toHaveBeenLastCalledWith("airtable");
    expect(d.clearOAuth).toHaveBeenCalledWith("airtable");
    expect((await loadServers(cwd)).some((s) => s.config.name === "airtable")).toBe(false);
  });

  it("probes instead when this window doesn't load MCP", async () => {
    const d = deps({ sync: vi.fn(async () => ({ here: null, others: 0 })) });
    const out = await runMcpShellCommand("claude mcp add s -- npx s", d);
    expect(d.probe).toHaveBeenCalled();
    expect(out.output).toContain("Connected — 3 tools.");
    expect(out.output).not.toContain("loaded into this session");
  });

  it("saves a server that fails to connect and says so", async () => {
    const d = deps({
      sync: vi.fn(async (name: string) => ({
        here: { name, removed: false, connected: false, toolCount: 0, error: "boom" },
        others: 0,
      })),
    });
    const out = await runMcpShellCommand("ggcoder mcp add --transport http n https://x.dev/mcp", d);
    expect(out.exitCode).toBe(0);
    expect(stripStderrMarks(out.output)).toContain("Could not connect: boom");
  });

  it("reports parse errors, unknown servers and subcommands as failures", async () => {
    const d = deps();
    expect((await runMcpShellCommand("claude mcp add 'bad name' -- x", d)).exitCode).toBe(1);
    expect((await runMcpShellCommand("claude mcp remove nope", d)).exitCode).toBe(1);
    expect((await runMcpShellCommand("claude mcp get nope", d)).exitCode).toBe(1);
    expect((await runMcpShellCommand("claude mcp serve", d)).exitCode).toBe(1);
    expect((await runMcpShellCommand("claude mcp", d)).output).toContain("claude mcp add");
  });

  it("hides header and env values in get output", async () => {
    const d = deps();
    await runMcpShellCommand(
      'claude mcp add -t http api https://x.dev/mcp -H "Authorization: Bearer supersecrettoken"',
      d,
    );
    const out = await runMcpShellCommand("claude mcp get api", d);
    expect(out.output).toContain("https://x.dev/mcp");
    expect(out.output).not.toContain("supersecrettoken");
  });
});

describe("pasted Claude Code lines", () => {
  it("recognises a pasted $ prompt and a leading VAR=value", () => {
    expect(isMcpShellCommand("$ claude mcp add c -- npx c")).toBe(true);
    expect(isMcpShellCommand("MCP_CLIENT_SECRET=s claude mcp add x https://x.dev/mcp")).toBe(true);
    expect(isMcpShellCommand("FOO=1 git status")).toBe(false);
  });

  it("adds from add-json and keeps a pre-registered OAuth client", async () => {
    const d = deps();
    const json = await runMcpShellCommand(
      `claude mcp add-json weather '{"type":"http","url":"https://w.dev/mcp"}'`,
      d,
    );
    expect(json.exitCode).toBe(0);
    const oauth = await runMcpShellCommand(
      "MCP_CLIENT_SECRET=shh claude mcp add --client-id cid --client-secret --callback-port 8080 --transport http o https://o.dev/mcp",
      d,
    );
    expect(oauth.exitCode).toBe(0);
    expect(d.saveOAuthClient).toHaveBeenCalledWith("o", "cid", "shh");
    const saved = await loadServers(cwd);
    expect(saved.find((s) => s.config.name === "weather")?.config.url).toBe("https://w.dev/mcp");
    // The secret stays out of the project's mcp.json.
    expect(saved.find((s) => s.config.name === "o")?.config.oauth).toEqual({
      clientId: "cid",
      callbackPort: 8080,
    });
    const file = await fs.readFile(path.join(cwd, ".gg", "mcp.json"), "utf8");
    expect(file).not.toContain("shh");
  });
});

describe("maskMcpCommand", () => {
  it("hides the client secret and add-json header values", () => {
    expect(
      maskMcpCommand(
        "MCP_CLIENT_SECRET=topsecret1 claude mcp add --client-id c --client-secret --transport http o https://o.dev/mcp",
      ),
    ).not.toContain("topsecret1");
    expect(
      maskMcpCommand(
        `claude mcp add-json w '{"url":"https://w.dev","headers":{"X-Key":"k3y-value"}}'`,
      ),
    ).not.toContain("k3y-value");
  });

  it("hides --env and --header values but not the server's own args", () => {
    const masked = maskMcpCommand(
      'claude mcp add -e API_KEY=abc123xyz -H "X-Token: tok999" s -- npx -e keep=me',
    );
    expect(masked).not.toContain("abc123xyz");
    expect(masked).not.toContain("tok999");
    expect(masked).toContain("API_KEY=");
    expect(masked).toContain("keep=me");
  });
});
