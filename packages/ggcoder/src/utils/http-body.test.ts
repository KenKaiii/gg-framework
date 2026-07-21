import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_HTTP_BODY_BYTES, readCappedBody } from "./http-body.js";

// Spin up a real HTTP server whose handler pipes the request through
// readCappedBody, then POST bodies of various sizes and assert the cap.
function startServer(maxBytes?: number): Promise<{
  url: string;
  results: Array<string | null>;
  close: () => Promise<void>;
}> {
  const results: Array<string | null> = [];
  const server = http.createServer((req, res) => {
    void readCappedBody(req, res, maxBytes).then((body) => {
      results.push(body);
      if (body === null) return; // 413 already sent by readCappedBody
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ bytes: body.length }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        results,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("readCappedBody", () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it("reads a normal body in full and resolves the string", async () => {
    const srv = await startServer();
    close = srv.close;
    const resp = await fetch(`${srv.url}/x`, { method: "POST", body: "hello world" });
    const json = (await resp.json()) as { bytes: number };
    expect(resp.status).toBe(200);
    expect(json.bytes).toBe("hello world".length);
    expect(srv.results.at(-1)).toBe("hello world");
  });

  it("rejects an over-cap body with 413 and resolves null", async () => {
    const cap = 1024; // 1 KB cap for the test
    const srv = await startServer(cap);
    close = srv.close;
    const big = "x".repeat(cap * 4); // 4 KB > cap
    const resp = await fetch(`${srv.url}/x`, { method: "POST", body: big });
    expect(resp.status).toBe(413);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toMatch(/too large/i);
    // The handler observed null and never ran its success branch.
    expect(srv.results.at(-1)).toBeNull();
  });

  it("accepts a body exactly at the cap", async () => {
    const cap = 2048;
    const srv = await startServer(cap);
    close = srv.close;
    const body = "y".repeat(cap);
    const resp = await fetch(`${srv.url}/x`, { method: "POST", body });
    expect(resp.status).toBe(200);
    expect(srv.results.at(-1)).toBe(body);
  });

  it("exposes a 10 MB default cap", () => {
    expect(MAX_HTTP_BODY_BYTES).toBe(10 * 1024 * 1024);
  });
});
