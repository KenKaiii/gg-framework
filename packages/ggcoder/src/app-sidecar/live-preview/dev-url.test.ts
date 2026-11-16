import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BackgroundProcess } from "../../core/process-manager.js";
import { detectDevUrl, lastLocalUrl } from "./dev-url.js";

const proc = (over: Partial<BackgroundProcess>): BackgroundProcess =>
  ({
    id: "p",
    pid: 1,
    command: "npm run dev",
    logFile: "/x.log",
    startedAt: 0,
    exitCode: null,
    lastReadOffset: 0,
    ...over,
  }) as BackgroundProcess;

describe("lastLocalUrl", () => {
  it("reads Vite's banner through its colour codes", () => {
    const vite =
      "\u001b[32m\u001b[1mVITE\u001b[22m v5.4.0\u001b[39m  ready in 312 ms\n\n  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n";
    expect(lastLocalUrl(vite)).toEqual({ url: "http://localhost:5173/", https: false });
  });

  it("takes the newest URL and normalises 0.0.0.0 and ::1", () => {
    const log = "Local: http://localhost:3000\nport in use, trying http://0.0.0.0:3001.\n";
    expect(lastLocalUrl(log)?.url).toBe("http://localhost:3001/");
    expect(lastLocalUrl("on http://[::1]:8080/app/")?.url).toBe("http://localhost:8080/app/");
  });

  it("flags https and ignores remote hosts", () => {
    expect(lastLocalUrl("https://127.0.0.1:8443")).toEqual({
      url: "https://localhost:8443/",
      https: true,
    });
    expect(lastLocalUrl("see https://vitejs.dev/config")).toBeNull();
  });
});

describe("detectDevUrl", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("prefers the newest running process that printed a URL", async () => {
    const logs: Record<string, string> = {
      "/old.log": "http://localhost:4000",
      "/new.log": "http://localhost:5173",
      "/dead.log": "http://localhost:6000",
      "/quiet.log": "compiling...",
    };
    const result = await detectDevUrl(
      [
        proc({ logFile: "/old.log", startedAt: 1 }),
        proc({ logFile: "/dead.log", startedAt: 9, exitCode: 1 }),
        proc({ logFile: "/quiet.log", startedAt: 8 }),
        proc({ logFile: "/new.log", startedAt: 5, command: "pnpm dev" }),
      ],
      async (f) => logs[f] ?? "",
    );
    expect(result).toEqual({ kind: "found", url: "http://localhost:5173/", command: "pnpm dev" });
  });

  it("says https and none plainly", async () => {
    expect(await detectDevUrl([proc({})], async () => "https://localhost:3000")).toMatchObject({
      kind: "https",
    });
    expect(await detectDevUrl([], async () => "")).toEqual({ kind: "none" });
    expect(await detectDevUrl([proc({})], async () => Promise.reject(new Error("gone")))).toEqual({
      kind: "none",
    });
  });

  it("reads only the end of a real log file", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-dev-url-"));
    const file = path.join(dir, "dev.log");
    await fs.writeFile(
      file,
      `http://localhost:1111\n${"x".repeat(70 * 1024)}\nhttp://localhost:2222\n`,
    );
    expect(await detectDevUrl([proc({ logFile: file })])).toMatchObject({
      url: "http://localhost:2222/",
    });
  });
});

describe("detectDevUrl with a probe and the project's own servers", () => {
  const port = (url: string) => Number(new URL(url).port);

  it("picks the web page over an API the same window started", async () => {
    const logs: Record<string, string> = {
      "/web.log": "http://localhost:5173",
      "/api.log": "http://localhost:4000",
    };
    const result = await detectDevUrl(
      [proc({ logFile: "/web.log", startedAt: 1 }), proc({ logFile: "/api.log", startedAt: 2 })],
      async (f) => logs[f] ?? "",
      { probe: async (p) => (p === 5173 ? "html" : "http") },
    );
    expect(result).toMatchObject({ kind: "found", url: "http://localhost:5173/" });
  });

  it("finds a server the user started in this project, never another project's", async () => {
    const byProject: Record<string, number[]> = { "/work/shop": [3000], "/work/blog": [3001] };
    const opts = (cwd: string) => ({
      cwd,
      scan: async (c: string) => byProject[c] ?? [],
      probe: async () => "html" as const,
    });
    expect((await detectDevUrl([], async () => "", opts("/work/shop"))).kind).toBe("found");
    expect(await detectDevUrl([], async () => "", opts("/work/shop"))).toMatchObject({
      url: "http://localhost:3000/",
    });
    expect(await detectDevUrl([], async () => "", opts("/work/blog"))).toMatchObject({
      url: "http://localhost:3001/",
    });
    expect(await detectDevUrl([], async () => "", opts("/work/none"))).toEqual({ kind: "none" });
  });

  it("doesn't trust an exited server's old port, but still points at what it printed", async () => {
    const probed: number[] = [];
    const result = await detectDevUrl(
      [proc({ logFile: "/dead.log", exitCode: 1 })],
      async () => "http://localhost:6000",
      { probe: async (p) => (probed.push(p), "html") },
    );
    expect(probed).toEqual([]);
    expect(result).toMatchObject({ kind: "found", url: "http://localhost:6000/" });
  });

  it("skips what doesn't answer and keeps the window's own server first on a tie", async () => {
    const result = await detectDevUrl([proc({})], async () => "http://localhost:5173", {
      cwd: "/work/shop",
      scan: async () => [3000, 9000],
      probe: async (p) => (p === 9000 ? "none" : "html"),
    });
    expect(port((result as { url: string }).url)).toBe(5173);
  });

  it("never previews an API: a project running only one has no web app", async () => {
    // An Electrobun app's UI isn't served over http; its Worker API is.
    const result = await detectDevUrl([], async () => "", {
      cwd: "/work/desktop-app",
      scan: async () => [8799],
      probe: async () => "http",
    });
    expect(result).toEqual({ kind: "none" });
  });
});
