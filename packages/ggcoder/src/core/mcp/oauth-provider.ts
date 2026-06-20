import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import crypto from "node:crypto";
import { McpOAuthStore } from "./oauth-store.js";

/**
 * Fixed loopback port for remote-MCP OAuth callbacks. It must stay STABLE across
 * logins: the redirect URI is baked into the dynamic client registration (RFC
 * 7591), so a changing port would invalidate the saved registration and force a
 * fresh one every time. Distinct from the provider-login port (1455).
 */
export const MCP_OAUTH_CALLBACK_PORT = 41999;
export const MCP_OAUTH_CALLBACK_PATH = "/oauth/callback";

/** The exact redirect URI registered with the authorization server. */
export function mcpOAuthRedirectUrl(): string {
  return `http://localhost:${MCP_OAUTH_CALLBACK_PORT}${MCP_OAUTH_CALLBACK_PATH}`;
}

/**
 * `OAuthClientProvider` for a single remote MCP server, backed by the on-disk
 * `McpOAuthStore`. The MCP SDK drives the whole RFC 6749/7591/8414 flow through
 * this object:
 *
 * - At connect time it reads `tokens()`; if absent/expired it tries a refresh,
 *   and if that fails it calls `redirectToAuthorization()` then throws
 *   `UnauthorizedError`.
 * - `redirectToAuthorization` is a NO-OP unless an `onRedirect` callback is
 *   supplied. Non-interactive paths (startup connect, add-probe) leave it unset,
 *   so a server needing auth fails cleanly (→ "requires login") without
 *   surprising the user with a browser tab. The interactive login path supplies
 *   `onRedirect` to open the browser.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private readonly store: McpOAuthStore;
  private readonly serverName: string;
  private readonly onRedirect?: (url: URL) => void;
  private readonly scope?: string;

  constructor(opts: {
    serverName: string;
    store?: McpOAuthStore;
    /** When set, the server is allowed to drive an interactive browser login. */
    onRedirect?: (url: URL) => void;
    scope?: string;
  }) {
    this.serverName = opts.serverName;
    this.store = opts.store ?? new McpOAuthStore();
    this.onRedirect = opts.onRedirect;
    this.scope = opts.scope;
  }

  get redirectUrl(): string {
    return mcpOAuthRedirectUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "GG Coder",
      client_uri: "https://github.com/kenkaiii/gg-coder",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  async state(): Promise<string> {
    const entry = await this.store.get(this.serverName);
    if (entry.state) return entry.state;
    const fresh = crypto.randomBytes(16).toString("hex");
    await this.store.patch(this.serverName, { state: fresh });
    return fresh;
  }

  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    const entry = await this.store.get(this.serverName);
    return entry.clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformation): Promise<void> {
    await this.store.patch(this.serverName, {
      clientInformation: info as OAuthClientInformationFull,
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const entry = await this.store.get(this.serverName);
    return entry.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.patch(this.serverName, { tokens });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Only interactive logins open a browser; otherwise this is intentionally a
    // no-op so the SDK throws UnauthorizedError and the caller marks the server
    // as "requires login" instead of popping a tab during a background connect.
    this.onRedirect?.(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.store.patch(this.serverName, { codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const entry = await this.store.get(this.serverName);
    if (!entry.codeVerifier) {
      throw new Error("No PKCE code verifier saved for this MCP server.");
    }
    return entry.codeVerifier;
  }
}
