import fs from "node:fs/promises";
import path from "node:path";
import { cleanInstructionText } from "../utils/text.js";
import { parseFrontmatter } from "./frontmatter.js";
import { log } from "./logger.js";
import { BUILTIN_TOOL_NAMES } from "../tools/prompt-hints.js";
import { BUNDLED_AGENTS } from "./bundled-agents.js";

/**
 * Which model a sub-agent runs on. Every sub-agent runs at the LOWEST thinking
 * level of that model (never off), whatever the parent uses.
 *
 * - `"inherit"` (default) — the parent's model, so a delegated task is never
 *   moved to a weaker model.
 * - `"fast"` — legacy alias of `"inherit"`, still accepted so older agent files
 *   load. It no longer swaps in a cheaper model.
 * - any other string — an explicit model id.
 */
export type AgentModelPreference = "inherit" | "fast" | (string & {});

export interface AgentDefinition {
  name: string;
  /** Routing signal — written for the dispatcher, not for the child. */
  description: string;
  /** Tool allow-list. Empty means inherit the full toolset. */
  tools: string[];
  /** Model policy for children of this agent. Defaults to `"inherit"`. */
  model?: AgentModelPreference;
  /** Whether the child's prompt includes project context files. Default `"project"`. */
  context?: "project" | "none";
  systemPrompt: string;
  source: "global" | "project" | "bundled";
}

/**
 * MCP server names an agent's `tools:` list asks for, derived from any
 * `mcp__<server>__<tool>` entries.
 *
 * A session with an allow-list connects MCP servers ONLY when they're named in
 * `allowedMcpServers` (see `AgentSession.connectMcpServers`). Without this,
 * every named agent silently got zero MCP tools, even one that explicitly
 * listed an `mcp__<server>__*` tool.
 */
export function mcpServersForAgent(tools: readonly string[]): string[] {
  const servers = new Set<string>();
  for (const tool of tools) {
    // mcp__<server>__<tool> — server names may themselves contain single
    // underscores, so split on the double-underscore delimiter only.
    const match = /^mcp__(.+?)__(.+)$/.exec(tool);
    if (match) servers.add(match[1]);
  }
  return [...servers];
}

const BUILTIN_TOOL_NAME_SET = new Set(BUILTIN_TOOL_NAMES);
// mcp__<server>__<tool> — the only non-built-in shape a session can register.
const MCP_TOOL_PATTERN = /^mcp__(.+?)__(.+)$/;

/**
 * Report `tools:` entries the session could never register.
 *
 * `AgentSession` filters its tool set by name, so an unknown entry is dropped
 * without a word: the agent just quietly loses a capability (or, if every name
 * is wrong, runs with nothing). Warn instead — and stay non-fatal, because a
 * bad agent file must never take down a session.
 *
 * @returns the unrecognized names, for tests and callers that want to report.
 */
export function validateAgentTools(agent: AgentDefinition, origin: string): string[] {
  const unknown = agent.tools.filter(
    (tool) => !BUILTIN_TOOL_NAME_SET.has(tool) && !MCP_TOOL_PATTERN.test(tool),
  );
  if (unknown.length > 0) {
    log("WARN", "agents", "Agent lists unknown tools; they will be ignored", {
      agent: agent.name,
      origin,
      unknown,
    });
  }
  return unknown;
}

/**
 * Discover agent definitions from global and project-local directories.
 * Agent files are markdown with frontmatter (similar to skills).
 *
 * Order: user agents (project, global) first → bundled defaults last.
 * The subagent lookup uses Array.prototype.find which matches the first hit,
 * so user agents override bundled when names collide.
 */
export async function discoverAgents(options: {
  globalAgentsDir?: string;
  projectDir?: string;
}): Promise<AgentDefinition[]> {
  const agents: AgentDefinition[] = [];

  // Project agents: {cwd}/.gg/agents/*.md
  if (options.projectDir) {
    const projectAgentsDir = path.join(options.projectDir, ".gg", "agents");
    const projectAgents = await loadAgentsFromDir(projectAgentsDir, "project");
    agents.push(...projectAgents);
  }

  // Global agents: ~/.gg/agents/*.md
  if (options.globalAgentsDir) {
    const globalAgents = await loadAgentsFromDir(options.globalAgentsDir, "global");
    agents.push(...globalAgents);
  }

  // Bundled defaults — shipped with @kleio/coder; user-defined agents with the same
  // name take precedence because they come first in the array.
  const userNames = new Set(agents.map((a) => a.name.toLowerCase()));
  for (const bundled of BUNDLED_AGENTS) {
    if (!userNames.has(bundled.name.toLowerCase())) {
      validateAgentTools(bundled, "bundled");
      agents.push(bundled);
    }
  }

  return agents;
}

async function loadAgentsFromDir(
  dir: string,
  source: "global" | "project",
): Promise<AgentDefinition[]> {
  const agents: AgentDefinition[] = [];
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return agents;
  }

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(dir, file);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const agent = parseAgentFile(content, source);
      if (!agent.name) {
        agent.name = path.basename(file, ".md");
      }
      validateAgentTools(agent, filePath);
      agents.push(agent);
    } catch {
      // Skip unreadable files
    }
  }

  return agents;
}

/**
 * Parse an agent definition file with frontmatter.
 *
 * ```markdown
 * ---
 * name: scout
 * description: Fast codebase recon that returns compressed context
 * tools: read, grep, find, ls, bash
 * ---
 *
 * You are a scout. Quickly investigate a codebase...
 * ```
 */
export function parseAgentFile(rawInput: string, source: "global" | "project"): AgentDefinition {
  // A BOM before `---` would otherwise silently kill frontmatter parsing, and a
  // project agent file can hide instructions in invisible text.
  const cleaned = cleanInstructionText(rawInput);
  const { fields, body: systemPrompt } = parseFrontmatter(cleaned.text);
  // Unknown keys are ignored on purpose: agent files stay forward-compatible
  // with fields a newer ggcoder understands.
  const name = fields.name ?? "";
  const description = fields.description ?? "";
  if (cleaned.stripped > 0) {
    log("WARN", "agents", "Stripped invisible characters from an agent file", {
      name,
      source,
      stripped: cleaned.stripped,
    });
  }
  const tools = (fields.tools ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  const model: AgentModelPreference | undefined = fields.model || undefined;
  const normalizedContext = fields.context?.toLowerCase();
  const context =
    normalizedContext === "project" || normalizedContext === "none" ? normalizedContext : undefined;

  return { name, description, tools, model, context, systemPrompt, source };
}

// ── Bundled agents ─────────────────────────────────────────
// Shipped with @kleio/coder (see ./bundled-agents.ts). Used by the bundled
// `bulletproof` skill and available to any subagent call. User-defined agents with the same name
// override these because they come first in `discoverAgents`.
export { BUNDLED_AGENTS };
