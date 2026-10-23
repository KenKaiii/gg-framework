import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ROYALE_URL, createRoyale } from "./royale.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-royale-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

interface Call {
  url: string;
  init: RequestInit;
}

function mockServer(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const okServer = (url: string) => {
  if (url.endsWith("/api/device/register")) return json({ playerId: "p1", deviceToken: "tok" });
  if (url.endsWith("/api/device/login-code")) return json({ code: "a b", expiresAt: 1 });
  return json({ found: 1 });
};

describe("royale", () => {
  it("is unlinked by default and uses the env base without trailing slashes", async () => {
    const r = createRoyale({ agentDir: dir, version: "1", env: {} });
    expect(await r.status()).toEqual({ linked: false, serverUrl: DEFAULT_ROYALE_URL });
    const r2 = createRoyale({ agentDir: dir, version: "1", env: { GG_ROYALE_URL: "http://x//" } });
    expect((await r2.status()).serverUrl).toBe("http://x");
  });

  it("open registers, stores 0600 file, and returns a code URL", async () => {
    const { calls, fetchImpl } = mockServer(okServer);
    const r = createRoyale({
      agentDir: dir,
      version: "9.9",
      env: { GG_ROYALE_URL: "http://localhost:1/" },
      fetchImpl,
      now: () => 42,
    });
    expect(await r.open()).toEqual({ url: "http://localhost:1/#code=a%20b" });
    expect(calls[0]?.url).toBe("http://localhost:1/api/device/register");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ client: "gg-coder", version: "9.9" });
    expect(calls[1]?.init.headers).toMatchObject({ authorization: "Bearer tok" });
    const file = path.join(dir, "royale.json");
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({
      playerId: "p1",
      deviceToken: "tok",
      linkedAt: 42,
    });
    if (process.platform !== "win32") {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
    expect((await r.status()).linked).toBe(true);
    // Second open reuses the link.
    await r.open();
    expect(calls.filter((c) => c.url.endsWith("/register"))).toHaveLength(1);
    await r.unlink();
    expect((await r.status()).linked).toBe(false);
  });

  it("gives clear errors for unreachable servers and bad responses", async () => {
    const down = createRoyale({
      agentDir: dir,
      version: "1",
      env: {},
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(down.open()).rejects.toThrow(/Couldn't reach the GG Royale server/);
    const bad = createRoyale({
      agentDir: dir,
      version: "1",
      env: {},
      fetchImpl: mockServer(() => json({ nope: true })).fetchImpl,
    });
    await expect(bad.open()).rejects.toThrow(/unexpected sign-up response/);
    const err = createRoyale({
      agentDir: dir,
      version: "1",
      env: {},
      fetchImpl: mockServer(() => json({}, 500)).fetchImpl,
    });
    await expect(err.open()).rejects.toThrow(/HTTP 500/);
    expect((await err.status()).linked).toBe(false);
  });

  it("reports a deploy, and a goal once a day when its run did real work; never the goal's name", async () => {
    const { calls, fetchImpl } = mockServer(okServer);
    let clock = Date.parse("2026-10-23T10:00:00Z");
    const r = createRoyale({ agentDir: dir, version: "1", env: {}, fetchImpl, now: () => clock });
    await r.open();
    const bodies = () => calls.map((c) => JSON.parse(String(c.init.body)) as { kind: string });
    const kinds = () => bodies().map((b) => b.kind);
    const settle = () => new Promise((res) => setTimeout(res, 30));

    // A goal run that only talked (no commits, no workers): just a run.
    calls.length = 0;
    r.reportRun({ commits: 0, goalId: "goal-secret-name" });
    await settle();
    expect(kinds()).toEqual(["run"]);

    // Its first working run today counts the goal; the next doesn't.
    calls.length = 0;
    r.reportRun({ commits: 1, goalId: "goal-secret-name" });
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(kinds()).toEqual(["run", "commit", "goal"]);
    calls.length = 0;
    r.reportRun({ commits: 0, workers: true, goalId: "goal-secret-name" });
    await settle();
    expect(kinds()).toEqual(["run"]);
    // Another goal the same day still counts, and so does tomorrow (even after a restart).
    calls.length = 0;
    r.reportRun({ commits: 0, workers: true, goalId: "other-goal" });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(kinds()).toEqual(["run", "goal"]);
    clock += 24 * 3_600_000;
    const restarted = createRoyale({
      agentDir: dir,
      version: "1",
      env: {},
      fetchImpl,
      now: () => clock,
    });
    calls.length = 0;
    restarted.reportRun({ commits: 0, workers: true, goalId: "goal-secret-name" });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(kinds()).toEqual(["run", "goal"]);

    // A deploy is one more report.
    calls.length = 0;
    r.reportRun({ commits: 0, deployed: true });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(bodies()).toEqual([
      { kind: "run", count: 1, at: clock },
      { kind: "deploy", count: 1, at: clock },
    ]);

    // Nothing about the goal leaves the machine, and the day file holds only hashes.
    for (const c of calls) expect(String(c.init.body)).not.toContain("goal-secret");
    const day = await fs.readFile(path.join(dir, "royale-goals.json"), "utf8");
    expect(day).not.toContain("goal-secret");
  });

  it("reportRun sends only kind/count/at when linked, nothing otherwise, never throws", async () => {
    const { calls, fetchImpl } = mockServer(okServer);
    const r = createRoyale({ agentDir: dir, version: "1", env: {}, fetchImpl, now: () => 7 });
    r.reportRun({ commits: 3 });
    await vi.waitFor(async () => {
      await new Promise((res) => setTimeout(res, 20));
      expect(calls).toHaveLength(0);
    });
    await r.open();
    calls.length = 0;
    r.reportRun({ commits: 3 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((c) => JSON.parse(String(c.init.body)))).toEqual([
      { kind: "run", count: 1, at: 7 },
      { kind: "commit", count: 3, at: 7 },
    ]);
    calls.length = 0;
    r.reportRun({ commits: 0 });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ kind: "run", count: 1, at: 7 });

    // bug label rides only on the run report, and nothing else is added.
    calls.length = 0;
    r.reportRun({ commits: 2, bug: "type" });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((c) => JSON.parse(String(c.init.body)))).toEqual([
      { kind: "run", count: 1, at: 7, bug: "type" },
      { kind: "commit", count: 2, at: 7 },
    ]);
    calls.length = 0;
    r.reportRun({ commits: 0, bug: null });
    r.reportRun({ commits: 0, bug: "/Users/me/secret" as never });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    for (const c of calls) {
      expect(JSON.parse(String(c.init.body))).toEqual({ kind: "run", count: 1, at: 7 });
    }

    const failing = createRoyale({
      agentDir: dir,
      version: "1",
      env: {},
      fetchImpl: (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
    });
    expect(() => failing.reportRun({ commits: 1 })).not.toThrow();
    await new Promise((res) => setTimeout(res, 20));
  });

  describe("summary", () => {
    const link = () =>
      fs.writeFile(
        path.join(dir, "royale.json"),
        JSON.stringify({ playerId: "p1", deviceToken: "tok", linkedAt: 1, serverUrl: "http://x" }),
      );

    it("returns null without any network call when not linked", async () => {
      const { calls, fetchImpl } = mockServer(() => json({ claimable: 1 }));
      const r = createRoyale({ agentDir: dir, version: "1", env: {}, fetchImpl });
      expect(await r.summary()).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it("returns parsed counts with the bearer token, coercing bad numbers to 0", async () => {
      await link();
      const { calls, fetchImpl } = mockServer(() =>
        json({ claimable: 2, streak: -1, playing: 1.5 }),
      );
      const r = createRoyale({
        agentDir: dir,
        version: "1",
        env: { GG_ROYALE_URL: "http://x" },
        fetchImpl,
      });
      expect(await r.summary()).toEqual({ claimable: 2, streak: 0, playing: 0 });
      expect(calls[0]?.url).toBe("http://x/api/device/summary");
      expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
      expect(calls[0]?.init.body).toBeUndefined();
    });

    it("returns null on HTTP error, bad JSON or network failure", async () => {
      await link();
      const cases: (typeof fetch)[] = [
        mockServer(() => json({}, 401)).fetchImpl,
        mockServer(() => new Response("not json", { status: 200 })).fetchImpl,
        (async () => {
          throw new TypeError("fetch failed");
        }) as unknown as typeof fetch,
      ];
      for (const fetchImpl of cases) {
        const r = createRoyale({ agentDir: dir, version: "1", env: {}, fetchImpl });
        await expect(r.summary()).resolves.toBeNull();
      }
    });
  });

  describe("one link per server", () => {
    const save = (o: object) => fs.writeFile(path.join(dir, "royale.json"), JSON.stringify(o));

    it("never sends a device token to a different server than the one it was made with", async () => {
      await save({
        playerId: "p1",
        deviceToken: "dev-token",
        linkedAt: 1,
        serverUrl: "http://localhost:5173",
      });
      const { calls, fetchImpl } = mockServer((url) =>
        url.endsWith("/register")
          ? json({ playerId: "p2", deviceToken: "live-token" }, 201)
          : json({ code: "c0de" }, 201),
      );
      const r = createRoyale({ agentDir: dir, version: "1", env: {}, fetchImpl });
      expect((await r.status()).linked).toBe(false);
      expect(await r.summary()).toBeNull();
      r.reportRun({ commits: 1 });
      await new Promise((res) => setTimeout(res, 20));
      expect(calls).toHaveLength(0);
      // Opening links afresh with the live game; the dev token is never sent.
      const { url } = await r.open();
      expect(url).toBe(`${DEFAULT_ROYALE_URL}/#code=c0de`);
      expect(calls.every((c) => !JSON.stringify(c.init.headers ?? {}).includes("dev-token"))).toBe(
        true,
      );
      const saved = JSON.parse(await fs.readFile(path.join(dir, "royale.json"), "utf8"));
      expect(saved).toMatchObject({
        playerId: "p2",
        deviceToken: "live-token",
        serverUrl: DEFAULT_ROYALE_URL,
      });
    });

    it("links again, once, if the server no longer knows this link", async () => {
      await save({ playerId: "old", deviceToken: "gone", linkedAt: 1, serverUrl: "http://x" });
      let codes = 0;
      const { calls, fetchImpl } = mockServer((url, init) => {
        if (url.endsWith("/register")) return json({ playerId: "new", deviceToken: "fresh" }, 201);
        codes++;
        const auth = (init.headers as Record<string, string>).authorization;
        return auth === "Bearer gone"
          ? json({ error: "invalid device token" }, 401)
          : json({ code: "ok" }, 201);
      });
      const r = createRoyale({
        agentDir: dir,
        version: "1",
        env: { GG_ROYALE_URL: "http://x" },
        fetchImpl,
      });
      expect((await r.open()).url).toBe("http://x/#code=ok");
      expect(codes).toBe(2);
      expect(calls.filter((c) => c.url.endsWith("/register"))).toHaveLength(1);
    });

    it("a link saved before serverUrl was stored counts as a live-game link", async () => {
      await save({ playerId: "p1", deviceToken: "tok", linkedAt: 1 });
      const r = createRoyale({
        agentDir: dir,
        version: "1",
        env: {},
        fetchImpl: mockServer(() => json({})).fetchImpl,
      });
      expect((await r.status()).linked).toBe(true);
    });
  });
});
