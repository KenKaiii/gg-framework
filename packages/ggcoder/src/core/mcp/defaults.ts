import type { Provider } from "@kenkaiiii/gg-ai";
import type { MCPServerConfig } from "./types.js";
import { loadServers } from "./store.js";
import { getModel } from "../model-registry.js";

/** Servers every provider gets. Real-code research is the native `steroids`
 *  tool now, so nothing ships here by default; provider-specific servers are
 *  added in `getMCPServers`. */
export const DEFAULT_MCP_SERVERS: MCPServerConfig[] = [];

/**
 * Whether a session on this model gets Z.AI's bundled servers. Only GLM models
 * without native image input need them (GLM-5.3, for zai_vision); GLM-5.4 and
 * 5.3-Flash read images themselves and use the built-in web_search, web_fetch
 * and steroids tools instead. An unknown GLM id keeps the servers.
 */
export function usesZaiMcpServers(provider: Provider, model: string): boolean {
  return provider === "glm" && getModel(model)?.supportsImages !== true;
}

/**
 * Get MCP servers for a specific provider.
 * GLM models get Z.AI MCP servers for vision, web search, web reading, and GitHub exploration.
 */
export function getMCPServers(provider: Provider, apiKey?: string): MCPServerConfig[] {
  const servers = [...DEFAULT_MCP_SERVERS];

  if (provider === "glm" && apiKey) {
    const zaiAuth = { Authorization: `Bearer ${apiKey}` };

    // Vision (image support via stdio MCP server). Timeout is 180s, not the
    // 60s the quick HTTP zai calls use: GLM-4.6V analysis of a large screenshot
    // legitimately runs 20-60s+ (observed 52s successes and 60s-cap kills in
    // the sidecar logs), and client.ts applies this per tool CALL.
    servers.push({
      name: "zai_vision",
      command: "npx",
      args: ["-y", "@z_ai/mcp-server"],
      env: {
        Z_AI_API_KEY: apiKey,
        Z_AI_MODE: "ZAI",
      },
      timeout: 180_000,
    });

    // Web search
    servers.push({
      name: "zai_web_search",
      url: "https://api.z.ai/api/mcp/web_search_prime/mcp",
      headers: zaiAuth,
      timeout: 60_000,
    });

    // Web reader (full-page content extraction)
    servers.push({
      name: "zai_web_reader",
      url: "https://api.z.ai/api/mcp/web_reader/mcp",
      headers: zaiAuth,
      timeout: 60_000,
    });

    // GitHub repository exploration
    servers.push({
      name: "zai_zread",
      url: "https://api.z.ai/api/mcp/zread/mcp",
      headers: zaiAuth,
      timeout: 60_000,
    });
  }

  return servers;
}

/**
 * Full startup set: provider defaults + user-configured servers from
 * ~/.gg/mcp.json and ./.gg/mcp.json. Provider defaults stay authoritative —
 * a user server can only ADD a new name, never override a default.
 */
export async function getAllMcpServers(
  provider: Provider,
  apiKey: string | undefined,
  cwd: string,
  opts?: { allowProjectScope?: boolean },
): Promise<MCPServerConfig[]> {
  const defaults = getMCPServers(provider, apiKey);
  const defaultNames = new Set(defaults.map((s) => s.name));
  const scoped = await loadServers(cwd);
  // Project scope (<repo>/.gg/mcp.json) is repo-controlled: a malicious repo
  // can declare a stdio `command` that would execute the moment the project
  // opens. Only include those when explicitly trusted (trustProjectMcpServers);
  // global ~/.gg/mcp.json is the user's own file and always connects.
  const userServers = scoped
    .filter((s) => opts?.allowProjectScope === true || s.scope !== "project")
    .map((s) => s.config)
    .filter((c) => !defaultNames.has(c.name));
  return [...defaults, ...userServers];
}
