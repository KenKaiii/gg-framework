import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppSidecarSessionRouter,
  sessionEventSseData,
  type SessionEventFrame,
} from "./app-sidecar-session-router.js";
import { BASH_DIAGNOSTICS_FIXTURE } from "./test-fixtures/bash-diagnostics.js";
import type { BackgroundTaskSnapshot } from "./core/process-manager.js";
import type { TaskOutputDetails } from "./tools/task-output.js";
import type { BashDiagnostics } from "./types.js";

interface FakeContext {
  transcript: string[];
  running: boolean;
  cancelled: boolean;
  clients: Set<http.ServerResponse>;
  dispose: () => Promise<void>;
}

const openServers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function createFakeContext(): FakeContext {
  const clients = new Set<http.ServerResponse>();
  return {
    transcript: [],
    running: false,
    cancelled: false,
    clients,
    async dispose() {
      for (const client of clients) client.end();
      clients.clear();
    },
  };
}

async function body(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function startHarness() {
  const router = new AppSidecarSessionRouter<FakeContext>();
  router.add("session-a", createFakeContext());
  router.add("session-b", createFakeContext());

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const pathname = new URL(url, "http://127.0.0.1").pathname;
    const method = req.method ?? "GET";
    if (method === "DELETE" && pathname.startsWith("/session/")) {
      const id = decodeURIComponent(pathname.slice("/session/".length));
      void router.deleteAndDispose(id).then((deleted) => json(res, 200, { deleted }));
      return;
    }

    const isEventStream = method === "GET" && (url === "/events" || url.startsWith("/events?"));
    const sessionId = router.sessionIdFromRequest(req, url, { allowQuery: isEventStream });
    const context = sessionId ? router.get(sessionId) : undefined;
    if (!sessionId || !context) {
      json(res, 404, { error: "unknown session" });
      return;
    }

    if (isEventStream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.flushHeaders();
      res.write(": connected\n\n");
      context.clients.add(res);
      req.on("close", () => context.clients.delete(res));
      return;
    }
    if (method === "POST" && pathname === "/prompt") {
      void body(req).then((text) => {
        context.transcript.push(text);
        context.running = true;
        for (const client of context.clients) {
          client.write(sessionEventSseData(sessionId, "prompt", { text }));
        }
        json(res, 200, { ok: true });
      });
      return;
    }
    if (method === "POST" && pathname === "/cancel") {
      context.cancelled = true;
      context.running = false;
      for (const client of context.clients) {
        client.write(sessionEventSseData(sessionId, "cancelled", {}));
      }
      json(res, 200, { cancelled: true });
      return;
    }
    if (method === "GET" && pathname === "/state") {
      json(res, 200, { running: context.running, cancelled: context.cancelled });
      return;
    }
    if (method === "GET" && pathname === "/history") {
      json(res, 200, { transcript: context.transcript });
      return;
    }
    json(res, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { router, baseUrl: `http://127.0.0.1:${port}` };
}

async function openSse(url: string) {
  const abort = new AbortController();
  const response = await fetch(url, { signal: abort.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async next(): Promise<SessionEventFrame> {
      while (true) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary >= 0) {
          const block = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const data = block
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (data) return JSON.parse(data) as SessionEventFrame;
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE stream ended before an event arrived");
        buffered += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
      }
    },
    async close(): Promise<void> {
      await reader.cancel().catch(() => undefined);
      abort.abort();
      reader.releaseLock();
    },
  };
}

async function nextSseWithTimeout(
  events: Awaited<ReturnType<typeof openSse>>,
  timeoutMs = 250,
): Promise<{ kind: "event"; frame: SessionEventFrame } | { kind: "timeout" }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      events.next().then((frame) => ({ kind: "event" as const, frame })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function request(
  baseUrl: string,
  path: string,
  sessionId?: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, ...(sessionId ? { "x-gg-session": sessionId } : {}) },
  });
}

describe("session event shape", () => {
  it("serializes the complete native background-task snapshot", () => {
    const task = {
      id: "bg-signal",
      pid: 4242,
      command: "pnpm watch",
      logFile: "/tmp/bg-signal.log",
      startedAt: 1,
      completedAt: 2,
      exitCode: null,
      signal: "SIGTERM",
      lastReadOffset: 0,
      logSize: 0,
      isRunning: false,
    } satisfies BackgroundTaskSnapshot;
    const serialized = sessionEventSseData("session-a", "tasks", { tasks: [task] });
    const frame = JSON.parse(serialized.slice("data: ".length)) as SessionEventFrame;

    expect(frame).toEqual({
      sessionId: "session-a",
      type: "tasks",
      data: { tasks: [task] },
    });
  });

  it("serializes complete task_output metadata in tool_call_end details", () => {
    const taskOutput = {
      isRunning: false,
      exitCode: null,
      signal: "SIGTERM",
      completedAt: Date.UTC(2026, 6, 24, 12, 34, 56),
      startOffset: 262_144,
      endOffset: 524_288,
      skippedBytes: 262_144,
      remainingBytes: 128,
      logFile: "/tmp/bg-task.log",
      presentationCapped: true,
    } satisfies TaskOutputDetails;
    const serialized = sessionEventSseData("session-a", "tool_call_end", {
      toolCallId: "task-output-1",
      result: "Process bg-task: exited (signal SIGTERM)",
      details: { taskOutput },
      isError: false,
      durationMs: 12,
    });
    const frame = JSON.parse(serialized.slice("data: ".length)) as SessionEventFrame;

    expect(frame).toEqual({
      sessionId: "session-a",
      type: "tool_call_end",
      data: expect.objectContaining({
        toolCallId: "task-output-1",
        details: { taskOutput },
      }),
    });
  });

  it("serializes complete bash diagnostics in tool_call_end details", () => {
    const diagnostics = BASH_DIAGNOSTICS_FIXTURE satisfies BashDiagnostics;
    const serialized = sessionEventSseData("session-a", "tool_call_end", {
      toolCallId: "bash-1",
      result: "Exit code: TIMEOUT (1000ms)",
      details: { bashDiagnostics: diagnostics },
      isError: false,
      durationMs: 2_005,
    });
    const frame = JSON.parse(serialized.slice("data: ".length)) as SessionEventFrame;

    expect(frame).toEqual({
      sessionId: "session-a",
      type: "tool_call_end",
      data: expect.objectContaining({
        toolCallId: "bash-1",
        details: { bashDiagnostics: diagnostics },
      }),
    });
  });
});

describe("AppSidecarSessionRouter HTTP isolation", () => {
  it("keeps prompt, ordered events, cancel, state, history, and disposal isolated", async () => {
    const { baseUrl } = await startHarness();
    const eventStreams: Awaited<ReturnType<typeof openSse>>[] = [];

    try {
      const eventsA = await openSse(`${baseUrl}/events?session=session-a`);
      eventStreams.push(eventsA);
      const eventsB = await openSse(`${baseUrl}/events?session=session-b`);
      eventStreams.push(eventsB);

      await request(baseUrl, "/prompt", "session-a", { method: "POST", body: "alpha" });
      await request(baseUrl, "/prompt", "session-b", { method: "POST", body: "bravo" });
      await request(baseUrl, "/prompt", "session-a", { method: "POST", body: "again" });

      await expect(eventsA.next()).resolves.toMatchObject({
        sessionId: "session-a",
        type: "prompt",
        data: { text: "alpha" },
      });
      await expect(eventsB.next()).resolves.toMatchObject({
        sessionId: "session-b",
        type: "prompt",
        data: { text: "bravo" },
      });
      await expect(eventsA.next()).resolves.toMatchObject({ data: { text: "again" } });

      await request(baseUrl, "/cancel", "session-a", { method: "POST" });
      await expect(eventsA.next()).resolves.toMatchObject({
        sessionId: "session-a",
        type: "cancelled",
      });
      await expect(nextSseWithTimeout(eventsB)).resolves.toEqual({ kind: "timeout" });

      await expect((await request(baseUrl, "/state", "session-a")).json()).resolves.toEqual({
        running: false,
        cancelled: true,
      });
      await expect((await request(baseUrl, "/state", "session-b")).json()).resolves.toEqual({
        running: true,
        cancelled: false,
      });
      await expect((await request(baseUrl, "/history", "session-a")).json()).resolves.toEqual({
        transcript: ["alpha", "again"],
      });
      await expect((await request(baseUrl, "/history", "session-b")).json()).resolves.toEqual({
        transcript: ["bravo"],
      });

      expect((await request(baseUrl, "/state")).status).toBe(404);
      expect((await request(baseUrl, "/state", "missing")).status).toBe(404);
      expect((await fetch(`${baseUrl}/state?session=session-a`)).status).toBe(404);
      expect(
        (
          await fetch(`${baseUrl}/state?session=session-b`, {
            headers: { "x-gg-session": "  session-a  " },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${baseUrl}/events?session=session-a`, {
            headers: { "x-gg-session": "   " },
          })
        ).status,
      ).toBe(200);
      expect((await fetch(`${baseUrl}/session/session-a`, { method: "DELETE" })).status).toBe(200);
      expect((await request(baseUrl, "/state", "session-a")).status).toBe(404);
      expect((await request(baseUrl, "/state", "session-b")).status).toBe(200);
    } finally {
      await Promise.all(eventStreams.map((events) => events.close()));
    }
  });

  it("removes sessions before disposal and attempts every shutdown disposal", async () => {
    const router = new AppSidecarSessionRouter<FakeContext>();
    const first = createFakeContext();
    const second = createFakeContext();
    first.dispose = vi.fn(async () => {
      expect(router.get("first")).toBeUndefined();
      throw new Error("dispose failed");
    });
    second.dispose = vi.fn(async () => {
      expect(router.get("second")).toBeUndefined();
    });
    router.add("first", first);
    router.add("second", second);

    await expect(router.disposeAll()).resolves.toBeUndefined();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
    expect([...router.values()]).toEqual([]);
  });
});
