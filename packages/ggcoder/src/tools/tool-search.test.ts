import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
import { resolveContextLimits } from "../core/context-limits.js";
import { DeferredToolCatalog } from "../core/mcp/deferred-catalog.js";
import { createToolSearchTool, type CachedToolResolution } from "./tool-search.js";

const CONTEXT = {} as ToolContext;

function stub(name: string, description: string, result = "ok"): AgentTool {
  return {
    name,
    description,
    parameters: z.record(z.string(), z.unknown()),
    execute: async () => result,
  };
}

async function search(tool: ReturnType<typeof createToolSearchTool>, query: string) {
  const result = await tool.execute({ query }, CONTEXT);
  return typeof result === "string" ? result : String(result.content);
}

describe("tool_search", () => {
  it("answers correctly on turn 1 from a cache-seeded catalog", async () => {
    const catalog = new DeferredToolCatalog();
    // Cold start: servers are still connecting, so every entry is a cached stub.
    catalog.add([stub("mcp__figma__get_screens", "fetch UI design screenshots")]);
    const promotedNames: string[] = [];
    const tool = createToolSearchTool(
      catalog,
      (tools) => promotedNames.push(...tools.map((t) => t.name)),
      async () => ({ serverName: "figma", ok: true }),
    );

    const result = await search(tool, "UI design screenshots");
    expect(result).toContain("mcp__figma__get_screens");
    expect(result).not.toContain("the catalog is empty");
    expect(promotedNames).toEqual(["mcp__figma__get_screens"]);
  });

  it("reports the empty catalog only when it really is empty", async () => {
    const tool = createToolSearchTool(new DeferredToolCatalog(), () => {});
    expect(await search(tool, "UI design screenshots")).toContain("the catalog is empty");
  });

  it("returns a model-visible error when the cached tool's server failed", async () => {
    const catalog = new DeferredToolCatalog();
    catalog.add([stub("mcp__figma__get_screens", "fetch UI design screenshots")]);
    const resolution: CachedToolResolution = {
      serverName: "figma",
      ok: false,
      error: "spawn ENOENT",
    };
    const tool = createToolSearchTool(
      catalog,
      () => {},
      async () => resolution,
    );

    const result = await search(tool, "UI design screenshots");
    expect(result).toContain("No usable tools matched");
    expect(result).toContain("figma");
    expect(result).toContain("spawn ENOENT");
  });

  it("promotes the reachable tools and flags only the unreachable ones", async () => {
    const catalog = new DeferredToolCatalog();
    catalog.add([
      stub("mcp__figma__get_screens", "fetch design screenshots"),
      stub("mcp__dead__get_screens", "fetch design screenshots"),
    ]);
    const tool = createToolSearchTool(
      catalog,
      () => {},
      async (name) =>
        name.startsWith("mcp__dead__")
          ? { serverName: "dead", ok: false, error: "timed out after 30000ms" }
          : undefined,
    );

    const result = await search(tool, "design screenshots");
    expect(result).toContain("1 tool(s) now available");
    expect(result).toContain("mcp__figma__get_screens");
    expect(result).toContain("Unreachable:");
    expect(result).toContain("mcp__dead__get_screens");
  });

  it("works without a resolver (all tools already live)", async () => {
    const catalog = new DeferredToolCatalog();
    catalog.add([stub("mcp__figma__get_screens", "fetch design screenshots")]);
    const tool = createToolSearchTool(catalog, () => {});
    expect(await search(tool, "design screenshots")).toContain("1 tool(s) now available");
  });

  it("refuses promotion of a tool whose schema exceeds the byte budget", async () => {
    const catalog = new DeferredToolCatalog();
    const huge = z.object({
      blob: z.string().describe("x".repeat(200 * 1024)), // 200KB serialized schema
    });
    catalog.add([
      {
        name: "mcp__big__get_screens",
        description: "fetch design screenshots",
        parameters: huge,
        execute: async () => "ok",
      },
      stub("mcp__figma__get_screens", "fetch design screenshots"),
    ]);
    const promotedNames: string[] = [];
    const tool = createToolSearchTool(catalog, (tools) =>
      promotedNames.push(...tools.map((t) => t.name)),
    );

    const result = await search(tool, "design screenshots");
    // The fit tool promoted; the oversized one was refused and named.
    expect(result).toContain("1 tool(s) now available");
    expect(result).toContain("mcp__figma__get_screens");
    expect(result).toContain("Refused (schema byte budget)");
    expect(result).toContain("mcp__big__get_screens");
    expect(result).toContain("contextLimits.mcpToolSchemaBytes");
    expect(promotedNames).toEqual(["mcp__figma__get_screens"]);
    // Refused tool stays in the catalog, not the live toolset.
    expect(catalog.names()).toContain("mcp__big__get_screens");
  });

  it("fails closed when EVERY match exceeds the schema budget", async () => {
    const catalog = new DeferredToolCatalog();
    catalog.add([
      {
        name: "mcp__big__blob",
        description: "fetch design screenshots",
        parameters: z.object({ blob: z.string().describe("x".repeat(200 * 1024)) }),
        execute: async () => "ok",
      },
    ]);
    const promotedNames: string[] = [];
    const tool = createToolSearchTool(catalog, (tools) =>
      promotedNames.push(...tools.map((t) => t.name)),
    );

    const result = await search(tool, "design screenshots");
    expect(result).toContain("No tools promoted");
    expect(result).toContain("mcp__big__blob");
    expect(promotedNames).toEqual([]);
  });

  it("honors a raised schema budget from limits", async () => {
    const catalog = new DeferredToolCatalog();
    catalog.add([
      {
        name: "mcp__big__blob",
        description: "fetch design screenshots",
        parameters: z.object({ blob: z.string().describe("x".repeat(8 * 1024)) }), // ~8KB
        execute: async () => "ok",
      },
    ]);
    const tool = createToolSearchTool(
      catalog,
      () => {},
      undefined,
      resolveContextLimits({ mcpToolSchemaBytes: 16 * 1024 }),
    );
    expect(await search(tool, "design screenshots")).toContain("1 tool(s) now available");
  });

  it("promotes only the best match and near-ties, never weak substring hits", async () => {
    const catalog = new DeferredToolCatalog();
    catalog.add([
      stub("web_search", "Search the web and return results."),
      stub("web_fetch", "Fetch a URL from the web."),
      stub("code_search", "Search code by meaning."),
      stub("checklist", "Project checks with evidence."),
      stub("tasks", "Task list for the project."),
      stub("debug", "Node debugger."),
    ]);
    expect(catalog.search("web search").map((t) => t.name)).toEqual(["web_search"]);
    // Word-level: "list" no longer matches inside "checklist"; plurals and
    // stems still match ("tasks" → task, "debugger" → debug).
    expect(catalog.search("task list").map((t) => t.name)).toEqual(["tasks"]);
    expect(catalog.search("debugger").map((t) => t.name)).toEqual(["debug"]);
    expect(catalog.search("nothing relevant here")).toEqual([]);
  });
});

describe("tool_search loadedTools", () => {
  it("names the promoted tools so transports can load them in the transcript", async () => {
    const catalog = new DeferredToolCatalog();
    catalog.add([
      {
        name: "steroids",
        description: "Search real open-source code",
        parameters: z.object({}),
        execute: async () => "",
      },
    ]);
    const tool = createToolSearchTool(catalog, () => {});
    const result = await tool.execute({ query: "open-source code" }, CONTEXT);
    expect(typeof result === "object" && result.loadedTools).toEqual(["steroids"]);
  });
});
