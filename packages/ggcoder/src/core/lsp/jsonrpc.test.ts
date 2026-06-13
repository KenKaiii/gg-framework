import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { JsonRpcConnection, JsonRpcRequestError } from "./jsonrpc.js";

interface CapturedMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function frame(msg: unknown): string {
  const body = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

/** Collects framed messages the connection writes to its output stream. */
function captureOutput(output: PassThrough): CapturedMessage[] {
  const messages: CapturedMessage[] = [];
  let buffer = Buffer.alloc(0);
  output.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString());
      if (!match) return;
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      messages.push(JSON.parse(buffer.subarray(start, start + length).toString()));
      buffer = buffer.subarray(start + length);
    }
  });
  return messages;
}

function makeConnection(): {
  conn: JsonRpcConnection;
  serverIn: PassThrough;
  sent: CapturedMessage[];
} {
  const serverIn = new PassThrough(); // server → client bytes
  const clientOut = new PassThrough(); // client → server bytes
  const sent = captureOutput(clientOut);
  const conn = new JsonRpcConnection(serverIn, clientOut);
  return { conn, serverIn, sent };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("JsonRpcConnection", () => {
  it("round-trips a request and its framed response", async () => {
    const { conn, serverIn, sent } = makeConnection();

    const pending = conn.request("initialize", { rootUri: "file:///x" }, 1000);
    await tick();

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("initialize");
    expect(sent[0].params).toEqual({ rootUri: "file:///x" });

    serverIn.write(frame({ jsonrpc: "2.0", id: sent[0].id, result: { capabilities: {} } }));
    await expect(pending).resolves.toEqual({ capabilities: {} });
  });

  it("parses messages split across arbitrary chunk boundaries", async () => {
    const { conn, serverIn } = makeConnection();
    const received: unknown[] = [];
    conn.onNotification("textDocument/publishDiagnostics", (params) => received.push(params));

    const params = { uri: "file:///a.ts", diagnostics: [{ message: "boom" }] };
    const bytes = Buffer.from(
      frame({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params }),
    );

    // Drip-feed one byte at a time — worst-case TCP/pipe fragmentation.
    for (const byte of bytes) {
      serverIn.write(Buffer.from([byte]));
    }
    await tick();

    expect(received).toEqual([params]);
  });

  it("parses multiple messages arriving in a single chunk", async () => {
    const { conn, serverIn } = makeConnection();
    const received: unknown[] = [];
    conn.onNotification("note", (params) => received.push(params));

    serverIn.write(
      frame({ jsonrpc: "2.0", method: "note", params: { n: 1 } }) +
        frame({ jsonrpc: "2.0", method: "note", params: { n: 2 } }),
    );
    await tick();

    expect(received).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("auto-replies to workspace/configuration with one null per item", async () => {
    const { serverIn, sent } = makeConnection();

    serverIn.write(
      frame({
        jsonrpc: "2.0",
        id: 99,
        method: "workspace/configuration",
        params: { items: [{ section: "a" }, { section: "b" }] },
      }),
    );
    await tick();

    expect(sent).toEqual([{ jsonrpc: "2.0", id: 99, result: [null, null] }]);
  });

  it("auto-replies null to other server→client requests", async () => {
    const { serverIn, sent } = makeConnection();

    serverIn.write(
      frame({ jsonrpc: "2.0", id: 7, method: "client/registerCapability", params: {} }),
    );
    serverIn.write(
      frame({ jsonrpc: "2.0", id: 8, method: "window/workDoneProgress/create", params: {} }),
    );
    await tick();

    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 7, result: null },
      { jsonrpc: "2.0", id: 8, result: null },
    ]);
  });

  it("rejects a request after its timeout elapses", async () => {
    const { conn } = makeConnection();

    await expect(conn.request("slow/method", null, 20)).rejects.toThrow(JsonRpcRequestError);
  });

  it("rejects with the server error payload", async () => {
    const { conn, serverIn, sent } = makeConnection();

    const pending = conn.request("textDocument/diagnostic", {}, 1000);
    await tick();
    serverIn.write(
      frame({
        jsonrpc: "2.0",
        id: sent[0].id,
        error: { code: -32802, message: "server cancelled" },
      }),
    );

    await expect(pending).rejects.toMatchObject({ code: -32802 });
  });

  it("skips malformed JSON bodies and keeps parsing subsequent messages", async () => {
    const { conn, serverIn } = makeConnection();
    const received: unknown[] = [];
    conn.onNotification("ok", (params) => received.push(params));

    const garbage = "{not json";
    serverIn.write(`Content-Length: ${Buffer.byteLength(garbage)}\r\n\r\n${garbage}`);
    serverIn.write(frame({ jsonrpc: "2.0", method: "ok", params: { fine: true } }));
    await tick();

    expect(received).toEqual([{ fine: true }]);
  });

  it("rejects all in-flight requests on dispose", async () => {
    const { conn } = makeConnection();

    const pending = conn.request("initialize", {}, 60_000);
    conn.dispose();

    await expect(pending).rejects.toMatchObject({ code: -32099 });
  });
});
