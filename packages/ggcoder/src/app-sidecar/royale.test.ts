import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORLD_URL, LEGACY_ROYALE_URL, createWorldLink } from "./royale.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-world-link-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

interface Call {
  url: string;
  init: RequestInit;
}

function mockServer(handler: (url: string, init: RequestInit) => Response) {
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

const okServer = (url: string) =>
  url.endsWith("/api/world/device/register")
    ? json({ playerId: "new", deviceToken: "newtok" }, 201)
    : json({ ver: 1 });

const file = () => path.join(dir, "royale.json");
const auth = (c: Call | undefined) =>
  (c?.init.headers as Record<string, string> | undefined)?.authorization;

async function saveLink(serverUrl: string | undefined) {
  await fs.writeFile(
    file(),
    JSON.stringify({ playerId: "old", deviceToken: "oldtok", linkedAt: 1, serverUrl }),
  );
}

describe("world link", () => {
  it("signs up with gg-world on first use and stores a 0600 link", async () => {
    const { calls, fetchImpl } = mockServer(okServer);
    const w = createWorldLink({ agentDir: dir, version: "9.9", env: {}, fetchImpl, now: () => 42 });
    expect((await w.worldGet()).status).toBe(200);
    expect(calls[0]?.url).toBe(`${DEFAULT_WORLD_URL}/api/world/device/register`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ client: "gg-coder", version: "9.9" });
    expect(calls[1]?.url).toBe(`${DEFAULT_WORLD_URL}/api/world/profile`);
    expect(auth(calls[1])).toBe("Bearer newtok");
    const saved = JSON.parse(await fs.readFile(file(), "utf8")) as Record<string, unknown>;
    expect(saved).toEqual({
      playerId: "new",
      deviceToken: "newtok",
      linkedAt: 42,
      serverUrl: DEFAULT_WORLD_URL,
    });
    if (process.platform !== "win32") expect((await fs.stat(file())).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["the old live Royale URL", LEGACY_ROYALE_URL],
    ["the old Royale URL with a slash", `${LEGACY_ROYALE_URL}/`],
    ["no serverUrl", undefined],
  ])("an existing link with %s is reused for gg-world, never re-registered", async (_l, url) => {
    await saveLink(url);
    const before = await fs.readFile(file(), "utf8");
    const { calls, fetchImpl } = mockServer(okServer);
    const w = createWorldLink({ agentDir: dir, version: "1", env: {}, fetchImpl });
    await w.worldGet();
    await w.worldLive();
    await w.worldPut(1, { a: 1 });
    expect(calls.some((c) => c.url.includes("/register"))).toBe(false);
    expect(calls.map((c) => c.url)).toEqual([
      `${DEFAULT_WORLD_URL}/api/world/profile`,
      `${DEFAULT_WORLD_URL}/api/world/live`,
      `${DEFAULT_WORLD_URL}/api/world/profile`,
    ]);
    for (const c of calls) expect(auth(c)).toBe("Bearer oldtok");
    expect(await fs.readFile(file(), "utf8")).toBe(before);
  });

  it("GG_WORLD_URL overrides, and a link from another server never reaches the live one", async () => {
    await saveLink("http://localhost:8787");
    const { calls, fetchImpl } = mockServer(okServer);
    const dev = createWorldLink({
      agentDir: dir,
      version: "1",
      env: { GG_WORLD_URL: "http://localhost:8787/" },
      fetchImpl,
    });
    await dev.worldGet();
    expect(calls[0]?.url).toBe("http://localhost:8787/api/world/profile");
    expect(auth(calls[0])).toBe("Bearer oldtok");

    calls.length = 0;
    const live = createWorldLink({ agentDir: dir, version: "1", env: {}, fetchImpl });
    await live.worldGet();
    expect(calls[0]?.url).toBe(`${DEFAULT_WORLD_URL}/api/world/device/register`);
    expect(auth(calls[1])).toBe("Bearer newtok");
    expect(calls.every((c) => auth(c) !== "Bearer oldtok")).toBe(true);
  });

  it("passes statuses through and never throws on a network failure", async () => {
    await saveLink(undefined);
    const conflict = mockServer(() => json({ error: "stale" }, 409));
    const w = createWorldLink({
      agentDir: dir,
      version: "1",
      env: {},
      fetchImpl: conflict.fetchImpl,
    });
    expect(await w.worldPut(1, {})).toEqual({ status: 409, body: { error: "stale" } });
    const down = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const w2 = createWorldLink({ agentDir: dir, version: "1", env: {}, fetchImpl: down });
    expect((await w2.worldGet()).status).toBe(0);
  });

  it("deleting the save without a link doesn't sign up", async () => {
    const { calls, fetchImpl } = mockServer(okServer);
    const w = createWorldLink({ agentDir: dir, version: "1", env: {}, fetchImpl });
    expect((await w.worldDelete()).status).toBe(200);
    expect((await w.accountDelete()).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("account delete calls DELETE /api/world/account and removes the link only on success", async () => {
    await saveLink(LEGACY_ROYALE_URL);
    const fail = mockServer(() => json({ error: "nope" }, 500));
    const w = createWorldLink({ agentDir: dir, version: "1", env: {}, fetchImpl: fail.fetchImpl });
    expect((await w.accountDelete()).status).toBe(500);
    await expect(fs.stat(file())).resolves.toBeTruthy();

    const ok = mockServer(() => json({ deleted: true }));
    const w2 = createWorldLink({ agentDir: dir, version: "1", env: {}, fetchImpl: ok.fetchImpl });
    expect(await w2.accountDelete()).toEqual({ status: 200, body: { deleted: true } });
    expect(ok.calls[0]?.url).toBe(`${DEFAULT_WORLD_URL}/api/world/account`);
    expect(ok.calls[0]?.init.method).toBe("DELETE");
    expect(auth(ok.calls[0])).toBe("Bearer oldtok");
    await expect(fs.stat(file())).rejects.toThrow();
  });
});
