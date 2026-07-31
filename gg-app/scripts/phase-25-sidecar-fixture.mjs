import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, watchFile, unwatchFile } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PHASE25_NOW = "2026-07-29T12:00:00.000Z";
export const PHASE25_DUE_EVENT = Object.freeze({ type: "roadmap_reminder_due", data: {} });

function canonicalProjectKey(cwd) {
  const normalized = resolve(cwd).replaceAll("\\", "/");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function fixturePhase(lastDelivery = null) {
  return {
    id: "phase-25-fixture",
    title: "Private fixture phase",
    goal: "Prove the real packaged background reminder path",
    doneWhen: ["One privacy-safe Windows toast is visible"],
    order: 0,
    status: "in-progress",
    sourcePrompt: "Private fixture source prompt",
    referenceIds: [],
    session: null,
    reminder: {
      id: "reminder-phase-25",
      occurrenceKey: "occurrence-phase-25",
      dueAt: "2026-07-28T12:00:00.000Z",
      note: "Private fixture note",
      createdAt: "2026-07-28T11:00:00.000Z",
      lastDelivery,
    },
    attentionReason: null,
    createdAt: "2026-07-29T11:00:00.000Z",
    updatedAt: PHASE25_NOW,
    completedAt: null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    lifecycleEvents: [],
    roadmapEvents: [],
  };
}

function fixtureDocument(lastDelivery = null) {
  return {
    version: 3,
    reference: "Private Phase 25 fixture reference",
    currentFocus: "Private Phase 25 fixture focus",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: PHASE25_NOW,
    legacyImportedAt: null,
    phases: [fixturePhase(lastDelivery)],
    references: [],
  };
}

export function createPhase25FixtureState(projectDir = process.cwd(), seedSnapshot = null) {
  return {
    projectDir: resolve(projectDir),
    revision: seedSnapshot?.revision ?? 1,
    document: structuredClone(seedSnapshot?.document ?? fixtureDocument()),
    armed: false,
    dueEventCount: 0,
    lease: null,
    nativeAttempts: 0,
    releases: 0,
  };
}

export function notesFixtureSnapshot(state) {
  return {
    projectKey: canonicalProjectKey(state.projectDir),
    revision: state.revision,
    document: structuredClone(state.document),
  };
}

export function armPhase25Fixture(state) {
  if (state.armed) return false;
  state.armed = true;
  return true;
}

export function reserveFixtureReminder(state, sessionId, focused, now = PHASE25_NOW) {
  const phase = state.document.phases[0];
  const reminder = phase.reminder;
  if (!state.armed) return { status: "none" };
  if (reminder.lastDelivery?.occurrenceKey === reminder.occurrenceKey) {
    return { status: "already-delivered" };
  }
  if (Date.parse(reminder.dueAt) > Date.parse(now)) return { status: "none" };
  if (state.lease) return { status: "leased" };
  state.lease = {
    token: randomUUID(),
    sessionId,
    occurrenceKey: reminder.occurrenceKey,
  };
  return {
    status: "reserved",
    leaseToken: state.lease.token,
    expiresAt: new Date(Date.parse(now) + 15_000).toISOString(),
    phase: { id: phase.id, title: phase.title, session: phase.session },
    reminder: {
      id: reminder.id,
      occurrenceKey: reminder.occurrenceKey,
      dueAt: reminder.dueAt,
      note: reminder.note,
    },
    focused,
  };
}

export function claimFixtureReminder(
  state,
  sessionId,
  leaseToken,
  channel,
  permission,
  now = PHASE25_NOW,
) {
  if (!state.lease || state.lease.token !== leaseToken) return { status: "invalid-lease" };
  if (state.lease.sessionId !== sessionId) return { status: "wrong-session" };
  const phase = state.document.phases[0];
  phase.reminder.lastDelivery = {
    occurrenceKey: phase.reminder.occurrenceKey,
    attemptedAt: now,
    channel,
    permission,
  };
  state.revision += 1;
  state.lease = null;
  if (channel === "native") state.nativeAttempts += 1;
  return {
    status: "ok",
    snapshot: notesFixtureSnapshot(state),
    phase: structuredClone(phase),
  };
}

export function releaseFixtureReminder(state, sessionId, leaseToken) {
  if (!state.lease || state.lease.token !== leaseToken) return { status: "invalid-lease" };
  if (state.lease.sessionId !== sessionId) return { status: "wrong-session" };
  state.lease = null;
  state.releases += 1;
  return { status: "released" };
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sessionState(state, sessionId) {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    cwd: state.projectDir,
    sessionId,
    sessionPath: null,
    messageCount: 0,
    mode: "code",
    chatAgent: "general",
    running: false,
    runState: "idle",
    ready: true,
    planMode: false,
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

function emitDueEvent(state, sessions) {
  const frame = `data: ${JSON.stringify({ sessionId: null, ...PHASE25_DUE_EVENT })}\n\n`;
  for (const [sessionId, session] of sessions) {
    const sessionFrame = frame.replace(
      '"sessionId":null',
      `"sessionId":${JSON.stringify(sessionId)}`,
    );
    for (const client of session.clients) client.write(sessionFrame);
  }
  state.dueEventCount += 1;
}

export function createPhase25FixtureServer({
  projectDir,
  auditFile,
  armFile,
  seedSnapshot = null,
  focusedOnly = false,
}) {
  if (!auditFile) throw new Error("GG_PHASE25_SMOKE_AUDIT_FILE is required");
  if (!armFile) throw new Error("GG_PHASE25_SMOKE_ARM_FILE is required");
  const state = createPhase25FixtureState(projectDir, seedSnapshot);
  const sessions = new Map();
  let sequence = 0;
  let nextSession = 1;
  let notesReadyAudited = false;

  const audit = (event) => {
    appendFileSync(
      auditFile,
      `${JSON.stringify({ sequence: ++sequence, timestamp: Date.now(), ...event })}\n`,
    );
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/session") {
        await readBody(request);
        const sessionId = `phase25-session-${nextSession++}`;
        sessions.set(sessionId, { clients: new Set() });
        audit({
          route: "/session",
          action: "authenticated-session",
          authenticated: true,
          sessionId,
        });
        json(response, 200, { sessionId });
        return;
      }
      if (request.method === "GET" && url.pathname === "/progress") {
        json(response, 200, { xp: 0, level: 1, rank: "Newcomer", nextLevelXp: 100 });
        return;
      }

      const headerSession = request.headers["x-gg-session"];
      const querySession = url.searchParams.get("session");
      const deletedSession =
        request.method === "DELETE" && url.pathname.startsWith("/session/")
          ? decodeURIComponent(url.pathname.slice("/session/".length))
          : null;
      const sessionId =
        typeof headerSession === "string" ? headerSession : (querySession ?? deletedSession);
      const session = sessionId ? sessions.get(sessionId) : null;
      if (!session) {
        audit({ route: url.pathname, action: "authentication-rejected", authenticated: false });
        json(response, 401, { error: "unknown fixture session" });
        return;
      }

      if (
        request.method === "DELETE" &&
        (url.pathname === "/session" || url.pathname.startsWith("/session/"))
      ) {
        sessions.delete(sessionId);
        audit({ route: "/session", action: "deleted", authenticated: true, sessionId });
        json(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(
          `data: ${JSON.stringify({ sessionId, type: "ready", data: sessionState(state, sessionId) })}\n\n`,
        );
        session.clients.add(response);
        request.once("close", () => session.clients.delete(response));
        return;
      }
      if (request.method === "GET" && url.pathname === "/state") {
        json(response, 200, sessionState(state, sessionId));
        return;
      }
      if (request.method === "GET" && url.pathname === "/notes") {
        if (!notesReadyAudited) {
          notesReadyAudited = true;
          audit({ route: "/notes", action: "authoritative-notes-ready", authenticated: true });
        }
        json(response, 200, {
          status: "ok",
          snapshot: notesFixtureSnapshot(state),
          recoveredFromBackup: false,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/reminders/reserve") {
        const body = await readBody(request);
        if (typeof body.focused !== "boolean") {
          json(response, 400, { status: "invalid" });
          return;
        }
        if (focusedOnly && !body.focused) {
          audit({
            route: url.pathname,
            action: "background-reserve-blocked",
            authenticated: true,
          });
          json(response, 200, { status: "none" });
          return;
        }
        const result = reserveFixtureReminder(state, sessionId, body.focused);
        if (result.status === "reserved") {
          audit({
            route: url.pathname,
            action: "reserve",
            authenticated: true,
            focused: body.focused,
            status: result.status,
          });
        }
        const { focused: _focused, ...responseResult } = result;
        json(response, 200, responseResult);
        return;
      }
      if (request.method === "POST" && url.pathname === "/reminders/claim") {
        const body = await readBody(request);
        const result = claimFixtureReminder(
          state,
          sessionId,
          body.leaseToken,
          body.channel,
          body.permission,
        );
        audit({
          route: url.pathname,
          action: "claim",
          authenticated: true,
          channel: body.channel,
          permission: body.permission,
          status: result.status,
          revision: state.revision,
        });
        json(response, 200, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/reminders/release") {
        const body = await readBody(request);
        const result = releaseFixtureReminder(state, sessionId, body.leaseToken);
        audit({
          route: url.pathname,
          action: "release",
          authenticated: true,
          status: result.status,
        });
        json(response, 200, result);
        return;
      }
      if (request.method === "GET" && url.pathname === "/history") {
        json(response, 200, { history: [] });
        return;
      }
      if (request.method === "GET" && ["/models", "/commands", "/tasks"].includes(url.pathname)) {
        const key = url.pathname.slice(1);
        json(response, 200, { [key]: [] });
        return;
      }
      json(response, 200, {});
    } catch (error) {
      audit({ route: request.url ?? "/", action: "fixture-error", message: String(error) });
      if (!response.headersSent) json(response, 500, { error: "fixture request failed" });
      else response.end();
    }
  });

  const armWatcher = () => {
    if (!existsSync(armFile) || !armPhase25Fixture(state)) return;
    audit({ route: "arm-file", action: "arm", authenticated: true });
    emitDueEvent(state, sessions);
  };
  watchFile(armFile, { interval: 50 }, armWatcher);

  return {
    server,
    state,
    sessions,
    recordListening(port) {
      audit({ route: "fixture", action: "fixture-listening", port });
    },
    close() {
      unwatchFile(armFile, armWatcher);
      return new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

export function validatePhase25FixtureAudit(
  entries,
  expectedDelivery = { focused: false, channel: "native", permission: "granted" },
) {
  const significant = entries.filter((entry) =>
    [
      "authenticated-session",
      "authoritative-notes-ready",
      "arm",
      "reserve",
      "claim",
      "release",
    ].includes(entry.action),
  );
  const actions = significant.map((entry) => entry.action);
  const expectedActions = [
    "authenticated-session",
    "authoritative-notes-ready",
    "arm",
    "reserve",
    "claim",
  ];
  if (JSON.stringify(actions) !== JSON.stringify(expectedActions)) {
    throw new Error(`unexpected Phase 25 fixture order: ${actions.join(" -> ")}`);
  }
  const reserve = significant.find((entry) => entry.action === "reserve");
  const claim = significant.find((entry) => entry.action === "claim");
  if (reserve.focused !== expectedDelivery.focused || reserve.status !== "reserved") {
    throw new Error("Phase 25 fixture used the wrong focus path");
  }
  if (
    claim.channel !== expectedDelivery.channel ||
    claim.permission !== expectedDelivery.permission ||
    claim.status !== "ok" ||
    claim.revision !== 2
  ) {
    throw new Error("Phase 25 fixture committed the wrong reminder claim");
  }
  return significant;
}

export function validatePhase25Fixture() {
  const state = createPhase25FixtureState();
  const unarmed = reserveFixtureReminder(state, "background", false);
  armPhase25Fixture(state);
  const reserved = reserveFixtureReminder(state, "background", false);
  const wrong = claimFixtureReminder(state, "other", reserved.leaseToken, "native", "granted");
  const claimed = claimFixtureReminder(
    state,
    "background",
    reserved.leaseToken,
    "native",
    "granted",
  );
  const replay = reserveFixtureReminder(state, "background", false);
  if (
    unarmed.status !== "none" ||
    reserved.status !== "reserved" ||
    wrong.status !== "wrong-session" ||
    claimed.status !== "ok" ||
    state.revision !== 2 ||
    replay.status !== "already-delivered"
  ) {
    throw new Error("Phase 25 fixture state contract failed");
  }
  return {
    unarmed,
    reserved: reserved.status,
    wrong: wrong.status,
    claimed: claimed.status,
    replay,
    state,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.GG_PHASE25_SMOKE_AUDIT_FILE && !process.env.GG_PHASE25_SMOKE_ARM_FILE) {
    process.stdout.write(`${JSON.stringify(validatePhase25Fixture(), null, 2)}\n`);
  } else {
    const seedSnapshot = process.env.GG_PHASE25_SMOKE_SEED_FILE
      ? JSON.parse(readFileSync(process.env.GG_PHASE25_SMOKE_SEED_FILE, "utf8"))
      : null;
    const fixture = createPhase25FixtureServer({
      projectDir: process.env.GG_APP_CWD ?? process.cwd(),
      auditFile: process.env.GG_PHASE25_SMOKE_AUDIT_FILE,
      armFile: process.env.GG_PHASE25_SMOKE_ARM_FILE,
      seedSnapshot,
      focusedOnly: process.env.GG_PHASE25_SMOKE_FOCUSED_ONLY === "1",
    });
    fixture.server.listen(Number(process.env.GG_APP_PORT ?? 0), "127.0.0.1", () => {
      const address = fixture.server.address();
      if (!address || typeof address === "string")
        throw new Error("fixture did not bind a TCP port");
      fixture.recordListening(address.port);
      process.stdout.write(`GG_APP_LISTENING ${address.port}\n`);
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => void fixture.close().then(() => process.exit(0)));
    }
  }
}
