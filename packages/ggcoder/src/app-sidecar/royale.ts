import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../core/logger.js";

// ── GG World device link ────────────────────────────────────────────────
// One device link per install, used only for GG World online save and the
// live world. It lives in ~/.gg/royale.json (the name is from GG Royale, now
// closed; the file and its format are unchanged so existing players keep
// their account). The device token is only ever sent to the server it was
// minted for.

/** The live GG World server. GG_WORLD_URL overrides it. */
export const DEFAULT_WORLD_URL = "https://gg-world.buzzbeamaustralia.workers.dev";

/** The retired GG Royale server. Links made with it belong to the live World
 *  server (same database), so they are never re-registered. */
export const LEGACY_ROYALE_URL = "https://gg-royale.buzzbeamaustralia.workers.dev";

const WORLD_TIMEOUT_MS = 8_000;
const REGISTER_TIMEOUT_MS = 10_000;

export interface RoyaleFile {
  serverUrl?: string;
  playerId: string;
  deviceToken: string;
  linkedAt: number;
}

/**
 * A World server reply, passed through for the app to read: `status` is the
 * HTTP status (409 stale ver, 400 validation with `body.error`, ...), or 0
 * when the server couldn't be reached. Never throws.
 */
export interface WorldResult {
  status: number;
  body: unknown;
}

export interface WorldLinkOptions {
  agentDir: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface WorldLink {
  /** GET /api/world/profile. Signs up on first use. */
  worldGet: () => Promise<WorldResult>;
  /** PUT /api/world/profile with `{ ver, patch }`. */
  worldPut: (ver: number, patch: unknown) => Promise<WorldResult>;
  /** DELETE /api/world/me (the online save only). */
  worldDelete: () => Promise<WorldResult>;
  /** POST /api/world/live: a one-time live-world ticket `{ world, ticket, url }`. */
  worldLive: () => Promise<WorldResult>;
  /** DELETE /api/world/account; on success the local link file is removed. */
  accountDelete: () => Promise<WorldResult>;
}

function stripSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The server a saved link belongs to: missing or the old Royale URL = live World. */
function linkServer(file: RoyaleFile): string {
  const url = stripSlashes(file.serverUrl ?? DEFAULT_WORLD_URL);
  return url === LEGACY_ROYALE_URL ? DEFAULT_WORLD_URL : url;
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

export function createWorldLink(opts: WorldLinkOptions): WorldLink {
  const filePath = path.join(opts.agentDir, "royale.json");
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;

  function base(): string {
    const fromEnv = env.GG_WORLD_URL;
    return stripSlashes(fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_WORLD_URL);
  }

  async function read(): Promise<RoyaleFile | null> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
      return isRoyaleFile(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** The saved link, only if it belongs to the server we're talking to. */
  async function link(): Promise<RoyaleFile | null> {
    const file = await read();
    return file && linkServer(file) === base() ? file : null;
  }

  async function write(file: RoyaleFile): Promise<void> {
    await fs.mkdir(opts.agentDir, { recursive: true });
    // The device token is private from its first byte: write a 0600 temp
    // file and rename it into place.
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

  async function register(server: string): Promise<RoyaleFile> {
    const res = await doFetch(`${server}/api/world/device/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: "gg-coder", version: opts.version }),
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`World sign-up failed (HTTP ${res.status}).`);
    const r = (await res.json()) as { playerId?: unknown; deviceToken?: unknown } | null;
    if (
      typeof r?.playerId !== "string" ||
      typeof r.deviceToken !== "string" ||
      r.deviceToken.length === 0
    ) {
      throw new Error("The World server sent an unexpected sign-up response.");
    }
    const file: RoyaleFile = {
      playerId: r.playerId,
      deviceToken: r.deviceToken,
      linkedAt: now(),
      serverUrl: server,
    };
    await write(file);
    return file;
  }

  async function world(
    method: "GET" | "PUT" | "DELETE" | "POST",
    route: string,
    body?: unknown,
  ): Promise<WorldResult> {
    const server = base();
    try {
      const linked = await link();
      // Nothing to delete without a link: don't sign up just to delete.
      if (!linked && method === "DELETE") return { status: 200, body: { deleted: true } };
      const file = linked ?? (await register(server));
      const res = await doFetch(`${server}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${file.deviceToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(WORLD_TIMEOUT_MS),
      });
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed };
    } catch (err) {
      log("DEBUG", "world", "world request failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      return { status: 0, body: { error: "Couldn't reach the server." } };
    }
  }

  async function accountDelete(): Promise<WorldResult> {
    const result = await world("DELETE", "/api/world/account");
    // 404: the server no longer knows this device, so the account is gone too.
    if ((result.status >= 200 && result.status < 300) || result.status === 404) {
      await fs.rm(filePath, { force: true }).catch(() => {});
    }
    return result;
  }

  return {
    worldGet: () => world("GET", "/api/world/profile"),
    worldPut: (ver, patch) => world("PUT", "/api/world/profile", { ver, patch }),
    worldDelete: () => world("DELETE", "/api/world/me"),
    worldLive: () => world("POST", "/api/world/live", {}),
    accountDelete,
  };
}
