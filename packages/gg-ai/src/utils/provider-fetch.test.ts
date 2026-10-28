import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_TRANSPORT_TIMEOUT_MS,
  createProviderFetch,
  nodeUsesEnvProxy,
} from "./provider-fetch.js";

/**
 * Regression for the 2026-10-17 incident: Node's built-in fetch killed every
 * provider request at exactly 300s — without response headers (non-streamed
 * Anthropic fallback → "Request timed out.") or with a silent body (MiMo
 * reasoning streams → "terminated") — underneath the agent loop's 10-15min
 * watchdogs, so long replies failed identically on every retry. Provider
 * transports must run on a fetch whose timeouts we set.
 */

type Server = { url: string; close: () => Promise<void> };

async function serve(handler: http.RequestListener): Promise<Server> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Response headers arrive only after `delayMs` (a non-streamed reply). */
const lateHeaders =
  (delayMs: number): http.RequestListener =>
  (_req, res) => {
    const timer = setTimeout(() => res.end("late"), delayMs);
    res.on("close", () => clearTimeout(timer));
  };

/** Headers and one chunk arrive, then `delayMs` of silence (a quiet stream). */
const silentBody =
  (delayMs: number): http.RequestListener =>
  (_req, res) => {
    res.writeHead(200);
    res.write("a");
    const timer = setTimeout(() => res.end("b"), delayMs);
    res.on("close", () => clearTimeout(timer));
  };

// undici checks transport timeouts on a coarse (~0.5-1s) tick, so the strict
// case uses a 200ms timeout against a 2s delay to fire reliably.
let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await server?.close();
  server = undefined;
});

describe("createProviderFetch", () => {
  it("applies its own header timeout instead of undici's default", async () => {
    server = await serve(lateHeaders(2_000));
    const strict = createProviderFetch(200);
    const err = await strict(server.url).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { cause?: { code?: string } }).cause?.code).toBe("UND_ERR_HEADERS_TIMEOUT");

    const generous = createProviderFetch(5_000);
    const response = await generous(server.url);
    expect(await response.text()).toBe("late");
  });

  it("applies its own body timeout to a silent stream", async () => {
    server = await serve(silentBody(2_000));
    const strict = createProviderFetch(200);
    const failed = await strict(server.url)
      .then((r) => r.text())
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((failed as { cause?: { code?: string } }).cause?.code).toBe("UND_ERR_BODY_TIMEOUT");

    const generous = createProviderFetch(5_000);
    expect(await (await generous(server.url)).text()).toBe("ab");
  });

  it("still honours the caller's abort signal", async () => {
    server = await serve(lateHeaders(5_000));
    const controller = new AbortController();
    const pending = createProviderFetch(60_000)(server.url, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  // undici's package fetch stringifies Node's global FormData to
  // "[object FormData]" — a silent multipart upload breakage (Moonshot video).
  it("sends a global FormData as real multipart", async () => {
    let received = { type: "", bytes: 0 };
    server = await serve((req, res) => {
      let bytes = 0;
      req.on("data", (chunk: Buffer) => (bytes += chunk.length));
      req.on("end", () => {
        received = { type: req.headers["content-type"] ?? "", bytes };
        res.end("ok");
      });
    });
    const form = new FormData();
    form.append("file", new File([new Uint8Array(1_000)], "clip.mp4", { type: "video/mp4" }));
    await createProviderFetch(5_000)(server.url, { method: "POST", body: form });
    expect(received.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(received.bytes).toBeGreaterThan(1_000);
  });

  // The OpenAI SDK probes the fetch it is given before any multipart upload
  // and threw "does not support file uploads" for undici's package Response.
  it("passes the OpenAI SDK's file-upload check and uploads", async () => {
    let received = { url: "", type: "" };
    server = await serve((req, res) => {
      req.resume();
      req.on("end", () => {
        received = { url: req.url ?? "", type: req.headers["content-type"] ?? "" };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "file-1", object: "file", filename: "clip.mp4" }));
      });
    });
    const { default: OpenAI, toFile } = await import("openai");
    const client = new OpenAI({
      apiKey: "test",
      baseURL: `${server.url}v1`,
      fetch: createProviderFetch(5_000),
    });
    const file = await toFile(new Uint8Array(1_000), "clip.mp4", { type: "video/mp4" });
    await client.files.create({ file, purpose: "user_data" });
    expect(received.url).toBe("/v1/files");
    expect(received.type).toMatch(/^multipart\/form-data; boundary=/);
  });

  it("defers to a host-replaced global fetch", async () => {
    const replaced = vi.fn(async () => new Response("from host"));
    const providerFetch = createProviderFetch(1_000);
    vi.stubGlobal("fetch", replaced);
    const response = await providerFetch("http://127.0.0.1:9/never");
    expect(await response.text()).toBe("from host");
    expect(replaced).toHaveBeenCalledOnce();
  });

  // Regression: with NODE_USE_ENV_PROXY=1, Node's fetch used HTTPS_PROXY but
  // this fetch's own dispatcher sent provider requests straight past it.
  it("tunnels through HTTPS_PROXY when the env proxy is on", async () => {
    const tunnels: string[] = [];
    const proxy = http.createServer((_req, res) => res.writeHead(405).end());
    proxy.on("connect", (req, socket) => {
      tunnels.push(req.url ?? "");
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = proxy.address() as AddressInfo;
      vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${port}`);
      vi.stubEnv("NO_PROXY", "");
      const viaProxy = createProviderFetch(5_000, { useEnvProxy: true });
      await expect(viaProxy("https://provider.invalid/v1/messages")).rejects.toThrow();
      expect(tunnels).toEqual(["provider.invalid:443"]);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("uses the env proxy exactly when Node does", () => {
    const uses = (env: NodeJS.ProcessEnv, nodeVersion = "26.0.0", execArgv: string[] = []) =>
      nodeUsesEnvProxy({ env, nodeVersion, execArgv });
    const on = { NODE_USE_ENV_PROXY: "1" };
    expect(uses(on)).toBe(true);
    expect(uses(on, "24.0.0")).toBe(true);
    expect(uses(on, "22.21.0")).toBe(true);
    // Older Node ignores the variable — including the app's bundled 22.12.
    expect(uses(on, "22.12.0")).toBe(false);
    expect(uses(on, "23.11.0")).toBe(false);
    expect(uses({ NODE_OPTIONS: "--trace-warnings --use-env-proxy" })).toBe(true);
    expect(uses({}, "26.0.0", ["--use-env-proxy"])).toBe(true);
    // Node only accepts "1"; a proxy variable alone turns nothing on.
    expect(uses({ NODE_USE_ENV_PROXY: "true" })).toBe(false);
    expect(uses({ HTTPS_PROXY: "http://proxy:8080" })).toBe(false);
  });

  it("outlasts the agent loop's longest watchdog (15min thinking hard cap)", () => {
    expect(PROVIDER_TRANSPORT_TIMEOUT_MS).toBeGreaterThan(30 * 60_000);
  });
});

describe("withBodyActivity", () => {
  it("reports every SSE body chunk (pings included) and passes bytes through", async () => {
    const { withBodyActivity } = await import("./provider-fetch.js");
    const sse = 'event: ping\ndata: {"type":"ping"}\n\n';
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode(sse));
        c.enqueue(enc.encode(sse));
        c.close();
      },
    });
    const fake = (async () =>
      new Response(body, { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    let hits = 0;
    const res = await withBodyActivity(fake, () => hits++)("https://x.test");
    expect(await res.text()).toBe(sse + sse);
    expect(hits).toBe(2);
  });

  it("leaves non-SSE responses untouched", async () => {
    const { withBodyActivity } = await import("./provider-fetch.js");
    const original = new Response("{}", { headers: { "content-type": "application/json" } });
    let hits = 0;
    const res = await withBodyActivity(
      (async () => original) as typeof fetch,
      () => hits++,
    )("https://x.test");
    expect(res).toBe(original);
    expect(hits).toBe(0);
  });
});
