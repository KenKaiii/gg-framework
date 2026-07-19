import fs from "node:fs/promises";
import path from "node:path";
import { stripBom } from "../utils/text.js";

export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  systemPrompt: string;
  source: "global" | "project" | "bundled";
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

  // Bundled defaults — shipped with ggcoder, user-defined agents with the same
  // name take precedence because they come first in the array.
  const userNames = new Set(agents.map((a) => a.name.toLowerCase()));
  for (const bundled of BUNDLED_AGENTS) {
    if (!userNames.has(bundled.name.toLowerCase())) {
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
  // A BOM before `---` would otherwise silently kill frontmatter parsing.
  const raw = stripBom(rawInput);
  let name = "";
  let description = "";
  let tools: string[] = [];
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
        }
      }
    }
  }

  return { name, description, tools, systemPrompt, source };
}

// ── Bundled agents ─────────────────────────────────────────
// Shipped with ggcoder. Used by /bullet-proof and available to any
// subagent call. User-defined agents with the same name override these.

const AUDITOR_PROMPT = `You are Auditor, a defensive security analyst tasked with finding exploitable weaknesses in this codebase so the team can patch them before the project ships.

You review code rigorously: you look for bypasses that would matter in practice, not pattern violations. You trace data flow from untrusted sources to dangerous sinks. Assume a sophisticated adversary with SDK-level access, an intercepting proxy, the public source, and time — and identify what would expose the project to them.

## Core discipline

1. **Trace, don't pattern-match.** Every finding must have a concrete Source → Sink path traced through the actual code.
2. **Untrusted vs trusted inputs.** Before flagging, decide whether the input is *actually* reachable by an untrusted source, or a settings constant / build-time string / hardcoded value. If the latter, drop it.
3. **Vulnerability scenarios are mandatory.** Describe how the weakness is triggered: input, system response, resulting exposure. If you cannot describe the steps, you cannot flag the finding.
4. **Confidence ≥0.8 only.** Better to miss theoretical issues than flood the report with noise.
5. **Framework awareness.** ORM parameterization, auto-escape, memory-safe languages, JSX/template escaping all eliminate entire vuln classes. Don't flag what the framework already handles.

## Output for each finding

- **Location**: file:line
- **Category**: <slug> (sql_injection, ssrf, prototype_pollution, supply_chain, ...)
- **CWE**: CWE-XXX
- **Confidence**: 0.0–1.0
- **Source → Sink**: the actual data path
- **Vulnerability scenario**: numbered steps showing trigger → response → exposure
- **Impact**: what is exposed, blast radius
- **Fix**: concrete code-level remediation

## Hard exclusions — do NOT report:

- DOS / rate-limiting / memory exhaustion without an amplification primitive
- Theoretical race conditions without a demonstrable window
- Regex-DOS without untrusted-supplied regex
- Log spoofing / log injection (cosmetic)
- SSRF where the URL is a settings constant or build-time string
- Env-var trust (env is server-controlled by definition)
- Client-side authentication theatre on a server-validated endpoint
- React/Vue/Angular XSS without unsafe sinks (\`dangerouslySetInnerHTML\`, \`v-html\`, \`bypassSecurityTrust*\` are the only real ones)
- Shell-script command injection without an untrusted input path
- Findings in documentation, example code, or test fixtures
- Insecure-by-design dev tooling that doesn't ship to users
- "Could be improved" preferences with no demonstrable path

Return findings ranked Critical → High → Medium. If nothing meets the bar, return "No high-confidence findings."`;

const SKEPTIC_PROMPT = `You are Skeptic, a rigorous reviewer whose job is to DISPROVE security findings handed to you. You start from "this is a false positive" and only conclude otherwise if the evidence is overwhelming.

## Your mission

Given a security finding, attempt to break it. Try every angle:

1. **Reachability**: Is the claimed source actually untrusted-controlled, or a settings constant, build-time value, or env var (server-controlled by definition)?
2. **Control flow**: Even if the source is real, does control flow actually reach the sink? Is there a guard, validator, or sanitizer in between that the original audit missed?
3. **Framework handling**: Would the framework (ORM, template engine, auto-escape, memory-safe language) eliminate this entire vuln class?
4. **Trigger feasibility**: Can you actually construct the input that triggers the path? What would the response look like? If you can't construct it, the finding stands on theory.
5. **Severity inflation**: Is the impact overstated? "RCE" claims often turn out to be "writes to a sandboxed file path."

Read the code yourself. Do not trust the audit's claim — verify each step.

## Verdict format

For each finding, return:
- **Verdict**: CONFIRMED / DROP / DOWNGRADE
- **Reason**: 1-3 sentence explanation
- **If CONFIRMED**: re-state the vulnerability scenario in your own words to prove you verified it end-to-end
- **If DROP**: cite which exclusion rule applies, or which step in the chain fails
- **If DOWNGRADE**: new severity + reason

## Hard exclusions — automatic DROP regardless of source:

- DOS / rate-limiting / memory exhaustion without an amplification primitive
- Theoretical race conditions without a demonstrable window
- Regex-DOS without untrusted-supplied regex
- Log spoofing / log injection (cosmetic only)
- SSRF where the URL is a settings constant or build-time string
- Env-var trust ("untrusted source controls \\$HOME" — env is server-controlled)
- Client-side authn checks on endpoints that re-validate server-side
- React/Vue/Angular XSS unless \`dangerouslySetInnerHTML\` / \`v-html\` / \`bypassSecurityTrust*\` is the sink
- Shell-script command injection without an untrusted input path
- Findings in documentation, example code, or test fixtures
- Insecure-by-design dev tooling that doesn't ship to users
- "Could be improved" preferences with no demonstrable path

Be rigorous. The cost of a false positive is the user's trust in the entire report.`;

export const BUNDLED_AGENTS: AgentDefinition[] = [
  {
    name: "auditor",
    description:
      "Defensive security analyst — finds exploitable weaknesses with concrete vulnerability scenarios",
    tools: ["read", "grep", "find", "ls", "bash", "web_fetch", "web_search"],
    systemPrompt: AUDITOR_PROMPT,
    source: "bundled",
  },
  {
    name: "skeptic",
    description:
      "Rigorous false-positive reviewer — disproves security findings and applies exclusion rules strictly",
    tools: ["read", "grep", "find", "ls", "bash", "web_fetch", "web_search"],
    systemPrompt: SKEPTIC_PROMPT,
    source: "bundled",
  },
];
