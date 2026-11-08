import crypto from "node:crypto";
import fs from "node:fs/promises";
import { getAppPaths } from "@kleio/core";
import { log } from "../logger.js";
import type { MCPServerConfig } from "./types.js";

/**
 * On-disk cache of MCP tool definitions, so a cold start can answer
 * `tool_search` honestly before any server has finished connecting.
 *
 * With `backgroundMcpConnect` on (the desktop default) the first turns run
 * against an empty `DeferredToolCatalog`, and `tool_search` reports "the
 * catalog is empty — every catalog tool is already available" for capabilities
 * that genuinely exist. That is a wrong answer, not a slow one.
 *
 * Entries are keyed by server name plus a hash of the resolved server config,
 * so editing a server's command, URL, headers or env invalidates its cache
 * instead of serving tools that server no longer exposes.
 */

/**
 * Negotiated MCP protocol era for a server, using the SDK's own vocabulary:
 * `legacy` = the 2025 `initialize` handshake, `modern` = 2026-07-28+. Feeds the
 * connect-time `prior` hint that lets a later connect skip the discovery probe.
 */
export type ProtocolEra = "legacy" | "modern";

export interface CachedTool {
  name: string;
  description: string;
  rawInputSchema?: Record<string, unknown>;
}

export interface CachedServerEntry {
  configHash: string;
  savedAt: number;
  protocolEra?: ProtocolEra;
  tools: CachedTool[];
}

interface CatalogFile {
  version: 1;
  servers: Record<string, CachedServerEntry>;
}

/** Cached entries older than this are ignored — a stale catalog misleads. */
const MAX_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Stable hash of everything that can change which tools a server exposes.
 * Key order is normalized so a reordered config file is not a cache miss.
 */
export function hashServerConfig(config: MCPServerConfig): string {
  const material = {
    url: config.url ?? null,
    headers: sortedEntries(config.headers),
    command: config.command ?? null,
    args: config.args ?? null,
    env: sortedEntries(config.env),
    transport: config.transport ?? null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16);
}

function sortedEntries(record: Record<string, string> | undefined): [string, string][] | null {
  if (!record) return null;
  return Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one persisted entry; unknown/partial shapes are dropped, not trusted. */
function parseEntry(value: unknown): CachedServerEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { configHash, savedAt, protocolEra, tools } = value;
  if (typeof configHash !== "string" || !configHash) return undefined;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return undefined;
  if (!Array.isArray(tools)) return undefined;
  const parsedTools: CachedTool[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    if (typeof tool.name !== "string" || !tool.name) continue;
    parsedTools.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      rawInputSchema: isRecord(tool.rawInputSchema) ? tool.rawInputSchema : undefined,
    });
  }
  return {
    configHash,
    savedAt,
    protocolEra: protocolEra === "legacy" || protocolEra === "modern" ? protocolEra : undefined,
    tools: parsedTools,
  };
}

/**
 * File-backed MCP tool catalog cache at `~/.gg/mcp-catalog.json`. Every read
 * re-reads the file so concurrent sidecars/windows see each other's writes;
 * writes are read-modify-write so two servers don't clobber one another.
 * Malformed files are treated as empty — a broken cache must never break a run.
 */
export class McpCatalogCache {
  /** Serializes read-modify-write cycles within one process. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string = getAppPaths().mcpCatalogFile) {}

  /** Where this cache lives; sibling state (tool pins) is kept beside it. */
  get path(): string {
    return this.filePath;
  }

  private async readAll(): Promise<CatalogFile> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || !isRecord(parsed.servers)) return { version: 1, servers: {} };
      const servers: Record<string, CachedServerEntry> = {};
      for (const [name, value] of Object.entries(parsed.servers)) {
        const entry = parseEntry(value);
        if (entry) servers[name] = entry;
      }
      return { version: 1, servers };
    } catch {
      // Missing or malformed: an empty cache is always a safe answer.
      return { version: 1, servers: {} };
    }
  }

  private async writeAll(data: CatalogFile): Promise<void> {
    try {
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
    } catch (err) {
      log("WARN", "mcp", "failed to persist MCP catalog cache", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Cached tools for the given configs, skipping any server whose config hash
   * changed or whose entry has aged out. Servers with no usable entry are
   * simply absent from the result.
   */
  async entriesFor(configs: readonly MCPServerConfig[]): Promise<Map<string, CachedServerEntry>> {
    const all = await this.readAll();
    const fresh = new Map<string, CachedServerEntry>();
    const now = Date.now();
    for (const config of configs) {
      const entry = all.servers[config.name];
      if (!entry) continue;
      if (entry.configHash !== hashServerConfig(config)) continue;
      if (now - entry.savedAt > MAX_ENTRY_AGE_MS) continue;
      fresh.set(config.name, entry);
    }
    return fresh;
  }

  /** Negotiated protocol era recorded for a server, if its config still matches. */
  async protocolEraFor(config: MCPServerConfig): Promise<ProtocolEra | undefined> {
    const entries = await this.entriesFor([config]);
    return entries.get(config.name)?.protocolEra;
  }

  /** Record a server's live tool list. Serialized against concurrent saves. */
  async save(
    config: MCPServerConfig,
    tools: readonly CachedTool[],
    protocolEra?: ProtocolEra,
  ): Promise<void> {
    const run = this.writeQueue.then(async () => {
      const all = await this.readAll();
      all.servers[config.name] = {
        configHash: hashServerConfig(config),
        savedAt: Date.now(),
        protocolEra: protocolEra ?? all.servers[config.name]?.protocolEra,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          ...(tool.rawInputSchema ? { rawInputSchema: tool.rawInputSchema } : {}),
        })),
      };
      await this.writeAll(all);
    });
    this.writeQueue = run.catch(() => undefined);
    await run;
  }

  /** Drop a server's cached tools (removal, or a connect that found none). */
  async clear(name: string): Promise<void> {
    const run = this.writeQueue.then(async () => {
      const all = await this.readAll();
      if (!all.servers[name]) return;
      delete all.servers[name];
      await this.writeAll(all);
    });
    this.writeQueue = run.catch(() => undefined);
    await run;
  }
}
