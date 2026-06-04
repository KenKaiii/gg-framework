/**
 * Kimi Code OAuth — Device Authorization Grant (RFC 8628).
 *
 * Mirrors MoonshotAI/kimi-code's managed-auth flow. Three form-encoded
 * POST endpoints against the OAuth host (default `https://auth.kimi.com`):
 *
 *  - `/api/oauth/device_authorization` (client_id)           → device + user code
 *  - `/api/oauth/token` (grant_type=device_code)             → poll until authorized
 *  - `/api/oauth/token` (grant_type=refresh_token)           → refresh access token
 *
 * Unlike Anthropic/OpenAI/Gemini (browser-redirect PKCE), this is a
 * device-code/poll flow: we show the user a URL + code, they authorize in a
 * browser on any device, and we poll for the token.
 *
 * After login the issued token is used against the managed coding API
 * (`https://api.kimi.com/coding/v1`, distinct from the `api.moonshot.ai`
 * API-key endpoint) via `Authorization: Bearer <access_token>`. We persist
 * that base URL on the credential so the runtime routes there automatically.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, hostname, release, type } from "node:os";
import path from "node:path";

import { getAppPaths } from "../paths.js";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types.js";

/** Public OAuth client id registered by Kimi Code (no client secret / PKCE). */
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEFAULT_CODING_BASE_URL = "https://api.kimi.com/coding/v1";

/** Platform identifier Kimi Code reports for the device flow. */
const KIMI_PLATFORM = "kimi_code_cli";
// Matches a real published kimi-code-cli release. The managed endpoint gates
// on the `kimi-code-cli` client identity; keep this aligned with an actual
// release (overridable via KIMI_CODE_VERSION) to avoid a version-ahead reject.
const DEFAULT_KIMI_VERSION = "0.9.0";

/** Local wall-clock budget for the whole device flow (15 min, matches Kimi). */
const DEVICE_TIMEOUT_MS = 15 * 60 * 1000;

function oauthHost(): string {
  const host =
    process.env.KIMI_CODE_OAUTH_HOST ?? process.env.KIMI_OAUTH_HOST ?? DEFAULT_OAUTH_HOST;
  return host.replace(/\/+$/, "");
}

/** Managed coding API base URL the issued OAuth token is used against. */
export function kimiCodeBaseUrl(): string {
  return (process.env.KIMI_CODE_BASE_URL ?? DEFAULT_CODING_BASE_URL).replace(/\/+$/, "");
}

function kimiVersion(): string {
  const v = process.env.KIMI_CODE_VERSION ?? DEFAULT_KIMI_VERSION;
  return asciiHeader(v, DEFAULT_KIMI_VERSION);
}

function asciiHeader(value: string, fallback = "unknown"): string {
  const cleaned = value.replace(/[^\u0020-\u007E]/g, "").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function macOsProductVersion(): string | undefined {
  try {
    const version = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf-8",
      timeout: 1000,
    }).trim();
    return version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

function deviceModel(): string {
  const os = type();
  const version = release();
  const osArch = arch();
  if (os === "Darwin") return `macOS ${macOsProductVersion() ?? version} ${osArch}`;
  if (os === "Windows_NT") return `Windows ${version} ${osArch}`;
  return `${os} ${version} ${osArch}`.trim();
}

/** Stable per-machine device id, persisted under the gg config dir. */
function deviceId(): string {
  const idPath = path.join(getAppPaths().agentDir, "kimi_device_id");
  if (existsSync(idPath)) {
    try {
      const text = readFileSync(idPath, "utf-8").trim();
      if (text.length > 0) return text;
    } catch {
      // fall through to regenerate
    }
  }
  const id = randomUUID();
  try {
    mkdirSync(getAppPaths().agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(idPath, id, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // best-effort: in-memory id still works for this run
  }
  return id;
}

function deviceHeaders(): Record<string, string> {
  return {
    "X-Msh-Platform": KIMI_PLATFORM,
    "X-Msh-Version": kimiVersion(),
    "X-Msh-Device-Name": asciiHeader(hostname()),
    "X-Msh-Device-Model": asciiHeader(deviceModel()),
    "X-Msh-Os-Version": asciiHeader(release()),
    "X-Msh-Device-Id": deviceId(),
  };
}

/**
 * Headers the Kimi For Coding API requires on every model request. The
 * managed endpoint gates access to recognized coding agents: requests must
 * carry a `kimi_code_cli` platform identity and matching `User-Agent`, or the
 * server rejects with "only available for Coding Agents". Attach these to the
 * inference client's default headers whenever the Kimi OAuth token is used.
 */
export function kimiCodingHeaders(): Record<string, string> {
  return {
    "User-Agent": `kimi-code-cli/${kimiVersion()}`,
    ...deviceHeaders(),
  };
}

/**
 * True if `baseUrl` targets the Kimi For Coding managed endpoint (the URL
 * persisted on Kimi OAuth credentials). Callers use this to decide whether to
 * attach `kimiCodingHeaders()` — the Moonshot API-key path uses a different
 * host and must NOT receive the coding-agent identity headers.
 */
export function isKimiCodingEndpoint(baseUrl: string | undefined): boolean {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return false;
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized === kimiCodeBaseUrl() || /(^|\.)kimi\.com/i.test(normalized);
}

async function postForm(
  endpoint: string,
  params: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${oauthHost()}${endpoint}`, {
    method: "POST",
    headers: {
      ...deviceHeaders(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    // non-JSON response — interpret by status
  }
  return { status: response.status, data };
}

function errorDetail(data: Record<string, unknown>): string {
  const desc = data.error_description ?? data.message ?? data.error;
  return typeof desc === "string" && desc.length > 0 ? desc : "unknown error";
}

function credsFromTokenResponse(data: Record<string, unknown>): OAuthCredentials {
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const expiresIn = Number(data.expires_in);
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Kimi OAuth response missing access_token.");
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new Error("Kimi OAuth response missing refresh_token.");
  }
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Kimi OAuth response missing or invalid expires_in.");
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    baseUrl: kimiCodeBaseUrl(),
  };
}

interface DeviceAuthorization {
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
}

async function requestDeviceAuthorization(): Promise<DeviceAuthorization> {
  const { status, data } = await postForm("/api/oauth/device_authorization", {
    client_id: CLIENT_ID,
  });
  if (status !== 200) {
    throw new Error(`Kimi device authorization failed (${status}): ${errorDetail(data)}`);
  }
  const userCode = data.user_code;
  const deviceCode = data.device_code;
  const verificationUriComplete = data.verification_uri_complete;
  if (typeof userCode !== "string" || typeof deviceCode !== "string") {
    throw new Error("Kimi device authorization response missing user_code/device_code.");
  }
  return {
    userCode,
    deviceCode,
    verificationUri: typeof data.verification_uri === "string" ? data.verification_uri : "",
    verificationUriComplete:
      typeof verificationUriComplete === "string" ? verificationUriComplete : "",
    interval: Number(data.interval ?? 5) || 5,
  };
}

type PollResult =
  | { kind: "success"; creds: OAuthCredentials }
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "expired" }
  | { kind: "denied" };

async function pollDeviceToken(deviceCode: string): Promise<PollResult> {
  const { status, data } = await postForm("/api/oauth/token", {
    client_id: CLIENT_ID,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (status === 200 && typeof data.access_token === "string") {
    return { kind: "success", creds: credsFromTokenResponse(data) };
  }
  if (status >= 500) {
    throw new Error(`Kimi token polling server error (${status}): ${errorDetail(data)}`);
  }
  const errorCode = typeof data.error === "string" ? data.error : "unknown_error";
  switch (errorCode) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down" };
    case "expired_token":
      return { kind: "expired" };
    case "access_denied":
      return { kind: "denied" };
    default:
      throw new Error(`Kimi token polling failed (${status}): ${errorDetail(data)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Drive the Kimi device-code flow end-to-end. Shows the verification URL +
 * user code via callbacks, opens the browser, and polls until the user
 * authorizes (or a 15-minute local timeout elapses).
 */
export async function loginKimi(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const auth = await requestDeviceAuthorization();

  callbacks.onStatus(
    `Visit ${auth.verificationUri || auth.verificationUriComplete} and enter code: ${auth.userCode}`,
  );
  callbacks.onOpenUrl(auth.verificationUriComplete || auth.verificationUri);
  callbacks.onStatus("Waiting for you to authorize in the browser...");

  const deadline = Date.now() + DEVICE_TIMEOUT_MS;
  let interval = Math.max(auth.interval, 1);

  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const result = await pollDeviceToken(auth.deviceCode);
    if (result.kind === "success") return result.creds;
    if (result.kind === "denied") {
      throw new Error("Kimi authorization was denied.");
    }
    if (result.kind === "expired") {
      throw new Error("Kimi device code expired. Please run login again.");
    }
    if (result.kind === "slow_down") {
      interval += 5;
    }
    // pending → keep polling
  }

  throw new Error("Kimi login timed out. Please run login again.");
}

/** Exchange a refresh token for a fresh Kimi access token. */
export async function refreshKimiToken(refreshToken: string): Promise<OAuthCredentials> {
  const { status, data } = await postForm("/api/oauth/token", {
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (status === 200 && typeof data.access_token === "string") {
    return credsFromTokenResponse(data);
  }
  const errorCode = typeof data.error === "string" ? data.error : "";
  // Surface 401/403/invalid_grant in a shape AuthStorage's refresh-failure
  // detection recognizes, so dead refresh tokens get wiped for re-login.
  throw new Error(`Kimi token refresh failed (${status}): ${errorCode || errorDetail(data)}`);
}
