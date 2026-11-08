import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_POLL_URL,
  createPollClient as createClient,
  deviceVoterId,
  parseMachineId,
  type PollClientOptions,
} from "./poll.js";

// Without a machine id: the random-id fallback. Device ids are tested below.
const createPollClient = (o: PollClientOptions) =>
  createClient({ machineId: async () => null, ...o });

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-poll-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const POLL = { id: "p1", question: "Next?", options: ["A", "B", "C"], closesAt: 1, opensAt: 0 };

function mockServer(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const file = () => path.join(dir, "poll.json");

describe("poll client", () => {
  it("reads the open poll without a voter id or a local file", async () => {
    const { calls, fetchImpl } = mockServer(() =>
      json({ poll: POLL, counts: [2, 1, 0], total: 3 }),
    );
    const state = await createPollClient({ agentDir: dir, env: {}, fetchImpl }).current();
    expect(state).toEqual({
      status: 200,
      poll: { id: "p1", question: "Next?", options: ["A", "B", "C"], closesAt: 1 },
      counts: [2, 1, 0],
      total: 3,
      myChoice: null,
    });
    expect(calls[0]?.url).toBe(`${DEFAULT_POLL_URL}/api/poll/current`);
    expect(calls[0]?.init.body).toBeUndefined();
    await expect(fs.stat(file())).rejects.toThrow();
  });

  it("votes under one private random id and remembers the pick", async () => {
    const bodies: Record<string, unknown>[] = [];
    const { fetchImpl } = mockServer((url, init) => {
      if (url.endsWith("/vote")) bodies.push(JSON.parse(String(init.body)));
      return json({ poll: POLL, counts: [0, 1, 0], total: 1 });
    });
    const client = createPollClient({ agentDir: dir, env: {}, fetchImpl });
    expect((await client.vote("p1", 1)).myChoice).toBe(1);
    await client.vote("p1", 2);
    expect(bodies[0]?.voter).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bodies[1]?.voter).toBe(bodies[0]?.voter);
    expect((await client.current()).myChoice).toBe(2);
    if (process.platform !== "win32") expect((await fs.stat(file())).mode & 0o777).toBe(0o600);
  });

  it("keeps the same voter id and pick across app restarts", async () => {
    const voters: unknown[] = [];
    const { fetchImpl } = mockServer((url, init) => {
      if (url.endsWith("/vote")) voters.push(JSON.parse(String(init.body)).voter);
      return json({ poll: POLL, counts: [1, 0, 0], total: 1 });
    });
    await createPollClient({ agentDir: dir, env: {}, fetchImpl }).vote("p1", 0);
    // A fresh client on the same ~/.gg is what the next app launch gets.
    const relaunched = createPollClient({ agentDir: dir, env: {}, fetchImpl });
    expect((await relaunched.current()).myChoice).toBe(0);
    await relaunched.vote("p1", 2);
    expect(voters).toHaveLength(2);
    expect(voters[1]).toBe(voters[0]);
  });

  it("votes under the hashed machine id, the same after ~/.gg is wiped", async () => {
    const voters: unknown[] = [];
    const { fetchImpl } = mockServer((url, init) => {
      if (url.endsWith("/vote")) voters.push(JSON.parse(String(init.body)).voter);
      return json({ poll: POLL, counts: [1, 0, 0], total: 1 });
    });
    const machineId = async () => "4C4C4544-0042-3510-8051-B4C04F4E4D32";
    await createClient({ agentDir: dir, env: {}, fetchImpl, machineId }).vote("p1", 0);
    const wiped = await fs.mkdtemp(path.join(os.tmpdir(), "gg-poll-wiped-"));
    try {
      await createClient({ agentDir: wiped, env: {}, fetchImpl, machineId }).vote("p1", 1);
    } finally {
      await fs.rm(wiped, { recursive: true, force: true });
    }
    expect(voters).toEqual([deviceVoterId(await machineId()), deviceVoterId(await machineId())]);
    expect(voters[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(String(voters[0])).not.toContain("4C4C4544");
  });

  it("reads machine ids from each platform's tool output", () => {
    expect(
      parseMachineId("darwin", '  "IOPlatformUUID" = "4C4C4544-0042-3510-8051-B4C04F4E4D32"\n'),
    ).toBe("4C4C4544-0042-3510-8051-B4C04F4E4D32");
    expect(
      parseMachineId(
        "win32",
        "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    6f1e2d3c-aaaa-bbbb-cccc-0123456789ab\r\n",
      ),
    ).toBe("6f1e2d3c-aaaa-bbbb-cccc-0123456789ab");
    expect(parseMachineId("linux", "0123456789abcdef0123456789abcdef\n")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    expect(parseMachineId("linux", "")).toBeNull();
    expect(parseMachineId("darwin", "no uuid here")).toBeNull();
  });

  it("passes server errors through and keeps the old pick", async () => {
    let closed = false;
    const { fetchImpl } = mockServer(() =>
      closed
        ? json({ error: "this poll is closed" }, 409)
        : json({ poll: POLL, counts: [1, 0, 0] }),
    );
    const client = createPollClient({ agentDir: dir, env: {}, fetchImpl });
    await client.vote("p1", 0);
    closed = true;
    expect(await client.vote("p1", 2)).toMatchObject({ status: 409, error: "this poll is closed" });
    expect(JSON.parse(await fs.readFile(file(), "utf8")).picks).toEqual({ p1: 0 });
  });

  it("reports an unreachable server as status 0 and honours GG_POLL_URL", async () => {
    const { calls, fetchImpl } = mockServer(() => {
      throw new Error("offline");
    });
    const state = await createPollClient({
      agentDir: dir,
      env: { GG_POLL_URL: "http://localhost:8787/" },
      fetchImpl,
    }).current();
    expect(state).toMatchObject({ status: 0, poll: null, error: "unreachable" });
    expect(calls[0]?.url).toBe("http://localhost:8787/api/poll/current");
  });

  it("treats no open poll as null", async () => {
    const { fetchImpl } = mockServer(() => json({ poll: null }));
    expect(
      (await createPollClient({ agentDir: dir, env: {}, fetchImpl }).current()).poll,
    ).toBeNull();
  });
});
