import fs from "node:fs/promises";
import path from "node:path";

export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  isolation?: "worktree";
  systemPrompt: string;
  source: "global" | "project";
}

/**
 * Discover agent definitions from global and project-local directories.
 * Agent files are markdown with frontmatter (similar to skills).
 */
export async function discoverAgents(options: {
  globalAgentsDir: string;
  projectDir?: string;
}): Promise<AgentDefinition[]> {
  const agents: AgentDefinition[] = [];

  // Global agents: ~/.gg/agents/*.md
  const globalAgents = await loadAgentsFromDir(options.globalAgentsDir, "global");
  agents.push(...globalAgents);

  // Project agents: {cwd}/.gg/agents/*.md
  if (options.projectDir) {
    const projectAgentsDir = path.join(options.projectDir, ".gg", "agents");
    const projectAgents = await loadAgentsFromDir(projectAgentsDir, "project");
    agents.push(...projectAgents);
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
 * model: claude-haiku-4-5
 * ---
 *
 * You are a scout. Quickly investigate a codebase...
 * ```
 */
export function parseAgentFile(raw: string, source: "global" | "project"): AgentDefinition {
  let name = "";
  let description = "";
  let tools: string[] = [];
  let model: string | undefined;
  let isolation: "worktree" | undefined;
  let systemPrompt = raw;

  if (raw.startsWith("---")) {
    const endIndex = raw.indexOf("---", 3);
    if (endIndex !== -1) {
      const frontmatter = raw.slice(3, endIndex).trim();
      systemPrompt = raw.slice(endIndex + 3).trim();

      for (const line of frontmatter.split("\n")) {
        const colonIndex = line.indexOf(":");
        if (colonIndex === -1) continue;
        const key = line.slice(0, colonIndex).trim().toLowerCase();
        const value = line.slice(colonIndex + 1).trim();

        if (key === "name") name = value;
        else if (key === "description") description = value;
        else if (key === "tools") {
          tools = value
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
        } else if (key === "model") model = value;
        else if (key === "isolation" && value === "worktree") isolation = value;
      }
    }
  }

  return { name, description, tools, model, isolation, systemPrompt, source };
}
