import http from "node:http";
import crypto from "node:crypto";
import { generatePKCE } from "./pkce.js";
import { oauthRequestSignal } from "./request-timeout.js";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
/** How long the loopback listener stays up before giving the paste route the floor. */
const CALLBACK_TIMEOUT_MS = 120_000;
/** Retries allowed on a mistyped/truncated paste before that route gives up. */
const MAX_PASTE_ATTEMPTS = 3;
/** Shortest plausible bare authorization code; below this it is a mis-paste. */
const MIN_RAW_CODE_LENGTH = 10;

export async function loginOpenAI(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { verifier, challenge } = await generatePKCE();
  const state = crypto.randomBytes(16).toString("hex");

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  // Force account chooser / re-authentication so switching accounts actually works.
  // Without this, the browser silently re-approves the cached session.
  url.searchParams.set("prompt", "login");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "ggcoder");

  const code = await acquireAuthorizationCode(url.toString(), state, callbacks);

  const creds = await exchangeOpenAICode(code, verifier);

  const accountId = getAccountId(creds.accessToken);
  if (!accountId) {
    throw new Error("Failed to extract accountId from OpenAI token.");
  }
  creds.accountId = accountId;

  return creds;
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  // Full URL
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL
  }

  // code#state
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  // Query string with code=
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  // Raw code. Anything containing whitespace, or too short to be one, is a
  // mis-paste (a stray clipboard, a shell prompt, half a URL). Treating it as a
  // code would send it to the token endpoint and surface an opaque provider
  // error instead of simply asking again.
  if (/\s/.test(value) || value.length < MIN_RAW_CODE_LENGTH) return {};
  return { code: value };
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const decoded = atob(parts[1]);
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getAccountId(accessToken: string): string | null {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

/**
 * Obtain the authorization code, running both routes at once.
 *
 * The local listener only completes when a browser on *this* machine hits the
 * callback. Over SSH the bind succeeds — port 1455 is free on the server — so
 * waiting on it alone means a two-minute silence ending in a misleading "could
 * not start local server" (#20). Detecting "headless" up front is unreliable:
 * DISPLAY, SSH_TTY and friends all disagree in containers, WSL and tmux.
 *
 * So offer both and take whichever arrives first. A desktop user completes the
 * browser round-trip and never touches the prompt; a remote user pastes the
 * callback URL. The login only fails if *both* routes fail, so a listener that
 * cannot bind (port in use) degrades to paste instead of aborting.
 */
async function acquireAuthorizationCode(
  authUrl: string,
  expectedState: string,
  callbacks: OAuthLoginCallbacks,
): Promise<string> {
  callbacks.onOpenUrl(authUrl);
  callbacks.onStatus("Waiting for browser callback...");

  const done = new AbortController();

  try {
    return await new Promise<string>((resolve, reject) => {
      let serverFailed = false;
      let pasteError: unknown;

      // Only when BOTH routes are out is the login actually unrecoverable.
      // Report the paste-side reason: it is the one the operator can act on,
      // whereas the listener's is invariably a generic close.
      const failIfExhausted = (): void => {
        if (!serverFailed || pasteError === undefined) return;
        reject(
          pasteError instanceof Error
            ? pasteError
            : new Error("Could not obtain an authorization code."),
        );
      };

      listenForCallback(expectedState, done.signal).then(resolve, () => {
        serverFailed = true;
        failIfExhausted();
      });

      promptForCode(expectedState, callbacks, done.signal).then(resolve, (err: unknown) => {
        // A state mismatch means the pasted code belongs to a different login
        // attempt. That is worth stopping for immediately rather than sitting
        // on the listener until it lapses: the operator has to start over.
        if (err instanceof FatalLoginError) {
          reject(err);
          return;
        }
        pasteError = err;
        failIfExhausted();
      });
    });
  } finally {
    // Tear down the losing route: close the listener, cancel the prompt.
    done.abort();
  }
}

/** A failure that should end the whole login rather than defer to the other route. */
class FatalLoginError extends Error {}

/** Wait for a pasted code or callback URL, validating state when one is present. */
async function promptForCode(
  expectedState: string,
  callbacks: OAuthLoginCallbacks,
  signal: AbortSignal,
): Promise<string> {
  let message =
    "If the browser is on another machine (SSH/headless), paste the callback URL or code here:";

  // A fumbled paste is common — the code is long and easily truncated — and it
  // must not end the login, so re-ask. Bounded, because a caller that cannot
  // actually collect input (non-interactive stdin) would otherwise spin here
  // and this route could never fail.
  for (let attempt = 0; attempt < MAX_PASTE_ATTEMPTS; attempt++) {
    if (signal.aborted) throw new Error("Authorization code already received.");
    const raw = await callbacks.onPromptCode(message, signal);
    if (signal.aborted) throw new Error("Authorization code already received.");

    const parsed = parseAuthorizationInput(raw);
    // A raw code carries no state to check. When the operator pastes the whole
    // callback URL the state IS present, and a mismatch means the code belongs
    // to a different login attempt — the same check the listener enforces.
    if (parsed.code && parsed.state && parsed.state !== expectedState) {
      throw new FatalLoginError("Authorization state mismatch — start the login again.");
    }
    if (parsed.code) return parsed.code;

    message = "That didn't contain an authorization code. Paste the full callback URL:";
  }

  throw new Error("No authorization code found in input.");
}

/** Serve the loopback callback until a matching code arrives or `signal` aborts. */
async function listenForCallback(expectedState: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let receivedCode: string | null = null;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "", "http://localhost");

      if (url.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      if (url.searchParams.get("state") !== expectedState) {
        res.statusCode = 400;
        res.end("State mismatch");
        return;
      }

      receivedCode = url.searchParams.get("code");

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Login successful!</h1><p>You can close this tab.</p></body></html>");

      server.close();
    });

    server.on("error", (err) => {
      // Usually EADDRINUSE. Not fatal on its own: the paste route is still live.
      reject(err);
    });

    server.listen(1455, "127.0.0.1");

    // Backstop so this route always terminates: without it, a login where the
    // callback never arrives AND the paste route has given up would hang
    // forever rather than reporting a failure.
    const timeout = setTimeout(() => {
      if (!receivedCode) server.close();
    }, CALLBACK_TIMEOUT_MS);
    timeout.unref();

    // The paste route winning (or a caller giving up) closes the listener.
    const onAbort = (): void => {
      server.close();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    server.on("close", () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (receivedCode) {
        resolve(receivedCode);
      } else {
        reject(new Error("Server closed without receiving code"));
      }
    });
  });
}

async function exchangeOpenAICode(code: string, verifier: string): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
    signal: oauthRequestSignal(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI token exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export async function refreshOpenAIToken(refreshToken: string): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: oauthRequestSignal(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI token refresh failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const creds: OAuthCredentials = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  const accountId = getAccountId(creds.accessToken);
  if (accountId) {
    creds.accountId = accountId;
  }

  return creds;
}
