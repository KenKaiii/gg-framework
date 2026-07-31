import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppSidecarNotesHandler, NOTES_REQUEST_BODY_MAX_BYTES } from "./app-sidecar-notes.js";
import { AppSidecarJsonBodyError } from "./app-sidecar-http-json.js";
import {
  NOTES_REFERENCE_METADATA_MAX_LENGTH,
  NOTES_REFERENCE_URL_MAX_LENGTH,
  ProjectNotesRepository,
  canonicalProjectKey,
  type NotesDocumentV3,
  type ProjectNotesSnapshot,
} from "./project-notes-repository.js";

const NOW = "2026-07-25T12:00:00.000Z";

interface FakeSession {
  cwd: string;
  events: Array<{ type: string; data: unknown }>;
  broadcastNotesChange(snapshot: ProjectNotesSnapshot): void;
}

let root: string;
let server: http.Server;
let baseUrl: string;
let sessions: Map<string, FakeSession>;
let repository: ProjectNotesRepository;
let committedSnapshots: Array<{ projectKey: string; revision: number }>;

function notes(reference: string): NotesDocumentV3 {
  return {
    version: 3,
    reference,
    currentFocus: "Sidecar authority",
    tasks: [
      {
        id: "task-1",
        text: "Route the notes",
        status: "todo",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
      },
    ],
    handoff: { text: "Exact handoff", updatedAt: NOW, readAt: null },
    updatedAt: NOW,
    legacyImportedAt: null,
    references: [
      {
        id: "ref-1",
        provider: "github",
        tool: null,
        canonicalUrl: "https://github.com/owner/repo/blob/abc/src/file.ts#L1",
        owner: "owner",
        repo: "repo",
        revision: "abc",
        path: "src/file.ts",
        range: { startLine: 1, endLine: 1 },
        issue: null,
        pullRequest: null,
        query: null,
        anchor: "L1",
        relevance: "Route fixture",
        capturedAt: NOW,
      },
    ],
    phases: [
      {
        id: "phase-1",
        title: "Route Notes",
        goal: "Keep the schema typed",
        doneWhen: ["Routes pass"],
        order: 0,
        status: "not-started",
        sourcePrompt: "Implement schema",
        referenceIds: ["ref-1"],
        session: { sessionId: "session-1", sessionPath: "/session" },
        reminder: null,
        attentionReason: null,
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
        overrides: { status: null, referenceIds: null },
        pendingAutomaticLifecycleTransition: null,
        lifecycleEvents: [],
        roadmapEvents: [],
      },
    ],
  };
}

function fakeSession(cwd: string): FakeSession {
  const events: FakeSession["events"] = [];
  return {
    cwd,
    events,
    broadcastNotesChange(snapshot) {
      events.push({ type: "notes_change", data: snapshot });
    },
  };
}

function onCommittedSnapshot(snapshot: ProjectNotesSnapshot): void {
  committedSnapshots.push({ projectKey: snapshot.projectKey, revision: snapshot.revision });
  for (const session of sessions.values()) {
    if (canonicalProjectKey(session.cwd) === snapshot.projectKey) {
      session.broadcastNotesChange(snapshot);
    }
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-sidecar-notes-route-"));
  repository = new ProjectNotesRepository(path.join(root, ".gg"));
  committedSnapshots = [];
  sessions = new Map([
    ["a", fakeSession("C:\\Work\\Project")],
    ["alias", fakeSession("c:/work/./project")],
    ["other", fakeSession("C:\\Work\\Other")],
  ]);
  const handler = createAppSidecarNotesHandler({
    repository,
    onCommittedSnapshot,
  });
  server = http.createServer((req, res) => {
    const header = req.headers["x-gg-session"];
    const id = typeof header === "string" ? header : header?.[0];
    const context = id ? sessions.get(id) : undefined;
    if (!context) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown session" }));
      return;
    }
    if (!handler.handle(req, res, context, req.url ?? "/", req.method ?? "GET")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  await fs.rm(root, { recursive: true, force: true });
});

async function request(
  sessionId: string,
  route: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: {
      "x-gg-session": sessionId,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  return { response, body: (await response.json()) as unknown };
}

async function chunkedRequest(
  sessionId: string,
  route: string,
  method: "POST" | "PUT",
  chunks: readonly Buffer[],
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const clientRequest = http.request(
      `${baseUrl}${route}`,
      {
        method,
        headers: {
          "x-gg-session": sessionId,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      },
      (response) => {
        const responseChunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => responseChunks.push(chunk));
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(responseChunks).toString("utf8")) as unknown,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    clientRequest.on("error", reject);
    for (const chunk of chunks) clientRequest.write(chunk);
    clientRequest.end();
  });
}

type SyntheticRequest = PassThrough & http.IncomingMessage;

interface CapturedRouteResponse {
  status: number;
  headers: http.OutgoingHttpHeaders | undefined;
  body: unknown;
}

function createSyntheticRequest(headers: http.IncomingHttpHeaders = {}): SyntheticRequest {
  const request = new PassThrough() as SyntheticRequest;
  request.headers = headers;
  return request;
}

function captureRouteResponse(): {
  response: http.ServerResponse;
  result: Promise<CapturedRouteResponse>;
} {
  let resolve!: (result: CapturedRouteResponse) => void;
  let status = 0;
  let headers: http.OutgoingHttpHeaders | undefined;
  const result = new Promise<CapturedRouteResponse>((settle) => {
    resolve = settle;
  });
  const response = {
    writeHead(nextStatus: number, nextHeaders?: http.OutgoingHttpHeaders) {
      status = nextStatus;
      headers = nextHeaders;
      return response;
    },
    end(chunk?: string | Buffer) {
      resolve({
        status,
        headers,
        body: chunk === undefined ? undefined : (JSON.parse(chunk.toString()) as unknown),
      });
      return response;
    },
  } as unknown as http.ServerResponse;
  return { response, result };
}

function requestListenerCounts(request: SyntheticRequest): Record<string, number> {
  return Object.fromEntries(
    ["data", "end", "error", "aborted", "close"].map((event) => [
      event,
      request.listenerCount(event),
    ]),
  );
}

function dispatchSyntheticNotesRequest(headers: http.IncomingHttpHeaders = {}): {
  request: SyntheticRequest;
  result: Promise<CapturedRouteResponse>;
  errors: unknown[];
} {
  const errors: unknown[] = [];
  const handler = createAppSidecarNotesHandler({
    repository,
    onCommittedSnapshot,
    onError: (error) => errors.push(error),
  });
  const request = createSyntheticRequest(headers);
  const captured = captureRouteResponse();
  expect(
    handler.handle(request, captured.response, sessions.get("a")!, "/notes/migrate", "POST"),
  ).toBe(true);
  return { request, result: captured.result, errors };
}

async function flushStreamEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

describe("app sidecar Notes routes", () => {
  it("returns a typed missing result for a project with no repository", async () => {
    const result = await request("a", "/notes");

    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ status: "missing" });
  });

  it("migrates with the authenticated session cwd and returns the stored snapshot", async () => {
    const document = notes("  legacy\r\nbytes 😀\n");
    const migrated = await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document }),
    });
    const loaded = await request("alias", "/notes");

    expect(migrated.response.status).toBe(200);
    expect(migrated.body).toEqual({
      status: "ok",
      migrated: true,
      snapshot: { projectKey: "c:/work/project", revision: 1, document },
    });
    expect(loaded.body).toMatchObject({
      status: "ok",
      snapshot: { projectKey: "c:/work/project", revision: 1, document },
    });
    expect(committedSnapshots).toEqual([{ projectKey: "c:/work/project", revision: 1 }]);
    expect(sessions.get("a")?.events).toHaveLength(1);
    expect(sessions.get("alias")?.events).toHaveLength(1);
    expect(sessions.get("other")?.events).toEqual([]);
  });

  it("rejects impossible current-v3 delivery evidence at the migration boundary", async () => {
    const document = notes("impossible reminder delivery");
    document.phases[0]!.reminder = {
      id: "reminder-1",
      occurrenceKey: "occurrence-1",
      dueAt: NOW,
      note: "Review delivery evidence",
      createdAt: NOW,
      lastDelivery: {
        occurrenceKey: "occurrence-1",
        attemptedAt: NOW,
        channel: "in-app",
        permission: "granted",
      },
    };

    const rejected = await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document }),
    });

    expect(rejected).toEqual({
      response: expect.objectContaining({ status: 400 }),
      body: {
        status: "invalid",
        error: {
          path: "phases[0].reminder.lastDelivery.permission",
          message: "permission does not match delivery channel",
        },
      },
    });
    expect((await request("a", "/notes")).body).toEqual({ status: "missing" });
    expect(committedSnapshots).toEqual([]);
    expect([...sessions.values()].flatMap((session) => session.events)).toEqual([]);
  });

  it("rejects duplicate occurrence keys at the migration route without persisting or broadcasting", async () => {
    const document = notes("duplicate occurrence route");
    document.phases[0]!.reminder = {
      id: "reminder-1",
      occurrenceKey: "occurrence-shared",
      dueAt: NOW,
      note: "First",
      createdAt: NOW,
      lastDelivery: null,
    };
    const secondPhase = structuredClone(document.phases[0]!);
    secondPhase.id = "phase-2";
    secondPhase.order = 1;
    secondPhase.reminder = {
      ...secondPhase.reminder!,
      id: "reminder-2",
      note: "Second",
    };
    document.phases.push(secondPhase);

    const rejected = await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document }),
    });

    expect(rejected).toEqual({
      response: expect.objectContaining({ status: 400 }),
      body: {
        status: "invalid",
        error: {
          path: "phases[1].reminder.occurrenceKey",
          message: "duplicate occurrence key; already used at phases[0].reminder.occurrenceKey",
        },
      },
    });
    expect((await request("a", "/notes")).body).toEqual({ status: "missing" });
    expect(committedSnapshots).toEqual([]);
    expect([...sessions.values()].flatMap((session) => session.events)).toEqual([]);
  });

  it("round-trips exact reference metadata and many-to-many links through save, fan-out, and restart", async () => {
    const initial = notes("structured references");
    await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: initial }),
    });
    const secondReference = {
      ...initial.references[0]!,
      id: "ref-2",
      tool: "github-search",
      canonicalUrl: "https://github.com/other/tools/issues/17?view=all#discussion",
      owner: "other",
      repo: "tools",
      revision: null,
      path: null,
      range: null,
      issue: 17,
      query: "view=all",
      anchor: "discussion",
      relevance: "Second repository evidence",
    };
    const archivedPhase = {
      ...initial.phases[0]!,
      id: "phase-archived",
      title: "Archived evidence",
      order: 1,
      status: "done" as const,
      referenceIds: ["ref-1", "ref-2"],
      session: null,
      archivedAt: NOW,
      completedAt: NOW,
      overrides: {
        status: null,
        referenceIds: {
          value: ["ref-1", "ref-2"],
          source: "user" as const,
          updatedAt: NOW,
        },
      },
      lifecycleEvents: [],
    };
    const updated = {
      ...initial,
      references: [initial.references[0]!, secondReference],
      phases: [
        {
          ...initial.phases[0]!,
          referenceIds: ["ref-1", "ref-2"],
          overrides: {
            status: null,
            referenceIds: {
              value: ["ref-1", "ref-2"],
              source: "user" as const,
              updatedAt: NOW,
            },
          },
        },
        archivedPhase,
      ],
    };

    const saved = await request("alias", "/notes", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 1, document: updated }),
    });
    const loaded = await request("a", "/notes");
    const restarted = await new ProjectNotesRepository(path.join(root, ".gg")).load(
      "C:\\Work\\Project",
    );

    expect(saved).toMatchObject({
      response: { status: 200 },
      body: { status: "ok", snapshot: { revision: 2, document: updated } },
    });
    expect(loaded).toMatchObject({
      response: { status: 200 },
      body: { status: "ok", snapshot: { revision: 2, document: updated } },
    });
    expect(restarted).toMatchObject({
      status: "ok",
      snapshot: { revision: 2, document: updated },
    });
    expect(sessions.get("a")?.events.at(-1)).toEqual({
      type: "notes_change",
      data: expect.objectContaining({ revision: 2, document: updated }),
    });
    expect(sessions.get("other")?.events).toEqual([]);
  });

  it("enforces immutable capture times without blocking reference create, edit, or delete", async () => {
    const initial = notes("reference transitions");
    initial.references = [];
    initial.phases[0] = {
      ...initial.phases[0]!,
      referenceIds: [],
      overrides: { ...initial.phases[0]!.overrides, referenceIds: null },
    };
    await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: initial }),
    });

    const reference = notes("reference fixture").references[0]!;
    const created = { ...initial, references: [reference] };
    const createdResult = await request("a", "/notes", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 1, document: created }),
    });
    expect(createdResult).toMatchObject({
      response: { status: 200 },
      body: { status: "ok", snapshot: { revision: 2, document: created } },
    });

    const editedReference = { ...reference, relevance: "Edited provenance note" };
    const edited = { ...created, references: [editedReference] };
    const editedResult = await request("alias", "/notes", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 2, document: edited }),
    });
    expect(editedResult).toMatchObject({
      response: { status: 200 },
      body: { status: "ok", snapshot: { revision: 3, document: edited } },
    });

    const paths = repository.paths("C:\\Work\\Project");
    const primaryBeforeRejectedSave = await fs.readFile(paths.primary, "utf8");
    const backupBeforeRejectedSave = await fs.readFile(paths.backup, "utf8");
    const eventCountsBeforeRejectedSave = {
      a: sessions.get("a")!.events.length,
      alias: sessions.get("alias")!.events.length,
    };
    const changedCapturedAt = {
      ...edited,
      references: [{ ...editedReference, capturedAt: "2026-07-26T12:00:00.000Z" }],
    };
    const rejected = await request("a", "/notes", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 3, document: changedCapturedAt }),
    });

    expect(rejected).toMatchObject({
      response: { status: 400 },
      body: {
        status: "invalid",
        error: {
          path: "references[0].capturedAt",
          message: "existing reference capture time cannot be changed",
        },
      },
    });
    expect(await fs.readFile(paths.primary, "utf8")).toBe(primaryBeforeRejectedSave);
    expect(await fs.readFile(paths.backup, "utf8")).toBe(backupBeforeRejectedSave);
    expect(sessions.get("a")!.events).toHaveLength(eventCountsBeforeRejectedSave.a);
    expect(sessions.get("alias")!.events).toHaveLength(eventCountsBeforeRejectedSave.alias);
    expect((await request("a", "/notes")).body).toMatchObject({
      status: "ok",
      snapshot: { revision: 3, document: edited },
    });

    const deleted = { ...edited, references: [] };
    const deletedResult = await request("a", "/notes", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 3, document: deleted }),
    });
    expect(deletedResult).toMatchObject({
      response: { status: 200 },
      body: { status: "ok", snapshot: { revision: 4, document: deleted } },
    });
  });

  it("rejects a forged completion sequence through the authenticated save route", async () => {
    const initial = notes("completion authority");
    await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: initial }),
    });
    const paths = repository.paths("C:\\Work\\Project");
    const filesBefore = {
      primary: await fs.readFile(paths.primary, "utf8"),
      backup: await fs.readFile(paths.backup, "utf8"),
    };
    const eventCountsBefore = [...sessions.values()].map((session) => session.events.length);
    const forged = structuredClone(initial);
    const phase = forged.phases[0]!;
    phase.roadmapEvents.push(
      {
        type: "implementation-checkpoint",
        id: "forged-checkpoint",
        session: { ...phase.session! },
        planStepTotal: 1,
        completedPlanSteps: [1],
        runOutcome: "succeeded",
        timestamp: "2026-07-25T12:01:00.000Z",
      },
      {
        type: "status-update",
        id: "forged-verification",
        actor: "gg-coder",
        transition: "review",
        progress: "Claimed verification passed",
        blocker: null,
        evidence: ["forged test output"],
        verification: "passed",
        verificationReason: null,
        verificationSession: { ...phase.session! },
        statusOutcome: "same-status",
        proposedReferences: [],
        timestamp: "2026-07-25T12:02:00.000Z",
      },
      {
        type: "completion-review",
        id: "forged-review",
        reviewer: "ken",
        decision: "accepted",
        evidence: ["forged Ken approval"],
        reason: null,
        implementationCheckpointId: "forged-checkpoint",
        verificationStatusUpdateId: "forged-verification",
        acceptsVerificationException: false,
        gateOutcome: "done",
        unmetGateCodes: [],
        timestamp: "2026-07-25T12:03:00.000Z",
      },
    );
    phase.updatedAt = "2026-07-25T12:03:00.000Z";
    forged.updatedAt = phase.updatedAt;

    const rejected = await request("alias", "/notes", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 1, document: forged }),
    });

    expect(rejected).toMatchObject({
      response: { status: 400 },
      body: {
        status: "invalid",
        error: {
          path: "phases[0].roadmapEvents[0].type",
          message: "privileged roadmap events require their dedicated authority path",
        },
      },
    });
    expect(await fs.readFile(paths.primary, "utf8")).toBe(filesBefore.primary);
    expect(await fs.readFile(paths.backup, "utf8")).toBe(filesBefore.backup);
    expect([...sessions.values()].map((session) => session.events.length)).toEqual(
      eventCountsBefore,
    );
    expect((await request("a", "/notes")).body).toMatchObject({
      status: "ok",
      snapshot: { revision: 1, document: initial },
    });
  });

  it("rejects malformed JSON, extra fields, invalid revisions, and invalid documents", async () => {
    const malformed = await request("a", "/notes/migrate", {
      method: "POST",
      body: "{broken",
    });
    const extra = await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: notes("x"), cwd: "/attacker/chosen" }),
    });
    const revision = await request("a", "/notes", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: -1, document: notes("x") }),
    });
    const document = await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: { ...notes("x"), version: 99 } }),
    });

    expect(malformed).toMatchObject({
      response: { status: 400 },
      body: {
        status: "invalid",
        error: { path: "$", message: "malformed JSON request body" },
      },
    });
    expect(extra.body).toEqual({
      status: "invalid",
      error: { path: "$", message: "invalid request body" },
    });
    expect(revision.body).toEqual({
      status: "invalid",
      error: { path: "$", message: "invalid request body" },
    });
    expect(document.body).toEqual({
      status: "invalid",
      error: { path: "version", message: "expected 3" },
    });
  });

  it("accepts 50 references at their maximum schema field lengths", async () => {
    const base = notes("maximum reference payload");
    const metadata = "x".repeat(NOTES_REFERENCE_METADATA_MAX_LENGTH);
    const document: NotesDocumentV3 = {
      ...base,
      references: Array.from({ length: 50 }, (_, index) => {
        const prefix = `https://example.com/reference/${index}?payload=`;
        return {
          ...base.references[0]!,
          id: `ref-${index + 1}`,
          provider: `source-${metadata.slice(7)}`,
          tool: metadata,
          canonicalUrl: `${prefix}${"x".repeat(NOTES_REFERENCE_URL_MAX_LENGTH - prefix.length)}`,
          owner: metadata,
          repo: metadata,
          revision: metadata,
          path: metadata,
          range: null,
          query: metadata,
          anchor: metadata,
          relevance: metadata,
        };
      }),
    };
    const body = JSON.stringify({ document });

    expect(Buffer.byteLength(body)).toBeGreaterThan(1024 * 1024);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(NOTES_REQUEST_BODY_MAX_BYTES);

    const migrated = await request("a", "/notes/migrate", { method: "POST", body });

    expect(migrated).toMatchObject({
      response: { status: 200 },
      body: { status: "ok", snapshot: { document: { references: { length: 50 } } } },
    });
  });

  it("rejects declared and chunked oversized migration bodies without mutation or fan-out", async () => {
    const expectedError = {
      status: "invalid",
      error: {
        path: "$",
        message: `notes request body exceeds ${NOTES_REQUEST_BODY_MAX_BYTES} bytes`,
      },
    };
    const declared = await request("a", "/notes/migrate", {
      method: "POST",
      headers: { "content-length": String(NOTES_REQUEST_BODY_MAX_BYTES + 1) },
      body: " ".repeat(NOTES_REQUEST_BODY_MAX_BYTES + 1),
    });
    const chunk = Buffer.alloc(Math.floor(NOTES_REQUEST_BODY_MAX_BYTES / 2) + 1, " ");
    const chunked = await chunkedRequest("a", "/notes/migrate", "POST", [chunk, chunk]);
    const paths = repository.paths("C:\\Work\\Project");

    expect(declared).toMatchObject({ response: { status: 413 }, body: expectedError });
    expect(chunked).toEqual({ status: 413, body: expectedError });
    expect((await request("a", "/notes")).body).toEqual({ status: "missing" });
    expect(await readOptionalFile(paths.primary)).toBeNull();
    expect(await readOptionalFile(paths.backup)).toBeNull();
    expect([...sessions.values()].flatMap((session) => session.events)).toEqual([]);

    const recovered = await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: notes("after oversized migration") }),
    });
    expect(recovered).toMatchObject({ response: { status: 200 }, body: { status: "ok" } });
  });

  it("accepts a valid migration body exactly at the Notes byte limit", async () => {
    const json = JSON.stringify({ document: notes("exact byte limit") });
    expect(Buffer.byteLength(json)).toBeLessThan(NOTES_REQUEST_BODY_MAX_BYTES);
    const body = json.padEnd(NOTES_REQUEST_BODY_MAX_BYTES, " ");

    const migrated = await request("a", "/notes/migrate", { method: "POST", body });

    expect(Buffer.byteLength(body)).toBe(NOTES_REQUEST_BODY_MAX_BYTES);
    expect(migrated).toMatchObject({
      response: { status: 200 },
      body: { status: "ok", snapshot: { document: { reference: "exact byte limit" } } },
    });
  });

  it("maps an aborted Notes body to the route error and cleans every reader listener", async () => {
    const dispatched = dispatchSyntheticNotesRequest();

    dispatched.request.emit("aborted");
    dispatched.request.emit("close");
    const response = await dispatched.result;

    expect(response).toMatchObject({
      status: 500,
      headers: { "access-control-allow-origin": "*" },
      body: { status: "error", message: "notes request failed" },
    });
    expect(dispatched.errors).toHaveLength(1);
    expect(dispatched.errors[0]).toBeInstanceOf(AppSidecarJsonBodyError);
    expect(dispatched.errors[0]).toMatchObject({ kind: "aborted" });
    expect(requestListenerCounts(dispatched.request)).toEqual({
      data: 0,
      end: 0,
      error: 0,
      aborted: 0,
      close: 0,
    });
  });

  it("maps a Notes request stream error to 500 and removes every reader listener", async () => {
    const dispatched = dispatchSyntheticNotesRequest();
    const streamError = new Error("synthetic Notes stream failure");

    dispatched.request.emit("error", streamError);
    const response = await dispatched.result;

    expect(response).toMatchObject({
      status: 500,
      body: { status: "error", message: "notes request failed" },
    });
    expect(dispatched.errors).toEqual([streamError]);
    expect(requestListenerCounts(dispatched.request)).toEqual({
      data: 0,
      end: 0,
      error: 0,
      aborted: 0,
      close: 0,
    });
  });

  it("drains declared and streamed Notes overflow and releases temporary listeners", async () => {
    const expectedResponse = {
      status: 413,
      body: {
        status: "invalid",
        error: {
          path: "$",
          message: `notes request body exceeds ${NOTES_REQUEST_BODY_MAX_BYTES} bytes`,
        },
      },
    };
    const declared = dispatchSyntheticNotesRequest({
      "content-length": String(NOTES_REQUEST_BODY_MAX_BYTES + 1),
    });
    declared.request.end("ignored");

    const streamed = dispatchSyntheticNotesRequest();
    streamed.request.end(Buffer.alloc(NOTES_REQUEST_BODY_MAX_BYTES + 1));

    await expect(declared.result).resolves.toMatchObject(expectedResponse);
    await expect(streamed.result).resolves.toMatchObject(expectedResponse);
    await flushStreamEvents();
    for (const dispatched of [declared, streamed]) {
      expect(dispatched.request.readableEnded).toBe(true);
      expect(requestListenerCounts(dispatched.request)).toEqual({
        data: 0,
        end: 0,
        error: 0,
        aborted: 0,
        close: 0,
      });
    }
  });

  it("rejects declared and chunked oversized save bodies without mutation or fan-out", async () => {
    await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: notes("before oversized save") }),
    });
    const paths = repository.paths("C:\\Work\\Project");
    const filesBefore = {
      primary: await readOptionalFile(paths.primary),
      backup: await readOptionalFile(paths.backup),
    };
    const eventCountsBefore = [...sessions.values()].map((session) => session.events.length);
    const expectedError = {
      status: "invalid",
      error: {
        path: "$",
        message: `notes request body exceeds ${NOTES_REQUEST_BODY_MAX_BYTES} bytes`,
      },
    };

    const declared = await request("a", "/notes", {
      method: "PUT",
      headers: { "content-length": String(NOTES_REQUEST_BODY_MAX_BYTES + 1) },
      body: " ".repeat(NOTES_REQUEST_BODY_MAX_BYTES + 1),
    });
    const chunk = Buffer.alloc(Math.floor(NOTES_REQUEST_BODY_MAX_BYTES / 2) + 1, " ");
    const chunked = await chunkedRequest("a", "/notes", "PUT", [chunk, chunk]);

    expect(declared).toMatchObject({ response: { status: 413 }, body: expectedError });
    expect(chunked).toEqual({ status: 413, body: expectedError });
    expect((await request("a", "/notes")).body).toMatchObject({
      status: "ok",
      snapshot: { revision: 1, document: { reference: "before oversized save" } },
    });
    expect(await readOptionalFile(paths.primary)).toBe(filesBefore.primary);
    expect(await readOptionalFile(paths.backup)).toBe(filesBefore.backup);
    expect([...sessions.values()].map((session) => session.events.length)).toEqual(
      eventCountsBefore,
    );

    const recovered = await request("a", "/notes", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 1, document: notes("after oversized save") }),
    });
    expect(recovered).toMatchObject({
      response: { status: 200 },
      body: { status: "ok", snapshot: { revision: 2 } },
    });
  });

  it("rejects credential-bearing reference URLs at the sidecar boundary", async () => {
    const withUsername = notes("username");
    withUsername.references[0] = {
      ...withUsername.references[0]!,
      canonicalUrl: "https://user@github.com/owner/repo/blob/abc/src/file.ts#L1",
    };
    const rejectedMigration = await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: withUsername }),
    });

    expect(rejectedMigration).toMatchObject({
      response: { status: 400 },
      body: {
        status: "invalid",
        error: {
          path: "references[0].canonicalUrl",
          message: "expected an absolute http(s) URL without username or password",
        },
      },
    });
    expect((await request("a", "/notes")).body).toEqual({ status: "missing" });
    expect(sessions.get("a")?.events).toEqual([]);

    const valid = notes("valid");
    await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: valid }),
    });
    const withPassword = notes("password");
    withPassword.references[0] = {
      ...withPassword.references[0]!,
      canonicalUrl: "https://:secret@github.com/owner/repo/blob/abc/src/file.ts#L1",
    };
    const rejectedSave = await request("a", "/notes", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 1, document: withPassword }),
    });

    expect(rejectedSave).toMatchObject({
      response: { status: 400 },
      body: { status: "invalid", error: { path: "references[0].canonicalUrl" } },
    });
    expect((await request("a", "/notes")).body).toMatchObject({
      status: "ok",
      snapshot: { revision: 1, document: { reference: "valid" } },
    });
    expect(sessions.get("a")?.events).toHaveLength(1);
  });

  it("returns the winning snapshot in a typed stale-write conflict", async () => {
    await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: notes("base") }),
    });
    const winner = await request("a", "/notes", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 1, document: notes("winner") }),
    });
    const stale = await request("alias", "/notes", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 1, document: notes("stale") }),
    });

    expect(winner.response.status).toBe(200);
    expect(winner.body).toMatchObject({
      status: "ok",
      snapshot: { revision: 2, document: { reference: "winner" } },
    });
    expect(stale.response.status).toBe(409);
    expect(stale.body).toEqual({
      status: "conflict",
      snapshot: {
        projectKey: "c:/work/project",
        revision: 2,
        document: notes("winner"),
      },
    });
    expect(committedSnapshots).toEqual([
      { projectKey: "c:/work/project", revision: 1 },
      { projectKey: "c:/work/project", revision: 2 },
    ]);
  });

  it("serializes simultaneous migration behind create-if-absent", async () => {
    const [first, second] = await Promise.all([
      request("a", "/notes/migrate", {
        method: "POST",
        body: JSON.stringify({ document: notes("first") }),
      }),
      request("alias", "/notes/migrate", {
        method: "POST",
        body: JSON.stringify({ document: notes("second") }),
      }),
    ]);
    const bodies = [first.body, second.body] as Array<{
      status: string;
      migrated: boolean;
      snapshot: unknown;
    }>;

    expect(bodies.filter((body) => body.migrated)).toHaveLength(1);
    expect(bodies.filter((body) => !body.migrated)).toHaveLength(1);
    expect(bodies[0]?.snapshot).toEqual(bodies[1]?.snapshot);
    expect(committedSnapshots).toEqual([{ projectKey: "c:/work/project", revision: 1 }]);
  });

  it("fans committed snapshots to every same-project alias and isolates other projects", async () => {
    const migrated = await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: notes("migrated") }),
    });
    const saved = await request("alias", "/notes", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 1, document: notes("saved") }),
    });

    expect(migrated.response.status).toBe(200);
    expect(saved.response.status).toBe(200);
    expect(committedSnapshots).toEqual([
      { projectKey: "c:/work/project", revision: 1 },
      { projectKey: "c:/work/project", revision: 2 },
    ]);
    expect(sessions.get("a")?.events).toEqual([
      { type: "notes_change", data: expect.objectContaining({ revision: 1 }) },
      { type: "notes_change", data: expect.objectContaining({ revision: 2 }) },
    ]);
    expect(sessions.get("alias")?.events).toEqual(sessions.get("a")?.events);
    expect(sessions.get("other")?.events).toEqual([]);
  });

  it("returns typed corruption and preserves the corrupt files", async () => {
    const paths = repository.paths("C:\\Work\\Project");
    await fs.mkdir(paths.directory, { recursive: true });
    await fs.writeFile(paths.primary, "{primary", "utf8");
    await fs.writeFile(paths.backup, "{backup", "utf8");

    const loaded = await request("a", "/notes");
    const migrated = await request("a", "/notes/migrate", {
      method: "POST",
      body: JSON.stringify({ document: notes("replacement") }),
    });

    expect(loaded.response.status).toBe(409);
    expect(loaded.body).toEqual({
      status: "corrupt",
      primary: "malformed-json",
      backup: "malformed-json",
    });
    expect(migrated.response.status).toBe(409);
    expect(await fs.readFile(paths.primary, "utf8")).toBe("{primary");
    expect(await fs.readFile(paths.backup, "utf8")).toBe("{backup");
  });

  it("owns only the exact Notes routes", async () => {
    const missing = await request("a", "/notes/other");
    const wrongMethod = await request("a", "/notes", { method: "POST" });

    expect(missing.response.status).toBe(404);
    expect(wrongMethod.response.status).toBe(405);
  });
});
