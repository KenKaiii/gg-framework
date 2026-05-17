import crypto from "node:crypto";
import { generatePKCE } from "./pkce.js";
import { getClaudeCliUserAgent } from "../claude-code-version.js";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types.js";

const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
// Anthropic migrated OAuth from console.anthropic.com to platform.claude.com
// in Claude Code v2.1.81+. Try the new endpoint first, fall back to the old one
// so a transient outage on either edge doesn't wipe the user's credentials.
const TOKEN_URLS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/v1/oauth/token",
];
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

async function postTokenRequest(
  body: Record<string, string>,
  label: string,
): Promise<TokenResponse> {
  const encoded = JSON.stringify(body);
  // Claude Code identity. Anthropic's OAuth edge intermittently rejects
  // requests without a recognized claude-cli UA + oauth beta header. Resolve
  // the UA version dynamically so it tracks real Claude Code releases.
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": await getClaudeCliUserAgent(),
    "anthropic-beta": "oauth-2025-04-20",
  };
  let lastError: Error | null = null;
  for (const url of TOKEN_URLS) {
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body: encoded });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }
    if (response.ok) {
      return (await response.json()) as TokenResponse;
    }
    const text = await response.text();
    // 4xx is an authoritative auth failure (invalid_grant, invalid_client, etc.)
    // — don't paper over it by trying another endpoint, the result will be the
    // same and the caller relies on this signal to wipe stale creds.
    if (response.status >= 400 && response.status < 500) {
      throw new Error(`Anthropic ${label} failed (${response.status}): ${text}`);
    }
    lastError = new Error(`Anthropic ${label} failed (${response.status}): ${text}`);
  }
  throw lastError ?? new Error(`Anthropic ${label} failed: all endpoints unreachable`);
}

function toCredentials(data: TokenResponse): OAuthCredentials {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

export async function loginAnthropic(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { verifier, challenge } = await generatePKCE();
  const state = crypto.randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  const authUrl = `${AUTHORIZE_URL}?${params}`;
  callbacks.onOpenUrl(authUrl);
  callbacks.onStatus(
    "\nAfter authorizing, claude.ai will show a code on the page.\n" +
      "Copy the entire value — it looks like:  <code>#<state>\n",
  );

  const raw = await callbacks.onPromptCode("Paste the code from the browser:");

  const trimmed = raw.trim();
  const hashIdx = trimmed.indexOf("#");

  let code: string;
  let receivedState: string | undefined;

  if (hashIdx !== -1) {
    code = trimmed.slice(0, hashIdx);
    receivedState = trimmed.slice(hashIdx + 1);
  } else {
    // User pasted only the code without the state — accept it with a warning.
    code = trimmed;
    receivedState = undefined;
  }

  if (!code) {
    throw new Error(
      "No authorization code found.\n" +
        "Expected the value shown on the claude.ai callback page, e.g.:\n" +
        "  abc123def456#" +
        state.slice(0, 8) +
        "…\n" +
        "Run `ggcoder login` to try again.",
    );
  }

  // Validate state when present — skip silently if the user omitted it.
  if (receivedState !== undefined && receivedState !== state) {
    throw new Error(
      "State mismatch — the pasted code does not match this login session.\n" +
        "This can happen if you copied from a previous login attempt.\n" +
        "Run `ggcoder login` to start a fresh session.",
    );
  }

  return exchangeAnthropicCode(code, state, verifier);
}

async function exchangeAnthropicCode(
  code: string,
  state: string,
  verifier: string,
): Promise<OAuthCredentials> {
  const data = await postTokenRequest(
    {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    },
    "token exchange",
  );
  return toCredentials(data);
}

export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
  const data = await postTokenRequest(
    {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    },
    "token refresh",
  );
  return toCredentials(data);
}
