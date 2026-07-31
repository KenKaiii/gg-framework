import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppSidecarSessionMutationCoordinator,
  appSidecarSessionBusyConflictBody,
  isAppSidecarSessionBusy,
  type SessionMutationKind,
} from "./app-sidecar-session-mutation.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface Harness {
  baseUrl: string;
  started: ReturnType<typeof deferred>;
  continueReset: ReturnType<typeof deferred>;
  sessionDir: string;
  resetEvents: Array<{ operationId: string; kind: SessionMutationKind }>;
  startupEvents: Array<{ operationId: string; kind: SessionMutationKind }>;
  setAutopilotActive(active: boolean): void;
  mutationAcquisitions(): number;
  newSessionCalls(): number;
  maxConcurrentResets(): number;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

async function startHarness(): Promise<Harness> {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-session-mutation-"));
  let sequence = 0;
  const mutations = new AppSidecarSessionMutationCoordinator(() => `operation-${++sequence}`);
  const started = deferred();
  const continueReset = deferred();
  const resetEvents: Harness["resetEvents"] = [];
  const startupEvents: Harness["startupEvents"] = [];
  let autopilotActive = false;
  let mutationAcquisitions = 0;
  let newSessionCalls = 0;
  let activeResets = 0;
  let maxConcurrentResets = 0;

  const kindForPath = (pathname: string): SessionMutationKind | null => {
    if (pathname === "/new-session") return "new-session";
    if (pathname === "/tasks/run") return "task-run";
    if (pathname === "/plan/accept") return "manual-plan-accept";
    return null;
  };

  const server = http.createServer((req, res) => {
    const kind = req.method === "POST" ? kindForPath(req.url ?? "") : null;
    if (!kind) {
      res.writeHead(404).end();
      return;
    }

    if (kind === "new-session") {
      const busyState = { running: false, autopilotActive, runLifecycleRunning: false };
      if (isAppSidecarSessionBusy(busyState)) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify(appSidecarSessionBusyConflictBody(busyState)));
        return;
      }
    }

    const mutation = mutations.tryAcquire(kind);
    if (!mutation) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify(mutations.conflictBody()));
      return;
    }
    mutationAcquisitions += 1;
    if (kind === "new-session") newSessionCalls += 1;

    started.resolve();
    void (async () => {
      try {
        await continueReset.promise;
        activeResets += 1;
        maxConcurrentResets = Math.max(maxConcurrentResets, activeResets);
        const file = path.join(sessionDir, `${mutation.operationId}.jsonl`);
        await fs.writeFile(
          file,
          JSON.stringify({ operationId: mutation.operationId, kind }) + "\n",
        );
        resetEvents.push({ operationId: mutation.operationId, kind });
        if (kind !== "new-session") startupEvents.push({ operationId: mutation.operationId, kind });
        res.writeHead(kind === "task-run" ? 202 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, operationId: mutation.operationId }));
      } finally {
        activeResets -= 1;
        mutation.release();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const harness: Harness = {
    baseUrl: `http://127.0.0.1:${port}`,
    started,
    continueReset,
    sessionDir,
    resetEvents,
    startupEvents,
    setAutopilotActive: (active) => {
      autopilotActive = active;
    },
    mutationAcquisitions: () => mutationAcquisitions,
    newSessionCalls: () => newSessionCalls,
    maxConcurrentResets: () => maxConcurrentResets,
    async close() {
      continueReset.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(sessionDir, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);
  return harness;
}

async function overlapNewSessionWith(competingPath: "/tasks/run" | "/plan/accept"): Promise<void> {
  const harness = await startHarness();
  const newSession = fetch(`${harness.baseUrl}/new-session`, { method: "POST" });
  await harness.started.promise;

  const loser = await fetch(`${harness.baseUrl}${competingPath}`, { method: "POST" });
  expect(loser.status).toBe(409);
  await expect(loser.json()).resolves.toEqual({
    error: "session_mutation_in_progress",
    owner: { operationId: "operation-1", kind: "new-session" },
  });
  expect(await fs.readdir(harness.sessionDir)).toEqual([]);

  harness.continueReset.resolve();
  expect((await newSession).status).toBe(200);
  expect(await fs.readdir(harness.sessionDir)).toEqual(["operation-1.jsonl"]);
  expect(harness.resetEvents).toEqual([{ operationId: "operation-1", kind: "new-session" }]);
  expect(harness.startupEvents).toEqual([]);
  expect(harness.maxConcurrentResets()).toBe(1);

  const retry = await fetch(`${harness.baseUrl}${competingPath}`, { method: "POST" });
  expect(retry.status).toBe(competingPath === "/tasks/run" ? 202 : 200);
  expect((await fs.readdir(harness.sessionDir)).sort()).toEqual([
    "operation-1.jsonl",
    "operation-2.jsonl",
  ]);
  expect(harness.resetEvents.map((event) => event.operationId)).toEqual([
    "operation-1",
    "operation-2",
  ]);
  expect(harness.startupEvents).toEqual([
    {
      operationId: "operation-2",
      kind: competingPath === "/tasks/run" ? "task-run" : "manual-plan-accept",
    },
  ]);
  expect(harness.maxConcurrentResets()).toBe(1);
}

describe("app-sidecar session mutation routes", () => {
  it("phase-start conflicts with every reset producer until its lease releases", () => {
    let sequence = 0;
    const coordinator = new AppSidecarSessionMutationCoordinator(() => `phase-${++sequence}`);
    const phaseStart = coordinator.tryAcquire("phase-start");
    expect(phaseStart).toMatchObject({ operationId: "phase-1", kind: "phase-start" });
    for (const kind of [
      "new-session",
      "task-run",
      "prompt-start",
      "manual-plan-accept",
      "autopilot-plan-accept",
    ] as const) {
      expect(coordinator.tryAcquire(kind)).toBeNull();
      expect(coordinator.conflictBody()).toEqual({
        error: "session_mutation_in_progress",
        owner: { operationId: "phase-1", kind: "phase-start" },
      });
    }
    phaseStart?.release();
    expect(coordinator.tryAcquire("autopilot-plan-accept")).toMatchObject({
      operationId: "phase-2",
      kind: "autopilot-plan-accept",
    });
  });

  it("phase-start loses without acquiring when another reset producer owns the session", () => {
    const kinds: SessionMutationKind[] = [
      "new-session",
      "task-run",
      "prompt-start",
      "manual-plan-accept",
      "autopilot-plan-accept",
    ];
    for (const kind of kinds) {
      const coordinator = new AppSidecarSessionMutationCoordinator(() => kind);
      const owner = coordinator.tryAcquire(kind);
      expect(coordinator.tryAcquire("phase-start")).toBeNull();
      owner?.release();
    }
  });

  it("rejects /new-session before reset or lease acquisition while Autopilot is active", async () => {
    const harness = await startHarness();
    harness.setAutopilotActive(true);

    const blocked = await fetch(`${harness.baseUrl}/new-session`, { method: "POST" });

    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toEqual({
      error: "session_busy",
      message: "Cannot start a new session while the current session is active.",
      state: { running: false, autopilotActive: true, runLifecycleRunning: false },
    });
    expect(harness.mutationAcquisitions()).toBe(0);
    expect(harness.newSessionCalls()).toBe(0);
    expect(harness.resetEvents).toEqual([]);

    harness.setAutopilotActive(false);
    const retry = fetch(`${harness.baseUrl}/new-session`, { method: "POST" });
    await harness.started.promise;
    expect(harness.mutationAcquisitions()).toBe(1);
    expect(harness.newSessionCalls()).toBe(1);
    harness.continueReset.resolve();
    await expect(retry.then((response) => response.json())).resolves.toEqual({
      ok: true,
      operationId: "operation-1",
    });
    expect(harness.resetEvents).toEqual([{ operationId: "operation-1", kind: "new-session" }]);
  });

  it("rejects /tasks/run while /new-session owns the logical session", async () => {
    await overlapNewSessionWith("/tasks/run");
  });

  it("rejects /plan/accept while /new-session owns the logical session", async () => {
    await overlapNewSessionWith("/plan/accept");
  });
});
