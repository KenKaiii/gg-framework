import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Boots the REAL daemon and drives `/routines` over HTTP. The thing under test
 * is the glue a unit test cannot see: a routine creates its own session via the
 * daemon's `createSession`, fires through loopback `POST /prompt` (the full
 * run-claim / queue pipeline), survives a daemon restart from
 * `~/.gg/routines.json`, and fans `routines` frames out to every window.
 *
 * The provider is never reached: no auth.json, so the fired prompt's run ends
 * immediately with an error — which is fine, `runsCompleted` counts sends.
 */
const SIDECAR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "app-sidecar.js",
);
const MIN_INTERVAL = 2_000;

let tmpHome: string;
let tmpProject: string;
type Daemon = ChildProcessByStdio<null, Readable, Readable>;
let daemon: Daemon | undefined;
let port = 0;
let token = "";
const openStreams: http.IncomingMessage[] = [];

async function startDaemon(): Promise<void> {
  daemon = spawn(process.execPath, [SIDECAR], {
    cwd: tmpProject,
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      GG_APP_CWD: tmpProject,
      GG_APP_PORT: "0",
      GG_ROUTINES_MIN_INTERVAL_MS: String(MIN_INTERVAL),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stderr.on("data", (c) => {
    if (process.env.ROUTINES_DEBUG) process.stderr.write(c);
  });
  port = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`daemon never listened: ${out}`)), 60_000);
    daemon!.stdout.on("data", (chunk) => {
      out += chunk;
      const match = /GG_APP_LISTENING (\d+) (\S+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        token = match[2]!;
        resolve(Number(match[1]));
      }
    });
    daemon!.on("error", reject);
    daemon!.on("exit", (code) => reject(new Error(`daemon exited (${code}): ${out}`)));
  });
}

async function stopDaemon(): Promise<void> {
  for (const stream of openStreams.splice(0)) stream.destroy();
  const d = daemon;
  daemon = undefined;
  if (d && d.exitCode === null && d.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      d.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      d.kill("SIGTERM");
    });
  }
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
        port,
        path: urlPath,
        method,
        headers: {
          "content-type": "application/json",
          "x-gg-token": token,
          ...(opts.session ? { "x-gg-session": opts.session } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: {} });
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

interface Frame {
  type: string;
  data: unknown;
}
function openEventStream(session: string): Promise<{ frames: Frame[] }> {
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/events?session=${session}`,
        method: "GET",
        headers: { "x-gg-token": token },
      },
      (res) => {
        openStreams.push(res);
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk;
          let split = buf.indexOf("\n\n");
          while (split !== -1) {
            const frame = buf.slice(0, split);
            buf = buf.slice(split + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                frames.push(JSON.parse(line.slice(6)) as Frame);
              } catch {
                /* keepalive */
              }
            }
            split = buf.indexOf("\n\n");
          }
        });
        resolve({ frames });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitFor<T>(fn: () => T | undefined, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function createWindowSession(): Promise<string> {
  const res = await request("POST", "/session", { body: { mode: "code", cwd: tmpProject } });
  expect(res.status).toBe(200);
  return res.json.sessionId as string;
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-routines-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-routines-project-"));
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "settings.json"),
    JSON.stringify({ autoCompact: false }),
  );
  await startDaemon();
});
afterEach(async () => {
  await stopDaemon();
  if (process.env.ROUTINES_DEBUG) {
    const log = await fs
      .readFile(path.join(tmpHome, ".gg", "gg-app-sidecar.log"), "utf8")
      .catch(() => "");
    process.stderr.write(
      log
        .split("\n")
        .filter((l) => /routine|prompt|ERROR/i.test(l))
        .join("\n") + "\n",
    );
  }
  // Windows keeps the project folder locked while the killed sidecar's git children finish.
  const removeOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
  await fs.rm(tmpHome, removeOptions);
  await fs.rm(tmpProject, removeOptions);
});

describe("routines over the real daemon", () => {
  it("validates, persists, fans out to every window, fires into its own session, and can be removed", async () => {
    const win = await createWindowSession();
    const { frames } = await openEventStream(win);

    // Validation is the module's; the daemon adds "cwd must exist here".
    expect(
      (
        await request("POST", "/routines", {
          body: { prompt: "x", intervalMs: 10, cwd: tmpProject },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("POST", "/routines", {
          body: { prompt: "x", intervalMs: MIN_INTERVAL, cwd: path.join(tmpProject, "nope") },
        })
      ).status,
    ).toBe(400);

    const added = await request("POST", "/routines", {
      body: {
        prompt: "routine says hi",
        intervalMs: MIN_INTERVAL,
        runCount: 2,
        cwd: tmpProject,
        mode: "code",
      },
    });
    expect(added.status).toBe(200);
    const routine = added.json.routine as { id: string; nextRunAt: number };
    expect(routine.id).toMatch(/^rtn-/);

    // On disk, and the window heard about it without asking.
    const onDisk = JSON.parse(
      await fs.readFile(path.join(tmpHome, ".gg", "routines.json"), "utf8"),
    );
    expect(onDisk.routines.map((r: { id: string }) => r.id)).toEqual([routine.id]);
    await waitFor(() => frames.find((f) => f.type === "routines"), 2_000, "routines frame");

    // It fires: a NEW session appears bound to the routine, not the window's.
    const bound = await (async () => {
      const deadline = Date.now() + MIN_INTERVAL + 5_000;
      for (;;) {
        const r = await request("GET", "/routines");
        const sid = (r.json.sessions as Record<string, string>)[routine.id];
        if (sid) return sid;
        if (Date.now() > deadline) throw new Error("routine never fired");
        await new Promise((res) => setTimeout(res, 150));
      }
    })();
    expect(bound).not.toBe(win);
    // The routine's session is a real one: its stream answers, and it saw the prompt run.
    const { frames: rf } = await openEventStream(bound);
    await waitFor(() => rf.find((f) => f.type === "ready"), 2_000, "routine session ready");

    // The window's list shows the first run counted; after the second
    // (runCount 2) the routine drops off and the window sees the empty list.
    await waitFor(
      () => {
        const last = [...frames].reverse().find((f) => f.type === "routines");
        const list = (last?.data as { routines: { runsCompleted: number }[] } | undefined)
          ?.routines;
        return list?.[0]?.runsCompleted === 1 ? true : undefined;
      },
      2_000,
      "first run counted",
    );
    await waitFor(
      () => {
        const last = [...frames].reverse().find((f) => f.type === "routines");
        const list = (last?.data as { routines: unknown[] } | undefined)?.routines;
        return list && list.length === 0 ? true : undefined;
      },
      MIN_INTERVAL + 5_000,
      "routine to complete and drop",
    );
    // Its session lives on (context for a later look) until removed/shutdown,
    // and the second prompt visibly ran on it (the stream opened after the first).
    expect((await request("GET", "/state", { session: bound })).status).toBe(200);
    expect(rf.some((f) => f.type === "run_start")).toBe(true);
  });

  it("survives a daemon restart and honours the persisted nextRunAt", async () => {
    const added = await request("POST", "/routines", {
      body: { prompt: "after restart", intervalMs: MIN_INTERVAL, runCount: null, cwd: tmpProject },
    });
    const routine = added.json.routine as { id: string; nextRunAt: number };
    await stopDaemon();
    await startDaemon();
    const listed = await request("GET", "/routines");
    expect(
      (listed.json.routines as { id: string; nextRunAt: number }[]).map((r) => [r.id, r.nextRunAt]),
    ).toEqual([[routine.id, routine.nextRunAt]]);
    const bound = await (async () => {
      const deadline = Date.now() + MIN_INTERVAL + 5_000;
      for (;;) {
        const r = await request("GET", "/routines");
        const sid = (r.json.sessions as Record<string, string>)[routine.id];
        if (sid) return sid;
        if (Date.now() > deadline) throw new Error("routine never fired after restart");
        await new Promise((res) => setTimeout(res, 150));
      }
    })();
    expect(bound).toBeTruthy();
    // DELETE stops it and disposes the session.
    expect((await request("DELETE", `/routines/${routine.id}`)).status).toBe(200);
    expect((await request("DELETE", `/routines/${routine.id}`)).status).toBe(404);
    expect((await request("GET", "/state", { session: bound })).status).toBe(404);
    expect((await request("GET", "/routines")).json.routines).toEqual([]);
  });
});
