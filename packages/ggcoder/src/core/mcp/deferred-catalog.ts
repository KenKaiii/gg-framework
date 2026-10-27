import type { AgentTool } from "@kenkaiiii/gg-agent";
import { clampToBytes, CONTEXT_LIMITS, type ContextLimits } from "../context-limits.js";

/** Clamp a tool's description to the MCP description budget (eager or deferred). */
export function clampMcpToolDescription(
  tool: AgentTool,
  limits: ContextLimits = CONTEXT_LIMITS,
): AgentTool {
  const clamped = clampToBytes(tool.description, limits.mcpToolDescriptionBytes);
  return clamped.truncated ? { ...tool, description: clamped.text } : tool;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Holds MCP tools OUT of the per-turn request payload until the model asks
 * for them via `tool_search`.
 *
 * Measured: injecting every MCP tool schema
 * eagerly cost ~33KB (~8.3k tokens) per cache-miss turn with just two MCP
 * servers connected — 56% of all billed input tokens in a 6-turn session.
 * Deferring keeps the tool prefix small and byte-stable; promotion is a
 * one-time cache break paid only when a capability is actually needed.
 *
 * Descriptions are clamped at `add` time (server-controlled content): a
 * hostile or bloated MCP server must not be able to inflate every
 * tool_search result — and, once promoted, every request's tool schema.
 */
export class DeferredToolCatalog {
  private byName = new Map<string, AgentTool>();

  constructor(private readonly limits: ContextLimits = CONTEXT_LIMITS) {}

  add(tools: AgentTool[]): void {
    for (const tool of tools)
      this.byName.set(tool.name, clampMcpToolDescription(tool, this.limits));
  }

  /** Remove tools (e.g. when their MCP server is reloaded/removed). */
  removeWhere(predicate: (name: string) => boolean): void {
    for (const name of [...this.byName.keys()]) {
      if (predicate(name)) this.byName.delete(name);
    }
  }

  get size(): number {
    return this.byName.size;
  }

  /** Names still waiting in the catalog (for "no match" tool output). */
  names(): string[] {
    return [...this.byName.keys()];
  }

  /**
   * Rank catalog tools against a free-text capability query.
   *
   * Word-level overlap: a query word matches a name or description word when
   * they are equal or, for words of 4+ letters, one is a prefix of the other
   * ("tasks"→task, "debugger"→debug). Name hits weigh 3×, description hits 1×.
   *
   * Every returned tool is promoted, and a promoted schema is billed on every
   * later request, so only the best match and near-ties (≥ 75% of its score)
   * come back. Raw substring matching used to drag in unrelated tools — "web
   * search" loaded steroids and spawn_agent alongside
   * web_search, and "list" matched `checklist`. A deferred built-in the model
   * then calls by name still runs at once (AgentSession.promoteDeferredBuiltin),
   * so dropping weak matches costs no turn.
   */
  search(query: string, limit = 5): AgentTool[] {
    const words = [...new Set(tokenize(query))];
    if (words.length === 0) return [];
    const scored: { tool: AgentTool; score: number }[] = [];
    for (const tool of this.byName.values()) {
      const nameWords = tokenize(tool.name);
      const descWords = new Set(tokenize(tool.description));
      let score = 0;
      for (const w of words) {
        if (nameWords.some((n) => wordsMatch(w, n))) score += 3;
        if (descWords.has(w) || [...descWords].some((d) => wordsMatch(w, d))) score += 1;
      }
      if (score > 0) scored.push({ tool, score });
    }
    if (scored.length === 0) return [];
    scored.sort((a, b) => b.score - a.score);
    const floor = scored[0]!.score * 0.75;
    return scored
      .filter((s) => s.score >= floor)
      .slice(0, limit)
      .map((s) => s.tool);
  }

  /** Remove the named tools from the catalog and return them for activation. */
  promote(names: string[]): AgentTool[] {
    const promoted: AgentTool[] = [];
    for (const name of names) {
      const tool = this.byName.get(name);
      if (tool) {
        this.byName.delete(name);
        promoted.push(tool);
      }
    }
    return promoted;
  }
}
