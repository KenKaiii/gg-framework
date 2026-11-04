import { parseArgs } from "node:util";
import { runJsonMode } from "../modes/json-mode.js";
import type { Provider } from "@kleio/ai";
import { parseThinkingLevel } from "../cli/thinking-arg.js";

/**
 * Sub-agents spawn the ggcoder CLI in JSON mode to run a delegated task. In the
 * packaged desktop app the only runnable entry is THIS bundle (there's no
 * sibling `cli.js`), so the subagent tool ends up spawning the sidecar itself.
 * Without this guard that would boot a second HTTP server, emit no NDJSON, and
 * hang until the 10-minute hard timeout. So when invoked with `--json`, behave
 * exactly like `ggcoder --json …`: stream the sub-agent run as NDJSON and exit,
 * never starting the HTTP/SSE server. Mirrors the `values.json` branch in cli.ts.
 */
export async function runJsonModeIfRequested(): Promise<boolean> {
  if (!process.argv.includes("--json")) return false;
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: "boolean" },
      provider: { type: "string" },
      model: { type: "string" },
      "max-turns": { type: "string" },
      "system-prompt": { type: "string" },
      "agent-prompt": { type: "string" },
      "agent-context": { type: "string" },
      tools: { type: "string" },
      "mcp-servers": { type: "string" },
      "prompt-cache-key": { type: "string" },
      thinking: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const maxTurnsRaw = values["max-turns"];
  // Optional tool allow-list forwarded by the subagent spawner from an agent
  // definition's `tools:` frontmatter. Mirrors the identical parsing in
  // cli.ts's `values.json` branch — keep both in sync (see subagent.ts).
  const parsedTools = values.tools
    ? values.tools
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  const allowedTools = parsedTools.length > 0 ? parsedTools : undefined;
  // MCP servers the agent definition asked for. Without forwarding these, an
  // allow-listed child connects no MCP at all and loses live code search.
  const parsedMcpServers = values["mcp-servers"]
    ? values["mcp-servers"]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const allowedMcpServers = parsedMcpServers.length > 0 ? parsedMcpServers : undefined;
  await runJsonMode({
    message: positionals[0] ?? "",
    provider: (values.provider ?? "anthropic") as Provider,
    model: values.model ?? "claude-opus-5-5",
    cwd: process.cwd(),
    systemPrompt: values["system-prompt"],
    agentPrompt: values["agent-prompt"],
    agentContext: values["agent-context"] === "none" ? "none" : undefined,
    maxTurns: maxTurnsRaw ? parseInt(maxTurnsRaw, 10) : undefined,
    allowedTools,
    allowedMcpServers,
    promptCacheKey: values["prompt-cache-key"],
    thinkingLevel: parseThinkingLevel(values.thinking),
  }).catch(async (err: unknown) => {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    process.exit(1);
  });
  return true;
}
