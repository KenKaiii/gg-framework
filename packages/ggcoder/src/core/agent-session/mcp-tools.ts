import type { AgentTool } from "@kleio/agent";
import { z } from "zod";
import { log } from "../logger.js";
import { MCPClientManager, type MCPElicitHandler } from "../mcp/index.js";
import type { MCPServerConfig } from "../mcp/types.js";
import { clampMcpToolDescription, DeferredToolCatalog } from "../mcp/deferred-catalog.js";
import { McpCatalogCache, type CachedTool } from "../mcp/catalog-cache.js";
import type { ContextLimits } from "../context-limits.js";
import { createToolSearchTool } from "../../tools/tool-search.js";

/**
 * MCP tool wiring for one session: the client manager, the deferred
 * `tool_search` catalog (shared with deferred built-ins), cached-catalog stubs
 * and the live/cached reconcile maps.
 *
 * Never owns the tool array — it reads the session's CURRENT array through
 * `getTools` (the session may filter-replace it) and only appends to it or
 * swaps same-named entries in place, so the cached tool prefix stays stable.
 */
export class McpToolRegistry {
  manager?: MCPClientManager;
  /** Deferred MCP tools awaiting discovery via tool_search. */
  private catalog?: DeferredToolCatalog;
  /** Live (connected) MCP tools by name — the reconcile target for cached stubs. */
  private readonly liveTools = new Map<string, AgentTool>();
  /** Server name for each cached-only tool, so a stub knows what to wait on. */
  private readonly cachedToolServers = new Map<string, string>();
  private readonly catalogCache = new McpCatalogCache();

  constructor(
    private readonly getTools: () => AgentTool[],
    private readonly getContextLimits: () => ContextLimits,
  ) {}

  createManager(options: {
    modernProtocol: boolean;
    onElicit: MCPElicitHandler | undefined;
  }): void {
    this.manager = new MCPClientManager({
      catalogCache: this.catalogCache,
      modernProtocol: options.modernProtocol,
      onElicit: options.onElicit,
    });
  }

  private ensureCatalog(): DeferredToolCatalog {
    this.catalog ??= new DeferredToolCatalog(this.getContextLimits());
    return this.catalog;
  }

  /** Hold tools in the tool_search catalog and make sure tool_search exists. */
  addDeferred(tools: AgentTool[]): void {
    this.ensureCatalog().add(tools);
    this.ensureToolSearchTool();
  }

  /** Forget every MCP tool before a provider-switch reconnect re-adds them. */
  clearMcpTools(): void {
    this.catalog?.removeWhere((name) => name.startsWith("mcp__"));
    this.liveTools.clear();
    this.cachedToolServers.clear();
  }

  /**
   * Route freshly connected MCP tools: deferred into the tool_search catalog
   * (default — keeps ~8k tokens of schema out of every cache-miss turn) or
   * pushed eagerly when `defer` is false.
   * Promotion pushes onto the live tools array the running agent loop
   * re-reads every turn, so promoted tools are callable on the next step.
   */
  addMcpTools(mcpTools: AgentTool[], defer: boolean): void {
    if (mcpTools.length === 0) return;
    for (const tool of mcpTools) {
      this.liveTools.set(tool.name, tool);
      this.cachedToolServers.delete(tool.name);
    }
    if (!defer) {
      // Eager path bypasses the catalog, so budget descriptions here too.
      this.replaceOrPushTools(
        mcpTools.map((tool) => clampMcpToolDescription(tool, this.getContextLimits())),
      );
      return;
    }
    // `add` is name-keyed, so live definitions replace cached stubs in place.
    this.ensureCatalog().add(mcpTools);
    // A stub the model already promoted lives in the tools array; swap it for
    // the live tool so later calls dispatch directly instead of through the stub.
    this.replaceLivePromotedTools(mcpTools);
    this.ensureToolSearchTool();
  }

  /**
   * Register `tool_search` once. Promotion of a cached-only entry waits for its
   * server so the model is told immediately when that capability turns out to
   * be unreachable, instead of promoting a tool that fails on first call.
   *
   * The catalog is created on demand rather than required up front: deferred
   * built-in tools populate it with zero MCP servers connected, so gating
   * registration on an existing catalog would leave those tools unreachable.
   */
  ensureToolSearchTool(): void {
    const catalog = this.ensureCatalog();
    if (this.getTools().some((t) => t.name === "tool_search")) return;
    this.getTools().push(
      createToolSearchTool(
        catalog,
        (promoted) => {
          this.getTools().push(...promoted);
        },
        async (toolName) => {
          if (this.liveTools.has(toolName)) return undefined;
          const serverName = this.cachedToolServers.get(toolName);
          if (!serverName) return undefined;
          const outcome = (await this.manager?.whenConnected(serverName)) ?? {
            ok: false as const,
            error: "MCP is disabled for this session",
          };
          return outcome.ok
            ? { serverName, ok: true }
            : { serverName, ok: false, error: outcome.error };
        },
        this.getContextLimits(),
      ),
    );
  }

  /** Append tools, replacing any same-named entry (cached stub → live tool). */
  private replaceOrPushTools(tools: AgentTool[]): void {
    const live = this.getTools();
    for (const tool of tools) {
      const index = live.findIndex((t) => t.name === tool.name);
      if (index >= 0) live[index] = tool;
      else live.push(tool);
    }
  }

  /** Swap already-promoted cached stubs for their live equivalents, in place. */
  private replaceLivePromotedTools(tools: AgentTool[]): void {
    const live = this.getTools();
    for (const tool of tools) {
      const index = live.findIndex((t) => t.name === tool.name);
      if (index >= 0) live[index] = tool;
    }
  }

  /**
   * Publish cached tool definitions into the deferred catalog so `tool_search`
   * answers correctly on turn 1. A cached stub carries the real name, one-line
   * description and input schema; calling it waits for the live connection and
   * then dispatches against the real client, or returns a clear error when that
   * server ultimately failed. Live tools replace stubs on connect.
   */
  async seedFromCache(servers: MCPServerConfig[]): Promise<void> {
    let entries: Awaited<ReturnType<McpCatalogCache["entriesFor"]>>;
    try {
      entries = await this.catalogCache.entriesFor(servers);
    } catch {
      return;
    }
    const stubs: AgentTool[] = [];
    for (const [serverName, entry] of entries) {
      for (const cached of entry.tools) {
        if (this.liveTools.has(cached.name)) continue;
        this.cachedToolServers.set(cached.name, serverName);
        stubs.push(this.buildCachedMcpTool(serverName, cached));
      }
    }
    if (stubs.length === 0) return;
    log("INFO", "mcp", "Seeded deferred tool catalog from cache", {
      tools: String(stubs.length),
      servers: String(entries.size),
    });
    // Catalog-only registration for cached stubs — never marks them live.
    this.addDeferred(stubs);
  }

  private buildCachedMcpTool(serverName: string, cached: CachedTool): AgentTool {
    return {
      name: cached.name,
      description: cached.description,
      parameters: z.record(z.string(), z.unknown()),
      rawInputSchema: cached.rawInputSchema,
      execute: async (args, context) => {
        const live = this.liveTools.get(cached.name);
        if (live) return live.execute(args, context);
        const outcome = (await this.manager?.whenConnected(serverName)) ?? {
          ok: false as const,
          error: "MCP is disabled for this session",
        };
        if (!outcome.ok) {
          return (
            `MCP tool ${cached.name} is unavailable: server "${serverName}" did not connect ` +
            `(${outcome.error}). This tool was offered from a cached catalog. ` +
            `Use a different approach or ask the user to check their MCP configuration.`
          );
        }
        const connected = this.liveTools.get(cached.name);
        if (!connected) {
          return (
            `MCP tool ${cached.name} no longer exists: server "${serverName}" connected but ` +
            `does not expose it. The cached catalog entry was stale.`
          );
        }
        return connected.execute(args, context);
      },
    };
  }
}
