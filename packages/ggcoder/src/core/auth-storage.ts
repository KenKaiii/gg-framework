import fs from "node:fs/promises";
import os from "node:os";
import { getAppPaths } from "../config.js";
import type { OAuthCredentials, ProviderStatus } from "./oauth/types.js";
import { refreshAnthropicToken } from "./oauth/anthropic.js";
import { refreshOpenAIToken } from "./oauth/openai.js";

type AuthData = Record<string, OAuthCredentials>;

export class AuthStorage {
  private data: AuthData = {};
  private filePath: string;
  private loaded = false;

  constructor(filePath?: string) {
    this.filePath = filePath ?? getAppPaths().authFile;
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      this.data = JSON.parse(content) as AuthData;
    } catch {
      this.data = {};
    }
    this.loaded = true;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  async getCredentials(provider: string): Promise<OAuthCredentials | undefined> {
    await this.ensureLoaded();
    return this.data[provider];
  }

  async setCredentials(provider: string, creds: OAuthCredentials): Promise<void> {
    await this.ensureLoaded();
    this.data[provider] = { ...creds, source: creds.source || "direct" };
    await this.save();
  }

  async clearCredentials(provider: string): Promise<void> {
    await this.ensureLoaded();
    delete this.data[provider];
    await this.save();
  }

  async clearAll(): Promise<void> {
    this.data = {};
    await this.save();
  }

  /**
   * Returns valid credentials, auto-refreshing if expired.
   * Throws if not logged in.
   */
  async resolveCredentials(provider: string): Promise<OAuthCredentials> {
    await this.ensureLoaded();
    let creds = this.data[provider];
    if (!creds) {
      // Auto-discover credentials from other CLI tools on the machine
      // (e.g. Claude Code stores OAuth tokens in ~/.claude/, Codex CLI in ~/.codex/)
      const discovered = await this.discoverCredentials(provider);
      if (!discovered) {
        throw new NotLoggedInError(provider);
      }
      creds = discovered;
      this.data[provider] = creds;
      await this.save();
    }

    // Return if not expired
    if (Date.now() < creds.expiresAt) {
      return creds;
    }

    // GLM and Moonshot use static API keys — no refresh needed
    if (provider === "glm" || provider === "moonshot") {
      return creds;
    }

    // Cannot refresh without a refresh token — clear stale credentials and require login
    if (!creds.refreshToken) {
      await this.clearCredentials(provider);
      throw new NotLoggedInError(
        provider,
        "Discovered credentials have expired. Please login again.",
      );
    }

    // Refresh (preserve accountId if not returned by refresh)
    const refreshFn = provider === "anthropic" ? refreshAnthropicToken : refreshOpenAIToken;
    const refreshed = await refreshFn(creds.refreshToken);
    if (!refreshed.accountId && creds.accountId) {
      refreshed.accountId = creds.accountId;
    }
    if (!refreshed.source && creds.source) {
      refreshed.source = creds.source;
    }
    this.data[provider] = refreshed;
    await this.save();
    return refreshed;
  }

  /**
   * Returns a valid access token, auto-refreshing if expired.
   * Throws if not logged in.
   */
  async resolveToken(provider: string): Promise<string> {
    const creds = await this.resolveCredentials(provider);
    return creds.accessToken;
  }

  /**
   * Try to find existing credentials from other CLI tools already installed
   * on the machine. This avoids forcing users to re-authenticate when they
   * already have valid sessions from Claude Code or Codex CLI.
   */
  private async discoverCredentials(provider: string): Promise<OAuthCredentials | null> {
    const home = os.homedir();

    if (provider === "anthropic") {
      // Claude Code stores OAuth credentials at ~/.claude/.credentials.json
      try {
        const raw = await fs.readFile(`${home}/.claude/.credentials.json`, "utf-8");
        const data = JSON.parse(raw);
        const oauth = data?.claudeAiOauth;
        if (oauth?.accessToken) {
          return {
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken ?? "",
            expiresAt: 0, // Force refresh on first use to validate
            source: "Claude Code",
          };
        }
      } catch {
        // No Claude Code credentials found
      }
    }

    if (provider === "openai") {
      // Codex CLI stores OAuth credentials at ~/.codex/auth.json
      try {
        const raw = await fs.readFile(`${home}/.codex/auth.json`, "utf-8");
        const data = JSON.parse(raw);
        const token = data?.tokens?.access_token;
        if (token) {
          return {
            accessToken: token,
            refreshToken: data.tokens.refresh_token ?? "",
            expiresAt: 0, // Force refresh on first use to validate
            accountId: data.tokens.account_id,
            source: "Codex CLI",
          };
        }
      } catch {
        // No Codex credentials found
      }
    }

    return null;
  }

  async getProviderStatuses(): Promise<ProviderStatus[]> {
    await this.ensureLoaded();
    const allProviders: ProviderStatus["provider"][] = ["anthropic", "openai", "glm", "moonshot"];
    return allProviders.map((provider) => {
      const creds = this.data[provider];
      return {
        provider,
        connected: !!creds,
        source: creds?.source,
      };
    });
  }

  private async save(): Promise<void> {
    const content = JSON.stringify(this.data, null, 2);
    await fs.writeFile(this.filePath, content, { encoding: "utf-8", mode: 0o600 });
  }
}

export class NotLoggedInError extends Error {
  provider: string;
  constructor(provider: string, message?: string) {
    super(message ?? `Not logged in to ${provider}. Run "ggcoder login" to authenticate.`);
    this.name = "NotLoggedInError";
    this.provider = provider;
  }
}
