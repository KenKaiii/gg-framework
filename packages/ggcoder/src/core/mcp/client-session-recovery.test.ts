import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTool, ToolContext } from "@kleio/agent";
import { MCPClientManager } from "./client.js";
import { McpCatalogCache } from "./catalog-cache.js";
import type { MCPServerConfig } from "./types.js";

const PROTOCOL_VERSION = "2025-11-25";

/**
 * A minimal Streamable-HTTP MCP server with controllable session lifetime.
 *
 * Real remote servers drop sessions on restart or idle sweep, after which every
 * request carrying the stale `Mcp-Session-Id` gets a bare HTTP 404 — the exact
 * failure the SDK has no recovery for. `expireAll()` reproduces it on demand.
 */
interface StubServer {
  url: string;
  /** How many `initialize` handshakes the server has seen. One per connection. */
  initializeCount: number;
  /** Number of requests currently parked by `holdExpired`. */
  heldCount: number;
  /** Invalidate every issued session; later requests bearing one get a 404. */
  expireAll: () => void;
  /** Park expired-session requests instead of answering, so they overlap. */
  holdExpired: (hold: boolean) => void;
  /** Answer every parked request with its 404. */
  releaseHeld: () => void;
  /** 404 all tool traffic regardless of session — the server can never recover. */
  breakToolTraffic: (broken: boolean) => void;
  close: () => Promise<void>;
}

async function startStubServer(): Promise<StubServer> {
  const validSessions = new Set<string>();
  let generation = 0;
  let holding = false;
  let toolTrafficBroken = false;
  const held: Array<() => void> = [];

  const state = {
    initializeCount: 0,
    get heldCount() {
      return held.length;
    },
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => resolve(raw));
      req.on("error", reject);
    });

  const server = http.createServer((req, res) => {
    // The SDK opens a standalone GET for server→client streaming and DELETEs on
    // teardown. 405 is the spec's "not offered", which it handles cleanly.
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    void readBody(req).then((raw) => {
      let message: { id?: number | string; method?: string; params?: unknown };
      try {
        message = JSON.parse(raw);
      } catch {
        res.writeHead(400).end();
        return;
      }

      const isNotification = message.id === undefined || message.id === null;
      const sendResult = (result: unknown, headers: Record<string, string> = {}) => {
        const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
        res.writeHead(200, { "content-type": "application/json", ...headers }).end(body);
      };

      if (message.method === "initialize") {
        state.initializeCount += 1;
        const sessionId = `session-${++generation}`;
        validSessions.add(sessionId);
        sendResult(
          {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "session-fixture", version: "1.0.0" },
          },
          { "mcp-session-id": sessionId },
        );
        return;
      }

      const sessionId = req.headers["mcp-session-id"];
      const isToolTraffic = message.method === "tools/list" || message.method === "tools/call";
      const expired =
        (typeof sessionId === "string" && !validSessions.has(sessionId)) ||
        (toolTrafficBroken && isToolTraffic);
      if (expired) {
        const reply = () => {
          res.writeHead(404, { "content-type": "text/plain" }).end("Session not found");
        };
        if (holding) held.push(reply);
        else reply();
        return;
      }

      if (isNotification) {
        res.writeHead(202).end();
        return;
      }

      switch (message.method) {
        case "ping":
          sendResult({});
          return;
        case "tools/list":
          sendResult({
            tools: [
              {
                name: "echo",
                description: "Echo the provided text back to the caller",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
            ],
          });
          return;
        case "tools/call": {
          const args = (message.params as { arguments?: { text?: unknown } } | undefined)
            ?.arguments;
          sendResult({ content: [{ type: "text", text: String(args?.text ?? "") }] });
          return;
        }
        default:
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: `Method not found: ${message.method}` },
            }),
          );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    get initializeCount() {
      return state.initializeCount;
    },
    get heldCount() {
      return held.length;
    },
    expireAll: () => validSessions.clear(),
    holdExpired: (hold: boolean) => {
      holding = hold;
    },
    releaseHeld: () => {
      holding = false;
      while (held.length > 0) held.shift()?.();
    },
    breakToolTraffic: (broken: boolean) => {
      toolTrafficBroken = broken;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function toolContext(signal?: AbortSignal): ToolContext {
  return { signal: signal ?? new AbortController().signal, toolCallId: "call-1" };
}

async function runTool(tool: AgentTool, text: string, signal?: AbortSignal): Promise<string> {
  const result = await tool.execute({ text }, toolContext(signal));
  return typeof result === "string" ? result : JSON.stringify(result);
}

let dir: string;
let stub: StubServer;
const managers: MCPClientManager[] = [];

function manager(): MCPClientManager {
  const instance = new MCPClientManager({
    catalogCache: new McpCatalogCache(path.join(dir, "mcp-catalog.json")),
  });
  managers.push(instance);
  return instance;
}

function httpConfig(): MCPServerConfig {
  return { name: "session-fixture", url: stub.url, timeout: 10_000 };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-session-"));
  stub = await startStubServer();
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((instance) => instance.dispose()));
  await stub.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("MCP HTTP session recovery", () => {
  it("reconnects once and replays the call when the session has expired", async () => {
    const mcp = manager();
    const tools = await mcp.connectAll([httpConfig()]);
    const echo = tools.find((t) => t.name === "mcp__session-fixture__echo");
    expect(echo).toBeDefined();
    expect(stub.initializeCount).toBe(1);

    stub.expireAll();

    expect(await runTool(echo!, "after-expiry")).toBe("after-expiry");
    expect(stub.initializeCount).toBe(2);
  }, 30_000);

  it("coalesces concurrent expiries into exactly one reconnect", async () => {
    const mcp = manager();
    const tools = await mcp.connectAll([httpConfig()]);
    const echo = tools.find((t) => t.name === "mcp__session-fixture__echo")!;

    // Park the 404s so all three calls are in flight at once. The manager
    // paces calls to one server 2s apart, so without parking the first would
    // have finished recovering long before the others even started.
    stub.expireAll();
    stub.holdExpired(true);

    const calls = Promise.all([runTool(echo, "a"), runTool(echo, "b"), runTool(echo, "c")]);

    await waitFor(() => stub.heldCount === 3, 15_000);
    stub.releaseHeld();

    expect(await calls).toEqual(["a", "b", "c"]);
    // 1 initial + 1 shared reconnect. Three would mean the coalescing map leaked.
    expect(stub.initializeCount).toBe(2);
  }, 30_000);

  it("fails after a single retry against a permanently expired server", async () => {
    const mcp = manager();
    const tools = await mcp.connectAll([httpConfig()]);
    const echo = tools.find((t) => t.name === "mcp__session-fixture__echo")!;

    // The handshake still works, but the server 404s all tool traffic — so a
    // rebuilt session is no better than the old one.
    stub.breakToolTraffic(true);

    await expect(runTool(echo, "doomed")).rejects.toThrow(/MCP tool error.*404/s);
    // Exactly one recovery attempt — a retry loop would keep climbing.
    expect(stub.initializeCount).toBe(2);
  }, 30_000);

  it("does not resurrect a call that was aborted while in flight", async () => {
    const mcp = manager();
    const tools = await mcp.connectAll([httpConfig()]);
    const echo = tools.find((t) => t.name === "mcp__session-fixture__echo")!;

    const controller = new AbortController();
    controller.abort();
    stub.expireAll();

    await expect(runTool(echo, "cancelled", controller.signal)).rejects.toThrow("MCP tool error");
    // No reconnect: the user cancelled, so replaying the work would be wrong.
    expect(stub.initializeCount).toBe(1);
  }, 30_000);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}
