import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import { getAppPaths } from "../../config.js";
import { log } from "../logger.js";
import type { MCPServerConfig } from "./types.js";

/**
 * Where a server config lives. We collapse Claude Code's three scopes
 * (local/project/user) into two:
 * - "global"  → ~/.gg/mcp.json   (all Kleio Coder sessions)
 * - "project" → ./.gg/mcp.json   (the current project root)
 */
export type MCPScope = "global" | "project";

/**
 * On-disk entry shape. Accepts both Claude's `.mcp.json` fields
 * (`type`, `url`, `headers`, `command`, `args`, `env`, `timeout`) and our
 * extras (`enabled`, `keepAlive`, `maxTotalTimeout`) so configs are portable
 * in both directions.
 */
const StoredServerEntrySchema = z
  .object({
    type: z.enum(["stdio", "http", "streamable-http", "sse"]).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeout: z.number().optional(),
    maxTotalTimeout: z.number().optional(),
    enabled: z.boolean().optional(),
    keepAlive: z.boolean().optional(),
  })
  .passthrough();

export type StoredServerEntry = z.infer<typeof StoredServerEntrySchema>;

const McpFileSchema = z.object({
  mcpServers: z.record(z.string(), StoredServerEntrySchema).default({}),
});

export type McpFile = z.infer<typeof McpFileSchema>;

/** A loaded server config paired with the scope it came from. */
export interface ScopedServer {
  config: MCPServerConfig;
  scope: MCPScope;
}

export function globalMcpPath(): string {
  return getAppPaths().mcpFile;
}

export function projectMcpPath(cwd: string): string {
  return path.join(cwd, ".gg", "mcp.json");
}

/**
 * Read + validate one mcp.json file. On missing file → empty. On malformed
 * JSON/schema → log + treat as empty (don't crash), matching SettingsManager.
 */
async function readMcpFile(filePath: string): Promise<McpFile> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return { mcpServers: {} };
  }
  try {
    const raw: unknown = JSON.parse(content);
    return McpFileSchema.parse(raw);
  } catch (err) {
    log("WARN", "mcp", `Ignoring malformed MCP config at ${filePath}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { mcpServers: {} };
  }
}

async function writeMcpFile(filePath: string, file: McpFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(file, null, 2) + "\n", "utf-8");
}

/** Map an on-disk entry to a runtime MCPServerConfig. */
export function fromStoredEntry(name: string, entry: StoredServerEntry): MCPServerConfig {
  const config: MCPServerConfig = { name };
  // URL transports: explicit url, or type marks it as http/sse.
  if (entry.url) {
    config.url = entry.url;
    if (entry.headers) config.headers = entry.headers;
    // Preserve an explicit transport hint so the client knows whether to try
    // Streamable HTTP or go straight to legacy SSE.
    if (entry.type === "sse") config.transport = "sse";
    else if (entry.type === "http" || entry.type === "streamable-http") config.transport = "http";
  } else if (entry.command) {
    config.command = entry.command;
    if (entry.args) config.args = entry.args;
    if (entry.env) config.env = entry.env;
  }
  if (typeof entry.timeout === "number") config.timeout = entry.timeout;
  if (typeof entry.maxTotalTimeout === "number") config.maxTotalTimeout = entry.maxTotalTimeout;
  if (typeof entry.enabled === "boolean") config.enabled = entry.enabled;
  if (typeof entry.keepAlive === "boolean") config.keepAlive = entry.keepAlive;
  return config;
}

/** Map a runtime MCPServerConfig to the on-disk (Claude-compatible) entry. */
export function toStoredEntry(config: MCPServerConfig): StoredServerEntry {
  const entry: StoredServerEntry = {};
  if (config.url) {
    entry.type = config.transport ?? "http";
    entry.url = config.url;
    if (config.headers) entry.headers = config.headers;
  } else if (config.command) {
    entry.type = "stdio";
    entry.command = config.command;
    if (config.args) entry.args = config.args;
    if (config.env) entry.env = config.env;
  }
  if (typeof config.timeout === "number") entry.timeout = config.timeout;
  if (typeof config.maxTotalTimeout === "number") entry.maxTotalTimeout = config.maxTotalTimeout;
  if (typeof config.enabled === "boolean") entry.enabled = config.enabled;
  if (typeof config.keepAlive === "boolean") entry.keepAlive = config.keepAlive;
  return entry;
}

/**
 * Load servers from both scopes. Project wins on name collision (global entries
 * whose name also exists in project are dropped). Each result carries its scope.
 */
export async function loadServers(cwd: string): Promise<ScopedServer[]> {
  const [globalFile, projectFile] = await Promise.all([
    readMcpFile(globalMcpPath()),
    readMcpFile(projectMcpPath(cwd)),
  ]);

  const projectNames = new Set(Object.keys(projectFile.mcpServers));
  const result: ScopedServer[] = [];

  for (const [name, entry] of Object.entries(globalFile.mcpServers)) {
    if (projectNames.has(name)) continue; // project overrides global
    result.push({ config: fromStoredEntry(name, entry), scope: "global" });
  }
  for (const [name, entry] of Object.entries(projectFile.mcpServers)) {
    result.push({ config: fromStoredEntry(name, entry), scope: "project" });
  }
  return result;
}

/**
 * Add (or overwrite) a server in the target scope's file. Rejects a duplicate
 * name within the same scope unless `overwrite` is true.
 */
export async function addServer(
  entry: MCPServerConfig,
  scope: MCPScope,
  cwd: string,
  overwrite = false,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const filePath = scope === "global" ? globalMcpPath() : projectMcpPath(cwd);
  const file = await readMcpFile(filePath);
  if (file.mcpServers[entry.name] && !overwrite) {
    return {
      ok: false,
      error: `A "${entry.name}" server already exists in ${scope} scope. Remove it first or use a different name.`,
    };
  }
  file.mcpServers[entry.name] = toStoredEntry(entry);
  await writeMcpFile(filePath, file);
  return { ok: true };
}

/** Remove a server from a scope. Returns true if it existed. */
export async function removeServer(name: string, scope: MCPScope, cwd: string): Promise<boolean> {
  const filePath = scope === "global" ? globalMcpPath() : projectMcpPath(cwd);
  const file = await readMcpFile(filePath);
  if (!file.mcpServers[name]) return false;
  delete file.mcpServers[name];
  await writeMcpFile(filePath, file);
  return true;
}

/** Look up a single server across both scopes (project wins). */
export async function getServer(name: string, cwd: string): Promise<ScopedServer | undefined> {
  const servers = await loadServers(cwd);
  return servers.find((s) => s.config.name === name);
}
