import { Readable } from "node:stream";
import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRouteContext } from "./route-context.js";
import {
  STDERR_END,
  STDERR_START,
  ShellRunner,
  formatShellContext,
  reopenStderr,
  parseShellRunBody,
  tailOutput,
  userShellEnv,
  userShellLaunch,
  type ShellRunEnd,
} from "./shell-runs.js";

const trusted = vi.hoisted(() => ({ value: false }));
vi.mock("./app-settings.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadShellTrusted: vi.fn(async () => trusted.value),
}));
const { handleShellRoutes } = await import("./shell-routes.js");

afterEach(() => {
  trusted.value = false;
});

function post(
  ctx: SessionRouteContext,
  url: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        return this;
      },
      end(payload: string) {
        resolve({ status, body: JSON.parse(payload) as Record<string, unknown> });
      },
    };
    const req = Readable.from([
      Buffer.from(JSON.stringify(body)),
    ]) as unknown as http.IncomingMessage;
    handleShellRoutes(ctx, req, res as unknown as http.ServerResponse, url, "POST");
  });
}

function routeCtx(start = vi.fn(() => ({ ok: true as const }))): {
  ctx: SessionRouteContext;
  start: typeof start;
} {
  const ctx = { mode: "code", cwd: "/p", shell: { start } } as unknown as SessionRouteContext;
  return { ctx, start };
}

describe("POST /shell/run", () => {
  it("refuses a command the user hasn't confirmed in an untrusted project", async () => {
    const { ctx, start } = routeCtx();
    const reply = await post(ctx, "/shell/run", { id: "r1", command: "rm -rf build" });
    expect(reply).toEqual({ status: 403, body: { error: "confirmation_required" } });
    expect(start).not.toHaveBeenCalled();
  });

  it("runs a confirmed command, or any command in a trusted project", async () => {
    const { ctx, start } = routeCtx();
    expect(
      (await post(ctx, "/shell/run", { id: "r1", command: "ls", confirmed: true })).status,
    ).toBe(202);
    trusted.value = true;
    expect((await post(ctx, "/shell/run", { id: "r2", command: "pwd" })).status).toBe(202);
    expect(start.mock.calls).toEqual([
      ["r1", "ls", "/p"],
      ["r2", "pwd", "/p"],
    ]);
  });

  it("only runs in code mode", async () => {
    const { ctx, start } = routeCtx();
    (ctx as { mode: string }).mode = "chat";
    const reply = await post(ctx, "/shell/run", { id: "r1", command: "ls", confirmed: true });
    expect(reply.status).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("parseShellRunBody", () => {
  it("validates the run id and command", () => {
    expect(parseShellRunBody('{"id":"a-1","command":" ls "}')).toEqual({
      ok: true,
      runId: "a-1",
      command: "ls",
      confirmed: false,
    });
    expect(parseShellRunBody('{"id":"../x","command":"ls"}').ok).toBe(false);
    expect(parseShellRunBody('{"id":"a","command":"   "}').ok).toBe(false);
    expect(parseShellRunBody("nope").ok).toBe(false);
  });
});

describe("output for the agent", () => {
  it("keeps the last lines and says when it cut", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
    const tail = tailOutput(text, 200, 100_000);
    expect(tail.truncated).toBe(true);
    expect(tail.text.split("\n")).toHaveLength(200);
    expect(tail.text.startsWith("line 101\n")).toBe(true);
    expect(tailOutput("a\nb\n")).toEqual({ text: "a\nb", truncated: false });
  });

  it("states the command, folder and result", () => {
    const run: ShellRunEnd = {
      runId: "r",
      command: "pnpm test",
      cwd: "/p",
      exitCode: 1,
      signal: null,
      durationMs: 4200,
      cancelled: false,
      tail: "2 failed",
      displayTail: "2 failed",
      tailTruncated: false,
      displayTruncated: false,
    };
    expect(formatShellContext(run)).toBe("$ pnpm test\n(in /p, exit code 1, 4.2s)\n2 failed");
    expect(formatShellContext({ ...run, cancelled: true, tail: "" })).toContain(
      "stopped by the user before it finished",
    );
  });
});

describe("reopenStderr", () => {
  it("reopens error output a cut started inside", () => {
    expect(reopenStderr(`tail of err${STDERR_END}\nok`)).toBe(
      `${STDERR_START}tail of err${STDERR_END}\nok`,
    );
    expect(reopenStderr(`ok\n${STDERR_START}err${STDERR_END}`)).toBe(
      `ok\n${STDERR_START}err${STDERR_END}`,
    );
  });
});

describe("the user's shell", () => {
  it("keeps the app's private daemon variables out", () => {
    const env = userShellEnv({ PATH: "/bin", GG_APP_TOKEN: "secret", HOME: "/h" });
    expect(env.GG_APP_TOKEN).toBeUndefined();
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", TERM: "dumb" });
  });

  it("uses the login shell where there is one", () => {
    expect(userShellLaunch("ls", { platform: "darwin", env: { SHELL: "/bin/zsh" } })).toEqual({
      file: "/bin/zsh",
      args: ["-c", "ls"],
    });
  });
});

function runOnce(command: string, opts: { cancelAfterMs?: number } = {}) {
  const chunks: string[] = [];
  return new Promise<{ end: ShellRunEnd; chunks: string[] }>((resolve, reject) => {
    const runner = new ShellRunner({
      emit: (type, data) => {
        if (type === "shell_output") chunks.push((data as { chunk: string }).chunk);
      },
      onEnd: (end) => resolve({ end, chunks }),
    });
    const started = runner.start("r1", command, process.cwd());
    if (!started.ok) reject(new Error(started.error));
    if (opts.cancelAfterMs !== undefined) {
      setTimeout(() => runner.cancel("r1"), opts.cancelAfterMs);
    }
  });
}

describe("ShellRunner", () => {
  it("streams output and reports the exit code", async () => {
    const { end, chunks } = await runOnce("echo hello && echo oops 1>&2 && exit 3");
    expect(end.exitCode).toBe(3);
    expect(end.cancelled).toBe(false);
    expect(chunks.join("")).toContain("hello");
    expect(end.tail).toContain("hello");
    expect(end.tail).toContain("oops");
  }, 20_000);

  it("marks error output for the window but keeps the agent's copy plain", async () => {
    const { end, chunks } = await runOnce("echo out; echo bad 1>&2");
    expect(chunks.join("")).toContain(`${STDERR_START}bad\n${STDERR_END}`);
    expect(end.displayTail).toContain(`${STDERR_START}bad`);
    expect(end.tail).toBe("out\nbad");
  }, 20_000);

  it("stops a command when asked", async () => {
    const { end } = await runOnce("sleep 30", { cancelAfterMs: 300 });
    expect(end.cancelled).toBe(true);
    expect(end.durationMs).toBeLessThan(15_000);
  }, 20_000);
});
