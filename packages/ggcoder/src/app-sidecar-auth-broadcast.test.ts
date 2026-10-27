import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realpathNative } from "./utils/git.js";

/**
 * Boots the REAL app sidecar daemon and drives it over HTTP, because the bug
 * being covered is cross-session: connecting a provider in one window has to
 * refresh the model picker in every window. A per-session unit test cannot see
 * that — the whole failure lives in which SSE streams receive the frame.
 */
const SIDECAR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "app-sidecar.js",
);

let tmpHome: string;
let tmpProject: string;
type Daemon = ChildProcessByStdio<null, Readable, Readable>;
let daemon: Daemon | undefined;
let port = 0;
let token = "";
const openStreams: http.IncomingMessage[] = [];

/** Start the daemon on an ephemeral port and wait for its listening handshake. */
async function startDaemon(): Promise<void> {
  daemon = spawn(process.execPath, [SIDECAR], {
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

  port = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`daemon never listened: ${out}`)), 60_000);
    daemon!.stdout.on("data", (chunk) => {
      out += chunk;
      const match = /GG_APP_LISTENING (\d+) (\S+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        token = match[2];
        resolve(Number(match[1]));
      }
    });
    daemon!.on("error", reject);
    daemon!.on("exit", (code) => reject(new Error(`daemon exited (${code}): ${out}`)));
  });
}

function request(
  method: string,
  urlPath: string,
  opts: { session?: string; body?: unknown; token?: string; host?: string } = {},
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
          ...(payload ? { "content-type": "application/json" } : {}),
          ...(opts.session ? { "x-gg-session": opts.session } : {}),
          // Default to the real token; pass token: "" to exercise the 401 path.
          ...(opts.token !== undefined
            ? opts.token
              ? { "x-gg-token": opts.token }
              : {}
            : { "x-gg-token": token }),
          ...(opts.host ? { host: opts.host } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
        });
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

/** Open a window's SSE stream and collect the events it receives. */
function openEventStream(
  session: string,
): Promise<{ types: string[]; frames: { type: string; data?: Record<string, unknown> }[] }> {
  return new Promise((resolve, reject) => {
    const types: string[] = [];
    const frames: { type: string; data?: Record<string, unknown> }[] = [];
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
                const parsed = JSON.parse(line.slice(6)) as {
                  type: string;
                  data?: Record<string, unknown>;
                };
                types.push(parsed.type);
                frames.push(parsed);
              } catch {
                // Non-JSON keepalives are not events.
              }
            }
            split = buf.indexOf("\n\n");
          }
        });
        resolve({ types, frames });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function createSession(): Promise<string> {
  const res = await request("POST", "/session", {
    body: { mode: "code", cwd: tmpProject },
  });
  expect(res.status).toBe(200);
  return res.json.sessionId as string;
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-models-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-models-project-"));
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  // No auth.json: the daemon is boot-tolerant when logged out, which is exactly
  // the state a user is in right before they connect their first provider.
  await fs.writeFile(
    path.join(tmpHome, ".gg", "settings.json"),
    JSON.stringify({ autoCompact: false }),
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
  const removeOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
  await fs.rm(tmpHome, removeOptions);
  await fs.rm(tmpProject, removeOptions);
});

describe("loopback daemon auth", () => {
  it("rejects requests without the per-launch token", async () => {
    const res = await request("POST", "/session", {
      body: { mode: "code", cwd: tmpProject },
      token: "",
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with a wrong token", async () => {
    const res = await request("GET", "/progress", { token: "not-the-token" });
    expect(res.status).toBe(401);
  });

  it("rejects requests with a non-loopback Host (DNS rebinding)", async () => {
    const res = await request("GET", "/progress", { host: "attacker.example" });
    expect(res.status).toBe(403);
  });
});

describe("a goal window reconnecting", () => {
  it("keeps the goal in the ready frame, as in GET /state", async () => {
    // Live bug: after a daemon restart the app swaps its state for the events
    // stream's "ready" frame, which had no `goal`, so a goal window turned
    // into a plain project screen.
    const goalDir = path.join(tmpHome, ".gg", "goals", "speed");
    await fs.mkdir(goalDir, { recursive: true });
    await fs.writeFile(
      path.join(goalDir, "goal.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "speed",
        name: "Speed",
        goal: "Make it fast",
        context: [],
        createdAt: "2026-10-11T00:00:00.000Z",
      }),
    );
    const created = await request("POST", "/session", { body: { mode: "code", cwd: goalDir } });
    expect(created.status).toBe(200);
    const session = created.json.sessionId as string;
    // The app also keeps the conversation file, to reopen it after a restart.
    expect(typeof created.json.sessionPath).toBe("string");

    const stream = await openEventStream(session);
    await waitFor(() => stream.types.includes("ready"));
    const ready = stream.frames.find((frame) => frame.type === "ready");
    expect(ready?.data?.goal).toMatchObject({ id: "speed", name: "Speed" });
    // And the questions it can still answer, so stale cards from a dead run close.
    expect(ready?.data?.openAsks).toEqual([]);
    const state = await request("GET", "/state", { session });
    expect(state.json.goal).toMatchObject({ id: "speed", name: "Speed" });
  });

  it("shows the attached project's uncommitted files, not the goal folder's", async () => {
    // Live bug: the goal window read git from its own folder under
    // ~/.gg/goals, so the titlebar never showed what the agent had changed.
    const project = path.join(tmpHome, "site");
    await fs.mkdir(project, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: project });
    await fs.writeFile(path.join(project, "a.txt"), "changed by the agent\n");
    await fs.writeFile(path.join(project, "b.txt"), "and this\n");
    const goalDir = path.join(tmpHome, ".gg", "goals", "site-speed");
    await fs.mkdir(goalDir, { recursive: true });
    await fs.writeFile(
      path.join(goalDir, "goal.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "site-speed",
        name: "Site speed",
        goal: "Make it fast",
        context: [{ path: project, kind: "folder" }],
        createdAt: "2026-10-11T00:00:00.000Z",
      }),
    );
    const created = await request("POST", "/session", { body: { mode: "code", cwd: goalDir } });
    expect(created.status).toBe(200);
    // A busy machine can make the first git read miss its 2 s limit; the
    // sidecar then re-reads in the background, so poll briefly for the result.
    const sessionId = created.json.sessionId as string;
    let state = await request("GET", "/state", { session: sessionId });
    for (let i = 0; i < 40 && state.json.isGitRepo !== true; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      state = await request("GET", "/state", { session: sessionId });
    }
    expect(state.json.isGitRepo).toBe(true);
    expect(state.json.gitDirtyFileCount).toBe(2);
  });
});

describe("two windows on one checkout", () => {
  it("both follow a branch switch made outside the app", async () => {
    // Live bug: windows on the same folder share one checkout, and a switch in
    // one left the other showing (and its agent assuming) the old branch until
    // its own next run ended.
    const repo = path.join(tmpHome, "shared");
    await fs.mkdir(repo, { recursive: true });
    const g = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=T",
          "-c",
          "user.email=t@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: repo, stdio: "ignore" },
      );
    g("init", "-q", "-b", "main");
    await fs.writeFile(path.join(repo, "a.txt"), "a\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    const a = await request("POST", "/session", { body: { mode: "code", cwd: repo } });
    const b = await request("POST", "/session", { body: { mode: "code", cwd: repo } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const branchOf = async (session: string) =>
      (await request("GET", "/state", { session })).json.gitBranch as string | null;
    const waitFor = async (session: string, branch: string) => {
      for (let i = 0; i < 60; i++) {
        if ((await branchOf(session)) === branch) return branch;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return branchOf(session);
    };
    expect(await waitFor(b.json.sessionId as string, "main")).toBe("main");

    g("switch", "-q", "-c", "feature");

    expect(await waitFor(a.json.sessionId as string, "feature")).toBe("feature");
    expect(await waitFor(b.json.sessionId as string, "feature")).toBe("feature");
  }, 30_000);

  it("reopens a conversation on the branch it picked, even after the folder moved on", async () => {
    const running = daemon;
    daemon = undefined;
    await new Promise<void>((resolve) => {
      running?.once("close", () => resolve());
      running?.kill("SIGKILL");
    });
    await fs.writeFile(
      path.join(tmpHome, ".gg", "auth.json"),
      JSON.stringify({
        anthropic: {
          accessToken: "fake",
          refreshToken: "fake",
          expiresAt: Date.now() + 86_400_000,
        },
      }),
    );
    await startDaemon();
    const repo = path.join(tmpHome, "keep");
    await fs.mkdir(repo, { recursive: true });
    const g = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=T",
          "-c",
          "user.email=t@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: repo, encoding: "utf8" },
      );
    g("init", "-q", "-b", "develop");
    await fs.writeFile(path.join(repo, "a.txt"), "a\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");

    // One window, alone on the folder: the pick switches it in place.
    const a = await request("POST", "/session", { body: { mode: "code", cwd: repo } });
    const conversation = a.json.sessionPath;
    expect(typeof conversation).toBe("string");
    const picked = await request("POST", "/git/branch", {
      session: a.json.sessionId as string,
      body: { branch: "feature/y", create: true },
    });
    expect(picked.json).toMatchObject({ kind: "switched", branch: "feature/y" });
    await request("DELETE", `/session/${a.json.sessionId as string}`);

    // Later the folder is back on develop (a terminal, another project window).
    g("switch", "-q", "develop");

    const resumed = await request("POST", "/session", {
      body: { mode: "code", cwd: repo, sessionPath: conversation },
    });
    expect(resumed.json.error ?? null).toBeNull();
    const state = await request("GET", "/state", { session: resumed.json.sessionId as string });
    expect(state.json.gitBranch).toBe("feature/y");
    expect(resumed.json.cwd).not.toBe(repo);
    expect(g("branch", "--show-current").trim()).toBe("develop");
    // The chat shows why it opened there, and keeps showing it on restore.
    const history = await request("GET", "/history", { session: resumed.json.sessionId as string });
    expect(JSON.stringify(history.json)).toContain(
      "Opened on branch feature/y in its own worktree, because the project folder is on develop now.",
    );

    // Reopening again lands in the same place, not a second worktree.
    await request("DELETE", `/session/${resumed.json.sessionId as string}`);
    const again = await request("POST", "/session", {
      body: { mode: "code", cwd: repo, sessionPath: conversation },
    });
    expect(again.json.cwd).toBe(resumed.json.cwd);
  }, 40_000);

  it("moves only the picking window onto a new branch, in its own worktree", async () => {
    // A branch picked in one window must not move the others on the same folder.
    // Resuming a conversation needs a login, as it does for every real user.
    const running = daemon;
    daemon = undefined;
    await new Promise<void>((resolve) => {
      running?.once("close", () => resolve());
      running?.kill("SIGKILL");
    });
    await fs.writeFile(
      path.join(tmpHome, ".gg", "auth.json"),
      JSON.stringify({
        anthropic: {
          accessToken: "fake",
          refreshToken: "fake",
          expiresAt: Date.now() + 86_400_000,
        },
      }),
    );
    await startDaemon();
    const repo = path.join(tmpHome, "picker");
    await fs.mkdir(repo, { recursive: true });
    const g = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=T",
          "-c",
          "user.email=t@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: repo, encoding: "utf8" },
      );
    g("init", "-q", "-b", "develop");
    await fs.writeFile(path.join(repo, ".gitignore"), ".env\n");
    await fs.writeFile(path.join(repo, ".env"), "TOKEN=x\n");
    await fs.writeFile(path.join(repo, "a.txt"), "a\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    const a = await request("POST", "/session", { body: { mode: "code", cwd: repo } });
    const b = await request("POST", "/session", { body: { mode: "code", cwd: repo } });
    const sessionA = a.json.sessionId as string;

    const listed = await request("GET", "/git/branches", { session: sessionA });
    expect(listed.status).toBe(200);
    expect(listed.json.current).toBe("develop");
    expect(listed.json.sharedWith).toBe("1 other open GG Coder window");

    const picked = await request("POST", "/git/branch", {
      session: sessionA,
      body: { branch: "feature/x", create: true },
    });
    expect(picked.status).toBe(200);
    expect(picked.json.kind).toBe("moved");
    const tree = picked.json.path as string;
    expect(tree.startsWith(await realpathNative(path.join(tmpHome, ".gg", "worktrees")))).toBe(
      true,
    );
    // The shared folder (and window B on it) stays on its branch.
    expect(g("branch", "--show-current").trim()).toBe("develop");
    expect(
      (await request("GET", "/state", { session: b.json.sessionId as string })).json.gitBranch,
    ).toBe("develop");
    expect(await fs.readFile(path.join(tree, ".env"), "utf8")).toBe("TOKEN=x\n");

    // Home lists the worktree under the project; its folder is a GG one.
    const trees = await request("GET", `/git/worktrees?cwd=${encodeURIComponent(repo)}`, {
      session: sessionA,
    });
    expect(trees.json.worktrees).toEqual([
      expect.objectContaining({ path: tree, branch: "feature/x", managed: true, dirty: 0 }),
    ]);

    // Window A re-opens in the worktree, on the new branch.
    const moved = await request("POST", "/session", {
      body: { mode: "code", cwd: tree, sessionPath: picked.json.sessionPath ?? undefined },
    });
    expect(moved.json.error ?? null).toBeNull();
    const state = await request("GET", "/state", { session: moved.json.sessionId as string });
    expect(state.json.gitBranch).toBe("feature/x");
    // Home opens on the project, not the worktree folder.
    expect(state.json.worktreeOf).toBe(await realpathNative(repo));

    // It can't be removed while a window is open in it; after closing, it can.
    const blocked = await request("POST", "/git/worktrees/remove", {
      session: b.json.sessionId as string,
      body: { cwd: repo, path: tree },
    });
    expect(blocked.status).toBe(409);
    await request("DELETE", `/session/${moved.json.sessionId as string}`);
    const removed = await request("POST", "/git/worktrees/remove", {
      session: b.json.sessionId as string,
      body: { cwd: repo, path: tree },
    });
    expect(removed.json).toEqual({ ok: true });
    expect(existsSync(tree)).toBe(false);
    expect(g("branch", "--list", "feature/x").trim()).toBe("feature/x");

    // "Switch here" moves the shared folder for everyone, on request only.
    const here = await request("POST", "/git/branch", {
      session: b.json.sessionId as string,
      body: { branch: "feature/x", create: false, placement: "here" },
    });
    expect(here.json).toMatchObject({ kind: "switched", branch: "feature/x" });
    expect(g("branch", "--show-current").trim()).toBe("feature/x");
  }, 40_000);
});

describe("a window whose saved conversation is gone", () => {
  it("opens a fresh session instead of failing", async () => {
    // Live bug: after a restart the app asked to resume a deleted session
    // file; the create failed and the window had no session, so even its
    // goal list said "Couldn't load your goals".
    const gone = path.join(tmpHome, ".gg", "sessions", "deleted", "2026-10-11T00-00-00_gone.jsonl");
    const created = await request("POST", "/session", {
      body: { mode: "code", cwd: tmpProject, sessionPath: gone },
    });
    expect(created.status).toBe(200);
    expect(typeof created.json.sessionId).toBe("string");
    expect(created.json.sessionPath).not.toBe(gone);
  });
});

describe("a model that spends real money", () => {
  /** Restart the daemon logged in to Anthropic, with fast mode saved as the default. */
  async function restartWithSavedPaidModel(): Promise<void> {
    const running = daemon;
    daemon = undefined;
    if (running && running.exitCode === null && running.signalCode === null) {
      await new Promise<void>((resolve) => {
        running.once("close", () => resolve());
        running.kill("SIGKILL");
      });
    }
    await fs.writeFile(
      path.join(tmpHome, ".gg", "auth.json"),
      JSON.stringify({
        anthropic: {
          accessToken: "sk-ant-oat-fake-for-tests",
          refreshToken: "fake-refresh",
          expiresAt: Date.now() + 86_400_000,
        },
      }),
    );
    await fs.writeFile(
      path.join(tmpHome, ".gg", "settings.json"),
      JSON.stringify({
        autoCompact: false,
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-5-5-fast",
      }),
    );
    await startDaemon();
  }

  it("never restores, follows into, or switches to it without explicit confirmation", async () => {
    await restartWithSavedPaidModel();
    const session = await createSession();

    // A saved paid default boots the standard model instead.
    const boot = await request("GET", "/state", { session });
    expect(boot.json.model).toBe("claude-opus-5-5");

    // Switching without the user's confirmation is refused, and nothing changes.
    const refused = await request("POST", "/model", {
      session,
      body: { model: "claude-opus-5-5-fast" },
    });
    expect(refused.status).toBe(409);
    expect(refused.json.requiresPaidConfirmation).toBe(true);
    expect((await request("GET", "/state", { session })).json.model).toBe("claude-opus-5-5");

    // With confirmation it switches, but only this session: Ken stays on the
    // standard model and the saved default is never the paid tier.
    const confirmed = await request("POST", "/model", {
      session,
      body: { model: "claude-opus-5-5-fast", confirmPaid: true },
    });
    expect(confirmed.status).toBe(200);
    const after = await request("GET", "/state", { session });
    expect(after.json.model).toBe("claude-opus-5-5-fast");
    expect(after.json.kenModel).toBe("claude-opus-5-5");
    const saved = JSON.parse(
      await fs.readFile(path.join(tmpHome, ".gg", "settings.json"), "utf-8"),
    ) as { defaultModel?: string };
    expect(saved.defaultModel).toBe("claude-opus-5-5");

    // Ken can't be pinned to it either.
    const kenPin = await request("POST", "/ken/model", {
      session,
      body: { model: "claude-opus-5-5-fast" },
    });
    expect(kenPin.status).toBe(400);
  }, 120_000);
});

describe("connecting a provider", () => {
  it("refreshes models in every window, not just the one that connected", async () => {
    const windowA = await createSession();
    const windowB = await createSession();
    const streamA = await openEventStream(windowA);
    const streamB = await openEventStream(windowB);

    // Logged out: no cloud provider's models are offered yet. Local providers
    // (Ollama, LM Studio) need no auth and may already be running on this
    // machine, so exclude them — the assertion is about auth-gated models only.
    const before = await request("GET", "/models", { session: windowA });
    const beforeCloud = (before.json.models as { local?: boolean }[]).filter((m) => !m.local);
    expect(beforeCloud).toEqual([]);

    // Connect a provider from window A only.
    const connect = await request("POST", "/auth/apikey", {
      session: windowA,
      body: { provider: "xai", key: "sk-test-key" },
    });
    expect(connect.status).toBe(200);

    // Both windows must be told, because ~/.gg/auth.json is shared. Without the
    // fan-out, window B's picker stayed stale until the session was reopened.
    await waitFor(() => streamA.types.includes("models_change"));
    await waitFor(() => streamB.types.includes("models_change"));

    // And the refetch each window now performs actually returns the new models.
    const after = await request("GET", "/models", { session: windowB });
    const cloudModels = (after.json.models as { provider: string; local?: boolean }[]).filter(
      (m) => !m.local,
    );
    expect(cloudModels.length).toBeGreaterThan(0);
    expect(cloudModels.every((m) => m.provider === "xai")).toBe(true);
  }, 90_000);

  it("closes the login modal in every window via auth_done", async () => {
    const windowA = await createSession();
    const windowB = await createSession();
    const streamA = await openEventStream(windowA);
    const streamB = await openEventStream(windowB);

    await request("POST", "/auth/apikey", {
      session: windowA,
      body: { provider: "xai", key: "sk-test-key" },
    });

    // auth_done closes the modal; auth_change refreshes the connection dots.
    // A second window sitting on the login screen needs both.
    await waitFor(() => streamA.types.includes("auth_done"));
    await waitFor(() => streamB.types.includes("auth_done"));
    await waitFor(() => streamA.types.includes("auth_change"));
    await waitFor(() => streamB.types.includes("auth_change"));
  }, 90_000);
});

describe("OAuth login across windows", () => {
  /** Park an Anthropic OAuth flow at its "paste the code" step in one window. */
  async function startParkedLogin(session: string): Promise<{ types: string[] }> {
    const stream = await openEventStream(session);
    const started = await request("POST", "/auth/oauth/start", {
      session,
      body: { provider: "anthropic" },
    });
    expect(started.status).toBe(202);
    // The flow opens a browser URL, then blocks on the pasted code.
    await waitFor(() => stream.types.includes("auth_need_code"));
    return stream;
  }

  it("keeps login progress in the window that started it", async () => {
    const windowA = await createSession();
    const windowB = await createSession();
    const streamB = await openEventStream(windowB);
    const streamA = await startParkedLogin(windowA);

    expect(streamA.types).toContain("auth_url");
    expect(streamA.types).toContain("auth_need_code");
    // Window B never pressed Connect — opening its browser or prompting it for
    // a code it does not have would be nonsense. Progress stays scoped.
    expect(streamB.types).not.toContain("auth_url");
    expect(streamB.types).not.toContain("auth_need_code");
  }, 90_000);

  it("refuses a second window's login for the same provider", async () => {
    const windowA = await createSession();
    const windowB = await createSession();
    await startParkedLogin(windowA);

    // Two flows for one provider means two browser tabs and two token
    // exchanges racing to write the same auth.json entry. The per-session
    // guard cannot see across windows; the daemon-wide one must.
    const second = await request("POST", "/auth/oauth/start", {
      session: windowB,
      body: { provider: "anthropic" },
    });
    expect(second.status).toBe(409);
    expect(String(second.json.error)).toContain("another window");
  }, 90_000);

  it("allows a different provider to log in concurrently", async () => {
    const windowA = await createSession();
    const windowB = await createSession();
    await startParkedLogin(windowA);

    // The guard is per provider, not a global lock: connecting Anthropic in
    // one window must not block connecting OpenAI in another.
    const other = await request("POST", "/auth/oauth/start", {
      session: windowB,
      body: { provider: "openai" },
    });
    expect(other.status).toBe(202);
  }, 90_000);

  it("reports a failed login only to the window that attempted it", async () => {
    const windowA = await createSession();
    const windowB = await createSession();
    const streamB = await openEventStream(windowB);
    const streamA = await startParkedLogin(windowA);

    // A malformed code fails the state check locally — no network needed.
    const sent = await request("POST", "/auth/oauth/code", {
      session: windowA,
      body: { code: "bogus#mismatch" },
    });
    expect(sent.status).toBe(200);
    await waitFor(() => streamA.types.includes("auth_error"));

    // Window B attempted nothing, so it has no failure to report. Its modal
    // correctly still offers to connect.
    expect(streamB.types).not.toContain("auth_error");
  }, 90_000);

  it("frees the provider again after a failed login", async () => {
    const windowA = await createSession();
    const windowB = await createSession();
    const streamA = await startParkedLogin(windowA);

    await request("POST", "/auth/oauth/code", {
      session: windowA,
      body: { code: "bogus#mismatch" },
    });
    await waitFor(() => streamA.types.includes("auth_error"));

    // A failed attempt must release the daemon-wide guard, or the provider
    // would be permanently unloggable until the app restarts.
    const retry = await request("POST", "/auth/oauth/start", {
      session: windowB,
      body: { provider: "anthropic" },
    });
    expect(retry.status).toBe(202);
  }, 90_000);
});

/**
 * Providers that accept subscription OAuth AND an API key (Kimi, Grok) hold two
 * independent credentials. The app renders a per-method comparison and per-method
 * disconnect from this payload, so a single "connected" bit is not enough.
 */
describe("dual-auth providers (OAuth + API key)", () => {
  async function providerStatus(session: string, value: string): Promise<Record<string, unknown>> {
    const res = await request("GET", "/auth/status", { session });
    expect(res.status).toBe(200);
    const providers = res.json.providers as Record<string, unknown>[];
    const found = providers.find((p) => p.value === value);
    expect(found).toBeDefined();
    return found!;
  }

  it("offers Grok both methods, with guidance and the priority rule", async () => {
    const session = await createSession();
    const xai = await providerStatus(session, "xai");

    expect(xai.methods).toEqual(["oauth", "apikey"]);
    expect(xai.connected).toBe(false);
    expect(xai.connectedMethods).toEqual([]);
    // The UI cannot invent this copy — the choice changes what the user is billed.
    const guidance = xai.methodGuidance as { method: string; billing: string }[];
    expect(guidance.map((g) => g.method)).toEqual(["oauth", "apikey"]);
    expect(String(xai.priorityNote)).toMatch(/first/i);
  }, 90_000);

  it("reports which method is connected and which one requests will use", async () => {
    const session = await createSession();
    await request("POST", "/auth/apikey", {
      session,
      body: { provider: "xai", key: "xai-test-key" },
    });

    const xai = await providerStatus(session, "xai");
    expect(xai.connected).toBe(true);
    // Key only: it is both connected and active, and OAuth is still on offer.
    expect(xai.connectedMethods).toEqual(["apikey"]);
    expect(xai.activeMethod).toBe("apikey");
    expect(xai.oauthExhaustedUntil).toBeUndefined();
  }, 90_000);

  it("disconnects one method without dropping the other", async () => {
    const session = await createSession();
    // Write both credentials directly: an OAuth login needs a real browser, and
    // what matters here is the two-credential state the app has to manage.
    await fs.writeFile(
      path.join(tmpHome, ".gg", "auth.json"),
      JSON.stringify({
        xai: { accessToken: "key", refreshToken: "", expiresAt: Date.now() + 1_000_000 },
        "xai-oauth": {
          accessToken: "oauth",
          refreshToken: "r",
          expiresAt: Date.now() + 1_000_000,
          baseUrl: "https://cli-chat-proxy.grok.com/v1",
        },
      }),
    );

    const both = await providerStatus(session, "xai");
    expect(both.connectedMethods).toEqual(["oauth", "apikey"]);
    // Both on file → the subscription is what actually gets used.
    expect(both.activeMethod).toBe("oauth");

    // Dropping a spent API key must not sign the user out of the subscription.
    const out = await request("POST", "/auth/logout", {
      session,
      body: { provider: "xai", method: "apikey" },
    });
    expect(out.status).toBe(200);

    const after = await providerStatus(session, "xai");
    expect(after.connectedMethods).toEqual(["oauth"]);
    expect(after.connected).toBe(true);
  }, 90_000);

  // Gemini is hidden (gg-core hidden-providers.ts): Google no longer serves
  // personal accounts over sign-in. Restore the dual-method test from git
  // history ("adds a Gemini API key beside the Google sign-in") when un-hiding.
  it("hides Gemini from the provider list and the model picker, even with a login on disk", async () => {
    const session = await createSession();
    await fs.writeFile(
      path.join(tmpHome, ".gg", "auth.json"),
      JSON.stringify({
        gemini: { accessToken: "oauth", refreshToken: "r", expiresAt: Date.now() + 1_000_000 },
        "gemini-api": { accessToken: "k", refreshToken: "", expiresAt: Date.now() + 1_000_000 },
      }),
    );
    const status = await request("GET", "/auth/status", { session });
    expect(status.status).toBe(200);
    const values = (status.json.providers as { value: string }[]).map((p) => p.value);
    expect(values).not.toContain("gemini");
    expect(values).toContain("xai");

    const models = await request("GET", "/models", { session });
    const providers = (models.json.models as { provider: string }[]).map((m) => m.provider);
    expect(providers).not.toContain("gemini");
  }, 90_000);
});
