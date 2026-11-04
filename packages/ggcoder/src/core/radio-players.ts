import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getAppPaths } from "@kenkaiiii/gg-core";
import { killProcessTree, resolveWindowsTaskkillPath } from "../utils/process.js";
import { log } from "./logger.js";

/**
 * Radio players recorded on disk, so a daemon that was killed hard (a crash,
 * `taskkill /F`, SIGKILL) leaves enough behind for the next daemon to stop
 * its still-streaming player. A record is only a hint: a player is killed only
 * when its owner daemon is gone AND the process still plays the recorded
 * station URL, so a reused PID is never touched.
 */
export interface PlayerRecord {
  pid: number;
  ownerPid: number;
  url: string;
}

export interface RadioPlayerDeps {
  file?: string;
  platform?: NodeJS.Platform;
  isAlive?: (pid: number) => boolean;
  commandLine?: (pid: number) => Promise<string | undefined>;
  killTree?: (pid: number) => void;
}

function recordFile(deps: RadioPlayerDeps): string {
  return deps.file ?? path.join(getAppPaths().agentDir, "radio-players.json");
}

function readRecords(file: string): PlayerRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is PlayerRecord =>
        typeof r === "object" &&
        r !== null &&
        Number.isSafeInteger((r as PlayerRecord).pid) &&
        (r as PlayerRecord).pid > 0 &&
        Number.isSafeInteger((r as PlayerRecord).ownerPid) &&
        typeof (r as PlayerRecord).url === "string" &&
        (r as PlayerRecord).url.length > 0,
    );
  } catch {
    return [];
  }
}

function writeRecords(file: string, records: PlayerRecord[]): void {
  try {
    if (records.length === 0) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(records), "utf8");
  } catch {
    // Best effort: an unwritable record must never break playback.
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function run(file: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

/** The process's command line (plus environment on Linux, where the WSL host player keeps its URL). */
async function defaultCommandLine(
  pid: number,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  if (platform === "linux") {
    try {
      const read = (name: string): string =>
        readFileSync(`/proc/${pid}/${name}`, "utf8").replace(/\0/g, " ");
      let text = read("cmdline");
      try {
        text += ` ${read("environ")}`;
      } catch {
        // environ is unreadable for other users' processes — cmdline is enough.
      }
      return text;
    } catch {
      return undefined;
    }
  }
  if (platform === "win32") {
    const system32 = path.win32.dirname(resolveWindowsTaskkillPath());
    const powershell = path.win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
    return run(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ]);
  }
  return run("/bin/ps", ["-o", "command=", "-p", String(pid)]);
}

export function recordRadioPlayer(pid: number, url: string, deps: RadioPlayerDeps = {}): void {
  const file = recordFile(deps);
  const records = readRecords(file).filter((r) => r.pid !== pid);
  records.push({ pid, ownerPid: process.pid, url });
  writeRecords(file, records);
}

export function forgetRadioPlayer(pid: number | undefined, deps: RadioPlayerDeps = {}): void {
  if (!pid) return;
  const file = recordFile(deps);
  const records = readRecords(file);
  const next = records.filter((r) => r.pid !== pid);
  if (next.length !== records.length) writeRecords(file, next);
}

/** Kill a player and anything it spawned (a launcher shim's real player on Windows). */
export function killRadioPlayerTree(pid: number): void {
  killProcessTree(pid);
}

/**
 * Stop players whose daemon died without cleaning up. Records of live daemons
 * (another app instance) are kept untouched. Returns the PIDs it killed.
 */
export async function reapOrphanedRadioPlayers(deps: RadioPlayerDeps = {}): Promise<number[]> {
  const file = recordFile(deps);
  const platform = deps.platform ?? process.platform;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const commandLine = deps.commandLine ?? ((pid: number) => defaultCommandLine(pid, platform));
  const killTree = deps.killTree ?? killRadioPlayerTree;

  const orphaned = readRecords(file).filter(
    (r) => r.ownerPid !== process.pid && !isAlive(r.ownerPid),
  );
  if (orphaned.length === 0) return [];
  const killed: number[] = [];
  for (const record of orphaned) {
    if (!isAlive(record.pid)) continue;
    const cmd = await commandLine(record.pid);
    if (!cmd?.includes(record.url)) continue;
    killTree(record.pid);
    killed.push(record.pid);
  }
  // Re-read: a player recorded while we were checking must survive.
  const done = new Set(orphaned.map((r) => r.pid));
  writeRecords(
    file,
    readRecords(file).filter((r) => !done.has(r.pid)),
  );
  if (killed.length > 0) log("WARN", "radio", "stopped orphaned radio players", { pids: killed });
  return killed;
}
