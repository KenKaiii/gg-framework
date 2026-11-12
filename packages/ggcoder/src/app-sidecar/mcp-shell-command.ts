import { environmentSecrets, redactText } from "@kenkaiiii/gg-ai";
import type { McpServerChange } from "../core/agent-session.js";
import { log } from "../core/logger.js";
import {
  addServer,
  getServer,
  removeServer,
  globalMcpPath,
  projectMcpPath,
  parseMcpAddCommand,
  McpOAuthStore,
  type MCPScope,
  type MCPServerConfig,
} from "../core/mcp/index.js";
import { splitMcpCommandLine } from "../core/mcp/parse-add-command.js";
import { buildMcpRows, mcpRowSummary, probeMcp, type McpWireRow } from "./mcp-rows.js";
import {
  STDERR_END,
  STDERR_START,
  reopenStderr,
  stripStderrMarks,
  tailOutput,
  type ShellRunEnd,
} from "./shell-runs.js";
import type { SessionRouteContext } from "./route-context.js";

/**
 * `!claude mcp …` / `!ggcoder mcp …` typed in the app's input. Handled here
 * instead of in a shell so the line pasted from an MCP server's docs manages
 * GG Coder's own servers (the same files as the MCP modal), not Claude Code's.
 */
export function isMcpShellCommand(command: string): boolean {
  const line = splitMcpCommandLine(command);
  return line.ok && line.value.prefixed;
}

export interface McpShellDeps {
  cwd: string;
  listRows: (cwd: string) => Promise<McpWireRow[]>;
  probe: typeof probeMcp;
  clearOAuth: (name: string) => Promise<void>;
  /** A project-scope server was added: the user trusts this project's servers. */
  trustProject: (cwd: string) => Promise<void>;
  onAdded: () => void;
  /** Keep a pre-registered OAuth client (and secret) for sign-in. */
  saveOAuthClient: (name: string, clientId: string, secret?: string) => Promise<void>;
  /** Load the saved change into open windows: this one's result, and how many others took it. */
  sync: (name: string) => Promise<{ here: McpServerChange | null; others: number }>;
}

export interface McpShellOutcome {
  exitCode: number;
  /** Output with error lines wrapped in the stderr marks, like a shell run. */
  output: string;
}

class Output {
  text = "";
  line(s = ""): void {
    this.text += `${s}\n`;
  }
  error(s: string): void {
    this.text += `${STDERR_START}${s}\n${STDERR_END}`;
  }
}

const HELP = `Manage GG Coder's MCP servers (same grammar as \`claude mcp\`):

  claude mcp add [--transport http|sse] <name> <url> [--header "K: V"]…
  claude mcp add [--env K=V]… <name> -- <command> [args…]
  claude mcp add-json <name> '<json>'
  claude mcp list
  claude mcp get <name>
  claude mcp remove <name> [--scope local|user]

Scopes (--scope):
  local / project   .gg/mcp.json in this project (default)
  user / global     ~/.gg/mcp.json, for every project

\`ggcoder mcp …\` works the same. To run Claude Code's own CLI instead, use
\`!command claude mcp …\`.`;

function scopeFile(scope: MCPScope, cwd: string): string {
  return scope === "global" ? globalMcpPath() : projectMcpPath(cwd);
}

function scopeFlag(args: string[]): { scope?: MCPScope; rest: string[]; error?: string } {
  const rest: string[] = [];
  let scope: MCPScope | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== "--scope" && arg !== "-s") {
      rest.push(arg);
      continue;
    }
    const value = args[++i]?.toLowerCase();
    if (value === "user" || value === "global") scope = "global";
    else if (value === "local" || value === "project") scope = "project";
    else return { rest, error: `Unknown scope "${value ?? ""}". Use local or user.` };
  }
  return { scope, rest };
}

function mask(value: string): string {
  return value.length <= 8 ? "••••" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function describeConfig(config: MCPServerConfig, out: Output): void {
  if (config.url) {
    out.line(`  transport: ${config.transport ?? "http"}`);
    out.line(`  url:       ${config.url}`);
    for (const [k, v] of Object.entries(config.headers ?? {})) {
      out.line(`  header:    ${k}: ${mask(v)}`);
    }
  } else {
    out.line("  transport: stdio");
    out.line(`  command:   ${mcpRowSummary(config)}`);
    for (const [k, v] of Object.entries(config.env ?? {})) {
      out.line(`  env:       ${k}=${mask(v)}`);
    }
  }
  if (config.timeout) out.line(`  timeout:   ${config.timeout}`);
}

async function add(command: string, deps: McpShellDeps, out: Output): Promise<number> {
  const parsed = parseMcpAddCommand(command);
  if (!parsed.ok) {
    out.error(`✗ ${parsed.error}`);
    return 1;
  }
  const { config } = parsed.value;
  // Claude Code's default scope ("local") is this project only.
  const scope: MCPScope = parsed.value.scope ?? "project";
  const saved = await addServer(config, scope, deps.cwd);
  if (!saved.ok) {
    out.error(`✗ ${saved.error}`);
    return 1;
  }
  if (scope === "project") await deps.trustProject(deps.cwd);
  if (config.oauth?.clientId) {
    await deps.saveOAuthClient(config.name, config.oauth.clientId, parsed.value.clientSecret);
  }
  deps.onAdded();
  out.line(`✓ Added "${config.name}" to ${scope} scope (${scopeFile(scope, deps.cwd)})`);
  const live = await deps.sync(config.name);
  // This window doesn't load MCP (or already had it): still report reachability.
  const status = live.here ?? (await deps.probe(config));
  const tools = `${status.toolCount} tool${status.toolCount === 1 ? "" : "s"}`;
  if (live.here?.connected) {
    out.line(`  Connected — ${tools}, loaded into this session. GG can use them now.`);
  } else if (!live.here && "ok" in status && status.ok) {
    out.line(`  Connected — ${tools}.`);
  } else if (status.requiresAuth) {
    out.line('  Needs sign-in: open the MCP panel and click "Sign in".');
  } else {
    out.error(`  Could not connect: ${status.error ?? "unknown error"} (saved anyway)`);
  }
  if (live.others > 0) {
    out.line(`  Also loaded in ${live.others} other open window${live.others === 1 ? "" : "s"}.`);
  }
  return 0;
}

async function list(deps: McpShellDeps, out: Output): Promise<number> {
  const rows = await deps.listRows(deps.cwd);
  if (rows.length === 0) {
    out.line("No MCP servers configured. Add one with `claude mcp add …`.");
    return 0;
  }
  for (const row of rows) {
    const status = row.ok
      ? `✓ ${row.toolCount} tool${row.toolCount === 1 ? "" : "s"}`
      : row.requiresAuth
        ? "needs sign-in"
        : `✗ ${row.error ?? "failed"}`;
    out.line(`${row.name} (${row.scope})  ${status}`);
    out.line(`  ${row.summary}`);
    if (row.warning) out.error(`  ⚠ ${row.warning.split("\n").join("\n  ⚠ ")}`);
  }
  return 0;
}

async function get(args: string[], deps: McpShellDeps, out: Output): Promise<number> {
  const name = args[0];
  if (!name) {
    out.error("Usage: claude mcp get <name>");
    return 1;
  }
  const found = await getServer(name, deps.cwd);
  if (!found) {
    out.error(`No server named "${name}".`);
    return 1;
  }
  out.line(`${found.config.name} (${found.scope})`);
  describeConfig(found.config, out);
  return 0;
}

async function remove(args: string[], deps: McpShellDeps, out: Output): Promise<number> {
  const flags = scopeFlag(args);
  if (flags.error) {
    out.error(flags.error);
    return 1;
  }
  const name = flags.rest.find((a) => !a.startsWith("-"));
  if (!name) {
    out.error("Usage: claude mcp remove <name> [--scope local|user]");
    return 1;
  }
  const scope = flags.scope ?? (await getServer(name, deps.cwd))?.scope;
  if (!scope || !(await removeServer(name, scope, deps.cwd))) {
    out.error(`No server named "${name}"${flags.scope ? ` in ${flags.scope} scope` : ""}.`);
    return 1;
  }
  // A re-add should start a fresh sign-in.
  await deps.clearOAuth(name).catch(() => {});
  out.line(`✓ Removed "${name}" from ${scope} scope (${scopeFile(scope, deps.cwd)})`);
  const live = await deps.sync(name);
  if (live.here?.removed) out.line("  Unloaded from this session.");
  else if (live.here?.connected) out.line("  This session now uses the other scope's entry.");
  return 0;
}

export async function runMcpShellCommand(
  command: string,
  deps: McpShellDeps,
): Promise<McpShellOutcome> {
  const out = new Output();
  const line = splitMcpCommandLine(command);
  if (!line.ok) {
    out.error(line.error);
    return { exitCode: 1, output: out.text };
  }
  const [sub, ...args] = line.value.args;
  let exitCode: number;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out.line(HELP);
      exitCode = 0;
      break;
    case "add":
    case "add-json":
      exitCode = await add(command, deps, out);
      break;
    case "list":
      exitCode = await list(deps, out);
      break;
    case "get":
      exitCode = await get(args, deps, out);
      break;
    case "remove":
    case "rm":
      exitCode = await remove(args, deps, out);
      break;
    default:
      out.error(`"mcp ${sub}" isn't supported here. Use add, add-json, list, get or remove.`);
      exitCode = 1;
  }
  return { exitCode, output: out.text };
}

/** The command as saved and shown to the agent: env, header and client-secret values hidden. */
export function maskMcpCommand(command: string): string {
  const secrets: string[] = [];
  const line = splitMcpCommandLine(command);
  if (line.ok) {
    secrets.push(...Object.values(line.value.env));
    const args = line.value.args;
    for (let i = 0; i < args.length - 1; i++) {
      const flag = args[i];
      // After `--` it's the server's own command line.
      if (flag === "--") break;
      const value = args[i + 1]!;
      const cut =
        flag === "--env" || flag === "-e"
          ? value.indexOf("=")
          : flag === "--header" || flag === "-H"
            ? value.indexOf(":")
            : -1;
      if (cut > 0) secrets.push(value.slice(cut + 1).trim());
    }
  }
  const parsed = parseMcpAddCommand(command);
  if (parsed.ok) {
    const { config, clientSecret } = parsed.value;
    secrets.push(...Object.values(config.env ?? {}), ...Object.values(config.headers ?? {}));
    if (clientSecret) secrets.push(clientSecret);
  }
  let masked = command;
  // Longest first, so a secret containing another is hidden whole.
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    masked = masked.split(secret).join("••••");
  }
  return redactText(masked);
}

/** Run one `!… mcp …` line for a window and finish it like any other command. */
export async function runMcpShell(
  ctx: SessionRouteContext,
  runId: string,
  command: string,
  finish: (ctx: SessionRouteContext, run: ShellRunEnd) => void,
): Promise<void> {
  const startedAt = Date.now();
  let outcome: McpShellOutcome;
  try {
    outcome = await runMcpShellCommand(command, {
      cwd: ctx.cwd,
      listRows: (cwd) => buildMcpRows(cwd, ctx.paths.settingsFile),
      probe: probeMcp,
      clearOAuth: (name) => new McpOAuthStore().clear(name),
      saveOAuthClient: (name, clientId, secret) =>
        new McpOAuthStore().setClient(name, clientId, secret),
      trustProject: (cwd) => ctx.session.trustProject(cwd),
      onAdded: () => void ctx.trophies.count("mcpServersAdded", ctx.sessionId),
      sync: async (name) => {
        const all = await ctx.syncMcpServer(name);
        const others = [...all].filter(([id, change]) => id !== ctx.sessionId && change).length;
        return { here: all.get(ctx.sessionId) ?? null, others };
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("WARN", "app-sidecar", "mcp shell command failed", { message });
    outcome = { exitCode: 1, output: `${STDERR_START}${message}\n${STDERR_END}` };
  }
  const display = redactText(outcome.output, { secrets: environmentSecrets(process.env) });
  if (display) ctx.broadcast("shell_output", { id: runId, chunk: display });
  const cut = tailOutput(reopenStderr(display));
  const displayTail = reopenStderr(cut.text);
  finish(ctx, {
    runId,
    command: maskMcpCommand(command),
    cwd: ctx.cwd,
    exitCode: outcome.exitCode,
    signal: null,
    durationMs: Math.max(0, Date.now() - startedAt),
    cancelled: false,
    tail: stripStderrMarks(displayTail).replace(/\s+$/, ""),
    displayTail,
    tailTruncated: cut.truncated,
    displayTruncated: false,
  });
}
