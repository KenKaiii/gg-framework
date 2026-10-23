import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../core/logger.js";
import type { RunOutcome } from "./progress-manager.js";
import { ROYALE_BUG_CATEGORIES, type RoyaleBugCategory } from "./royale-bug.js";

// ── GG Royale (public hook only) ────────────────────────────────────────
// GG Royale is a private, web-hosted game mode. This module only links the
// device, mints a login code for the hosted page, and reports "a run finished
// / N commits / a goal made progress today / a deploy happened". The outcome
// payload is ONLY {kind, count, at} plus, on a run that fixed a failing check,
// a fixed-vocabulary `bug` label: never paths, repo names, goal names,
// prompts, commands or code.

/** The ONE place the default GG Royale server URL lives. Overridden by
 *  GG_ROYALE_URL or royale.json `serverUrl`. */
export const DEFAULT_ROYALE_URL = "https://gg-royale.buzzbeamaustralia.workers.dev";

const REPORT_TIMEOUT_MS = 5_000;
const OPEN_TIMEOUT_MS = 10_000;

export interface RoyaleFile {
  serverUrl?: string;
  playerId: string;
  deviceToken: string;
  linkedAt: number;
}

export interface RoyaleStatus {
  linked: boolean;
  serverUrl: string;
}

export interface RoyaleSummary {
  claimable: number;
  streak: number;
  playing: number;
}

export interface RoyaleOptions {
  agentDir: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface Royale {
  status: () => Promise<RoyaleStatus>;
  open: () => Promise<{ url: string }>;
  unlink: () => Promise<void>;
  /** Fire-and-forget; never throws, never awaits the network for the caller. */
  reportRun: (input: RunOutcome) => void;
  /** Badge counts; null when unlinked or on any error. Never throws. */
  summary: () => Promise<RoyaleSummary | null>;
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

function stripSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function isRoyaleFile(v: unknown): v is RoyaleFile {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.playerId === "string" &&
    typeof o.deviceToken === "string" &&
    o.deviceToken.length > 0 &&
    typeof o.linkedAt === "number" &&
    (o.serverUrl === undefined || typeof o.serverUrl === "string")
  );
}

export function createRoyale(opts: RoyaleOptions): Royale {
  const filePath = path.join(opts.agentDir, "royale.json");
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;

  async function read(): Promise<RoyaleFile | null> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
      return isRoyaleFile(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** The server this app talks to: GG_ROYALE_URL when set, else the live game. */
  function target(): string {
    const fromEnv = env.GG_ROYALE_URL;
    return stripSlashes(fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_ROYALE_URL);
  }
  /**
   * The saved link, only if it was made with the server we're talking to. A
   * link (and its device token) belongs to one server: it's never sent to
   * another, and a link to a dev server doesn't stick once you're back on the
   * live game. Links saved before serverUrl was always stored are live links.
   */
  async function link(): Promise<RoyaleFile | null> {
    const file = await read();
    if (!file) return null;
    return stripSlashes(file.serverUrl ?? DEFAULT_ROYALE_URL) === target() ? file : null;
  }
  async function register(base: string): Promise<RoyaleFile> {
    const reg = await postJson(`${base}/api/device/register`, {
      client: "gg-coder",
      version: opts.version,
    });
    const r = reg as { playerId?: unknown; deviceToken?: unknown } | null;
    if (
      typeof r?.playerId !== "string" ||
      typeof r.deviceToken !== "string" ||
      r.deviceToken.length === 0
    ) {
      throw new Error("The GG Royale server sent an unexpected sign-up response.");
    }
    const file: RoyaleFile = {
      playerId: r.playerId,
      deviceToken: r.deviceToken,
      linkedAt: now(),
      serverUrl: base,
    };
    await write(file);
    return file;
  }

  async function write(file: RoyaleFile): Promise<void> {
    await fs.mkdir(opts.agentDir, { recursive: true });
    // The device token is private from its first byte: write a 0600 temp
    // file and rename it into place (no moment where others can read it).
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

  async function postJson(url: string, body: unknown, token?: string): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
      });
    } catch {
      throw new Error("Couldn't reach the GG Royale server. Check your connection and try again.");
    }
    if (!res.ok) {
      throw Object.assign(
        new Error(`The GG Royale server returned an error (HTTP ${res.status}).`),
        { status: res.status },
      );
    }
    try {
      return await res.json();
    } catch {
      throw new Error("The GG Royale server sent a response the app couldn't read.");
    }
  }

  async function status(): Promise<RoyaleStatus> {
    const file = await link();
    return { linked: file !== null, serverUrl: target() };
  }

  async function open(): Promise<{ url: string }> {
    const base = target();
    let file = (await link()) ?? (await register(base));
    const code = async (f: RoyaleFile) =>
      (await postJson(`${base}/api/device/login-code`, undefined, f.deviceToken)) as {
        code?: unknown;
      } | null;
    let codeRes: { code?: unknown } | null;
    try {
      codeRes = await code(file);
    } catch (err) {
      // The server no longer knows this link (reset or removed): link again, once.
      if ((err as { status?: number }).status !== 401) throw err;
      file = await register(base);
      codeRes = await code(file);
    }
    if (typeof codeRes?.code !== "string" || codeRes.code.length === 0) {
      throw new Error("The GG Royale server sent an unexpected sign-in response.");
    }
    return { url: `${base}/#code=${encodeURIComponent(codeRes.code)}` };
  }

  async function unlink(): Promise<void> {
    await fs.rm(filePath, { force: true });
  }

  function send(
    base: string,
    token: string,
    kind: "run" | "commit" | "goal" | "deploy",
    count: number,
    bug?: RoyaleBugCategory | null,
  ): void {
    // Payload is deliberately ONLY kind/count/at (+ a whitelisted bug label).
    const safeBug = bug && (ROYALE_BUG_CATEGORIES as readonly string[]).includes(bug) ? bug : null;
    const body = JSON.stringify(
      safeBug ? { kind, count, at: now(), bug: safeBug } : { kind, count, at: now() },
    );
    void doFetch(`${base}/api/device/outcome`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    })
      .then((res) => {
        if (!res.ok) log("DEBUG", "royale", "outcome rejected", { status: String(res.status) });
      })
      .catch((err: unknown) => {
        log("DEBUG", "royale", "outcome failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // A goal counts once a day: the first of its runs that does real work
  // (commits, or work handed to workers). Remembered across restarts in a
  // tiny file holding only hashed goal ids for the current UTC day.
  const goalsFile = path.join(opts.agentDir, "royale-goals.json");
  const utcDay = (): string => new Date(now()).toISOString().slice(0, 10);
  async function firstGoalWorkToday(goalId: string): Promise<boolean> {
    const key = createHash("sha256").update(goalId).digest("hex").slice(0, 16);
    const day = utcDay();
    let seen: string[] = [];
    try {
      const parsed = JSON.parse(await fs.readFile(goalsFile, "utf8")) as {
        day?: unknown;
        goals?: unknown;
      };
      if (parsed.day === day && Array.isArray(parsed.goals)) {
        seen = parsed.goals.filter((g): g is string => typeof g === "string");
      }
    } catch {
      // No file yet, or unreadable: a fresh day.
    }
    if (seen.includes(key)) return false;
    const tmp = `${goalsFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ day, goals: [...seen, key] }));
    await fs.rename(tmp, goalsFile);
    return true;
  }

  function reportRun({ commits, bug, goalId, workers, deployed }: RunOutcome): void {
    void link()
      .then(async (file) => {
        if (!file) return;
        const base = target();
        send(base, file.deviceToken, "run", 1, bug);
        const n = Number.isFinite(commits) ? Math.floor(commits) : 0;
        if (n > 0) send(base, file.deviceToken, "commit", n);
        if (deployed) send(base, file.deviceToken, "deploy", 1);
        if (goalId && (n > 0 || workers) && (await firstGoalWorkToday(goalId))) {
          send(base, file.deviceToken, "goal", 1);
        }
      })
      .catch((err: unknown) => {
        log("DEBUG", "royale", "report failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }

  async function summary(): Promise<RoyaleSummary | null> {
    try {
      const file = await link();
      if (!file) return null;
      const res = await doFetch(`${target()}/api/device/summary`, {
        headers: { authorization: `Bearer ${file.deviceToken}` },
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      });
      if (!res.ok) {
        log("DEBUG", "royale", "summary rejected", { status: String(res.status) });
        return null;
      }
      const body: unknown = await res.json();
      if (typeof body !== "object" || body === null) return null;
      const o = body as Record<string, unknown>;
      return { claimable: count(o.claimable), streak: count(o.streak), playing: count(o.playing) };
    } catch (err) {
      log("DEBUG", "royale", "summary failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  return { status, open, unlink, reportRun, summary };
}
