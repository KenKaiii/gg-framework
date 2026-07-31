import http from "node:http";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

const scenario = process.env.GG_PHASE20_SMOKE_SCENARIO;
if (scenario !== "reject-409" && scenario !== "drop-reset") {
  throw new Error(`unsupported Phase 20 sidecar fixture scenario: ${scenario ?? "missing"}`);
}

const sessions = new Map();
const projectDir = process.env.GG_APP_CWD ?? process.cwd();
const prompt = "PHASE20_NATIVE_FRESH_SEND_CANARY";
const auditFile = process.env.GG_PHASE20_SMOKE_AUDIT_FILE;
if (!auditFile) throw new Error("GG_PHASE20_SMOKE_AUDIT_FILE is required");

function audit(event) {
  appendFileSync(auditFile, `${JSON.stringify({ timestamp: Date.now(), ...event })}\n`);
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function state(sessionId) {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    cwd: projectDir,
    sessionId,
    sessionPath: null,
    messageCount: 0,
    mode: "code",
    chatAgent: "general",
    running: false,
    runState: "idle",
    ready: true,
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

function history() {
  return {
    history: [
      { role: "user", text: "Prepare the deterministic native smoke prompt.", ken: true },
      {
        role: "assistant",
        text: `Native smoke fixture\n\n\`\`\`prompt\n${prompt}\n\`\`\``,
        ken: true,
      },
    ],
  };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "POST" && url.pathname === "/session") {
    await readBody(request);
    const sessionId = randomUUID();
    sessions.set(sessionId, { clients: new Set(), promptCount: 0 });
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
      `data: ${JSON.stringify({ sessionId, type: "ready", data: state(sessionId) })}\n\n`,
    );
    session.clients.add(response);
    request.once("close", () => session.clients.delete(response));
    return;
  }
  if (request.method === "GET" && url.pathname === "/state") {
    json(response, 200, state(sessionId));
    return;
  }
  if (request.method === "GET" && url.pathname === "/history") {
    json(response, 200, history());
    return;
  }
  if (request.method === "GET" && ["/models", "/commands", "/tasks"].includes(url.pathname)) {
    const key = url.pathname.slice(1);
    json(response, 200, { [key]: [] });
    return;
  }
  if (request.method === "GET" && url.pathname === "/notes") {
    json(response, 200, { status: "missing" });
    return;
  }
  if (request.method === "POST" && url.pathname === "/new-session") {
    if (scenario === "reject-409") {
      audit({ route: "/new-session", status: 409 });
      json(response, 409, { error: "fixture new-session conflict" });
      return;
    }
    const operationId = randomUUID();
    audit({ route: "/new-session", status: 200, operationId });
    json(response, 200, { ok: true, operationId });
    return;
  }
  if (request.method === "POST" && url.pathname === "/prompt") {
    session.promptCount += 1;
    audit({ route: "/prompt", status: 202, count: session.promptCount });
    json(response, 202, { queued: false, count: 0 });
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
