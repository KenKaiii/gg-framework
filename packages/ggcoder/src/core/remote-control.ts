import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { log } from "./logger.js";
import type { EventBus } from "./event-bus.js";

// ── RPC Command Types (same as rpc-mode.ts) ─────────────

export interface RcPromptCommand {
  id: string;
  command: "prompt";
  text: string;
}

interface RcAbortCommand {
  id: string;
  command: "abort";
}

interface RcGetStateCommand {
  id: string;
  command: "get_state";
}

export type RcCommand = RcPromptCommand | RcAbortCommand | RcGetStateCommand;

// ── Remote Control Server ────────────────────────────────

export interface RemoteControlEvents {
  prompt: [command: RcPromptCommand];
  abort: [command: RcAbortCommand];
  get_state: [command: RcGetStateCommand];
  connection: [clientCount: number];
  disconnection: [clientCount: number];
}

/**
 * Unix domain socket server for remote control.
 * External agents connect and send NDJSON commands (same protocol as --rpc).
 * Events are broadcast back to all connected clients.
 */
export class RemoteControlServer extends EventEmitter<RemoteControlEvents> {
  private server: net.Server | null = null;
  private clients = new Set<net.Socket>();
  private _socketPath: string;
  private _closed = false;

  constructor(socketPath?: string) {
    super();
    this._socketPath = socketPath ?? getDefaultSocketPath();
  }

  get socketPath(): string {
    return this._socketPath;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get isListening(): boolean {
    return this.server?.listening ?? false;
  }

  /**
   * Start the Unix domain socket server.
   * Cleans up any stale socket file before binding.
   */
  async start(): Promise<string> {
    if (this.server) {
      throw new Error("Remote control server already started");
    }

    // Ensure parent directory exists
    const dir = path.dirname(this._socketPath);
    fs.mkdirSync(dir, { recursive: true });

    // Remove stale socket file if it exists
    try {
      fs.unlinkSync(this._socketPath);
    } catch {
      // File doesn't exist — fine
    }

    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      server.on("error", (err) => {
        log("ERROR", "remote-control", `Socket server error: ${err.message}`);
        reject(err);
      });

      server.listen(this._socketPath, () => {
        // Set socket permissions to owner-only (0o600)
        try {
          fs.chmodSync(this._socketPath, 0o600);
        } catch {
          // Non-fatal — permissions may not be settable on all platforms
        }
        log("INFO", "remote-control", `Listening on ${this._socketPath}`);
        this.server = server;
        resolve(this._socketPath);
      });
    });
  }

  /** Broadcast an NDJSON event to all connected clients. */
  broadcast(payload: Record<string, unknown>): void {
    if (this.clients.size === 0) return;
    const line = JSON.stringify(payload) + "\n";
    for (const client of this.clients) {
      try {
        client.write(line);
      } catch {
        // Client disconnected — will be cleaned up by close handler
      }
    }
  }

  /** Send an NDJSON event to a specific client. */
  sendTo(client: net.Socket, payload: Record<string, unknown>): void {
    try {
      client.write(JSON.stringify(payload) + "\n");
    } catch {
      // Client disconnected
    }
  }

  /** Wire up event bus forwarding — all bus events get broadcast to socket clients. */
  forwardEventBus(eventBus: EventBus): () => void {
    const unsubs: (() => void)[] = [];

    unsubs.push(eventBus.on("text_delta", (p) => this.broadcast({ type: "text_delta", ...p })));
    unsubs.push(
      eventBus.on("thinking_delta", (p) => this.broadcast({ type: "thinking_delta", ...p })),
    );
    unsubs.push(
      eventBus.on("tool_call_start", (p) => this.broadcast({ type: "tool_call_start", ...p })),
    );
    unsubs.push(
      eventBus.on("tool_call_update", (p) => this.broadcast({ type: "tool_call_update", ...p })),
    );
    unsubs.push(
      eventBus.on("tool_call_end", (p) => this.broadcast({ type: "tool_call_end", ...p })),
    );
    unsubs.push(eventBus.on("turn_end", (p) => this.broadcast({ type: "turn_end", ...p })));
    unsubs.push(eventBus.on("agent_done", (p) => this.broadcast({ type: "agent_done", ...p })));
    unsubs.push(
      eventBus.on("server_tool_call", (p) => this.broadcast({ type: "server_tool_call", ...p })),
    );
    unsubs.push(
      eventBus.on("server_tool_result", (p) =>
        this.broadcast({ type: "server_tool_result", ...p }),
      ),
    );
    unsubs.push(
      eventBus.on("compaction_start", (p) => this.broadcast({ type: "compaction_start", ...p })),
    );
    unsubs.push(
      eventBus.on("compaction_end", (p) => this.broadcast({ type: "compaction_end", ...p })),
    );
    unsubs.push(
      eventBus.on("session_start", (p) => this.broadcast({ type: "session_start", ...p })),
    );
    unsubs.push(eventBus.on("model_change", (p) => this.broadcast({ type: "model_change", ...p })));
    unsubs.push(
      eventBus.on("branch_created", (p) => this.broadcast({ type: "branch_created", ...p })),
    );
    unsubs.push(
      eventBus.on("error", ({ error }) =>
        this.broadcast({ type: "error", message: error.message }),
      ),
    );

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }

  /** Close the server and clean up the socket file. */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    // Disconnect all clients
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    // Close server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    // Remove socket file
    try {
      fs.unlinkSync(this._socketPath);
    } catch {
      // Already gone
    }

    log("INFO", "remote-control", "Server closed");
  }

  private handleConnection(socket: net.Socket): void {
    this.clients.add(socket);
    const clientCount = this.clients.size;
    log("INFO", "remote-control", `Client connected (${clientCount} total)`);
    this.emit("connection", clientCount);

    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      // Process complete lines (NDJSON)
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;

        let cmd: RcCommand;
        try {
          cmd = JSON.parse(line) as RcCommand;
        } catch {
          this.sendTo(socket, { type: "error", message: `Invalid JSON: ${line}` });
          continue;
        }

        this.handleCommand(socket, cmd);
      }
    });

    socket.on("close", () => {
      this.clients.delete(socket);
      const remaining = this.clients.size;
      log("INFO", "remote-control", `Client disconnected (${remaining} remaining)`);
      this.emit("disconnection", remaining);
    });

    socket.on("error", (err) => {
      log("WARN", "remote-control", `Client error: ${err.message}`);
      this.clients.delete(socket);
    });
  }

  private handleCommand(client: net.Socket, cmd: RcCommand): void {
    switch (cmd.command) {
      case "prompt":
        this.emit("prompt", cmd);
        break;
      case "abort":
        this.emit("abort", cmd);
        break;
      case "get_state":
        this.emit("get_state", cmd);
        break;
      default: {
        const unknown = cmd as { id?: string; command?: string };
        this.sendTo(client, {
          id: unknown.id,
          type: "error",
          message: `Unknown command: ${unknown.command}`,
        });
        break;
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────

function getDefaultSocketPath(): string {
  const dir = path.join(os.homedir(), ".gg");
  return path.join(dir, `rc-${process.pid}.sock`);
}

/**
 * Install process cleanup handlers to remove the socket file on exit.
 * Returns a cleanup function to remove the handlers.
 */
export function installCleanupHandlers(server: RemoteControlServer): () => void {
  const cleanup = () => {
    server.close().catch(() => {});
  };

  // Synchronous cleanup for exit
  const onExit = () => {
    try {
      fs.unlinkSync(server.socketPath);
    } catch {
      // Already gone
    }
  };

  process.on("exit", onExit);
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  return () => {
    process.removeListener("exit", onExit);
    process.removeListener("SIGTERM", cleanup);
    process.removeListener("SIGINT", cleanup);
  };
}
