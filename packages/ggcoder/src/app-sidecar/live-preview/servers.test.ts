import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  belongsToProject,
  findProjectServers,
  parseLsofListeners,
  parseNetstatListeners,
  parseSsListeners,
  probePort,
  type RunCommand,
} from "./servers.js";

describe("listener parsing", () => {
  it("reads lsof, keeping only servers reachable as localhost", () => {
    const out = [
      "p100",
      "f20",
      "n*:5173",
      "n[::1]:5174",
      "p200",
      "n192.168.0.5:8080",
      "n127.0.0.1:3000",
    ].join("\n");
    expect(parseLsofListeners(out)).toEqual([
      { pid: 100, port: 5173 },
      { pid: 100, port: 5174 },
      { pid: 200, port: 3000 },
    ]);
  });

  it("reads ss", () => {
    const out = [
      'LISTEN 0      511        127.0.0.1:5173      0.0.0.0:*    users:(("node",pid=4242,fd=23))',
      'LISTEN 0      511             [::]:3000         [::]:*    users:(("next-server",pid=77,fd=20))',
      "LISTEN 0      4096   127.0.0.53%lo:53        0.0.0.0:*",
    ].join("\n");
    expect(parseSsListeners(out)).toEqual([
      { pid: 4242, port: 5173 },
      { pid: 77, port: 3000 },
    ]);
  });

  it("reads netstat whatever language its state column is in", () => {
    const out = [
      "  Proto  Lokale Adresse  Remoteadresse  Status  PID",
      "  TCP    0.0.0.0:3000   0.0.0.0:0      ABHÖREN    1234",
      "  TCP    [::1]:5173     [::]:0         ABHÖREN    55",
      "  TCP    127.0.0.1:5173 127.0.0.1:61000 HERGESTELLT 55",
      "  UDP    0.0.0.0:5353   *:*                       900",
    ].join("\r\n");
    expect(parseNetstatListeners(out)).toEqual([
      { pid: 1234, port: 3000 },
      { pid: 55, port: 5173 },
    ]);
  });
});

describe("belongsToProject", () => {
  it("matches a working directory inside the project, not a sibling with a longer name", () => {
    expect(belongsToProject("/work/app", { cwd: "/work/app" }, "linux", "/home/u")).toBe(true);
    expect(belongsToProject("/work/app", { cwd: "/work/app/web" }, "linux", "/home/u")).toBe(true);
    expect(belongsToProject("/work/app", { cwd: "/work/app2" }, "linux", "/home/u")).toBe(false);
  });

  it("matches a command line naming the project, Windows paths included", () => {
    expect(
      belongsToProject(
        "C:\\Users\\Ann\\shop",
        {
          command:
            '"C:\\Program Files\\nodejs\\node.exe" C:\\users\\ann\\shop\\node_modules\\vite\\bin\\vite.js',
        },
        "win32",
        "C:\\Users\\Ann",
      ),
    ).toBe(true);
    expect(
      belongsToProject(
        "/work/app",
        { command: "node /work/other/node_modules/.bin/next dev" },
        "linux",
        "/home/u",
      ),
    ).toBe(false);
  });

  it("won't claim servers for a home folder or a drive root", () => {
    expect(belongsToProject("/home/u", { cwd: "/home/u/app" }, "linux", "/home/u")).toBe(false);
    expect(belongsToProject("C:\\", { cwd: "C:\\app" }, "win32", "C:\\Users\\Ann")).toBe(false);
  });
});

describe("findProjectServers", () => {
  it("keeps each project's own servers on macOS, skipping GG Coder itself", async () => {
    const run: RunCommand = async (file, args) => {
      if (args.includes("-sTCP:LISTEN"))
        return [
          "p10",
          "n*:5173",
          "p20",
          "n*:3000",
          "p30",
          "n127.0.0.1:51000",
          "p99",
          "n*:4000",
        ].join("\n");
      if (file.endsWith("lsof"))
        return ["p10", "n/work/shop", "p20", "n/work/blog", "p30", "n/work/shop"].join("\n");
      return ["10 node vite", "20 node next dev", "30 /opt/gg/node app-sidecar.mjs"].join("\n");
    };
    const opts = { platform: "darwin" as const, run, selfPid: 99 };
    expect(await findProjectServers("/work/shop", opts)).toEqual([5173]);
    expect(await findProjectServers("/work/blog", opts)).toEqual([3000]);
    expect(await findProjectServers("/work/none", opts)).toEqual([]);
  });

  it("matches on Windows by command line", async () => {
    const run: RunCommand = async (file) =>
      file.toLowerCase().endsWith("netstat.exe")
        ? "  TCP    0.0.0.0:3000   0.0.0.0:0   LISTENING   7\n  TCP    0.0.0.0:8080   0.0.0.0:0   LISTENING   8\n"
        : "7\tnode C:\\work\\shop\\node_modules\\next\\dist\\bin\\next dev\n8\tjava -jar C:\\tools\\db.jar\n";
    expect(
      await findProjectServers("C:\\work\\shop", { platform: "win32", run, selfPid: 1 }),
    ).toEqual([3000]);
  });

  it("finds nothing, rather than failing, when the OS tools aren't there", async () => {
    const run: RunCommand = async () => {
      throw new Error("ENOENT");
    };
    expect(await findProjectServers("/work/shop", { platform: "linux", run, selfPid: 1 })).toEqual(
      [],
    );
  });
});

describe("probePort", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
  const serve = async (handler: http.RequestListener): Promise<number> => {
    const s = http.createServer(handler);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "localhost", r));
    return (s.address() as AddressInfo).port;
  };

  it("tells a web page from an API, a slow first compile and nothing at all", async () => {
    const page = await serve((_q, r) =>
      r.writeHead(200, { "content-type": "text/html" }).end("<html>"),
    );
    const signIn = await serve((_q, r) => r.writeHead(307, { location: "/login" }).end());
    const api = await serve((_q, r) =>
      r.writeHead(404, { "content-type": "application/json" }).end("{}"),
    );
    const apiHtml404 = await serve((_q, r) =>
      r.writeHead(404, { "content-type": "text/html" }).end("Cannot GET /"),
    );
    const slow = await serve(() => {});
    const closed = await serve(() => {});
    const last = servers.pop()!;
    await new Promise<void>((r) => last.close(() => r()));
    expect(await probePort(page)).toBe("html");
    expect(await probePort(signIn)).toBe("html");
    expect(await probePort(api)).toBe("http");
    expect(await probePort(apiHtml404)).toBe("http");
    expect(await probePort(slow, 200)).toBe("slow");
    expect(await probePort(closed)).toBe("none");
  });
});
