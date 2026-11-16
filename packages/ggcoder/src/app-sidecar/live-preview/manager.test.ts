import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackgroundProcess } from "../../core/process-manager.js";
import type { SessionContext, SseClient } from "../session-types.js";
import {
  createLivePreviewManager,
  findLivePreviewAssets,
  parseDevUrl,
  type LivePreviewManager,
} from "./manager.js";

let dir: string;
let manager: LivePreviewManager;
let created: SessionContext[];
let closed: string[];
let dev: http.Server;
let devUrl: string;

function fakeCtx(id: string, cwd: string, processes: BackgroundProcess[] = []): SessionContext {
  const clients = new Set<SseClient>();
  return {
    id,
    cwd,
    clients,
    session: { listBackgroundProcesses: () => processes },
    broadcast: (type: string, data: unknown) => {
      for (const c of clients) c.res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    },
    handle: (_req: http.IncomingMessage, res: http.ServerResponse, url: string) => {
      if (url === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: {"type":"ready"}\n\n`);
        return;
      }
      res.writeHead(200).end("{}");
    },
  } as unknown as SessionContext;
}

function get(port: number, pathname: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        headers: { host: `localhost:${port}`, ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-live-"));
  await fs.writeFile(path.join(dir, "page.js"), "/* page */");
  await fs.writeFile(path.join(dir, "frame.html"), "<!doctype html>");
  created = [];
  closed = [];
  manager = createLivePreviewManager({
    assetsDir: dir,
    createSession: async (cwd) => {
      const ctx = fakeCtx(`preview-${created.length + 1}`, cwd);
      created.push(ctx);
      return ctx;
    },
    closeSession: async (id) => void closed.push(id),
    usage: async () => ({}),
  });
  dev = http.createServer((_req, res) =>
    res
      .writeHead(200, { "content-type": "text/html" })
      .end("<html><head></head><body>app</body></html>"),
  );
  await new Promise<void>((r) => dev.listen(0, "127.0.0.1", r));
  devUrl = `http://127.0.0.1:${(dev.address() as AddressInfo).port}/`;
});

afterEach(async () => {
  await manager.stopAll();
  dev.closeAllConnections();
  await new Promise<void>((r) => dev.close(() => r()));
  await fs.rm(dir, { recursive: true, force: true });
});

describe("parseDevUrl", () => {
  it("accepts a bare host:port and refuses https and other schemes", () => {
    expect(String(parseDevUrl("localhost:3000"))).toBe("http://localhost:3000/");
    expect(String(parseDevUrl("http://0.0.0.0:8080/app"))).toBe("http://localhost:8080/app");
    expect(parseDevUrl("https://localhost:3000")).toMatchObject({
      error: expect.stringContaining("https"),
    });
    expect(parseDevUrl("ftp://x")).toMatchObject({ error: expect.any(String) });
  });
});

describe("live preview manager", () => {
  it("starts its own session in the window's folder and serves the page with the overlay", async () => {
    const window = fakeCtx("w1", "/proj");
    const status = await manager.start(window, { url: devUrl });
    expect(status.running).toBe(true);
    expect(created.map((c) => c.cwd)).toEqual(["/proj"]);
    expect(manager.isPreviewSession("preview-1")).toBe(true);
    const port = Number(new URL(status.url!).port);
    const page = await get(port, "/", { "sec-fetch-dest": "document" });
    expect(page.body).toMatch(
      /<head><script defer src="http:\/\/127\.0\.0\.1:\d+\/page\.js"><\/script><\/head>/,
    );
    const framePort = Number(/127\.0\.0\.1:(\d+)/.exec(page.body)![1]);
    const script = await get(framePort, "/page.js", { host: `127.0.0.1:${framePort}` });
    expect(script.body).toBe("/* page */");
  });

  it("finds the dev server in the window's background process logs", async () => {
    const log = path.join(dir, "dev.log");
    await fs.writeFile(log, `  Local:   ${devUrl}\n`);
    const window = fakeCtx("w1", "/proj", [
      {
        id: "b1",
        pid: 1,
        command: "pnpm dev",
        logFile: log,
        startedAt: 1,
        exitCode: null,
      } as BackgroundProcess,
    ]);
    const status = await manager.start(window);
    expect(status.target).toBe(devUrl.replace("127.0.0.1", "localhost"));
  });

  it("asks for an address when nothing is running, and explains https", async () => {
    expect(await manager.start(fakeCtx("w1", "/proj"))).toMatchObject({
      running: false,
      needsUrl: true,
    });
    expect(
      await manager.start(fakeCtx("w1", "/proj"), { url: "https://localhost:3000" }),
    ).toMatchObject({
      running: false,
      error: expect.stringContaining("https"),
    });
    expect(created).toEqual([]);
  });

  it("reuses one preview for a double start and keeps the port for the project", async () => {
    const window = fakeCtx("w1", "/proj");
    const [a, b] = await Promise.all([
      manager.start(window, { url: devUrl }),
      manager.start(window, { url: devUrl }),
    ]);
    expect(a.url).toBe(b.url);
    expect(created).toHaveLength(1);
    await manager.stop("w1");
    expect(closed).toEqual(["preview-1"]);
    expect(manager.status("w1").running).toBe(false);
    const again = await manager.start(window, { url: devUrl });
    expect(again.url).toBe(a.url);
  });

  it("tells the window when its preview starts and stops", async () => {
    const changes: Array<[string, boolean]> = [];
    const watched = createLivePreviewManager({
      assetsDir: dir,
      createSession: async (cwd) => fakeCtx("preview-x", cwd),
      closeSession: async () => {},
      usage: async () => ({}),
      onChange: (id, s) => changes.push([id, s.running]),
    });
    await watched.start(fakeCtx("w1", "/proj"), { url: devUrl });
    await watched.stop("w1");
    expect(changes).toEqual([
      ["w1", true],
      ["w1", false],
    ]);
  });

  it("stops when its window or its own session closes", async () => {
    await manager.start(fakeCtx("w1", "/a"), { url: devUrl });
    await manager.start(fakeCtx("w2", "/b"), { url: devUrl });
    await manager.onSessionClosed("w1");
    expect(manager.status("w1").running).toBe(false);
    expect(closed).toEqual(["preview-1"]);
    await manager.onSessionClosed("preview-2");
    expect(manager.status("w2").running).toBe(false);
  });

  it("replays what the session said to a page that loads later", async () => {
    const status = await manager.start(fakeCtx("w1", "/proj"), { url: devUrl });
    created[0].broadcast("live_preview_prompt", { text: "make it blue" });
    const page = await get(Number(new URL(status.url!).port), "/", {
      "sec-fetch-dest": "document",
    });
    const framePort = Number(/127\.0\.0\.1:(\d+)/.exec(page.body)![1]);
    const events = await new Promise<string>((resolve) => {
      const req = http.get(
        {
          host: "127.0.0.1",
          port: framePort,
          path: "/api/events",
          headers: { host: `127.0.0.1:${framePort}`, "x-gg-live": "1" },
        },
        (res) => {
          let body = "";
          res.on("data", (c: Buffer) => {
            body += c.toString();
            if (body.includes("make it blue")) {
              req.destroy();
              resolve(body);
            }
          });
        },
      );
    });
    expect(events).toContain("ready");
    expect(events).toContain("make it blue");
  });

  it("says so when the overlay isn't in the build", async () => {
    const bare = createLivePreviewManager({
      assetsDir: null,
      createSession: async () => {
        throw new Error("should not start");
      },
      closeSession: async () => {},
      usage: async () => ({}),
    });
    expect(await bare.start(fakeCtx("w1", "/proj"), { url: devUrl })).toMatchObject({
      running: false,
      error: expect.stringContaining("isn't included"),
    });
    expect(findLivePreviewAssets([path.join(dir, "missing"), dir])).toBe(dir);
    expect(findLivePreviewAssets([path.join(dir, "missing")])).toBeNull();
  });
});

describe("live preview with many windows open", () => {
  it("keeps each window on its own project's dev server, session and link", async () => {
    const other = http.createServer((_req, res) =>
      res
        .writeHead(200, { "content-type": "text/html" })
        .end("<html><head></head><body>blog</body></html>"),
    );
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}/`;
    try {
      const windowFor = async (id: string, cwd: string, url: string) => {
        const log = path.join(dir, `${id}.log`);
        await fs.writeFile(log, `  Local:   ${url}\n`);
        return fakeCtx(id, cwd, [
          {
            id: `${id}-dev`,
            pid: 1,
            command: "npm run dev",
            logFile: log,
            startedAt: 1,
            exitCode: null,
          } as BackgroundProcess,
        ]);
      };
      const shop = await windowFor("w-shop", "/work/shop", devUrl);
      const blog = await windowFor("w-blog", "/work/blog", otherUrl);
      const shop2 = await windowFor("w-shop-2", "/work/shop", devUrl);
      const [a, b, c] = await Promise.all([
        manager.start(shop),
        manager.start(blog),
        manager.start(shop2),
      ]);
      expect(a.target).toBe(devUrl.replace("127.0.0.1", "localhost"));
      expect(b.target).toBe(otherUrl.replace("127.0.0.1", "localhost"));
      expect(c.target).toBe(a.target);
      expect(new Set([a.url, b.url, c.url]).size).toBe(3);
      expect(created.map((s) => s.cwd).sort()).toEqual(["/work/blog", "/work/shop", "/work/shop"]);
      const blogPage = await get(Number(new URL(b.url!).port), "/", {
        "sec-fetch-dest": "document",
      });
      expect(blogPage.body).toContain("blog");

      await manager.stop("w-blog");
      expect(manager.status("w-blog").running).toBe(false);
      expect(manager.status("w-shop").running).toBe(true);
      expect(manager.status("w-shop-2").running).toBe(true);
    } finally {
      other.closeAllConnections();
      await new Promise<void>((r) => other.close(() => r()));
    }
  });

  it("finds a server the user started in the project when the window started none", async () => {
    const scanned: string[] = [];
    const scanning = createLivePreviewManager({
      assetsDir: dir,
      createSession: async (cwd) => fakeCtx("preview-s", cwd),
      closeSession: async () => {},
      usage: async () => ({}),
      scan: async (cwd) => (
        scanned.push(cwd),
        cwd === "/work/shop" ? [Number(new URL(devUrl).port)] : []
      ),
      probe: async () => "html",
    });
    try {
      expect((await scanning.start(fakeCtx("w1", "/work/shop"))).running).toBe(true);
      expect(await scanning.start(fakeCtx("w2", "/work/blog"))).toMatchObject({
        running: false,
        needsUrl: true,
      });
      expect(scanned).toEqual(["/work/shop", "/work/blog"]);
    } finally {
      await scanning.stopAll();
    }
  });
});
