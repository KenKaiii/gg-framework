// Unit tests for the retrying Node runtime download in stage-node.mjs. A
// dropped connection to nodejs.org once failed a release build, so the retry
// rules are checked here with a scripted fetch, never the network.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { download } from "./stage-node.mjs";

const NODE_URL = "https://nodejs.org/dist/v24.22.3/node-v24.22.3-darwin-arm64.tar.gz";
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDest() {
  const dir = mkdtempSync(join(tmpdir(), "stage-node-test-"));
  tempDirs.push(dir);
  return join(dir, "node.tar.gz");
}

// One scripted outcome per fetch call.
const ok = (text) => () => new Response(text, { status: 200 });
const httpStatus = (code) => () => new Response("nope", { status: code });
const networkError = (reason) => () => {
  throw new TypeError("fetch failed", { cause: new Error(reason) });
};
// Sends some bytes, then drops the connection mid-transfer.
const cutOff = (partial) => () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(partial));
        controller.error(new Error("socket hang up"));
      },
    }),
    { status: 200 },
  );
// Never answers; only the per-attempt timeout ends it.
const stall = () => (init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });

function run(outcomes, extra = {}) {
  const calls = [];
  const delays = [];
  const logs = [];
  const dest = tempDest();
  const promise = download(NODE_URL, dest, {
    fetchImpl: async (url, init) => {
      calls.push(url);
      const next = outcomes[calls.length - 1];
      if (!next) throw new Error(`unexpected fetch call ${calls.length}`);
      return next(init);
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
    log: (line) => logs.push(line),
    ...extra,
  });
  return { promise, calls, delays, logs, dest };
}

describe("stage-node download", () => {
  it("downloads on the first try without waiting", async () => {
    const r = run([ok("node-archive")]);
    await r.promise;

    expect(readFileSync(r.dest, "utf8")).toBe("node-archive");
    expect(r.calls).toHaveLength(1);
    expect(r.delays).toEqual([]);
  });

  it("retries a dropped connection and logs the real reason", async () => {
    const r = run([
      networkError("Connect Timeout Error (attempted address: nodejs.org:443, timeout: 10000ms)"),
      ok("node-archive"),
    ]);
    await r.promise;

    expect(readFileSync(r.dest, "utf8")).toBe("node-archive");
    expect(r.calls).toHaveLength(2);
    expect(r.delays).toEqual([2000]);
    expect(r.logs[0]).toContain("attempt 1/4 failed (fetch failed: Connect Timeout Error");
  });

  it.each([408, 429, 500, 503])("retries HTTP %i", async (code) => {
    const r = run([httpStatus(code), ok("node-archive")]);
    await r.promise;

    expect(readFileSync(r.dest, "utf8")).toBe("node-archive");
    expect(r.calls).toHaveLength(2);
  });

  it.each([403, 404])("fails at once on HTTP %i, which a retry cannot fix", async (code) => {
    const r = run([httpStatus(code)]);

    await expect(r.promise).rejects.toThrow(`download failed (${code})`);
    expect(r.calls).toHaveLength(1);
    expect(r.delays).toEqual([]);
  });

  it("replaces a transfer cut off midway instead of keeping the partial file", async () => {
    const r = run([cutOff("PARTIAL-"), ok("node-archive")]);
    await r.promise;

    expect(readFileSync(r.dest, "utf8")).toBe("node-archive");
    expect(r.calls).toHaveLength(2);
  });

  it("turns a stalled attempt into a retry", async () => {
    const r = run([stall(), ok("node-archive")], { attemptTimeoutMs: 20 });
    await r.promise;

    expect(readFileSync(r.dest, "utf8")).toBe("node-archive");
    expect(r.calls).toHaveLength(2);
  });

  it("gives up after four attempts, waiting 2s, 4s and 8s between them", async () => {
    const fail = networkError("ECONNRESET");
    const r = run([fail, fail, fail, fail]);

    await expect(r.promise).rejects.toThrow("fetch failed");
    expect(r.calls).toHaveLength(4);
    expect(r.delays).toEqual([2000, 4000, 8000]);
    expect(r.logs).toHaveLength(3);
  });
});
