import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mcpServersForAgent, parseAgentFile } from "./agents.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf-8");

/**
 * An allow-listed session (`allowedTools` set, i.e. every named agent) connects
 * MCP servers ONLY when they're named in `allowedMcpServers` — see
 * `AgentSession.connectMcpServers`. That whitelist has to survive the whole
 * spawn chain or a research agent silently falls back to training data:
 *
 *   agent frontmatter `tools:`
 *     → mcpServersForAgent()
 *     → subagent.ts `--mcp-servers` / subagent-manager `allowedMcpServers`
 *     → cli.ts | app-sidecar.ts parseArgs
 *     → runJsonMode / subagent worker
 *     → AgentSession
 *
 * These assertions pin each link so a future refactor can't quietly drop one.
 */
describe("agent MCP whitelist passthrough", () => {
  it("derives the whitelist from an agent that asks for an MCP server", () => {
    const agent = parseAgentFile(
      [
        "---",
        "name: prospector",
        "description: real-code researcher",
        "tools: read, grep, mcp__example-server__searchCode, mcp__example-server__discoverRepos",
        "---",
        "You find real code.",
      ].join("\n"),
      "global",
    );

    expect(agent.tools).toContain("mcp__example-server__searchCode");
    expect(mcpServersForAgent(agent.tools)).toEqual(["example-server"]);
  });

  it("the blocking subagent spawn forwards --mcp-servers", () => {
    const subagent = src("tools/subagent.ts");
    expect(subagent).toContain("mcpServersForAgent(agentDef.tools)");
    expect(subagent).toContain('cliArgs.push("--mcp-servers"');
  });

  it("both JSON-mode entry points parse --mcp-servers into allowedMcpServers", () => {
    for (const file of ["cli.ts", "app-sidecar/json-mode.ts"]) {
      const source = src(file);
      expect(source, file).toContain('"mcp-servers": { type: "string" }');
      expect(source, file).toContain("allowedMcpServers");
    }
  });

  it("json-mode hands allowedMcpServers to the AgentSession", () => {
    const jsonMode = src("modes/json-mode.ts");
    expect(jsonMode).toContain("allowedMcpServers?: string[]");
    expect(jsonMode).toContain("allowedMcpServers: options.allowedMcpServers");
  });

  it("the async spawn path sets allowedMcpServers alongside allowedTools", () => {
    const manager = src("core/subagent-manager.ts");
    const worker = src("modes/subagent-worker-mode.ts");
    // Both spawn call sites (initial spawn + resume) must set it.
    expect(manager.match(/allowedMcpServers:/g) ?? []).toHaveLength(2);
    expect(worker).toContain("allowedMcpServers?: string[]");
  });
});
