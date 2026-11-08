import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.js";
import { findHideFromUser } from "../skill-scan.js";

/**
 * MCP tool-list guard (gg-safe S2).
 *
 * Runs when a server's tool list arrives, before any tool reaches the model or
 * the catalog cache. Descriptions lose ANSI escapes; a tool is hidden (never
 * exposed, no prompt) when its description:
 *  - orders reading secret files / MCP or auth config, or passing them in a
 *    parameter (Invariant tool poisoning);
 *  - tells the model to hide something from the user;
 *  - carries an `<IMPORTANT>`-style block steering how other tools are used;
 *  - names another server's tool to redirect it (postmark-style shadowing);
 *  - changed since it was pinned while the server's version did not (rug pull).
 * A server version change re-baselines its pins silently.
 */

export type ToolGuardRule =
  "bad-name" | "secret-read" | "hide-from-user" | "important-block" | "shadowing" | "rug-pull";

export interface HiddenMcpTool {
  server: string;
  tool: string;
  rule: ToolGuardRule;
  reason: string;
}

/** The SDK tool shape the guard needs; extra fields pass through untouched. */
export interface GuardableTool {
  name: string;
  description?: string;
}

const ANSI =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])|\u009B[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Strip ANSI escape sequences (and stray control bytes) from server text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "").replace(CONTROL, "");
}

const STRONG_SECRET =
  /(?:~|\$HOME|%USERPROFILE%)?\/?\.ssh\b|\bid_(?:rsa|ed25519|ecdsa|dsa)|\bmcp\.json\b|\bauth\.json\b|claude_desktop_config\.json|\.aws\/credentials|\.netrc\b|\.git-credentials\b|\bsecurity\s+find-(?:generic|internet)-password\b/i;
const DOTENV = /(?:^|[\s'"`(/])\.env(?:\.\w+)?(?![\w-])/;
const READ_VERB =
  /\b(?:read|cat|open|load|fetch|get|retrieve|collect|grab|copy|include|attach|pass|provide|send|upload|put|insert|add)\b/i;
const ORDER =
  /\b(?:must|always|first|before\s+(?:using|calling|running|you)|make\s+sure|you\s+(?:need|have)\s+to|is\s+(?:required|necessary|mandatory)|otherwise|required)\b/i;
const IN_PARAM =
  /\b(?:pass|provide|include|put|insert|send|add)\b[^.]{0,80}\b(?:as|in|into|via|through)\s+(?:the\s+)?(?:['"`]?\w+['"`]?\s+)?(?:param(?:eter)?|argument|arg|field|sidenote|note|input)\b/i;
const IMPORTANT_BLOCK =
  /<\s*(?:important|system|instructions?|critical|admin|secret|hidden)\s*>|\[\s*(?:important|system)\s*\]/i;
const OTHER_TOOLS =
  /\b(?:other|another|any|all|every|each)\s+(?:\w+\s+)?tools?\b|\btools?\s+(?:from|on|of)\s+(?:other|another)\b|\bmcp__\w+/i;
const REDIRECT =
  /\b(?:always|must|instead|whenever|before|after|also|never|override|replace|redirect|bcc|cc|send\s+a\s+copy|forward)\b/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim() !== "");
}

/** Identifiers distinctive enough to count as a deliberate tool reference. */
function distinctive(name: string): boolean {
  return name.length >= 5 && /[_-]|[a-z][A-Z]/.test(name);
}

function mentionsTool(text: string, name: string): boolean {
  // Cheap substring gate: building a RegExp per (tool × description) pair
  // cost ~30 ms for 200 tools against 200 known tools.
  if (!text.includes(name)) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(text);
}

/**
 * Check one cleaned description. `ownTools` are this server's names;
 * `otherTools` maps each other known server's tool names (for shadowing).
 */
export function checkToolDescription(
  description: string,
  ownTools: ReadonlySet<string>,
  otherTools: ReadonlyMap<string, string>,
): { rule: ToolGuardRule; reason: string } | null {
  for (const s of sentences(description)) {
    const strong = STRONG_SECRET.test(s);
    const env = DOTENV.test(s);
    if ((strong || env) && READ_VERB.test(s) && (ORDER.test(s) || IN_PARAM.test(s))) {
      return { rule: "secret-read", reason: "orders reading secret files or config" };
    }
    if (strong && IN_PARAM.test(s)) {
      return { rule: "secret-read", reason: "asks for secret files in a parameter" };
    }
  }
  const hide = findHideFromUser(description);
  if (hide)
    return {
      rule: "hide-from-user",
      reason: `tells the model to hide things from the user ("${hide}")`,
    };

  for (const [tool, server] of otherTools) {
    if (ownTools.has(tool) || !distinctive(tool)) continue;
    if (!mentionsTool(description, tool)) continue;
    const near = sentences(description).some((s) => mentionsTool(s, tool) && REDIRECT.test(s));
    if (near || IMPORTANT_BLOCK.test(description)) {
      return { rule: "shadowing", reason: `redirects "${tool}" from server "${server}"` };
    }
  }
  if (IMPORTANT_BLOCK.test(description)) {
    const external = [
      ...description.matchAll(
        /`?\b([a-zA-Z][\w-]{4,})\b`?\s+tool\b|\btool\s+[`'"]([\w-]{5,})[`'"]/g,
      ),
    ]
      .map((m) => m[1] ?? m[2] ?? "")
      .some((n) => distinctive(n) && !ownTools.has(n));
    if (external || OTHER_TOOLS.test(description) || STRONG_SECRET.test(description)) {
      return {
        rule: "important-block",
        reason: "<IMPORTANT>-style block instructs the model about other tools",
      };
    }
  }
  return null;
}

interface ServerPins {
  serverVersion: string;
  tools: Record<string, string>;
}

interface PinFile {
  version: 1;
  servers: Record<string, ServerPins>;
}

function hashDescription(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parsePins(raw: unknown): PinFile {
  const out: PinFile = { version: 1, servers: {} };
  if (!isRecord(raw) || !isRecord(raw.servers)) return out;
  for (const [name, entry] of Object.entries(raw.servers)) {
    if (!isRecord(entry) || typeof entry.serverVersion !== "string" || !isRecord(entry.tools))
      continue;
    const tools: Record<string, string> = {};
    for (const [tool, hash] of Object.entries(entry.tools)) {
      if (typeof hash === "string") tools[tool] = hash;
    }
    out.servers[name] = { serverVersion: entry.serverVersion, tools };
  }
  return out;
}

/**
 * Pins tool descriptions per server in a JSON file under the GG dir and
 * filters each arriving tool list. One instance per manager; the file is the
 * shared truth across sessions and pooled connections.
 */
export class McpToolGuard {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async readPins(): Promise<PinFile> {
    try {
      return parsePins(JSON.parse(await fs.readFile(this.filePath, "utf-8")));
    } catch {
      return { version: 1, servers: {} };
    }
  }

  /**
   * Filter a server's tool list. Returns the tools to expose (descriptions
   * ANSI-stripped, order preserved) and the hidden ones with one-line reasons.
   */
  async filter<T extends GuardableTool>(
    server: string,
    serverVersion: string | undefined,
    tools: readonly T[],
  ): Promise<{ tools: T[]; hidden: HiddenMcpTool[] }> {
    let result: { tools: T[]; hidden: HiddenMcpTool[] } = { tools: [], hidden: [] };
    // Serialize read-modify-write so concurrent servers don't clobber pins.
    const run = this.writeQueue.then(async () => {
      result = await this.filterLocked(server, serverVersion ?? "", tools);
    });
    this.writeQueue = run.catch(() => undefined);
    await run;
    for (const h of result.hidden) {
      log("WARN", "mcp", hiddenToolMessage(h), { rule: h.rule });
    }
    return result;
  }

  private async filterLocked<T extends GuardableTool>(
    server: string,
    serverVersion: string,
    tools: readonly T[],
  ): Promise<{ tools: T[]; hidden: HiddenMcpTool[] }> {
    const pins = await this.readPins();
    const previous = pins.servers[server];
    const rebaseline = !previous || previous.serverVersion !== serverVersion;
    const nextPins: Record<string, string> = rebaseline ? {} : { ...previous.tools };

    const ownTools = new Set(tools.map((t) => t.name));
    const otherTools = new Map<string, string>();
    for (const [name, entry] of Object.entries(pins.servers).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (name === server) continue;
      for (const tool of Object.keys(entry.tools))
        if (!otherTools.has(tool)) otherTools.set(tool, name);
    }

    const kept: T[] = [];
    const hidden: HiddenMcpTool[] = [];
    for (const tool of tools) {
      const rawDescription = tool.description ?? "";
      const hash = hashDescription(rawDescription);
      const pinned = nextPins[tool.name];
      // Keep the original pin on a mismatch so the tool stays hidden until a
      // version bump, rather than the new text becoming trusted next connect.
      if (pinned === undefined) nextPins[tool.name] = hash;

      if (stripAnsi(tool.name) !== tool.name || /\s/.test(tool.name)) {
        hidden.push({
          server,
          tool: stripAnsi(tool.name),
          rule: "bad-name",
          reason: "tool name contains control characters",
        });
        continue;
      }
      if (!rebaseline && pinned !== undefined && pinned !== hash) {
        hidden.push({
          server,
          tool: tool.name,
          rule: "rug-pull",
          reason: `description changed without a server version change (${serverVersion || "no version"})`,
        });
        continue;
      }
      const description = stripAnsi(rawDescription);
      const verdict = checkToolDescription(description, ownTools, otherTools);
      if (verdict) {
        hidden.push({ server, tool: tool.name, ...verdict });
        continue;
      }
      kept.push(description === rawDescription ? tool : { ...tool, description });
    }

    const changed =
      rebaseline || Object.keys(nextPins).length !== Object.keys(previous?.tools ?? {}).length;
    if (changed) {
      pins.servers[server] = { serverVersion, tools: nextPins };
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        await fs.writeFile(this.filePath, JSON.stringify(pins, null, 2), {
          encoding: "utf-8",
          mode: 0o600,
        });
      } catch (err) {
        log("WARN", "mcp", "failed to persist MCP tool pins", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { tools: kept, hidden };
  }
}

/** One plain line: which tool is hidden, and why. */
export function hiddenToolMessage(h: HiddenMcpTool): string {
  return `MCP tool "${h.tool}" from server "${h.server}" hidden: ${h.reason}.`;
}
