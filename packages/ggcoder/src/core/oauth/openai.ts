import http from "node:http";
import crypto from "node:crypto";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/**
 * Detect headless / remote-server environments where a browser-based
 * localhost callback cannot work. Returns true when:
 *  - No graphical display is available ($DISPLAY / $WAYLAND_DISPLAY unset), or
 *  - The process is running inside an SSH session ($SSH_CLIENT / $SSH_TTY set)
 *    without X11 forwarding.
 */
function isHeadless(): boolean {
  const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const isSsh = Boolean(process.env.SSH_CLIENT || process.env.SSH_TTY);
  // In an SSH session without X11 forwarding, a browser can't open locally.
  if (isSsh && !hasDisplay) return true;
  // No display at all (e.g. a plain server, Docker, CI).
  if (!hasDisplay) return true;
  return false;
}

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
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "ggcoder");

  let code: string;

  // On headless / remote servers the local callback server is unreachable from
  // the user's browser, so skip straight to the manual-paste flow.
  if (isHeadless()) {
    code = await manualPasteFlow(url.toString(), callbacks);
  } else {
    try {
      code = await loginWithServer(url.toString(), state, callbacks);
    } catch {
      code = await manualPasteFlow(url.toString(), callbacks);
    }
  }

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

  // Raw code
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
 * Manual-paste fallback used on headless servers and when the local callback
 * server fails. Prints the auth URL and asks the user to paste either:
 *  - The full redirect URL  (http://localhost:1455/auth/callback?code=…&state=…)
 *  - Or just the bare authorization code
 */
async function manualPasteFlow(authUrl: string, callbacks: OAuthLoginCallbacks): Promise<string> {
  callbacks.onOpenUrl(authUrl);
  callbacks.onStatus(
    "\nRunning on a headless/remote server — the browser callback cannot reach localhost.\n" +
      "Steps:\n" +
      "  1. Open the URL above in a browser on your local machine.\n" +
      "  2. Complete the OpenAI sign-in.\n" +
      "  3. After you are redirected, copy the FULL address-bar URL\n" +
      "     (it looks like: http://localhost:1455/auth/callback?code=…&state=…)\n" +
      "  4. Paste it below.\n",
  );
  const raw = await callbacks.onPromptCode("Paste the full redirect URL (or bare code):");
  const parsed = parseAuthorizationInput(raw);
  if (!parsed.code) {
    throw new Error(
      "No authorization code found in the pasted input.\n" +
        "Expected a full redirect URL such as:\n" +
        "  http://localhost:1455/auth/callback?code=<code>&state=<state>\n" +
        "or just the bare code value.",
    );
  }
  return parsed.code;
}

async function loginWithServer(
  authUrl: string,
  expectedState: string,
  callbacks: OAuthLoginCallbacks,
): Promise<string> {
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
      reject(err);
    });

    server.listen(1455, "127.0.0.1", () => {
      callbacks.onOpenUrl(authUrl);
      callbacks.onStatus("Waiting for browser callback...");
    });

    server.on("close", () => {
      if (receivedCode) {
        resolve(receivedCode);
      } else {
        reject(new Error("Server closed without receiving code"));
      }
    });

    setTimeout(() => {
      if (!receivedCode) {
        server.close();
      }
    }, 30_000);
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
