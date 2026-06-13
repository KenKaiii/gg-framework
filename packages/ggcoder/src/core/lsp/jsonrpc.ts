import type { Readable, Writable } from "node:stream";

/**
 * Minimal JSON-RPC 2.0 connection over a byte stream pair with LSP-style
 * Content-Length framing. Zero dependencies by design — this module must
 * never pull in vscode-jsonrpc or any other package (hard distribution
 * constraint: LSP diagnostics add no install weight).
 */

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class JsonRpcRequestError extends Error {
  readonly code: number;

  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message} (code ${code})`);
    this.name = "JsonRpcRequestError";
    this.code = code;
  }
}

export type NotificationHandler = (params: unknown) => void;

const HEADER_SEPARATOR = "\r\n\r\n";

/**
 * JSON-RPC connection speaking Content-Length framed messages.
 *
 * Server→client REQUESTS are auto-replied with safe defaults so language
 * servers never stall waiting on us: `workspace/configuration` gets one null
 * per requested item; everything else (`client/registerCapability`,
 * `window/workDoneProgress/create`, …) gets a plain null result.
 */
export class JsonRpcConnection {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, (msg: JsonRpcMessage) => void>();
  private readonly notificationHandlers = new Map<string, NotificationHandler[]>();
  private disposed = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    input.on("data", (chunk: Buffer) => this.onData(chunk));
    // Writing to a dead server's stdin must never crash the host process.
    output.on("error", () => {});
  }

  onNotification(method: string, handler: NotificationHandler): void {
    const handlers = this.notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new JsonRpcRequestError(method, -32099, "connection disposed"));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new JsonRpcRequestError(method, -32803, `timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) {
          reject(new JsonRpcRequestError(method, msg.error.code, msg.error.message));
        } else {
          resolve(msg.result);
        }
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Reject all in-flight requests and stop accepting new work. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, settle] of this.pending) {
      this.pending.delete(id);
      settle({ error: { code: -32099, message: "connection disposed" } });
    }
  }

  private send(msg: JsonRpcMessage): void {
    if (this.disposed) return;
    const body = JSON.stringify(msg);
    try {
      this.output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } catch {
      // Server stdin already closed — degradation is handled by the caller.
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString();
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString();
      this.buffer = this.buffer.subarray(bodyStart + length);
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(body) as JsonRpcMessage;
      } catch {
        continue;
      }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: JsonRpcMessage): void {
    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const settle = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (settle && typeof msg.id === "number") {
        this.pending.delete(msg.id);
        settle(msg);
      }
      return;
    }
    // Server→client request: auto-reply with safe defaults.
    if (msg.id !== undefined && msg.method !== undefined) {
      let result: unknown = null;
      if (msg.method === "workspace/configuration") {
        const items = (msg.params as { items?: unknown[] } | undefined)?.items ?? [];
        result = items.map(() => null);
      }
      this.send({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    // Notification.
    if (msg.method !== undefined) {
      const handlers = this.notificationHandlers.get(msg.method);
      if (handlers) {
        for (const handler of handlers) handler(msg.params);
      }
    }
  }
}
