// Live preview's frame server. It serves the chat (a cross-origin iframe on the
// previewed page) and the only route from it to the preview session. The page
// itself is untrusted: its scripts can't read or drive this origin, every API
// call needs a custom header (so a cross-origin preflight we never approve)
// and, when the browser sends one, this server's own Origin.
import fs from "node:fs/promises";
import http from "node:http";
import type net from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { SessionContext } from "../session-types.js";

export const LIVE_HEADER = "x-gg-live";

export interface FrameConfig {
  /** The dev server the agent is told about (not the proxy). */
  devUrl: string;
  /** Origins the page proxy is reachable at; the only parents the frame talks to. */
  proxyOrigins: string[];
}

export interface FrameServerOptions {
  assetsDir: string;
  session: () => SessionContext | null;
  config: () => FrameConfig;
  /** SSE frames broadcast so far, so a reloaded page rebuilds its transcript. */
  replay: () => readonly string[];
  usage: (provider: "anthropic" | "moonshot") => Promise<unknown>;
}

export interface FrameServer {
  server: http.Server;
  listen: (port: number) => Promise<number>;
  close: () => Promise<void>;
  origin: () => string;
}

// The frame's API, and the session route each maps to. Nothing else reaches the session.
const ROUTES: Record<string, { method: "GET" | "POST"; to: string }> = {
  "/api/events": { method: "GET", to: "/events" },
  "/api/state": { method: "GET", to: "/state" },
  "/api/models": { method: "GET", to: "/models" },
  "/api/model": { method: "POST", to: "/model" },
  "/api/prompt": { method: "POST", to: "/prompt" },
  "/api/cancel": { method: "POST", to: "/cancel" },
  "/api/enhance": { method: "POST", to: "/enhance" },
  "/api/git/overview": { method: "GET", to: "/git/overview" },
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
};

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * Whether an API request comes from the frame itself. Exported for tests.
 * The custom header can't be sent cross-origin without a preflight, and we
 * answer every preflight without CORS headers, so browsers block it.
 */
export function fromFrame(req: http.IncomingMessage, frameOrigin: string): boolean {
  if (req.headers[LIVE_HEADER] !== "1") return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== frameOrigin) return false;
  // Browsers always send Origin on POST: a POST without one isn't from the frame.
  if (req.method !== "GET" && origin === undefined) return false;
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin";
}

export function frameCsp(proxyOrigins: readonly string[]): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src * data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${proxyOrigins.join(" ") || "'none'"}`,
  ].join("; ");
}

export function createFrameServer(opts: FrameServerOptions): FrameServer {
  const port = (): number => (server.address() as AddressInfo | null)?.port ?? 0;
  const origin = (): string => `http://127.0.0.1:${port()}`;
  const root = path.resolve(opts.assetsDir);

  async function serveFile(res: http.ServerResponse, rel: string, extra = {}): Promise<void> {
    const file = path.resolve(root, `.${rel}`);
    if (file !== root && !file.startsWith(root + path.sep)) {
      send(res, 404, { error: "not found" });
      return;
    }
    const body = await fs.readFile(file).catch(() => null);
    if (!body) {
      send(res, 404, { error: "not found" });
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      // Hashed assets can be kept; the entry points change with every build.
      "cache-control": rel.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    });
    res.end(body);
  }

  function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    if (!fromFrame(req, origin())) {
      send(res, 403, { error: "forbidden" });
      return;
    }
    if (url.pathname === "/api/config" && req.method === "GET") {
      send(res, 200, opts.config());
      return;
    }
    if (url.pathname === "/api/usage" && req.method === "GET") {
      const provider = url.searchParams.get("provider");
      if (provider !== "anthropic" && provider !== "moonshot") {
        send(res, 400, { error: "unsupported usage provider" });
        return;
      }
      opts.usage(provider).then(
        (body) => send(res, 200, body),
        () => send(res, 500, { error: "Usage is temporarily unavailable." }),
      );
      return;
    }
    const route = ROUTES[url.pathname];
    if (!route || route.method !== req.method) {
      send(res, 404, { error: `${url.pathname} isn't available in the live preview` });
      return;
    }
    const ctx = opts.session();
    if (!ctx) {
      send(res, 503, { error: "Live preview has stopped. Start it again from GG Coder." });
      return;
    }
    req.url = route.to;
    ctx.handle(req, res, route.to, route.method);
    // The events route answers synchronously with its `ready` frame; what the
    // session said before this page loaded follows it, then live events.
    if (route.to === "/events") for (const frame of opts.replay()) res.write(frame);
  }

  const server = http.createServer((req, res) => {
    // Only the address the frame is loaded from: blocks DNS rebinding and keeps one Origin.
    if (req.headers.host !== `127.0.0.1:${port()}`) {
      send(res, 403, { error: "forbidden host" });
      return;
    }
    // Preflights get no CORS grant, so cross-origin pages can't send the custom header.
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? "/", origin());
    if (url.pathname.startsWith("/api/")) {
      api(req, res, url);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { error: "method not allowed" });
      return;
    }
    if (url.pathname === "/page.js") {
      void serveFile(res, "/page.js");
      return;
    }
    if (url.pathname === "/frame" || url.pathname === "/frame.html") {
      void serveFile(res, "/frame.html", {
        "content-security-policy": frameCsp(opts.config().proxyOrigins),
      });
      return;
    }
    if (url.pathname.startsWith("/assets/")) {
      void serveFile(res, url.pathname);
      return;
    }
    send(res, 404, { error: "not found" });
  });

  const sockets = new Set<net.Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  return {
    server,
    origin,
    listen: (p) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(p, "127.0.0.1", () => {
          server.off("error", reject);
          resolve(port());
        });
      }),
    close: () =>
      new Promise((resolve) => {
        // Open event streams would hold close() open forever.
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
