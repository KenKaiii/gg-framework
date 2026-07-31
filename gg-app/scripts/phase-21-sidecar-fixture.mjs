import http from "node:http";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

const projectDir = resolve(process.env.GG_APP_CWD ?? process.cwd());
const auditFile = process.env.GG_PHASE21_SMOKE_AUDIT_FILE;
if (!auditFile) throw new Error("GG_PHASE21_SMOKE_AUDIT_FILE is required");

const boundSessionId = "phase21-bound-session";
const boundSessionPath = join(projectDir, "phase-21-bound.jsonl");
const operationId = "phase21-operation-1";
const planReason = "Plan Roadmap phase: Bound phase";
const sessions = new Map();
let nextLogicalSessionId = 1;
let notesRevision = 1;
let phaseBound = process.env.GG_PHASE21_SMOKE_PREBOUND === "1";

function canonicalProjectKey(cwd) {
  const normalized = resolve(cwd).replaceAll("\\", "/");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function notesDocument() {
  const now = "2026-07-27T00:00:00.000Z";
  return {
    version: 3,
    reference: "Phase 21 packaged native smoke",
    currentFocus: "Verify packaged Start and Resume",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: now,
    legacyImportedAt: null,
    references: [],
    phases: [
      {
        id: "phase-21",
        title: "Bound phase",
        goal: "Prove packaged native Start and Resume",
        doneWhen: ["One bound session is restored in Plan Mode"],
        order: 0,
        status: phaseBound ? "planning" : "not-started",
        sourcePrompt: "Plan only this deterministic smoke phase.",
        referenceIds: [],
        session: phaseBound ? { sessionId: boundSessionId, sessionPath: boundSessionPath } : null,
        reminder: null,
        attentionReason: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        archivedAt: null,
        overrides: { status: null, referenceIds: null },
        pendingAutomaticLifecycleTransition: null,
        lifecycleEvents: phaseBound
          ? [
              {
                id: "phase21-lifecycle-1",
                fromStatus: "not-started",
                toStatus: "planning",
                source: "session",
                timestamp: now,
                reason: "Phase session bound",
                kind: "other",
              },
            ]
          : [],
        roadmapEvents: [],
      },
    ],
  };
}

function notesSnapshot() {
  return {
    projectKey: canonicalProjectKey(projectDir),
    revision: notesRevision,
    document: notesDocument(),
  };
}

function audit(event) {
  appendFileSync(auditFile, `${JSON.stringify({ timestamp: Date.now(), ...event })}\n`);
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sessionState(sessionId, session) {
  const restored = session.sessionPath === boundSessionPath;
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    cwd: projectDir,
    sessionId: restored ? boundSessionId : sessionId,
    sessionPath: session.sessionPath,
    messageCount: restored ? 1 : 0,
    mode: "code",
    chatAgent: "general",
    running: false,
    runState: "idle",
    ready: true,
    planMode: restored,
    thinkingLevel: null,
    supportedThinkingLevels: [],
    supportsVideo: false,
    autopilot: false,
    kenRunning: false,
    kenIsThinking: false,
    kenThinkingStartTs: null,
    kenThinkingAccumMs: 0,
    kenTokens: 0,
    contextWindow: 200000,
    gitBranch: null,
    isGitRepo: false,
    gitDirtyFileCount: 0,
    tasks: [],
  };
}

function history(session) {
  if (session.sessionPath !== boundSessionPath) return { history: [] };
  return {
    history: [{ role: "assistant", text: "", plan: { reason: planReason } }],
  };
}

function broadcast(sessionId, type, data) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const frame = `data: ${JSON.stringify({ sessionId, type, data })}\n\n`;
  for (const client of session.clients) client.write(frame);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "POST" && url.pathname === "/session") {
    const raw = await readBody(request);
    const body = raw ? JSON.parse(raw) : {};
    const sessionId = `phase21-logical-${nextLogicalSessionId++}`;
    const sessionPath =
      typeof body.sessionPath === "string" && body.sessionPath ? body.sessionPath : null;
    sessions.set(sessionId, { clients: new Set(), sessionPath });
    audit({ route: "/session", status: 200, sessionId, requestedSessionPath: sessionPath });
    json(response, 200, { sessionId });
    return;
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/session/")) {
    sessions.delete(decodeURIComponent(url.pathname.slice("/session/".length)));
    json(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/progress") {
    json(response, 200, { xp: 0, level: 1, rank: "Newcomer", nextLevelXp: 100 });
    return;
  }

  const sessionId = request.headers["x-gg-session"] ?? url.searchParams.get("session");
  const session = typeof sessionId === "string" ? sessions.get(sessionId) : null;
  if (!session) {
    audit({ route: url.pathname, status: 404, authenticated: false });
    json(response, 404, { error: "unknown fixture session" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(
      `data: ${JSON.stringify({ sessionId, type: "ready", data: sessionState(sessionId, session) })}\n\n`,
    );
    session.clients.add(response);
    request.once("close", () => session.clients.delete(response));
    return;
  }
  if (request.method === "GET" && url.pathname === "/state") {
    json(response, 200, sessionState(sessionId, session));
    return;
  }
  if (request.method === "GET" && url.pathname === "/history") {
    json(response, 200, history(session));
    return;
  }
  if (request.method === "GET" && ["/models", "/commands", "/tasks"].includes(url.pathname)) {
    const key = url.pathname.slice(1);
    json(response, 200, { [key]: [] });
    return;
  }
  if (request.method === "GET" && url.pathname === "/notes") {
    json(response, 200, { status: "ok", snapshot: notesSnapshot(), recoveredFromBackup: false });
    return;
  }
  if (request.method === "POST" && url.pathname === "/phases/phase-busy/start") {
    audit({
      route: url.pathname,
      status: 409,
      authenticated: true,
      logicalSessionId: sessionId,
      result: "session-busy",
    });
    json(response, 409, {
      status: "failed",
      code: "session-busy",
      operationId: null,
      message: "Wait for the current run or Autopilot review to finish.",
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/phases/phase-21/start") {
    if (phaseBound) {
      audit({
        route: url.pathname,
        status: 200,
        authenticated: true,
        logicalSessionId: sessionId,
        result: "already-bound",
      });
      json(response, 200, {
        status: "already-bound",
        operationId: "phase21-already-bound-1",
        session: { sessionId: boundSessionId, sessionPath: boundSessionPath },
        packageTokenCount: 0,
      });
      return;
    }

    phaseBound = true;
    notesRevision += 1;
    audit({
      route: url.pathname,
      status: 202,
      authenticated: true,
      logicalSessionId: sessionId,
      result: "accepted",
      operationId,
      boundSessionId,
      boundSessionPath,
    });
    audit({ route: "phase-prompt", status: 202, operationId, count: 1 });
    broadcast(sessionId, "notes_change", notesSnapshot());
    broadcast(sessionId, "session_reset", {
      operationId,
      phaseId: "phase-21",
      sessionId: boundSessionId,
      sessionPath: boundSessionPath,
    });
    broadcast(sessionId, "plan_enter", { reason: planReason });
    json(response, 202, {
      status: "accepted",
      operationId,
      session: { sessionId: boundSessionId, sessionPath: boundSessionPath },
      packageTokenCount: 42,
    });
    return;
  }
  json(response, 200, {});
});

server.listen(Number(process.env.GG_APP_PORT ?? 0), "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a TCP port");
  process.stdout.write(`GG_APP_LISTENING ${address.port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
