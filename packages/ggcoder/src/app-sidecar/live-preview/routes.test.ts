import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContext } from "../session-types.js";
import type { LivePreviewManager } from "./manager.js";
import { handleLivePreviewRoutes } from "./routes.js";

let server: http.Server;
let port: number;
let manager: LivePreviewManager;
let ctx: SessionContext;
let passed: string[];

beforeEach(async () => {
  passed = [];
  ctx = { id: "w1", mode: "code", cwd: "/proj" } as unknown as SessionContext;
  manager = {
    start: vi.fn(async (_w: SessionContext, opts?: { url?: string }) => ({
      running: true,
      url: "http://localhost:4100/",
      target: opts?.url ?? "http://localhost:5173/",
    })),
    stop: vi.fn(async () => ({ running: false, url: null, target: null })),
    status: vi.fn(() => ({ running: false, url: null, target: null })),
    onSessionClosed: vi.fn(async () => {}),
    isPreviewSession: vi.fn((id: string) => id === "preview"),
    stopAll: vi.fn(async () => {}),
  };
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (handleLivePreviewRoutes(manager, ctx, req, res, url, req.method ?? "GET")) return;
    passed.push(url);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function call(pathname: string, method = "GET", body?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, body });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, unknown>,
  };
}

describe("live preview routes", () => {
  it("starts with a typed address, or detects one without", async () => {
    expect(
      (await call("/live-preview/start", "POST", JSON.stringify({ url: "localhost:3000" }))).body,
    ).toMatchObject({
      running: true,
      target: "localhost:3000",
    });
    expect(manager.start).toHaveBeenLastCalledWith(ctx, { url: "localhost:3000" });
    await call("/live-preview/start", "POST", "");
    expect(manager.start).toHaveBeenLastCalledWith(ctx, {});
  });

  it("rejects bad bodies and starts from preview or non-code sessions", async () => {
    expect((await call("/live-preview/start", "POST", "{")).status).toBe(400);
    expect((await call("/live-preview/start", "POST", JSON.stringify({ url: 3 }))).status).toBe(
      400,
    );
    ctx = { ...ctx, id: "preview" } as SessionContext;
    expect((await call("/live-preview/start", "POST", "{}")).status).toBe(400);
    ctx = { ...ctx, id: "w2", mode: "chat" } as SessionContext;
    expect((await call("/live-preview/start", "POST", "{}")).status).toBe(400);
    expect(manager.start).not.toHaveBeenCalled();
  });

  it("reports a failed start as an error", async () => {
    vi.mocked(manager.start).mockRejectedValueOnce(new Error("EADDRINUSE"));
    const r = await call("/live-preview/start", "POST", "{}");
    expect(r.status).toBe(500);
    expect(r.body.error).toContain("EADDRINUSE");
  });

  it("stops and reports status for the window session", async () => {
    expect((await call("/live-preview/stop", "POST")).body).toMatchObject({ running: false });
    expect(manager.stop).toHaveBeenCalledWith("w1");
    await call("/live-preview/status");
    expect(manager.status).toHaveBeenCalledWith("w1");
    expect((await call("/live-preview/nope")).status).toBe(404);
  });

  it("leaves every other route to the session", async () => {
    await call("/state");
    expect(passed).toEqual(["/state"]);
  });
});
