// Live preview's page proxy: sits in front of the project's dev server on its
// own local port, adds the overlay's page script to HTML documents, and passes
// everything else (assets, API calls, hot-reload websockets) straight through.
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

export interface PreviewProxyOptions {
  /** The dev server, e.g. http://localhost:5173/. */
  target: URL;
  /** Tags added right after `<head>` of every HTML document. */
  inject: string;
  /** The page served when the dev server can't be reached. */
  downPage: (target: URL) => string;
}

export interface PreviewProxy {
  server: http.Server;
  listen: (port: number) => Promise<number>;
  close: () => Promise<void>;
}

// Header marking our own "dev server is down" page, so its reload probe can tell it apart.
export const DOWN_HEADER = "x-gg-preview-down";
const MAX_HEAD_BYTES = 256 * 1024;
const META_CSP =
  /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy(?:-report-only)?["']?[^>]*>/gi;

/** The proxy's own addresses: anything else is a DNS-rebinding attempt. */
export function allowedHosts(port: number): Set<string> {
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
}

/** The dev server's own origins (localhost and 127.0.0.1 are the same server). */
function targetOrigins(target: URL): Set<string> {
  const port = target.port ? `:${target.port}` : "";
  return new Set([
    target.origin,
    `${target.protocol}//localhost${port}`,
    `${target.protocol}//127.0.0.1${port}`,
  ]);
}

/** Redirects to the dev server's own address would leave the preview: send them back here. */
export function rewriteLocation(location: string, target: URL, proxyHost: string): string {
  try {
    const u = new URL(location, target);
    if (targetOrigins(target).has(u.origin))
      return `http://${proxyHost}${u.pathname}${u.search}${u.hash}`;
  } catch {
    /* not a URL: leave it */
  }
  return location;
}

/**
 * Headers for the dev server: its own Host, and Origin/Referer pointing at it
 * rather than the proxy, so dev servers that check them (Next's dev origin
 * guard, Vite's websocket) see a same-origin request.
 */
function upstreamHeaders(
  headers: http.IncomingHttpHeaders,
  target: URL,
  proxyHost: string,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers, host: target.host };
  const self = [`http://${proxyHost}`];
  if (typeof out.origin === "string" && self.includes(out.origin)) out.origin = target.origin;
  if (typeof out.referer === "string" && out.referer.startsWith(`http://${proxyHost}/`))
    out.referer = target.origin + out.referer.slice(`http://${proxyHost}`.length);
  return out;
}

/** Remove `<meta http-equiv="Content-Security-Policy">` tags from an HTML head. */
export function stripMetaCsp(html: string): string {
  return html.replace(META_CSP, "");
}

/**
 * Where the page script goes in a buffered document start: after `<head>`,
 * else before `<body>`, else after `<html>`. Null for a fragment, which is
 * left alone (htmx-style partials are HTML too).
 */
export function injectionPoint(text: string): number | null {
  const head = /<head\b[^>]*>/i.exec(text);
  if (head) return head.index + head[0].length;
  const body = /<body\b/i.exec(text);
  if (body) return body.index;
  const html = /<html\b[^>]*>/i.exec(text);
  if (html) return html.index + html[0].length;
  return null;
}

/**
 * Streams the page through. The start is held until the head has passed (so
 * a `<meta>` CSP in it can be removed), then the page script is added and the
 * rest streams as it arrives, so streamed (SSR/Suspense) pages aren't held back.
 */
function injectStream(upRes: http.IncomingMessage, res: http.ServerResponse, inject: Buffer): void {
  let pending = Buffer.alloc(0);
  let done = false;
  const flush = (final: boolean): boolean => {
    // latin1 keeps byte offsets one to one with characters.
    const text = pending.toString("latin1");
    const headEnd = /<\/head\s*>|<body\b/i.exec(text);
    if (!headEnd && !final && pending.length < MAX_HEAD_BYTES) return false;
    const cut = headEnd ? headEnd.index : text.length;
    const head = stripMetaCsp(text.slice(0, cut));
    const at = injectionPoint(head);
    const start = Buffer.from(head, "latin1");
    const rest = pending.subarray(cut);
    res.write(
      at === null
        ? Buffer.concat([start, rest])
        : Buffer.concat([start.subarray(0, at), inject, start.subarray(at), rest]),
    );
    pending = Buffer.alloc(0);
    done = true;
    return true;
  };
  upRes.on("data", (chunk: Buffer) => {
    if (done) {
      res.write(chunk);
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    flush(false);
  });
  upRes.on("end", () => {
    if (!done) flush(true);
    res.end();
  });
  upRes.on("error", () => res.destroy());
}

/** Whether a request is a page load (gets the overlay), not a fetch or an asset. */
function isDocumentRequest(req: http.IncomingMessage): boolean {
  const dest = req.headers["sec-fetch-dest"];
  if (typeof dest === "string") return dest === "document" || dest === "iframe";
  return req.method === "GET" && String(req.headers.accept ?? "").includes("text/html");
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page shown while the dev server is down. It still loads the overlay, so the user can ask GG to start it. */
export function defaultDownPage(target: URL, inject: string): string {
  const where = escapeHtml(target.origin);
  return `<!doctype html><html lang="en"><head>${inject}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dev server isn't running</title>
<style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.55 system-ui,sans-serif;background:Canvas;color:CanvasText}main{max-width:32em;padding:24px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;opacity:.75}code{font-size:.92em}</style>
</head><body><main><h1>Your dev server isn't running</h1><p>Live preview can't reach <code>${where}</code>. Ask GG Coder below to start it. This page reloads once it's up.</p></main>
<script>setInterval(function(){fetch(location.href,{method:"HEAD",cache:"no-store"}).then(function(r){if(!r.headers.get("${DOWN_HEADER}"))location.reload()}).catch(function(){})},2000)</script>
</body></html>`;
}

export function createPreviewProxy(opts: PreviewProxyOptions): PreviewProxy {
  const { target } = opts;
  const inject = Buffer.from(opts.inject);
  const port = (): number => (server.address() as AddressInfo | null)?.port ?? 0;
  const hostOk = (host: string | undefined): host is string =>
    typeof host === "string" && allowedHosts(port()).has(host.toLowerCase());

  const server = http.createServer((req, res) => {
    if (!hostOk(req.headers.host)) {
      res.writeHead(403, { "content-type": "text/plain" }).end("forbidden host");
      return;
    }
    const proxyHost = req.headers.host;
    const up = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: req.url,
        method: req.method,
        headers: (() => {
          const h = upstreamHeaders(req.headers, target, proxyHost);
          // Plain bodies, so HTML can be rewritten.
          delete h["accept-encoding"];
          return h;
        })(),
      },
      (upRes) => {
        const out: http.OutgoingHttpHeaders = { ...upRes.headers };
        if (typeof out.location === "string")
          out.location = rewriteLocation(out.location, target, proxyHost);
        const type = String(upRes.headers["content-type"] ?? "");
        if (!type.includes("text/html") || req.method === "HEAD" || !isDocumentRequest(req)) {
          res.writeHead(upRes.statusCode ?? 502, out);
          upRes.pipe(res);
          return;
        }
        delete out["content-length"];
        delete out["content-encoding"];
        delete out["content-security-policy"];
        delete out["content-security-policy-report-only"];
        res.writeHead(upRes.statusCode ?? 200, out);
        injectStream(upRes, res, inject);
      },
    );
    up.on("error", (err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (isDocumentRequest(req)) {
        res
          .writeHead(502, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            [DOWN_HEADER]: "1",
          })
          .end(req.method === "HEAD" ? undefined : opts.downPage(target));
        return;
      }
      res
        .writeHead(502, { "content-type": "text/plain", [DOWN_HEADER]: "1" })
        .end(`Live preview can't reach your dev server at ${target.origin}: ${err.message}`);
    });
    req.pipe(up);
  });

  // Hot-reload websockets (Vite, Next, etc.) pass straight through.
  server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    if (!hostOk(req.headers.host)) {
      socket.destroy();
      return;
    }
    const proxyHost = req.headers.host;
    const up = net.connect(Number(target.port || 80), target.hostname, () => {
      const headers = upstreamHeaders(req.headers, target, proxyHost);
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (const [k, v] of Object.entries(headers)) {
        if (v === undefined) continue;
        for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
      }
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(socket).pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
    socket.on("close", () => up.destroy());
  });

  const sockets = new Set<net.Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  return {
    server,
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
        // Keep-alive and upgraded sockets would hold close() open forever.
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
