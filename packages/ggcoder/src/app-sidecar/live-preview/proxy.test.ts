import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DOWN_HEADER,
  createPreviewProxy,
  defaultDownPage,
  injectionPoint,
  rewriteLocation,
  stripMetaCsp,
  type PreviewProxy,
} from "./proxy.js";

const INJECT = `<script src="http://127.0.0.1:1/page.js"></script>`;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function stub(handler: http.RequestListener): Promise<{ server: http.Server; url: URL }> {
  const server = http.createServer(handler);
  const sockets = new Set<net.Socket>();
  server.on("connection", (s: net.Socket) => sockets.add(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(
    () =>
      new Promise((r) => {
        // Upgraded sockets aren't covered by closeAllConnections().
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  );
  return { server, url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`) };
}

async function proxyTo(target: URL): Promise<{ proxy: PreviewProxy; port: number }> {
  const proxy = createPreviewProxy({
    target,
    inject: INJECT,
    downPage: (t) => defaultDownPage(t, INJECT),
  });
  const port = await proxy.listen(0);
  closers.push(proxy.close);
  return { proxy, port };
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { host: `localhost:${port}`, "sec-fetch-dest": "document", ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("live preview proxy helpers", () => {
  it("finds where the page script goes", () => {
    expect(injectionPoint("<html><head lang=x><title>")).toBe("<html><head lang=x>".length);
    expect(injectionPoint("<html><body>")).toBe("<html>".length);
    expect(injectionPoint("<li>fragment</li>")).toBeNull();
  });

  it("removes meta CSP tags of both kinds", () => {
    const html = `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"><meta http-equiv='content-security-policy-report-only' content="x"><meta charset="utf-8">`;
    expect(stripMetaCsp(html)).toBe(`<head><meta charset="utf-8">`);
  });

  it("points redirects at the dev server back at the proxy", () => {
    const target = new URL("http://localhost:5173/");
    expect(rewriteLocation("http://127.0.0.1:5173/a?b#c", target, "localhost:9000")).toBe(
      "http://localhost:9000/a?b#c",
    );
    expect(rewriteLocation("/login", target, "localhost:9000")).toBe("http://localhost:9000/login");
    expect(rewriteLocation("https://example.com/x", target, "localhost:9000")).toBe(
      "https://example.com/x",
    );
  });
});

describe("live preview proxy", () => {
  it("adds the page script after <head> and strips CSP, even split across chunks", async () => {
    const { url } = await stub((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "script-src 'self'",
      });
      res.write("<!doctype html><html><he");
      setTimeout(() => {
        res.write(`ad><meta http-equiv="Content-Security-Policy" content="x"><title>t</title>`);
        setTimeout(() => res.end("</head><body>hi</body></html>"), 10);
      }, 10);
    });
    const { port } = await proxyTo(url);
    const r = await get(port, "/");
    expect(r.status).toBe(200);
    expect(r.headers["content-security-policy"]).toBeUndefined();
    expect(r.body).toBe(
      `<!doctype html><html><head>${INJECT}<title>t</title></head><body>hi</body></html>`,
    );
  });

  it("streams the body without waiting for the end once the head has passed", async () => {
    let finish!: () => void;
    const { url } = await stub((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html><head></head><body>first");
      finish = () => res.end("</body></html>");
    });
    const { port } = await proxyTo(url);
    const first = await new Promise<string>((resolve) => {
      http.get(
        {
          host: "127.0.0.1",
          port,
          path: "/",
          headers: { host: `localhost:${port}`, "sec-fetch-dest": "document" },
        },
        (res) => res.once("data", (c: Buffer) => resolve(c.toString())),
      );
    });
    expect(first).toContain(INJECT);
    expect(first).toContain("first");
    finish();
  });

  it("leaves assets, fetches and fragments untouched", async () => {
    const { url } = await stub((req, res) => {
      if (req.url === "/app.js") {
        res.writeHead(200, { "content-type": "text/javascript" }).end("console.log(1)");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end("<li>row</li>");
    });
    const { port } = await proxyTo(url);
    expect((await get(port, "/app.js", { "sec-fetch-dest": "script" })).body).toBe(
      "console.log(1)",
    );
    expect((await get(port, "/rows", { "sec-fetch-dest": "empty" })).body).toBe("<li>row</li>");
    expect((await get(port, "/rows")).body).toBe("<li>row</li>");
  });

  it("rewrites redirects and gives the dev server its own Host and Origin", async () => {
    let seen: http.IncomingHttpHeaders = {};
    const { url } = await stub((req, res) => {
      seen = req.headers;
      res.writeHead(302, { location: `${url.origin}/login` }).end();
    });
    const { port } = await proxyTo(url);
    const r = await get(port, "/", { origin: `http://localhost:${port}` });
    expect(r.headers.location).toBe(`http://localhost:${port}/login`);
    expect(seen.host).toBe(url.host);
    expect(seen.origin).toBe(url.origin);
    expect(seen["accept-encoding"]).toBeUndefined();
  });

  it("rejects other Host names (DNS rebinding)", async () => {
    const { url } = await stub((_req, res) => res.end("secret"));
    const { port } = await proxyTo(url);
    const r = await get(port, "/", { host: `evil.example:${port}` });
    expect(r.status).toBe(403);
    expect(r.body).not.toContain("secret");
  });

  it("serves the overlay on a down page while the dev server is off", async () => {
    const { server, url } = await stub(() => {});
    await new Promise<void>((r) => server.close(() => r()));
    const { port } = await proxyTo(url);
    const page = await get(port, "/");
    expect(page.status).toBe(502);
    expect(page.headers[DOWN_HEADER]).toBe("1");
    expect(page.body).toContain(INJECT);
    expect(page.body).toContain("isn't running");
    const asset = await get(port, "/x.js", { "sec-fetch-dest": "script" });
    expect(asset.status).toBe(502);
    expect(asset.body).not.toContain(INJECT);
  });

  it("passes websocket upgrades through with the dev server's Host", async () => {
    const { server, url } = await stub(() => {});
    let upstreamHost = "";
    server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket) => {
      upstreamHost = req.headers.host ?? "";
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      socket.on("data", (d) => socket.write(d));
    });
    const { port } = await proxyTo(url);
    const echoed = await new Promise<string>((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.write(
          `GET /hmr HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
        );
      });
      let buf = "";
      s.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("\r\n\r\n") && !buf.includes("ping")) s.write("ping");
        if (buf.endsWith("ping")) {
          s.destroy();
          resolve(buf);
        }
      });
      s.on("error", reject);
    });
    expect(echoed).toContain("101 Switching Protocols");
    expect(upstreamHost).toBe(url.host);
  });

  it("drops websocket upgrades for other Host names", async () => {
    const { url } = await stub(() => {});
    const { port } = await proxyTo(url);
    const closed = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () =>
        s.write(
          `GET / HTTP/1.1\r\nHost: evil.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
        ),
      );
      s.on("close", () => resolve(true));
      s.on("error", () => resolve(true));
    });
    expect(closed).toBe(true);
  });
});
