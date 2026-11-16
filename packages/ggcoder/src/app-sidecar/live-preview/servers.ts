// Web servers the user started themselves (a terminal `npm run dev`), kept only
// when they run from inside the window's project, so a window never previews
// another project's app. Read from the OS: lsof (macOS), ss or lsof (Linux),
// netstat and PowerShell (Windows).
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { resolveWindowsTaskkillPath } from "../../utils/process.js";

export interface Listener {
  pid: number;
  port: number;
}

export interface ProcessDetails {
  cwd?: string;
  command?: string;
}

/** Runs a program and returns its stdout, also when it exits non-zero with output. */
export type RunCommand = (file: string, args: string[]) => Promise<string>;

export type Probe = "html" | "slow" | "http" | "none";

const REACHABLE = new Set([
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "::",
  "*",
  "localhost",
  "::ffff:127.0.0.1",
]);

/** `host:port` as printed by lsof, ss and netstat ([::1]:5173, *:3000, fe80::1%lo0:80). */
function hostPort(addr: string): { host: string; port: number } | null {
  const i = addr.lastIndexOf(":");
  if (i < 0) return null;
  const port = Number(addr.slice(i + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = addr
    .slice(0, i)
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  return { host, port };
}

function listener(pid: number, addr: string): Listener | null {
  const hp = hostPort(addr);
  // A server bound to one LAN address only isn't reachable as localhost.
  if (!hp || !Number.isInteger(pid) || pid <= 0 || !REACHABLE.has(hp.host.toLowerCase()))
    return null;
  return { pid, port: hp.port };
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: a `p<pid>` line, then `n<addr>` lines. */
export function parseLsofListeners(out: string): Listener[] {
  const found: Listener[] = [];
  let pid = 0;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) {
      const l = listener(pid, line.slice(1));
      if (l) found.push(l);
    }
  }
  return found;
}

/** `ss -ltnpH`: `LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=42,fd=20))`. */
export function parseSsListeners(out: string): Listener[] {
  const found: Listener[] = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    const pid = /pid=(\d+)/.exec(line)?.[1];
    if (cols.length < 5 || !pid) continue;
    const l = listener(Number(pid), cols[3]);
    if (l) found.push(l);
  }
  return found;
}

/** `netstat -ano`: `TCP 0.0.0.0:3000 0.0.0.0:0 LISTENING 1234`. The state word is translated, so a
 *  listener is told by its foreign port 0. */
export function parseNetstatListeners(out: string): Listener[] {
  const found: Listener[] = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0].toUpperCase() !== "TCP" || !/:0$/.test(cols[2])) continue;
    const l = listener(Number(cols[cols.length - 1]), cols[1]);
    if (l) found.push(l);
  }
  return found;
}

const system32 = (): string => path.win32.dirname(resolveWindowsTaskkillPath());

async function listListeners(platform: NodeJS.Platform, run: RunCommand): Promise<Listener[]> {
  if (platform === "win32")
    return parseNetstatListeners(await run(path.win32.join(system32(), "netstat.exe"), ["-ano"]));
  const lsof = () =>
    run(platform === "darwin" ? "/usr/sbin/lsof" : "lsof", [
      "-nP",
      "-iTCP",
      "-sTCP:LISTEN",
      "-Fpn",
    ]).then(parseLsofListeners);
  if (platform === "linux") {
    const viaSs = await run("ss", ["-ltnpH"])
      .then(parseSsListeners)
      .catch(() => []);
    return viaSs.length > 0 ? viaSs : lsof().catch(() => []);
  }
  return lsof();
}

async function processDetails(
  platform: NodeJS.Platform,
  pids: number[],
  run: RunCommand,
): Promise<Map<number, ProcessDetails>> {
  const details = new Map<number, ProcessDetails>(pids.map((p) => [p, {}]));
  const set = (pid: number, key: keyof ProcessDetails, value: string) => {
    const d = details.get(pid);
    if (d && value) d[key] = value;
  };
  if (platform === "linux") {
    await Promise.all(
      pids.map(async (pid) => {
        set(pid, "cwd", await fs.readlink(`/proc/${pid}/cwd`).catch(() => ""));
        const cmd = await fs.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
        set(pid, "command", cmd.replace(/\0/g, " ").trim());
      }),
    );
  } else if (platform === "win32") {
    // Windows doesn't expose another process's working directory: its command line names the project.
    const filter = pids.map((p) => `ProcessId=${p}`).join(" OR ");
    const out = await run(
      path.win32.join(system32(), "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`,
      ],
    ).catch(() => "");
    for (const line of out.split(/\r?\n/)) {
      const tab = line.indexOf("\t");
      if (tab > 0) set(Number(line.slice(0, tab)), "command", line.slice(tab + 1).trim());
    }
  } else {
    const list = pids.join(",");
    const [cwds, commands] = await Promise.all([
      run("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn", "-p", list]).catch(() => ""),
      run("/bin/ps", ["-o", "pid=,command=", "-p", list]).catch(() => ""),
    ]);
    let pid = 0;
    for (const line of cwds.split(/\r?\n/)) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n")) set(pid, "cwd", line.slice(1));
    }
    for (const line of commands.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m) set(Number(m[1]), "command", m[2].trim());
    }
  }
  return details;
}

function normalise(p: string, platform: NodeJS.Platform): string {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" || platform === "darwin" ? s.toLowerCase() : s;
}

/**
 * Whether a process runs from inside `project`: its working directory is in it,
 * or its command line names a path in it (`node /work/app/node_modules/.bin/vite`).
 * A home folder or drive root is too broad to tell projects apart.
 */
export function belongsToProject(
  project: string,
  details: ProcessDetails,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): boolean {
  const root = normalise(project, platform);
  if (!root || root === normalise(home, platform) || /^([a-z]:)?$/i.test(root)) return false;
  const cwd = details.cwd ? normalise(details.cwd, platform) : "";
  if (cwd === root || cwd.startsWith(`${root}/`)) return true;
  const command = details.command ? normalise(details.command, platform) : "";
  return command.includes(`${root}/`);
}

export const runCommand: RunCommand = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: 4000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)),
    );
  });

export interface FindServersOptions {
  platform?: NodeJS.Platform;
  run?: RunCommand;
  /** This process (the sidecar and its own previews) is never a dev server. */
  selfPid?: number;
}

/** Ports of local servers running from inside `project`, lowest first. Never throws. */
export async function findProjectServers(
  project: string,
  opts: FindServersOptions = {},
): Promise<number[]> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runCommand;
  const selfPid = opts.selfPid ?? process.pid;
  try {
    const listeners = (await listListeners(platform, run)).filter((l) => l.pid !== selfPid);
    if (listeners.length === 0) return [];
    const pids = [...new Set(listeners.map((l) => l.pid))];
    const details = await processDetails(platform, pids, run);
    // The OS reports real paths (macOS /tmp is /private/tmp): match through links too.
    const real = await fs.realpath(project).catch(() => project);
    const roots = real === project ? [project] : [project, real];
    const ports = listeners
      .filter((l) => {
        const d = details.get(l.pid) ?? {};
        // Another GG Coder's sidecar serves previews, not the project's app.
        if (d.command && /app-sidecar\.m?js/.test(d.command)) return false;
        return roots.some((root) => belongsToProject(root, d, platform));
      })
      .map((l) => l.port);
    return [...new Set(ports)].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** What answers on a local port: a web page, something slow to answer (a first compile), another
 *  HTTP server (an API, or an error page), or nothing. */
export function probePort(port: number, timeoutMs = 3000): Promise<Probe> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "localhost",
        port,
        path: "/",
        headers: { accept: "text/html", "user-agent": "gg-live-preview" },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const type = String(res.headers["content-type"] ?? "");
        res.destroy();
        // A redirect from "/" (to a sign-in page, say) is a web app too; an API's HTML 404 isn't.
        const page =
          status >= 300 && status < 400 ? true : status < 300 && /text\/html/i.test(type);
        resolve(page ? "html" : "http");
      },
    );
    req.on("timeout", () => {
      resolve("slow");
      req.destroy();
    });
    req.on("error", () => resolve("none"));
  });
}
