import { describe, expect, it } from "vitest";
import { parseMcpAddCommand } from "./parse-add-command.js";

describe("parseMcpAddCommand", () => {
  it("parses an http server (Notion docs example)", () => {
    const r = parseMcpAddCommand("--transport http notion https://mcp.notion.com/mcp");
    expect(r).toEqual({
      ok: true,
      value: {
        config: { name: "notion", url: "https://mcp.notion.com/mcp", transport: "http" },
      },
    });
  });

  it("parses an sse server (Asana docs example)", () => {
    const r = parseMcpAddCommand("--transport sse asana https://mcp.asana.com/sse");
    expect(r.ok && r.value.config).toEqual({
      name: "asana",
      url: "https://mcp.asana.com/sse",
      transport: "sse",
    });
  });

  it("parses a stdio server with --env (Airtable docs example)", () => {
    const r = parseMcpAddCommand(
      "--env AIRTABLE_API_KEY=key airtable -- npx -y airtable-mcp-server",
    );
    expect(r.ok && r.value.config).toEqual({
      name: "airtable",
      command: "npx",
      args: ["-y", "airtable-mcp-server"],
      env: { AIRTABLE_API_KEY: "key" },
    });
  });

  it("parses a bearer --header", () => {
    const r = parseMcpAddCommand(
      '--transport http api https://api.example/mcp --header "Authorization: Bearer tok"',
    );
    expect(r.ok && r.value.config.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("strips a `claude mcp add` prefix", () => {
    const r = parseMcpAddCommand(
      "claude mcp add --transport http notion https://mcp.notion.com/mcp",
    );
    expect(r.ok && r.value.config.name).toBe("notion");
  });

  it("strips a `ggcoder mcp add` prefix", () => {
    const r = parseMcpAddCommand("ggcoder mcp add foo -- node server.js");
    expect(r.ok && r.value.config).toEqual({
      name: "foo",
      command: "node",
      args: ["server.js"],
    });
  });

  it("handles quoted args", () => {
    const r = parseMcpAddCommand('foo -- node "my server.js" --flag "a b"');
    expect(r.ok && r.value.config.args).toEqual(["my server.js", "--flag", "a b"]);
  });

  it("maps --scope user to global and project to project", () => {
    const u = parseMcpAddCommand("--scope user --transport http n https://x/mcp");
    expect(u.ok && u.value.scope).toBe("global");
    const p = parseMcpAddCommand("--scope project --transport http n https://x/mcp");
    expect(p.ok && p.value.scope).toBe("project");
  });

  it("defaults stdio when a command follows --", () => {
    const r = parseMcpAddCommand("local -- ./bin/server");
    expect(r.ok && r.value.config.command).toBe("./bin/server");
  });

  it("errors on missing name", () => {
    const r = parseMcpAddCommand("--transport http");
    expect(r.ok).toBe(false);
  });

  it("errors when http transport has no url", () => {
    const r = parseMcpAddCommand("--transport http notion");
    expect(r.ok).toBe(false);
  });

  it("errors when stdio has no command", () => {
    const r = parseMcpAddCommand("notion");
    expect(r.ok).toBe(false);
  });

  it("rejects websocket transport", () => {
    const r = parseMcpAddCommand("--transport ws notion ws://x");
    expect(r).toEqual({ ok: false, error: "WebSocket transport isn't supported yet." });
  });

  it("rejects an unsafe name", () => {
    const r = parseMcpAddCommand("bad/name -- node x.js");
    expect(r.ok).toBe(false);
  });
});

describe("pasted Claude Code lines", () => {
  it("treats `add <name> <command> [args…]` without `--` as stdio (Playwright README)", () => {
    const r = parseMcpAddCommand("claude mcp add playwright npx @playwright/mcp@latest");
    expect(r.ok && r.value.config).toEqual({
      name: "playwright",
      command: "npx",
      args: ["@playwright/mcp@latest"],
    });
    // The server's own flags pass through untouched.
    const flags = parseMcpAddCommand("claude mcp add -s user ctx npx -y @upstash/context7-mcp");
    expect(flags.ok && flags.value).toEqual({
      config: { name: "ctx", command: "npx", args: ["-y", "@upstash/context7-mcp"] },
      scope: "global",
    });
    // A URL without --transport is still a remote server.
    const url = parseMcpAddCommand("claude mcp add notion https://mcp.notion.com/mcp");
    expect(url.ok && url.value.config.url).toBe("https://mcp.notion.com/mcp");
  });

  it("drops a pasted $ prompt and joins \\-continued lines", () => {
    const r = parseMcpAddCommand(
      "$ claude mcp add ctx \\\n  -- npx -y \\\r\n  @upstash/context7-mcp",
    );
    expect(r.ok && r.value.config).toEqual({
      name: "ctx",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    });
  });

  it("parses add-json for http and stdio servers", () => {
    const http = parseMcpAddCommand(
      `claude mcp add-json weather '{"type":"http","url":"https://w.dev/mcp","headers":{"Authorization":"Bearer t"}}' -s user`,
    );
    expect(http.ok && http.value).toEqual({
      config: {
        name: "weather",
        url: "https://w.dev/mcp",
        transport: "http",
        headers: { Authorization: "Bearer t" },
      },
      scope: "global",
    });
    const stdio = parseMcpAddCommand(
      `claude mcp add-json gh '{"command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"TOKEN":"x"}}'`,
    );
    expect(stdio.ok && stdio.value.config).toEqual({
      name: "gh",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { TOKEN: "x" },
    });
  });

  it("rejects bad add-json input with a clear reason", () => {
    expect(parseMcpAddCommand(`claude mcp add-json w '{nope'`)).toMatchObject({ ok: false });
    expect(parseMcpAddCommand(`claude mcp add-json w '{"args":[]}'`)).toMatchObject({
      ok: false,
      error: expect.stringContaining('"command"'),
    });
    expect(parseMcpAddCommand(`claude mcp add-json w {"a": 1}`)).toMatchObject({
      ok: false,
      error: expect.stringContaining("single quotes"),
    });
  });

  it("keeps OAuth client options, taking the secret from MCP_CLIENT_SECRET", () => {
    const r = parseMcpAddCommand(
      "MCP_CLIENT_SECRET=shh claude mcp add --client-id cid --client-secret --callback-port 8080 --transport http s https://s.dev/mcp",
    );
    expect(r.ok && r.value).toEqual({
      config: {
        name: "s",
        url: "https://s.dev/mcp",
        transport: "http",
        oauth: { clientId: "cid", callbackPort: 8080 },
      },
      clientSecret: "shh",
    });
    expect(
      parseMcpAddCommand("claude mcp add --client-id c --client-secret -t http s https://s.dev"),
    ).toMatchObject({ ok: false, error: expect.stringContaining("MCP_CLIENT_SECRET=") });
    expect(
      parseMcpAddCommand("claude mcp add --callback-port 99999 -t http s https://s.dev"),
    ).toMatchObject({ ok: false });
  });
});
