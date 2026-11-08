import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../core/logger.js";

// ── Weekly poll (Home) ─────────────────────────────────────────────────
// The owner's weekly feature poll, from the gg-poll Worker. A device votes
// under a hash of its OS machine id (salted for the poll only, so the raw id
// never leaves the machine and can't be matched to other apps); deleting
// ~/.gg or reinstalling doesn't mint a second vote. Without a machine id it
// falls back to a random id kept in ~/.gg/poll.json, which also holds this
// device's picks so Home can mark them. The server stores only a hash.

/** The poll server. GG_POLL_URL overrides it. */
export const DEFAULT_POLL_URL = "https://gg-poll.buzzbeamaustralia.workers.dev";

const POLL_TIMEOUT_MS = 8_000;
const DEVICE_SALT = "gg-poll-v1:";

/** The OS machine id from the platform tool's output, or null. Exported for tests. */
export function parseMachineId(platform: NodeJS.Platform, output: string): string | null {
  const m =
    platform === "darwin"
      ? /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output)
      : platform === "win32"
        ? /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(output)
        : /^([0-9a-f]{32})\s*$/im.exec(output);
  const id = m?.[1]?.trim();
  return id && id.length >= 16 ? id : null;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 5_000, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    ),
  );
}

/** This machine's OS id (stable across reinstalls), or null when it can't be read. */
export async function readMachineId(): Promise<string | null> {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      return parseMachineId(
        platform,
        await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]),
      );
    }
    if (platform === "win32") {
      const reg = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
      const key = "HKLM\\SOFTWARE\\Microsoft\\Cryptography";
      return parseMachineId(
        platform,
        await run(reg, ["query", key, "/v", "MachineGuid", "/reg:64"]),
      );
    }
    for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      const id = parseMachineId(platform, await fs.readFile(file, "utf8").catch(() => ""));
      if (id) return id;
    }
  } catch (e) {
    log("WARN", "poll", `no machine id: ${e instanceof Error ? e.message : String(e)}`);
  }
  return null;
}

/** The voter id sent for a machine id: salted SHA-256, base64url (43 chars). */
export function deviceVoterId(machineId: string): string {
  return createHash("sha256")
    .update(DEVICE_SALT + machineId)
    .digest("base64url");
}

export interface Poll {
  id: string;
  question: string;
  options: string[];
  closesAt: number;
}

/**
 * What Home shows. `status` is the server's HTTP status, or 0 when it
 * couldn't be reached; `poll` is null when no poll is open. Never thrown.
 */
export interface PollState {
  status: number;
  poll: Poll | null;
  counts: number[];
  total: number;
  /** This install's pick in the open poll, or null. */
  myChoice: number | null;
  error?: string;
}

interface PollFile {
  voterId: string;
  picks: Record<string, number>;
}

export interface PollClientOptions {
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Reads the OS machine id; defaults to readMachineId. */
  machineId?: () => Promise<string | null>;
}

export interface PollClient {
  current: () => Promise<PollState>;
  vote: (pollId: string, choice: number) => Promise<PollState>;
}

function isPollFile(v: unknown): v is PollFile {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.voterId === "string" &&
    o.voterId.length >= 22 &&
    typeof o.picks === "object" &&
    o.picks !== null &&
    !Array.isArray(o.picks)
  );
}

function parsePoll(v: unknown): Poll | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (
    typeof o.id !== "string" ||
    typeof o.question !== "string" ||
    typeof o.closesAt !== "number" ||
    !Array.isArray(o.options) ||
    o.options.length < 2 ||
    !o.options.every((x) => typeof x === "string")
  ) {
    return null;
  }
  return { id: o.id, question: o.question, options: o.options as string[], closesAt: o.closesAt };
}

export function createPollClient(opts: PollClientOptions): PollClient {
  const filePath = path.join(opts.agentDir, "poll.json");
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;
  const readId = opts.machineId ?? readMachineId;
  let device: Promise<string | null> | null = null;

  function base(): string {
    const fromEnv = env.GG_POLL_URL;
    return (fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_POLL_URL).replace(/\/+$/, "");
  }

  async function read(): Promise<PollFile | null> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
      return isPollFile(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function write(file: PollFile): Promise<void> {
    await fs.mkdir(opts.agentDir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(file, null, 2), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(tmp, filePath);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
    await fs.chmod(filePath, 0o600).catch(() => {});
  }

  async function voterFile(): Promise<PollFile> {
    const existing = await read();
    if (existing) return existing;
    const file: PollFile = { voterId: randomBytes(32).toString("base64url"), picks: {} };
    await write(file);
    return file;
  }

  /** The server reply as Home's state; `myChoice` comes from this install's picks. */
  async function toState(res: Response, picks: Record<string, number>): Promise<PollState> {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const error = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
      return { status: res.status, poll: null, counts: [], total: 0, myChoice: null, error };
    }
    const poll = parsePoll(body?.poll);
    if (!poll) return { status: res.status, poll: null, counts: [], total: 0, myChoice: null };
    const raw = Array.isArray(body?.counts) ? body.counts : [];
    const counts = poll.options.map((_, i) => (typeof raw[i] === "number" ? raw[i] : 0));
    const total = counts.reduce((a, b) => a + b, 0);
    const pick = picks[poll.id];
    const myChoice = typeof pick === "number" && pick >= 0 && pick < counts.length ? pick : null;
    return { status: res.status, poll, counts, total, myChoice };
  }

  function unreachable(e: unknown): PollState {
    log("WARN", "poll", `poll server unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return { status: 0, poll: null, counts: [], total: 0, myChoice: null, error: "unreachable" };
  }

  return {
    async current() {
      try {
        // Reading the poll sends no voter id; the picks stay on this machine.
        const res = await doFetch(`${base()}/api/poll/current`, {
          signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
        });
        return await toState(res, (await read())?.picks ?? {});
      } catch (e) {
        return unreachable(e);
      }
    },
    async vote(pollId, choice) {
      try {
        const file = await voterFile();
        device ??= readId().then((id) => (id ? deviceVoterId(id) : null));
        const voter = (await device) ?? file.voterId;
        const res = await doFetch(`${base()}/api/poll/vote`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pollId, voter, choice }),
          signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
        });
        if (!res.ok) return await toState(res, file.picks);
        // Only the open poll's pick is kept; older weeks' picks are dropped.
        const picks = { [pollId]: choice };
        await write({ voterId: file.voterId, picks });
        return await toState(res, picks);
      } catch (e) {
        return unreachable(e);
      }
    },
  };
}
