import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getAppPaths } from "../paths.js";
import { generatePKCE } from "./pkce.js";
import { oauthRequestSignal } from "./request-timeout.js";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types.js";

// Sign in with ChatGPT for open-source local apps:
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
/** First-time registration entrypoint; never saved or used for token exchange. */
const REGISTRATION_CLIENT_ID = "dynamic_agent_client";
const AGENT_NAME = "GG Coder";
const RESOURCE = "https://api.openai.com/v1";
/** The scope that lets GG Coder use the user's ChatGPT plan. */
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${CHATGPT_PLAN_SCOPE}`;
/** Responses API base for ChatGPT plan inference. */
export const CHATGPT_PLAN_BASE_URL = "https://api.openai.com/v1";
/** Where users review and limit what GG Coder may use of their plan. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
const CALLBACK_PATH = "/auth/callback";
const PREFERRED_PORT = 1455;
/** How long the loopback listener stays up before giving the paste route the floor. */
const CALLBACK_TIMEOUT_MS = 120_000;
/** Retries allowed on a mistyped/truncated paste before that route gives up. */
const MAX_PASTE_ATTEMPTS = 3;
const ID_TOKEN_CLOCK_SKEW_S = 60;

export const CHATGPT_PLAN_NOT_ENABLED_MESSAGE =
  "ChatGPT plan use isn't enabled for GG Coder. Allow Use your ChatGPT plan, or add an OpenAI API key.";

/** A sign-in that worked but can't be used to bill the user's ChatGPT plan. */
export class ChatGPTPlanNotEnabledError extends Error {
  constructor() {
    super(CHATGPT_PLAN_NOT_ENABLED_MESSAGE);
    this.name = "ChatGPTPlanNotEnabledError";
  }
}

/**
 * OpenAI refused the one-time code at the token endpoint. `reason` is its
 * OAuth error (`invalid_grant`, `invalid_client`, ...) and `detail` its
 * `error_description`; the message never carries the raw response body.
 */
export class ChatGPTSignInError extends Error {
  readonly reason: string;
  readonly status: number;
  readonly detail: string;
  /** Whether a saved app registration was used, rather than a first registration. */
  returning = false;
  /** Whether this was the second refusal, after the one automatic retry. */
  retried = false;
  /** Milliseconds from the browser callback to the token endpoint's answer. */
  callbackToExchangeMs?: number;

  constructor(reason: string, status: number, detail = "") {
    super(`ChatGPT token exchange failed (${status}): ${reason}`);
    this.name = "ChatGPTSignInError";
    this.reason = reason;
    this.status = status;
    this.detail = detail;
  }
}

interface ChatGPTRegistration {
  clientId: string;
  subject: string;
}

export interface ChatGPTLoginOptions {
  /** Defaults to `~/.gg/openai-host-id`. */
  hostIdFile?: string;
  /** Defaults to `~/.gg/openai-chatgpt-client.json`. */
  registrationFile?: string;
  /** The current sign-in, if any: its ID token skips the account picker. */
  previous?: Pick<OAuthCredentials, "idToken">;
  /** Aborting closes the callback listener at once and rejects with an `AbortError`. */
  signal?: AbortSignal;
}

function cancelled(): Error {
  const err = new Error("ChatGPT sign-in was cancelled.");
  err.name = "AbortError";
  return err;
}

function defaultHostIdFile(): string {
  return path.join(getAppPaths().agentDir, "openai-host-id");
}

function defaultRegistrationFile(): string {
  return path.join(getAppPaths().agentDir, "openai-chatgpt-client.json");
}

/** Owner-only write via temp file + rename, so a crash never leaves a torn file. */
async function writePrivateFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.writeFile(tmp, content, { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

const HOST_ID_PATTERN = /^urn:uuid:[0-9a-f-]{36}$/i;

/** This machine's stable `ext_agent_host_id`, created on first use. */
export async function getChatGPTHostId(file = defaultHostIdFile()): Promise<string> {
  const existing = await fs.readFile(file, "utf-8").catch(() => "");
  if (HOST_ID_PATTERN.test(existing.trim())) return existing.trim();
  await writePrivateFile(file, `urn:uuid:${crypto.randomUUID()}`);
  // Another process may have won the race; everyone uses what is on disk.
  return (await fs.readFile(file, "utf-8")).trim();
}

async function readRegistration(file: string): Promise<ChatGPTRegistration | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf-8")) as Partial<ChatGPTRegistration>;
    if (typeof value.clientId === "string" && typeof value.subject === "string") {
      return { clientId: value.clientId, subject: value.subject };
    }
  } catch {
    // Missing or unreadable: register again.
  }
  return undefined;
}

/**
 * Continue with ChatGPT. Registers GG Coder for this ChatGPT account on first
 * use (the user names and approves it in the browser), then reuses the issued
 * client ID. Throws {@link ChatGPTPlanNotEnabledError} when the user signed in
 * but didn't allow plan use, and {@link ChatGPTSignInError} when OpenAI refuses
 * the one-time code twice.
 */
export async function loginChatGPT(
  callbacks: OAuthLoginCallbacks,
  options: ChatGPTLoginOptions = {},
): Promise<OAuthCredentials> {
  const { signal } = options;
  const hostId = await getChatGPTHostId(options.hostIdFile);
  const registrationFile = options.registrationFile ?? defaultRegistrationFile();
  const registration = await readRegistration(registrationFile);
  // The app ID OpenAI issued in a first registration whose code it then refused.
  let issuedClientId: string | undefined;

  const signIn = async (status: string): Promise<OAuthCredentials> => {
    if (signal?.aborted) throw cancelled();
    const knownClientId = registration?.clientId ?? issuedClientId;
    const { verifier, challenge } = await generatePKCE();
    const state = crypto.randomBytes(16).toString("hex");
    const nonce = crypto.randomBytes(16).toString("hex");

    const listener = await startCallbackListener(state, Boolean(knownClientId));
    try {
      const redirectUri = `http://127.0.0.1:${listener.port}${CALLBACK_PATH}`;
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set("client_id", knownClientId ?? REGISTRATION_CLIENT_ID);
      if (!knownClientId) url.searchParams.set("agent_name_hint", AGENT_NAME);
      url.searchParams.set("ext_agent_host_id", hostId);
      if (registration && options.previous?.idToken) {
        url.searchParams.set("id_token_hint", options.previous.idToken);
      }
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", SCOPES);
      url.searchParams.set("resource", RESOURCE);
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("code_challenge", challenge);

      const callback = await acquireCallback(url.toString(), state, listener, callbacks, {
        status,
        signal,
      });
      const callbackAt = Date.now();
      if (callback.get("error")) {
        if (callback.get("error") === "access_denied") throw new ChatGPTPlanNotEnabledError();
        throw new Error(
          `ChatGPT sign-in failed: ${callback.get("error_description") ?? callback.get("error")}`,
        );
      }
      const code = callback.get("code");
      if (!code) throw new Error("ChatGPT sign-in returned no authorization code.");
      const issued = callback.get("client_id") ?? undefined;
      if (knownClientId && issued && issued !== knownClientId) {
        throw new Error("ChatGPT returned a different app registration. Start the sign-in again.");
      }
      const clientId = knownClientId ?? issued;
      if (!clientId || clientId === REGISTRATION_CLIENT_ID) {
        throw new Error(
          "ChatGPT didn't finish registering GG Coder. Start the sign-in again, and paste the full callback URL if you're on another machine.",
        );
      }
      issuedClientId = clientId;

      const tokens = await exchangeCode({ code, verifier, clientId, redirectUri, signal }).catch(
        (err: unknown) => {
          if (err instanceof ChatGPTSignInError) {
            err.returning = Boolean(registration);
            err.callbackToExchangeMs = Date.now() - callbackAt;
          }
          throw err;
        },
      );
      const claims = await verifyIdToken(tokens.idToken, { clientId, nonce });
      const subject = String(claims.sub ?? "");
      if (!subject) throw new Error("ChatGPT ID token has no subject.");
      if (registration && registration.subject !== subject) {
        // The saved registration belongs to another account; register afresh next time.
        await fs.unlink(registrationFile).catch(() => {});
        await revokeChatGPTSignIn({ refreshToken: tokens.refreshToken, clientId });
        throw new Error(
          "That was a different ChatGPT account. Continue with ChatGPT again to connect it.",
        );
      }
      if (!tokens.scopes.includes(CHATGPT_PLAN_SCOPE)) {
        await revokeChatGPTSignIn({ refreshToken: tokens.refreshToken, clientId });
        throw new ChatGPTPlanNotEnabledError();
      }
      if (!registration) {
        await writePrivateFile(registrationFile, JSON.stringify({ clientId, subject }));
      }

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: Date.now() + tokens.expiresIn * 1000,
        expiresIn: tokens.expiresIn,
        accountId: subject,
        clientId,
        idToken: tokens.idToken,
        scopes: tokens.scopes,
        baseUrl: CHATGPT_PLAN_BASE_URL,
      };
    } finally {
      listener.close();
    }
  };

  try {
    try {
      return await signIn("Waiting for ChatGPT sign-in in your browser...");
    } catch (err) {
      if (!(err instanceof ChatGPTSignInError) || err.reason !== "invalid_grant") throw err;
      if (signal?.aborted) throw err;
    }
    // OpenAI's documented recovery: drop the refused code and authorize again
    // with the app ID it just issued.
    try {
      return await signIn(
        "ChatGPT didn't accept that sign-in. Trying once more in your browser...",
      );
    } catch (err) {
      if (err instanceof ChatGPTSignInError) err.retried = true;
      throw err;
    }
  } catch (err) {
    if (signal?.aborted) throw cancelled();
    throw err;
  }
}

/**
 * Model ids the signed-in ChatGPT account may use on its plan, from the same
 * `/v1/models` catalog OpenAI tells apps to build their picker from. Hidden
 * entries (`visibility` other than "list") are left out.
 */
export async function fetchChatGPTPlanModels(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  const response = await fetchFn(`${CHATGPT_PLAN_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: oauthRequestSignal(),
  });
  if (!response.ok) throw new Error(`ChatGPT model list failed (${response.status})`);
  const data = (await response.json()) as {
    models?: Array<{ slug?: unknown; visibility?: unknown }>;
  };
  return (data.models ?? [])
    .filter((m) => typeof m.slug === "string" && (m.visibility ?? "list") === "list")
    .map((m) => m.slug as string);
}

// ── Callback ───────────────────────────────────────────────

interface CallbackListener {
  port: number;
  /** Resolves with the callback query once a request with our state arrives. */
  result: Promise<URLSearchParams>;
  close: () => void;
}

/**
 * Bind the loopback callback. The first registration uses the documented port;
 * a returning sign-in may take any free one (only the port may vary). When no
 * port binds, the paste route still works with the preferred URI.
 */
async function startCallbackListener(
  expectedState: string,
  anyPort: boolean,
): Promise<CallbackListener> {
  let settle: { resolve: (p: URLSearchParams) => void; reject: (e: Error) => void } | undefined;
  const result = new Promise<URLSearchParams>((resolve, reject) => {
    settle = { resolve, reject };
  });
  result.catch(() => {});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    if (url.searchParams.get("state") !== expectedState) {
      res.statusCode = 400;
      res.end("State mismatch");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<html><body><h1>You're signed in to GG Coder.</h1><p>You can close this tab.</p></body></html>",
    );
    settle?.resolve(url.searchParams);
    server.close();
  });

  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolve((server.address() as AddressInfo).port);
      });
    });

  let port: number | undefined;
  for (const candidate of anyPort ? [PREFERRED_PORT, 0] : [PREFERRED_PORT]) {
    try {
      port = await listen(candidate);
      break;
    } catch {
      // Port in use: try the next one, or fall back to paste only.
    }
  }
  if (port === undefined) {
    settle?.reject(new Error("Could not start the local sign-in listener."));
    return { port: PREFERRED_PORT, result, close: () => {} };
  }

  // Backstop so this route always terminates.
  const timeout = setTimeout(() => server.close(), CALLBACK_TIMEOUT_MS);
  timeout.unref();
  server.on("close", () => {
    clearTimeout(timeout);
    settle?.reject(new Error("Sign-in listener closed without a callback."));
  });
  return { port, result, close: () => server.close() };
}

/**
 * Wait for the browser callback and the paste route at once, taking whichever
 * arrives first. Over SSH the listener binds but never hears from the browser,
 * so the user pastes the callback URL instead (#20).
 */
async function acquireCallback(
  authUrl: string,
  expectedState: string,
  listener: CallbackListener,
  callbacks: OAuthLoginCallbacks,
  options: { status: string; signal?: AbortSignal },
): Promise<URLSearchParams> {
  callbacks.onOpenUrl(authUrl);
  callbacks.onStatus(options.status);
  const done = new AbortController();
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<URLSearchParams>((resolve, reject) => {
      onAbort = () => reject(cancelled());
      options.signal?.addEventListener("abort", onAbort, { once: true });
      let listenerFailed = false;
      let pasteError: unknown;
      const failIfExhausted = (): void => {
        if (!listenerFailed || pasteError === undefined) return;
        reject(
          pasteError instanceof Error ? pasteError : new Error("Could not complete the sign-in."),
        );
      };
      listener.result.then(resolve, () => {
        listenerFailed = true;
        failIfExhausted();
      });
      promptForCallback(expectedState, callbacks, done.signal).then(resolve, (err: unknown) => {
        if (err instanceof FatalLoginError) {
          reject(err);
          return;
        }
        pasteError = err;
        failIfExhausted();
      });
    });
  } finally {
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    done.abort();
    listener.close();
  }
}

/** A failure that should end the whole login rather than defer to the other route. */
class FatalLoginError extends Error {}

/** The callback query from a pasted URL or query string, or undefined for anything else. */
export function parseCallbackInput(input: string): URLSearchParams | undefined {
  const value = input.trim();
  if (!value) return undefined;
  try {
    return new URL(value).searchParams;
  } catch {
    // Not a full URL.
  }
  if (/[?&]?(code|error)=/.test(value)) {
    return new URLSearchParams(value.replace(/^.*\?/, ""));
  }
  return undefined;
}

async function promptForCallback(
  expectedState: string,
  callbacks: OAuthLoginCallbacks,
  signal: AbortSignal,
): Promise<URLSearchParams> {
  let message =
    "If the browser is on another machine (SSH/headless), paste the full callback URL here:";
  // Re-ask on a fumbled paste, but bounded: a caller that can't collect input
  // would otherwise spin here and this route could never fail.
  for (let attempt = 0; attempt < MAX_PASTE_ATTEMPTS; attempt++) {
    if (signal.aborted) throw new Error("Callback already received.");
    const raw = await callbacks.onPromptCode(message, signal);
    if (signal.aborted) throw new Error("Callback already received.");
    const params = parseCallbackInput(raw);
    if (params && (params.get("code") || params.get("error"))) {
      if (params.get("state") !== expectedState) {
        throw new FatalLoginError("Sign-in state mismatch — start the sign-in again.");
      }
      return params;
    }
    message = "That wasn't a callback URL. Paste the full URL from the browser's address bar:";
  }
  throw new Error("No callback URL found in input.");
}

// ── Tokens ─────────────────────────────────────────────────

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresIn: number;
  scopes: string[];
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}

async function postForm(
  url: string,
  form: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    signal: signal ? AbortSignal.any([oauthRequestSignal(), signal]) : oauthRequestSignal(),
  });
}

/** The token endpoint's refusal as a typed error, whatever shape the body took. */
function signInError(status: number, body: string): ChatGPTSignInError {
  let reason = "";
  let detail = "";
  try {
    const data = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    if (typeof data.error === "string") {
      reason = data.error;
    } else if (data.error && typeof data.error === "object") {
      const nested = data.error as { code?: unknown; type?: unknown; message?: unknown };
      reason = String(nested.code ?? nested.type ?? "");
      if (typeof nested.message === "string") detail = nested.message;
    }
    if (typeof data.error_description === "string") detail = data.error_description;
  } catch {
    // Not JSON (a proxy or an outage page): keep the start of it for the log.
    detail = body.replace(/\s+/g, " ").trim();
  }
  return new ChatGPTSignInError(
    /^[\w.-]{1,60}$/.test(reason) ? reason : "unknown_error",
    status,
    detail.slice(0, 300),
  );
}

async function exchangeCode(input: {
  code: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  signal?: AbortSignal;
}): Promise<TokenSet> {
  const response = await postForm(
    TOKEN_URL,
    {
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      resource: RESOURCE,
    },
    input.signal,
  );
  if (!response.ok) {
    throw signInError(response.status, await response.text().catch(() => ""));
  }
  const data = (await response.json()) as TokenResponse;
  if (!data.access_token || !data.refresh_token || !data.id_token) {
    throw new Error("ChatGPT token response is missing tokens.");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    expiresIn: data.expires_in ?? 3600,
    scopes: (data.scope ?? "").split(/\s+/).filter(Boolean),
  };
}

/**
 * Renew the plan token with the issued client ID. The response replaces the
 * access token, its expiry, the granted scopes and the rotating refresh token.
 */
export async function refreshChatGPTToken(
  creds: Pick<OAuthCredentials, "refreshToken" | "clientId">,
): Promise<OAuthCredentials> {
  if (!creds.clientId) {
    throw new Error("ChatGPT token refresh failed (401): no issued client ID saved");
  }
  const response = await postForm(TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: creds.clientId,
    refresh_token: creds.refreshToken,
    resource: RESOURCE,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`ChatGPT token refresh failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const data = (await response.json()) as TokenResponse;
  if (!data.access_token || !data.refresh_token) {
    throw new Error("ChatGPT token refresh returned no tokens.");
  }
  const expiresIn = data.expires_in ?? 3600;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    expiresIn,
    ...(data.id_token ? { idToken: data.id_token } : {}),
    ...(data.scope ? { scopes: data.scope.split(/\s+/).filter(Boolean) } : {}),
  };
}

/**
 * End the renewable session on sign-out. True when OpenAI confirmed it; callers
 * clear local tokens either way and say so when it wasn't confirmed.
 */
export async function revokeChatGPTSignIn(
  creds: Pick<OAuthCredentials, "refreshToken" | "clientId">,
  options: { attempts?: number; backoffMs?: number } = {},
): Promise<boolean> {
  if (!creds.clientId || !creds.refreshToken) return false;
  const attempts = options.attempts ?? 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await postForm(REVOKE_URL, {
        token: creds.refreshToken,
        token_type_hint: "refresh_token",
        client_id: creds.clientId,
      });
      if (response.ok) return true;
      if (response.status < 500) return false;
    } catch {
      // Network failure: retry while the token is still available.
    }
    if (attempt < attempts - 1) {
      await new Promise((r) => setTimeout(r, (options.backoffMs ?? 500) * 2 ** attempt));
    }
  }
  return false;
}

// ── ID token ───────────────────────────────────────────────

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf-8")) as Record<string, unknown>;
}

/** Check the ID token's RS256 signature against OpenAI's JWKS, then iss, aud, exp and nonce. */
export async function verifyIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string; now?: number },
): Promise<Record<string, unknown>> {
  const [headerSeg, payloadSeg, signatureSeg] = idToken.split(".");
  if (!headerSeg || !payloadSeg || !signatureSeg) throw new Error("Malformed ChatGPT ID token.");
  const header = decodeSegment(headerSeg);
  if (header.alg !== "RS256") throw new Error("Unexpected ChatGPT ID token algorithm.");

  const response = await fetch(JWKS_URL, { signal: oauthRequestSignal() });
  if (!response.ok) throw new Error(`Could not load OpenAI signing keys (${response.status}).`);
  const { keys = [] } = (await response.json()) as {
    keys?: Array<crypto.webcrypto.JsonWebKey & { kid?: string }>;
  };
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("ChatGPT ID token is signed with an unknown key.");
  const valid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${headerSeg}.${payloadSeg}`),
    crypto.createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(signatureSeg, "base64url"),
  );
  if (!valid) throw new Error("ChatGPT ID token signature is invalid.");

  const claims = decodeSegment(payloadSeg);
  const now = Math.floor((expected.now ?? Date.now()) / 1000);
  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (claims.iss !== ISSUER) throw new Error("ChatGPT ID token has the wrong issuer.");
  if (!audiences.includes(expected.clientId)) {
    throw new Error("ChatGPT ID token was issued to another app.");
  }
  if (typeof claims.exp !== "number" || claims.exp + ID_TOKEN_CLOCK_SKEW_S < now) {
    throw new Error("ChatGPT ID token has expired.");
  }
  if (claims.nonce !== expected.nonce) throw new Error("ChatGPT ID token nonce mismatch.");
  return claims;
}
