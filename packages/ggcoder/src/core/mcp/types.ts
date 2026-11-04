export interface MCPServerConfig {
  name: string;
  /** HTTP endpoint URL (Streamable HTTP or SSE) */
  url?: string;
  headers?: Record<string, string>;
  /** Stdio server: command to spawn */
  command?: string;
  /** Stdio server: command arguments */
  args?: string[];
  /** Stdio server: environment variables */
  env?: Record<string, string>;
  /**
   * Milliseconds. Bounds the connect handshake, and — for a tool call — the
   * time allowed WITHOUT a response or progress notification: a tool that
   * reports progress has this window restarted on every notification.
   */
  timeout?: number;
  /**
   * Hard cap (ms) on one tool call's total duration, however much progress it
   * reports. Defaults to `MCP_DEFAULT_MAX_TOTAL_TIMEOUT_MS` (see client.ts).
   */
  maxTotalTimeout?: number;
  enabled?: boolean;
  /**
   * Opt OUT of idle shutdown. By default a stdio server's process is stopped
   * after a period with no call in flight and respawned on the next call (its
   * tools stay listed meanwhile). Set `true` for a server whose process holds
   * state worth keeping between calls — a logged-in browser session, an open
   * database handle, a warm index. HTTP servers are never idle-stopped.
   */
  keepAlive?: boolean;
  /**
   * Opt OUT of connection sharing. Defaults to true for stdio servers, so one
   * child process serves every session in the daemon rather than one per
   * window (see core/mcp/shared-pool.ts).
   *
   * Set `false` for a server that keeps per-CALLER state across requests — a
   * cursor, a selected workspace, an open handle — where multiplexing two
   * sessions over one connection would let one session's state change the
   * other's answers. Sharing is already skipped for HTTP servers, whose auth
   * and session id are per-connection.
   */
  shared?: boolean;
  /** Explicit HTTP transport hint. "http" tries Streamable HTTP first (SSE
   *  fallback); "sse" connects via the legacy SSE transport directly. When
   *  unset, both are tried (Streamable HTTP → SSE). */
  transport?: "http" | "sse";
}
