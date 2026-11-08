/**
 * Grok (xAI) subscription OAuth — Device Authorization Grant (RFC 8628).
 *
 * Two form-encoded POST endpoints against xAI's OIDC issuer (`https://auth.x.ai`,
 * advertised by its `/.well-known/openid-configuration`):
 *
 *  - `/oauth2/device/code` (client_id + scope)          → device + user code
 *  - `/oauth2/token` (grant_type=device_code)           → poll until authorized
 *  - `/oauth2/token` (grant_type=refresh_token)         → refresh access token
 *
 * Like Kimi (and unlike Anthropic/OpenAI/Gemini's browser-redirect PKCE) this is
 * a device-code/poll flow: show a URL + code, the user authorizes in a browser on
 * any device, we poll for the token. Deliberately chosen over the loopback PKCE
 * variant because xAI pins the Grok-CLI client's redirect to
 * `http://127.0.0.1:56121/callback` — a fixed port we cannot rebind if it's busy,
 * and unreachable from a container/SSH session. Device code has neither problem.
 *
 * The issued token is used against the Grok CLI's chat proxy
 * (`https://cli-chat-proxy.grok.com/v1`, distinct from the `api.x.ai` API-key
 * endpoint) — that is the surface the `grok-cli:access` scope grants, and it
 * bills against the user's SuperGrok / X Premium subscription instead of metered
 * API credits. We persist that base URL on the credential so the runtime routes
 * there automatically; `grokCliHeaders()` supplies the client identity the proxy
 * requires (attached centrally in gg-ai's `xai` transport).
 *
 * Caveats worth knowing, both observed in the wild and surfaced to users rather
 * than hidden here:
 *  - The client id below is xAI's public Grok-CLI desktop client (no secret).
 *    Every third-party implementation reuses it; xAI has not published a
 *    partner-client program, so subscription OAuth is a best-effort path.
 *  - xAI gates proxy access by subscription tier. A perfectly valid login can
 *    still be refused at inference time, which is exactly why `xai` keeps its
 *    API-key method as a fallback (see AuthStorage's dual-auth resolution).
 */

import { oauthRequestSignal } from "./request-timeout.js";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types.js";

/**
 * Public OAuth client id of xAI's Grok CLI desktop client (no secret, no PKCE
 * needed for the device flow). Overridable for forks/staging via env.
 */
const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

const DEFAULT_ISSUER = "https://auth.x.ai";
const DEFAULT_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

/**
 * Scopes the Grok CLI requests. `grok-cli:access` is what authorizes the chat
 * proxy, `api:access` covers the public API surface, and `offline_access` is
 * what yields a refresh token — dropping any of them breaks a working login.
 */
const OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";

/**
 * Client version reported to the chat proxy. The proxy hard-gates on this with
 * a semver minimum (prereleases don't satisfy it): below the floor every
 * request gets HTTP 426 "Your Grok CLI version (x) is outdated". The floor was
 * 0.1.202, then rose to 1.0.13 around 2026-10-01, which broke the old 0.2.101
 * pin. 1.0.67 is the stable Grok CLI per x.ai/cli/stable (2026-10-24).
 *
 * Overridable via GROK_CLI_VERSION so a bumped proxy floor can be worked around
 * without waiting for a release.
 */
const DEFAULT_GROK_CLI_VERSION = "1.0.67";

/**
 * Fallback poll budget when the device-authorization response omits `expires_in`.
 * The server's value is preferred (see loginXai) — this only bounds the loop when
 * xAI tells us nothing.
 */
const DEVICE_TIMEOUT_FALLBACK_MS = 10 * 60 * 1000;

/**
 * Access-token lifetime assumed when the token response omits `expires_in`.
 * RFC 6749 §5.1 marks the field RECOMMENDED, not REQUIRED, so a login must not
 * die over its absence — mirrors how other Grok clients degrade (JWT `exp`, then
 * a long TTL). AuthStorage refreshes proactively from `expiresIn`, so a
 * conservative value here just means it revalidates sooner.
 */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

function issuer(): string {
  return (process.env.XAI_OAUTH_ISSUER ?? DEFAULT_ISSUER).replace(/\/+$/, "");
}

function clientId(): string {
  return process.env.XAI_OAUTH_CLIENT_ID ?? DEFAULT_CLIENT_ID;
}

/** Grok CLI chat-proxy base URL the issued OAuth token is used against. */
export function grokCliBaseUrl(): string {
  return (process.env.XAI_CLI_BASE_URL ?? DEFAULT_CLI_BASE_URL).replace(/\/+$/, "");
}

function grokCliVersion(): string {
  const raw = process.env.GROK_CLI_VERSION ?? DEFAULT_GROK_CLI_VERSION;
  const cleaned = raw.replace(/[^\u0020-\u007E]/g, "").trim();
  return cleaned.length > 0 ? cleaned : DEFAULT_GROK_CLI_VERSION;
}

/**
 * Headers the Grok CLI chat proxy requires on every model request. It serves
 * only recognized Grok-CLI clients: without the token-auth marker and a client
 * version it refuses the request. `modelId` populates the model-override header
 * the proxy uses to route a request to the entitled model.
 *
 * Attach these ONLY to the proxy — the `api.x.ai` API-key path must not receive
 * them (see {@link isGrokCliEndpoint}).
 */
export function grokCliHeaders(modelId?: string): Record<string, string> {
  return {
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": grokCliVersion(),
    "x-grok-client-identifier": "ggcoder",
    ...(modelId ? { "x-grok-model-override": modelId } : {}),
  };
}

/**
 * True if `baseUrl` targets the Grok CLI chat proxy (the URL persisted on Grok
 * OAuth credentials). Callers use this to decide whether to attach
 * {@link grokCliHeaders} and whether a usage/permission rejection should fall
 * back to the xAI API key.
 */
export function isGrokCliEndpoint(baseUrl: string | undefined): boolean {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return false;
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized === grokCliBaseUrl() || /(^|\.)grok\.com/i.test(normalized);
}

async function postForm(
  endpoint: string,
  params: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${issuer()}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": `grok-cli/${grokCliVersion()}`,
    },
    body: new URLSearchParams(params).toString(),
    signal: oauthRequestSignal(),
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

/**
 * `exp` (seconds since epoch) from a JWT access token, if it carries one. xAI
 * issues JWTs, so this recovers a real expiry when the token response omits
 * `expires_in` — far better than assuming a blanket default. Parsing is
 * best-effort and never throws: an opaque token simply yields undefined.
 */
function jwtExpirySeconds(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf-8",
    );
    const claims: unknown = JSON.parse(json);
    if (!claims || typeof claims !== "object") return undefined;
    const exp = (claims as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp : undefined;
  } catch {
    return undefined;
  }
}

function credsFromTokenResponse(
  data: Record<string, unknown>,
  opts?: { fallbackRefreshToken?: string },
): OAuthCredentials {
  const accessToken = data.access_token;
  const responseRefreshToken = data.refresh_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Grok OAuth response missing access_token.");
  }
  // The token endpoint may rotate the refresh token or omit it (keeping the
  // existing one). Honor a rotated token, otherwise reuse the caller's so a
  // non-rotating refresh never strands the credential. Only the initial
  // device-code exchange (no fallback) hard-requires one.
  const refreshToken =
    typeof responseRefreshToken === "string" && responseRefreshToken.length > 0
      ? responseRefreshToken
      : (opts?.fallbackRefreshToken ?? "");
  if (refreshToken.length === 0) {
    throw new Error(
      "Grok OAuth response missing refresh_token — the offline_access scope was not granted.",
    );
  }
  // `expires_in` is RECOMMENDED, not REQUIRED (RFC 6749 §5.1). Degrade instead of
  // failing a login that already succeeded: server value → the access token's own
  // JWT `exp` → a conservative default.
  const responseExpiresIn = Number(data.expires_in);
  let expiresIn: number;
  if (Number.isFinite(responseExpiresIn) && responseExpiresIn > 0) {
    expiresIn = responseExpiresIn;
  } else {
    const exp = jwtExpirySeconds(accessToken);
    const fromJwt = exp !== undefined ? exp - Math.floor(Date.now() / 1000) : 0;
    expiresIn = fromJwt > 0 ? fromJwt : DEFAULT_TOKEN_LIFETIME_SECONDS;
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    expiresIn,
    baseUrl: grokCliBaseUrl(),
  };
}

interface DeviceAuthorization {
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  /** How long the device code stays valid, in ms (server-provided when given). */
  expiresInMs: number;
}

async function requestDeviceAuthorization(): Promise<DeviceAuthorization> {
  const { status, data } = await postForm("/oauth2/device/code", {
    client_id: clientId(),
    scope: OAUTH_SCOPE,
  });
  if (status !== 200) {
    throw new Error(`Grok device authorization failed (${status}): ${errorDetail(data)}`);
  }
  const userCode = data.user_code;
  const deviceCode = data.device_code;
  const verificationUriComplete = data.verification_uri_complete;
  if (typeof userCode !== "string" || typeof deviceCode !== "string") {
    throw new Error("Grok device authorization response missing user_code/device_code.");
  }
  return {
    userCode,
    deviceCode,
    verificationUri: typeof data.verification_uri === "string" ? data.verification_uri : "",
    verificationUriComplete:
      typeof verificationUriComplete === "string" ? verificationUriComplete : "",
    interval: Number(data.interval ?? 5) || 5,
    // RFC 8628 §3.2: the server states how long the device code lives. Honor it
    // rather than imposing our own budget — polling a code we know is dead only
    // burns requests, and a longer local window would keep a user waiting past
    // the point the code can ever succeed.
    expiresInMs:
      (Number(data.expires_in) || 0) > 0
        ? Number(data.expires_in) * 1000
        : DEVICE_TIMEOUT_FALLBACK_MS,
  };
}

type PollResult =
  | { kind: "success"; creds: OAuthCredentials }
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "expired" }
  | { kind: "denied" };

async function pollDeviceToken(deviceCode: string): Promise<PollResult> {
  const { status, data } = await postForm("/oauth2/token", {
    client_id: clientId(),
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (status === 200 && typeof data.access_token === "string") {
    return { kind: "success", creds: credsFromTokenResponse(data) };
  }
  if (status >= 500) {
    throw new Error(`Grok token polling server error (${status}): ${errorDetail(data)}`);
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
      throw new Error(`Grok token polling failed (${status}): ${errorDetail(data)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Drive the Grok device-code flow end-to-end. Shows the verification URL + user
 * code via callbacks, opens the browser, and polls until the user authorizes or
 * the device code expires (deadline set by the server).
 */
export async function loginXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const auth = await requestDeviceAuthorization();

  callbacks.onStatus(
    `Visit ${auth.verificationUri || auth.verificationUriComplete} and enter code: ${auth.userCode}`,
  );
  callbacks.onOpenUrl(auth.verificationUriComplete || auth.verificationUri);
  callbacks.onStatus("Waiting for you to authorize in the browser...");

  const deadline = Date.now() + auth.expiresInMs;
  let interval = Math.max(auth.interval, 1);

  while (Date.now() < deadline) {
    // Never sleep past the deadline: overshooting it would poll a code the server
    // has already expired, or stall the failure message well past the point the
    // user could still have completed the flow.
    const remaining = deadline - Date.now();
    await sleep(Math.min(interval * 1000, remaining));
    const result = await pollDeviceToken(auth.deviceCode);
    if (result.kind === "success") return result.creds;
    if (result.kind === "denied") {
      throw new Error("Grok authorization was denied.");
    }
    if (result.kind === "expired") {
      throw new Error("Grok device code expired. Please run login again.");
    }
    if (result.kind === "slow_down") {
      // RFC 8628 §3.5: back off by at least 5s and keep polling.
      interval += 5;
    }
    // pending → keep polling
  }

  throw new Error("Grok login timed out. Please run login again.");
}

/** Exchange a refresh token for a fresh Grok access token. */
export async function refreshXaiToken(refreshToken: string): Promise<OAuthCredentials> {
  const { status, data } = await postForm("/oauth2/token", {
    client_id: clientId(),
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (status === 200 && typeof data.access_token === "string") {
    return credsFromTokenResponse(data, { fallbackRefreshToken: refreshToken });
  }
  const errorCode = typeof data.error === "string" ? data.error : "";
  // Surface 401/403/invalid_grant in a shape AuthStorage's refresh-failure
  // detection recognizes, so dead refresh tokens get wiped for re-login.
  throw new Error(`Grok token refresh failed (${status}): ${errorCode || errorDetail(data)}`);
}
