import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { z } from "zod";
import http from "node:http";
import os from "node:os";
import { log } from "../logger.js";
import type { MCPServerConfig } from "./types.js";
import {
  McpOAuthProvider,
  MCP_OAUTH_CALLBACK_PORT,
  MCP_OAUTH_CALLBACK_PATH,
} from "./oauth-provider.js";
import { McpOAuthStore } from "./oauth-store.js";

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport;
  lastCallTime: number;
}

/** Per-server connection outcome for the dashboard / non-interactive list. */
export interface MCPConnectResult {
  name: string;
  ok: boolean;
  toolCount: number;
  tools: AgentTool[];
  error?: string;
  /** True when the server returned 401/Unauthorized and an OAuth login is
   *  required before it can connect. The UI surfaces this as "requires login". */
  requiresAuth?: boolean;
}

/** Outcome of an interactive remote-MCP OAuth login. */
export interface MCPLoginResult {
  ok: boolean;
  toolCount: number;
  error?: string;
}

export class MCPClientManager {
  private servers: ConnectedServer[] = [];

  async connectAll(configs: MCPServerConfig[]): Promise<AgentTool[]> {
    const results = await this.connectAllDetailed(configs);
    return results.flatMap((r) => r.tools);
  }

  /**
   * Connect every enabled server and return one result per server (success →
   * ok + toolCount; failure → ok:false with a human-readable error string).
   * Keeps successfully connected servers in `this.servers`.
   */
  async connectAllDetailed(configs: MCPServerConfig[]): Promise<MCPConnectResult[]> {
    const enabled = configs.filter((c) => c.enabled !== false);
    if (enabled.length === 0) return [];

    const settled = await Promise.allSettled(enabled.map((c) => this.connectServer(c)));

    const results: MCPConnectResult[] = settled.map((result, i) => {
      const name = enabled[i].name;
      if (result.status === "fulfilled") {
        return { name, ok: true, toolCount: result.value.length, tools: result.value };
      }
      const requiresAuth = isUnauthorized(result.reason);
      const error = requiresAuth ? "Requires login." : formatConnectError(result.reason);
      log("WARN", "mcp", `Failed to connect to MCP server "${name}"`, { error });
      return { name, ok: false, toolCount: 0, tools: [], error, requiresAuth };
    });

    const connected = results.filter((r) => r.ok).length;
    const toolCount = results.reduce((sum, r) => sum + r.toolCount, 0);
    log("INFO", "mcp", `Connected ${connected} MCP server(s), ${toolCount} tool(s)`);
    return results;
  }

  /**
   * Connect a single server, list its tools, then close that client so the
   * probe connection doesn't accumulate in `this.servers`. Used to validate a
   * server before persisting it.
   */
  async probe(config: MCPServerConfig): Promise<MCPConnectResult> {
    try {
      const tools = await this.connectServer(config);
      const server = this.servers.find((s) => s.name === config.name);
      if (server) {
        this.servers = this.servers.filter((s) => s !== server);
        try {
          await server.client.close();
        } catch {
          // Ignore close errors during probe teardown.
        }
      }
      return { name: config.name, ok: true, toolCount: tools.length, tools };
    } catch (err) {
      const requiresAuth = isUnauthorized(err);
      const error = requiresAuth ? "Requires login." : formatConnectError(err);
      return { name: config.name, ok: false, toolCount: 0, tools: [], error, requiresAuth };
    }
  }

  /**
   * Run the interactive OAuth login for one remote MCP server end-to-end:
   * start a loopback callback server, let the SDK open the browser via
   * `onAuthorizationUrl`, capture the redirect, exchange the code, then verify
   * the authorized connection by listing tools. Tokens are persisted by the
   * provider so later (non-interactive) connects succeed silently.
   *
   * `onAuthorizationUrl` is invoked with the authorize URL so the host can open
   * it (the gg-app broadcasts it to the webview, which opens the system
   * browser; the CLI prints it). Never throws — returns `{ ok:false, error }`.
   */
  async login(
    config: MCPServerConfig,
    onAuthorizationUrl: (url: string) => void,
    timeoutMs = 180_000,
  ): Promise<MCPLoginResult> {
    if (!config.url) {
      return { ok: false, toolCount: 0, error: "Login is only supported for HTTP MCP servers." };
    }
    const url = new URL(config.url);
    const store = new McpOAuthStore();
    // Fresh PKCE/state for this attempt so a previous half-finished login can't
    // poison the exchange.
    await store.patch(config.name, { codeVerifier: undefined, state: undefined });

    let codeResolve: ((code: string) => void) | undefined;
    let codeReject: ((err: Error) => void) | undefined;
    const codePromise = new Promise<string>((resolve, reject) => {
      codeResolve = resolve;
      codeReject = reject;
    });

    const provider = new McpOAuthProvider({
      serverName: config.name,
      store,
      onRedirect: (authUrl) => onAuthorizationUrl(authUrl.toString()),
    });
    const expectedState = await provider.state();

    // Loopback server that receives the OAuth redirect. Bound to the fixed
    // callback port that the registered redirect_uri points at.
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || "", `http://localhost:${MCP_OAUTH_CALLBACK_PORT}`);
      if (reqUrl.pathname !== MCP_OAUTH_CALLBACK_PATH) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const err = reqUrl.searchParams.get("error");
      const code = reqUrl.searchParams.get("code");
      const state = reqUrl.searchParams.get("state");
      res.writeHead(200, { "Content-Type": "text/html" });
      if (err) {
        res.end(`<html><body><h1>Login failed</h1><p>${escapeHtml(err)}</p></body></html>`);
        codeReject?.(new Error(`Authorization failed: ${err}`));
        return;
      }
      if (!code) {
        res.end("<html><body><h1>Login failed</h1><p>No authorization code.</p></body></html>");
        codeReject?.(new Error("No authorization code in callback."));
        return;
      }
      if (state !== expectedState) {
        res.end("<html><body><h1>Login failed</h1><p>State mismatch.</p></body></html>");
        codeReject?.(new Error("OAuth state mismatch."));
        return;
      }
      res.end(
        "<html><body><h1>Login successful!</h1><p>You can close this tab and return to GG Coder.</p></body></html>",
      );
      codeResolve?.(code);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(MCP_OAUTH_CALLBACK_PORT, "127.0.0.1", () => resolve());
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint =
        msg.includes("EADDRINUSE") || msg.includes("in use")
          ? `Port ${MCP_OAUTH_CALLBACK_PORT} is in use — close whatever is using it and retry.`
          : msg;
      return { ok: false, toolCount: 0, error: `Could not start login callback server: ${hint}` };
    }

    const overallTimeout = setTimeout(() => {
      codeReject?.(new Error("Login timed out waiting for the browser callback."));
    }, timeoutMs);
    overallTimeout.unref();

    try {
      // First connect triggers the redirect (browser opens) then throws
      // UnauthorizedError — that's the expected, not a failure.
      const loginTransport = new StreamableHTTPClientTransport(url, {
        requestInit: config.headers ? { headers: config.headers } : undefined,
        authProvider: provider,
      });
      const loginClient = new Client({ name: "ggcoder", version: "1.0.0" });
      try {
        await loginClient.connect(loginTransport);
        // Already authorized (had valid tokens) — nothing more to do.
        const { tools } = await loginClient.listTools();
        await loginClient.close().catch(() => {});
        return { ok: true, toolCount: tools.length };
      } catch (err) {
        if (!isUnauthorized(err)) throw err;
      }

      const code = await codePromise;
      // Exchange the code for tokens (persisted via provider.saveTokens).
      await loginTransport.finishAuth(code);
      await loginClient.close().catch(() => {});

      // Verify the authorized connection on a fresh transport + list tools.
      const verifyTransport = new StreamableHTTPClientTransport(url, {
        requestInit: config.headers ? { headers: config.headers } : undefined,
        authProvider: provider,
      });
      const verifyClient = new Client({ name: "ggcoder", version: "1.0.0" });
      await verifyClient.connect(verifyTransport);
      const { tools } = await verifyClient.listTools();
      await verifyClient.close().catch(() => {});
      return { ok: true, toolCount: tools.length };
    } catch (err) {
      return { ok: false, toolCount: 0, error: formatConnectError(err) };
    } finally {
      clearTimeout(overallTimeout);
      server.close();
      // Clear the now-consumed in-flight PKCE/state so the store only keeps tokens.
      await store.patch(config.name, { codeVerifier: undefined, state: undefined });
    }
  }

  private async connectServer(config: MCPServerConfig): Promise<AgentTool[]> {
    const timeout = config.timeout ?? 30_000;
    let client: Client;
    let transport: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport;

    if (config.command) {
      // Stdio transport for local processes.
      // cwd is forced to homedir so the user's working directory can't
      // affect resolution. e.g. running ggcoder from a folder whose
      // package.json names the same package as the MCP server makes
      // `npx -y <pkg>` self-resolve to the local source (no built bin
      // shim) and fail with "command not found".
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...process.env, ...config.env } as Record<string, string>,
        cwd: os.homedir(),
        stderr: "pipe",
      });
      // Capture stderr so a crashing server doesn't fail silently — when the
      // child closes the pipe before completing handshake, the SDK throws
      // the opaque "-32000 Connection closed" but the real cause (stack
      // trace, missing dep, port conflict) was just printed to stderr.
      const stderrChunks: string[] = [];
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      });
      client = new Client({ name: "ggcoder", version: "1.0.0" });
      try {
        await client.connect(transport, { timeout });
      } catch (err) {
        const stderr = stderrChunks.join("").slice(-4000);
        if (stderr.trim()) {
          log("WARN", "mcp", `stdio child stderr for "${config.name}"`, { stderr });
        }
        throw err;
      }
    } else {
      // HTTP transport — try StreamableHTTP first, fall back to SSE. An OAuth
      // provider (no `onRedirect`) is always attached: if the server has saved
      // tokens it connects/refreshes silently; if it needs auth the SDK throws
      // UnauthorizedError, which the caller maps to `requiresAuth`.
      const url = new URL(config.url!);
      const reqInit = config.headers ? { headers: config.headers } : undefined;
      const authProvider = new McpOAuthProvider({ serverName: config.name });

      try {
        transport = new StreamableHTTPClientTransport(url, {
          requestInit: reqInit,
          authProvider,
        });
        client = new Client({ name: "ggcoder", version: "1.0.0" });
        await client.connect(transport, { timeout });
      } catch (streamableErr) {
        // A 401 isn't a transport mismatch — don't waste time on the SSE
        // fallback, just surface that login is required.
        if (isUnauthorized(streamableErr)) throw streamableErr;
        log("INFO", "mcp", `StreamableHTTP failed for "${config.name}", trying SSE fallback`, {
          error: String(streamableErr),
        });
        transport = new SSEClientTransport(url, {
          eventSourceInit: config.headers
            ? { fetch: createHeaderFetch(config.headers) }
            : undefined,
          requestInit: reqInit,
          authProvider,
        });
        client = new Client({ name: "ggcoder", version: "1.0.0" });
        await client.connect(transport, { timeout });
      }
    }

    this.servers.push({ name: config.name, client, transport, lastCallTime: 0 });

    const { tools } = await client.listTools(undefined, { timeout });

    return tools.map((tool): AgentTool => {
      const toolName = `mcp__${config.name}__${tool.name}`;
      return {
        name: toolName,
        description: tool.description ?? "",
        parameters: z.record(z.string(), z.unknown()),
        rawInputSchema: tool.inputSchema as Record<string, unknown>,
        execute: async (args) => {
          const server = this.servers.find((s) => s.name === config.name);
          if (server) {
            const elapsed = Date.now() - server.lastCallTime;
            const minGap = 2_000;
            if (elapsed < minGap) {
              await new Promise((r) => setTimeout(r, minGap - elapsed));
            }
            server.lastCallTime = Date.now();
          }

          try {
            const result = await client.callTool(
              { name: tool.name, arguments: args as Record<string, unknown> },
              undefined,
              { timeout: config.timeout ?? 60_000 },
            );
            if (!("content" in result) || !Array.isArray(result.content)) {
              return "(empty response)";
            }
            const texts: string[] = [];
            for (const item of result.content) {
              if (
                item != null &&
                typeof item === "object" &&
                "text" in item &&
                typeof item.text === "string"
              ) {
                texts.push(item.text);
              }
            }
            return texts.join("\n") || "(empty response)";
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("Too Many R") || msg.includes("429")) {
              return "Rate limited — too many requests. Wait a moment before searching again.";
            }
            return `MCP tool error: ${msg}`;
          }
        },
      };
    });
  }

  async dispose(): Promise<void> {
    for (const server of this.servers) {
      try {
        await server.client.close();
      } catch {
        // Ignore close errors
      }
    }
    this.servers = [];
  }
}

/**
 * Create a custom fetch wrapper that injects extra headers into every request.
 * Used for SSEClientTransport's eventSourceInit to pass auth headers
 * on the initial SSE GET connection (which doesn't use requestInit).
 */
/**
 * Turn a thrown connection error into a short human-readable string. Surfaces
 * the common rate-limit case explicitly; otherwise the underlying message.
 */
function formatConnectError(reason: unknown): string {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (msg.includes("Too Many R") || msg.includes("429")) {
    return "Rate limited (429) — try again in a moment.";
  }
  return msg;
}

/**
 * Whether a connect error means the server needs OAuth login. The SDK throws
 * its typed `UnauthorizedError` when auth is required, but a raw 401 from the
 * initial request (before the auth machinery engages) can also surface as a
 * plain error message — so we check both.
 */
function isUnauthorized(reason: unknown): boolean {
  if (reason instanceof UnauthorizedError) return true;
  const msg = reason instanceof Error ? reason.message : String(reason);
  return (
    msg.includes("Unauthorized") ||
    msg.includes("401") ||
    msg.toLowerCase().includes("invalid_token")
  );
}

/** Minimal HTML-escape for echoing an OAuth error string into the callback page. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createHeaderFetch(extraHeaders: Record<string, string>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (url: string | URL, init: any): Promise<Response> => {
    const existing = (init?.headers ?? {}) as Record<string, string>;
    return fetch(url, { ...init, headers: { ...existing, ...extraHeaders } });
  };
}
