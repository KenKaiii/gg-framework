import fs from "node:fs/promises";
import { getAppPaths } from "../config.js";
import type { OAuthCredentials } from "./oauth/types.js";
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
    this.data[provider] = creds;
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
   * If `forceRefresh` is true, refreshes even if the token hasn't expired
   * (useful when the provider rejects a token with 401 before its stored expiry).
   * Throws if not logged in.
   */
  async resolveCredentials(
    provider: string,
    opts?: { forceRefresh?: boolean },
  ): Promise<OAuthCredentials> {
    await this.ensureLoaded();
    const creds = this.data[provider];
    if (!creds) {
      throw new NotLoggedInError(provider);
    }

    // GLM and Moonshot use static API keys — no refresh needed
    if (provider === "glm" || provider === "moonshot") {
      return creds;
    }

    // Return if not expired and not force-refreshing
    if (!opts?.forceRefresh && Date.now() < creds.expiresAt) {
      return creds;
    }

    // Refresh (preserve accountId if not returned by refresh)
    const refreshFn = provider === "anthropic" ? refreshAnthropicToken : refreshOpenAIToken;
    const refreshed = await refreshFn(creds.refreshToken);
    if (!refreshed.accountId && creds.accountId) {
      refreshed.accountId = creds.accountId;
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

  private async save(): Promise<void> {
    const content = JSON.stringify(this.data, null, 2);
    await fs.writeFile(this.filePath, content, { encoding: "utf-8", mode: 0o600 });
  }
}

export class NotLoggedInError extends Error {
  provider: string;
  constructor(provider: string) {
    super(`Not logged in to ${provider}. Run "ggcoder login" to authenticate.`);
    this.name = "NotLoggedInError";
    this.provider = provider;
  }
}
