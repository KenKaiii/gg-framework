import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareVersions,
  feedMatches,
  loadThreatFeed,
  onThreatFeedUpdated,
  pruneFeed,
  startThreatFeedSync,
  syncThreatFeed,
  threatFeedPath,
  type ThreatFeedData,
  writeJsonAtomic,
} from "./threat-feed.js";

vi.mock("./logger.js", () => ({ log: vi.fn() }));

const NOW = Date.parse("2026-10-19T12:00:00Z");
const DAY = 86_400_000;
let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "threat-feed-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Fake OSV bucket: index rows newest-first served as a 206 range body. */
function bucket(rows: Record<string, string[]>, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const m = /storage\.googleapis\.com\/(npm|PyPI)\/(.+)$/.exec(url);
    const eco = m?.[1] ?? "";
    const file = m?.[2] ?? "";
    if (file === "modified_id.csv") {
      return new Response(`${(rows[eco] ?? []).join("\n")}\n`, { status: 206 });
    }
    const id = file.replace(/\.json$/, "");
    return new Response(
      JSON.stringify({
        id,
        affected: [
          { package: { name: `pkg-${id.toLowerCase()}`, ecosystem: eco }, versions: ["1.0.0"] },
        ],
      }),
    );
  }) as typeof fetch;
}

describe("syncThreatFeed", () => {
  it("syncs only new MAL- ids, stops at the last timestamp, once a day", async () => {
    const calls: string[] = [];
    const rows: Record<string, string[]> = {
      npm: [
        "2026-10-18T00:00:00Z,MAL-2026-2",
        "2026-10-17T00:00:00Z,GHSA-aaaa",
        "2026-10-16T00:00:00Z,MAL-2026-1",
      ],
      PyPI: ["2026-10-18T00:00:00Z,MAL-2026-9"],
    };
    expect(await syncThreatFeed({ dir, fetch: bucket(rows, calls), now: () => NOW })).toBe(true);
    expect(calls.filter((u) => u.endsWith("modified_id.csv"))).toHaveLength(2);
    let feed = loadThreatFeed(dir);
    expect(feedMatches(feed, "npm", "pkg-mal-2026-2", "1.0.0")).toEqual(["MAL-2026-2"]);
    expect(feedMatches(feed, "npm", "pkg-mal-2026-1", "1.0.0")).toEqual(["MAL-2026-1"]);
    expect(feedMatches(feed, "PyPI", "pkg-mal-2026-9", "1.0.0")).toEqual(["MAL-2026-9"]);
    expect(calls.some((u) => u.includes("GHSA"))).toBe(false);
    expect(calls.some((u) => u.includes("all.zip"))).toBe(false);
    expect(path.dirname(threatFeedPath(dir))).toBe(dir);

    // Same day: nothing runs.
    calls.length = 0;
    expect(await syncThreatFeed({ dir, fetch: bucket(rows, calls), now: () => NOW + 1000 })).toBe(
      false,
    );
    expect(calls).toEqual([]);

    // Next day: only the row newer than the last sync is fetched.
    rows.npm?.unshift("2026-10-19T06:00:00Z,MAL-2026-3");
    await syncThreatFeed({ dir, fetch: bucket(rows, calls), now: () => NOW + DAY });
    expect(calls.filter((u) => u.endsWith(".json"))).toEqual([
      "https://osv-vulnerabilities.storage.googleapis.com/npm/MAL-2026-3.json",
    ]);
    feed = loadThreatFeed(dir);
    expect(feedMatches(feed, "npm", "pkg-mal-2026-3", "1.0.0")).toEqual(["MAL-2026-3"]);
    expect(feedMatches(feed, "npm", "pkg-mal-2026-2", "1.0.0")).toEqual(["MAL-2026-2"]);
  });

  it("first sync stops at the window start", async () => {
    const calls: string[] = [];
    const rows = { npm: ["2026-10-18T00:00:00Z,MAL-2026-2", "2026-01-01T00:00:00Z,MAL-2026-OLD"] };
    await syncThreatFeed({ dir, fetch: bucket(rows, calls), now: () => NOW, windowDays: 90 });
    expect(calls.some((u) => u.includes("MAL-2026-2.json"))).toBe(true);
    expect(calls.some((u) => u.includes("MAL-2026-OLD"))).toBe(false);
  });

  it("offline: rejects without writing, so the caller (startThreatFeedSync) just logs", async () => {
    const offline = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    await expect(syncThreatFeed({ dir, fetch: offline, now: () => NOW })).rejects.toThrow(
      "offline",
    );
    expect(fs.existsSync(threatFeedPath(dir))).toBe(false);
    expect(loadThreatFeed(dir).entries).toEqual({});
  });

  it("an interrupted pass keeps what it got and re-reads the missed advisories next time", async () => {
    const rows = { npm: ["2026-10-18T00:00:00Z,MAL-2026-2", "2026-10-17T00:00:00Z,MAL-2026-1"] };
    const calls: string[] = [];
    const ok = bucket(rows, calls);
    const flaky = (async (input: string | URL | Request) =>
      String(input).includes("MAL-2026-1")
        ? Promise.reject(new Error("reset"))
        : ok(input)) as typeof fetch;
    await syncThreatFeed({ dir, fetch: flaky, now: () => NOW });
    expect(feedMatches(loadThreatFeed(dir), "npm", "pkg-mal-2026-2", "1.0.0")).toHaveLength(1);
    calls.length = 0;
    await syncThreatFeed({ dir, fetch: ok, now: () => NOW + 1000 });
    expect(calls.some((u) => u.includes("MAL-2026-1.json"))).toBe(true);
    expect(feedMatches(loadThreatFeed(dir), "npm", "pkg-mal-2026-1", "1.0.0")).toHaveLength(1);
  });

  it("re-reads a rewritten feed even when the write kept the same mtime", async () => {
    const file = threatFeedPath(dir);
    const stamp = new Date(NOW);
    const entry = { id: "MAL-2026-1", versions: ["1.0.0"], ranges: [] };
    await writeJsonAtomic(file, { sync: {}, entries: {} });
    fs.utimesSync(file, stamp, stamp);
    expect(loadThreatFeed(dir).entries).toEqual({});
    // Windows file times tick coarsely, so a quick second write can share the mtime.
    await writeJsonAtomic(file, { sync: {}, entries: { "npm:pkg-mal-2026-1": [entry] } });
    fs.utimesSync(file, stamp, stamp);
    expect(feedMatches(loadThreatFeed(dir), "npm", "pkg-mal-2026-1", "1.0.0")).toEqual([
      "MAL-2026-1",
    ]);
  });

  it("a read-only GG dir rejects (caller logs) and leaves the old feed intact", async () => {
    if (process.platform === "win32") return;
    const rows = { npm: ["2026-10-18T00:00:00Z,MAL-2026-2"] };
    await syncThreatFeed({ dir, fetch: bucket(rows, []), now: () => NOW });
    const before = fs.readFileSync(threatFeedPath(dir), "utf8");
    fs.chmodSync(dir, 0o500);
    try {
      await expect(
        syncThreatFeed({ dir, fetch: bucket(rows, []), now: () => NOW + DAY }),
      ).rejects.toThrow();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    expect(fs.readFileSync(threatFeedPath(dir), "utf8")).toBe(before);
  });
});

describe("feedMatches", () => {
  const feed: ThreatFeedData = {
    sync: {},
    entries: {
      "npm:ranged": [
        { id: "MAL-R", versions: [], ranges: [[{ introduced: "2.0.0" }, { fixed: "2.3.0" }]] },
      ],
      "npm:whole": [{ id: "MAL-W", versions: [], ranges: [[{ introduced: "0" }]] }],
      "npm:single": [{ id: "MAL-S", versions: ["4.4.2"], ranges: [] }],
    },
  };

  it("matches version ranges and exact versions only", () => {
    expect(feedMatches(feed, "npm", "ranged", "2.1.5")).toEqual(["MAL-R"]);
    expect(feedMatches(feed, "npm", "ranged", "2.3.0")).toEqual([]);
    expect(feedMatches(feed, "npm", "ranged", "1.9.9")).toEqual([]);
    expect(feedMatches(feed, "npm", "single", "4.4.1")).toEqual([]);
    expect(feedMatches(feed, "npm", "single", "4.4.2")).toEqual(["MAL-S"]);
  });

  it("without a version only whole-package entries match", () => {
    expect(feedMatches(feed, "npm", "whole", undefined)).toEqual(["MAL-W"]);
    expect(feedMatches(feed, "npm", "single", undefined)).toEqual([]);
  });

  it("compareVersions", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
  });
});

describe("feed bounds", () => {
  it("drops advisories older than a year and caps the entry count", () => {
    const at = (days: number): string => new Date(NOW - days * DAY).toISOString();
    const feed: ThreatFeedData = {
      sync: {},
      entries: {
        "npm:old": [{ id: "MAL-1", versions: [], ranges: [], published: at(400) }],
        "npm:new": [{ id: "MAL-2", versions: [], ranges: [], published: at(3) }],
        "npm:mid": [{ id: "MAL-3", versions: [], ranges: [], published: at(100) }],
        "npm:undated": [{ id: "MAL-4", versions: [], ranges: [] }],
      },
    };
    pruneFeed(feed, NOW);
    expect(Object.keys(feed.entries)).toEqual(["npm:mid", "npm:new", "npm:undated"]);
    pruneFeed(feed, NOW, 1);
    expect(Object.keys(feed.entries)).toEqual(["npm:new"]);
  });

  it("parses a CRLF index", async () => {
    const calls: string[] = [];
    const crlf = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await bucket({ npm: ["2026-10-19T10:00:00Z,MAL-2026-7"], PyPI: [] }, calls)(
        input,
        init,
      );
      const text = await res.text();
      return new Response(text.replace(/\n/g, "\r\n"), { status: res.status });
    }) as typeof fetch;
    await syncThreatFeed({ dir, fetch: crlf, now: () => NOW });
    expect(loadThreatFeed(dir).sync.npm?.modified).toBe("2026-10-19T10:00:00Z");
    expect(Object.keys(loadThreatFeed(dir).entries)).toEqual(["npm:pkg-mal-2026-7"]);
  });
});

describe("startThreatFeedSync", () => {
  it("re-tries on an interval (an app left open stays current) and tells listeners on new data", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const fetchImpl = bucket({ npm: ["2026-10-19T10:00:00Z,MAL-2026-1"], PyPI: [] }, calls);
      let clock = NOW;
      let updates = 0;
      const off = onThreatFeedUpdated(() => updates++);
      const stop = startThreatFeedSync({
        dir,
        fetch: fetchImpl,
        now: () => clock,
        delayMs: 10,
        intervalMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(20);
      await vi.waitFor(() => expect(updates).toBe(1));
      // Within the same day the interval fires but the sync is skipped.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(updates).toBe(1);
      // A day later the next interval tick syncs again.
      clock = NOW + DAY + 1;
      const before = calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(updates).toBe(2));
      expect(calls.length).toBeGreaterThan(before);
      stop();
      off();
    } finally {
      vi.useRealTimers();
    }
  });
});
