import type { MCPServerConfig } from "./types.js";
import { fromStoredEntry, parseStoredEntry, type MCPScope } from "./store.js";

/** Zero-dep discriminated-union result for expected parse failures. */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface ParsedAddCommand {
  config: MCPServerConfig;
  /** Requested scope, if the input carried a --scope flag. */
  scope?: MCPScope;
  /** OAuth client secret (`--client-secret`, read from MCP_CLIENT_SECRET). Never written to mcp.json. */
  clientSecret?: string;
}

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/**
 * Shell-style tokenizer: splits on whitespace but respects single/double
 * quotes and backslash escapes. Good enough for `claude mcp add …` lines.
 */
export function tokenize(input: string): Result<string[], string> {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\" && !inSingle) {
      const next = input[i + 1];
      // Backslash-newline is a line continuation, as in a shell.
      if (next === "\n" || (next === "\r" && input[i + 2] === "\n")) {
        i += next === "\n" ? 1 : 2;
        continue;
      }
      if (next !== undefined) {
        current += next;
        hasToken = true;
        i++;
        continue;
      }
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      hasToken = true;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      hasToken = true;
      continue;
    }
    if ((ch === " " || ch === "\t" || ch === "\n") && !inSingle && !inDouble) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }

  if (inSingle || inDouble) {
    return { ok: false, error: "Unbalanced quote in the command." };
  }
  if (hasToken) tokens.push(current);
  return { ok: true, value: tokens };
}

type Transport = "stdio" | "http" | "sse";

function normalizeTransport(value: string): Result<Transport | "ws", string> {
  const v = value.toLowerCase();
  if (v === "stdio") return { ok: true, value: "stdio" };
  if (v === "http" || v === "streamable-http") return { ok: true, value: "http" };
  if (v === "sse") return { ok: true, value: "sse" };
  if (v === "ws" || v === "websocket") return { ok: true, value: "ws" };
  return { ok: false, error: `Unknown transport "${value}". Use stdio, http, or sse.` };
}

function mapScope(value: string): Result<MCPScope, string> {
  const v = value.toLowerCase();
  if (v === "user" || v === "global") return { ok: true, value: "global" };
  if (v === "local" || v === "project") return { ok: true, value: "project" };
  return { ok: false, error: `Unknown scope "${value}". Use local, project, or user.` };
}

/** A pasted `claude mcp …` / `ggcoder mcp …` line, split into words. */
export interface McpCommandLine {
  /** `VAR=value` assignments in front of the command (e.g. MCP_CLIENT_SECRET). */
  env: Record<string, string>;
  /** Whether the line started with `claude mcp` / `ggcoder mcp`. */
  prefixed: boolean;
  /** The words after `mcp` (or every word, when not prefixed). */
  args: string[];
}

/**
 * Split a line the way a shell would, dropping a pasted `$ ` prompt and
 * collecting leading `VAR=value` assignments.
 */
export function splitMcpCommandLine(input: string): Result<McpCommandLine, string> {
  const tokenized = tokenize(input.trim().replace(/^\$\s+/, ""));
  if (!tokenized.ok) return tokenized;
  const tokens = tokenized.value;
  const env: Record<string, string> = {};
  while (tokens.length > 0) {
    const match = ASSIGNMENT.exec(tokens[0]!);
    if (!match) break;
    env[match[1]!] = match[2]!;
    tokens.shift();
  }
  const prefixed =
    tokens.length >= 2 && /^(claude|ggcoder)$/i.test(tokens[0]!) && tokens[1] === "mcp";
  return { ok: true, value: { env, prefixed, args: prefixed ? tokens.slice(2) : tokens } };
}

/**
 * Parse a pasted `claude mcp add …` / `claude mcp add-json …` line (or just
 * the args after `add`) into an MCPServerConfig + requested scope.
 *
 * Grammar matches Claude Code:
 *   add [--transport t] [--env K=V]… [--header "K: V"]… [--scope s] <name> -- <command> [args…]
 *   add [options] <name> <command> [args…]          (stdio without `--`)
 *   add --transport http|sse <name> <url> [--header "K: V"]…
 *       [--client-id id] [--client-secret] [--callback-port n]
 *   add-json [--scope s] [--client-secret] <name> '<json>'
 * `--client-secret` takes the secret from MCP_CLIENT_SECRET=… in front of the
 * command, which is how Claude Code skips its interactive prompt.
 */
export function parseMcpAddCommand(input: string): Result<ParsedAddCommand, string> {
  const line = splitMcpCommandLine(input);
  if (!line.ok) return line;
  const { env, prefixed, args } = line.value;
  if (!prefixed) return parseAddArgs(args, env);
  if (args[0] === "add") return parseAddArgs(args.slice(1), env);
  if (args[0] === "add-json") return parseAddJsonArgs(args.slice(1), env);
  return { ok: false, error: 'Expected "mcp add" or "mcp add-json".' };
}

function checkName(name: string | undefined): Result<string, string> {
  if (!name) return { ok: false, error: "Missing server name." };
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error: `Invalid server name "${name}". Use only letters, numbers, hyphens, and underscores.`,
    };
  }
  return { ok: true, value: name };
}

function clientSecretFrom(env: Record<string, string>): Result<string, string> {
  const secret = env.MCP_CLIENT_SECRET;
  if (secret) return { ok: true, value: secret };
  return {
    ok: false,
    error:
      "--client-secret needs the secret. Put it in front of the command: " +
      "MCP_CLIENT_SECRET=<secret> claude mcp add …",
  };
}

function finish(
  config: MCPServerConfig,
  scope: MCPScope | undefined,
  clientSecret: string | undefined,
): Result<ParsedAddCommand, string> {
  if (clientSecret && !config.oauth?.clientId) {
    return { ok: false, error: "--client-secret needs --client-id." };
  }
  return {
    ok: true,
    value: {
      config,
      ...(scope === undefined ? {} : { scope }),
      ...(clientSecret ? { clientSecret } : {}),
    },
  };
}

function parseAddArgs(
  tokens: string[],
  lineEnv: Record<string, string>,
): Result<ParsedAddCommand, string> {
  if (tokens.length === 0) {
    return { ok: false, error: "Nothing to parse — provide a server name and command or URL." };
  }

  let transport: Transport | "ws" | undefined;
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let scope: MCPScope | undefined;
  let timeout: number | undefined;
  let clientId: string | undefined;
  let callbackPort: number | undefined;
  let wantsSecret = false;
  let name: string | undefined;
  const positionals: string[] = [];
  let commandArgv: string[] | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;

    // `--` ends option parsing; remainder is the literal spawn argv.
    if (tok === "--") {
      commandArgv = tokens.slice(i + 1);
      break;
    }

    const needNext = (label: string): Result<string, string> => {
      const next = tokens[i + 1];
      if (next === undefined) return { ok: false, error: `${label} expects a value.` };
      i++;
      return { ok: true, value: next };
    };

    if (tok === "--transport" || tok === "-t") {
      const next = needNext(tok);
      if (!next.ok) return next;
      const t = normalizeTransport(next.value);
      if (!t.ok) return t;
      transport = t.value;
      continue;
    }
    if (tok === "--env" || tok === "-e") {
      const next = needNext(tok);
      if (!next.ok) return next;
      const eq = next.value.indexOf("=");
      if (eq <= 0) return { ok: false, error: `Invalid --env "${next.value}". Use KEY=VALUE.` };
      env[next.value.slice(0, eq)] = next.value.slice(eq + 1);
      continue;
    }
    if (tok === "--header" || tok === "-H") {
      const next = needNext(tok);
      if (!next.ok) return next;
      const colon = next.value.indexOf(":");
      if (colon <= 0) {
        return { ok: false, error: `Invalid --header "${next.value}". Use "Name: Value".` };
      }
      headers[next.value.slice(0, colon).trim()] = next.value.slice(colon + 1).trim();
      continue;
    }
    if (tok === "--scope" || tok === "-s") {
      const next = needNext(tok);
      if (!next.ok) return next;
      const s = mapScope(next.value);
      if (!s.ok) return s;
      scope = s.value;
      continue;
    }
    if (tok === "--timeout") {
      const next = needNext(tok);
      if (!next.ok) return next;
      const n = Number(next.value);
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, error: `Invalid --timeout "${next.value}".` };
      }
      timeout = n;
      continue;
    }
    if (tok === "--client-id") {
      const next = needNext(tok);
      if (!next.ok) return next;
      clientId = next.value;
      continue;
    }
    if (tok === "--callback-port") {
      const next = needNext(tok);
      if (!next.ok) return next;
      const port = Number(next.value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, error: `Invalid --callback-port "${next.value}".` };
      }
      callbackPort = port;
      continue;
    }
    if (tok === "--client-secret") {
      wantsSecret = true;
      continue;
    }
    if (tok.startsWith("-")) {
      return { ok: false, error: `Unknown option "${tok}".` };
    }

    // First non-flag token is the name.
    if (name === undefined) {
      name = tok;
      continue;
    }
    // `add <name> <command> [args…]` without `--`: like Claude Code, the rest
    // is the server's own command line, flags included.
    if (
      positionals.length === 0 &&
      (transport === undefined || transport === "stdio") &&
      !/^https?:\/\//i.test(tok)
    ) {
      commandArgv = tokens.slice(i);
      break;
    }
    positionals.push(tok);
  }

  const named = checkName(name);
  if (!named.ok) return named;

  if (transport === "ws") {
    return { ok: false, error: "WebSocket transport isn't supported yet." };
  }

  let clientSecret: string | undefined;
  if (wantsSecret) {
    const secret = clientSecretFrom(lineEnv);
    if (!secret.ok) return secret;
    clientSecret = secret.value;
  }

  const effectiveTransport: Transport =
    transport ?? (commandArgv ? "stdio" : positionals.length > 0 ? "http" : "stdio");

  const config: MCPServerConfig = { name: named.value };
  if (timeout !== undefined) config.timeout = timeout;

  if (effectiveTransport === "http" || effectiveTransport === "sse") {
    const url = positionals[0];
    if (!url) {
      return {
        ok: false,
        error: `The ${effectiveTransport} transport requires a URL after the name.`,
      };
    }
    config.url = url;
    config.transport = effectiveTransport;
    if (Object.keys(headers).length > 0) config.headers = headers;
    if (clientId || callbackPort) {
      config.oauth = {
        ...(clientId ? { clientId } : {}),
        ...(callbackPort ? { callbackPort } : {}),
      };
    }
  } else {
    // stdio
    if (!commandArgv || commandArgv.length === 0) {
      return {
        ok: false,
        error: "stdio servers need a command after `--`, e.g. `name -- npx -y some-mcp-server`.",
      };
    }
    config.command = commandArgv[0];
    if (commandArgv.length > 1) config.args = commandArgv.slice(1);
    if (Object.keys(env).length > 0) config.env = env;
  }

  return finish(config, scope, clientSecret);
}

function parseAddJsonArgs(
  tokens: string[],
  lineEnv: Record<string, string>,
): Result<ParsedAddCommand, string> {
  let scope: MCPScope | undefined;
  let wantsSecret = false;
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "--scope" || tok === "-s") {
      const value = tokens[++i];
      if (value === undefined) return { ok: false, error: `${tok} expects a value.` };
      const s = mapScope(value);
      if (!s.ok) return s;
      scope = s.value;
    } else if (tok === "--client-secret") {
      wantsSecret = true;
    } else if (tok.startsWith("-") && !tok.startsWith("-{")) {
      return { ok: false, error: `Unknown option "${tok}".` };
    } else {
      positionals.push(tok);
    }
  }
  const named = checkName(positionals[0]);
  if (!named.ok) return named;
  const json = positionals[1];
  if (!json) return { ok: false, error: "add-json needs the server's JSON after the name." };
  if (positionals.length > 2) {
    return { ok: false, error: "Wrap the JSON in single quotes so it stays one argument." };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: "The server JSON isn't valid JSON." };
  }
  const entry = parseStoredEntry(raw);
  if (!entry.ok) return entry;
  if (entry.value.type === "sse" || entry.value.type === "http" || entry.value.url) {
    if (!entry.value.url) return { ok: false, error: 'An http/sse server needs a "url".' };
  } else if (!entry.value.command) {
    return { ok: false, error: 'The server JSON needs a "command" or a "url".' };
  }
  let clientSecret: string | undefined;
  if (wantsSecret) {
    const secret = clientSecretFrom(lineEnv);
    if (!secret.ok) return secret;
    clientSecret = secret.value;
  }
  return finish(fromStoredEntry(named.value, entry.value), scope, clientSecret);
}
