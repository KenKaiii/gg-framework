import { z } from "zod";
import { resolveToolSchema } from "@kenkaiiii/gg-ai";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { CONTEXT_LIMITS, type ContextLimits } from "../core/context-limits.js";
import type { DeferredToolCatalog } from "../core/mcp/deferred-catalog.js";

const ToolSearchParams = z.object({
  query: z.string(),
});

/** Outcome of waiting for the MCP server behind a cached-only catalog entry. */
export interface CachedToolResolution {
  serverName: string;
  ok: boolean;
  error?: string;
}

/**
 * Discovery tool for the deferred MCP catalog. Matching tools are promoted
 * into the live toolset immediately — callable from the very next turn.
 * `onPromote` pushes onto the session's live tools array (the agent loop
 * re-reads it every turn).
 *
 * `resolveCached` settles entries that came from the on-disk catalog cache and
 * whose server has not connected yet: it waits for that connection so the model
 * learns *now* whether the capability really exists, instead of promoting a
 * tool that will fail on first call. Returns undefined for already-live tools.
 */
export function createToolSearchTool(
  catalog: DeferredToolCatalog,
  onPromote: (tools: AgentTool[]) => void,
  resolveCached?: (toolName: string) => Promise<CachedToolResolution | undefined>,
  limits: ContextLimits = CONTEXT_LIMITS,
): AgentTool<typeof ToolSearchParams> {
  return {
    name: "tool_search",
    description: "Load on-demand/integration tools by capability; callable next step.",
    parameters: ToolSearchParams,
    async execute({ query }) {
      const matches = catalog.search(query);
      if (matches.length === 0) {
        const remaining = catalog.names();
        return remaining.length === 0
          ? "No tools matched and the catalog is empty — every catalog tool is already available."
          : `No tools matched "${query}". Still in the catalog: ${remaining.join(", ")}`;
      }
      // Schema budget, fail closed: a tool whose serialized input schema exceeds
      // the budget is NOT promoted — promoting it would bill those bytes on every
      // subsequent request. The user can raise contextLimits.mcpToolSchemaBytes.
      const oversized: Array<{ name: string; bytes: number }> = [];
      const promotable: AgentTool[] = [];
      for (const tool of matches) {
        const bytes = Buffer.byteLength(JSON.stringify(resolveToolSchema(tool)), "utf8");
        if (bytes > limits.mcpToolSchemaBytes) oversized.push({ name: tool.name, bytes });
        else promotable.push(tool);
      }
      if (promotable.length === 0) {
        const details = oversized
          .map(
            (t) =>
              `- ${t.name}: schema is ${Math.round(t.bytes / 1024)}KB (budget ${Math.round(limits.mcpToolSchemaBytes / 1024)}KB)`,
          )
          .join("\n");
        return (
          `No tools promoted — every match exceeds the schema byte budget.\n${details}\n` +
          `Raise the contextLimits.mcpToolSchemaBytes setting if this tool is trusted.`
        );
      }
      const promoted = catalog.promote(promotable.map((t) => t.name));
      onPromote(promoted);

      const unavailable = new Map<string, CachedToolResolution>();
      if (resolveCached) {
        const settled = await Promise.all(
          promoted.map(async (tool) => [tool.name, await resolveCached(tool.name)] as const),
        );
        for (const [name, resolution] of settled) {
          if (resolution && !resolution.ok) unavailable.set(name, resolution);
        }
      }

      const available = promoted.filter((tool) => !unavailable.has(tool.name));
      const failures = [...unavailable].map(
        ([name, resolution]) =>
          `- ${name}: MCP server "${resolution.serverName}" did not connect (${resolution.error ?? "unknown error"}).`,
      );

      if (available.length === 0) {
        return `No usable tools matched "${query}". Offered from a cached catalog but unreachable:\n${failures.join("\n")}`;
      }
      const lines = available.map(
        (t) => `- ${t.name}: ${t.description.split("\n")[0].slice(0, 200)}`,
      );
      const body = `${available.length} tool(s) now available:\n${lines.join("\n")}`;
      const refused =
        oversized.length > 0
          ? `\n\nRefused (schema byte budget):\n${oversized.map((t) => `- ${t.name} (${Math.round(t.bytes / 1024)}KB schema)`).join("\n")}\nRaise the contextLimits.mcpToolSchemaBytes setting if a refused tool is trusted.`
          : "";
      const unreachable = failures.length > 0 ? `\n\nUnreachable:\n${failures.join("\n")}` : "";
      // `loadedTools` lets transports with transcript tool loading (Anthropic
      // tool_reference, OpenAI tool_search_output) load these here instead of
      // growing the cached tools block.
      return {
        content: `${body}${refused}${unreachable}`,
        loadedTools: available.map((t) => t.name),
      };
    },
  };
}
