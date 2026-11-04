import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ProcessTreeKillOptions {
  platform?: NodeJS.Platform;
  kill?: typeof process.kill;
  spawnSync?: typeof spawnSync;
  env?: NodeJS.ProcessEnv;
  taskkillTimeoutMs?: number;
}

const DEFAULT_TASKKILL_TIMEOUT_MS = 5_000;

function getEnvCaseInsensitive(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.entries(env).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

/**
 * Absolute path to `taskkill.exe`.
 *
 * Bare `"taskkill"` depends on `System32` being on PATH — not guaranteed for a
 * GUI-launched app whose PATH we also mutate — and is spoofable by a
 * `taskkill.exe` sitting in the project cwd. Resolve it from `SystemRoot`
 * (falling back to `WINDIR`, then `C:\Windows`), rejecting anything that isn't
 * a plain drive-rooted path.
 */
export function resolveWindowsTaskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const normalize = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const root = value.trim();
    const unsafe = [...root].some((ch) => ch === ";" || ch.charCodeAt(0) <= 31);
    if (!/^[A-Za-z]:[\\/]/.test(root) || unsafe) return undefined;
    return path.win32.normalize(root);
  };
  const systemRoot =
    normalize(getEnvCaseInsensitive(env, "SystemRoot")) ??
    normalize(getEnvCaseInsensitive(env, "WINDIR")) ??
    "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "taskkill.exe");
}

/**
 * Kill a process and every descendant.
 *
 * POSIX: SIGKILL the process group (negative pid), falling back to the single
 * pid. Windows has no process groups and negative pids are invalid there — the
 * POSIX path silently left the whole child tree running, so a timed-out or
 * cancelled `bash` command kept its `npm`/`node`/`pnpm` descendants alive
 * forever. Use `taskkill /T /F` instead, falling back to the direct pid.
 */
export function killProcessTree(pid: number, options: ProcessTreeKillOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const kill = options.kill ?? process.kill;

  if (platform !== "win32") {
    try {
      kill(-pid, "SIGKILL");
      return;
    } catch {
      killSingleProcess(pid, kill);
      return;
    }
  }

  const executable = resolveWindowsTaskkillPath(options.env);
  try {
    const result = (options.spawnSync ?? spawnSync)(executable, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: options.taskkillTimeoutMs ?? DEFAULT_TASKKILL_TIMEOUT_MS,
    });
    if (result.status === 0 && result.error === undefined) return;
  } catch {
    // Fall through to the direct-pid fallback below.
  }
  killSingleProcess(pid, kill);
}

function killSingleProcess(pid: number, kill: typeof process.kill): void {
  try {
    kill(pid, "SIGKILL");
  } catch {
    // Process already exited.
  }
}

export interface ProcessTableOptions {
  platform?: NodeJS.Platform;
  /** Injected for tests: returns `[pid, ppid]` pairs for every process. */
  readTable?: () => Array<[number, number]>;
}

/** `[pid, ppid]` for every live process, from `/proc` (Linux) or `ps`. */
function readProcessTable(platform: NodeJS.Platform): Array<[number, number]> {
  if (platform === "linux") {
    try {
      const rows: Array<[number, number]> = [];
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          // `pid (comm) state ppid …` — comm may contain spaces/parens, so
          // parse from the LAST `)`.
          const stat = readFileSync(`/proc/${name}/stat`, "utf-8");
          const ppid = parseInt(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1] ?? "", 10);
          if (!Number.isNaN(ppid)) rows.push([Number(name), ppid]);
        } catch {
          // Exited mid-scan.
        }
      }
      if (rows.length > 0) return rows;
    } catch {
      // No readable /proc — fall through to ps.
    }
  }
  // Absolute path when present: a bare `ps` is resolvable through a PATH we
  // do not control.
  const ps = existsSync("/bin/ps") ? "/bin/ps" : "ps";
  const res = spawnSync(ps, ["-A", "-o", "pid=", "-o", "ppid="], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
  if (res.status !== 0 || typeof res.stdout !== "string") return [];
  const rows: Array<[number, number]> = [];
  for (const line of res.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) rows.push([pid!, ppid!]);
  }
  return rows;
}

/**
 * Every live descendant of `pid` (breadth-first, excluding `pid` itself),
 * found by parent links — so it also covers children that left the process
 * group, unlike a group kill. POSIX only; returns `[]` on Windows, where
 * shell pids (msys) do not map onto the native process table.
 */
export function listDescendantPids(pid: number, options: ProcessTableOptions = {}): number[] {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return [];
  const table = options.readTable ? options.readTable() : readProcessTable(platform);
  const children = new Map<number, number[]>();
  for (const [child, parent] of table) {
    if (child === parent) continue;
    const list = children.get(parent);
    if (list) list.push(child);
    else children.set(parent, [child]);
  }
  const seen = new Set<number>();
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (child === pid || seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen];
}

/**
 * Signal every descendant of `pid` without touching `pid` itself — stops a
 * persistent shell's running command while the shell survives. Returns how
 * many processes were signalled.
 */
export function signalDescendants(
  pid: number,
  signal: NodeJS.Signals,
  options: ProcessTableOptions & { kill?: typeof process.kill } = {},
): number {
  const kill = options.kill ?? process.kill;
  let signalled = 0;
  for (const child of listDescendantPids(pid, options)) {
    try {
      kill(child, signal);
      signalled++;
    } catch {
      // Already gone.
    }
  }
  return signalled;
}
