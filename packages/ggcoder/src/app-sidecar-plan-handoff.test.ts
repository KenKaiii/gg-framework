import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Plan hand-off, end to end: the REAL app sidecar daemon, driven over HTTP,
 * talking to a scripted OpenAI-compatible model server. The bug class covered
 * here — a submitted plan left pending with no review box and nobody acting on
 * it — lives entirely in the daemon's settle-point wiring, which a unit test of
 * the pure decision cannot see.
 *
 * The scripted main agent submits `.gg/plans/plan.md` when a prompt contains
 * PLAN_IT, writes a code file (leaving unverified work) on EDIT_IT, enters plan
 * mode and then stops WITHOUT submitting on DRAFT_IT, and tries to write code
 * on REVISE_IT. It submits only when reminded to. Ken's autopilot reviewer is
 * recognised by his verdict-only system prompt and answers with the test's
 * verdicts in order (the last one repeats).
 */
const SIDECAR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "app-sidecar.js",
);

const PLAN_REL = path.join(".gg", "plans", "plan.md");
const PLAN = "# Plan\n\n## Steps\n1. Add the helper\n2. Wire it in\n";
const KEN_MARKER = "Autopilot mode: verdict only";

interface SidecarEvent {
  type: string;
  data: Record<string, unknown>;
}

type Daemon = ChildProcessByStdio<null, Readable, Readable>;

let tmpHome: string;
let tmpProject: string;
let daemon: Daemon | undefined;
let daemonPort = 0;
let token = "";
let modelServer: http.Server | undefined;
let kenVerdicts = ["HUMAN\nPlease look at this plan yourself."];
let kenReviews = 0;
const NUDGE_MARKER = "haven't submitted a plan";
const SNEAKY_REL = path.join("src", "sneaky.ts");
const openStreams: http.IncomingMessage[] = [];

// ── Scripted model server ───────────────────────────────────────────────────

interface ChatRequest {
  stream?: boolean;
  messages?: { role?: string; content?: unknown }[];
  tools?: { function?: { name?: string } }[];
}

type Reply = { text: string } | { tool: string; args: Record<string, unknown> };

function scriptedReply(body: ChatRequest): Reply {
  const messages = body.messages ?? [];
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => JSON.stringify(m.content))
    .join("\n");
  if (system.includes(KEN_MARKER)) {
    kenReviews++;
    const verdict = kenVerdicts.length > 1 ? kenVerdicts.shift() : kenVerdicts[0];
    return { text: verdict ?? "HUMAN" };
  }
  // enter_plan/exit_plan are deferred (loaded on first call), so recognise the
  // main agent by its always-loaded tools instead.
  const isMainAgent = (body.tools ?? []).some((t) =>
    ["ask_user", "tool_search", "exit_plan"].includes(t.function?.name ?? ""),
  );
  const last = messages.at(-1);
  if (!isMainAgent || last?.role !== "user") return { text: "Done." };
  const said = JSON.stringify(last.content);
  // Checked first: the reminder is the only thing that gets a drafted plan in.
  if (said.includes(NUDGE_MARKER)) return { tool: "exit_plan", args: { plan_path: PLAN_REL } };
  if (said.includes("DRAFT_IT")) {
    return { tool: "enter_plan", args: { reason: "multi-file change" } };
  }
  if (said.includes("REVISE_IT")) {
    return { tool: "write", args: { file_path: SNEAKY_REL, content: "export const x = 1;\n" } };
  }
  if (said.includes("PLAN_IT")) return { tool: "exit_plan", args: { plan_path: PLAN_REL } };
  if (said.includes("EDIT_IT")) {
    return {
      tool: "write",
      args: { file_path: "src/helper.ts", content: "export const helper = 1;\n" },
    };
  }
  return { text: "Done." };
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-v4-pro",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function writeStreamed(res: http.ServerResponse, reply: Reply): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  if ("text" in reply) {
    res.write(chunk({ role: "assistant", content: reply.text }, null));
    res.write(chunk({}, "stop"));
  } else {
    const call = {
      index: 0,
      id: `call_${reply.tool}`,
      type: "function",
      function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
    };
    res.write(chunk({ role: "assistant", tool_calls: [call] }, null));
    res.write(chunk({}, "tool_calls"));
  }
  res.write(
    `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: "deepseek-v4-pro", choices: [], usage: USAGE })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}

function writeWhole(res: http.ServerResponse, reply: Reply): void {
  const message =
    "text" in reply
      ? { role: "assistant", content: reply.text }
      : {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_${reply.tool}`,
              type: "function",
              function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
            },
          ],
        };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "deepseek-v4-pro",
      choices: [{ index: 0, message, finish_reason: "text" in reply ? "stop" : "tool_calls" }],
      usage: USAGE,
    }),
  );
}

async function startModelServer(): Promise<number> {
  modelServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as ChatRequest;
      const reply = scriptedReply(body);
      if (body.stream === false) writeWhole(res, reply);
      else writeStreamed(res, reply);
    });
  });
  await new Promise<void>((resolve) => modelServer?.listen(0, "127.0.0.1", resolve));
  return (modelServer.address() as AddressInfo).port;
}

// ── Daemon + HTTP helpers ───────────────────────────────────────────────────

async function startDaemon(): Promise<void> {
  const running = spawn(process.execPath, [SIDECAR], {
    cwd: tmpProject,
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      GG_APP_CWD: tmpProject,
      GG_APP_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon = running;
  daemonPort = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`daemon never listened: ${out}`)), 60_000);
    running.stdout.on("data", (data) => {
      out += data;
      const match = /GG_APP_LISTENING (\d+) (\S+)/.exec(out);
      if (match?.[1] && match[2]) {
        clearTimeout(timer);
        token = match[2];
        resolve(Number(match[1]));
      }
    });
    running.on("error", reject);
    running.on("exit", (code) => reject(new Error(`daemon exited (${code}): ${out}`)));
  });
}

function request(
  method: string,
  urlPath: string,
  opts: { session?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: daemonPort,
        path: urlPath,
        method,
        headers: {
          "x-gg-token": token,
          ...(payload ? { "content-type": "application/json" } : {}),
          ...(opts.session ? { "x-gg-session": opts.session } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            // Non-JSON bodies are only checked by status.
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function openEventStream(session: string): Promise<SidecarEvent[]> {
  return new Promise((resolve, reject) => {
    const events: SidecarEvent[] = [];
    const req = http.request(
      {
        host: "127.0.0.1",
        port: daemonPort,
        path: `/events?session=${session}`,
        method: "GET",
        headers: { "x-gg-token": token },
      },
      (res) => {
        openStreams.push(res);
        let buf = "";
        res.on("data", (data) => {
          buf += data;
          let split = buf.indexOf("\n\n");
          while (split !== -1) {
            const frame = buf.slice(0, split);
            buf = buf.slice(split + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                events.push(JSON.parse(line.slice(6)) as SidecarEvent);
              } catch {
                // Keepalives are not events.
              }
            }
            split = buf.indexOf("\n\n");
          }
        });
        resolve(events);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const count = (events: SidecarEvent[], type: string): number =>
  events.filter((e) => e.type === type).length;

/** One window: a code session plus its event stream. */
async function openWindow(): Promise<{ session: string; events: SidecarEvent[] }> {
  const created = await request("POST", "/session", { body: { mode: "code", cwd: tmpProject } });
  expect(created.status).toBe(200);
  const session = created.json.sessionId as string;
  const events = await openEventStream(session);
  await waitFor(() => count(events, "ready") > 0, "ready");
  return { session, events };
}

async function setAutopilot(session: string, enabled: boolean): Promise<void> {
  const res = await request("POST", "/autopilot", { session, body: { enabled } });
  expect(res.status).toBe(200);
}

/** Send a prompt and wait for its run (and the hand-off after it) to settle. */
async function promptAndSettle(
  window: { session: string; events: SidecarEvent[] },
  text: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const ends = count(window.events, "run_end");
  const res = await request("POST", "/prompt", {
    session: window.session,
    body: meta ? { text, meta } : { text },
  });
  expect(res.status).toBeLessThan(300);
  await waitFor(() => count(window.events, "run_end") > ends, `run_end after "${text}"`);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(async () => {
  kenVerdicts = ["HUMAN\nPlease look at this plan yourself."];
  kenReviews = 0;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-plan-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-plan-project-"));
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.mkdir(path.join(tmpProject, ".gg", "plans"), { recursive: true });
  await fs.mkdir(path.join(tmpProject, "src"), { recursive: true });
  await fs.writeFile(path.join(tmpProject, PLAN_REL), PLAN);
  const modelPort = await startModelServer();
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      deepseek: {
        accessToken: "sk-test",
        refreshToken: "",
        expiresAt: Date.now() + 1_000_000_000,
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
      },
    }),
  );
  await fs.writeFile(
    path.join(tmpHome, ".gg", "settings.json"),
    JSON.stringify({ provider: "deepseek", model: "deepseek-v4-pro", autoCompact: false }),
  );
  await startDaemon();
});

afterEach(async () => {
  for (const stream of openStreams.splice(0)) stream.destroy();
  const runningDaemon = daemon;
  daemon = undefined;
  if (runningDaemon && runningDaemon.exitCode === null && runningDaemon.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      runningDaemon.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      runningDaemon.kill("SIGKILL");
    });
  }
  const server = modelServer;
  modelServer = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const removeOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
  await fs.rm(tmpHome, removeOptions);
  await fs.rm(tmpProject, removeOptions);
});

// ── Scenarios ───────────────────────────────────────────────────────────────

describe("plan hand-off (real daemon)", () => {
  it("autopilot off: offers the plan once the run has settled, and Accept succeeds", async () => {
    const window = await openWindow();
    await promptAndSettle(window, "PLAN_IT please");

    await waitFor(() => count(window.events, "plan_review") > 0, "plan_review");
    const exitAt = window.events.findIndex((e) => e.type === "plan_exit");
    const endAt = window.events.findIndex((e) => e.type === "run_end");
    const reviewAt = window.events.findIndex((e) => e.type === "plan_review");
    // The box opens only after the submitting run fully ended — opening at
    // plan_exit let Accept land mid-run, get refused, and strand the plan.
    expect(exitAt).toBeGreaterThanOrEqual(0);
    expect(reviewAt).toBeGreaterThan(endAt);
    const review = window.events[reviewAt]?.data;
    expect(String(review?.planPath)).toMatch(/plan\.md$/);
    expect(review?.content).toBe(PLAN);

    const accepted = await request("POST", "/plan/accept", {
      session: window.session,
      body: { planPath: review?.planPath },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.json.planTotal).toBe(2);
    // Offered once — no duplicate boxes from later settle points.
    expect(count(window.events, "plan_review")).toBe(1);
  }, 120_000);

  it("autopilot on: Ken handing the plan back opens the review box", async () => {
    const window = await openWindow();
    await setAutopilot(window.session, true);
    kenVerdicts = ["HUMAN\nThis plan needs your call on the data model."];

    await promptAndSettle(window, "PLAN_IT please");

    await waitFor(() => count(window.events, "plan_review") > 0, "plan_review after HUMAN");
    expect(kenReviews).toBeGreaterThan(0);
    const humanAt = window.events.findIndex((e) => e.type === "autopilot_human");
    const reviewAt = window.events.findIndex((e) => e.type === "plan_review");
    expect(humanAt).toBeGreaterThanOrEqual(0);
    expect(reviewAt).toBeGreaterThan(humanAt);
  }, 120_000);

  it("autopilot on: Ken approving runs the plan without ever showing the box", async () => {
    const window = await openWindow();
    await setAutopilot(window.session, true);
    kenVerdicts = ["ALL_CLEAR"];

    await promptAndSettle(window, "PLAN_IT please");

    await waitFor(() => count(window.events, "autopilot_plan_accepted") > 0, "plan accepted");
    await waitFor(() => count(window.events, "autopilot_done") > 0, "autopilot_done");
    expect(count(window.events, "plan_review")).toBe(0);
  }, 120_000);

  it("autopilot on: unverified earlier work still reaches the user with a reason", async () => {
    // Before: the cycle bailed silently on unverified work — no Ken message,
    // no box, plan pending forever.
    const window = await openWindow();
    await promptAndSettle(window, "EDIT_IT please");
    await setAutopilot(window.session, true);

    await promptAndSettle(window, "PLAN_IT please");

    await waitFor(() => count(window.events, "plan_review") > 0, "plan_review");
    const human = window.events.find((e) => e.type === "autopilot_human");
    expect(String(human?.data.reason ?? "")).not.toBe("");
    // Ken's model was never asked to approve unverified work.
    expect(kenReviews).toBe(0);
  }, 120_000);

  it("a run that stops mid-plan without submitting is reminded, and the plan reaches the user", async () => {
    // Before: the run ended in plan mode with nothing submitted — no box, and
    // Ken could only say the coder was "still drafting".
    const window = await openWindow();
    await promptAndSettle(window, "DRAFT_IT please");

    await waitFor(() => count(window.events, "plan_review") > 0, "plan_review after reminder");
    expect(count(window.events, "plan_enter")).toBe(1);
    expect(count(window.events, "plan_exit")).toBe(1);
    // One run: the reminder kept it going instead of ending mid-plan.
    expect(count(window.events, "run_end")).toBe(1);
  }, 120_000);

  it("Feedback from the review box revises the plan read-only", async () => {
    // Before: exit_plan left plan mode, so the revision run could edit code.
    const window = await openWindow();
    await promptAndSettle(window, "PLAN_IT please");
    await waitFor(() => count(window.events, "plan_review") > 0, "first plan_review");

    await promptAndSettle(window, "REVISE_IT: split step 2", { planRevision: true });

    await waitFor(() => count(window.events, "plan_review") > 1, "revised plan_review");
    expect(window.events.some((e) => e.type === "plan_mode" && e.data.active === true)).toBe(true);
    await expect(fs.access(path.join(tmpProject, SNEAKY_REL))).rejects.toThrow();
  }, 120_000);

  it("autopilot on: Ken's plan feedback is revised read-only, then handed back", async () => {
    const window = await openWindow();
    await setAutopilot(window.session, true);
    kenVerdicts = ["PROMPT\nREVISE_IT: split step 2", "HUMAN\nOver to you."];

    await promptAndSettle(window, "PLAN_IT please");

    await waitFor(() => count(window.events, "plan_review") > 0, "plan_review after revision");
    expect(count(window.events, "autopilot_prompted")).toBe(1);
    expect(window.events.some((e) => e.type === "plan_mode" && e.data.active === true)).toBe(true);
    await expect(fs.access(path.join(tmpProject, SNEAKY_REL))).rejects.toThrow();
    // The revised plan was resubmitted and reviewed again before the hand-off.
    expect(count(window.events, "plan_exit")).toBe(2);
    expect(kenReviews).toBe(2);
  }, 120_000);

  it("a reconnecting window gets the waiting plan back", async () => {
    const window = await openWindow();
    await promptAndSettle(window, "PLAN_IT please");
    await waitFor(() => count(window.events, "plan_review") > 0, "plan_review");

    // A reload opens a fresh event stream for the same session.
    const reopened = await openEventStream(window.session);
    await waitFor(() => count(reopened, "ready") > 0, "ready on reconnect");
    const ready = reopened.find((e) => e.type === "ready");
    const pending = ready?.data.pendingPlan as { planPath?: string; content?: string } | null;
    expect(String(pending?.planPath)).toMatch(/plan\.md$/);
    expect(pending?.content).toBe(PLAN);
  }, 120_000);
});
