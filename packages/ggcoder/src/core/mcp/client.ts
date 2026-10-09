import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  Client,
  OAuthError,
  OAuthErrorCode,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  SSEClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";
import type { AgentTool, ToolContext, ToolExecuteResult } from "@kenkaiiii/gg-agent";
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
import { isLocalhost, alternateLoopback, isNetworkError } from "./loopback.js";
import { toToolResult } from "./content.js";
import { resolveStdioCommand } from "./resolve-stdio.js";
import { McpCatalogCache, type ProtocolEra } from "./catalog-cache.js";
import {
  isShareableServer,
  sharedMcpPool,
  type SharedMcpPool,
  type SharedServerHandle,
} from "./shared-pool.js";

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport;
  lastCallTime: number;
  /** The config this connection was built from, kept so an expired HTTP session
   *  can be rebuilt without going back to the caller for it. */
  config: MCPServerConfig;
}

/**
 * How long a stdio server may sit with no call in flight before its process is
 * stopped. It is respawned transparently on the next call.
 *
 * 15 min, deliberately longer than pi-mcp-adapter's 10 min default: one pooled
 * child here serves every window in the daemon, so a premature stop is paid as
 * a cold start (`npx`/node boot + handshake, often seconds) by whichever chat
 * calls next. 15 min still covers the read/think/edit pauses inside one task
 * while reclaiming servers a session touched once and moved on from.
 */
export const MCP_DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;

/**
 * Default per-call window without a response or progress notification. Equal
 * to the SDK's own `DEFAULT_REQUEST_TIMEOUT_MSEC`; `config.timeout` overrides.
 */
export const MCP_DEFAULT_CALL_TIMEOUT_MS = 60_000;

/**
 * Default hard cap on one tool call, however much progress it reports — so a
 * server stuck in a progress loop cannot hold a turn forever. Generous because
 * the tools that report progress are the long ones (builds, crawls, renders);
 * `config.maxTotalTimeout` overrides.
 */
export const MCP_DEFAULT_MAX_TOTAL_TIMEOUT_MS = 30 * 60_000;

/** Per-server idle-shutdown bookkeeping (stdio servers without `keepAlive`). */
interface IdleState {
  /** Tool calls currently in flight. A server is never stopped while > 0. */
  inFlight: number;
  timer?: ReturnType<typeof setTimeout>;
  /** A respawn in progress, shared by every call that arrives meanwhile. */
  restarting?: Promise<void>;
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

/**
 * A failed MCP tool call. Thrown (not returned as text) so the agent loop
 * records the result as an error: the app shows it as failed and receipts,
 * the loop breaker and verification all see a failure, not a success whose
 * text happens to say "error". The message is what the model reads.
 */
export class McpToolError extends Error {
  override readonly name = "McpToolError";
}

/** Text parts of a tool result, joined, for an error message. */
function resultText(result: ToolExecuteResult): string {
  if (typeof result === "string") return result;
  if (typeof result.content === "string") return result.content;
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Terminal state of one server's connection attempt, awaited by `whenConnected`. */
type ConnectionOutcome = { ok: true } | { ok: false; error: string };

/**
 * A server-initiated request for user input, mid tool call. The host resolves
 * it by showing the user a form built from `requestedSchema` and returning
 * their answer — or `decline` / `cancel`.
 */
export interface MCPElicitation {
  /** Which configured server is asking. */
  server: string;
  /** Human-readable prompt from the server. */
  message: string;
  /** JSON Schema object describing the fields to collect. */
  requestedSchema: Record<string, unknown>;
}

export type MCPElicitHandler = (request: MCPElicitation) => Promise<ElicitResult>;

export class MCPClientManager {
  private servers: ConnectedServer[] = [];
  /**
   * Per-server connection settlement, so a caller holding a cached-only tool
   * can wait for the live client instead of failing or hanging forever.
   */
  private connections = new Map<
    string,
    { promise: Promise<ConnectionOutcome>; settle: (outcome: ConnectionOutcome) => void }
  >();

  /**
   * In-flight session rebuilds, keyed by server name. N tool calls to the same
   * server all 404 at once when its session expires; without coalescing each
   * would spawn its own reconnect and they would race to replace each other in
   * `this.servers`. Sharing one promise means exactly one reconnect per outage.
   */
  private reconnecting = new Map<string, Promise<void>>();

  /**
   * Claims on process-wide shared connections, keyed by server name. Held so
   * `dispose` can hand them back: the pooled child only exits once the LAST
   * manager holding it releases, so leaking a claim here would pin the process
   * for the daemon's lifetime — the exact bug sharing is meant to fix.
   */
  private sharedHandles = new Map<string, SharedServerHandle>();

  private readonly catalogCache: McpCatalogCache;
  /**
   * Opt into the 2026-07-28 revision. Off by default: `mode: "auto"` probes with
   * `server/discover` before falling back to `initialize`, and a legacy stdio
   * server that ignores pre-`initialize` requests pays the full probe timeout.
   */
  private readonly modernProtocol: boolean;

  /**
   * Host callback for server-initiated `elicitation/create`. Absent means we
   * declare no elicitation capability at all — which is protocol-legal and is
   * how the CLI runs, since it has nowhere to render the form.
   */
  private readonly onElicit?: MCPElicitHandler;

  /**
   * Pool backing `shared: true` servers. Defaults to the daemon-wide singleton;
   * injectable so tests can exercise sharing without touching global state.
   */
  private readonly pool: SharedMcpPool;

  /**
   * Fired when a connected server's transport closes on its own — a crashed or
   * exited child, not our own `dispose`. The pool uses it to drop a dead
   * connection so the next session rebuilds instead of inheriting a corpse.
   */
  private readonly onServerClosed?: (name: string) => void;

  /** Set while `dispose` runs, so our own teardown is not reported as a death. */
  private disposing = false;

  /** Idle period before a stdio server is stopped; 0 disables idle shutdown. */
  private readonly idleTimeoutMs: number;

  /** Idle bookkeeping per server name, for servers eligible for idle shutdown. */
  private idle = new Map<string, IdleState>();

  /**
   * Clients we closed ON PURPOSE for idleness. Their `onclose` must not be
   * reported as a death — that would make the pool evict a connection whose
   * tools are still published and which will respawn on the next call.
   */
  private idleStopped = new WeakSet<Client>();

  constructor(
    opts: {
      catalogCache?: McpCatalogCache;
      modernProtocol?: boolean;
      onElicit?: MCPElicitHandler;
      sharedPool?: SharedMcpPool;
      onServerClosed?: (name: string) => void;
      /** Override `MCP_DEFAULT_IDLE_TIMEOUT_MS`; 0 disables idle shutdown. */
      idleTimeoutMs?: number;
    } = {},
  ) {
    this.catalogCache = opts.catalogCache ?? new McpCatalogCache();
    this.modernProtocol = opts.modernProtocol ?? false;
    this.onElicit = opts.onElicit;
    this.pool = opts.sharedPool ?? sharedMcpPool;
    this.onServerClosed = opts.onServerClosed;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? MCP_DEFAULT_IDLE_TIMEOUT_MS;
  }

  /**
   * Does this server get stopped when idle?
   *
   * Only stdio servers: idle shutdown exists to reclaim a child PROCESS, and an
   * HTTP server has none on our side. Closing one would save nothing locally
   * while throwing away its `Mcp-Session-Id` (server-side state) and forcing a
   * fresh handshake — possibly an OAuth refresh — on the next call.
   * `keepAlive: true` opts a stdio server out for state held in its process.
   */
  private idleEligible(config: MCPServerConfig): boolean {
    return this.idleTimeoutMs > 0 && Boolean(config.command) && config.keepAlive !== true;
  }

  private idleState(name: string): IdleState {
    let state = this.idle.get(name);
    if (!state) {
      state = { inFlight: 0 };
      this.idle.set(name, state);
    }
    return state;
  }

  /** (Re)start the idle countdown for a server, unless a call is in flight. */
  private armIdleTimer(config: MCPServerConfig): void {
    if (this.disposing || !this.idleEligible(config)) return;
    const state = this.idleState(config.name);
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    if (state.inFlight > 0) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.stopIdleServer(config.name);
    }, this.idleTimeoutMs);
    // An idle countdown must never be what keeps the CLI/daemon alive.
    state.timer.unref?.();
  }

  /**
   * Stop an idle server's process, keeping its published tools. The entry is
   * removed from `this.servers` synchronously, so a call landing during the
   * close sees "not running" and respawns rather than using a closing client.
   */
  private async stopIdleServer(name: string): Promise<void> {
    const state = this.idle.get(name);
    if (this.disposing || !state || state.inFlight > 0 || state.restarting) return;
    const server = this.servers.find((s) => s.name === name);
    if (!server) return;
    this.servers = this.servers.filter((s) => s !== server);
    this.idleStopped.add(server.client);
    log("INFO", "mcp", `Stopping idle MCP server "${name}" (restarts on next call)`);
    try {
      await server.client.close();
    } catch {
      // Already gone; nothing to reclaim.
    }
  }

  /**
   * Make sure an idle-stopped server is running again before a call. Concurrent
   * calls share one respawn. The fresh tool list is persisted to the catalog
   * cache by `connectServer` but NOT republished: the model keeps the tools it
   * already has, so a stop/restart cycle never churns the prompt.
   */
  private async ensureRunning(config: MCPServerConfig): Promise<void> {
    if (this.servers.some((s) => s.name === config.name)) return;
    const state = this.idleState(config.name);
    if (!state.restarting) {
      log("INFO", "mcp", `Restarting idle-stopped MCP server "${config.name}"`);
      state.restarting = this.connectServer(config, { restart: true }).then(
        () => {
          state.restarting = undefined;
        },
        (err: unknown) => {
          state.restarting = undefined;
          throw err;
        },
      );
    }
    await state.restarting;
  }

  /** Is this server's connection currently live? Diagnostic/test use. */
  isServerRunning(name: string): boolean {
    return this.servers.some((s) => s.name === name);
  }

  /**
   * Build a `Client` for one server, declaring elicitation support and wiring
   * the handler when the host can actually prompt the user.
   *
   * Form mode only. URL mode would have us open a browser tab in the middle of
   * a tool call with no user gesture behind it — the SDK rejects URL-mode
   * requests for us when the `url` capability is undeclared.
   */
  private createClient(serverName: string, negotiate: NegotiationOptions): Client {
    const handler = this.onElicit;
    if (!handler) return new Client({ name: "ggcoder", version: "1.0.0" }, negotiate);

    const client = new Client(
      { name: "ggcoder", version: "1.0.0" },
      { ...negotiate, capabilities: { elicitation: { form: {} } } },
    );
    client.setRequestHandler("elicitation/create", async (request: ElicitRequest) => {
      const params = request.params;
      if (params.mode === "url") {
        // Unreachable while `url` stays undeclared, but a server that ignores
        // capabilities must get a clean decline rather than a thrown handler.
        return { action: "decline" } satisfies ElicitResult;
      }
      return handler({
        server: serverName,
        message: params.message,
        requestedSchema: params.requestedSchema as Record<string, unknown>,
      });
    });
    return client;
  }

  /**
   * Version-negotiation options for a real (non-probe) connect. `probe()` is
   * spawn-per-invocation and deliberately never negotiates: a legacy stdio
   * server that ignores the discovery request would stall it for the whole
   * probe timeout, turning "validate this server" into a 30s hang.
   *
   * The probe timeout is transport-aware because the SDK's timeout VERDICT is:
   *
   * - **stdio** — silence on a local pipe means a legacy server, and the SDK
   *   falls back to `initialize`. The probe runs on a disposable sibling
   *   process, so the fallback is clean. Waiting the full connect timeout to
   *   reach a conclusion we can draw in seconds is pure dead time, so cap it
   *   short.
   * - **HTTP** — silence means an outage, and the SDK REJECTS the connect
   *   rather than falling back. A short timeout would therefore turn a slow
   *   cold start into a hard connection failure, so inherit the full connect
   *   timeout and let the normal timeout handling deal with a real outage.
   */
  private negotiationOptions(transport: "stdio" | "http"): NegotiationOptions {
    if (!this.modernProtocol) return {};
    return {
      versionNegotiation: {
        mode: "auto",
        ...(transport === "stdio" ? { probe: { timeoutMs: STDIO_PROBE_TIMEOUT_MS } } : {}),
      },
    };
  }

  /**
   * Claim the pooled connection for a shared server and adopt its tools.
   *
   * Shaped like `connectServer` (resolve tools / throw on failure) so the
   * caller's `allSettled` handling is identical for both kinds. The pool
   * reports failure in-band, so it is rethrown here with the message the pool
   * already formatted.
   */
  private async connectShared(config: MCPServerConfig): Promise<AgentTool[]> {
    const handle = await this.pool.acquire(
      config,
      // The pooled connection is just another manager with sharing switched
      // off, so it takes the normal connect path instead of recursing into the
      // pool. Its elicit handler is the pool's dispatcher, NOT this session's:
      // the connection is shared, so each request has to be routed to whichever
      // session actually provoked it.
      (opts) => {
        const manager = new MCPClientManager({
          catalogCache: opts.catalogCache,
          modernProtocol: opts.modernProtocol,
          onElicit: opts.onElicit,
          sharedPool: this.pool,
          // Let the pool retire this connection if its server exits.
          onServerClosed: opts.onClosed,
          // Idle shutdown lives in the pooled manager: it sees every session's
          // calls, so "no call in flight" means none from ANY window.
          idleTimeoutMs: this.idleTimeoutMs,
        });
        return {
          connect: async (target) => {
            const [result] = await manager.connectAllDetailed([{ ...target, shared: false }]);
            return (
              result ?? {
                name: target.name,
                ok: false,
                toolCount: 0,
                tools: [],
                error: "connection produced no result",
              }
            );
          },
          dispose: () => manager.dispose(),
        };
      },
      {
        catalogCache: this.catalogCache,
        modernProtocol: this.modernProtocol,
        onElicit: this.onElicit,
      },
    );
    if (!handle.result.ok) {
      // Nothing was claimed on a failed connect, but releasing is idempotent
      // and keeps this path honest if that ever changes.
      await handle.release();
      throw new Error(handle.result.error ?? "connection failed");
    }
    this.sharedHandles.set(config.name, handle);

    // Wrap each pooled tool so a call from THIS session is attributable while
    // it runs. The pool needs that to answer "which window asked?" when the
    // server elicits mid-call; without it a shared server could only ever
    // cancel its prompts.
    return handle.result.tools.map((tool) => ({
      ...tool,
      execute: async (args: unknown, context?: ToolContext) => {
        const endCall = handle.beginCall();
        try {
          return await tool.execute(args, context as ToolContext);
        } finally {
          endCall();
        }
      },
    }));
  }

  /** Get-or-create the settlement record for one server name. */
  private connectionSlot(name: string): {
    promise: Promise<ConnectionOutcome>;
    settle: (outcome: ConnectionOutcome) => void;
  } {
    const existing = this.connections.get(name);
    if (existing) return existing;
    let settle!: (outcome: ConnectionOutcome) => void;
    const promise = new Promise<ConnectionOutcome>((resolve) => {
      settle = resolve;
    });
    const slot = { promise, settle };
    this.connections.set(name, slot);
    return slot;
  }

  /**
   * Resolve once a server's connection attempt has settled. Returns `ok:false`
   * with the failure reason when that server could not connect, and times out
   * rather than hanging when no attempt is ever made (e.g. a server that was
   * removed from the config since the catalog cache was written).
   */
  async whenConnected(name: string, timeoutMs = 30_000): Promise<ConnectionOutcome> {
    if (this.servers.some((server) => server.name === name)) return { ok: true };
    const slot = this.connectionSlot(name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ConnectionOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, error: `timed out after ${timeoutMs}ms` }),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([slot.promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async connectAll(configs: MCPServerConfig[]): Promise<AgentTool[]> {
    const results = await this.connectAllDetailed(configs);
    return results.flatMap((r) => r.tools);
  }

  /**
   * Connect every enabled server and return one result per server (success →
   * ok + toolCount; failure → ok:false with a human-readable error string).
   * Keeps successfully connected servers in `this.servers`.
   *
   * Shareable servers — stdio, unless opted out with `shared: false` — are not
   * connected here at all: they are claimed from the process-wide pool, so every
   * session in the daemon multiplexes over one child process instead of spawning
   * its own. The split is invisible to callers — results and tools come back in
   * the same shape, `whenConnected` settles for both kinds, and `dispose`
   * releases the pooled claims — so sharing applies wherever a manager is used
   * (sessions, CLI, subagents) without each call site opting in.
   */
  async connectAllDetailed(configs: MCPServerConfig[]): Promise<MCPConnectResult[]> {
    const enabled = configs.filter((c) => c.enabled !== false);
    if (enabled.length === 0) return [];

    // Claim a settlement slot for every server up front, so a `whenConnected`
    // caller that arrives before a slow server's turn still waits on the right
    // promise instead of creating a second one.
    for (const config of enabled) this.connectionSlot(config.name);

    const settled = await Promise.allSettled(
      enabled.map((c) => (isShareableServer(c) ? this.connectShared(c) : this.connectServer(c))),
    );

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

    // Release anyone waiting on a cached-only tool from these servers.
    for (const result of results) {
      this.connectionSlot(result.name).settle(
        result.ok ? { ok: true } : { ok: false, error: result.error ?? "connection failed" },
      );
    }

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
      const tools = await this.connectServer(config, { probe: true });
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

    // The whole callback query string, not just `code`: v2's finishAuth reads
    // `iss` from it and validates the issuer (RFC 9207) before redeeming the
    // code, which is the defense against an authorization-server mix-up.
    let codeResolve: ((params: URLSearchParams) => void) | undefined;
    let codeReject: ((err: Error) => void) | undefined;
    const codePromise = new Promise<URLSearchParams>((resolve, reject) => {
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
      codeResolve?.(reqUrl.searchParams);
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

      const callbackParams = await codePromise;
      // Exchange the code for tokens (persisted via provider.saveTokens).
      await loginTransport.finishAuth(callbackParams);
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

  private async connectServer(
    config: MCPServerConfig,
    opts: { probe?: boolean; restart?: boolean } = {},
  ): Promise<AgentTool[]> {
    const timeout = config.timeout ?? 30_000;
    // `command` is what actually selects the stdio path further down.
    const negotiate: NegotiationOptions = opts.probe
      ? {}
      : this.negotiationOptions(config.command ? "stdio" : "http");
    // A server we already know speaks the 2025 handshake skips the discovery
    // probe entirely. Only the legacy verdict is reusable from an era string:
    // adopting a 'modern' verdict needs the full DiscoverResult, so those still
    // probe (a modern server answers immediately, so that costs nothing).
    const prior =
      "versionNegotiation" in negotiate && (await this.cachedEra(config)) === "legacy"
        ? ({ kind: "legacy" } as const)
        : undefined;
    const connectOptions = { timeout, ...(prior ? { prior } : {}) };
    let client: Client;
    let transport: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport;

    if (config.command) {
      // Stdio transport for local processes.
      // cwd is forced to homedir so the user's working directory can't
      // affect resolution. e.g. running ggcoder from a folder whose
      // package.json names the same package as the MCP server makes
      // `npx -y <pkg>` self-resolve to the local source (no built bin
      // shim) and fail with "command not found".
      //
      // For an `npx -y <pkg>` of a package that ships as a ggcoder dependency
      // rewrite to a direct
      // `node <binScript>` invocation. `npx` otherwise spawns a ~100 MB Node
      // wrapper whose only job is to resolve+launch the real server, doubling
      // memory per connection. Non-resolvable / non-npx commands pass through
      // unchanged. Mirrors the LSP `process.execPath`+bin pattern.
      const resolved = resolveStdioCommand(config.command, config.args);
      transport = new StdioClientTransport({
        command: resolved.command,
        args: resolved.args,
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
      client = this.createClient(config.name, negotiate);
      try {
        await client.connect(transport, connectOptions);
      } catch (err) {
        const stderr = stderrChunks.join("").slice(-4000);
        if (stderr.trim()) {
          log("WARN", "mcp", `stdio child stderr for "${config.name}"`, { stderr });
        }
        throw err;
      }
    } else {
      // HTTP transport (Streamable HTTP or SSE). See connectHttp for the
      // transport-selection + auth logic.
      if (!config.url) throw new Error(`MCP server "${config.name}" needs a command or a url`);
      const url = new URL(config.url);
      const isLocal = isLocalhost(url);

      try {
        const r = await this.connectHttp(url, config, isLocal, negotiate, connectOptions);
        client = r.client;
        transport = r.transport;
      } catch (err) {
        // Windows 11 resolves `localhost` → ::1 (IPv6) first; if the server
        // binds IPv4-only (127.0.0.1) the first fetch gets ECONNREFUSED.
        // Retry once with the alternate loopback hostname. macOS resolves
        // both stacks so this only bites Windows/Linux in practice.
        const alt = isLocal ? alternateLoopback(url.hostname) : undefined;
        if (!alt || !isNetworkError(err)) throw err;
        log("INFO", "mcp", `localhost connect failed for "${config.name}", retrying as ${alt}`, {
          error: String(err),
        });
        const altUrl = new URL(url);
        altUrl.hostname = alt;
        const r = await this.connectHttp(altUrl, config, isLocal, negotiate, connectOptions);
        client = r.client;
        transport = r.transport;
      }
    }

    this.servers.push({ name: config.name, client, transport, lastCallTime: 0, config });

    // Report an unexpected close. A stdio child that crashes has no recovery
    // path (`canRecoverSession` excludes stdio deliberately: respawning one
    // mid-call would be a surprise), so the only safe response is to let the
    // owner drop this connection and rebuild on the next use. That matters most
    // for a POOLED connection, where a corpse would otherwise be handed to every
    // session in the daemon, including ones that connect later.
    client.onclose = () => {
      if (this.disposing || this.idleStopped.has(client)) return;
      log("WARN", "mcp", `MCP server "${config.name}" closed unexpectedly`);
      this.onServerClosed?.(config.name);
    };

    const { tools } = await client.listTools(undefined, { timeout });

    // Start the idle countdown (a no-op for HTTP / keepAlive / a call in
    // flight). A probe connection is closed right away, so it never idles.
    if (!opts.probe) this.armIdleTimer(config);

    if (opts.restart) {
      // A respawn after idle shutdown only revives the process; the tools the
      // model already has stay as they are (see `ensureRunning`). A server whose
      // list changed meanwhile is logged — its new list lands on next session.
      log("INFO", "mcp", `MCP server "${config.name}" restarted`, {
        tools: String(tools.length),
      });
    }

    // Persist the live tool list so the NEXT cold start can answer tool_search
    // before this server has finished connecting. Awaited (a small serialized
    // JSON write) so the entry is on disk before the connect is reported done —
    // otherwise a session that starts right after would still see a cold cache.
    // A failed write must never fail the connect.
    try {
      await this.catalogCache.save(
        config,
        tools.map((tool) => ({
          name: `mcp__${config.name}__${tool.name}`,
          description: tool.description ?? "",
          rawInputSchema: tool.inputSchema as Record<string, unknown> | undefined,
        })),
        this.negotiatedEra(client),
      );
    } catch {
      // Cache is an optimization; a connected server is still fully usable.
    }

    // Per-call deadlines (see MCP_DEFAULT_* above). `timeout` is the window
    // WITHOUT a response or progress; every progress notification restarts it
    // (`resetTimeoutOnProgress`), up to the hard `maxTotalTimeout` cap. The
    // SDK checks the cap when progress arrives, so the worst case for a call is
    // the cap plus one silent window.
    const callTimeout = config.timeout ?? MCP_DEFAULT_CALL_TIMEOUT_MS;
    const maxTotalTimeout = Math.max(
      config.maxTotalTimeout ?? MCP_DEFAULT_MAX_TOTAL_TIMEOUT_MS,
      callTimeout,
    );

    return tools.map((tool): AgentTool => {
      const toolName = `mcp__${config.name}__${tool.name}`;

      const runCall = async (
        args: unknown,
        context: ToolContext | undefined,
      ): Promise<ToolExecuteResult> => {
        const server = this.servers.find((s) => s.name === config.name);
        if (server) {
          const elapsed = Date.now() - server.lastCallTime;
          const minGap = 2_000;
          if (elapsed < minGap) {
            await new Promise((r) => setTimeout(r, minGap - elapsed));
          }
          server.lastCallTime = Date.now();
        }

        // Resolve the client from `this.servers` on every attempt rather than
        // closing over the one from connect time: a session rebuild (or an idle
        // respawn) swaps the entry, and a stale capture would keep calling the
        // dead client.
        const liveClient = (): Client =>
          this.servers.find((s) => s.name === config.name)?.client ?? client;

        // The client the attempt actually ran against, so a failure can be
        // attributed to "my client was replaced" vs "the server hung up".
        let attemptClient = liveClient();
        const callOnce = async (): Promise<ToolExecuteResult> => {
          attemptClient = liveClient();
          const result = await attemptClient.callTool(
            { name: tool.name, arguments: args as Record<string, unknown> },
            {
              timeout: callTimeout,
              maxTotalTimeout,
              resetTimeoutOnProgress: true,
              // The SDK only attaches a progressToken (and so only gets progress
              // at all) when `onprogress` is set. Forward it as a tool update so
              // the UI can show the call is alive.
              onprogress: (progress) => {
                context?.onUpdate?.({ type: "mcp_progress", ...progress });
              },
              ...(context?.signal ? { signal: context.signal } : {}),
            },
          );
          if (!("content" in result) || !Array.isArray(result.content)) {
            return "(empty response)";
          }
          const converted = await toToolResult(result.content, toolName);
          // The server ran the tool and reports it failed (MCP `isError`).
          if ("isError" in result && result.isError === true) {
            throw new McpToolError(resultText(converted) || "MCP tool reported an error");
          }
          return converted;
        };

        try {
          return await callOnce();
        } catch (err) {
          if (err instanceof McpToolError) throw err;
          // An expired HTTP session is recoverable exactly once: rebuild the
          // connection and replay the call. A second failure is a real error.
          if (this.canRecoverSession(config, err, attemptClient, context?.signal)) {
            try {
              await this.reconnectServer(config);
              if (!context?.signal?.aborted) return await callOnce();
            } catch (retryErr) {
              if (retryErr instanceof McpToolError) throw retryErr;
              throw new McpToolError(`MCP tool error: ${formatConnectError(retryErr)}`);
            }
          }
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("Too Many R") || msg.includes("429")) {
            throw new McpToolError(
              "Rate limited — too many requests. Wait a moment before searching again.",
            );
          }
          throw new McpToolError(`MCP tool error: ${msg}`);
        }
      };

      return {
        name: toolName,
        description: tool.description ?? "",
        parameters: z.record(z.string(), z.unknown()),
        rawInputSchema: tool.inputSchema as Record<string, unknown>,
        // The agent loop's own per-tool deadline (5 min by default) would
        // otherwise preempt a long tool that is legitimately reporting
        // progress, so declare the real worst case.
        timeoutMs: maxTotalTimeout + callTimeout,
        execute: async (args, context) => {
          // Counted synchronously, before any await, so an idle timer that
          // fires while this call is still starting cannot stop the server.
          const idle = this.idleEligible(config) ? this.idleState(config.name) : undefined;
          if (idle) {
            idle.inFlight += 1;
            if (idle.timer) clearTimeout(idle.timer);
            idle.timer = undefined;
          }
          try {
            if (idle) await this.ensureRunning(config);
            return await runCall(args, context);
          } catch (err) {
            if (err instanceof McpToolError) throw err;
            throw new McpToolError(`MCP tool error: ${formatConnectError(err)}`);
          } finally {
            if (idle) {
              idle.inFlight = Math.max(0, idle.inFlight - 1);
              if (idle.inFlight === 0) this.armIdleTimer(config);
            }
          }
        },
      };
    });
  }

  /**
   * Is this failure a recoverable expired HTTP session?
   *
   * Stdio servers are excluded: they have no HTTP session to expire, so a 404
   * from one means something else entirely and respawning the child process
   * mid-call would be a surprise. An already-aborted call is excluded too —
   * reconnecting to replay work the user cancelled resurrects it.
   */
  private canRecoverSession(
    config: MCPServerConfig,
    err: unknown,
    attemptClient: Client,
    signal: AbortSignal | undefined,
  ): boolean {
    if (config.command) return false;
    if (signal?.aborted) return false;
    if (isSessionExpired(err)) return true;
    // A sibling call that hit the same expired session may already have torn
    // the transport down underneath us, which surfaces as a generic "connection
    // closed" rather than the 404. Recover only when the client we called has
    // genuinely been retired — otherwise this is a real disconnect and a retry
    // would just fail again.
    const current = this.servers.find((s) => s.name === config.name)?.client;
    return current !== attemptClient && this.isConnectionClosed(err);
  }

  /** A local "the transport went away mid-request" failure, as the SDK reports it. */
  private isConnectionClosed(reason: unknown): boolean {
    return SdkError.isInstance(reason) && reason.code === SdkErrorCode.ConnectionClosed;
  }

  /**
   * Rebuild one server's connection from its stored config, replacing the dead
   * entry in `this.servers`. Concurrent callers share a single rebuild.
   *
   * Rejects if the reconnect itself fails, so the caller reports a real error
   * rather than retrying against a client that was never replaced.
   */
  private async reconnectServer(config: MCPServerConfig): Promise<void> {
    const inFlight = this.reconnecting.get(config.name);
    if (inFlight) return inFlight;

    const attempt = (async () => {
      log("INFO", "mcp", `MCP session expired for "${config.name}", reconnecting`);
      const dead = this.servers.find((s) => s.name === config.name);
      if (dead) {
        this.servers = this.servers.filter((s) => s !== dead);
        try {
          await dead.client.close();
        } catch {
          // The session is already gone server-side; a failed close is expected.
        }
      }
      await this.connectServer(config);
    })();

    this.reconnecting.set(config.name, attempt);
    try {
      await attempt;
    } finally {
      this.reconnecting.delete(config.name);
    }
  }

  /**
   * Connect a single HTTP (Streamable HTTP or SSE) server and return the live
   * client + transport. Transport selection:
   * - `transport === "sse"` → legacy SSE directly (Playwright MCP `--port`).
   * - otherwise → Streamable HTTP first, SSE fallback for older servers.
   *
   * An OAuth provider is attached only for REMOTE servers — localhost never
   * needs OAuth and attaching it there is dead weight that can misdiagnose a
   * protocol mismatch as a login requirement.
   */
  private async connectHttp(
    url: URL,
    config: MCPServerConfig,
    isLocal: boolean,
    negotiate: NegotiationOptions,
    connectOptions: { timeout: number; prior?: { kind: "legacy" } },
  ): Promise<{
    client: Client;
    transport: StreamableHTTPClientTransport | SSEClientTransport;
  }> {
    const reqInit = config.headers ? { headers: config.headers } : undefined;
    const authProvider = isLocal ? undefined : new McpOAuthProvider({ serverName: config.name });
    const sseTransport = (): SSEClientTransport =>
      new SSEClientTransport(url, {
        eventSourceInit: config.headers ? { fetch: createHeaderFetch(config.headers) } : undefined,
        requestInit: reqInit,
        authProvider,
      });

    if (config.transport === "sse") {
      const transport = sseTransport();
      const client = this.createClient(config.name, negotiate);
      await client.connect(transport, connectOptions);
      return { client, transport };
    }

    try {
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: reqInit,
        authProvider,
      });
      const client = this.createClient(config.name, negotiate);
      await client.connect(transport, connectOptions);
      return { client, transport };
    } catch (streamableErr) {
      // For localhost, always try the SSE fallback — a 401 from localhost is
      // almost certainly a protocol mismatch (e.g. Playwright MCP serves SSE),
      // not an auth requirement. For remote servers, a 401 means OAuth is needed
      // so skip the fallback and surface "requires login".
      if (!isLocal && isUnauthorized(streamableErr)) throw streamableErr;
      log("INFO", "mcp", `StreamableHTTP failed for "${config.name}", trying SSE fallback`, {
        error: String(streamableErr),
      });
      const transport = sseTransport();
      const client = this.createClient(config.name, negotiate);
      await client.connect(transport, connectOptions);
      return { client, transport };
    }
  }

  /**
   * Protocol era actually negotiated with a server, as the SDK reports it.
   * Undefined before a connect completes; with negotiation off the SDK always
   * settles on `legacy` (the 2025 `initialize` handshake).
   */
  private negotiatedEra(client: Client): ProtocolEra {
    return client.getProtocolEra() ?? "legacy";
  }

  /** Previously negotiated era for this exact server config, if still cached. */
  private async cachedEra(config: MCPServerConfig): Promise<ProtocolEra | undefined> {
    try {
      return await this.catalogCache.protocolEraFor(config);
    } catch {
      return undefined;
    }
  }

  async dispose(): Promise<void> {
    // Our own teardown closes transports too; flag it so those closes are not
    // reported as unexpected deaths.
    this.disposing = true;
    this.connections.clear();
    this.reconnecting.clear();
    // Idle countdowns must not outlive the manager (they are unref'd, but a
    // late fire would still try to close a client we are about to close).
    for (const state of this.idle.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
    }
    // A respawn racing teardown would add a child after we closed the rest.
    await Promise.allSettled(
      [...this.idle.values()].map((state) => state.restarting).filter(Boolean),
    );
    this.idle.clear();
    // Hand back pooled claims first. These are references, not connections —
    // the shared child survives if another session still holds it, and exits
    // when this was the last claim.
    const handles = [...this.sharedHandles.values()];
    this.sharedHandles.clear();
    await Promise.all(handles.map((handle) => handle.release()));
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
 * Turn a thrown connection error into a short human-readable string.
 *
 * v2 splits the old `McpError` into `ProtocolError` (a JSON-RPC error that
 * crossed the wire) and `SdkError` (a purely local failure: timeout, closed
 * connection, HTTP status). Matching the typed classes gives far better wording
 * than sniffing message text, which survives only as the fallback for errors
 * thrown before the SDK's machinery engages (raw fetch failures).
 */
function formatConnectError(reason: unknown): string {
  if (SdkHttpError.isInstance(reason)) {
    if (reason.status === 429) return "Rate limited (429) — try again in a moment.";
    const statusText = reason.statusText ? ` ${reason.statusText}` : "";
    return `Server responded with HTTP ${reason.status}${statusText}.`;
  }
  if (SdkError.isInstance(reason)) {
    if (reason.code === SdkErrorCode.RequestTimeout) {
      return "Timed out waiting for the server to respond.";
    }
    if (reason.code === SdkErrorCode.ConnectionClosed) {
      return "Connection closed before the server finished starting up.";
    }
    return reason.message;
  }
  if (OAuthError.isInstance(reason)) return `OAuth error (${reason.code}): ${reason.message}`;
  if (ProtocolError.isInstance(reason)) return reason.message;

  const msg = reason instanceof Error ? reason.message : String(reason);
  if (msg.includes("Too Many R") || msg.includes("429")) {
    return "Rate limited (429) — try again in a moment.";
  }
  return msg;
}

/**
 * How long to wait for a stdio server to answer `server/discover` before
 * concluding it is a 2025-era server. A local child that has not replied in
 * this window is not going to; the SDK then falls back to `initialize`.
 */
const STDIO_PROBE_TIMEOUT_MS = 2_500;

/** Client-side version-negotiation options, as passed to the SDK `Client`. */
type NegotiationOptions = {
  versionNegotiation?: {
    mode: "auto";
    probe?: { timeoutMs: number };
  };
};

/** OAuth failures that mean the saved credentials can no longer be used. */
const REAUTH_OAUTH_CODES: readonly (OAuthErrorCode | string)[] = [
  OAuthErrorCode.InvalidToken,
  OAuthErrorCode.InvalidGrant,
  OAuthErrorCode.InvalidClient,
  OAuthErrorCode.AccessDenied,
];

/**
 * Whether an error means the remote server has dropped our HTTP session.
 *
 * `StreamableHTTPClientTransport.send` handles 401/403 (it re-runs auth) but
 * returns a bare `SdkHttpError{status:404}` when the `Mcp-Session-Id` we are
 * carrying is no longer known to the server — which is exactly what happens
 * after a server restart or an idle-session sweep on a long desktop session.
 * The SDK has no recovery for it, so we rebuild the connection ourselves.
 */
function isSessionExpired(reason: unknown): boolean {
  return SdkHttpError.isInstance(reason) && reason.status === 404;
}

/**
 * Whether a connect error means the server needs OAuth login. The SDK throws
 * its typed `UnauthorizedError` when auth is required, a `SdkHttpError` for a
 * bare 401, and an `OAuthError` when the token endpoint rejects the saved
 * credentials. A raw 401 from before the auth machinery engages can still
 * surface as a plain message — so the string check remains as a fallback.
 */
function isUnauthorized(reason: unknown): boolean {
  if (UnauthorizedError.isInstance(reason)) return true;
  if (SdkHttpError.isInstance(reason)) return reason.status === 401;
  // Token/grant/client codes mean "log in again"; the rest (server_error,
  // temporarily_unavailable, …) are transient, not an auth gap.
  if (OAuthError.isInstance(reason)) return REAUTH_OAUTH_CODES.includes(reason.code);
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

/**
 * Create a custom fetch wrapper that injects extra headers into every request.
 * Used for SSEClientTransport's eventSourceInit to pass auth headers
 * on the initial SSE GET connection (which doesn't use requestInit).
 *
 * The incoming headers may be a Web Standard `Headers` instance (v2 uses it
 * throughout) or a plain object. Spreading a `Headers` yields `{}`, silently
 * dropping the SDK's own auth header — so normalize through `Headers`, which
 * accepts both shapes, and merge with `set()` rather than bracket access.
 */
function createHeaderFetch(extraHeaders: Record<string, string>) {
  return (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
    return fetch(url, { ...init, headers });
  };
}
