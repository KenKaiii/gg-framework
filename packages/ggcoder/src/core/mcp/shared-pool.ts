import { hashServerConfig } from "./catalog-cache.js";
import type { McpCatalogCache } from "./catalog-cache.js";
import type { MCPConnectResult, MCPElicitHandler } from "./client.js";
import { log } from "../logger.js";
import type { MCPServerConfig } from "./types.js";

/**
 * Process-wide pool of MCP connections that are safe for every session to
 * share, so one stdio child serves the whole daemon instead of one per session.
 *
 * The daemon hosts many `AgentSession`s at once — one per window, plus Ken chat
 * and Ken autopilot within each window — and each used to spawn its own child
 * for every configured stdio server. For a stateless proxy that is N identical
 * processes doing identical work: measured
 * at 7 live children, ~43 MB each, purely duplicated.
 *
 * Sharing is the DEFAULT for stdio servers. A stdio connection has nothing
 * session-specific in it: every one is spawned with `cwd: os.homedir()`, so a
 * server cannot observe which project the caller is in even in principle, and
 * the pool key hashes command/args/env, so two configs differing in any way
 * that changes behaviour already get their own process.
 *
 * The two concerns that sharing has to answer are handled rather than avoided:
 *
 *  - **Per-caller state.** Multiplexing many sessions over one connection would
 *    let a server that remembers "the current project" leak one session's
 *    context into another's answers. That is invisible from a config, so it
 *    stays a declaration: `shared: false` opts such a server out and it keeps a
 *    private child per session.
 *  - **User prompting.** "Ask the user" has to name a window, so elicitation is
 *    routed to the session with a tool call in flight (see `dispatchElicit`),
 *    and cancelled rather than guessed when that is ambiguous. Because a
 *    connection declares its elicitation capability once at initialize, callers
 *    that can prompt and callers that cannot are keyed apart.
 *
 * The pool deliberately knows nothing about `MCPClientManager` — the connection
 * is supplied as a `SharedConnector`. That keeps the dependency pointing one
 * way (client → pool), and lets tests exercise refcounting against a fake.
 */

/**
 * Is this server shared across sessions in this process?
 *
 * Sharing is the DEFAULT for stdio servers, because a stdio MCP connection has
 * nothing session-specific in it: every one is spawned with `cwd:
 * os.homedir()` (see client.ts), so a server cannot observe which project the
 * caller is in even in principle, and the pool key hashes command/args/env, so
 * two configs that differ in any way that changes behaviour already get their
 * own process. What remained — elicitation, the one genuinely per-window
 * concern — is routed back to the calling session rather than dropped.
 *
 * `shared: false` opts a server out. That exists for a server that keeps
 * per-CALLER state across requests (a cursor, a selected workspace, an open
 * handle), where multiplexing two sessions over one connection would let one
 * session's state change the other's answers. That property is invisible from
 * a config, so it stays a declaration rather than a guess.
 *
 * HTTP servers are never shared. Sharing exists to collapse duplicate child
 * PROCESSES and an HTTP server has none, so it would save nothing while adding
 * real risk: OAuth tokens and `Mcp-Session-Id` are per-connection, and pooling
 * them would cross one session's authenticated identity with another's.
 */
export function isShareableServer(config: MCPServerConfig): boolean {
  return config.shared !== false && Boolean(config.command);
}

/** One pooled connection, owned by the pool and torn down at zero references. */
export interface SharedConnector {
  connect(config: MCPServerConfig): Promise<MCPConnectResult>;
  dispose(): Promise<void>;
}

export interface SharedAcquireOptions {
  catalogCache?: McpCatalogCache;
  modernProtocol?: boolean;
  /** Invoked by the connection when its server exits on its own. */
  onClosed?: () => void;
  /**
   * The acquiring session's elicitation handler. Invoked only while that
   * session has a tool call in flight on this connection (see `dispatchElicit`).
   */
  onElicit?: MCPElicitHandler;
}

/**
 * Builds the underlying connection the first time a config is pooled. The pool
 * supplies its own `onElicit`: a dispatcher that routes each request to the
 * session that asked for it, instead of any one session's handler.
 */
export type SharedConnectorFactory = (opts: SharedAcquireOptions) => SharedConnector;

/** A session's claim on a shared connection. `release` is idempotent. */
export interface SharedServerHandle {
  result: MCPConnectResult;
  release: () => Promise<void>;
  /**
   * Mark a tool call from this session as in flight, returning the function
   * that ends it. Elicitation arriving during the call is routed to this
   * session's window.
   */
  beginCall: () => () => void;
}

/** One session's participation in a shared connection. */
interface Caller {
  onElicit?: MCPElicitHandler;
  /** Tool calls this session currently has in flight on this connection. */
  activeCalls: number;
}

interface PoolEntry {
  connector: SharedConnector;
  /** Sessions holding this entry. Size is the reference count. */
  callers: Set<Caller>;
  connected: Promise<MCPConnectResult>;
}

export class SharedMcpPool {
  private entries = new Map<string, PoolEntry>();

  /**
   * Key on everything that changes what the connection IS, not merely what it
   * exposes: `hashServerConfig` covers command/args/env/url/transport, the name
   * keeps two differently-named aliases apart, and the protocol flag is
   * included because it changes the handshake — a session that opted into the
   * modern revision must not be handed a legacy-negotiated connection.
   *
   * Whether the caller can prompt is part of the key for the same reason. A
   * connection declares its elicitation capability once, at initialize, and
   * servers use that declaration to decide whether to ask at all — so a
   * headless caller (CLI, JSON mode) must not be handed a connection that
   * promises prompting nobody can deliver, and a windowed caller must not be
   * handed one that forecloses it. Splitting the key keeps each connection's
   * declaration honest; in practice a daemon's sessions are uniformly windowed
   * and the CLI's uniformly headless, so this still means one process.
   */
  private keyFor(config: MCPServerConfig, opts: SharedAcquireOptions): string {
    const era = opts.modernProtocol ? "modern" : "legacy";
    const prompting = opts.onElicit ? "interactive" : "headless";
    return `${config.name}\u0000${hashServerConfig(config)}\u0000${era}\u0000${prompting}`;
  }

  /**
   * Get-or-create the shared connection for `config` and claim a reference.
   *
   * Concurrent acquirers share one connect attempt: the entry and its pending
   * promise are registered synchronously before the first `await`, so a second
   * caller arriving mid-connect joins the in-flight attempt instead of spawning
   * a rival child.
   */
  async acquire(
    config: MCPServerConfig,
    createConnector: SharedConnectorFactory,
    opts: SharedAcquireOptions = {},
  ): Promise<SharedServerHandle> {
    const key = this.keyFor(config, opts);
    const caller: Caller = { onElicit: opts.onElicit, activeCalls: 0 };
    let entry = this.entries.get(key);

    if (!entry) {
      // Built before the connector so the dispatcher can close over it: the
      // connection needs an elicit handler at construction time, but which
      // session that handler defers to is only knowable per request.
      const created: PoolEntry = {
        connector: undefined as unknown as SharedConnector,
        callers: new Set(),
        connected: undefined as unknown as Promise<MCPConnectResult>,
      };
      // A headless entry gets no dispatcher at all, so its connection declares
      // no elicitation capability — matching what its callers can actually do.
      created.connector = createConnector({
        ...opts,
        onElicit: opts.onElicit ? this.dispatchElicit(created) : undefined,
        // A pooled child that dies would otherwise be handed to every session
        // in the daemon, and to every session that connects later — one crash
        // becoming a permanent outage. Unregister it so the next acquire builds
        // a fresh connection. Sessions already holding it still see their calls
        // fail, which is what a dead server means; they recover on reconnect.
        onClosed: () => this.evictDead(key, created),
      });
      created.connected = created.connector.connect(config);
      entry = created;
      this.entries.set(key, entry);
      log("INFO", "mcp", `Opening shared MCP connection for "${config.name}"`);
    }
    entry.callers.add(caller);

    const claimed = entry;
    let result: MCPConnectResult;
    try {
      result = await claimed.connected;
    } catch (err) {
      // The connector reports failure in-band, so a throw is unexpected. Drop
      // the claim so a broken entry cannot outlive it.
      await this.releaseKey(key, claimed, caller);
      throw err;
    }

    if (!result.ok) {
      // A failed connection is not worth pooling: keeping it would make every
      // later session inherit this failure with no chance to retry. Release the
      // claim (tearing the entry down at zero) and report the failure as-is.
      await this.releaseKey(key, claimed, caller);
      return { result, release: async () => {}, beginCall: () => () => {} };
    }

    let released = false;
    return {
      result,
      release: async () => {
        if (released) return;
        released = true;
        await this.releaseKey(key, claimed, caller);
      },
      beginCall: () => {
        caller.activeCalls += 1;
        let ended = false;
        return () => {
          if (ended) return;
          ended = true;
          caller.activeCalls = Math.max(0, caller.activeCalls - 1);
        };
      },
    };
  }

  /**
   * Drop a connection whose server died, without touching its callers' claims.
   *
   * The entry is unregistered but NOT disposed: its transport is already gone,
   * and the sessions still holding handles will release them normally on their
   * own dispose. Guarded on identity so a death notice arriving after the entry
   * was already replaced cannot evict its successor.
   */
  private evictDead(key: string, entry: PoolEntry): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    log("WARN", "mcp", "shared MCP connection died; next session will reconnect");
  }

  /**
   * Route an elicitation to the session that provoked it.
   *
   * A shared connection is held by many windows, so "ask the user" has to name
   * one. Elicitation only happens while a server is servicing a tool call, so
   * the session with a call in flight IS the one whose window should show the
   * form. When that is ambiguous — no call in flight, or two windows calling
   * the same server at once — the request is cancelled rather than guessed:
   * showing one project's consent form in another project's window would be a
   * worse failure than a declined prompt, and `cancel` is exactly what a server
   * already handles for a user who dismissed the dialog.
   */
  private dispatchElicit(entry: PoolEntry): MCPElicitHandler {
    return async (request) => {
      const candidates = [...entry.callers].flatMap((c) =>
        c.activeCalls > 0 && c.onElicit ? [c.onElicit] : [],
      );
      const [onElicit] = candidates;
      if (candidates.length !== 1 || !onElicit) {
        log("WARN", "mcp", "cancelled a shared-server elicitation with no unique caller", {
          server: request.server,
          candidates: String(candidates.length),
        });
        return { action: "cancel" };
      }
      return onElicit(request);
    };
  }

  /**
   * Drop one session's claim. At zero the entry is unregistered SYNCHRONOUSLY
   * before the disposal await, so an `acquire` landing mid-teardown builds a
   * fresh connection instead of receiving a client that is already closing.
   */
  private async releaseKey(key: string, entry: PoolEntry, caller: Caller): Promise<void> {
    if (!entry.callers.delete(caller)) return;
    if (entry.callers.size > 0) return;
    // Only unregister when this entry is still the live one for the key: a
    // teardown racing a fresh acquire must not evict its replacement.
    if (this.entries.get(key) === entry) this.entries.delete(key);
    await entry.connector.dispose();
    log("INFO", "mcp", "Closed shared MCP connection (last session released it)");
  }

  /** Live shared connections. Test/diagnostic use. */
  get size(): number {
    return this.entries.size;
  }

  /** Reference count for one config, or 0 when nothing is pooled for it. */
  refCount(config: MCPServerConfig, opts: SharedAcquireOptions = {}): number {
    return this.entries.get(this.keyFor(config, opts))?.callers.size ?? 0;
  }

  /** Tear every shared connection down regardless of refs (process shutdown). */
  async disposeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.connector.dispose()));
  }
}

/** The daemon-wide pool. One per process, which is exactly the sharing scope. */
export const sharedMcpPool = new SharedMcpPool();
