import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "../oauth/types.js";

// Nous Portal through Hermes Agent, the way Nous documents for other apps:
// Hermes keeps the Portal sign-in, and its subscription proxy
// (`hermes proxy start`) serves the subscription as an OpenAI-compatible
// endpoint on loopback, attaching the real credential to each request. The
// Portal only issues tokens to its own allowlisted clients, so GG Coder never
// holds a Nous token: auth.json gets the proxy address.
// https://hermes-agent.nousresearch.com/docs/user-guide/features/subscription-proxy

/** auth.json key of the Nous Portal connection (the proxy address, not a token). */
export const NOUS_AUTH_KEY = "nous";
/** Prefix on registry ids: Portal ids repeat OpenRouter's, and models resolve by bare id. */
export const NOUS_MODEL_PREFIX = "nous/";
/** The proxy's documented default port. */
export const HERMES_PROXY_PORT = 8645;
export const HERMES_PROXY_BASE_URL = `http://127.0.0.1:${HERMES_PROXY_PORT}/v1`;
export const HERMES_INSTALL_URL =
  "https://hermes-agent.nousresearch.com/docs/getting-started/installation";
/** The proxy ignores the bearer it receives and attaches the real one. */
const PROXY_BEARER = "hermes-proxy";
const CREDENTIAL_LIFETIME_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const STATUS_TIMEOUT_MS = 60_000;
const PROXY_START_TIMEOUT_MS = 30_000;

export class HermesNotInstalledError extends Error {
  constructor() {
    super(
      `Nous Portal connects through Hermes Agent, which isn't installed. Install it from ${HERMES_INSTALL_URL}, then try again.`,
    );
    this.name = "HermesNotInstalledError";
  }
}

export interface HermesRunOptions {
  /** Hermes executable; resolved from PATH and the installer's locations when omitted. */
  binary?: string;
  /** Arguments placed before Hermes's own (tests run a script through Node). */
  binaryArgs?: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** What GG Coder stores for a Nous Portal connection: where the proxy listens. */
export function hermesProxyCredential(now = Date.now()): OAuthCredentials {
  return {
    accessToken: PROXY_BEARER,
    refreshToken: "",
    expiresAt: now + CREDENTIAL_LIFETIME_MS,
    baseUrl: HERMES_PROXY_BASE_URL,
  };
}

/**
 * The Hermes executable: PATH first, then where the official installer puts it
 * (`%LOCALAPPDATA%\hermes\bin` on Windows, `~/.local/bin` elsewhere), since a
 * desktop app often starts without the user's shell PATH.
 */
export function resolveHermesBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const name = platform === "win32" ? "hermes.exe" : "hermes";
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":");
  if (platform === "win32") {
    if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, "hermes", "bin"));
  } else {
    dirs.push(join(env.HOME ?? os.homedir(), ".local", "bin"));
  }
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

function spawnHermes(args: string[], opts: HermesRunOptions, extra: SpawnOptions = {}) {
  const binary = opts.binary ?? resolveHermesBinary(opts.env);
  if (!binary) throw new HermesNotInstalledError();
  return spawn(binary, [...(opts.binaryArgs ?? []), ...args], {
    env: hermesEnv(opts),
    // No stdin: any yes/no prompt takes its default instead of hanging.
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...extra,
  });
}

/** Hermes is Python: unbuffered so progress lines arrive as they print, plain text, UTF-8. */
function hermesEnv(opts: HermesRunOptions): NodeJS.ProcessEnv {
  return {
    ...(opts.env ?? process.env),
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    NO_COLOR: "1",
  };
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** The last few non-empty lines of a run, for an error that says what Hermes said. */
function tail(output: string, lines = 3): string {
  return stripAnsi(output)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(" ");
}

function runHermes(
  args: string[],
  opts: HermesRunOptions,
  timeoutMs = STATUS_TIMEOUT_MS,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnHermes(args, opts, { signal: opts.signal, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** True when Hermes holds a Nous Portal sign-in (`hermes auth status nous`). */
export async function hermesNousLoggedIn(opts: HermesRunOptions = {}): Promise<boolean> {
  const { stdout } = await runHermes(["auth", "status", "nous"], opts);
  // "nous: logged in" vs "nous: not logged in".
  return /\bnous:\s*logged in\b/i.test(stripAnsi(stdout));
}

/** The verification link and user code Hermes prints for the device sign-in. */
export function parseHermesDeviceCode(output: string): { url: string; code?: string } | null {
  const text = stripAnsi(output);
  const url = /Open:\s*(https:\/\/\S+)/.exec(text)?.[1];
  if (!url) return null;
  const code = /enter code:\s*([A-Z0-9-]+)/i.exec(text)?.[1];
  return code ? { url, code } : { url };
}

/**
 * Sign in to Nous Portal through Hermes (`hermes auth add nous --type oauth`).
 * Hermes runs the Portal's device sign-in and keeps the tokens; the
 * verification link goes to `onOpenUrl` so the host opens it once.
 */
export async function loginHermesNous(
  callbacks: OAuthLoginCallbacks,
  opts: HermesRunOptions = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnHermes(["auth", "add", "nous", "--type", "oauth", "--no-browser"], opts, {
      signal: opts.signal,
    });
    let output = "";
    let opened = false;
    const onData = (d: Buffer): void => {
      output += d.toString();
      if (opened) return;
      const device = parseHermesDeviceCode(output);
      if (!device) return;
      opened = true;
      callbacks.onOpenUrl(device.url);
      callbacks.onStatus(
        device.code
          ? `Approve code ${device.code} in your browser to finish signing in to Nous Portal…`
          : "Finish signing in to Nous Portal in your browser…",
      );
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Nous Portal sign-in failed: ${tail(output) || `exit ${code}`}`));
    });
  });
}

export interface HermesProxyHealth {
  /** The proxy answered and forwards to Nous Portal. */
  nous: boolean;
  /** Hermes holds a usable Portal credential. */
  authenticated: boolean;
}

/** The proxy's `/health` answer, or undefined when nothing answers there. */
export async function hermesProxyHealth(
  baseUrl = HERMES_PROXY_BASE_URL,
  fetchFn: typeof fetch = fetch,
): Promise<HermesProxyHealth | undefined> {
  try {
    const res = await fetchFn(`${new URL(baseUrl).origin}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { upstream?: unknown; authenticated?: unknown };
    return {
      nous: typeof body.upstream === "string" && /nous/i.test(body.upstream),
      authenticated: body.authenticated === true,
    };
  } catch {
    return undefined;
  }
}

/**
 * Start `hermes proxy start` for Nous Portal and wait until it answers. The
 * caller owns the returned process: it lives as long as the host and must be
 * stopped with it.
 */
export async function startHermesProxy(
  opts: HermesRunOptions & { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ChildProcess> {
  const child = spawnHermes(
    ["proxy", "start", "--provider", "nous", "--port", String(HERMES_PROXY_PORT)],
    opts,
  );
  let output = "";
  child.stdout?.on("data", (d: Buffer) => (output = (output + d.toString()).slice(-4_000)));
  child.stderr?.on("data", (d: Buffer) => (output = (output + d.toString()).slice(-4_000)));
  let exited = false;
  child.once("exit", () => (exited = true));
  child.once("error", () => (exited = true));
  const deadline = Date.now() + (opts.timeoutMs ?? PROXY_START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`The Hermes proxy stopped: ${tail(output) || "no output"}`);
    }
    if ((await hermesProxyHealth(HERMES_PROXY_BASE_URL, opts.fetch))?.nous) return child;
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error("The Hermes proxy didn't start in time.");
}
