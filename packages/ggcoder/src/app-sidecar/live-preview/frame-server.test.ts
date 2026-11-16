import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionContext } from "../session-types.js";
import { createFrameServer, frameCsp, type FrameServer } from "./frame-server.js";

let dir: string;
let frame: FrameServer;
let port: number;
let calls: Array<{ url: string; method: string }>;
let session: SessionContext | null;

const fakeSession = (): SessionContext =>
  ({
    id: "preview",
    handle: (_req: http.IncomingMessage, res: http.ServerResponse, url: string, method: string) => {
      calls.push({ url, method });
      if (url === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: {"type":"ready"}\n\n`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ url }));
    },
  }) as unknown as SessionContext;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-frame-"));
  await fs.mkdir(path.join(dir, "assets"));
  await fs.writeFile(path.join(dir, "frame.html"), "<!doctype html><title>frame</title>");
  await fs.writeFile(path.join(dir, "page.js"), "/* page */");
  await fs.writeFile(path.join(dir, "assets", "frame-abc.js"), "/* frame */");
  await fs.writeFile(path.join(os.tmpdir(), "gg-frame-secret.txt"), "secret");
  calls = [];
  session = fakeSession();
  frame = createFrameServer({
    assetsDir: dir,
    session: () => session,
    config: () => ({ devUrl: "http://localhost:5173/", proxyOrigins: ["http://localhost:4100"] }),
    replay: () => [`data: {"type":"old"}\n\n`],
    usage: async (provider) => ({ provider }),
  });
  port = await frame.listen(0);
});

afterEach(async () => {
  await frame.close();
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(path.join(os.tmpdir(), "gg-frame-secret.txt"), { force: true });
});

function request(
  pathname: string,
  opts: { method?: string; headers?: Record<string, string>; until?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: opts.method ?? "GET",
        headers: { host: `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
          // Event streams never end: stop once the expected text arrived.
          if (opts.until && body.includes(opts.until)) {
            req.destroy();
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
          }
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", (e) => (opts.until ? undefined : reject(e)));
    req.end(opts.method === "POST" ? "{}" : undefined);
  });
}

const frameHeaders = () => ({ "x-gg-live": "1", origin: `http://127.0.0.1:${port}` });

describe("live preview frame server", () => {
  it("maps the allowed routes onto the preview session", async () => {
    const r = await request("/api/prompt", { method: "POST", headers: frameHeaders() });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ url: "/prompt" });
    await request("/api/state", { headers: { "x-gg-live": "1", "sec-fetch-site": "same-origin" } });
    await request("/api/git/overview", { headers: { "x-gg-live": "1" } });
    expect(calls).toEqual([
      { url: "/prompt", method: "POST" },
      { url: "/state", method: "GET" },
      { url: "/git/overview", method: "GET" },
    ]);
  });

  it("fails closed for anything not on the list", async () => {
    for (const p of ["/api/shell/run", "/api/session", "/api/tasks/run"]) {
      expect((await request(p, { method: "POST", headers: frameHeaders() })).status).toBe(404);
    }
    // Right path, wrong method.
    expect((await request("/api/prompt", { headers: { "x-gg-live": "1" } })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("rejects requests that don't come from the frame", async () => {
    const cases: Array<{ method?: string; headers: Record<string, string> }> = [
      // No custom header: a form post or a simple fetch from the page.
      { method: "POST", headers: { origin: `http://127.0.0.1:${port}` } },
      // The previewed page's own origin.
      { method: "POST", headers: { "x-gg-live": "1", origin: "http://localhost:4100" } },
      // A POST that carries no Origin at all.
      { method: "POST", headers: { "x-gg-live": "1" } },
      { headers: { "x-gg-live": "1", "sec-fetch-site": "cross-site" } },
      { headers: { "x-gg-live": "1", "sec-fetch-site": "same-site" } },
    ];
    for (const c of cases) {
      const r = await request("/api/prompt", { method: c.method, headers: c.headers });
      expect(r.status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it("rejects other Host names and grants no CORS on preflight", async () => {
    const r = await request("/api/state", {
      headers: { host: `localhost:${port}`, "x-gg-live": "1" },
    });
    expect(r.status).toBe(403);
    const pre = await request("/api/prompt", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:4100", "access-control-request-method": "POST" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("streams events with what the session said before the page loaded", async () => {
    const r = await request("/api/events", { headers: { "x-gg-live": "1" }, until: "old" });
    expect(r.body.indexOf("ready")).toBeLessThan(r.body.indexOf("old"));
  });

  it("serves config and usage, and 503s once the preview stopped", async () => {
    const config = await request("/api/config", { headers: { "x-gg-live": "1" } });
    expect(JSON.parse(config.body)).toMatchObject({ devUrl: "http://localhost:5173/" });
    const usage = await request("/api/usage?provider=anthropic", { headers: { "x-gg-live": "1" } });
    expect(JSON.parse(usage.body)).toEqual({ provider: "anthropic" });
    expect(
      (await request("/api/usage?provider=openai", { headers: { "x-gg-live": "1" } })).status,
    ).toBe(400);
    session = null;
    expect((await request("/api/state", { headers: { "x-gg-live": "1" } })).status).toBe(503);
  });

  it("serves the frame with frame-ancestors locked to the proxy, and nothing outside its folder", async () => {
    const page = await request("/frame");
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain(
      "frame-ancestors http://localhost:4100",
    );
    expect((await request("/page.js")).body).toBe("/* page */");
    expect((await request("/assets/frame-abc.js")).body).toBe("/* frame */");
    expect((await request("/assets/../../gg-frame-secret.txt")).status).toBe(404);
    expect((await request("/assets/%2e%2e/%2e%2e/gg-frame-secret.txt")).status).toBe(404);
  });

  it("refuses every parent when no proxy is running", () => {
    expect(frameCsp([])).toContain("frame-ancestors 'none'");
  });
});
